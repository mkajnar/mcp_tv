/**
 * Core order execution logic — places, verifies and manages orders on the broker
 * connected to TradingView's Trading Panel (Paper Trading by default).
 *
 * One call does the whole flow: account check → money management → guards →
 * placeOrder → fill/working-order verification → JSONL audit log.
 */
import { evaluateAsync } from '../connection.js';
import { getOhlcv } from './data.js';
import { setSymbol } from './chart.js';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');
const USER_DATA_DIR = join(homedir(), '.tradingview-mcp');
const ORDERS_DIR = join(USER_DATA_DIR, 'orders');

// TradingView broker API enums (charting library)
const ORDER_TYPE = { limit: 1, market: 2, stop: 3 };
const ORDER_STATUS_WORKING = 6;

export const DEFAULT_CONFIG = {
  risk_usdt: 100,        // money at risk per trade incl. fees + slippage
  max_risk_usdt: 500,    // hard cap, a request above it is refused
  rr: 2,                 // take profit = rr * SL distance (0 = no TP)
  sl_atr_mult: 0.5,      // auto SL = last confirmed swing + sl_atr_mult * ATR
  atr_length: 14,
  pivot_length: 3,       // swing = pivot with N bars left and N bars right
  fee_rate: 0.0002,      // per side, applied to entry + exit price
  slippage_rate: 0.0002, // modelled the same way as fees
  allow_live: false,     // live (non-demo) accounts refused unless true or TV_ALLOW_LIVE_TRADING=1
  trailing: {
    trail_atr_mult: 1.0,   // ATR trail: SL = price ± trail_atr_mult * ATR
    min_gap_atr: 0.25,     // SL never closer to price than min_gap_atr * ATR
    min_step_atr: 0.1,     // move only if the stop improves by at least this many ATRs (avoids micro-updates)
    breakeven: true,       // also consider break-even (entry ± fees) once there is room for it
    switch_chart: true,    // temporarily switch the chart to read bars of positions on other symbols
    bars_source: 'bybit',  // 'bybit' = ATR from Bybit public klines for BYBIT:*.P (no chart switching), 'chart' = active chart
    atr_timeframe: '1',    // kline interval for the Bybit source (1, 5, 15, 60, D)
  },
};

// ── Config ──────────────────────────────────────────────────────────────

export function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  for (const p of [join(PROJECT_ROOT, 'trading.json'), join(USER_DATA_DIR, 'trading.json')]) {
    if (!existsSync(p)) continue;
    try {
      const file = JSON.parse(readFileSync(p, 'utf8'));
      Object.assign(cfg, file, { trailing: { ...cfg.trailing, ...(file.trailing || {}) } });
    }
    catch (err) { throw new Error(`Invalid JSON in ${p}: ${err.message}`); }
  }
  if (process.env.TV_ALLOW_LIVE_TRADING === '1') cfg.allow_live = true;
  if (process.env.TV_MAX_RISK_USDT) cfg.max_risk_usdt = Number(process.env.TV_MAX_RISK_USDT);
  return cfg;
}

// ── Pure helpers (unit tested) ──────────────────────────────────────────

function stepDecimals(step) {
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}

export function roundToStep(value, step, mode = 'round') {
  const n = value / step;
  const fn = mode === 'ceil' ? Math.ceil : mode === 'floor' ? Math.floor : Math.round;
  const eps = mode === 'ceil' ? -1e-6 : mode === 'floor' ? 1e-6 : 0; // absorb float noise (e.g. 100.40000000000873)
  return Number((fn(n + eps) * step).toFixed(stepDecimals(step)));
}

export function parseSide(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'buy' || s === 'long') return 1;
  if (s === 'sell' || s === 'short') return -1;
  throw new Error(`side must be buy/long or sell/short, got "${side}"`);
}

/**
 * ATR (Wilder/RMA) and the last confirmed swing on closed bars.
 * The last bar is treated as still forming and is ignored.
 * side -1 (short) → swing high, side 1 (long) → swing low.
 */
