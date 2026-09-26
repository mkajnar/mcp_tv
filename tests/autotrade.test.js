/**
 * Auto-trader unit tests — indicators and the decision playbook, no TradingView needed.
 *
 * Run: node --test tests/autotrade.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, adx, swings, analyzeTimeframe, decide } from '../src/core/autotrade.js';

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
