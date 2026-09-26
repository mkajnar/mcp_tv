/**
 * Money-management unit tests — no TradingView connection needed.
 * Fixtures are the two real paper trades from 2026-09-26.
 *
 * Run: node --test tests/trading.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planOrder, computeSwingAtr, computeTrailStop, roundToStep, parseSide } from '../src/core/trading.js';

const MM = { fee_rate: 0.0002, slippage_rate: 0.0002, rr: 2, risk_usdt: 100 };

describe('planOrder', () => {
  it('reproduces the ETHUSDT.P short (entry 2689, SL 2693.69)', () => {
    const p = planOrder({ ...MM, side: -1, entry: 2689, sl: 2693.69, min_tick: 0.01, qty_step: 0.0001, qty_min: 0.0001 });
    assert.equal(p.qty, 14.6133);
    assert.equal(p.tp, 2679.62);
    assert.ok(p.planned_risk <= 100 && p.planned_risk > 99.99);
  });

  it('reproduces the BTCUSDT.P short (entry 84239.7, SL 84340.1)', () => {
    const sl = roundToStep(84323.7 + 0.5 * 32.689536722028045, 0.1, 'ceil');
    assert.equal(sl, 84340.1);
    const p = planOrder({ ...MM, side: -1, entry: 84239.7, sl, min_tick: 0.1, qty_step: 0.0001, qty_min: 0.0001 });
    assert.equal(p.qty, 0.5958);
    // exact 2R; the manual trade got 84038.8 because float noise pushed floor() one tick down
    assert.equal(p.tp, 84038.9);
  });

  it('mirrors for a long', () => {
    const p = planOrder({ ...MM, side: 1, entry: 100, sl: 99, min_tick: 0.01, qty_step: 0.001 });
    assert.equal(p.tp, 102);
    assert.equal(p.side, 'long');
    assert.ok(p.planned_risk <= 100);
  });

  it('rejects a stop on the wrong side', () => {
    assert.throws(() => planOrder({ ...MM, side: -1, entry: 100, sl: 99, min_tick: 0.01, qty_step: 0.001 }), /wrong side/);
    assert.throws(() => planOrder({ ...MM, side: 1, entry: 100, sl: 101, min_tick: 0.01, qty_step: 0.001 }), /wrong side/);
  });

  it('honours fixed qty and rr=0 (no TP)', () => {
    const p = planOrder({ ...MM, rr: 0, qty: 0.12345, side: -1, entry: 100, sl: 101, min_tick: 0.01, qty_step: 0.001 });
    assert.equal(p.qty, 0.123);
    assert.equal(p.tp, null);
  });

  it('refuses qty below the minimum', () => {
    assert.throws(() => planOrder({ ...MM, risk_usdt: 0.0001, side: -1, entry: 100, sl: 101, min_tick: 0.01, qty_step: 0.001, qty_min: 0.001 }), /below the minimum/);
  });
});

describe('computeSwingAtr', () => {
  const flat = (n, base = 100) => Array.from({ length: n }, (_, i) => ({ time: i * 60, open: base, high: base + 1, low: base - 1, close: base }));

  it('finds the last confirmed swing high and ignores the forming bar', () => {
    const bars = flat(30);
    bars[20] = { ...bars[20], high: 110 };   // confirmed by bars 21..23
    bars[29] = { ...bars[29], high: 120 };   // forming bar — must be ignored
    const { swing, atr } = computeSwingAtr(bars, { side: -1, atr_length: 14, pivot_length: 3 });
    assert.equal(swing.price, 110);
    assert.equal(swing.time, 20 * 60);
    assert.equal(swing.confirmed_time, 23 * 60);
    assert.ok(atr > 0);
  });

  it('does not accept an unconfirmed swing', () => {
    const bars = flat(30);
    bars[27] = { ...bars[27], low: 80 };     // only 1 closed bar to the right
    bars[15] = { ...bars[15], low: 90 };
    const { swing } = computeSwingAtr(bars, { side: 1, atr_length: 14, pivot_length: 3 });
    assert.equal(swing.price, 90);
  });
});

describe('computeTrailStop', () => {
  const T = { trail_atr_mult: 1, min_gap_atr: 0.25, fee_rate: 0.0002, breakeven: true };

  it('trails a profitable short to price + 1 ATR', () => {
    // BTC short: entry 84239.7, ask 84170.8, ATR 22 → 84192.8; break-even 84206.0 is looser, so ATR wins
    const r = computeTrailStop({ ...T, side: -1, entry: 84239.7, price: 84170.8, current_sl: 84340.1, atr: 22, min_tick: 0.1 });
    assert.equal(r.action, 'move');
    assert.equal(r.new_sl, 84192.8);
    assert.equal(r.basis, 'atr');
    assert.ok(r.locked_per_unit > 0);
  });

  it('prefers break-even when it protects more', () => {
    // long entry 100, bid 100.5, ATR 1 → ATR stop 99.5, BE 100.04 (room 0.46 ≥ gap 0.25) → BE
    const r = computeTrailStop({ ...T, side: 1, entry: 100, price: 100.5, current_sl: 98, atr: 1, min_tick: 0.01 });
    assert.equal(r.action, 'move');
    assert.equal(r.basis, 'breakeven');
    assert.equal(r.new_sl, 100.04);
  });

  it('never loosens an existing stop', () => {
    const r = computeTrailStop({ ...T, side: -1, entry: 84239.7, price: 84170.8, current_sl: 84180, atr: 22, min_tick: 0.1 });
    assert.equal(r.action, 'keep');
  });

  it('skips positions that are not in profit', () => {
    assert.equal(computeTrailStop({ ...T, side: -1, entry: 100, price: 100.1, current_sl: 101, atr: 1, min_tick: 0.01 }).action, 'skip');
    assert.equal(computeTrailStop({ ...T, side: 1, entry: 100, price: 99.9, current_sl: 99, atr: 1, min_tick: 0.01 }).action, 'skip');
  });

  it('ignores improvements smaller than min_step_atr', () => {
    // live case: SL 84181.5, new candidate 84180.9 (0.6 better) < 0.1 * ATR 16.75
    const r = computeTrailStop({ ...T, min_step_atr: 0.1, side: -1, entry: 84239.7, price: 84164.6, current_sl: 84181.5, atr: 16.3, min_tick: 0.1 });
    assert.equal(r.action, 'keep');
  });

  it('keeps the minimum gap to price', () => {
    const r = computeTrailStop({ ...T, trail_atr_mult: 0.1, side: 1, entry: 100, price: 110, current_sl: 90, atr: 2, min_tick: 0.01 });
    assert.equal(r.basis, 'min_gap');
    assert.equal(r.new_sl, 109.5);
  });
});

describe('helpers', () => {
  it('roundToStep handles float noise', () => {
    assert.equal(roundToStep(84340.0, 0.1, 'ceil'), 84340);
    assert.equal(roundToStep(0.59589, 0.0001, 'floor'), 0.5958);
  });
  it('parseSide', () => {
    assert.equal(parseSide('short'), -1);
    assert.equal(parseSide('BUY'), 1);
    assert.throws(() => parseSide('up'));
  });
});
