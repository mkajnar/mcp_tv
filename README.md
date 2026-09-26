# mcp_tv — TradingView MCP with order execution

Fork of [tradingview-mcp-jackson](https://github.com/LewisWJackson/tradingview-mcp-jackson) (itself built on [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp)). Czech guide: [README_CZ.md](README_CZ.md). The upstream documentation follows after the mcp_tv sections.

## Added in mcp_tv: order execution with money management

Orders go to the broker connected in TradingView's Trading Panel (**Paper Trading by default — live accounts are refused** unless you opt in). Each tool does the whole flow in one call: account check → money management → guards → send → verify → audit log.

| Tool | CLI | What it does |
|---|---|---|
| `order_place` | `tv order place sell` | Market/limit/stop order. Only `side` is required: qty is sized from `risk_usdt` (incl. fees + slippage), SL = last confirmed swing ± `sl_atr_mult`×ATR, TP = `rr`×R. Everything can be overridden; `dry_run` computes only. |
| `positions_trail` | `tv order trail [--watch 5]` | Finds **all** open positions and tightens the SL of every one in profit. The original stop is left alone until the trade is +`activate_r`·R (default 1R); then the stop goes at least to break-even incl. fees and an ATR trail (5m ATR from Bybit) follows the price, with min gap and min step. With `trailing.t3_exit` it also **closes** a position (in profit or not) when T3 FAST crosses T3 SLOW against it on the last closed 5m bar. Never loosens a stop, never touches TP. `--watch N` repeats every N seconds. |
| `autoorder` | `tv order auto BYBIT:BTCUSDT.P [--dry-run]` | Give it a ticker: it reads 1D/1h/15m/5m/1m (EMA 20/50/200 trend, HH/HL structure, RSI, ADX, ATR extension, compression, volume, levels), decides top-down whether to trade and which order type — **market** on a pullback with a 1m trigger, **limit** on the 15m EMA20 when price is extended, **stop** on a 5m compression breakout or above the trigger bars — sets a structural SL behind the last 5m swing, requires ≥ rr·R room to the next 1h/15m/daily level and a confluence score ≥ `min_score`, then executes via `order_place`. **Tillson T3 FAST/SLOW** (default 8/21, v 0.7) gates entries: the 15m T3 must agree with the direction, a fresh 5m T3 cross against it means WAIT, and a fresh 5m/1m T3 cross in the direction counts as the entry trigger (up to 10 score points). Default is WAIT. Stops tighter than `min_sl_pct` (0.15 %) or where fees + slippage exceed `max_cost_share` (30 %) of the risk are refused (flat / weekend markets). The chart view is reset (Alt+R) after every symbol/timeframe switch and a symbol switch is retried if TradingView jumps elsewhere. Takes a 5m screenshot after the decision. |
| `order_status` | `tv order status` | Account summary, positions, working orders, active config |
| `position_set_brackets` | `tv order brackets --sl X --tp Y` | Move SL/TP of an open position |
| `position_close` | `tv order close` | Close a position at market |
| `order_cancel` | `tv order cancel [--id N]` | Cancel working orders |

**Config** — `trading.json` in the repo root (overridden by `~/.tradingview-mcp/trading.json`):

```json
{
  "risk_usdt": 100, "max_risk_usdt": 500, "rr": 2,
  "sl_atr_mult": 0.5, "atr_length": 14, "pivot_length": 3,
  "fee_rate": 0.0002, "slippage_rate": 0.0002, "allow_live": false,
  "leverage": { "enabled": true, "min": 10, "max": 50, "vol_mult": 3, "sl_mult": 2, "maintenance_margin": 0.005 },
  "t3": { "fast": 8, "slow": 21, "factor": 0.7 },
  "trailing": { "activate_r": 1, "t3_exit": true, "trail_atr_mult": 1.0, "min_gap_atr": 0.25, "min_step_atr": 0.1, "breakeven": true, "switch_chart": true, "bars_source": "bybit", "atr_timeframe": "5" },
  "auto": { "min_score": 65, "min_bias": 0.35, "bars": 400 }
}
```

**Leverage** — chosen per order from the last hour's range (Bybit 1m klines): the target keeps the isolated liquidation distance ≈ 1/L − maintenance beyond `vol_mult`×1h range and `sl_mult`×stop distance, clamped to 10–50×. The order is refused only if even the minimum leverage would liquidate closer than `sl_mult`×stop. Leverage never changes the risk (qty is sized from the stop), only margin and liquidation price. It is applied via `setLeverage` where the broker supports it; TradingView Paper Trading does not, so the account leverage stays in effect there.

**Safety**
- Non-demo accounts are refused unless `"allow_live": true` or `TV_ALLOW_LIVE_TRADING=1`.
- Risk above `max_risk_usdt` is refused; adding to an existing position requires `allow_add`.
- Every action is appended to `~/.tradingview-mcp/orders/YYYY-MM-DD.jsonl`; the submit intent is logged before sending. Never retry a failed `order_place` without checking `order_status`.
- ATR and swings are computed from the chart's current timeframe. Positions on other symbols are read by briefly switching the chart (disable with `switch_chart: false` / `--no-switch`).

**Windows Store build of TradingView** — `tv_launch` does not find the Store (Appx) install. Use `scripts/launch-tv-cdp.ps1`: it locates the package via `Get-AppxPackage`, kills running instances (single-instance lock) and starts TradingView with `--remote-debugging-port=9222`.

`autoorder` is a rule-based playbook, not a guarantee of profitability — it has not been backtested; validate it with `--dry-run` / Paper Trading first.

Unit tests: `node --test tests/trading.test.js tests/autotrade.test.js`.

---

## Guide: using mcp_tv with an AI assistant (Claude Code)

> 🇨🇿 Czech version: [README_CZ.md](README_CZ.md)

The idea: TradingView Desktop runs on your PC, this MCP server talks to it over the Chrome DevTools Protocol (CDP), and the AI assistant (Claude Code, Claude Desktop or any MCP client) calls the server's tools. You talk to the AI in plain language ("autoorder BTC", "trail my positions", "what orders are open?") and it picks the tools.

### 1. Install

```bash
git clone https://github.com/mkajnar/mcp_tv.git
cd mcp_tv
npm install
```

Requirements: Node.js 18+, TradingView Desktop (a subscription with real-time data is recommended), Trading Panel connected to **Paper Trading** (default, safe).

### 2. Start TradingView with CDP (port 9222)

- **Windows Store (Appx) build:** `powershell -ExecutionPolicy Bypass -File scripts/launch-tv-cdp.ps1`
- **Classic install / macOS / Linux:** ask the AI to call `tv_launch`, or start TradingView with `--remote-debugging-port=9222`.

Check: `http://localhost:9222/json/version` must answer. In TradingView open a chart and connect the Trading Panel to Paper Trading.

### 3. Register the MCP server in your AI client

**Claude Code** — `.mcp.json` in your project (or `claude mcp add`):

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["C:/path/to/mcp_tv/src/server.js"]
    }
  }
}
```

**Claude Desktop** — the same block in `claude_desktop_config.json`.

Restart the client (in Claude Code run `/mcp` → reconnect). Ask: *"run tv_health_check"* — it should report the connected chart.

Optional: pre-approve the trading tools in `.claude/settings.local.json` so the AI does not ask every time:

```json
{ "permissions": { "allow": [
  "mcp__tradingview__order_place", "mcp__tradingview__order_status", "mcp__tradingview__order_cancel",
  "mcp__tradingview__position_close", "mcp__tradingview__position_set_brackets",
  "mcp__tradingview__positions_trail", "mcp__tradingview__autoorder"
] } }
```

### 4. Configure money management

Edit `trading.json` (repo root) or `~/.tradingview-mcp/trading.json` (overrides). Key values:

| Key | Default | Meaning |
|---|---|---|
| `risk_usdt` | 100 | Money lost at SL, incl. fees + slippage — qty is sized from it |
| `max_risk_usdt` | 500 | Hard cap per order |
| `rr` | 2 | TP = rr × SL distance |
| `min_sl_pct` / `max_cost_share` | 0.15 % / 30 % | Refuse noise-tight stops |
| `leverage.min` / `max` | 10 / 50 | Volatility-based leverage range |
| `trailing.activate_r` | 1 | Trail starts at +1R (break-even first) |
| `trailing.t3_exit` | true | Close position on a 5m T3 cross against it |
| `t3` | 8 / 21 / 0.7 | T3 FAST / SLOW / volume factor |
| `auto.min_score` / `min_bias` | 65 / 0.35 | autoorder strictness |
| `allow_live` | false | Live accounts refused unless true |

### 5. Talk to the AI — example prompts

| You say | The AI does |
|---|---|
| "What is on my account?" | `order_status` — balance, positions, pending orders |
| "Short BTC per money management" | `order_place` side=sell — SL from swing + ATR, TP 2R, qty from risk |
| "Buy limit ETH at 2650, SL 2610" | `order_place` side=buy type=limit price=2650 sl=2610 |
| "autoorder BYBIT:SOLUSDT.P" | `autoorder` — 1D/1h/15m/5m/1m analysis, trades only if the playbook qualifies |
| "autoorder on the top 30 Bybit tickers" | loops `autoorder` over the list, summarizes TRADE / WAIT / SKIP |
| "autoorder BTC, just a dry run" | `autoorder` dry_run=true — decision and plan, nothing sent |
| "Trail my positions" | `positions_trail` — tightens SL of all profitable positions |
| "Move the SL on ETH to 2640" | `position_set_brackets` |
| "Close SOL" / "Cancel all orders" | `position_close` / `order_cancel` |
| "Show me a 5m chart of ENA" | `chart_set_symbol` + `chart_set_timeframe` + `capture_screenshot` |

Tips:
- Use full tickers (`BYBIT:BTCUSDT.P`) — short names can resolve to another exchange.
- Tell the AI whether you want screenshots; `autoorder` accepts `screenshot=false`.
- `autoorder` skips a symbol that already has a position or a pending entry — cancel first if you want a new plan.
- While autoorder loops, don't click symbols in TradingView; the chart may jump to a symbol whose order just filled (autoorder retries 3× and then skips).

### 6. Run the trailing stop in the background

The AI only acts when you talk to it. To protect profit continuously, run the trail loop as a separate process:

```bash
node src/cli/index.js order trail --watch 5
```

Windows (hidden, with log):

```powershell
Start-Process node -ArgumentList "src/cli/index.js","order","trail","--watch","5" -WorkingDirectory C:\path\to\mcp_tv -WindowStyle Hidden -RedirectStandardOutput "$HOME\.tradingview-mcp\trail.log" -RedirectStandardError "$HOME\.tradingview-mcp\trail.err.log"
```

It prints one JSON line per position per tick (`skip` / `move` / `t3_exit`). Restart it after changing the code or `trading.json`.

### 7. The same without the AI (CLI)

```bash
node src/cli/index.js order status
node src/cli/index.js order place sell --risk 100 --dry-run
node src/cli/index.js order auto BYBIT:BTCUSDT.P --no-screenshot [--dry-run]
node src/cli/index.js order trail --watch 5
node src/cli/index.js order cancel
```

### 8. How autoorder decides (short)

1. Top-down bias from 1D/1h/15m/5m/1m (weights .30/.30/.20/.15/.05); needs |bias| ≥ `min_bias`, 1h and 15m must agree.
2. T3 gate: 15m T3 FAST/SLOW must agree with the direction; a fresh 5m counter-cross = WAIT.
3. Order type: **market** (pullback into value + 1m or T3 trigger), **limit** (extended → EMA20 pullback), **stop** (5m compression breakout / above trigger bars).
4. Structural SL behind the 5m swing (± 0.5 ATR); refused if too wide (> 3 ATR 15m) or too tight (`min_sl_pct`, `max_cost_share`).
5. Needs ≥ rr·R room to the next 1h/15m/daily level and a confluence score ≥ `min_score`.
6. Sends via `order_place` (money management, leverage 10–50× from 1h volatility, verification, audit log).

### Pine indicator with T3 (optional)

[`pine/milan_macd_rsi_swings.pine`](pine/milan_macd_rsi_swings.pine) — "MKA Multi" (RSI, MACD, swings, T3 FAST/SLOW with T3 L / T3 S / exit signals and alerts, same T3 settings as autoorder). Load it via the AI: *"open the Pine editor, set this source and compile"* (`pine_set_source`, `pine_smart_compile`) or paste it into TradingView's Pine Editor.

### Jev AI decisions (optional, on/off)

[Jev AI](https://thejevai.com) (`POST /v1/systemone`, model `typesafe/jev-1.13`) can take over the **decisions**: which way and which order type to enter, and whether to hold, tighten or close an open position. The rules still compute stops, sizing, leverage and every guard.

- **Setup:** put `JEV_API_KEY=...` in `.env` in the repo root (gitignored; optional `JEV_API_BASE_URL`, `JEV_MODEL`, `JEV_TIMEOUT`, `JEV_MAX_RETRIES`). The key is never logged or returned.
- **On/off:** say *"turn Jev on"* (`jev_toggle enabled=true`), CLI `tv order jev on|off|status`, or `trading.json` → `"jev": { "enabled": true }`. Per call: `autoorder jev=true|false`, CLI `--jev` / `--no-jev`.
- **Entries (autoorder):** the state (per-timeframe indicators, T3, swings, last 20 OHLCV bars of 1D/1h/15m/5m/1m, quote and the rules' opinion) goes to Jev with two questions: `action` (choice: long/short × market/limit/stop, or wait) and `setup_quality` (score 1–5). A trade is placed only if `action` confidence ≥ `jev.entry_threshold` (0.6) and quality ≥ `jev.min_quality` (3). The entry price for the chosen type, the structural SL, the too-wide/too-tight guards and ≥ rr·R room are rule-based; then `order_place` (money management).
- **Exits (trail loop):** when `jev.exits` is on, every open position is asked `exit_action` (hold / tighten / close) at most once per `jev.exit_interval_s` (60 s). `close` needs confidence ≥ `jev.exit_threshold` (0.75); `tighten` moves the SL to at least break-even (never loosens). The ATR trail and T3 exit still run as the safety net.
- **Failures:** retries with backoff on 429/5xx/timeouts, a circuit breaker (3 failures → 10 min pause, immediately on 401/402). With `jev.fallback: "rules"` (default) autoorder then uses the rule playbook; `"wait"` skips the trade.
- Every Jev answer (action, confidence, probabilities, credits) is written to the audit log and returned under `jev` in the result.

### 9. Logs and troubleshooting

- Audit log: `~/.tradingview-mcp/orders/YYYY-MM-DD.jsonl` (decisions, intents, fills, trail moves).
- "CDP not reachable" → TradingView was not started with port 9222.
- New code not used by the AI → `/mcp` reconnect in Claude Code.
- "Chart did not switch" → the symbol does not exist on TradingView or the chart jumped; rerun it.
- Paper Trading ignores leverage changes via API; the computed leverage is reported only.

⚠️ This is a tool, not financial advice. The playbook is not backtested — use Paper Trading and `dry_run` first.

# TradingView MCP Jackson (upstream documentation)

If you found this from the YouTube video — welcome. This is the improved fork. Everything you need is below.

Built on top of the original [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) by [@tradesdontlie](https://github.com/tradesdontlie). Full credit to them for the foundation. This fork adds a morning brief workflow, a rules config, and fixes the launch bug on TradingView Desktop v2.14+.

> [!WARNING]
> **Not affiliated with TradingView Inc. or Anthropic.** This tool connects to your locally running TradingView Desktop app via Chrome DevTools Protocol. Review the [Disclaimer](#disclaimer) before use.

> [!IMPORTANT]
> **Requires a valid TradingView subscription.** This tool does not bypass any TradingView paywall. It reads from and controls the TradingView Desktop app already running on your machine.

> [!NOTE]
> **All data processing happens locally.** Nothing is sent anywhere. No TradingView data leaves your machine.

---

## What's New in This Fork

| Feature | What it does |
|---------|-------------|
| `morning_brief` | One command that scans your watchlist, reads all your indicators, and returns structured data for Claude to generate your session bias |
| `session_save` / `session_get` | Saves your daily brief to `~/.tradingview-mcp/sessions/` so you can compare today vs yesterday |
| `rules.json` | Write your trading rules once — bias criteria, risk rules, watchlist. The morning brief applies them automatically every day |
| Launch bug fix | Fixed `tv_launch` compatibility with TradingView Desktop v2.14+ |
| `tv brief` CLI | Run your morning brief from the terminal in one word |

---

## One-Shot Setup

Paste this into Claude Code and it will handle everything:

```
Set up TradingView MCP Jackson for me. 
Clone https://github.com/LewisWJackson/tradingview-mcp-jackson.git to ~/tradingview-mcp-jackson, run npm install, then add it to my MCP config at ~/.claude/.mcp.json (merge with any existing servers, don't overwrite them). 
The config block is: { "mcpServers": { "tradingview": { "command": "node", "args": ["/Users/YOUR_USERNAME/tradingview-mcp-jackson/src/server.js"] } } } — replace YOUR_USERNAME with my actual username.
Then copy rules.example.json to rules.json and open it so I can fill in my trading rules.
Finally restart and verify with tv_health_check.
```

Or follow the manual steps below.

---

## Prerequisites

- **TradingView Desktop app** (paid subscription required for real-time data)
- **Node.js 18+**
- **Claude Code** (for MCP tools) or any terminal (for CLI)
- **macOS, Windows, or Linux**

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/LewisWJackson/tradingview-mcp-jackson.git ~/tradingview-mcp-jackson
cd ~/tradingview-mcp-jackson
npm install
```

