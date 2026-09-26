/**
 * Jev AI client unit tests — parsing, binding rules, question catalog and entry mapping. No network.
 *
 * Run: node --test tests/jev.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, evaluate, entryQuestions, exitQuestions, scrub, ENTRY_ACTIONS, probAtLeast, decideEntry, decideExit } from '../src/core/jev.js';
import { entryForType, finishPlan } from '../src/core/autotrade.js';

describe('parseResponse', () => {
  it('reads the enveloped shape', () => {
    const r = parseResponse({ code: 0, message: 'ok', data: { creditsUsed: 1, result: { answers: { a: { type: 'noul', noul: 0.9 } }, elapsedMs: 180 } } });
    assert.equal(r.answers.a.noul, 0.9);
    assert.equal(r.credits, 1);
    assert.equal(r.elapsedMs, 180);
  });
  it('reads the flat shape', () => {
    assert.equal(parseResponse({ answers: { a: { noul: 0.1 } } }).answers.a.noul, 0.1);
  });
  it('rejects code != 0 and missing answers', () => {
    assert.throws(() => parseResponse({ code: 7, message: 'bad' }), /code 7/);
    assert.throws(() => parseResponse({ code: 0, data: { result: {} } }), /answers/);
  });
});

describe('evaluate (agent-orch binding rules)', () => {
  const qs = {
    gate: { type: 'noul', threshold: 0.8, instructions: 'x' },
    pick: { type: 'choice', threshold: 0.6, criteria: { a: 'A', b: 'B' }, instructions: 'x' },
    rate: { type: 'score', threshold: 0.5, criteria: ['Low', 'Mid', 'High'], instructions: 'x' },
  };
  it('noul: yes ≥ t, no ≤ 1 − t, otherwise undecided', () => {
    assert.equal(evaluate({ gate: { noul: 0.85 } }, { gate: qs.gate }).gate.value, 'yes');
    assert.equal(evaluate({ gate: { noul: 0.1 } }, { gate: qs.gate }).gate.value, 'no');
    const u = evaluate({ gate: { noul: 0.5 } }, { gate: qs.gate }).gate;
    assert.equal(u.value, 'undecided');
    assert.equal(u.binding, false);
  });
  it('choice binding only at confidence ≥ threshold and a known option', () => {
    assert.equal(evaluate({ pick: { choice: 'a', confidence: 0.7 } }, { pick: qs.pick }).pick.binding, true);
    assert.equal(evaluate({ pick: { choice: 'a', confidence: 0.5 } }, { pick: qs.pick }).pick.binding, false);
    assert.equal(evaluate({ pick: { choice: 'zzz', confidence: 0.9 } }, { pick: qs.pick }).pick.binding, false);
  });
  it('score is rounded and clamped to the criteria', () => {
    const r = evaluate({ rate: { score: 7.2, confidence: 0.9 } }, { rate: qs.rate }).rate;
    assert.equal(r.value, 2);
    assert.equal(r.label, 'High');
  });
});

describe('score scale (Jev levels are 0-indexed, verified live)', () => {
  const q = { rate: { type: 'score', threshold: 0.5, criteria: ['Poor', 'Weak', 'Average', 'Good', 'Excellent'], instructions: 'x' } };
  const legend = { 0: 'Poor', 1: 'Weak', 2: 'Average', 3: 'Good', 4: 'Excellent' };
  it('score 0 = first criterion, 4 = last, label from the legend', () => {
    assert.equal(evaluate({ rate: { score: 0, legend, confidence: 1 } }, q).rate.label, 'Poor');
    assert.equal(evaluate({ rate: { score: 4, legend, confidence: 1 } }, q).rate.label, 'Excellent');
  });
  it('quality gate uses probability mass, not the rounded mean', () => {
    // ETH case: mean 1.96 → "Average", but only 0.30 + 0.01 mass is Good+ … and 0.68 is Average+
    const r = evaluate({ rate: { score: 1.96, legend, confidence: 0.45, probabilities: { 0: 0.02, 1: 0.3, 2: 0.38, 3: 0.29, 4: 0.01 } } }, q).rate;
    assert.equal(r.value, 2);
    assert.ok(Math.abs(probAtLeast(r, 2) - 0.68) < 1e-9);  // P(≥ Average)
    assert.ok(Math.abs(probAtLeast(r, 3) - 0.30) < 1e-9);  // P(≥ Good)
  });
});

describe('decideEntry (probability + margin over wait)', () => {
  const Q = (probs, qp) => ({ action: { value: 'wait', confidence: 0.3, probabilities: probs },
    setup_quality: { value: 2, label: 'Average', probabilities: qp ?? { 0: 0, 1: 0.2, 2: 0.5, 3: 0.3, 4: 0 } } });
  it('WLD case: long_limit 0.46 vs wait 0.33 -> trade long limit', () => {
    const d = decideEntry(Q({ long_limit: 0.46, wait: 0.33, long_stop: 0.12 }));
    assert.equal(d.action, 'long_limit');
    assert.equal(d.dir, 1);
    assert.equal(d.type, 'limit');
  });
  it('TAO case: long_limit 0.39 < 0.4 -> wait', () => {
    assert.equal(decideEntry(Q({ long_limit: 0.39, wait: 0.34 })).action, 'wait');
  });
  it('lead over wait below the margin -> wait', () => {
    assert.match(decideEntry(Q({ long_limit: 0.45, wait: 0.40 })).why, /leads wait/);
  });
  it('low quality probability -> wait', () => {
    assert.match(decideEntry(Q({ short_stop: 0.6, wait: 0.2 }, { 0: 0.4, 1: 0.3, 2: 0.2, 3: 0.1 })).why, /quality/);
  });
});

describe('decideExit', () => {
  it('close needs p >= 0.5 and a lead over hold', () => {
    assert.equal(decideExit({ probabilities: { close: 0.55, hold: 0.3, tighten: 0.15 } }).action, 'close');
    assert.equal(decideExit({ probabilities: { close: 0.5, hold: 0.45, tighten: 0.05 } }).action, 'hold');
  });
  it('tighten at p >= 0.4 above hold (live samples)', () => {
    assert.equal(decideExit({ probabilities: { tighten: 0.58, hold: 0.41, close: 0.01 } }).action, 'tighten');
    assert.equal(decideExit({ probabilities: { tighten: 0.35, hold: 0.6, close: 0.05 } }).action, 'hold');
  });
});

describe('catalog', () => {
  it('entry action covers long/short × market/limit/stop + wait', () => {
    assert.deepEqual(Object.keys(ENTRY_ACTIONS).sort(), ['long_limit', 'long_market', 'long_stop', 'short_limit', 'short_market', 'short_stop', 'wait']);
    assert.deepEqual(Object.keys(exitQuestions().exit_action.criteria), ['hold', 'tighten', 'close']);
  });
  it('scrub hides the key and bearer tokens', () => {
    assert.equal(scrub('key sk_abc123 used', 'sk_abc123'), 'key *** used');
    assert.equal(scrub('Authorization: Bearer sk_zzz'), 'Authorization: Bearer ***');
  });
});

// Hand-built analysis like tests/autotrade.test.js
function tf(over = {}) {
  return {
    close: 100, ema20: 99.5, ema50: 98, ema200: 95, atr: 1, rsi: 55, rsi_prev: 50, adx: 25, structure: 'up', trend: 0.8, extension: 0.2,
    range: { high: 102, low: 97, size_atr: 5 }, compressed: false, swing_highs: [103, 110], swing_lows: [96, 98.5], rel_vol: 1.1,
    last_bar: { open: 99.8, high: 100.3, low: 99.7, close: 100.2 }, prev_bar: { open: 99.5, high: 100.1, low: 99.4, close: 99.8 }, ...over,
  };
}
const A = () => ({ '1d': tf({ swing_highs: [120], last_bar: { high: 125, low: 90 } }), '1h': tf({ swing_highs: [115] }), '15m': tf({ ema20: 99, swing_highs: [112] }), '5m': tf(), '1m': tf() });
const Q = { bid: 99.99, ask: 100, min_tick: 0.01, rr: 2 };

describe('entryForType (Jev order type → entry)', () => {
  it('market = ask for a long', () => {
    assert.deepEqual(entryForType(A(), { ...Q, dir: 1, type: 'market' }).entry, 100);
  });
  it('limit = 5m EMA20 below the market', () => {
    const e = entryForType(A(), { ...Q, dir: 1, type: 'limit' });
    assert.equal(e.type, 'limit');
    assert.equal(e.entry, 99.5);
  });
  it('limit already reached → market', () => {
    const a = A(); a['5m'].ema20 = 100.5; a['15m'].ema20 = 100.4;
    assert.equal(entryForType(a, { ...Q, dir: 1, type: 'limit' }).type, 'market');
  });
  it('stop above the 1m trigger bars, then the shared plan passes the guards', () => {
    const e = entryForType(A(), { ...Q, dir: 1, type: 'stop' });
    assert.equal(e.type, 'stop');
    assert.equal(e.entry, 100.4);
    const fin = finishPlan(A(), { ...Q, dir: 1, ...e });
    assert.equal(fin.ok, true);
    assert.equal(fin.plan.sl, 98);
  });
});
