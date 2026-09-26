/**
 * Multi-timeframe auto-trader.
 *
 * Top-down read of the chart (1D → 1h → 15m → 5m → 1m), a rule-based decision
 * (market / limit / stop / wait) and execution through placeOrder, so money
 * management and all trading guards apply unchanged.
 *
 * Playbook (default is to NOT trade):
 *  - direction only when the weighted HTF bias is clear and 1h confirms it
 *  - over-extended or RSI-stretched → limit on the 15m EMA20 pullback (no chasing)
 *  - 5m compression pressing the range edge → stop entry on the breakout
 *  - pullback into value with a 1m momentum trigger → market, without trigger → stop above the trigger bar
 *  - structural stop behind the last 5m swing, must leave ≥ rr·R room to the next 1h/15m/daily level
 *  - T3 FAST/SLOW by order type: market / stop entries need the 15m T3 with the trade and no fresh 5m
 *    T3 cross against it; a pullback limit only needs the 1h T3 with the trade. When the 15m T3 is against
 *    but the 1h T3 agrees (pullback in progress) a market / stop plan becomes a limit on the nearest EMA
 *    below price (t3_pullback_limit). A fresh T3 cross in the trade direction on 5m/1m counts as a trigger
 *  - buy low / sell high: longs only in the lower half (discount) of the 1h swing range, shorts only
 *    in the upper half (premium); only a 5m compression breakout (stop) is exempt. TP sits just in front of the
 *    next opposing level (at least rr·R)
 *  - confluence score (0–100) must reach min_score
 */
import { evaluate } from '../connection.js';
import { getOhlcv } from './data.js';
import { setSymbol, setTimeframe, resetView } from './chart.js';
import { captureScreenshot } from './capture.js';
import { ema, t3State } from './ta.js';

export { ema };
import { computeAtr, loadConfig, placeOrder, status, symbolSpec, roundToStep, logEvent, stopTooTight } from './trading.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export const TIMEFRAMES = [
  { key: '1d', res: '1D', sec: 86400, weight: 0.30 },
  { key: '1h', res: '60', sec: 3600, weight: 0.30 },
  { key: '15m', res: '15', sec: 900, weight: 0.20 },
  { key: '5m', res: '5', sec: 300, weight: 0.15 },
  { key: '1m', res: '1', sec: 60, weight: 0.05 },
];

export const AUTO_DEFAULTS = { min_score: 65, min_bias: 0.35, bars: 400, zone_max: 0.5, tp_at_level: true, t3_pullback_limit: true };
export const T3_DEFAULTS = { fast: 8, slow: 21, factor: 0.7 };

// ── Indicators (closed bars) ────────────────────────────────────────────

export function rsi(closes, len = 14) {
  if (closes.length < len + 1) return closes.map(() => null);
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= len; l /= len;
  const val = () => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  const out = new Array(len).fill(null);
  out.push(val());
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (len - 1) + Math.max(d, 0)) / len;
    l = (l * (len - 1) + Math.max(-d, 0)) / len;
    out.push(val());
  }
  return out;
}

/** Wilder ADX / DMI. */
export function adx(bars, len = 14) {
  if (bars.length < len * 2 + 1) return null;
  let trS = 0, pS = 0, mS = 0;
  const dx = [];
  for (let i = 1; i < bars.length; i++) {
    const { high: h, low: l } = bars[i];
    const { high: ph, low: pl, close: pc } = bars[i - 1];
    const up = h - ph, dn = pl - l;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i <= len) { trS += tr; pS += pdm; mS += mdm; if (i < len) continue; }
    else { trS = trS - trS / len + tr; pS = pS - pS / len + pdm; mS = mS - mS / len + mdm; }
    const pdi = trS ? 100 * pS / trS : 0, mdi = trS ? 100 * mS / trS : 0;
    dx.push({ dx: pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0, pdi, mdi });
  }
  let a = dx.slice(0, len).reduce((s, x) => s + x.dx, 0) / len;
  for (const x of dx.slice(len)) a = (a * (len - 1) + x.dx) / len;
  const last = dx[dx.length - 1];
  return { adx: a, plus_di: last.pdi, minus_di: last.mdi };
}