### 2. Set up your rules

```bash
cp rules.example.json rules.json
```

Open `rules.json` and fill in:
- Your **watchlist** (symbols to scan each morning)
- Your **bias criteria** (what makes something bullish/bearish/neutral for you)
- Your **risk rules** (the rules you want Claude to check before every session)

### 3. Launch TradingView with CDP

TradingView must be running with the debug port enabled.

**Mac:**
```bash
./scripts/launch_tv_debug_mac.sh
```

**Windows:**
```bash
scripts\launch_tv_debug.bat
```

**Linux:**
```bash
./scripts/launch_tv_debug_linux.sh
```

Or use the MCP tool after setup: `"Use tv_launch to start TradingView in debug mode"`

### 4. Add to Claude Code

Add to `~/.claude/.mcp.json` (merge with any existing servers):

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/tradingview-mcp-jackson/src/server.js"]
    }
  }
}
```

Replace `YOUR_USERNAME` with your actual username. On Mac: `echo $USER` to check.

### 5. Verify

Restart Claude Code, then ask: *"Use tv_health_check to verify TradingView is connected"*

### 6. Run your first morning brief

Ask Claude: *"Run morning_brief and give me my session bias"*

Or from the terminal:
```bash
npm link  # install tv CLI globally (one time)
tv brief
```

---

## Morning Brief Workflow

This is the feature that turns this from a toolkit into a daily habit.

**Before every session:**

1. TradingView is open (launched with debug port)
2. Run: `tv brief` in your terminal (or ask Claude: *"run morning_brief"*)
3. Claude scans every symbol in your watchlist, reads your indicator values, applies your `rules.json` criteria, and prints:

```
BTCUSD  | BIAS: Bearish  | KEY LEVEL: 94,200  | WATCH: RSI crossing 50 on 4H
ETHUSD  | BIAS: Neutral  | KEY LEVEL: 3,180   | WATCH: Ribbon direction on daily
SOLUSD  | BIAS: Bullish  | KEY LEVEL: 178.50  | WATCH: Hold above 20 EMA