export function computeAtr(bars, atr_length = 14) {
  const closed = bars.slice(0, -1);
  if (closed.length < atr_length + 1) throw new Error(`Not enough bars for ATR(${atr_length}): ${closed.length}`);
  const trs = closed.map((b, i) => i === 0 ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - closed[i - 1].close), Math.abs(b.low - closed[i - 1].close)));
  let atr = trs.slice(0, atr_length).reduce((a, b) => a + b, 0) / atr_length;
  for (const tr of trs.slice(atr_length)) atr = (atr * (atr_length - 1) + tr) / atr_length;
  return atr;
}

export function computeSwingAtr(bars, { side, atr_length = 14, pivot_length = 3 }) {
  const closed = bars.slice(0, -1);
  if (closed.length < Math.max(atr_length + 1, pivot_length * 2 + 1)) {
    throw new Error(`Not enough bars for ATR(${atr_length}) / pivot(${pivot_length}): ${closed.length}`);
  }
  const atr = computeAtr(bars, atr_length);

  const L = pivot_length, R = pivot_length;
  const key = side === -1 ? 'high' : 'low';
  const beats = side === -1 ? (a, b) => a > b : (a, b) => a < b;
  const beatsOrEq = side === -1 ? (a, b) => a >= b : (a, b) => a <= b;
  for (let i = closed.length - 1 - R; i >= L; i--) {
    const v = closed[i][key];
    let ok = true;
    for (let j = i - L; j < i && ok; j++) ok = beats(v, closed[j][key]);
    for (let j = i + 1; j <= i + R && ok; j++) ok = beatsOrEq(v, closed[j][key]);
    if (ok) return { atr, swing: { price: v, time: closed[i].time, confirmed_time: closed[i + R].time, bars_ago: closed.length - 1 - i } };
  }
  throw new Error(`No confirmed swing ${key} found in ${closed.length} bars`);
}

/**
 * Money management: SL/TP/qty from entry. Risk per unit includes fees and slippage:
 *   risk/unit = |entry - sl| + (fee_rate + slippage_rate) * (entry + sl)
 */
export function planOrder({ side, entry, sl, tp, rr, qty, risk_usdt, fee_rate, slippage_rate, min_tick, qty_step, qty_min }) {
  const dist = side === -1 ? sl - entry : entry - sl;
  if (!(dist > 0)) throw new Error(`Stop loss ${sl} is on the wrong side of entry ${entry} for a ${side === -1 ? 'short' : 'long'}`);
  let takeProfit = tp ?? null;
  if (takeProfit == null && rr > 0) {
    takeProfit = side === -1
      ? roundToStep(entry - rr * dist, min_tick, 'floor')
      : roundToStep(entry + rr * dist, min_tick, 'ceil');
  }
  if (takeProfit != null && (side === -1 ? takeProfit >= entry : takeProfit <= entry)) {
    throw new Error(`Take profit ${takeProfit} is on the wrong side of entry ${entry}`);
  }
  const commissionPerUnit = fee_rate * (entry + sl);
  const slippagePerUnit = slippage_rate * (entry + sl);
  const riskPerUnit = dist + commissionPerUnit + slippagePerUnit;
  const finalQty = qty != null ? roundToStep(qty, qty_step, 'floor') : roundToStep(risk_usdt / riskPerUnit, qty_step, 'floor');
  if (!(finalQty >= (qty_min || qty_step))) throw new Error(`Quantity ${finalQty} is below the minimum ${qty_min || qty_step}`);
  return {
    side: side === -1 ? 'short' : 'long',
    entry, sl, tp: takeProfit, dist: Number(dist.toFixed(8)),
    rr_effective: takeProfit != null ? Number((Math.abs(takeProfit - entry) / dist).toFixed(3)) : null,
    qty: finalQty,
    planned_risk: Number((finalQty * riskPerUnit).toFixed(4)),
    commission_per_unit: commissionPerUnit,
    slippage_per_unit: slippagePerUnit,
    notional: Number((finalQty * entry).toFixed(4)),
  };
}

/**
 * Profit-protecting trailing stop for an open position (never loosens the stop).
 * price = the side that would trigger the stop (ask for a short, bid for a long).
 */
