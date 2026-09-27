/**
 * Autoorder pass over the Bybit top N perpetuals (by 24h turnover), started from the trail loop
 * (`tv order trail --watch 5 --auto`) when the standalone PowerShell loop (scripts/autoorder-loop.ps1)
 * is not running. Every symbol runs in its own CLI child process, one after another (autoorder switches
 * the chart), so the trail loop keeps ticking while a pass is in progress. A lock file keeps the two
 * loops from running a pass at the same time.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = join(homedir(), '.tradingview-mcp');
export const LOOP_PID_FILE = join(DATA_DIR, 'autoorder-loop.pid');
export const LOCK_FILE = join(DATA_DIR, 'autoorder.lock');
const SYMBOL_TIMEOUT_MS = 180000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** Image name of a process on Windows (null elsewhere or when unknown). */
function processName(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const m = /^"([^"]+)"/.exec(out.trim());
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

const readText = (p) => readFileSync(p, 'utf8').replace(/^﻿/, '').trim();

/** The standalone PowerShell autoorder loop is running (its pid file points at a live powershell process). */
export function standaloneLoopRunning() {
  if (!existsSync(LOOP_PID_FILE)) return false;
  const pid = parseInt(readText(LOOP_PID_FILE), 10);
  if (!(pid > 0) || !pidAlive(pid)) return false;
  const name = processName(pid);
  return name == null ? true : /^(powershell|pwsh)\.exe$/.test(name);
}

/** Live holder of the pass lock ({ pid, by, ts }) or null (no lock, or its process is gone). */
export function lockHolder() {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    const lock = JSON.parse(readText(LOCK_FILE));
    return lock.pid && lock.pid !== process.pid && pidAlive(lock.pid) ? lock : null;
  } catch { return null; }
}

function takeLock(by) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, by, ts: new Date().toISOString() }));
}

function releaseLock() {
  try { if (JSON.parse(readText(LOCK_FILE)).pid === process.pid) unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

export async function topSymbols(n = 50) {
  const json = await (await fetch('https://api.bybit.com/v5/market/tickers?category=linear')).json();
  if (json.retCode !== 0) throw new Error(`Bybit tickers: ${json.retMsg}`);
  return json.result.list.filter(t => t.symbol.endsWith('USDT'))
    .sort((a, b) => b.turnover24h - a.turnover24h).slice(0, n).map(t => `BYBIT:${t.symbol}.P`);
}

/** Run `tv order auto <symbol>` in a child process; resolves with the parsed JSON result (stdout, or stderr on failure). */
function runOne(symbol, { dry_run = false } = {}) {
  return new Promise((resolveRun) => {
    const args = [join(ROOT, 'src/cli/index.js'), 'order', 'auto', symbol, '--no-screenshot', ...(dry_run ? ['--dry-run'] : [])];
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill(); }, SYMBOL_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      for (const text of [out, err]) {
        const i = text.indexOf('{');
        if (i >= 0) { try { return resolveRun(JSON.parse(text.slice(i))); } catch { /* try the other stream */ } }
      }
      resolveRun({ success: false, error: code === null ? `timed out after ${SYMBOL_TIMEOUT_MS / 1000} s` : `exit ${code}: ${(err || out).trim().slice(0, 200)}` });
    });
  });
}

/** One log row per symbol from an autoorder result (trade / wait / skip / error). */
export function summarizeAuto(symbol, res) {
  if (!res) return { symbol, action: 'error', reason: 'no output' };
  const d = res.decision, plan = res.order?.plan;
  return {
    symbol,
    action: d?.action ?? res.action ?? (res.success === false ? 'error' : 'unknown'),
    side: d?.side ?? null, type: d?.type ?? null,
    entry: plan?.entry ?? null, sl: plan?.sl ?? null, tp: plan?.tp ?? null,
    order_ok: res.order ? !!res.order.success : null,
    reason: d?.reasons?.at(-1) ?? res.reason ?? res.error ?? res.order?.error ?? null,
  };
}

/**
 * Kind of a failed symbol: 'broker' (TradingView trading panel disconnected — the rest of the pass would fail
 * the same way), 'data' (the chart cannot load enough bars: fresh listing, sparse stock perp) or null.
 */
export function errorKind(reason) {
  if (/broker is not connected|no broker connected|quotesSnapshot not received/i.test(reason || '')) return 'broker';
  if (/did not load|not enough closed bars/i.test(reason || '')) return 'data';
  return null;
}

const DATA_SKIP_MS = 6 * 3600000;
const dataSkipUntil = new Map(); // symbol → ms; lives as long as the trail loop process

/**
 * One autoorder pass over the current top N. Returns { skipped: 'standalone' | 'locked' } without doing
 * anything when the standalone loop runs or another pass holds the lock, { skipped: 'broker' } when the
 * broker turned out to be disconnected (pass stopped), otherwise { counts }. Symbols whose bars did not load
 * are left out for 6 hours.
 */
export async function runAutoPass({ top = 50, dry_run = false, onEvent = () => {}, by = 'trail-loop' } = {}) {
  if (standaloneLoopRunning()) return { skipped: 'standalone' };
  if (lockHolder()) return { skipped: 'locked' };
  takeLock(by);
  try {
    const now = Date.now();
    const all = await topSymbols(top);
    const symbols = all.filter(s => !((dataSkipUntil.get(s) || 0) > now));
    const left_out = all.filter(s => !symbols.includes(s));
    onEvent({ message: 'autoorder pass start', count: symbols.length, dry_run, ...(left_out.length ? { left_out } : {}) });
    const counts = {};
    for (const s of symbols) {
      if (standaloneLoopRunning()) { onEvent({ message: 'autoorder pass stopped — the standalone autoorder loop started' }); break; }
      const row = summarizeAuto(s, await runOne(s, { dry_run }));
      counts[row.action] = (counts[row.action] || 0) + 1;
      onEvent({ auto: true, ...row });
      const kind = row.action === 'error' ? errorKind(row.reason) : null;
      if (kind === 'data') dataSkipUntil.set(s, Date.now() + DATA_SKIP_MS);
      if (kind === 'broker') { onEvent({ message: 'autoorder pass stopped — broker not connected', counts }); return { skipped: 'broker', counts }; }
    }
    onEvent({ message: 'autoorder pass done', counts });
    return { counts };
  } finally {
    releaseLock();
  }
}
