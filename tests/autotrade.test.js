/**
 * Auto-trader unit tests — indicators and the decision playbook, no TradingView needed.
 *
 * Run: node --test tests/autotrade.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, adx, swings, analyzeTimeframe, decide, rangeZone, pullbackLimit } from '../src/core/autotrade.js';
import { t3, t3State } from '../src/core/ta.js';

describe('indicators', () => {
  it('ema seeds with SMA and follows the series', () => {
    const e = ema([1, 2, 3, 4, 5, 6], 3);
    assert.deepEqual(e.slice(0, 2), [null, null]);
    assert.equal(e[2], 2);
    assert.equal(e[5], 5);
  });

  it('rsi is 100 on a rising series and 0 on a falling one', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    assert.equal(rsi(up).at(-1), 100);
    assert.equal(rsi(up.slice().reverse()).at(-1), 0);
  });

  it('adx is high in a steady trend', () => {
    const bars = Array.from({ length: 80 }, (_, i) => ({ high: 101 + i, low: 99 + i, close: 100 + i }));
    const r = adx(bars);
    assert.ok(r.adx > 50);
    assert.ok(r.plus_di > r.minus_di);
  });

  it('swings finds confirmed pivots only', () => {
    const bars = [1, 2, 3, 9, 3, 2, 1, 5].map((h, i) => ({ high: h, low: h - 1, time: i }));
    const { highs } = swings(bars, 3, 3);
    assert.deepEqual(highs.map(h => h.price), [9]);
  });
});

describe('T3', () => {
  it('t3 tracks a constant series exactly (coefficients sum to 1)', () => {
    const v = t3(Array(200).fill(50), 8);
    assert.ok(Math.abs(v.at(-1) - 50) < 1e-9);
    assert.equal(v[10], null);
  });

  it('fast above slow in an uptrend, cross detected after a reversal', () => {
    const upSeries = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
    const st = t3State(upSeries);
    assert.equal(st.bull, true);
    assert.equal(st.cross, 0);
    let rev = null;
    const s = [...upSeries];
    for (let k = 0; k < 60 && !(rev && rev.cross === -1); k++) { s.push(s.at(-1) - 2); rev = t3State(s, { recent: 1 }); }
    assert.equal(rev.cross, -1);
    assert.equal(rev.bull, false);
  });

  it('returns null without enough bars', () => {
    assert.equal(t3State([1, 2, 3]), null);
  });
});

describe('analyzeTimeframe', () => {
  const mk = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { time: i * 60, open: c - 0.2, high: c + 0.5, low: c - 0.5, close: c, volume: 100 }; });

  it('reads a zig-zag uptrend as trend up', () => {
    const t = analyzeTimeframe(mk(260, i => 100 + i * 0.3 + 3 * Math.sin(i / 4)));
    assert.equal(t.structure, 'up');
    assert.ok(t.trend > 0.5);
  });

  it('reads a zig-zag downtrend as trend down', () => {
    const t = analyzeTimeframe(mk(260, i => 300 - i * 0.3 + 3 * Math.sin(i / 4)));
    assert.equal(t.structure, 'down');
    assert.ok(t.trend < -0.5);
  });

  it('refuses too little history', () => {
    assert.throws(() => analyzeTimeframe(mk(40, i => 100 + i)), /Not enough/);
  });
});

// Hand-built analysis objects make every playbook branch explicit
function tf(over = {}) {
  return {
    close: 100, ema20: 100, ema50: 98, ema200: 95, atr: 1, rsi: 55, rsi_prev: 50, adx: 25,
    structure: 'up', trend: 0.8, extension: 0.2,
    range: { high: 102, low: 97, size_atr: 5 }, compressed: false,
    swing_highs: [103, 110], swing_lows: [96, 98.5], rel_vol: 1.1,
    last_bar: { open: 99.8, high: 100.3, low: 99.7, close: 100.2 }, prev_bar: { open: 99.5, high: 100.1, low: 99.4, close: 99.8 },
    t3: { bull: (over.trend ?? 0.8) >= 0, cross: 0, cross_bars_ago: null },
    ...over,
  };
}
const up = () => ({ '1d': tf({ swing_highs: [120], last_bar: { high: 125, low: 90 } }), '1h': tf({ swing_highs: [115] }), '15m': tf({ swing_highs: [112] }), '5m': tf(), '1m': tf() });
const Q = { bid: 99.99, ask: 100, min_tick: 0.01, rr: 2, min_score: 65, min_bias: 0.35 };

describe('decide', () => {
  it('waits when there is no directional edge', () => {
    const a = up(); for (const k of Object.keys(a)) a[k].trend = 0;
    const d = decide(a, Q);
    assert.equal(d.action, 'wait');
    assert.match(d.reasons.at(-1), /No directional edge/);
  });

  it('waits when 1h does not confirm', () => {
    const a = up(); a['1h'].trend = -0.2;
    assert.match(decide(a, Q).reasons.at(-1), /1h trend/);
  });

  it('pullback in value with 1m trigger → market long, SL behind the 5m swing', () => {
    const d = decide(up(), Q);
    assert.equal(d.action, 'trade');
    assert.equal(d.side, 'long');
    assert.equal(d.type, 'market');
    assert.equal(d.entry, 100);
    assert.equal(d.sl, 98); // last 5m swing low 98.5 - 0.5 ATR
    assert.ok(d.score >= 65);
  });

  it('over-extended → limit on the 15m EMA20, never a chase', () => {
    const a = up(); a['15m'] = tf({ extension: 2.1, ema20: 97.5, swing_highs: [112] });
    const d = decide(a, Q);
    assert.equal(d.type, 'limit');
    assert.equal(d.entry, 97.5);
    assert.ok(d.sl < 97.5);
  });

  it('5m compression at the high → buy stop above the range', () => {
    const a = up(); a['5m'] = tf({ compressed: true, close: 101.6, range: { high: 102, low: 100, size_atr: 2 }, extension: 1.2, rel_vol: 1.5 });
    a['15m'] = tf({ extension: 1.0, swing_highs: [112] });
    const d = decide(a, Q);
    assert.equal(d.type, 'stop');
    assert.equal(d.entry, 102.1);
    assert.equal(d.sl, 99.75); // range low 100 - 0.25 ATR
  });

  it('in value without 1m trigger → stop above the trigger bars', () => {
    const a = up(); a['1m'] = tf({ rsi: 40, rsi_prev: 44, last_bar: { high: 100.4, low: 99.8, close: 99.9 }, prev_bar: { high: 100.6, low: 99.9, close: 100.1 } });
    const d = decide(a, Q);
    assert.equal(d.type, 'stop');
    assert.equal(d.entry, 100.7);
  });

  it('15m T3 against + 1h T3 with the trade → pullback limit on the nearest EMA below price', () => {
    const a = up(); a['15m'].t3 = { bull: false, cross: 0 };
    const d = decide(a, Q);
    assert.equal(d.action, 'trade');
    assert.equal(d.type, 'limit');
    assert.equal(d.entry, 98);  // 5m / 15m EMA20 are at the market (100), 15m EMA50 = 98 is the nearest below
    assert.match(d.reasons.join(' | '), /pullback in progress, limit on the 15m EMA50/);
  });

  it('15m T3 against and 1h T3 against → wait', () => {
    const a = up(); a['15m'].t3 = { bull: false, cross: 0 }; a['1h'].t3 = { bull: false, cross: 0 };
    const d = decide(a, Q);
    assert.equal(d.action, 'wait');
    assert.match(d.reasons.at(-1), /15m T3.*1h T3 against/);
  });

  it('t3_pullback_limit off keeps the old 15m T3 wait', () => {
    const a = up(); a['15m'].t3 = { bull: false, cross: 0 };
    assert.match(decide(a, { ...Q, t3_pullback_limit: false }).reasons.at(-1), /15m T3/);
  });

  it('fresh 5m T3 cross against a market entry → pullback limit (1h T3 with the trade)', () => {
    const a = up(); a['5m'].t3 = { bull: false, cross: -1, cross_bars_ago: 0 };
    const d = decide(a, Q);
    assert.equal(d.type, 'limit');
    assert.match(d.reasons.join(' | '), /Fresh 5m T3 cross against/);
  });

  it('a pullback limit needs the 1h T3 with the trade even when the 15m T3 agrees', () => {
    const a = up(); a['15m'] = tf({ extension: 2.1, ema20: 97.5, swing_highs: [112] }); a['1h'].t3 = { bull: false, cross: 0 };
    const d = decide(a, Q);
    assert.equal(d.action, 'wait');
    assert.match(d.reasons.at(-1), /1h T3 .* against a long pullback limit/);
  });

  it('pullbackLimit picks the nearest EMA below a long / above a short', () => {
    const a = up(); a['5m'].ema20 = 99.6; a['15m'].ema20 = 99.2; a['15m'].ema50 = 98;
    assert.deepEqual(pullbackLimit(a, 1, 99.99, 100), { entry: 99.6, basis: '5m EMA20' });
    a['5m'].ema20 = 100.5; a['15m'].ema20 = 100.8; a['15m'].ema50 = 101.4;
    assert.deepEqual(pullbackLimit(a, -1, 99.99, 100), { entry: 100.5, basis: '5m EMA20' });
    assert.equal(pullbackLimit(a, 1, 99.99, 100), null);
  });

  it('a fresh 5m T3 cross in the direction replaces the 1m momentum trigger', () => {
    const a = up(); a['1m'] = tf({ rsi: 40, rsi_prev: 44, last_bar: { high: 100.4, low: 99.8, close: 99.9 }, prev_bar: { high: 100.6, low: 99.9, close: 100.1 } });
    a['5m'].t3 = { bull: true, cross: 1, cross_bars_ago: 0 };
    const d = decide(a, Q);
    assert.equal(d.type, 'market');
    assert.match(d.reasons.join(' | '), /T3 cross/);
    assert.equal(d.score_breakdown.t3, 10);
  });

  it('waits when the stop is too tight for the costs (flat market)', () => {
    const a = up(); for (const k of ['5m', '15m', '1m']) { a[k].atr = 0.01; a[k].swing_lows = [99.99]; }
    const d = decide(a, Q);
    assert.equal(d.action, 'wait');
    assert.match(d.reasons.at(-1), /too tight/);
  });

  it('buy low: a long above the middle of the 1h range waits', () => {
    // 1h range 94 → 99.5, entry 100 = 109 % → premium; next resistance (15m 112) is far, so only the zone blocks it
    const a = up(); a['1h'].swing_highs = [95, 99.5]; a['1h'].swing_lows = [90, 94];
    const d = decide(a, Q);
    assert.equal(d.action, 'wait');
    assert.match(d.reasons.at(-1), /Buy low \/ sell high/);
  });

  it('sell high: a short below the middle of the 1h range waits', () => {
    const flip = (t) => tf({ ...t, trend: -0.8, structure: 'down', ema50: 102, ema200: 105, rsi: 45, rsi_prev: 50,
      swing_highs: [104, 101.5], swing_lows: [90], last_bar: { open: 100.2, high: 100.3, low: 99.7, close: 99.8 }, prev_bar: { open: 100.5, high: 100.6, low: 99.9, close: 100.2 } });
    const a = { '1d': flip({ last_bar: { high: 110, low: 80 } }), '1h': flip(), '15m': flip(), '5m': flip(), '1m': flip() };
    a['1d'].swing_lows = [80]; a['1d'].last_bar = { high: 110, low: 80 }; a['1h'].swing_highs = [106]; a['1h'].swing_lows = [100.5];
    const d = decide(a, Q);
    assert.equal(d.action, 'wait');
    assert.match(d.reasons.at(-1), /premium/);
  });

  it('a stop above the 1m trigger bars is NOT exempt from the zone rule (WLD 26.9.)', () => {
    const a = up(); a['1h'].swing_highs = [95, 99.5]; a['1h'].swing_lows = [90, 94];
    a['1m'] = tf({ rsi: 40, rsi_prev: 44, last_bar: { high: 100.4, low: 99.8, close: 99.9 }, prev_bar: { high: 100.6, low: 99.9, close: 100.1 } });
    const d = decide(a, Q);
    assert.equal(d.action, 'wait');
    assert.match(d.reasons.at(-1), /Buy low \/ sell high/);
  });

  it('a 5m compression breakout stop is exempt from the zone rule', () => {
    const a = up(); a['1h'].swing_highs = [95, 99.5]; a['1h'].swing_lows = [90, 94];
    a['5m'] = tf({ compressed: true, close: 101.6, range: { high: 102, low: 100, size_atr: 2 }, extension: 1.2, rel_vol: 1.5 });
    a['15m'] = tf({ extension: 1.0, swing_highs: [112] });
    const d = decide(a, Q);
    assert.equal(d.action, 'trade');
    assert.equal(d.type, 'stop');
    assert.match(d.reasons.join(' | '), /compression breakout — zone rule exempt/);
  });

  it('TP sits just in front of the next resistance', () => {
    const d = decide(up(), Q);  // entry 100, SL 98, nearest level 112 (15m), buffer 0.1 ATR
    assert.equal(d.tp, 111.9);
    assert.equal(d.rr_target, 5.95);
  });

  it('TP never closer than rr·R', () => {
    const a = up(); a['15m'].swing_highs = [104.05];
    const d = decide(a, Q);
    assert.equal(d.tp, 104);
  });

  it('TP = rr·R when tp_at_level is off', () => {
    assert.equal(decide(up(), { ...Q, tp_at_level: false }).tp, 104);
  });

  it('rangeZone: 0 at the swing low, 1 at the swing high', () => {
    const t = { swing_highs: [110], swing_lows: [100] };
    assert.equal(rangeZone(t, 100).position, 0);
    assert.equal(rangeZone(t, 105).position, 0.5);
    assert.equal(rangeZone({ swing_highs: [], swing_lows: [] }, 1), null);
  });

  it('waits when resistance is closer than rr·R', () => {
    const a = up(); a['1h'].swing_highs = [101];
    const d = decide(a, Q);
    assert.equal(d.action, 'wait');
    assert.match(d.reasons.at(-1), /room/);
  });

  it('ignores levels already broken by the current price (limit below market)', () => {
    // ENA case: limit entry on the pullback, price already above the old high → that high is no obstacle
    const a = up(); a['15m'] = tf({ extension: 1.2, swing_highs: [101.2, 112] }); a['5m'] = tf({ ema20: 99.5, extension: 1.0 });
    const d = decide(a, { ...Q, bid: 101.49, ask: 101.5 });
    assert.equal(d.type, 'limit');
    assert.equal(d.entry, 99.5);
    assert.equal(d.nearest_level, 112);
  });

  it('mirrors for a short', () => {
    const flip = (t) => tf({ ...t, trend: -0.8, structure: 'down', ema50: 102, ema200: 105, rsi: 45, rsi_prev: 50,
      swing_highs: [104, 101.5], swing_lows: [90], last_bar: { open: 100.2, high: 100.3, low: 99.7, close: 99.8 }, prev_bar: { open: 100.5, high: 100.6, low: 99.9, close: 100.2 } });
    const a = { '1d': flip({ last_bar: { high: 110, low: 80 } }), '1h': flip(), '15m': flip(), '5m': flip(), '1m': flip() };
    a['1d'].swing_lows = [80]; a['1d'].last_bar = { high: 110, low: 80 };
    const d = decide(a, Q);
    assert.equal(d.action, 'trade');
    assert.equal(d.side, 'short');
    assert.equal(d.entry, 99.99);
    assert.equal(d.sl, 102); // 5m swing high 101.5 + 0.5 ATR
  });
});