export function computeTrailStop({ side, entry, price, current_sl, atr, min_tick, trail_atr_mult, min_gap_atr, min_step_atr = 0, fee_rate, breakeven }) {
  const inProfit = side === -1 ? price < entry : price > entry;
  if (!inProfit) return { action: 'skip', reason: 'position is not in profit' };
  const gap = min_gap_atr * atr;
  const candidates = { atr: side === -1 ? price + trail_atr_mult * atr : price - trail_atr_mult * atr };
  if (breakeven) {
    const be = side === -1 ? entry * (1 - 2 * fee_rate) : entry * (1 + 2 * fee_rate);
    if (side === -1 ? be >= price + gap : be <= price - gap) candidates.breakeven = be;
  }
  const pick = side === -1 ? Math.min : Math.max;
  let target = pick(...Object.values(candidates));
  let basis = Object.keys(candidates).find(k => candidates[k] === target);
  const limit = side === -1 ? price + gap : price - gap;
  if (side === -1 ? target < limit : target > limit) { target = limit; basis = 'min_gap'; }
  const newSl = roundToStep(target, min_tick, side === -1 ? 'ceil' : 'floor');
  const step = Math.max(min_tick * 0.999, min_step_atr * atr);
  const improves = current_sl == null || (side === -1 ? newSl <= current_sl - step : newSl >= current_sl + step);
  if (!improves) return { action: 'keep', reason: `improvement below ${Number(step.toFixed(8))} (min step) or existing stop already tighter`, new_sl: newSl, basis, candidates };
  return { action: 'move', new_sl: newSl, basis, candidates, locked_per_unit: Number((side === -1 ? entry - newSl : newSl - entry).toFixed(8)) };
}

/** Closed + forming bars for a Bybit USDT perpetual from the public API, or null for other symbols. */
async function bybitBars(symbol, interval = '1', limit = 200) {
  const m = /^BYBIT:([A-Z0-9]+)\.P$/i.exec(symbol);
  if (!m) return null;
  const res = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${m[1].toUpperCase()}&interval=${interval}&limit=${limit}`);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`Bybit kline ${m[1]}: ${json.retMsg}`);
  return json.result.list.map(r => ({ time: Number(r[0]) / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })).reverse();
}

/**
 * Live bid/ask for a Bybit USDT perpetual, or null for other symbols / on failure.
 * TradingView's quotesSnapshot is a cached value that goes stale for symbols that are not on the chart.
 */
export async function bybitQuote(symbol) {
  const m = /^BYBIT:([A-Z0-9]+)\.P$/i.exec(symbol || '');
  if (!m) return null;
  try {
    const res = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${m[1].toUpperCase()}`);
    const json = await res.json();
    const t = json.retCode === 0 && json.result.list[0];
    if (!t || !(+t.bid1Price > 0) || !(+t.ask1Price > 0)) return null;
    return { bid: +t.bid1Price, ask: +t.ask1Price, last: +t.lastPrice, source: 'bybit' };
  } catch { return null; }
}

// ── Broker bridge ───────────────────────────────────────────────────────