/** Confirmed pivots: strictly beyond the L bars on the left, at least equal to the R bars on the right. */
export function swings(bars, L = 3, R = 3) {
  const highs = [], lows = [];
  for (let i = L; i < bars.length - R; i++) {
    const h = bars[i].high, l = bars[i].low;
    let isH = true, isL = true;
    for (let j = i - L; j < i; j++) { if (!(h > bars[j].high)) isH = false; if (!(l < bars[j].low)) isL = false; }
    for (let j = i + 1; j <= i + R; j++) { if (!(h >= bars[j].high)) isH = false; if (!(l <= bars[j].low)) isL = false; }
    if (isH) highs.push({ price: h, time: bars[i].time });
    if (isL) lows.push({ price: l, time: bars[i].time });
  }
  return { highs, lows };
}

// ── Per-timeframe read ──────────────────────────────────────────────────

const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(4)));

/** rawBars includes the forming bar as the last element; it is ignored. */
export function analyzeTimeframe(rawBars, { pivot = 3, t3 = T3_DEFAULTS } = {}) {
  const bars = rawBars.slice(0, -1);
  if (bars.length < 60) throw new Error(`Not enough closed bars for analysis: ${bars.length}`);
  const closes = bars.map(b => b.close);
  const last = bars[bars.length - 1], prev = bars[bars.length - 2];
  const close = last.close;
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = closes.length >= 200 ? ema(closes, 200) : null;
  const E20 = e20.at(-1), E50 = e50.at(-1), E200 = e200 ? e200.at(-1) : null;
  const atr = computeAtr(rawBars, 14);
  const rs = rsi(closes, 14);
  const dmi = adx(bars, 14);
  const { highs, lows } = swings(bars, pivot, pivot);

  let structure = 'range';
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs.at(-1).price > highs.at(-2).price, hl = lows.at(-1).price > lows.at(-2).price;
    if (hh && hl) structure = 'up';
    else if (!hh && !hl) structure = 'down';
  }
  const slope = (E20 - e20.at(-6)) / 5 / atr; // ATRs per bar

  let score = 0, parts = 0;
  score += close > E50 ? 1 : -1; parts++;
  score += E20 > E50 ? 1 : -1; parts++;
  if (E200 != null) { score += E50 > E200 ? 1 : -1; parts++; }
  score += structure === 'up' ? 1 : structure === 'down' ? -1 : 0; parts++;
  score += slope > 0.02 ? 1 : slope < -0.02 ? -1 : 0; parts++;

  const win = bars.slice(-12);
  const rh = Math.max(...win.map(b => b.high)), rl = Math.min(...win.map(b => b.low));
  const volWin = bars.slice(-21, -1).map(b => b.volume || 0);
  const avgVol = volWin.reduce((a, b) => a + b, 0) / (volWin.length || 1);

  return {
    close, ema20: E20, ema50: E50, ema200: E200, atr,
    rsi: rs.at(-1), rsi_prev: rs.at(-2),
    adx: dmi ? dmi.adx : null, plus_di: dmi ? dmi.plus_di : null, minus_di: dmi ? dmi.minus_di : null,
    structure, slope, trend: Number((score / parts).toFixed(3)),
    extension: (close - E20) / atr,
    range: { high: rh, low: rl, size_atr: (rh - rl) / atr },
    compressed: rh - rl < 2.5 * atr,
    swing_highs: highs.slice(-6).map(p => p.price),
    swing_lows: lows.slice(-6).map(p => p.price),
    rel_vol: avgVol > 0 ? (last.volume || 0) / avgVol : null,
    t3: t3State(closes, { ...t3, recent: 3 }),
    last_bar: { open: last.open, high: last.high, low: last.low, close: last.close },
    prev_bar: { open: prev.open, high: prev.high, low: prev.low, close: prev.close },
    bars: bars.length,
  };
}

// ── Decision ────────────────────────────────────────────────────────────

/**
 * a = { '1d', '1h', '15m', '5m', '1m' } → analyzeTimeframe results.
 * Returns { action: 'trade' | 'wait', side, type, entry, sl, score, reasons, ... }.
 */
