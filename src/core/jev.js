/**
 * Jev AI decision client (https://thejevai.com/v1/systemone) — port of agent-orch's jev.py.
 *
 * Jev gets a minimal `state` plus typed questions (choice / score / noul) and returns
 * answers with probabilities. Here it decides entries (direction + order type) and exits
 * (hold / tighten / close); money management, stops and guards stay deterministic.
 *
 * Config: process env or `.env` in the repo root (only JEV_* keys are read):
 *   JEV_API_KEY (required), JEV_API_BASE_URL, JEV_MODEL, JEV_TIMEOUT (s), JEV_MAX_RETRIES
 * The key is never logged or returned.
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULTS = { JEV_API_BASE_URL: 'https://thejevai.com', JEV_MODEL: 'typesafe/jev-1.13', JEV_TIMEOUT: '20', JEV_MAX_RETRIES: '2' };
const LOG_DIR = join(homedir(), '.tradingview-mcp', 'jev');

/** Full request + response audit (never the key): ~/.tradingview-mcp/jev/YYYY-MM-DD.jsonl */
function logCall(entry, key) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const line = scrub(JSON.stringify({ ts: new Date().toISOString(), ...entry }), key);
    appendFileSync(join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`), line + '\n');
  } catch { /* logging must never break a decision */ }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

function readEnvFile() {
  const file = process.env.JEV_ENV_FILE || join(ROOT, '.env');
  if (!existsSync(file)) return {};
  let text = readFileSync(file);
  // UTF-16 (PowerShell 5 `>`) or UTF-8 with/without BOM
  text = text[0] === 0xff && text[1] === 0xfe ? text.toString('utf16le') : text.toString('utf8');
  const out = {};
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(JEV_[A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function jevEnv() {
  const file = readEnvFile();
  const get = (k) => process.env[k] || file[k] || DEFAULTS[k];
  return { key: get('JEV_API_KEY') || null, base: get('JEV_API_BASE_URL').replace(/\/+$/, ''), model: get('JEV_MODEL'),
    timeout_ms: Number(get('JEV_TIMEOUT')) * 1000, max_retries: Number(get('JEV_MAX_RETRIES')) };
}

export function scrub(text, key = jevEnv().key) {
  let s = String(text);
  if (key) s = s.split(key).join('***');
  return s.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***');
}

// ── Circuit breaker (per process — the trail loop is one long-lived process) ──
const breaker = { failures: 0, open_until: 0 };
const BREAKER_FAILURES = 3, BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

export function jevStatus(cfgJev = {}) {
  const env = jevEnv();
  return { enabled: !!cfgJev.enabled, exits: cfgJev.exits !== false, key_present: !!env.key, model: env.model, base: env.base,
    breaker: breaker.open_until > Date.now() ? `open until ${new Date(breaker.open_until).toISOString()}` : 'closed' };
}

/** Accepts the enveloped `{code, data:{result:{answers}}}` and the flat `{answers}` shapes. */
export function parseResponse(json) {
  if (json && Object.prototype.hasOwnProperty.call(json, 'code')) {
    if (json.code !== 0) throw new Error(`Jev error code ${json.code}: ${json.message || 'unknown'}`);
    const r = json.data?.result;
    if (!r?.answers) throw new Error('Jev response has no data.result.answers');
    return { answers: r.answers, elapsedMs: r.elapsedMs ?? null, credits: json.data.creditsUsed ?? null, model: r.model ?? null };
  }
  if (!json?.answers) throw new Error('Jev response has no answers');
  return { answers: json.answers, elapsedMs: json.elapsedMs ?? null, credits: json.creditsUsed ?? null, model: json.model ?? null };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** POST state + questions; only type / instructions / criteria are sent (thresholds stay local). */
export async function callJev({ state, questions, tag = null }) {
  const env = jevEnv();
  if (!env.key) { breaker.open_until = Date.now() + BREAKER_COOLDOWN_MS; throw new Error('JEV_API_KEY is not configured (.env in the repo root or process env)'); }
  if (breaker.open_until > Date.now()) throw new Error(`Jev circuit breaker open until ${new Date(breaker.open_until).toISOString()}`);
  const api = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: q.type, instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }]));
  const request = { model: env.model, state, questions: api };
  const body = JSON.stringify(request);
  const t0 = Date.now();
  let lastErr;
  for (let attempt = 0; attempt <= env.max_retries; attempt++) {
    if (attempt) await sleep(Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.random() * 300);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), env.timeout_ms);
    try {
      const res = await fetch(`${env.base}/v1/systemone`, { method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${env.key}`, 'Content-Type': 'application/json' }, body });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`Jev HTTP ${res.status}: ${scrub(text, env.key).slice(0, 300)}`);
        if (res.status === 401 || res.status === 402) { breaker.open_until = Date.now() + BREAKER_COOLDOWN_MS; throw Object.assign(err, { fatal: true }); }
        if (!RETRY_STATUSES.has(res.status)) throw Object.assign(err, { fatal: true });
        lastErr = err; continue;
      }
      const json = JSON.parse(text);
      const parsed = parseResponse(json);
      breaker.failures = 0;
      logCall({ tag, url: `${env.base}/v1/systemone`, request, response: json, http_status: res.status, attempts: attempt + 1, ms: Date.now() - t0 }, env.key);
      return parsed;
    } catch (err) {
      if (err.fatal) { breaker.failures++; logCall({ tag, url: `${env.base}/v1/systemone`, request, error: err.message, ms: Date.now() - t0 }, env.key); throw err; }
      lastErr = err.name === 'AbortError' ? new Error(`Jev timeout after ${env.timeout_ms} ms`) : err;
      if (/no data\.result|no answers|error code/.test(lastErr.message)) break;
    } finally { clearTimeout(timer); }
  }
  if (++breaker.failures >= BREAKER_FAILURES) breaker.open_until = Date.now() + BREAKER_COOLDOWN_MS;
  logCall({ tag, url: `${env.base}/v1/systemone`, request, error: lastErr?.message || 'Jev call failed', ms: Date.now() - t0 }, env.key);
  throw new Error(scrub(lastErr?.message || 'Jev call failed', env.key));
}

