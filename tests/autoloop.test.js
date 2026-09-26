/**
 * Autoorder pass (trail loop --auto) unit tests — result rows, no TradingView or network needed.
 *
 * Run: node --test tests/autoloop.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAuto } from '../src/core/autoloop.js';

describe('summarizeAuto', () => {
  it('trade: side, type, plan prices and order result', () => {
    const row = summarizeAuto('BYBIT:RAREUSDT.P', {
      success: true,
      decision: { action: 'trade', side: 'buy', type: 'limit', reasons: ['bias', 'Score 72 ≥ 65'] },
      order: { success: true, plan: { entry: 0.0512, sl: 0.0498, tp: 0.0541 } },
    });
    assert.deepEqual(row, { symbol: 'BYBIT:RAREUSDT.P', action: 'trade', side: 'buy', type: 'limit',
      entry: 0.0512, sl: 0.0498, tp: 0.0541, order_ok: true, reason: 'Score 72 ≥ 65' });
  });

  it('wait: last reason, no order', () => {
    const row = summarizeAuto('BYBIT:BTCUSDT.P', { success: true, decision: { action: 'wait', reasons: ['No directional bias (0.12 < 0.35)'] }, order: null });
    assert.equal(row.action, 'wait');
    assert.equal(row.reason, 'No directional bias (0.12 < 0.35)');
    assert.equal(row.order_ok, null);
    assert.equal(row.entry, null);
  });

  it('skip: open position or pending order has no decision', () => {
    const row = summarizeAuto('BYBIT:WLDUSDT.P', { success: true, action: 'skip', reason: 'A position on BYBIT:WLDUSDT.P is already open' });
    assert.equal(row.action, 'skip');
    assert.match(row.reason, /already open/);
  });

  it('error: CLI failure JSON, timeout, no output', () => {
    assert.deepEqual(summarizeAuto('X', { success: false, error: 'Chart did not switch' }).action, 'error');
    assert.equal(summarizeAuto('X', { success: false, error: 'timed out after 180 s' }).reason, 'timed out after 180 s');
    assert.deepEqual(summarizeAuto('X', null), { symbol: 'X', action: 'error', reason: 'no output' });
  });

  it('failed order after a trade decision keeps the order error', () => {
    const row = summarizeAuto('X', { success: false, decision: { action: 'trade', side: 'sell', type: 'stop', reasons: [] }, order: { success: false, error: 'rejected' } });
    assert.equal(row.order_ok, false);
    assert.equal(row.reason, 'rejected');
  });
});
