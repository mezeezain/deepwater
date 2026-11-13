# Deepwater

Binance futures positioning tools: whales vs crowd, a Pump Catcher that flags every pair rising 27% off its 24-hour low and follows the move, live liquidations, market heatmap, funding rates and a futures calculator.

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
| Pump catcher | `#pumps` | Every USDT perpetual on the live ticker stream; fires when price rises 27% off its rolling 24h low. **Active now** (start price, alert price, price now, gain %, peak % or off peak, time to peak, dip before peak, volume 24h, OI, duration) and a 30-day **Alert log**; All/24H/7D/30D windows, an At peak filter, sort by gain or volume, 15 rows at a time. Shared log across devices (see below) |
| Live setups | `#ideas` | Setups live right now on BTC, ETH and SOL (or up to 5 pairs you choose) on 15m, 1h and 4h: exact entry, stop, TP1/TP2/TP3, an A/B/C evidence grade (setup record after costs, top 20% vs crowd and its trend, Smart Money whales, next timeframe's trend, funding, costs vs stop), the record of comparable past trades, live price checks (stop hit, don't chase), where the next setups would trigger, and optional sound/desktop alerts. Refreshes at every candle close |
| Setups lab | `#setups` | Sweep reclaim, breakout retest and regime confluence replayed on up to 1,500 candles (15m/1h/4h) with real costs: paper win rate (TP1 touched) beside net win rate, profit factor and expectancy in R after fees, slippage and funding, split by whether Binance's top 20% leaned the trade's way. Latest setups with Smart Money context. See "Setups lab" |
| Signal page | `#sig-<pair>-<time>` | One alert: 15M/1H/4H/1D chart with ALERT and PEAK markers, alert/peak/time-to-peak/dip numbers, whale positioning at the alert, the pair's full signal history, links to its chart and liquidation map |
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

Modelled on how PumpGlass's Pump Catcher works: a rebound detector on the 24-hour low, not a launch or breakout detector (pump.fun-style holder and rug checks don't apply to exchange perpetuals). The rules live in `js/pump.js` and are shared by the browser and the server:

