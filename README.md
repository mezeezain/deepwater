# Deepwater

Binance futures positioning tools: whales vs crowd, pump scanner, live liquidations, market heatmap, funding rates and a futures calculator.

Plain HTML, CSS and ES modules. No build step, no dependencies, no API keys.

## Run it

```bash
cd deepwater
python3 -m http.server 8000      # or: npx serve .
# open http://localhost:8000
```

It must be served over http(s), because browsers block ES modules opened as `file://`.

Add `?demo` to the URL to use sample data. The app also switches to demo data on its own when Binance can't be reached. Binance blocks its futures API in some regions, including the US (HTTP 451). If you deploy for users there, put a small server-side proxy in a supported region and change `BASE` in `js/api.js`.

## Feature map

| Feature on the reference site | Here | What's better |
|---|---|---|
| Whales vs crowd table | `#whales` | Sortable columns, text filter, a **Contrarian setups** lens that flags whales on the other side of a lopsided crowd, a 24h whale trend sparkline, open-interest change, funding, a watchlist (★), and copy as CSV |
| Whale long % / Crowd long % / Gap | same | Signal chips (Contrarian / Shifting / Aligned) so the pairs that need attention stand out |
| Smart traders long | "Top accts" column | Uses Binance's top-trader *account* ratio |
| Whales 24h ago | "Whale 24h" column | Shown as a signed change in points instead of a second percentage |
| Token file + live chart | `#SOLUSDT` (any pair) | Candles with whale and crowd long-share lines, markers on big whale moves, a plain-language read of the gap, an open interest panel, a whale move log with the price at each move, and 10 days of funding |
| Pump Catcher | `#pumps` | Adjustable candle size, minimum move and volume multiple; catches dumps too; highlights new signals and can beep |
| Liquidation heatmap | `#liquidations` | Live from Binance's public liquidation stream, with tiles by pair split into long and short, totals, the biggest single liquidation, and a size filter |
| Heatmap | `#heatmap` | Volume-weighted tiles, coloured by 24h change or by funding |
| Funding rates of all coins | `#funding` | Yearly equivalent, countdown to the next payment, pressure bars and a volume filter |
| Long short ratio of all coins | `#whales`, sorted by Crowd long | The same data, merged into one table |
| Futures calculator | `#calculator` | Net profit after fees, return on margin, break-even price, estimated liquidation price and distance to it, and a warning when the exit is past liquidation |

Not included:
- **PnL long/short** needs per-trader data that Binance doesn't publish.
- **The "real" order book view, AI assistant, Pro accounts, delisting list and pre-IPO pages** each need a backend, a paid data source or an account system. Ask if you want one of them next.

## Code layout

```
index.html            shell: top bar, status strip, <main>
css/app.css           theme tokens (light + dark) and all component styles
js/api.js             Binance client: request queue (6 at a time), 60s cache, live/demo switch
js/demo.js            deterministic sample data
js/util.js            h() DOM helper, formatters, watchlist, CSV
js/chart.js           canvas candle chart with share overlays; SVG sparkline
js/app.js             hash router and navigation
js/views/*.js         one file per screen; each returns a cleanup function
```

## Moving it into your own app

- **React / Next.js / Vue:** keep `api.js`, `demo.js` and `chart.js` as they are; they don't touch the page layout. Rewrite each `views/*.js` as a component that calls the same API functions in an effect and returns its cleanup.
- **Backend:** move `getMarket` and `getPositioning` to a server route and cache them there. Then every visitor shares one set of Binance requests, and you can store whale history for longer than Binance's 30 days.

## Binance endpoints used

| Data | Endpoint |
|---|---|
| Pairs | `GET /fapi/v1/exchangeInfo` |
| Price, 24h stats | `GET /fapi/v1/ticker/24hr` |
| Funding (current) | `GET /fapi/v1/premiumIndex` |
| Funding history | `GET /fapi/v1/fundingRate` |
| Candles | `GET /fapi/v1/klines` |
| Whales (top traders, by position) | `GET /futures/data/topLongShortPositionRatio` |
| Top accounts | `GET /futures/data/topLongShortAccountRatio` |
| Crowd (all accounts) | `GET /futures/data/globalLongShortAccountRatio` |
| Open interest | `GET /futures/data/openInterestHist` |
| Liquidations (live) | `wss://fstream.binance.com/ws/!forceOrder@arr` |

Not financial advice.