Overall: Cautious session. BTC leading bearish, SOL the exception — watch for divergence.
```

4. Save it: *"save this brief"* (uses `session_save`)
5. Next morning, compare: *"get yesterday's session"* (uses `session_get`)

---

## What This Tool Does

- **Morning brief** — scan watchlist, read indicators, apply your rules, print session bias
- **Pine Script development** — write, inject, compile, debug scripts with AI
- **Chart navigation** — change symbols, timeframes, zoom to dates, add/remove indicators
- **Visual analysis** — read indicator values, price levels, drawn levels from custom indicators
- **Draw on charts** — trend lines, horizontal levels, rectangles, text
- **Manage alerts** — create, list, delete price alerts
- **Replay practice** — step through historical bars, practice entries and exits with P&L tracking
- **Screenshots** — capture chart state
- **Multi-pane layouts** — 2x2, 3x1 grids with different symbols per pane
- **Stream data** — JSONL output from your live chart for monitoring scripts
- **CLI access** — every tool is also a `tv` command, pipe-friendly JSON output

---

## How Claude Knows Which Tool to Use

Claude reads `CLAUDE.md` automatically when working in this project. It contains the full decision tree.

| You say... | Claude uses... |
|------------|---------------|
| "Run my morning brief" | `morning_brief` → apply rules → `session_save` |
| "What was my bias yesterday?" | `session_get` |
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "Give me a full analysis" | `quote_get` → `data_get_study_values` → `data_get_pine_lines` → `data_get_pine_labels` → `capture_screenshot` |
| "Switch to BTCUSD daily" | `chart_set_symbol` → `chart_set_timeframe` |
| "Write a Pine Script for..." | `pine_set_source` → `pine_smart_compile` → `pine_get_errors` |
| "Start replay at March 1st" | `replay_start` → `replay_step` → `replay_trade` |
| "Set up a 4-chart grid" | `pane_set_layout` → `pane_set_symbol` |
| "Draw a level at 94200" | `draw_shape` (horizontal_line) |

---

## Tool Reference (81 MCP tools)

### Morning Brief (new in this fork)

| Tool | What it does |
|------|-------------|
| `morning_brief` | Scan watchlist, read indicators, return structured data for session bias. Reads `rules.json` automatically. |
| `session_save` | Save the generated brief to `~/.tradingview-mcp/sessions/YYYY-MM-DD.json` |
| `session_get` | Retrieve today's brief (or yesterday's if today not saved yet) |

### Chart Reading

| Tool | When to use | Output size |
|------|------------|-------------|
| `chart_get_state` | First call — get symbol, timeframe, all indicator names + IDs | ~500B |
| `data_get_study_values` | Read current RSI, MACD, BB, EMA values from all indicators | ~500B |
| `quote_get` | Get latest price, OHLC, volume | ~200B |
| `data_get_ohlcv` | Get price bars. **Use `summary: true`** for compact stats | 500B (summary) / 8KB (100 bars) |

### Custom Indicator Data (Pine Drawings)

Read `line.new()`, `label.new()`, `table.new()`, `box.new()` output from any visible Pine indicator.

| Tool | When to use |
|------|------------|
| `data_get_pine_lines` | Horizontal price levels (support/resistance, session levels) |
| `data_get_pine_labels` | Text annotations + prices ("PDH 24550", "Bias Long") |
| `data_get_pine_tables` | Data tables (session stats, analytics dashboards) |
| `data_get_pine_boxes` | Price zones as {high, low} pairs |

**Always use `study_filter`** to target a specific indicator: `study_filter: "MyIndicator"`.

### Chart Control

| Tool | What it does |
|------|-------------|
| `chart_set_symbol` | Change ticker (BTCUSD, AAPL, ES1!, NYMEX:CL1!) |
| `chart_set_timeframe` | Change resolution (1, 5, 15, 60, D, W, M) |
| `chart_set_type` | Change style (Candles, HeikinAshi, Line, Area, Renko) |
| `chart_manage_indicator` | Add/remove indicators. **Use full names**: "Relative Strength Index" not "RSI" |
| `chart_scroll_to_date` | Jump to a date (ISO: "2025-01-15") |
| `indicator_set_inputs` / `indicator_toggle_visibility` | Change indicator settings, show/hide |

### Pine Script Development

| Tool | Step |
|------|------|
| `pine_set_source` | 1. Inject code into editor |
| `pine_smart_compile` | 2. Compile with auto-detection + error check |
| `pine_get_errors` | 3. Read compilation errors if any |
| `pine_get_console` | 4. Read log.info() output |
| `pine_save` | 5. Save to TradingView cloud |
| `pine_analyze` | Offline static analysis (no chart needed) |
| `pine_check` | Server-side compile check (no chart needed) |

### Replay Mode

| Tool | Step |
|------|------|
| `replay_start` | Enter replay at a date |
| `replay_step` | Advance one bar |
| `replay_autoplay` | Auto-advance (set speed in ms) |
| `replay_trade` | Buy/sell/close positions |
| `replay_status` | Check position, P&L, date |
| `replay_stop` | Return to realtime |

### Multi-Pane, Alerts, Drawings, UI

| Tool | What it does |
|------|-------------|
| `pane_set_layout` | Change grid: `s`, `2h`, `2v`, `2x2`, `4`, `6`, `8` |
| `pane_set_symbol` | Set symbol on any pane |
| `draw_shape` | Draw horizontal_line, trend_line, rectangle, text |
| `alert_create` / `alert_list` / `alert_delete` | Manage price alerts |
| `batch_run` | Run action across multiple symbols/timeframes |
| `watchlist_get` / `watchlist_add` | Read/modify watchlist |
| `capture_screenshot` | Screenshot (regions: full, chart, strategy_tester) |
| `tv_launch` / `tv_health_check` | Launch TradingView and verify connection |

---

## CLI Commands

```bash
tv brief                           # run morning brief
tv session get                     # get today's saved brief
tv session save --brief "..."      # save a brief