/** agent-orch binding rules: choice/score binding at confidence ≥ threshold; noul yes ≥ t, no ≤ 1 − t. */
export function evaluate(answers, questions) {
  const out = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    const t = q.threshold ?? 0.7;
    if (!a) { out[name] = { binding: false, error: 'missing answer' }; continue; }
    if (q.type === 'noul') {
      const p = Number(a.noul);
      out[name] = { value: p >= t ? 'yes' : p <= 1 - t ? 'no' : 'undecided', p, confidence: Math.max(p, 1 - p), binding: p >= t || p <= 1 - t };
    } else if (q.type === 'choice') {
      const conf = Number(a.confidence ?? a.probabilities?.[a.choice] ?? 0);
      out[name] = { value: a.choice, confidence: conf, probabilities: a.probabilities ?? null, binding: conf >= t && a.choice in q.criteria };
    } else if (q.type === 'score') {
      const level = Math.max(0, Math.min(q.criteria.length - 1, Math.round(Number(a.score))));
      const conf = Number(a.confidence ?? 0);
      // Jev score is 0-indexed (response `legend` {"0": first criterion, ...}); `score` is the expected level
      const label = a.legend?.[String(level)] ?? q.criteria[level];
      out[name] = { value: level, label, raw: a.score, confidence: conf, probabilities: a.probabilities ?? null, binding: conf >= t };
    }
  }
  return out;
}

// ── Question catalog ─────────────────────────────────────────────────────

export const ENTRY_ACTIONS = {
  long_market: 'Buy now at market: long bias confirmed and a trigger is present at a good location',
  long_limit: 'Buy with a limit on a pullback (5m/15m EMA20) — long bias but price is extended',
  long_stop: 'Buy stop above the range / trigger bars — long bias, waiting for a breakout confirmation',
  short_market: 'Sell now at market: short bias confirmed and a trigger is present at a good location',
  short_limit: 'Sell with a limit on a pullback up to the 5m/15m EMA20 — short bias but price is extended',
  short_stop: 'Sell stop below the range / trigger bars — short bias, waiting for a breakdown confirmation',
  wait: 'No trade: no clear edge, conflicting timeframes, poor risk/reward or chop',
};

export function entryQuestions({ entry_threshold = 0.6, rules_hint = false } = {}) {
  return {
    action: { type: 'choice', threshold: entry_threshold, criteria: ENTRY_ACTIONS,
      instructions: 'You are a top 0.1% discretionary crypto futures trader. From the multi-timeframe OHLCV bars and indicator values in the state ' +
        '(1D, 1h, 15m, 5m, 1m: EMA 20/50/200 trend, market structure, RSI, ADX, ATR extension, Tillson T3 fast/slow, compression, relative volume, ' +
        'swing levels) decide the single best action now. Trade only with top-down alignment and room to the next opposing level for at least 2R. ' +
        (rules_hint ? 'The rules engine hint is only a second opinion. ' : '') + 'Prefer wait when in doubt.' },
    setup_quality: { type: 'score', threshold: 0.5, criteria: ['Poor', 'Weak', 'Average', 'Good', 'Excellent'],
      instructions: 'Rate the quality of the best available trade setup in this state (trend alignment, location, trigger, risk/reward, volatility).' },
  };
}

export const EXIT_ACTIONS = {
  hold: 'Keep the position with the current stop — the trade thesis is intact',
  tighten: 'Protect profit: move the stop to at least break-even / tighter trail — momentum is fading or a level is near',
  close: 'Exit now at market — the thesis is invalidated (structure broke, strong opposite momentum, T3 turned against)',
};

export function exitQuestions({ exit_threshold = 0.75 } = {}) {
  return {
    exit_action: { type: 'choice', threshold: exit_threshold, criteria: EXIT_ACTIONS,
      instructions: 'You are a top 0.1% crypto futures trader managing this open position. Given the position (side, entry, stop, target, current R) ' +
        'and the 5m/15m/1h OHLCV and indicators in the state, decide whether to hold, tighten the stop or close now. Do not close a healthy trend trade on noise.' },
  };
}