1. **Watch every pair.** All Binance USDT-margined perpetuals that are trading, from the all-market ticker stream (about once a second).
2. **Track the rolling 24h low.** Binance's 24h ticker low is the baseline, recorded as the **start price**.
3. **Fire on the rebound.** When price reaches **1.27× the 24h low** (+27%), an alert fires. The first price seen at or past the line is the **alert price**, so alert ÷ start is 1.27 or a little above (PumpGlass's published rows sit at 1.2700–1.2775). The scanner must have seen the pair below the line first: a pair that was already above it when scanning started has pumped before we looked and waits for its next crossing.
4. **First breakout only.** Crossing the line only triggers a check. On 1-hour candles over the previous 40 days (leaving out the last 24 hours, which is the move itself), the pair must have: **no earlier pump** (never +27% within any 24 hours), price **above that period's highest high** (a new 40-day high, not a bounce back into an old range), a **flat base** (high at most 60% above low), **24h volume at least 2× a normal day**, and **at least 14 days of history** (fresh listings are skipped). Pairs that fail are listed under *Filtered out* with the reasons, and get no alert. The rules are `BREAKOUT` in `js/pump.js`. Volume and range rules follow common breakout practice (volume confirmation of roughly 1.5–2× average, a breakout from a defined range).
5. **Follow the move.** Gain now (price vs alert, can be negative), the peak since the alert, time to peak, the **dip before peak** (lowest price between the alert and the peak), 24h volume and open interest in USD (refreshed every 5 minutes for tracked pairs).
6. **Re-arm.** A pair can only be checked again 24 hours after its last alert, or sooner if its 24h low drops below the last signal's start price. In practice the first-breakout rules then reject it until the earlier pump has left the 40-day window. A new signal on a pair closes the pair's earlier one.
7. **Close.** PumpGlass doesn't publish its closing rule, so Deepwater uses a simple one: a signal stays **active** until price falls back to the 24h low it started from (the whole move given back), a new signal fires on the pair, or 30 days pass. The log keeps 30 days.

There is no trading exit: the percentages measure price after detection, not trading results, and some pumps reverse straight after the alert. There is also no paid delay: alerts reach every viewer the moment they fire.

**Whale context.** With a whale data server, each alert records where Binance Smart Money whales stood at the alert price (long share by size, distance to their average entries, whether their shorts are losing). It is shown on the signal page and in Telegram alerts, and plays no part in firing.

### Shared signal log

When the site can reach your server, the Pump catcher page shows the **shared log**: one record built by `worker/catcher.mjs` scanning around the clock. Every device then sees the same alerts, and new alerts still pop up and beep in the browser. Without the server (or with a server still running the old scanner), the page scans in the browser instead, labelled **This browser only**: it scans only while the page is open and keeps its own log. You can switch between the two on the page.

The site's default server is `DEFAULT_WHALE_SERVER` in `js/api.js`. Change it if you fork the project.

### Server with Telegram alerts

`worker/catcher.mjs` runs the same rules on a server (Node 22+, no `npm install` needed):

```bash
# Try it on the simulated market
node worker/catcher.mjs --demo

# Live, with Telegram alerts
TELEGRAM_BOT_TOKEN=123456:ABC... TELEGRAM_CHAT_ID=-1001234567890 node worker/catcher.mjs

# Whale context in alerts comes from the whale data server (default http://localhost:8787)
WHALE_SERVER=http://localhost:8787 node worker/catcher.mjs
```

It serves the shared log at `/api/catcher` (port 8788; `version: 2` in the response). On a server set up with `deploy/setup.sh`, it runs as the `catcher` service, with settings in `/etc/deepwater/catcher.env` (Telegram); restart it with `sudo systemctl restart catcher`. Each Telegram alert links to its signal page (`SITE_URL`, default the GitHub Pages site). Posting alerts to a public Telegram channel can make them look like a signal service, so check the rules where you and your subscribers live first.

**Live setups on Telegram.** With Telegram configured, the same server also watches the Live setups page's pairs and posts each **new grade A or B setup** (sweep reclaim, breakout retest, regime confluence) with entry, stop, TP1–TP3, the checklist and the record of comparable past trades. It reloads each timeframe a few seconds after its candle closes, uses the same code as the page (`js/setup-feed.js`), and remembers what it sent in `worker/setups-sent.json`, so nothing is sent twice, even after a restart. On its very first start it notes the setups already live without sending them. Settings in `/etc/deepwater/catcher.env`: `SETUP_PAIRS=BTC,ETH,SOL` (up to 5), `SETUP_FRAMES=15m,1h,4h`, `SETUP_GRADES=A,B` (`A,B,C` for all), `SETUP_ALERTS=off` to stop them.

To get a bot token, message @BotFather on Telegram. To get the chat ID, add the bot to your channel and send a message, then open `https://api.telegram.org/bot<token>/getUpdates`. Signals are saved to `worker/pumps.json`. Run it with `pm2`, `systemd` or a Docker container on a VPS in a region Binance serves.

### Tests

```bash
node --test
```

These cover:
- the Pump Catcher trigger (27% off the 24h low, watched crossings, re-arming), peak / time-to-peak / dip-before-peak accounting, closing, catch-up from candles, the Active and Alert log views, and the scanner loop;
- the indicators, the Smart Money parsing and snapshot diffs, and the whale context;
- the setups lab, live setups, router, validation and server helpers.

## Trend radar

`#trends` (Markets → Trend radar) lists coins whose trend **started recently**, on 1h or 4h candles, with the nearest **support and resistance**. Rules in `js/trend.js`:

1. **Direction:** EMA 20 above EMA 50 and the close above EMA 50 (mirror for downtrends).
2. **Structure:** a close beyond the highest high (lowest low) of the 20 candles before it, no earlier than 5 candles before the EMA cross: a breakout from the old range, not a wobble inside it.
3. **Recent:** the trend started at most 12 candles ago (start = the later of the EMA cross and the breakout).
4. **Strength:** ADX(14) rising over 3 candles with +DI above −DI. No ADX floor by default, because ADX lags: by the time it passes 20 a trend is rarely fresh.

Levels are swing highs and lows (3 candles either side) from the last 200 candles, merged into zones when closer than 0.6 ATR. Each row says whether price has room to run, has pulled back to a level, or is pressing into one (within 1 ATR), and flags trends stretched more than 2.5 ATR past EMA 20.

The server (`worker/catcher.mjs`) rescans every coin trading over $5M a day (`TREND_MIN_VOLUME`) after each 1h and 4h close and serves `/api/catcher/trends`; without the server the page scans the top 60 coins in the browser.

**Testing it:** `node tools/trends.mjs` (4h) and `node tools/trends.mjs --tf 1h` replay the radar over the top 60 coins (about 3,000 candles each) and measure what price did next in the trend's direction after costs: +6/+12/+24 candles and a 2:1 race (+2 ATR before −1 ATR). They compare it with trading any candle in the EMA direction and with late trends, split it by location, ADX and age, and check each coin's older 70% against its newest 30%. The result is saved on the server and shown on the page under "Has it been tested?".

## Fib pullbacks

`#fib` (Markets → Fib pullbacks) lists coins in the **first correction after a pump**, with the Fibonacci retracement levels of the move (`js/fib.js`):

- **Pump:** the highest high of the last 60 candles, made 1–30 candles ago, and the lowest low of the 40 candles before it, at least 15% apart.
- **Clean:** on the way up price never gave back more than 0.382 of the move so far, so the current pullback is the pump's first.
- **First correction now:** price is at least 0.236 below the high, has made no new high since, and has not fallen past 0.886 of the move. A new high, or a deeper fall, removes the coin.
- **Levels:** 0.382, 0.5, 0.618, 0.786; "at level" = within 3% of the move.

It runs on the same candles as the Trend radar (server scan after each 1h/4h close, browser fallback). **Testing it:** `node tools/fib.mjs` (and `--tf 1h`) buys the first touch of each level in every first pullback, stop just under the pump's low, target the pump's high, 48 candles max, and compares Fibonacci levels with other depths (0.30 / 0.44 / 0.56 / 0.70) on each coin's older 70% and newest 30%. The result appears on the page.

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
node tools/setups.mjs --compare       # does each quality filter help?
```

**Quality filters.** `FILTERS` in `js/setups.js` holds five candidate filters, all **off** by default: trade with the 200-candle trend (sweeps and retests), skip choppy markets (Choppiness Index ≥ 55, for retests and regime flips), a clean sweep candle (wick at most 1 ATR past the level, close in the outer 40%), a stop wide enough that costs stay under 0.12R, and skip setups the top 20% accounts lean against. Try them on the Setups lab page, then run `--compare` on the server: it runs the baseline, each filter alone, and all together on every pair, split into each pair's older 70% and newest 30% of candles, and says whether a filter helps on both. Only filters that help on the unseen part, with 30+ trades, should be switched on (`LAB_DEFAULTS.filters`), which then applies to the Live setups page and Telegram alike.

**What the comparison showed (2 Nov 2026, 40 coins, 15m/1h/4h).** Without filters every setup lost money after costs on the newest candles (−0.03R to −0.17R per trade). "Stop wide enough for costs" was the only filter that helped on both halves on every timeframe (on 15m from −0.17R to +0.09R per trade), so it is now on. Sweep reclaims lost money on every timeframe, and regime flips on 1h, so the Live setups grade marks them C and they are not sent as alerts (`js/setup-record.js`, the "Tested on 40 coins" check). Skipping setups that the top 20% accounts leaned against made results worse, so positioning is shown on each card but no longer counted in the grade. Breakout retests were the strongest setup (15m: +0.12R older, +0.29R newest, 240 and 114 trades).

**Alert hygiene.** Live setups are not announced (in the browser or on Telegram) when price is already more than 0.3R past entry, or when the same pair has an opposite setup live on another timeframe; the page marks such conflicts.

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
js/pump.js              Pump Catcher rules: trigger, tracking, views, header stats (pure functions, shared by browser and server)
js/smartmoney.js        Smart Money parsing, cohort choice, snapshot diffs (moves, opens, roster changes)
js/smartmoney-demo.js   simulated Smart Money snapshots for demo mode
js/indicators.js        chart layers, liquidation levels, order book walls, setup check (pure functions)
js/multichart.js        stacked canvas chart: candles plus indicator panes, shared crosshair
js/pump-scanner.js      scanner loop: ticker stream, trigger, tracking, open interest
js/binance.js           Binance source for the scanner (fetch + WebSocket only)
js/demo-market.js       simulated market with the same interface
js/pump-app.js          browser scanner or shared server log, alerts (toast, sound, desktop notification)
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
worker/catcher.mjs      Pump Catcher server: round-the-clock scanning, shared signal log API, Telegram alerts
js/setups.js            setups lab: indicators, setups, realistic execution, whale split (pure functions)
tools/setups.mjs        setups lab over many pairs, from a server
js/ideas.js             live setups: active plans, evidence grade, comparable history, trigger levels (pure functions)
js/trend.js             Trend radar rules: fresh trend, swing levels, location (pure functions)
js/fib.js               Fib pullbacks: pump, first correction, retracement levels (pure functions)
tools/fib.mjs           tests buying Fibonacci levels in first pullbacks against other depths
js/trend-scan.js        runs the radar and Fib pullbacks over many coins (server and browser), demo rows
tools/trends.mjs        tests the Trend radar on Binance history
js/hl.js                Hyperliquid trader analysis: picking traders, round trips from fills, style labels (pure functions)
tools/hl-traders.mjs    finds proven Hyperliquid traders and describes how each one trades; --check tests them later
tools/hl-timing.mjs     were those traders' entries well timed, or were they on the right side? (entries vs the same side at any hour)
tools/hl-api.mjs        Hyperliquid public API calls shared by the two tools
js/sweep-regime.js      the "4h regime + 1h liquidity sweep" plan as exact rules: regime, trigger, limit fill, two-stage exit (pure functions)
tools/sol150.mjs        replays that plan on real candles against its claimed results, a no-edge reference and a control
js/setup-feed.js        live setups shared by the page and the server: bars from Binance responses, collecting and grading setups
worker/setup-alerts.mjs posts new grade A/B live setups to Telegram (runs inside worker/catcher.mjs)
deploy/setup.sh         one-step VPS setup: both servers, firewall, DuckDNS, HTTPS
worker/smartmoney.mjs   whale data server: polls Smart Money data, stores snapshots, serves the app
test/*.test.mjs         Pump Catcher, indicator, router, validation and server-helper tests (`npm test` or `node --test`)
.github/workflows/ci.yml   runs the tests and syntax checks on every push
```

## How the top Hyperliquid traders trade

Hyperliquid publishes its leaderboard and every fill of every account, so "how do the winners trade?" can be measured instead of guessed. From the server:

```
node tools/hl-traders.mjs                 # 30 proven hand-sized traders, their last 60 days (about 8 minutes)
node tools/hl-traders.mjs --top 50 --days 30
node tools/hl-traders.mjs --max-equity 500000 --min-alltime 50000   # smaller accounts
node tools/hl-traders.mjs --whales        # the month's biggest winners instead (funds and market makers)
node tools/hl-traders.mjs --check         # a month later: did those traders keep winning?
```

**Who it picks.** Accounts between $20k and $2M with over $200k all-time profit, at least $100k of it made before this month, and in profit this month and this week. It then skips bots (an account whose last 2,000 fills took under 10 days) and accounts with no trades in the period. The first version ranked by this month's dollars (now `--whales`) and, on 11 Nov 2026, returned only $5M–$170M accounts: 9 of 30 were market makers or high-frequency, 12 of 30 had been in the red until that month, and most traded so much that the public history (the last 10,000 fills) covered a single day. Nothing there could be copied by hand, hence the size cap, the "already a winner" rule and the bot screen.

**What it measures.** It rebuilds each trader's trades from their fills (flat → adds → flat) and reports trades a day, typical holding time, win rate, win size against loss size, share of resting orders, whether they add to winners or to losers, last week's funding against last week's profit, how much of the profit is a few trades, and leverage and direction now. Each account gets a plain label (market maker, high-frequency, mostly spot, funding income, position holder, few trades, a few big bets, averages into losers, adds to winners, scalper, day trader, swing trader) and a note on whether a person could test the same idea.

**Side or timing?** `node tools/hl-timing.mjs` (run after the above, about 4 minutes) takes the saved traders' entries (every hour in which they made a futures position bigger) and measures, on hourly candles, what price had done in the 24 hours before, where the entry sat in the week's range, and the result 24 and 72 hours later. It compares that with entering the same side on the same coin at any hour of their active period. The difference is timing; the rest is simply which side they were on. On 11 Nov 2026, 17 of the 20 picked traders with open positions were almost entirely short, which is what picking this month's winners in a falling market would produce by itself.

**The honest test.** A leaderboard is a list of survivors, so the run also saves 200 random accounts of the same size. `--check` compares both groups from the day they were picked: if the picks do no better than the random accounts, their past profit was not a signal. Results stay in `worker/data/hl-traders-<date>.json`.

## Checking a strategy from the internet: the "SOL-150" plan

A plan called "4H Regime + 1H Liquidity Sweep (SOL-150)" arrived with a table of 120 backtested trades ($150 → $295 in six months). The table is arithmetic on assumed win rates, not a replay of candles: it counts 30 "low-ADX chop trades" although the plan's own first rule forbids trading when ADX is under 20. `node tools/sol150.mjs` replays the rules exactly as written (js/sweep-regime.js) on real Binance 1h candles with real funding, and prints them next to the claim and next to what the same exits give with no edge at all (17% both targets, 17% first only, 67% stopped). It also shows how many candles pass each rule, runs the same rules on the 15 busiest other coins, and compares with entering at any hour in the same regime.

```
node tools/sol150.mjs                    # SOLUSDT, about 560 days, plus the top 15 coins pooled (about 2 minutes)
node tools/sol150.mjs --symbol ETHUSDT --pairs 0
```

## Moving it into your own app

- **React / Next.js / Vue:** keep `pump.js`, `pump-scanner.js`, `binance.js`, `api.js` and `chart.js` as they are. Rewrite each `views/*.js` as a component that subscribes in an effect and returns its cleanup.
- **Shared alerts for all visitors:** run the worker on a server and expose `pumps.json` (or a database) over an API, then have the page read from it instead of scanning in each browser.

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
| Open interest | `GET /futures/data/openInterestHist`, `GET /fapi/v1/openInterest` (Pump Catcher) |
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
