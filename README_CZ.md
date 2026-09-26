# mcp_tv — TradingView MCP s vlastním zadáváním objednávek (návod CZ)

> 🇬🇧 English version: [README.md](README.md)

Fork projektu [tradingview-mcp-jackson](https://github.com/LewisWJackson/tradingview-mcp-jackson). K původnímu čtení a ovládání grafu přidává zadávání objednávek s money managementem, automatický `autoorder`, trailing stoploss, páku podle volatility a filtr Tillson T3.

## Jak to funguje

TradingView Desktop běží na tvém PC. Tento MCP server s ním mluví přes Chrome DevTools Protocol (CDP, port 9222). AI asistent (Claude Code, Claude Desktop nebo jiný MCP klient) volá nástroje serveru. S AI mluvíš normálně, třeba „autoorder BTC“, „trailuj pozice“ nebo „jaké mám ordery?“, a AI si sama vybere nástroj.

```
Ty ──► AI (Claude) ──MCP──► mcp_tv server ──CDP:9222──► TradingView Desktop ──► Paper Trading / broker
                                   └──► Bybit veřejné API (živé ceny, svíčky, volatilita)
```

## 1. Instalace

```bash
git clone https://github.com/mkajnar/mcp_tv.git
cd mcp_tv
npm install
```

Potřebuješ Node.js 18+ a TradingView Desktop (doporučené je předplatné s real-time daty). Trading Panel má být připojený k **Paper Trading**, což je výchozí a bezpečná volba.

## 2. Spuštění TradingView s CDP

- **Windows Store (Appx) verze:** `powershell -ExecutionPolicy Bypass -File scripts/launch-tv-cdp.ps1`. Skript najde balíček, ukončí běžící instance a spustí TV s `--remote-debugging-port=9222`.
- **Klasická instalace, macOS, Linux:** řekni AI „spusť tv_launch“, nebo TradingView spusť s parametrem `--remote-debugging-port=9222`.

Kontrola: adresa `http://localhost:9222/json/version` musí odpovědět. V TradingView otevři graf a Trading Panel připoj na Paper Trading.

## 3. Registrace MCP serveru v AI

**Claude Code:** do projektu přidej `.mcp.json` (nebo použij `claude mcp add`):

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["C:/cesta/k/mcp_tv/src/server.js"]
    }
  }
}
```

**Claude Desktop:** stejný blok patří do `claude_desktop_config.json`.

Pak restartuj klienta; v Claude Code stačí `/mcp` → reconnect. Ověř to dotazem „spusť tv_health_check“, který musí vrátit připojený graf.

Volitelně můžeš obchodní nástroje předem povolit v `.claude/settings.local.json`, aby se AI pokaždé neptala:

```json
{ "permissions": { "allow": [
  "mcp__tradingview__order_place", "mcp__tradingview__order_status", "mcp__tradingview__order_cancel",
  "mcp__tradingview__position_close", "mcp__tradingview__position_set_brackets",
  "mcp__tradingview__positions_trail", "mcp__tradingview__autoorder"
] } }
```

## 4. Nastavení money managementu

Uprav `trading.json` v kořeni repa. Soubor `~/.tradingview-mcp/trading.json` má přednost.

| Klíč | Výchozí | Význam |
|---|---|---|
| `risk_usdt` | 100 | Ztráta při zásahu SL včetně poplatků a slippage; podle ní se počítá množství |
| `max_risk_usdt` | 500 | Tvrdý strop rizika na objednávku |
| `rr` | 2 | TP = rr × vzdálenost SL |
| `fee_rate` / `slippage_rate` | 0.02 % / 0.02 % | Poplatek a skluz na stranu |
| `min_sl_pct` / `max_cost_share` | 0.15 % / 30 % | Odmítne příliš těsný stop (šum, víkendový trh) |
| `leverage.min` / `max` | 10 / 50 | Rozsah páky podle volatility za poslední hodinu |
| `trailing.activate_r` | 0.75 | Trail začne při +0.75R, nejdřív posune SL na break-even |
| `trailing.guard_pending` / `pending_ttl_min` | true / 60 | Zruší čekající vstup, když cena projde přes jeho SL, nebo když se do 60 min nevyplní |
| `trailing.t3_exit` | true | Zavře pozici při křížení T3 na 5m proti ní |
| `t3` | 8 / 21 / 0.7 | T3 FAST / SLOW / volume factor |
| `auto.min_score` / `min_bias` | 65 / 0.35 | Přísnost autoorderu |
| `allow_live` | false | Živé (ne-demo) účty jsou zablokované |

## 5. Jak mluvit s AI – příklady

| Řekneš | AI udělá |
|---|---|
| „Co mám na účtu?“ | `order_status`: zůstatek, pozice, čekající ordery |
| „Zadej short BTC dle money managementu“ | `order_place` side=sell: SL ze swingu + ATR, TP 2R, množství z rizika |
| „Buy limit ETH na 2650, SL 2610“ | `order_place` side=buy type=limit price=2650 sl=2610 |
| „autoorder BYBIT:SOLUSDT.P“ | `autoorder`: analýza 1D/1h/15m/5m/1m, obchod jen když playbook projde |
| „autoorder na top 30 tickerů z Bybitu“ | Projde seznam a shrne výsledky TRADE / WAIT / SKIP |
| „autoorder BTC, jen nanečisto“ | `autoorder` dry_run=true: rozhodnutí a plán, nic se neodešle |
| „Trailuj pozice“ | `positions_trail`: utáhne SL všech ziskových pozic |
| „Posuň SL na ETH na 2640“ | `position_set_brackets` |
| „Zavři SOL“ / „Zruš všechny ordery“ | `position_close` / `order_cancel` |
| „Vyfoť graf ENA 5m“ | `chart_set_symbol` + `chart_set_timeframe` + `capture_screenshot` |
| „Udělej mi tabulku historie obchodů“ | AI přečte historii brokera a sestaví tabulku |

Tipy:
- Používej celé tickery (`BYBIT:BTCUSDT.P`), krátký název se může přeložit na jinou burzu.
- Řekni AI, jestli chceš screenshoty. `autoorder` umí `screenshot=false`.
- `autoorder` přeskočí symbol, na kterém už je pozice nebo čekající vstup. Když chceš nový plán, nejdřív ho zruš.
- Když autoorder prochází seznam, neklikej v TradingView na symboly. Graf může skočit na symbol, u kterého se právě vyplnila objednávka. Autoorder to zkusí 3× a pak symbol přeskočí.
- Po každém přepnutí symbolu nebo timeframe se provede „Reset chart view“ (Alt+R), aby byly vidět poslední svíčky.

## 6. Trailing stop na pozadí

AI jedná, jen když s ní mluvíš. Pro průběžnou ochranu zisku spusť trail jako samostatný proces:

```bash
node src/cli/index.js order trail --watch 5
```

Na Windows skrytě a s logem:

```powershell
Start-Process node -ArgumentList "src/cli/index.js","order","trail","--watch","5" -WorkingDirectory C:\cesta\k\mcp_tv -WindowStyle Hidden -RedirectStandardOutput "$HOME\.tradingview-mcp\trail.log" -RedirectStandardError "$HOME\.tradingview-mcp\trail.err.log"
```

Každých 5 s vypíše pro každou pozici jeden JSON řádek s akcí `skip`, `move` nebo `t3_exit`. Pravidla trailu:
- Čekající vstupy trail hlídá: když cena projde přes SL objednávky dřív, než se vyplní, nebo když se do `trailing.pending_ttl_min` (60 min) nevyplní, objednávku zruší.
- Původní SL se nechá, dokud pozice nedosáhne +0.75R.
- Pak se SL posune aspoň na break-even (včetně poplatků).
- Dál se SL posouvá o 1× ATR z 5m svíček (Bybit), s minimální mezerou a minimálním krokem.
- SL se nikdy nepovoluje a TP se nemění.
- Při křížení T3 FAST/SLOW na 5m proti pozici se pozice zavře.

Po změně kódu nebo `trading.json` trail restartuj.

**Autoorder z trail smyčky.** S volbou `--auto` spouští stejný proces každých 20 minut i autoorder přes aktuální top 50 z Bybitu (podle 24h obratu):

```bash
node src/cli/index.js order trail --watch 5 --auto [--auto-top 50] [--auto-every 20]
```

- Kolo prochází symboly postupně, každý v samostatném podřízeném procesu `tv order auto <symbol> --no-screenshot`. Trail tak dál běží každých 5 s.
- Další kolo začne `--auto-every` minut po konci předchozího (`auto.loop_top` 50, `auto.loop_every_min` 20 v `trading.json`).
- Kolo se spustí **jen když neběží samostatná PowerShell smyčka** (`scripts/autoorder-loop.ps1`, pozná se podle `~/.tradingview-mcp/autoorder-loop.pid`). Když se samostatná smyčka spustí během kola, kolo skončí před dalším symbolem.
- Běžící kolo drží zámek `~/.tradingview-mcp/autoorder.lock`. Samostatná smyčka na jeho konec počká.
- V logu je `autoorder pass start` / `done` s počty a jeden řádek na symbol (`auto: true`, akce, směr, typ, entry / SL / TP, důvod).

Samostatná smyčka (místo `--auto`): `powershell -ExecutionPolicy Bypass -File scripts/autoorder-loop.ps1 -PauseSeconds 1200`.

## 7. Totéž bez AI (CLI)

```bash
node src/cli/index.js order status
node src/cli/index.js order place sell --risk 100 --dry-run
node src/cli/index.js order auto BYBIT:BTCUSDT.P --no-screenshot [--dry-run]
node src/cli/index.js order brackets --sl 84300 --tp 83500
node src/cli/index.js order close
node src/cli/index.js order cancel [--id N]
node src/cli/index.js order trail --watch 5 [--auto]
```

## 8. Jak autoorder rozhoduje

1. **Směr:** vážený bias z 1D/1h/15m/5m/1m (váhy 0.30/0.30/0.20/0.15/0.05), podle trendu EMA 20/50/200 a struktury HH/HL. Musí platit |bias| ≥ `min_bias` a 1h i 15m musí souhlasit.
2. **T3 filtr podle typu objednávky:**
   - **market a stop:** T3 FAST/SLOW na 15m musí souhlasit se směrem a na 5m nesmí být čerstvé křížení proti směru;
   - **limit na pullback:** stačí, aby se směrem souhlasila T3 na 1h;
   - když je T3 na 15m proti, ale na 1h ve směru (pullback právě probíhá), market nebo stop se změní na limit na nejbližší EMA pod cenou (5m EMA20, 15m EMA20 nebo 15m EMA50; u shortu nad cenou), volba `auto.t3_pullback_limit` (true);
   - když je proti i T3 na 1h, výsledek je WAIT;
   - čerstvé křížení ve směru na 5m nebo 1m slouží jako spouštěč.
3. **Typ objednávky:**
   - **market:** pullback do hodnoty a spouštěč na 1m nebo z T3;
   - **limit:** přetažená cena, vstup na pullback k EMA20;
   - **stop:** průraz 5m komprese nebo nad spouštěcí svíčky.
4. **SL:** za 5m swing ± 0.5 ATR. Odmítne se, když je příliš široký (> 3 ATR na 15m) nebo příliš těsný (`min_sl_pct`, `max_cost_share`).
5. **Buy low, sell high:** long se zadá jen v dolní polovině 1h swing range (od posledního swing low k poslednímu swing high), short jen v horní polovině (`auto.zone_max`, 0.5). Z pravidla je vyjmutý jen průraz 5m komprese (stop); stop nad spouštěcími 1m svíčkami pravidlo dodržuje. TP se dá těsně před nejbližší protilehlou úroveň, ale nikdy blíž než rr·R (`auto.tp_at_level`, true; při vypnutí pevně rr·R).
6. **Místo a skóre:** k nejbližší 1h, 15m nebo denní úrovni musí být aspoň rr·R prostoru a skóre souhlasných signálů musí být ≥ `min_score` (body za směr, režim, T3, polohu, spouštěč, momentum a objem).
7. **Odeslání:** přes `order_place`, tedy money management, páka 10–50× podle 1h volatility, ověření a audit log.

Výchozí odpověď je **WAIT**. Obchoduje se jen při souhlasu všech pravidel.

## 9. Pine indikátor s T3 (volitelné)

Indikátor „MKA Multi“ (RSI, MACD, swingy, T3 FAST/SLOW) kreslí signály T3 L, T3 S, exit L a exit S a má alerty. Soubor je v repu: [`pine/milan_macd_rsi_swings.pine`](pine/milan_macd_rsi_swings.pine). Stejné T3 parametry používá i autoorder. Nahraješ ho přes AI: „otevři Pine editor, vlož skript a zkompiluj“ (`pine_set_source`, `pine_smart_compile`).

## 10. Logy a řešení problémů

- **Audit log:** `~/.tradingview-mcp/orders/YYYY-MM-DD.jsonl` obsahuje rozhodnutí, záměry, vyplnění a posuny SL.
- **„CDP not reachable“:** TradingView neběží s portem 9222.
- **AI nepoužívá nový kód:** v Claude Code spusť `/mcp` → reconnect.
- **„Chart did not switch“:** symbol v TradingView neexistuje nebo graf skočil jinam. Spusť to znovu.
- **Páka:** Paper Trading nastavení páky přes API ignoruje. Vypočtená páka se jen reportuje, riziko se ale počítá ze SL, takže na něj páka vliv nemá.
- **Unit testy:** `node --test tests/trading.test.js tests/autotrade.test.js tests/autoloop.test.js`

## Bezpečnost

- Ne-demo účty se odmítnou, pokud nenastavíš `"allow_live": true` nebo `TV_ALLOW_LIVE_TRADING=1`.
- Riziko nad `max_risk_usdt` se odmítne. Přikoupení do existující pozice vyžaduje `allow_add`.
- Záměr se zapíše do logu ještě před odesláním. Neúspěšný `order_place` nikdy neopakuj naslepo, nejdřív zkontroluj `order_status`.

⚠️ Jde o nástroj, ne o investiční doporučení. Playbook není backtestovaný, takže začni na Paper Tradingu a s `dry_run`.