/**
 * Probability mass of levels ≥ minIndex (0-indexed). Gating on this instead of the rounded
 * expected score keeps an undecided spread (e.g. 0.30 Weak / 0.38 Average / 0.29 Good) from passing.
 */
export function probAtLeast(q, minIndex) {
  if (!q.probabilities) return q.value >= minIndex ? 1 : 0;
  return Object.entries(q.probabilities).reduce((s, [k, p]) => s + (Number(k) >= minIndex ? Number(p) : 0), 0);
}

/** Entry decision → { action, dir, type, binding, confidence, quality, ... } */
/**
 * Entry gate on the probability distribution (not Jev's confidence, which stays low when the
 * distribution is spread): the best trade action must have p >= entry_min_prob and lead wait by
 * >= entry_margin; setup quality needs P(level >= min_quality) >= quality_min_p.
 */
export function decideEntry(ev, cfgJev = {}) {
  const act = ev.action, q = ev.setup_quality;
  const minProb = cfgJev.entry_min_prob ?? 0.4, margin = cfgJev.entry_margin ?? 0.1;
  const minQ = cfgJev.min_quality ?? 3, qMinP = cfgJev.quality_min_p ?? 0.4;
  const probs = act?.probabilities || (act?.value ? { [act.value]: act.confidence ?? 0 } : {});
  const pWait = Number(probs.wait ?? 0);
  const [best, pBest] = Object.entries(probs).filter(([k]) => k !== 'wait' && k in ENTRY_ACTIONS)
    .map(([k, v]) => [k, Number(v)]).sort((x, y) => y[1] - x[1])[0] || [null, 0];
  const qualityLevel = q ? q.value + 1 : null;  // 1..5 (Jev levels are 0-indexed)
  const qualityP = q ? probAtLeast(q, minQ - 1) : null;
  let decision = 'wait', why;
  if (!best || pBest < minProb) why = `Jev best trade ${best} p=${pBest.toFixed(2)} < ${minProb} (wait ${pWait.toFixed(2)})`;
  else if (pBest - pWait < margin - 1e-9) why = `Jev ${best} ${pBest.toFixed(2)} leads wait ${pWait.toFixed(2)} by < ${margin}`;
  else if (qualityP != null && qualityP < qMinP) why = `Jev setup quality ${qualityLevel}/5: P(>=${minQ}) ${qualityP.toFixed(2)} < ${qMinP}`;
  else { decision = best; why = `Jev: ${best} p=${pBest.toFixed(2)} vs wait ${pWait.toFixed(2)}, quality ${qualityLevel}/5 (P>=${minQ} ${qualityP?.toFixed(2)})`; }
  const [side, type] = decision === 'wait' ? [null, null] : decision.split('_');
  return { action: decision, side, type, dir: side === 'long' ? 1 : side === 'short' ? -1 : 0, why,
    raw_action: act?.value ?? null, best_trade: best, p_best: pBest, p_wait: pWait, confidence: act?.confidence ?? null, probabilities: act?.probabilities ?? null,
    quality: qualityLevel, quality_label: q?.label ?? null, quality_raw: q?.raw ?? null, quality_p_min: qualityP };
}

/** close: p(close) >= exit_close_prob and leads hold by exit_margin; tighten: p(tighten) >= exit_tighten_prob and > hold. */
export function decideExit(ev, cfgJev = {}) {
  const probs = ev?.probabilities || (ev?.value ? { [ev.value]: ev.confidence ?? 0 } : {});
  const p = (k) => Number(probs[k] ?? 0);
  const closeP = cfgJev.exit_close_prob ?? 0.5, margin = cfgJev.exit_margin ?? 0.1, tightenP = cfgJev.exit_tighten_prob ?? 0.4;
  let action = 'hold';
  if (p('close') >= closeP && p('close') - p('hold') >= margin - 1e-9) action = 'close';
  else if (p('tighten') >= tightenP && p('tighten') > p('hold')) action = 'tighten';
  return { action, raw_action: ev?.value ?? null, confidence: ev?.confidence ?? null, probabilities: ev?.probabilities ?? null };
}

/** Entry decision -> { action, dir, type, p_best, p_wait, quality, ... } */
export async function jevEntry(state, cfgJev = {}) {
  const questions = entryQuestions(cfgJev);
  const res = await callJev({ state, questions, tag: `entry ${state.symbol || ''}`.trim() });
  return { ...decideEntry(evaluate(res.answers, questions), cfgJev), elapsedMs: res.elapsedMs, credits: res.credits };
}

/** Exit decision -> { action: hold | tighten | close, probabilities } */
export async function jevExit(state, cfgJev = {}) {
  const questions = exitQuestions(cfgJev);
  const res = await callJev({ state, questions, tag: `exit ${state.position?.symbol || ''}`.trim() });
  return { ...decideExit(evaluate(res.answers, questions).exit_action, cfgJev), elapsedMs: res.elapsedMs, credits: res.credits };
}