tv status                          # check connection
tv quote                           # current price
tv symbol BTCUSD                   # change symbol
tv ohlcv --summary                 # price summary
tv screenshot -r chart             # capture chart
tv pine compile                    # compile Pine Script
tv pane layout 2x2                 # 4-chart grid
tv stream quote | jq '.close'      # monitor price ticks
```

Full command list: `tv --help`

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | TradingView isn't running with `--remote-debugging-port=9222`. Use the launch script. |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Check `~/.claude/.mcp.json` syntax, restart Claude Code |
| `tv` command not found | Run `npm link` from the project directory |
| `morning_brief` — "No rules.json found" | Run `cp rules.example.json rules.json` and fill it in |
| `morning_brief` — watchlist empty | Add symbols to the `watchlist` array in `rules.json` |
| Tools return stale data | TradingView still loading — wait a few seconds |
| Pine Editor tools fail | Open Pine Editor panel first: `ui_open_panel pine-editor open` |

---

## Architecture

```
Claude Code  ←→  MCP Server (stdio)  ←→  CDP (port 9222)  ←→  TradingView Desktop (Electron)
```

- **78 original tools** + **3 morning brief tools** = 81 MCP tools total
- **Transport**: MCP over stdio + CLI (`tv` command)
- **Connection**: Chrome DevTools Protocol on localhost:9222
- **No external network calls** — everything runs locally
- **Zero extra dependencies** beyond the original

---

## Credits

This fork is built on [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) by [@tradesdontlie](https://github.com/tradesdontlie). The original tool is the foundation — go star their repo.

---

## Disclaimer

This project is provided **for personal, educational, and research purposes only**.

This tool uses the Chrome DevTools Protocol (CDP), a standard debugging interface built into all Chromium-based applications. It does not reverse engineer any proprietary TradingView protocol, connect to TradingView's servers, or bypass any access controls. The debug port must be explicitly enabled by the user via a standard Chromium command-line flag.

By using this software you agree that:

1. You are solely responsible for ensuring your use complies with [TradingView's Terms of Use](https://www.tradingview.com/policies/) and all applicable laws.
2. This tool accesses undocumented internal TradingView APIs that may change at any time.
3. This tool must not be used to redistribute, resell, or commercially exploit TradingView's market data.
4. The authors are not responsible for any account bans, suspensions, or other consequences.

**Use at your own risk.**

## License

MIT — see [LICENSE](LICENSE). Applies to source code only, not to TradingView's software, data, or trademarks.