export function decide(a, { bid, ask, min_tick, rr = 2, min_score = AUTO_DEFAULTS.min_score, min_bias = AUTO_DEFAULTS.min_bias,
  cost_rate = 0.0004, min_sl_pct = 0.0015, max_cost_share = 0.3, zone_max = AUTO_DEFAULTS.zone_max, tp_at_level = AUTO_DEFAULTS.tp_at_level,
  t3_pullback_limit = AUTO_DEFAULTS.t3_pullback_limit }) {
  const reasons = [];
  const bias = TIMEFRAMES.reduce((s, tf) => s + tf.weight * a[tf.key].trend, 0);
  const base = { bias: Number(bias.toFixed(3)), trends: Object.fromEntries(TIMEFRAMES.map(tf => [tf.key, a[tf.key].trend])) };
  const wait = (why, extra = {}) => ({ ...base, action: 'wait', side: null, reasons: [...reasons, why], ...extra });

  const dir = bias >= min_bias ? 1 : bias <= -min_bias ? -1 : 0;
  if (!dir) return wait(`No directional edge: weighted bias ${base.bias} (need ±${min_bias})`);
  const side = dir === 1 ? 'long' : 'short';
  if (Math.sign(a['1h'].trend) !== dir) return wait(`1h trend (${a['1h'].trend}) does not confirm the ${side} bias`);
  if (a['1d'].trend * dir < -0.4) return wait(`Daily trend (${a['1d'].trend}) is strongly against a ${side}`);
  if (a['15m'].trend * dir < -0.2) return wait(`15m trend (${a['15m'].trend}) is against — wait for it to realign`);
  reasons.push(`Top-down ${side} bias ${base.bias} (1D ${a['1d'].trend}, 1h ${a['1h'].trend}, 15m ${a['15m'].trend}, 5m ${a['5m'].trend})`);

  const m15 = a['15m'], m5 = a['5m'], m1 = a['1m'];
  // T3 is gated per order type further below (after the order type is chosen)
  const t3Against15 = !!(m15.t3 && m15.t3.bull !== (dir === 1));
  const t3Cross5Against = !!(m5.t3 && m5.t3.cross === -dir);
  const t3Aligned1h = !a['1h'].t3 || a['1h'].t3.bull === (dir === 1);
  const t3Reason = t3Against15 ? `15m T3 FAST is ${m15.t3.bull ? 'above' : 'below'} T3 SLOW — against the ${side}`
    : `Fresh 5m T3 cross against the ${side} (${m5.t3?.cross_bars_ago} bars ago)`;
  const t3Trigger = !t3Against15 && ((m5.t3 && m5.t3.cross === dir) || (m1.t3 && m1.t3.cross === dir));
  const trending = (a['1h'].adx ?? 0) >= 20 || (m15.adx ?? 0) >= 22;
  const ext15 = m15.extension * dir;
  const exhausted = dir === 1 ? (m15.rsi > 70 || m5.rsi > 75) : (m15.rsi < 30 || m5.rsi < 25);
  const mom1 = t3Trigger || (dir === 1
    ? (m1.last_bar.close > m1.prev_bar.high || (m1.rsi > m1.rsi_prev && m1.rsi > 45))
    : (m1.last_bar.close < m1.prev_bar.low || (m1.rsi < m1.rsi_prev && m1.rsi < 55)));
  const rangeSize = m5.range.high - m5.range.low;
  const nearEdge = rangeSize > 0 && (dir === 1 ? (m5.close - m5.range.low) / rangeSize >= 0.7 : (m5.range.high - m5.close) / rangeSize >= 0.7);
  const market = dir === 1 ? ask : bid;

  let type, entry, why, slRaw = null, slBasis = null, breakout = false;
  if (ext15 > 1.5 || exhausted) {
    type = 'limit'; entry = m15.ema20;
    why = `Extended ${ext15.toFixed(2)} ATR from 15m EMA20${exhausted ? ' with stretched RSI' : ''} — no chase, limit on the 15m EMA20 pullback`;
  } else if (m5.compressed && nearEdge) {
    type = 'stop'; entry = (dir === 1 ? m5.range.high : m5.range.low) + dir * 0.1 * m5.atr;
    slRaw = (dir === 1 ? m5.range.low : m5.range.high) - dir * 0.25 * m5.atr; slBasis = '5m range edge'; breakout = true;
    why = `5m compression (${m5.range.size_atr.toFixed(1)} ATR) pressing the range ${dir === 1 ? 'high' : 'low'} — stop entry on the breakout`;
  } else if (Math.abs(m15.extension) <= 0.75 || Math.abs(m5.extension) <= 0.5) {
    if (mom1) {
      type = 'market'; entry = market;
      why = `Pullback into value (15m/5m EMA) with a ${t3Trigger ? 'fresh T3 cross' : '1m momentum'} trigger — market entry`;
    } else {
      type = 'stop';
      entry = dir === 1 ? Math.max(m1.last_bar.high, m1.prev_bar.high) + 0.1 * m1.atr : Math.min(m1.last_bar.low, m1.prev_bar.low) - 0.1 * m1.atr;
      why = 'In value but no 1m trigger yet — stop entry beyond the 1m trigger bars';
    }
  } else {
    type = 'limit'; entry = m5.ema20;
    why = `Moderately extended (${ext15.toFixed(2)} ATR on 15m) — limit on the 5m EMA20`;
  }
  if (type === 'limit' && (dir === 1 ? entry >= ask : entry <= bid)) { type = 'market'; entry = market; why += ' (level already reached → market)'; }
  if (type === 'stop' && (dir === 1 ? entry <= ask : entry >= bid)) { type = 'market'; entry = market; why += ' (trigger already crossed → market)'; }

  // T3 gate by order type. Market / stop entries need the 15m T3 with the trade and no fresh 5m cross against it.
  // A pullback limit waits for price to come to value, so it only needs the 1h T3 with the trade — this is what
  // lets the playbook buy the pullback while the 15m T3 is still pointing into it.
  if (type !== 'limit' && (t3Against15 || t3Cross5Against)) {
    const pull = t3_pullback_limit && t3Aligned1h ? pullbackLimit(a, dir, bid, ask) : null;
    if (!pull) return wait(t3Aligned1h ? t3Reason : `${t3Reason}; 1h T3 against as well`);
    type = 'limit'; entry = pull.entry; slRaw = null; slBasis = null;
    why = `${t3Reason}, but the 1h T3 is with the ${side} — pullback in progress, limit on the ${pull.basis}`;
  }
  if (type === 'limit' && !t3Aligned1h) return wait(`1h T3 FAST is ${a['1h'].t3.bull ? 'above' : 'below'} T3 SLOW — against a ${side} pullback limit`);

  if (type !== 'market') entry = roundToStep(entry, min_tick, (dir === 1) === (type === 'limit') ? 'floor' : 'ceil');
  reasons.push(why);

  const fin = finishPlan(a, { dir, type, entry, slRaw, slBasis, breakout, bid, ask, min_tick, rr, cost_rate, min_sl_pct, max_cost_share, zone_max, tp_at_level });
  if (!fin.ok) return wait(fin.why, { plan: fin.plan });
  const { plan, nearest, roomR } = fin;
  reasons.push(nearest == null ? 'No opposing level in range (open space)' : `${roomR.toFixed(2)}R of room to the next level ${nearest}`);
  if (fin.zone) reasons.push(`Entry at ${(fin.zone.position * 100).toFixed(0)} % of the 1h range ${fin.zone.low}–${fin.zone.high}${breakout && type === 'stop' ? ' (5m compression breakout — zone rule exempt)' : ''}; TP ${plan.tp} (${plan.tp_basis})`);

  // T3 points follow the gate: the 1h T3 for a limit, the 15m T3 for market / stop entries
  const t3Pts = (type === 'limit' ? (t3Aligned1h ? 4 : 0) : (m15.t3 && m15.t3.bull === (dir === 1) ? 4 : 0))
    + (m5.t3 && m5.t3.bull === (dir === 1) ? 3 : 0) + (t3Trigger ? 3 : 0);
  const sc = {
    bias: Math.round(30 * Math.min(1, Math.abs(bias))),
    regime: trending ? 10 : 3,
    t3: t3Pts,
    location: roomR >= rr + 1 ? 20 : 12,
    trigger: type === 'market' ? 15 : type === 'stop' ? ((m5.rel_vol ?? 0) >= 1.2 ? 15 : 10) : 10,
    momentum: (dir === 1 ? m15.rsi >= 40 && m15.rsi <= 68 : m15.rsi >= 32 && m15.rsi <= 60) ? 10 : 3,
    volume: (m5.rel_vol ?? 0) >= 1 ? 5 : 0,
  };
  const score = Object.values(sc).reduce((s, x) => s + x, 0);
  const extra = { plan, score, score_breakdown: sc, trending, nearest_level: nearest, room_r: Number.isFinite(roomR) ? Number(roomR.toFixed(2)) : null };
  if (score < min_score) return wait(`Confluence score ${score} < ${min_score}`, extra);
  return { ...base, action: 'trade', ...plan, reasons, ...extra };
}

