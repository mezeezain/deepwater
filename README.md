# Deepwater

Binance futures positioning tools: whales vs crowd, a pump catcher that follows every alert to its outcome, live liquidations, market heatmap, funding rates and a futures calculator.

Plain HTML, CSS and ES modules. No build step, no dependencies, no API keys.

## Run it

```bash
cd deepwater
python3 -m http.server 8000      # or: npx serve .
# open http://localhost:8000
```

It must be served over http(s), because browsers block ES modules opened as `file://`.

Add `?demo` to the URL to use a simulated market. The app also switches to demo data on its own when Binance can't be reached. Binance blocks its futures API in some regions, including the US (HTTP 451). If you deploy for users there, put a small server-side proxy in a supported region and change `REST` / `BASE` in `js/binance.js` and `js/api.js`.

## Screens

| Screen | Route | What it does |
|---|---|---|
| Whales vs crowd | `#whales` | Binance Smart Money whales' long share (by size) against all accounts for the 60 most traded pairs; pairs without Smart Money data use Binance's top 20% of accounts instead (marked T20). Rankings for biggest gap, whales most long/short, biggest 24h shift and **contrarian setups** (whales against a lopsided crowd). Sortable, filterable, watchlist (★), copy as CSV |
| Pair page | `#SOLUSDT` | Indicator chart (5m–1d) with selectable layers, a four-point setup check, biggest whale moves and funding. See "Chart layers" |
| Charts | `#charts` | The pair page for the last pair you opened |
| Liquidation map | `#liqmap-SOLUSDT` | Illustrative liquidation zones on both sides of each open interest increase, cleared when a wick trades through them, with an adjustable leverage cap, the live order book, walls (size vs typical, how long they've rested) and Smart Money whale entries |
| Pump catcher | `#pumps` | Scans every USDT perpetual every 5 seconds, fires alerts and tracks each to a realised exit; shared log across devices, track record after costs, backtest (see below) |
| Live setups | `#ideas` | Setups live right now on BTC, ETH and SOL (or up to 5 pairs you choose) on 15m, 1h and 4h: exact entry, stop, TP1/TP2/TP3, an A/B/C evidence grade (setup record after costs, top 20% vs crowd and its trend, Smart Money whales, next timeframe's trend, funding, costs vs stop), the record of comparable past trades, live price checks (stop hit, don't chase), where the next setups would trigger, and optional sound/desktop alerts. Refreshes at every candle close |
| Setups lab | `#setups` | Sweep reclaim, breakout retest and regime confluence replayed on up to 1,500 candles (15m/1h/4h) with real costs: paper win rate (TP1 touched) beside net win rate, profit factor and expectancy in R after fees, slippage and funding, split by whether Binance's top 20% leaned the trade's way. Latest setups with Smart Money context. See "Setups lab" |
| Signal page | `#sig-<pair>-<time>` | Chart around one alert with alert, peak and dip lines, why it fired, and how it closed |
| Liquidations | `#liquidations` | A live sample of forced liquidations by pair, long vs short (Binance's stream sends at most one per pair per second) |
| Heatmap | `#heatmap` | Pairs sized by volume, coloured by 24h change or funding |
| Funding | `#funding` | Every pair's funding, yearly equivalent, time to next payment |
| Calculator | `#calculator` | Profit after fees, return on margin, break-even and estimated liquidation price; inputs are validated (leverage 1–125, maintenance rate below 1/leverage) |
| Guide | `#guide` | What each screen shows, a glossary (whales, crowd, T20, gap, contrarian, funding…), data sources and limits |

The pair page keeps its interval and layers in the address (`#SOLUSDT?i=4h&l=gap,cvd`), so a view can be shared. Navigation is grouped into Signals, Markets and Risk menus; pair names in tables are real links, there is a skip link, and focus moves to the page content after navigating.

## Chart layers

Price is treated as the result; positioning and order flow are what move it. Toggle any of these on the pair page (choices are remembered):

| Layer | How it's calculated |
|---|---|
| Whales vs crowd | Smart Money whales' long share by size (exact, from the whale data server), Binance's top 20% of accounts by margin balance (by position), and all accounts |
| Whale moves / opens / net position | Exact from Smart Money snapshots (see "Exact whale data"). Without that data they become **Top-20% tilt × OI (est.)**: the top-20% long share applied to total open interest. That mostly redraws open interest, since the top 20% is thousands of accounts and many hedge, so it is labelled as an estimate and named after its formula |
| Whale entry lines | Smart Money whales' average long and short entries. Only shown with exact data; there is no estimated version |
| OI by aggressor (est.) | Every new contract opens a long and a short. This assigns each candle's open interest change to the aggressive (taker) side: OI up + net buying = longs opened, OI up + net selling = shorts opened, OI down + net buying = shorts closed, OI down + net selling = longs closed. It shows who pushed, not who is now positioned |
| CVD | Running sum of taker buy minus taker sell volume |
| Open interest | Open contracts valued in USDT |
| Liquidations (est.) | Open interest drops at least 2× the usual change, on a candle at least 1.5× the usual range, with one-sided taker flow |
| Funding, Volume | Funding rate per 8h; taker buy and sell volume |
| Absorption dots | Taker flow more than 20% one-sided while price moved under 0.15%: someone was absorbing it with limit orders |
| Listing marker | Date the pair was listed on Binance futures, if it falls in the window |

**Setup check** answers four questions from the last 12 candles: is the move driven by new longs or by short covering, are whales opening longs, is the crowd on the wrong side, and is price near the whale entry with liquidations stacked overhead. It also appears on each pump signal's page.

**Liquidation map (illustrative):** each candle's open interest increase adds levels on **both** sides, since every new contract has a long and a short holder, spread across 10×, 25×, 50× and 100× leverage (35/30/20/15%, reweighted when you lower the leverage cap; altcoins default to 50×). These weights and the flat margin are assumptions, not Binance data, and cross-margin positions liquidate elsewhere. Long liquidation price ≈ entry × (1 − 1/leverage + 0.5%), and short ≈ entry × (1 + 1/leverage − 0.5%). Levels are grouped into 0.25% price buckets and removed once a candle trades through them. The order book refreshes every 15 seconds while the page is open.

Everything marked *est.* is an estimate: Binance publishes ratios and totals, not individual positions or entry prices.

**Freshness.** Under the chart, the page says when the newest 5-minute positioning snapshot was taken (later candles repeat it) and how old the Smart Money data is.

## Exact whale data (whale data server)

Binance's public API only publishes the top-trader long/short *ratio*. The Smart Money data behind Binance's futures website is more detailed, and `worker/smartmoney.mjs` fetches it on a server so the app can read it (browsers can't fetch it from another site).

**What Binance sends** (checked against a live response in October 2026), per side (long and short):

| Group | Fields |
|---|---|
| **Whales** | trader count, position size in coins, average entry price, traders in profit |
| **All smart money** (Binance calls them "Traders"; includes the whales) | the same four fields |

It also sends `updateTime`, the time Binance last recalculated the data. In the first live check, that was almost 22 hours old, so expect updates to be infrequent.

What the app shows from that:
- **Value** = size × current mark price.
- **Unrealized PnL** = (price − entry) × size for longs, the reverse for shorts. Binance doesn't send it, but it follows exactly from size and entry.
- **In profit** = traders in profit ÷ traders.
- If fewer than 10 whales hold a pair, the chart uses all smart money instead (marked **S** in the table).

Without a server, the app shows estimates labelled *est.*. With one, the Whales table, pair chart, Smart money panel, entry lines, setup check and liquidation map switch to exact values for every pair the server tracks.

**How moves and opens are worked out.** The server stores one snapshot per pair each time Binance's `updateTime` changes (repeat polls of the same update are dropped). The app compares each snapshot with the previous one:

- Sizes are compared in coins, so a price move never counts as buying.
- **Whale moves** = change in (long size − short size) × price. **Whale opens** count only increases, so closing shorts moves the line but isn't an open.
- **Roster changes** (grey dots): adding at the market price moves the average entry to a predictable value, and closing leaves it unchanged. If the entry jumps somewhere else, a trader joined or left the group, and that change is left out of moves and opens.
- Moves land on the candle where Binance's update happened. Because updates are infrequent, short-interval charts show whale moves only at those candles.
- The crowd stays Binance's all-accounts ratio. "Open interest minus whales" sits near 50% on every pair, because whales hold a small share of open interest.

### Running it

```bash
# 1. Check the response format first (field names are matched by meaning; this shows what was understood)
node worker/smartmoney.mjs --probe BTCUSDT

# 2. Run the server (polls the 120 most traded pairs, one request every 1.2s ≈ one sweep every 2.5 minutes)
ALLOW_ORIGIN=https://<you>.github.io node worker/smartmoney.mjs

# Or set everything up on a fresh Ubuntu VPS (Node, service, firewall, DuckDNS, HTTPS) in one step.
# Download it, read it, then run it (it uses sudo to install packages and open ports):
curl -fsSLo setup.sh https://raw.githubusercontent.com/mezeezain/deepwater/main/deploy/setup.sh
less setup.sh && bash setup.sh

# Try the whole flow without Binance
node worker/smartmoney.mjs --demo
```

Then on the **Whales** page, open **Whale data** and paste the server's address. The page is served over HTTPS, so the server needs HTTPS too: put it behind Caddy, nginx or a Cloudflare tunnel.

API: `GET /api/health` (thin and public; add `?detail=1` on the machine itself for counters and errors), `GET /api/overview` (latest numbers for every pair), `GET /api/positioning` (the four hourly ratio series for the top `POSITIONING_TOP` pairs, cached and refreshed every 10 minutes, so the Whales page makes one request instead of about 240 to Binance; the page falls back to Binance directly if the server lacks it), `GET /api/symbol/BTCUSDT?since=<ms>` (snapshot history). Snapshots are kept for `KEEP_HOURS` (default 720, 30 days) in `worker/data/`. Settings are at the top of the file.

**Server hardening (both servers).** They listen on `127.0.0.1` by default (put Caddy/nginx in front; set `HOST=0.0.0.0` only for direct access), allow cross-origin reads only from `ALLOW_ORIGIN` (comma-separated; default the Deepwater site and `localhost:8000`, `*` to open it up), answer `GET` only, rate-limit each client to `RATE_LIMIT` requests a minute (default 120), and send `nosniff` / `no-referrer` headers. The web app only accepts an `https://` server address (plain `http://` only for localhost).

**Before you rely on it:**
- The endpoint is undocumented. Binance can change or remove it at any time, and using it may not be allowed by Binance's terms. Read them for your use case.
- The server polls slowly and pauses when Binance answers 403, 418 or 429, doubling the pause each time. Keep it that way; don't use proxies to get around the limits.
- Binance blocks some regions, including the US. Run the server from a supported country.
- If `--probe` shows no recognised fields, the response format differs from what the parser expects. Share the probe output so the matching rules in `js/smartmoney.js` can be adjusted.

## Pump catcher

A pair has to pass three gates before it fires:

1. **Lift-off.** Price has just crossed **+27% off its rolling 24h low** (1.27× the low) and is no more than 5% below its 24h high. "Just crossed" is enforced: five minutes earlier the pair must still have been below +27%, so a pump that peaked higher and is sliding back through the band doesn't fire. The band runs to +40%, so a thin coin that jumps from +25% to +35% between two 5-second samples still alerts. The 24h-high condition separates a fresh breakout from a rebound after a bigger peak. Both rules can be relaxed in Settings. This matches PumpGlass's trigger: on its published alerts, alert price ÷ start price is 1.2700–1.2734 every time. A minimum 5-minute move can be set in Settings (off by default).
2. **Order flow.** Volume over the last 5 minutes is at least 2.5× the recent average (average per minute × 5), taker buys are at least 56% of volume, and **real-time** open interest is up at least 1.5% on its level 15 minutes earlier.
3. **Positioning.** Binance's top 20% of accounts are more than 5 points longer than all accounts, or all accounts are under 40% long. This gate can be switched off.

**Exits and results.** Each signal closes at its stop, after giving back 45% of a gain over 8%, or after 72 hours. The stop is a fixed 7% by default, or optionally a volatility-based stop: 3× the pair's typical 5-minute range, kept within 3–12%. The **exit price is stored**, and the track record reports **realised** results after an assumed 0.3% round-trip cost (fees and slippage; funding paid while holding is not included for live signals), each with a 95% range because a few dozen signals say little:
- win rate, average win and average loss;
- **expectancy** per signal;
- how often the stop was hit.

The best price reached ("peak") is still shown, but labelled as the best case. Open signals are counted separately.

**Rules per signal.** Each alert stores the settings it fired with (a rule-set id such as `r2e4f63`), and its exit rules stay fixed after later Settings changes. The track record can show the current rule set on its own, so different settings never blend into one number.

**Whale context (with a whale data server).** Each alert records where Binance Smart Money whales stood at the alert price:
- their long share by size;
- the distance to their average long and short entries;
- whether their shorts are losing money there (squeeze fuel).

This is context, not part of the trigger. An optional filter, off by default, skips alerts where whales lean short. ("Their shorts are losing" is shown but no longer counts as agreement: after a +27% run almost every earlier short is under water, so it passed nearly everything.)

### Shared signal log

When the site can reach your server, the Pump catcher page shows the **shared log**: one record built by `worker/catcher.mjs` scanning around the clock. Every device then sees the same alerts and the same track record, and new alerts still pop up and beep in the browser. Without the server, the page scans in the browser instead, labelled **This browser only**: it scans only while the page is open and keeps its own log. You can switch between the two on the page.

The site's default server is `DEFAULT_WHALE_SERVER` in `js/api.js`. Change it if you fork the project.

### Backtest

`tools/backtest.mjs` replays the exact engine over Binance's recent history:
- the most traded pairs (ranked by volume on the **first day** of the window, not today, so current pumpers aren't favoured; `--pairs all` uses every pair that was trading; coins delisted since are not in Binance's list), 29 days plus a day of warm-up;
- funding paid while each signal was open, charged to it;
- 1-minute candles, and 5-minute open interest and long/short ratios.

It tunes a small grid of settings on the first 19 days, then tests the chosen settings on the last 10 days, which the tuning never saw, after costs:

```bash
node tools/backtest.mjs              # ~20–30 minutes for 40 pairs (paced for Binance's limits)
node tools/backtest.mjs --demo       # synthetic data, checks the tool runs
```

The report goes to `worker/data/backtest.json`. The pump catcher server publishes it at `/api/backtest`, and the Pump catcher page shows it. The setup script runs it every Sunday.

The report is built to resist flattering itself: the first pre-filter uses the lowest trigger values in play (so the default rules are tested as they run live); positioning is read one 5-minute slot late (safe whichever end of the period Binance's timestamp marks) and the open-interest baseline is the snapshot nearest 15 minutes back, as live; signals alerted in the last 72 hours of data are left out rather than counted only if they closed early; stops fill at the stop price minus a slippage allowance rather than at the candle low; the chosen rule set is shown beside the **median and spread of all 54**, a **walk-forward** result (tune before each split, test after), and bootstrap 95% ranges.

A replay still differs from live scanning: it fires at minute closes, has no Smart Money filter (Binance keeps no history), and assumes green candles hit their low before their high. Treat its numbers as an upper bound. Rule of thumb: if the unseen-period result is not positive at 0.3% costs over 50+ closed signals, rethink the trigger rather than tune it. Until the test period shows a positive expectancy after costs, treat this as a positioning dashboard, not a signal service.

### Background worker with Telegram alerts

`worker/catcher.mjs` runs the same engine on a server (Node 22+, no `npm install` needed):

```bash
# Try it on the simulated market
node worker/catcher.mjs --demo

# Live, with Telegram alerts
TELEGRAM_BOT_TOKEN=123456:ABC... TELEGRAM_CHAT_ID=-1001234567890 node worker/catcher.mjs

# Custom thresholds
CATCHER_CONFIG='{"minRise":5,"minRvol":3}' node worker/catcher.mjs

# Whale context in Telegram alerts comes from the whale data server (default http://localhost:8787)
WHALE_SERVER=http://localhost:8787 node worker/catcher.mjs
```

The pump catcher worker also serves the shared log (`/api/catcher`, port 8788) and the backtest (`/api/backtest`). On a server set up with `deploy/setup.sh`, it runs as the `catcher` service, with settings in `/etc/deepwater/catcher.env` (Telegram, `CATCHER_CONFIG`); restart it with `sudo systemctl restart catcher`. Posting alerts to a public Telegram channel can make them look like a signal service, so check the rules where you and your subscribers live first.

To get a bot token, message @BotFather on Telegram. To get the chat ID, add the bot to your channel and send a message, then open `https://api.telegram.org/bot<token>/getUpdates`. Signals are saved to `worker/signals.json`. Run it with `pm2`, `systemd` or a Docker container on a VPS in a region Binance serves.

### Tests

```bash
node --test
```

These cover:
- the gates, including the bounce filter, and the order-flow maths, including the volume baseline;
- peak and dip accounting, the close rules and stops, exits and realised results;
- rule sets stored per signal, and stats that count only closed signals;
- catch-up from candles, and cooldown;
- the indicators, the Smart Money parsing and snapshot diffs, the whale context and filter;
- the backtest replay.

## Setups lab

`js/setups.js` (pure functions) finds three common setups on closed candles and plays each forward like a real account:

| Setup | Trigger | Stop | Targets |
|---|---|---|---|
| Sweep reclaim | Wick beyond the previous 19-bar low/high, close back inside, taker share ≥ 53% the trade's way, volume ≥ 1.2× the 20-bar average | 0.5 × ATR(14) beyond the wick | TP1 0.75R, target 1.5R |
| Breakout retest | Close beyond the 19-bar range and outside Keltner (EMA 20 ± 2 × ATR 10), volume ≥ 1.5× | 1.5 × ATR(14) beyond the level | TP1 1R, target 2R |
| Regime confluence | SuperTrend (10, 3) flips, Kalman slope, MFI(14) and taker share agree | SuperTrend line (assumed) | TP1 1R, target 2R |

Execution: market entries at the next open (0.05% taker), retest limit orders filled only when traded 0.02% through (0.02% maker), half off at TP1 and stop to entry, stops and 48-bar time exits at 0.05% + 0.03% slippage, funding actually charged while open, stop first when a candle touches both. **Paper win** counts TP1 touched before the stop with no costs, the way signal dashboards usually badge a "target hit"; **net win** counts trades that made money after costs.

Each trade is tagged with the top 20% vs crowd gap at the signal candle's close (*with* ≥ +5 points the trade's way, *against* ≤ −5). Binance keeps that history for 30 days only, so the split uses the last 30 days. The page states when a sample is too small (under 30 trades) and shows a 95% range for expectancy.

For a bigger sample, run on the server:

```
node tools/setups.mjs                 # top 40 pairs, 1h
node tools/setups.mjs --pairs 80 --tf 4h
```

## Limits

- **Two different "whale" groups.** *Smart Money whales* (whale data server) are Binance's large, consistently profitable accounts, with exact positions. The public `topLongShortPositionRatio` is Binance's **top 20% of accounts by margin balance**, thousands of accounts on major pairs and many of them hedging. The app labels the second group "Top 20%" (and T20 in the table).
- **Smart Money data updates infrequently** (about daily when checked), and exact history starts when your server starts.
- **Positioning history** (open interest, long/short ratios) only goes back 30 days, comes in 5-minute snapshots, and isn't available at the weekly interval.
- **Liquidations** on the live screen are a sample: Binance's stream sends at most one per pair per second. The liquidation map is illustrative.
- **Order book history** isn't available from Binance, so walls are tracked only while the map is open.
- **Signal prices are futures prices.** Real fills come later, with fees and slippage. Spot markets can differ, and some perpetuals have no spot market; the signal page says which.
- **Peak and dip** are measured from live prices about once a second. Brief wicks between updates can be missed. Catch-up after a gap uses 1-minute candles and assumes green candles hit their low before their high.
- **Demo mode** appears only when the address has `?demo`, or when Binance can't be reached. In that case a full-width banner, a DEMO badge, the tab title and a chart watermark say so, and the app keeps retrying and switches back to live data by itself.
- **Not included:** listings on other exchanges (no free data source) and chart drawing tools.

## Code layout

```
index.html              shell: top bar, status strip, <main>
css/app.css             theme tokens (light + dark) and all component styles
js/engine.js            pump catcher rules: pure functions, shared by browser and worker
js/backtest.js          replays the engine over historical data, tune/test split (pure functions)
js/smartmoney.js        Smart Money parsing, cohort choice, snapshot diffs (moves, opens, roster changes)
js/smartmoney-demo.js   simulated Smart Money snapshots for demo mode
js/indicators.js        chart layers, liquidation levels, order book walls, setup check (pure functions)
js/multichart.js        stacked canvas chart: candles plus indicator panes, shared crosshair
js/catcher.js           scanner loop: ticker stream, screening, confirmation, tracking
js/binance.js           Binance source for the catcher (fetch + WebSocket only)
js/demo-market.js       simulated market with the same interface
js/catcher-app.js       browser scanner or shared server log, alerts (toast, sound, desktop notification)
js/api.js               Binance client for the other screens: request queue, cache, live/demo switch
js/demo.js              sample data for the other screens
js/util.js              h() DOM helper, fill(), formatters, watchlist, CSV
js/route.js             pure hash parsing/building and pair-name normalising (unit-tested)
js/validate.js          server-URL and number validation (unit-tested)
js/views/guide.js       the in-app guide and glossary
worker/http-util.mjs    CORS allow-list, rate limit and headers shared by both servers
assets/, manifest.webmanifest, robots.txt, sitemap.xml, 404.html   icons, social image, install manifest, crawler files
js/chart.js             canvas candle chart with share overlays and level lines; SVG sparkline
js/app.js               router (pages load on demand), grouped navigation, focus handling
js/views/*.js           one file per screen; each returns a cleanup function
worker/catcher.mjs      Node worker: round-the-clock scanning, shared signal log API, Telegram alerts
tools/backtest.mjs      downloads Binance history and runs the backtest
js/setups.js            setups lab: indicators, setups, realistic execution, whale split (pure functions)
tools/setups.mjs        setups lab over many pairs, from a server
js/ideas.js             live setups: active plans, evidence grade, comparable history, trigger levels (pure functions)
deploy/setup.sh         one-step VPS setup: both servers, firewall, DuckDNS, HTTPS, weekly backtest
worker/smartmoney.mjs   whale data server: polls Smart Money data, stores snapshots, serves the app
test/*.test.mjs         engine, indicator, router, validation and server-helper tests (`npm test` or `node --test`)
.github/workflows/ci.yml   runs the tests and syntax checks on every push
```

## Moving it into your own app

- **React / Next.js / Vue:** keep `engine.js`, `catcher.js`, `binance.js`, `api.js` and `chart.js` as they are. Rewrite each `views/*.js` as a component that subscribes in an effect and returns its cleanup.
- **Shared alerts for all visitors:** run the worker on a server and expose `signals.json` (or a database) over an API, then have the page read from it instead of scanning in each browser.

## Binance endpoints used

| Data | Endpoint |
|---|---|
| Pairs | `GET /fapi/v1/exchangeInfo` |
| Price, 24h stats, 24h low | `GET /fapi/v1/ticker/24hr`, stream `!ticker@arr` |
| Funding | `GET /fapi/v1/premiumIndex`, `GET /fapi/v1/fundingRate` |
| Candles, volume, taker buy volume | `GET /fapi/v1/klines` |
| Whales (top traders, by position) | `GET /futures/data/topLongShortPositionRatio` |
| Top accounts | `GET /futures/data/topLongShortAccountRatio` |
| Crowd (all accounts) | `GET /futures/data/globalLongShortAccountRatio` |
| Open interest | `GET /futures/data/openInterestHist` |
| Order book | `GET /fapi/v1/depth` |
| Listing date | `onboardDate` in `GET /fapi/v1/exchangeInfo` |
| Liquidations (live) | stream `!forceOrder@arr` |

Not financial advice.

## Security and privacy

- `index.html` carries a Content-Security-Policy: scripts and styles only from this site (plus Google Fonts for typefaces), no inline script, connections only over `https:`/`wss:` (plus `localhost` for local servers).
- Everything is read-only public market data; there are no accounts, API keys or cookies. Settings (watchlist, interface choices, server address) stay in your browser's local storage.
- The page is not affiliated with Binance. Nothing here is financial advice.

## Licence

MIT, see `LICENSE`.