/** Run an async body in the page with `b` = active broker, `t` = trading API. */
async function brokerEval(body, timeoutMs = 10000) {
  const res = await evaluateAsync(`
    (function() {
      var work = (async function() {
        var t = window.TradingViewApi && window.TradingViewApi.trading && window.TradingViewApi.trading();
        var b = t && t.activeBroker && t.activeBroker();
        if (b && typeof b.value === 'function') b = b.value();
        if (!b) throw new Error('No broker connected in the Trading Panel. Connect Paper Trading (or a broker) first.');
        ${body}
      })();
      var timeout = new Promise(function(_, rej) { setTimeout(function() { rej(new Error('Broker call timed out after ${timeoutMs} ms')); }, ${timeoutMs}); });
      return Promise.race([work, timeout]).then(function(v) { return { ok: true, value: v }; }, function(e) { return { ok: false, error: (e && (e.message || String(e))) || 'unknown broker error' }; });
    })()
  `);
  if (!res) throw new Error('Empty response from TradingView page');
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

const MAP_POSITION = `function(p) { return { id: p.id, symbol: p.symbol, side: p.side === -1 ? 'short' : 'long', qty: p.qty, avg_price: p.avgPrice,
  last_price: p.last != null ? p.last : p.lastPrice, pl: p.extra && p.extra.pl, stop_loss: p.stopLoss, take_profit: p.takeProfit,
  used_margin: p.extra && p.extra.usedMargin }; }`;
const MAP_ORDER = `function(o) { var types = {1: 'limit', 2: 'market', 3: 'stop', 4: 'stop_limit'}; return { id: o.id, symbol: o.symbol,
  side: o.side === -1 ? 'sell' : 'buy', type: types[o.type] || o.type, qty: o.qty, limit_price: o.limitPrice, stop_price: o.stopPrice,
  bracket_of: o.parentId || null, stop_loss: o.stopLoss, take_profit: o.takeProfit }; }`;

const ACCOUNT_JS = `
  var meta = {}; try { meta = b.metainfo() || {}; } catch (e) {}
  var accountType = null; try { accountType = b.currentAccountType(); } catch (e) {}
  var accountId = null; try { accountId = b.currentAccount(); } catch (e) {}
  var accounts = []; try { accounts = await b.accountsMetainfo(); } catch (e) {}
  var acc = (accounts || []).filter(function(a) { return a.id === accountId; })[0] || {};
  var summary = {};
  try {
    var info = await b.accountManagerInfo();
    (info.summary || []).forEach(function(s) { try { summary[s.text] = s.wValue && s.wValue.value ? s.wValue.value() : null; } catch (e) {} });
  } catch (e) {}
  var account = { broker_id: meta.id || null, broker: meta.title || null, account_id: accountId, account_name: acc.name || null,
    currency: acc.currency || null, account_type: accountType, is_demo: accountType === 'demo' || meta.id === 'Paper', summary: summary };
`;

async function getContext(symbol) {
  const ctx = await brokerEval(`
    ${ACCOUNT_JS}
    var chartSymbol = null; try { chartSymbol = window.TradingViewApi._activeChartWidgetWV.value().symbol(); } catch (e) {}
    var sym = ${JSON.stringify(symbol || null)};
    if (!sym) sym = chartSymbol;
    else if (sym.indexOf(':') < 0 && chartSymbol && chartSymbol.toUpperCase().slice(-(sym.length + 1)) === (':' + sym.toUpperCase())) sym = chartSymbol;
    var si = await b.symbolInfo(sym);
    var q = await b.quotesSnapshot(sym);
    var positions = (await b.positions()).filter(function(p) { return p.qty > 0; }).filter(function(p) { return p.symbol === sym; }).map(${MAP_POSITION});
    var working = (await b.orders()).filter(function(o) { return o.symbol === sym && o.status === ${ORDER_STATUS_WORKING}; }).map(${MAP_ORDER});
    return { account: account, chart_symbol: chartSymbol, symbol: sym,
      symbol_info: { description: si.description, currency: si.currency, min_tick: si.minTick, qty_step: si.qty && si.qty.step,
        qty_min: si.qty && si.qty.min, margin_rate: si.marginRate, leverage: si.leverage },
      quote: { bid: q.bid, ask: q.ask, last: q.trade, is_delayed: q.isDelayed, tradable: q.is_tradable },
      positions: positions, working_orders: working };
  `, 15000);
  const live = await bybitQuote(ctx.symbol);
  if (live) ctx.quote = { ...ctx.quote, bid: live.bid, ask: live.ask, last: live.last, source: 'bybit' };
  return ctx;
}

async function snapshot(symbol) {
  return brokerEval(`
    var sym = ${JSON.stringify(symbol)};
    var positions = (await b.positions()).filter(function(p) { return p.qty > 0; }).filter(function(p) { return !sym || p.symbol === sym; }).map(${MAP_POSITION});
    var working = (await b.orders()).filter(function(o) { return (!sym || o.symbol === sym) && o.status === ${ORDER_STATUS_WORKING}; }).map(${MAP_ORDER});
    return { positions: positions, working_orders: working };
  `);
}

// ── Audit log ───────────────────────────────────────────────────────────

export function logEvent(event) {
  const line = { ts: new Date().toISOString(), ...event };
  try {
    mkdirSync(ORDERS_DIR, { recursive: true });
    const file = join(ORDERS_DIR, `${line.ts.slice(0, 10)}.jsonl`);
    appendFileSync(file, JSON.stringify(line) + '\n');
    return file;
  } catch { return null; }
}

function assertAccountAllowed(account, cfg) {
  if (!account.is_demo && !cfg.allow_live) {
    throw new Error(`Refusing to trade on a non-demo account (${account.broker} / ${account.account_type}). ` +
      'Set "allow_live": true in trading.json or TV_ALLOW_LIVE_TRADING=1 to enable live trading.');
  }
}

async function waitFor(check, { tries = 12, delayMs = 400 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await check();
    if (last.done) return last;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return last;
}

// ── Public API ──────────────────────────────────────────────────────────

/** Tick size, quantity step and live bid/ask of a symbol from the connected broker. */
export async function symbolSpec(symbol) {
  return brokerEval(`
    var sym = ${JSON.stringify(symbol)};
    var si = await b.symbolInfo(sym);
    var q = await b.quotesSnapshot(sym);
    return { symbol: sym, min_tick: si.minTick, qty_step: si.qty && si.qty.step, bid: q.bid, ask: q.ask, tradable: q.is_tradable };
  `);
}

export async function status({ symbol } = {}) {
  const res = await brokerEval(`
    ${ACCOUNT_JS}
    var sym = ${JSON.stringify(symbol || null)};
    var positions = (await b.positions()).filter(function(p) { return p.qty > 0; }).filter(function(p) { return !sym || p.symbol === sym || p.symbol.slice(-(sym.length + 1)) === ':' + sym; }).map(${MAP_POSITION});
    var working = (await b.orders()).filter(function(o) { return (!sym || o.symbol === sym || o.symbol.slice(-(sym.length + 1)) === ':' + sym) && o.status === ${ORDER_STATUS_WORKING}; }).map(${MAP_ORDER});
    return { account: account, positions: positions, working_orders: working };
  `);
  return { success: true, ...res, config: loadConfig() };
}

/**
 * Place an order with automatic money management.
 * Only `side` is required; everything else falls back to trading.json defaults.
 */
export async function placeOrder(params = {}) {
  const cfg = loadConfig();
  const side = parseSide(params.side);
  const type = (params.type || 'market').toLowerCase();
  if (!ORDER_TYPE[type]) throw new Error(`type must be market, limit or stop, got "${params.type}"`);
  if (type !== 'market' && !(params.price > 0)) throw new Error(`price is required for a ${type} order`);

  const risk = params.risk_usdt ?? cfg.risk_usdt;
  if (params.qty == null && !(risk > 0)) throw new Error('risk_usdt must be > 0 (or pass qty)');
  if (risk > cfg.max_risk_usdt && params.qty == null) throw new Error(`risk_usdt ${risk} exceeds max_risk_usdt ${cfg.max_risk_usdt} (trading.json)`);

  const ctx = await getContext(params.symbol);
  const { account, symbol, symbol_info: si, quote } = ctx;
  assertAccountAllowed(account, cfg);
  if (quote.tradable === false) throw new Error(`${symbol} is not tradable with ${account.broker}`);
  if (ctx.positions.length && !params.allow_add) {
    throw new Error(`An open position on ${symbol} already exists (${ctx.positions[0].side} ${ctx.positions[0].qty}). Pass allow_add=true to add to it.`);
  }

  const entry = type === 'market' ? (side === -1 ? quote.bid : quote.ask) : params.price;
  if (!(entry > 0)) throw new Error(`No valid ${side === -1 ? 'bid' : 'ask'} price for ${symbol}`);

  // Stop loss: explicit price, or last confirmed swing ± ATR buffer from the active chart
  let sl = params.sl ?? null;
  let slBasis = { mode: 'manual' };
  if (sl == null) {
    if (ctx.chart_symbol !== symbol) {
      throw new Error(`Auto stop loss reads bars from the active chart (${ctx.chart_symbol}), but the order is for ${symbol}. Pass sl or switch the chart first.`);
    }
    const { bars } = await getOhlcv({ count: 300 });
    const atrLen = params.atr_length ?? cfg.atr_length;
    const pivotLen = params.pivot_length ?? cfg.pivot_length;
    const mult = params.sl_atr_mult ?? cfg.sl_atr_mult;
    const { atr, swing } = computeSwingAtr(bars, { side, atr_length: atrLen, pivot_length: pivotLen });
    sl = side === -1 ? roundToStep(swing.price + mult * atr, si.min_tick, 'ceil') : roundToStep(swing.price - mult * atr, si.min_tick, 'floor');
    slBasis = { mode: 'swing_atr', swing, atr, atr_length: atrLen, pivot_length: pivotLen, sl_atr_mult: mult };
  }

  const plan = planOrder({
    side, entry, sl, tp: params.tp ?? null, rr: params.rr ?? cfg.rr,
    qty: params.qty ?? null, risk_usdt: risk,
    fee_rate: cfg.fee_rate, slippage_rate: cfg.slippage_rate,
    min_tick: si.min_tick, qty_step: si.qty_step, qty_min: si.qty_min,
  });
  if (plan.planned_risk > cfg.max_risk_usdt) throw new Error(`Planned risk ${plan.planned_risk} exceeds max_risk_usdt ${cfg.max_risk_usdt}`);
  plan.margin = si.margin_rate ? Number((plan.notional * si.margin_rate).toFixed(4)) : null;
  const available = account.summary['Available funds'];
  if (plan.margin != null && typeof available === 'number' && plan.margin > available) {
    throw new Error(`Required margin ${plan.margin} exceeds available funds ${available}`);
  }

  const order = { symbol, side, type: ORDER_TYPE[type], qty: plan.qty };
  if (type === 'limit') order.limitPrice = params.price;
  if (type === 'stop') order.stopPrice = params.price;
  order.stopLoss = plan.sl;
  if (plan.tp != null) order.takeProfit = plan.tp;

  const base = { symbol, type, account: { broker: account.broker, id: account.account_id, name: account.account_name, type: account.account_type },
    quote, sl_basis: slBasis, plan, order };

  if (params.dry_run) {
    const logFile = logEvent({ event: 'dry_run', ...base });
    return { success: true, dry_run: true, ...base, log_file: logFile };
  }

  // Intent is logged before sending — a failed call must never be blindly retried
  logEvent({ event: 'submit_intent', ...base });
  let placeResult;
  try {
    placeResult = await brokerEval(`var r = await b.placeOrder(${JSON.stringify(order)}); return r === undefined ? null : r;`, 15000);
  } catch (err) {
    const logFile = logEvent({ event: 'submit_error', symbol, error: err.message });
    throw new Error(`placeOrder failed: ${err.message}. Check order_status before retrying (log: ${logFile}).`);
  }

  const prevQty = ctx.positions.reduce((s, p) => s + p.qty, 0);
  const verified = await waitFor(async () => {
    const snap = await snapshot(symbol);
    const pos = snap.positions[0];
    const done = type === 'market'
      ? !!pos && pos.qty > prevQty
      : snap.working_orders.some(o => o.bracket_of == null && Math.abs(o.qty - plan.qty) < 1e-9);
    return { done, ...snap };
  });

  const result = { success: verified.done, ...base, place_result: placeResult,
    verified: verified.done, position: verified.positions[0] || null, working_orders: verified.working_orders };
  if (!verified.done) result.warning = 'Order was sent but could not be confirmed within ~5 s. Check order_status before retrying.';
  result.log_file = logEvent({ event: verified.done ? 'filled_or_working' : 'unconfirmed', symbol, position: result.position, working_orders: result.working_orders });
  return result;
}

export async function closePosition({ symbol } = {}) {
  const cfg = loadConfig();
  const ctx = await getContext(symbol);
  assertAccountAllowed(ctx.account, cfg);
  const pos = ctx.positions[0];
  if (!pos) throw new Error(`No open position on ${ctx.symbol}`);
  logEvent({ event: 'close_intent', symbol: ctx.symbol, position: pos });
  await brokerEval(`return await b.closePosition(${JSON.stringify(pos.id)});`, 15000);
  const verified = await waitFor(async () => { const s = await snapshot(ctx.symbol); return { done: s.positions.length === 0, ...s }; });
  const result = { success: verified.done, symbol: ctx.symbol, closed: pos, verified: verified.done, remaining_orders: verified.working_orders };
  result.log_file = logEvent({ event: verified.done ? 'closed' : 'close_unconfirmed', symbol: ctx.symbol, position: pos });
  return result;
}

export async function setBrackets({ symbol, sl, tp } = {}) {
  if (sl == null && tp == null) throw new Error('Pass sl and/or tp');
  const cfg = loadConfig();
  const ctx = await getContext(symbol);
  assertAccountAllowed(ctx.account, cfg);
  const pos = ctx.positions[0];
  if (!pos) throw new Error(`No open position on ${ctx.symbol}`);
  const side = pos.side === 'short' ? -1 : 1;
  const brackets = {};
  if (sl != null) {
    brackets.stopLoss = roundToStep(sl, ctx.symbol_info.min_tick);
    const ref = side === -1 ? ctx.quote.ask : ctx.quote.bid;
    if (side === -1 ? brackets.stopLoss <= ref : brackets.stopLoss >= ref) throw new Error(`Stop loss ${brackets.stopLoss} is already through the market (${ref})`);
  } else if (pos.stop_loss != null) brackets.stopLoss = pos.stop_loss;
  if (tp != null) brackets.takeProfit = roundToStep(tp, ctx.symbol_info.min_tick);
  else if (pos.take_profit != null) brackets.takeProfit = pos.take_profit;

  logEvent({ event: 'brackets_intent', symbol: ctx.symbol, old: { sl: pos.stop_loss, tp: pos.take_profit }, new: brackets });
  await brokerEval(`return await b.editPositionBrackets(${JSON.stringify(pos.id)}, ${JSON.stringify(brackets)});`, 15000);
  const verified = await waitFor(async () => {
    const s = await snapshot(ctx.symbol);
    const p = s.positions[0];
    return { done: !!p && (brackets.stopLoss == null || p.stop_loss === brackets.stopLoss) && (brackets.takeProfit == null || p.take_profit === brackets.takeProfit), ...s };
  });
  const result = { success: verified.done, symbol: ctx.symbol, old: { sl: pos.stop_loss, tp: pos.take_profit },
    new: { sl: brackets.stopLoss ?? null, tp: brackets.takeProfit ?? null }, verified: verified.done, position: verified.positions[0] || null };
  result.log_file = logEvent({ event: verified.done ? 'brackets_set' : 'brackets_unconfirmed', symbol: ctx.symbol, new: result.new });
  return result;
}

/**
 * Tighten the stop of every open position that is in profit (or only `symbol`).
 * Bars for ATR come from the active chart; positions on other symbols are read by
 * temporarily switching the chart (restored afterwards) unless switch_chart is false.
 */
export async function trailStops({ symbol, dry_run = false, trail_atr_mult, min_gap_atr, min_step_atr, breakeven, switch_chart, bars_source } = {}) {
  const cfg = loadConfig();
  const tr = {
    trail_atr_mult: trail_atr_mult ?? cfg.trailing.trail_atr_mult,
    min_gap_atr: min_gap_atr ?? cfg.trailing.min_gap_atr,
    min_step_atr: min_step_atr ?? cfg.trailing.min_step_atr,
    breakeven: breakeven ?? cfg.trailing.breakeven,
    switch_chart: switch_chart ?? cfg.trailing.switch_chart,
    bars_source: bars_source ?? cfg.trailing.bars_source,
    atr_timeframe: cfg.trailing.atr_timeframe,
  };
  const ctx = await brokerEval(`
    ${ACCOUNT_JS}
    var chartSymbol = null; try { chartSymbol = window.TradingViewApi._activeChartWidgetWV.value().symbol(); } catch (e) {}
    var sym = ${JSON.stringify(symbol || null)};
    var positions = (await b.positions()).filter(function(p) { return p.qty > 0; })
      .filter(function(p) { return !sym || p.symbol === sym || p.symbol.slice(-(sym.length + 1)) === ':' + sym; }).map(${MAP_POSITION});
    for (var i = 0; i < positions.length; i++) {
      var q = await b.quotesSnapshot(positions[i].symbol);
      var si = await b.symbolInfo(positions[i].symbol);
      positions[i].bid = q.bid; positions[i].ask = q.ask; positions[i].min_tick = si.minTick;
    }
    return { account: account, chart_symbol: chartSymbol, positions: positions };
  `, 20000);
  assertAccountAllowed(ctx.account, cfg);
  if (!ctx.positions.length) return { success: true, dry_run, message: 'No open positions', results: [] };

  const results = [];
  let switched = false;
  try {
    for (const pos of ctx.positions) {
      const side = pos.side === 'short' ? -1 : 1;
      const live = await bybitQuote(pos.symbol);
      const price = side === -1 ? (live ? live.ask : pos.ask) : (live ? live.bid : pos.bid);
      const base = { symbol: pos.symbol, side: pos.side, qty: pos.qty, entry: pos.avg_price, price, quote_source: live ? 'bybit' : 'tradingview', current_sl: pos.stop_loss ?? null };
      if (!(side === -1 ? price < pos.avg_price : price > pos.avg_price)) { results.push({ ...base, action: 'skip', reason: 'position is not in profit' }); continue; }
      let bars = tr.bars_source === 'bybit' ? await bybitBars(pos.symbol, tr.atr_timeframe) : null;
      if (!bars) {
        if (pos.symbol !== ctx.chart_symbol) {
          if (!tr.switch_chart) { results.push({ ...base, action: 'skip', reason: `not on the active chart (${ctx.chart_symbol}) and switch_chart is off` }); continue; }
          await setSymbol({ symbol: pos.symbol });
          switched = true;
        }
        ({ bars } = await getOhlcv({ count: 300 }));
      }
      const atr = computeAtr(bars, cfg.atr_length);
      const plan = computeTrailStop({ side, entry: pos.avg_price, price, current_sl: pos.stop_loss ?? null, atr, min_tick: pos.min_tick,
        trail_atr_mult: tr.trail_atr_mult, min_gap_atr: tr.min_gap_atr, min_step_atr: tr.min_step_atr, fee_rate: cfg.fee_rate, breakeven: tr.breakeven });
      const row = { ...base, atr, ...plan };
      if (plan.action === 'move') {
        row.locked_profit = Number((plan.locked_per_unit * pos.qty).toFixed(4));
        if (!dry_run) {
          try {
            const res = await setBrackets({ symbol: pos.symbol, sl: plan.new_sl });
            row.applied = res.verified;
            if (!res.verified) row.warning = 'Stop change sent but not confirmed — check order_status';
          } catch (err) { row.applied = false; row.error = err.message; }
        }
      }
      results.push(row);
    }
  } finally {
    if (switched && ctx.chart_symbol) { try { await setSymbol({ symbol: ctx.chart_symbol }); } catch { /* best effort */ } }
  }
  const log_file = logEvent({ event: dry_run ? 'trail_dry_run' : 'trail', settings: tr, results });
  return { success: results.every(r => !r.error && r.applied !== false), dry_run, settings: tr, results, log_file };
}

export async function cancelOrders({ symbol, order_id, include_brackets = false } = {}) {
  const cfg = loadConfig();
  const ctx = await getContext(symbol);
  assertAccountAllowed(ctx.account, cfg);
  const targets = order_id
    ? ctx.working_orders.filter(o => String(o.id) === String(order_id))
    : ctx.working_orders.filter(o => include_brackets || o.bracket_of == null);
  if (!targets.length) throw new Error(order_id ? `Working order ${order_id} not found on ${ctx.symbol}` : `No cancellable working orders on ${ctx.symbol}`);
  logEvent({ event: 'cancel_intent', symbol: ctx.symbol, orders: targets.map(o => o.id) });
  await brokerEval(`var ids = ${JSON.stringify(targets.map(o => o.id))}; for (var i = 0; i < ids.length; i++) await b.cancelOrder(ids[i]); return ids.length;`, 15000);
  const ids = new Set(targets.map(o => String(o.id)));
  const verified = await waitFor(async () => { const s = await snapshot(ctx.symbol); return { done: !s.working_orders.some(o => ids.has(String(o.id))), ...s }; });
  const result = { success: verified.done, symbol: ctx.symbol, cancelled: targets, verified: verified.done, remaining_orders: verified.working_orders };
  result.log_file = logEvent({ event: verified.done ? 'cancelled' : 'cancel_unconfirmed', symbol: ctx.symbol, orders: [...ids] });
  return result;
}