/**
 * Limit entry for a pullback that is still running: the nearest of 5m EMA20, 15m EMA20 and 15m EMA50
 * below the market for a long (above it for a short). Returns { entry, basis } or null.
 */
export function pullbackLimit(a, dir, bid, ask) {
  const cands = [[a['5m'].ema20, '5m EMA20'], [a['15m'].ema20, '15m EMA20'], [a['15m'].ema50, '15m EMA50']]
    .filter(([p]) => p != null && (dir === 1 ? p < ask : p > bid));
  if (!cands.length) return null;
  const [entry, basis] = cands.sort((x, y) => (dir === 1 ? y[0] - x[0] : x[0] - y[0]))[0];
  return { entry, basis };
}

/**
 * Shared tail of every plan: structural SL, stop width / cost guards and room to the next level.
 * Returns { ok, plan, nearest, roomR } or { ok: false, why, plan }.
 */
export function finishPlan(a, { dir, type, entry, slRaw = null, slBasis = null, breakout = false, bid, ask, min_tick, rr = 2, cost_rate = 0.0004, min_sl_pct = 0.0015, max_cost_share = 0.3,
  zone_max = AUTO_DEFAULTS.zone_max, tp_at_level = AUTO_DEFAULTS.tp_at_level }) {
  const m15 = a['15m'], m5 = a['5m'];
  const side = dir === 1 ? 'long' : 'short';
  // Structural stop behind the most recent 5m swing beyond entry, buffered by 0.5 ATR(5m)
  if (slRaw == null) {
    const beyond = dir === 1 ? m5.swing_lows.filter(p => p < entry) : m5.swing_highs.filter(p => p > entry);
    if (beyond.length) { slRaw = beyond.at(-1) - dir * 0.5 * m5.atr; slBasis = '5m swing ± 0.5 ATR'; }
    else { slRaw = entry - dir * 1.5 * m15.atr; slBasis = '1.5 ATR(15m)'; }
  }
  if (Math.abs(entry - slRaw) < 0.5 * m5.atr) { slRaw = entry - dir * 0.5 * m5.atr; slBasis += ' (widened to 0.5 ATR(5m))'; }
  const sl = roundToStep(slRaw, min_tick, dir === 1 ? 'floor' : 'ceil');
  const dist = Math.abs(entry - sl);
  const plan = { side, type, entry, sl, sl_basis: slBasis, dist: Number(dist.toFixed(8)) };
  if (dist > 3 * m15.atr) return { ok: false, plan, why: `Structural stop too wide: ${(dist / m15.atr).toFixed(1)} ATR(15m) > 3` };
  const tight = stopTooTight({ entry, dist, cost_per_unit: cost_rate * (entry + sl), min_sl_pct, max_cost_share });
  if (tight) return { ok: false, plan, why: `${tight} — market too quiet for a money-managed stop` };

  // Room to the next opposing level: 1h / 15m swings and the previous daily high/low.
  // Levels the market has already broken (between a pending entry and the current price) are not obstacles.
  const beyondFrom = dir === 1 ? Math.max(entry, ask) : Math.min(entry, bid);
  const levels = dir === 1
    ? [...a['1h'].swing_highs, ...m15.swing_highs, a['1d'].last_bar.high].filter(p => p > beyondFrom + 0.1 * m5.atr)
    : [...a['1h'].swing_lows, ...m15.swing_lows, a['1d'].last_bar.low].filter(p => p < beyondFrom - 0.1 * m5.atr);
  const nearest = levels.length ? (dir === 1 ? Math.min(...levels) : Math.max(...levels)) : null;
  const roomR = nearest == null ? Infinity : Math.abs(nearest - entry) / dist;
  if (roomR < rr) return { ok: false, plan, why: `Only ${roomR.toFixed(2)}R of room to the next ${dir === 1 ? 'resistance' : 'support'} ${nearest} — need ${rr}R` };

  // Buy low, sell high: a long enters in the discount (lower part) of the 1h swing range, a short in the premium.
  // Only a real 5m compression breakout (stop order) is exempt — a stop above the 1m trigger bars is not
  // (WLD 26.9.: a trigger-bar buy stop at 71 % of the range was waved through as a "breakout" and lost 1R).
  const zone = rangeZone(a['1h'], entry);
  if (zone && zone_max != null && !(breakout && type === 'stop')) {
    const inZone = dir === 1 ? zone.position <= zone_max : zone.position >= 1 - zone_max;
    if (!inZone) return { ok: false, plan, zone, why: `Buy low / sell high: entry at ${(zone.position * 100).toFixed(0)} % of the 1h range ${zone.low}–${zone.high}` +
      ` — a ${side} needs ${dir === 1 ? `≤ ${Math.round(zone_max * 100)} % (discount)` : `≥ ${Math.round((1 - zone_max) * 100)} % (premium)`}` };
  }

  // Sell high (short: buy low): TP just in front of the next opposing level, never closer than rr·R
  let tp, tpBasis;
  if (tp_at_level && nearest != null) {
    let t = nearest - dir * Math.max(min_tick || 0, 0.1 * m5.atr);
    if (Math.abs(t - entry) < rr * dist) t = entry + dir * rr * dist;
    tp = roundToStep(t, min_tick, dir === 1 ? 'floor' : 'ceil');
    tpBasis = `in front of the next ${dir === 1 ? 'resistance' : 'support'} ${nearest}`;
  } else {
    tp = roundToStep(entry + dir * rr * dist, min_tick, dir === 1 ? 'ceil' : 'floor');
    tpBasis = `${rr}R`;
  }
  plan.tp = tp;
  plan.tp_basis = tpBasis;
  plan.rr_target = Number((Math.abs(tp - entry) / dist).toFixed(2));
  return { ok: true, plan, nearest, roomR, zone };
}

