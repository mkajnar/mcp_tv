import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/trading.js';
import * as auto from '../core/autotrade.js';

export function registerTradingTools(server) {
  server.tool('order_place',
    'Place an order on the broker connected to the TradingView Trading Panel and verify it — in ONE call. ' +
    'Only side is required: symbol defaults to the active chart, qty is sized from risk_usdt, SL defaults to the last confirmed swing ± sl_atr_mult*ATR, TP to rr*R. ' +
    'Defaults come from trading.json. Non-demo (live) accounts are refused unless allow_live is enabled. Never retry a failed call without checking order_status first.', {
    side: z.enum(['buy', 'sell', 'long', 'short']).describe('Direction'),
    symbol: z.string().optional().describe('Symbol, e.g. BYBIT:BTCUSDT.P (default: active chart symbol)'),
    type: z.enum(['market', 'limit', 'stop']).optional().describe('Order type (default market)'),
    price: z.coerce.number().optional().describe('Limit/stop price (required for limit and stop)'),
    qty: z.coerce.number().optional().describe('Fixed quantity — overrides risk-based sizing'),
    risk_usdt: z.coerce.number().optional().describe('Money at risk incl. fees+slippage (default from trading.json)'),
    sl: z.coerce.number().optional().describe('Stop loss price (default: auto swing + ATR from the active chart)'),
    tp: z.coerce.number().optional().describe('Take profit price (default: rr * SL distance)'),
    rr: z.coerce.number().optional().describe('Reward:risk for auto TP (0 = no TP)'),
    sl_atr_mult: z.coerce.number().optional().describe('ATR buffer beyond the swing for auto SL'),
    atr_length: z.coerce.number().optional().describe('ATR length for auto SL'),
    pivot_length: z.coerce.number().optional().describe('Swing pivot length (bars left/right) for auto SL'),
    allow_add: z.boolean().optional().describe('Allow adding to an existing position on the symbol'),
    dry_run: z.boolean().optional().describe('Compute and validate everything but do not send'),
  }, async (params) => {
    try { return jsonResult(await core.placeOrder(params)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('autoorder',
    'Give it a ticker and it does the rest: loads the chart, reads 1D/1h/15m/5m/1m (trend, structure, momentum, extension, compression, levels), ' +
    'decides like a disciplined top-down trader whether to trade at all and which order type (market / limit on pullback / stop on breakout), ' +
    'places a structural SL and sizes the order by money management via order_place. Default is WAIT unless confluence score >= min_score. ' +
    'Returns the decision with reasons and a per-timeframe summary. With Jev AI on (jev_toggle / trading.json jev.enabled or jev=true) ' +
    'Jev decides direction and order type from the OHLCV + indicator state; SL, guards and sizing stay rule-based.', {
    symbol: z.string().describe('Ticker, preferably with exchange, e.g. BYBIT:BTCUSDT.P'),
    dry_run: z.boolean().optional().describe('Analyse and plan, but do not send the order'),
    risk_usdt: z.coerce.number().optional().describe('Override risk per trade (default trading.json)'),
    min_score: z.coerce.number().optional().describe('Minimum confluence score 0-100 to trade (default trading.json auto.min_score)'),
    min_bias: z.coerce.number().optional().describe('Minimum weighted top-down bias 0-1 (default trading.json auto.min_bias)'),
    screenshot: z.boolean().optional().describe('Capture a 5m screenshot after the decision (default true); path returned in screenshot'),
    jev: z.boolean().optional().describe('Force Jev AI on (true) or off (false) for this call; default trading.json jev.enabled'),
  }, async (params) => {
    try { return jsonResult(await auto.autoOrder(params)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('order_status', 'Trading account summary, open positions and working orders (optionally for one symbol), plus the active money-management config', {
    symbol: z.string().optional().describe('Filter by symbol (full or without exchange prefix)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.status({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('position_close', 'Close the open position on a symbol at market and verify it is flat', {
    symbol: z.string().optional().describe('Symbol (default: active chart symbol)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.closePosition({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('position_set_brackets', 'Move the stop loss and/or take profit of the open position on a symbol and verify it', {
    symbol: z.string().optional().describe('Symbol (default: active chart symbol)'),
    sl: z.coerce.number().optional().describe('New stop loss price'),
    tp: z.coerce.number().optional().describe('New take profit price'),
  }, async ({ symbol, sl, tp }) => {
    try { return jsonResult(await core.setBrackets({ symbol, sl, tp })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('positions_trail',
    'Find ALL open positions and immediately tighten the stop loss of every position that is in profit (ATR trail from current price + break-even lock incl. fees). ' +
    'Never loosens a stop, never touches TP. With trailing.t3_exit it also closes a position when T3 FAST crosses T3 SLOW against it on the last closed bar. ' +
    'Bybit perpetuals use Bybit klines/quotes; other symbols are read by briefly switching the chart (restored afterwards).', {
    symbol: z.string().optional().describe('Only this symbol (default: all open positions)'),
    trail_atr_mult: z.coerce.number().optional().describe('SL distance from price in ATRs (default trading.json trailing.trail_atr_mult)'),
    min_gap_atr: z.coerce.number().optional().describe('Minimum SL distance from price in ATRs'),
    min_step_atr: z.coerce.number().optional().describe('Move only if the stop improves by at least this many ATRs'),
    breakeven: z.boolean().optional().describe('Consider break-even (entry ± fees) as a candidate'),
    switch_chart: z.boolean().optional().describe('Allow switching the chart to read bars for other symbols'),
    dry_run: z.boolean().optional().describe('Compute only, do not move stops'),
    jev: z.boolean().optional().describe('false = skip Jev exit decisions for this call (they run only when jev.enabled and jev.exits)'),
  }, async (params) => {
    try { return jsonResult(await core.trailStops(params)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jev_toggle',
    'Switch Jev AI decisions on or off (entries in autoorder, exits in positions_trail / the trail loop). Persists to ~/.tradingview-mcp/trading.json; the running trail loop picks it up on its next tick.', {
    enabled: z.boolean().describe('true = Jev decides entries/exits, false = rule-based playbook only'),
    exits: z.boolean().optional().describe('Also let Jev decide exits (hold / tighten / close) — default unchanged'),
  }, async ({ enabled, exits }) => {
    try { return jsonResult(core.setJev({ enabled, exits })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('jev_status', 'Jev AI status: enabled, exits, API key present (never the value), model, circuit breaker', {}, async () => {
    try { return jsonResult({ success: true, ...core.jevInfo() }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('order_cancel', 'Cancel working orders on a symbol (one by id, or all non-bracket orders)', {
    symbol: z.string().optional().describe('Symbol (default: active chart symbol)'),
    order_id: z.string().optional().describe('Cancel only this order id'),
    include_brackets: z.boolean().optional().describe('Also cancel SL/TP bracket orders of the position'),
  }, async ({ symbol, order_id, include_brackets }) => {
    try { return jsonResult(await core.cancelOrders({ symbol, order_id, include_brackets })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
