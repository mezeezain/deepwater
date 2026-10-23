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
| Whales vs crowd | `#whales` | Top traders' long share against all accounts for the 60 most traded pairs. Rankings for biggest gap, whales most long/short, biggest 24h shift and **contrarian setups** (whales against a lopsided crowd). Sortable, filterable, watchlist (★), copy as CSV |
| Pair page | `#SOLUSDT` | Indicator chart (5m–1d) with selectable layers, a four-point setup check, biggest whale moves and funding. See "Chart layers" |
| Charts | `#charts` | The pair page for the last pair you opened |
| Liquidation map | `#liqmap-SOLUSDT` | Estimated liquidation levels over time, cleared when a wick trades through them, with the live order book, walls (size vs typical, how long they've rested) and whale entry estimates |
| Pump catcher | `#pumps` | Scans every USDT perpetual every 5 seconds, fires alerts and tracks each one until the move ends (see below) |
| Signal page | `#sig-<pair>-<time>` | Chart around one alert with alert, peak and dip lines, why it fired, and how it closed |
| Liquidations | `#liquidations` | Live forced liquidations by pair, long vs short |
| Heatmap | `#heatmap` | Pairs sized by volume, coloured by 24h change or funding |
| Funding | `#funding` | Every pair's funding, yearly equivalent, time to next payment |
| Calculator | `#calculator` | Profit after fees, return on margin, break-even and estimated liquidation price |

## Chart layers

Price is treated as the result; positioning and order flow are what move it. Toggle any of these on the pair page (choices are remembered):

| Layer | How it's calculated |
|---|---|
| Whales vs crowd | Top traders' long share (by position) vs all accounts. Falls back to top accounts when position data is missing |
| Whale moves (est.) | Change in estimated whale net exposure: top-trader long share × open interest. Grey dots mark a share jump with flat open interest, which is likely a change in who ranks as a top trader, not a trade, so it is left out |
| Whale opens (est.) | Only the increase in whale long or short exposure; closures are excluded, so short covering doesn't look like buying |
| Whale net position (est.) | Estimated whale longs minus shorts |
| Whale entry lines (est.) | Price weighted by estimated whale opens in the window, for longs and shorts |
| Net longs / shorts (est.) | Each candle's open interest change, assigned by the aggressive side: OI up + net buying = longs opened, OI up + net selling = shorts opened, OI down + net buying = shorts closed, OI down + net selling = longs closed |
| CVD | Running sum of taker buy minus taker sell volume |
| Open interest | Open contracts valued in USDT |
| Liquidations (est.) | Open interest drops at least 2× the usual change, on a candle at least 1.5× the usual range, with one-sided taker flow |
| Funding, Volume | Funding rate per 8h; taker buy and sell volume |
| Absorption dots | Taker flow more than 20% one-sided while price moved under 0.15%: someone was absorbing it with limit orders |
| Listing marker | Date the pair was listed on Binance futures, if it falls in the window |

**Setup check** answers four questions from the last 12 candles: is the move driven by new longs or by short covering, are whales opening longs, is the crowd on the wrong side, and is price near the whale entry with liquidations stacked overhead. It also appears on each pump signal's page.

**Liquidation map:** each candle's estimated new longs or shorts are spread across 10×, 25×, 50× and 100× leverage (35/30/20/15%). Long liquidation price ≈ entry × (1 − 1/leverage + 0.5%), and short ≈ entry × (1 + 1/leverage − 0.5%). Levels are grouped into 0.25% price buckets and removed once a candle trades through them. The order book refreshes every 15 seconds while the page is open.

Everything marked *est.* is an estimate: Binance publishes ratios and totals, not individual positions or entry prices.

## Pump catcher

A pair has to pass three gates before it fires:

1. **Lift-off.** Price is 4.5–18% above its rolling 24h low and moved at least 1.5% in the last 5 minutes. Below the band it's noise; above it the move is usually spent.
2. **Fuel.** Last 5 minutes of volume is at least 2.5× the recent average, taker buys are at least 56% of volume (positive CVD), and open interest rose at least 1.5% in 15 minutes, so new positions are opening rather than shorts just closing.
3. **Positioning.** Whales are more than 5 points longer than the crowd, or the crowd is under 40% long (short-squeeze fuel). This gate can be switched off.

After an alert, the signal is tracked:

- **Rise after alert:** the best gain since the alert, and how long it took.
- **Dip before peak:** the lowest point between the alert and that best gain. A drawdown *after* the peak doesn't change it.
- **Closes** when price falls 5% below the alert, gives back 45% of a gain over 8%, or after 72 hours.

Every threshold can be changed under **Settings** on the page. The defaults are a reasonable starting point, not tuned values. The page shows the 30-day hit rate (share of alerts that reached +10%) and median rise and dip, so you can see whether a change helps.

Cost: screening uses the all-market ticker stream (one WebSocket). Only pairs that pass gate 1 trigger REST lookups: 4 light requests, at most once a minute per pair and 6 at a time.

The browser keeps a 30-day signal log in `localStorage`, and when you reopen the page it catches up tracking signals from 1-minute candles. It only scans while the page is open, so for round-the-clock alerts use the worker.

### Background worker with Telegram alerts

`worker/catcher.mjs` runs the same engine on a server (Node 22+, no `npm install` needed):

```bash
# Try it on the simulated market
node worker/catcher.mjs --demo

# Live, with Telegram alerts
TELEGRAM_BOT_TOKEN=123456:ABC... TELEGRAM_CHAT_ID=-1001234567890 node worker/catcher.mjs

# Custom thresholds
CATCHER_CONFIG='{"minRise":5,"minRvol":3}' node worker/catcher.mjs
```

To get a bot token, message @BotFather on Telegram. To get the chat ID, add the bot to your channel and send a message, then open `https://api.telegram.org/bot<token>/getUpdates`. Signals are saved to `worker/signals.json`. Run it with `pm2`, `systemd` or a Docker container on a VPS in a region Binance serves.

### Tests

```bash
node --test
```

These cover the gates, order-flow maths, rise and dip accounting (including that a post-peak drawdown doesn't change the dip before peak), the close rules, catch-up from candles, cooldown and the summary stats.

## Limits

- **"Whales"** are Binance's top traders by position size (`topLongShortPositionRatio`). Binance doesn't publish trader counts or profitability, so there's no fallback for pairs with few whales.
- **Per-trader PnL, whale dollar positions and entry prices** aren't published by Binance. Whale amounts and entries are estimated from the top-trader ratio and open interest.
- **Positioning history** (open interest, long/short ratios) only goes back 30 days and isn't available at the weekly interval.
- **Order book history** isn't available from Binance, so walls are tracked only while the map is open.
- **Not included:** listings on other exchanges (no free data source) and chart drawing tools.
- **Rise and dip** in the browser are measured from live prices about once a second. Brief wicks between updates can be missed, except during catch-up, which uses candle highs and lows.

## Code layout

```
index.html              shell: top bar, status strip, <main>
css/app.css             theme tokens (light + dark) and all component styles
js/engine.js            pump catcher rules: pure functions, shared by browser and worker
js/indicators.js        chart layers, liquidation levels, order book walls, setup check (pure functions)
js/multichart.js        stacked canvas chart: candles plus indicator panes, shared crosshair
js/catcher.js           scanner loop: ticker stream, screening, confirmation, tracking
js/binance.js           Binance source for the catcher (fetch + WebSocket only)
js/demo-market.js       simulated market with the same interface
js/catcher-app.js       browser instance, alerts (toast, sound, desktop notification)
js/api.js               Binance client for the other screens: request queue, cache, live/demo switch
js/demo.js              sample data for the other screens
js/util.js              h() DOM helper, formatters, watchlist, CSV
js/chart.js             canvas candle chart with share overlays and level lines; SVG sparkline
js/app.js               hash router and navigation
js/views/*.js           one file per screen; each returns a cleanup function
worker/catcher.mjs      Node worker with Telegram alerts
test/*.test.mjs         engine and indicator tests (node --test)
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