/**
 * Position of `price` in the 1h dealing range (last swing low → last swing high): 0 = low, 1 = high,
 * < 0 below the range, > 1 above it. Falls back to the last two swings when the latest pair is inverted.
 */
export function rangeZone(t, price) {
  let hi = t.swing_highs.at(-1), lo = t.swing_lows.at(-1);
  if (!(hi > lo)) { hi = Math.max(...t.swing_highs.slice(-2)); lo = Math.min(...t.swing_lows.slice(-2)); }
  if (!(hi > lo) || !Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { high: hi, low: lo, position: Number(((price - lo) / (hi - lo)).toFixed(3)) };
}

// ── Orchestration ───────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function chartState() {
  return evaluate(`(function() { var c = ${CHART_API}; return { symbol: c.symbol(), resolution: c.resolution() }; })()`);
}

/** Switch timeframe and wait until the chart really shows bars of that spacing for the symbol. */
async function loadBars(symbol, tf, count) {
  await setTimeframe({ timeframe: tf.res });
  const deadline = Date.now() + 20000;
  let last = null, lastFix = Date.now();
  while (Date.now() < deadline) {
    try {
      const st = await chartState();
      const { bars } = await getOhlcv({ count });
      const diffs = bars.slice(-40).map((b, i, arr) => (i ? b.time - arr[i - 1].time : null)).filter(Boolean).sort((x, y) => x - y);
      const median = diffs[Math.floor(diffs.length / 2)];
      if (st.symbol === symbol && median === tf.sec && bars.length >= 61) { await resetView(); return bars; }
      if (st.symbol !== symbol && Date.now() - lastFix > 3000) { await setSymbol({ symbol }); await setTimeframe({ timeframe: tf.res }); lastFix = Date.now(); }
      last = { symbol: st.symbol, resolution: st.resolution, median_spacing: median, bars: bars.length };
    } catch (err) { last = { error: err.message }; }
    await sleep(400);
  }
  throw new Error(`Bars for ${symbol} ${tf.key} did not load: ${JSON.stringify(last)}`);
}

