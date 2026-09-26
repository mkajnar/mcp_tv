import { register } from '../router.js';
import * as core from '../../core/trading.js';
import * as auto from '../../core/autotrade.js';
import * as autoloop from '../../core/autoloop.js';

const num = (v) => (v === undefined ? undefined : Number(v));

register('order', {
  description: 'Place and manage orders with automatic money management (place, status, close, brackets, cancel)',
  subcommands: new Map([
    ['place', {
      description: 'Place an order and verify it. Usage: tv order place sell [--risk 100] [--sl 84340] [--tp 84000] [--dry-run]',
      options: {
        symbol: { type: 'string', short: 's', description: 'Symbol (default: active chart)' },
        type: { type: 'string', short: 't', description: 'market | limit | stop (default market)' },
        price: { type: 'string', short: 'p', description: 'Limit/stop price' },
        qty: { type: 'string', short: 'q', description: 'Fixed quantity (overrides risk sizing)' },
        risk: { type: 'string', short: 'r', description: 'Risk in account currency (default trading.json)' },
        sl: { type: 'string', description: 'Stop loss price (default auto swing + ATR)' },
        tp: { type: 'string', description: 'Take profit price (default rr * R)' },
        rr: { type: 'string', description: 'Reward:risk for auto TP (0 = none)' },
        'sl-atr-mult': { type: 'string', description: 'ATR buffer for auto SL' },
        'allow-add': { type: 'boolean', description: 'Allow adding to an open position' },
        'dry-run': { type: 'boolean', short: 'n', description: 'Plan only, do not send' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Side required. Usage: tv order place buy|sell [options]');
        return core.placeOrder({
          side: positionals[0], symbol: opts.symbol, type: opts.type, price: num(opts.price), qty: num(opts.qty),
          risk_usdt: num(opts.risk), sl: num(opts.sl), tp: num(opts.tp), rr: num(opts.rr),
          sl_atr_mult: num(opts['sl-atr-mult']), allow_add: !!opts['allow-add'], dry_run: !!opts['dry-run'],
        });
      },
    }],
    ['auto', {
      description: 'Analyse 1D/1h/15m/5m/1m and trade only if the playbook qualifies. Usage: tv order auto BYBIT:BTCUSDT.P [--dry-run]',
      options: {
        risk: { type: 'string', short: 'r', description: 'Risk per trade (default trading.json)' },
        'min-score': { type: 'string', description: 'Minimum confluence score 0-100' },
        'min-bias': { type: 'string', description: 'Minimum weighted top-down bias 0-1' },
        'dry-run': { type: 'boolean', short: 'n', description: 'Analyse and plan only' },
        'no-screenshot': { type: 'boolean', description: 'Skip the 5m screenshot' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv order auto BYBIT:BTCUSDT.P');
        return auto.autoOrder({ symbol: positionals[0], risk_usdt: num(opts.risk), min_score: num(opts['min-score']),
          min_bias: num(opts['min-bias']), dry_run: !!opts['dry-run'], screenshot: !opts['no-screenshot'] });
      },
    }],
    ['status', {
      description: 'Account summary, positions and working orders',
      options: { symbol: { type: 'string', short: 's', description: 'Filter by symbol' } },
      handler: (opts) => core.status({ symbol: opts.symbol }),
    }],
    ['close', {
      description: 'Close the open position at market',
      options: { symbol: { type: 'string', short: 's', description: 'Symbol (default: active chart)' } },
      handler: (opts) => core.closePosition({ symbol: opts.symbol }),
    }],
    ['brackets', {
      description: 'Move SL and/or TP of the open position',
      options: {
        symbol: { type: 'string', short: 's', description: 'Symbol (default: active chart)' },
        sl: { type: 'string', description: 'New stop loss' },
        tp: { type: 'string', description: 'New take profit' },
      },
      handler: (opts) => core.setBrackets({ symbol: opts.symbol, sl: num(opts.sl), tp: num(opts.tp) }),
    }],
    ['trail', {
      description: 'Tighten SL of all open positions in profit. --watch N repeats every N seconds (Ctrl+C to stop)',
      options: {
        symbol: { type: 'string', short: 's', description: 'Only this symbol (default: all)' },
        atr: { type: 'string', description: 'SL distance from price in ATRs' },
        gap: { type: 'string', description: 'Minimum SL distance from price in ATRs' },
        step: { type: 'string', description: 'Minimum improvement in ATRs to move the stop' },
        'no-breakeven': { type: 'boolean', description: 'Do not use the break-even candidate' },
        'no-switch': { type: 'boolean', description: 'Never switch the chart (skip positions on other symbols)' },
        watch: { type: 'string', short: 'w', description: 'Repeat every N seconds' },
        auto: { type: 'boolean', description: 'With --watch: also run autoorder over the Bybit top N, unless the standalone autoorder loop runs' },
        'auto-top': { type: 'string', description: 'Tickers per autoorder pass (default trading.json auto.loop_top, 50)' },
        'auto-every': { type: 'string', description: 'Minutes from the end of one autoorder pass to the next (default auto.loop_every_min, 20)' },
        'dry-run': { type: 'boolean', short: 'n', description: 'Compute only' },
      },
      handler: async (opts) => {
        const params = {
          symbol: opts.symbol, trail_atr_mult: num(opts.atr), min_gap_atr: num(opts.gap), min_step_atr: num(opts.step), dry_run: !!opts['dry-run'],
          breakeven: opts['no-breakeven'] ? false : undefined, switch_chart: opts['no-switch'] ? false : undefined,
        };
        const every = num(opts.watch);
        if (opts.auto && !every) throw new Error('--auto needs --watch');
        if (!every) return core.trailStops(params);
        if (!(every >= 5)) throw new Error('--watch must be at least 5 seconds');
        const log = (row) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...row }));
        // Autoorder passes run alongside the trail ticks (not awaited), each symbol in its own child process
        const pass = { running: false, next: 0, skip: null };
        const maybeAutoPass = () => {
          if (!opts.auto || pass.running || Date.now() < pass.next) return;
          const ac = { ...auto.AUTO_DEFAULTS, ...core.loadConfig().auto };
          const top = num(opts['auto-top']) ?? ac.loop_top, everyMin = num(opts['auto-every']) ?? ac.loop_every_min;
          pass.running = true;
          autoloop.runAutoPass({ top, dry_run: params.dry_run, onEvent: log })
            .then((r) => {
              if (r.skipped) {
                // Look again in a minute; log only when the reason changes
                if (pass.skip !== r.skipped) log({ message: `autoorder pass skipped: ${r.skipped === 'standalone' ? 'the standalone autoorder loop is running' : 'another pass holds the lock'}` });
                pass.skip = r.skipped;
                pass.next = Date.now() + 60000;
              } else {
                pass.skip = null;
                pass.next = Date.now() + everyMin * 60000;
                log({ message: 'next autoorder pass', at: new Date(pass.next).toISOString() });
              }
            })
            .catch((err) => { console.error(JSON.stringify({ ts: new Date().toISOString(), error: `autoorder pass: ${err.message}` })); pass.next = Date.now() + 60000; })
            .finally(() => { pass.running = false; });
        };
        for (;;) {
          maybeAutoPass();
          try {
            const r = await core.trailStops(params);
            for (const row of r.results) {
              console.log(JSON.stringify({ ts: new Date().toISOString(), symbol: row.symbol, action: row.action, price: row.price,
                current_sl: row.current_sl, new_sl: row.new_sl, basis: row.basis, applied: row.applied, locked_profit: row.locked_profit, reason: row.reason, error: row.error }));
            }
            if (!r.results.length) console.log(JSON.stringify({ ts: new Date().toISOString(), message: r.message }));
          } catch (err) {
            console.error(JSON.stringify({ ts: new Date().toISOString(), error: err.message }));
          }
          await new Promise(res => setTimeout(res, every * 1000));
        }
      },
    }],
    ['cancel', {
      description: 'Cancel working orders (by --id, or all non-bracket orders)',
      options: {
        symbol: { type: 'string', short: 's', description: 'Symbol (default: active chart)' },
        id: { type: 'string', description: 'Order id' },
        'include-brackets': { type: 'boolean', description: 'Also cancel SL/TP brackets' },
      },
      handler: (opts) => core.cancelOrders({ symbol: opts.symbol, order_id: opts.id, include_brackets: !!opts['include-brackets'] }),
    }],
  ]),
});