function summarize(t) {
  return {
    trend: t.trend, structure: t.structure, t3: t.t3 ? `${t.t3.bull ? 'bull' : 'bear'}${t.t3.cross ? (t.t3.cross > 0 ? ', cross up ' : ', cross down ') + t.t3.cross_bars_ago + ' bars ago' : ''}` : null, close: r4(t.close), ema20: r4(t.ema20), ema50: r4(t.ema50), ema200: r4(t.ema200),
    rsi: r4(t.rsi), adx: r4(t.adx), atr: r4(t.atr), ext_atr: r4(t.extension), compressed: t.compressed, rel_vol: r4(t.rel_vol),
  };
}

/**
 * Analyse `symbol` on 1D/1h/15m/5m/1m and, if the playbook qualifies a trade,
 * place it through placeOrder (money management + guards). A 5m screenshot is taken
 * after the decision. The symbol stays on the chart; the original timeframe is restored.
 */
export async function autoOrder({ symbol, dry_run = false, risk_usdt, min_score, min_bias, screenshot = true } = {}) {
  if (!symbol) throw new Error('symbol is required (e.g. BYBIT:BTCUSDT.P)');
  const cfg = loadConfig();
  const auto = { ...AUTO_DEFAULTS, ...(cfg.auto || {}) };
  const opts = { min_score: min_score ?? auto.min_score, min_bias: min_bias ?? auto.min_bias, rr: cfg.rr,
    cost_rate: cfg.fee_rate + cfg.slippage_rate, min_sl_pct: cfg.min_sl_pct, max_cost_share: cfg.max_cost_share,
    zone_max: auto.zone_max, tp_at_level: auto.tp_at_level, t3_pullback_limit: auto.t3_pullback_limit };

  const original = await chartState();
  const bare = symbol.includes(':') ? symbol.toUpperCase() : ':' + symbol.toUpperCase();
  const isTarget = (s) => s.toUpperCase() === symbol.toUpperCase() || s.toUpperCase().endsWith(bare);
  // TradingView can jump to the symbol of a just-filled order — retry the switch
  let full = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await setSymbol({ symbol });
    await sleep(attempt * 700);
    ({ symbol: full } = await chartState());
    if (isTarget(full)) break;
  }
  if (!isTarget(full)) throw new Error(`Chart did not switch to ${symbol} after 3 attempts (shows ${full}). Use the full ticker, e.g. BYBIT:BTCUSDT.P`);

  const st = await status({ symbol: full });
  const pending = st.working_orders.filter(o => o.bracket_of == null);
  if (st.positions.length || pending.length) {
    await setTimeframe({ timeframe: original.resolution });
    const reason = st.positions.length
      ? `A position on ${full} is already open (${st.positions[0].side} ${st.positions[0].qty}) — manage it with positions_trail`
      : `A pending ${pending[0].type} ${pending[0].side} order on ${full} is already working (id ${pending[0].id}) — cancel it first with order_cancel`;
    return { success: true, symbol: full, action: 'skip', reason };
  }

  const analysis = {};
  try {
    for (const tf of TIMEFRAMES) analysis[tf.key] = analyzeTimeframe(await loadBars(full, tf, auto.bars), { t3: { ...T3_DEFAULTS, ...(cfg.t3 || {}) } });

    const spec = await symbolSpec(full);
    const decision = decide(analysis, { bid: spec.bid, ask: spec.ask, min_tick: spec.min_tick, ...opts });
    const timeframes = Object.fromEntries(TIMEFRAMES.map(tf => [tf.key, summarize(analysis[tf.key])]));
    logEvent({ event: 'autoorder_decision', symbol: full, dry_run, decision, timeframes });

    const result = { success: true, symbol: full, dry_run, decision, timeframes, quote: { bid: spec.bid, ask: spec.ask }, order: null };
    if (decision.action === 'trade') {
      result.order = await placeOrder({
        symbol: full, side: decision.side, type: decision.type,
        price: decision.type === 'market' ? undefined : decision.entry,
        sl: decision.sl, tp: decision.tp, risk_usdt, dry_run,
      });
      result.success = result.order.success;
    }

    // Screenshot of the setup timeframe (5m) after the decision, so order lines are visible
    if (screenshot) {
      try {
        await loadBars(full, TIMEFRAMES.find(tf => tf.key === '5m'), 100);
        const name = `autoorder_${full.replace(/[^A-Za-z0-9]+/g, '_')}_${decision.action}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
        result.screenshot = (await captureScreenshot({ region: 'full', filename: name })).file_path;
      } catch (err) { result.screenshot_error = err.message; }
    }
    return result;
  } finally {
    try { await setTimeframe({ timeframe: original.resolution }); } catch { /* best effort */ }
  }
}
