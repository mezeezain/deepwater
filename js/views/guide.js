// Plain-language guide: what each screen shows, where the numbers come from, and what they cannot tell you.
import { h, fill } from '../util.js';

const TERMS = [
  ['Whales', 'Traders Binance’s Smart Money data classes as the largest by position size. “Whales long” is the share of whale position value that is long, so 70% means 70 cents of every whale dollar is betting up.'],
  ['Crowd', 'All accounts on the pair, counted by account, not by size. It tells you how many people are long, not how much money.'],
  ['T20', 'A pair without Smart Money data. Deepwater then uses Binance’s “top 20% of accounts by margin balance”, a far broader group than whales, so treat the number as a rough proxy.'],
  ['Gap', 'Percentage points between whale long share and crowd long share. A wide gap means the two groups disagree.'],
  ['Contrarian', 'Whales lean one way while a lopsided crowd (more than 65% or less than 35% long) leans the other, and the gap is at least 40 points. It describes positioning, not a forecast.'],
  ['Open interest (OI)', 'The total value of open contracts. Rising OI with rising price usually means new money is entering; falling OI means positions are closing.'],
  ['Funding', 'A periodic payment between longs and shorts that keeps the perpetual near spot. Positive: longs pay shorts. Most pairs settle every 8 hours; some every 4 or 1.'],
  ['Liquidation map', 'An estimate of where leveraged positions would be force-closed, built from open interest and typical leverage. It is a model, not Binance’s actual book.'],
  ['Pump catcher', 'Scans every pair for sudden moves and records each alert with what happened afterwards, so you can judge the rules by their track record.'],
  ['Expectancy', 'The average result per closed signal after costs. With few signals it is mostly noise; treat anything under a few dozen closed signals as anecdote.'],
];

const SCREENS = [
  ['Whales', 'Ranks about 60 pairs by how far whales and the crowd disagree.'],
  ['Pump catcher', 'Live alerts for fast movers with a running track record.'],
  ['Live setups', 'Current trade plans with entry, stop, targets and how similar setups did before.'],
  ['Setups lab', 'Replays each setup model over history so you can see how it would have performed.'],
  ['Charts', 'One pair in depth: price, open interest, CVD, whale layers and funding.'],
  ['Funding, Heatmap', 'Where funding or price change is most extreme across the market.'],
  ['Liq map, Liquidations', 'Estimated liquidation levels and a live feed of forced closes.'],
  ['Calculator', 'Profit, fees and approximate liquidation price before you open a position.'],
];

export function guideView(root) {
  fill(root,
    h('section.hero.compact', h('div.hero-text',
      h('p.eyebrow', 'Guide'),
      h('h1', 'How to read Deepwater'),
      h('p.lede', 'Deepwater shows how different groups of traders are positioned on Binance USDⓈ-M perpetual futures. It does not predict price.'))),
    h('section.panel.guide',
      h('p.risk-note', h('strong', 'Not financial advice. '), 'Positioning is context, not a signal to trade. Futures are leveraged and you can lose more than your margin. Past alerts and backtests do not guarantee future results, and small samples mislead.'),
      h('h2', 'The screens'),
      h('dl', SCREENS.flatMap(([t, d]) => [h('dt', t), h('dd', d)])),
      h('h2', 'Terms'),
      h('dl', TERMS.flatMap(([t, d]) => [h('dt', t), h('dd', d)])),
      h('h2', 'Where the data comes from'),
      h('p.note', 'Prices, open interest, funding and account ratios come from Binance’s public futures API, fetched by your browser. Exact whale numbers (headcount, position value, entry, unrealized PnL) come from Binance’s Smart Money page, which only a server can read, so they come from a small separate server. If either source is unreachable, Deepwater says so and, where possible, falls back to a simulated demo that is clearly marked DEMO.'),
      h('h2', 'Limits worth knowing'),
      h('ul.steps',
        h('li', 'Binance recalculates Smart Money data only every few hours, so whale numbers lag the price.'),
        h('li', 'Account-based ratios treat a trader with $100 the same as one with $10 million. Whale numbers weight by size.'),
        h('li', 'Binance blocks some regions (HTTP 451/403). From those, Deepwater can only show the demo.'),
        h('li', 'Estimates (liquidation map, “whale moves” without exact data, OI by aggressor) are models, labelled as such where they appear.')),
      h('h2', 'Privacy and the data server'),
      h('p.note', 'Deepwater has no accounts and sets no cookies. By default the page also contacts a small server run by the project (deepwater-whales.duckdns.org) for exact whale data and the shared pump log, so that server sees your IP address like any web server does. Under Whales → Whale data you can disconnect from it or point the page at your own server; without it the page falls back to Binance’s public ratios. The server is one small machine, so it can be offline, and the page then says so. Numbers received from it are range-checked before they are shown.'),
      h('h2', 'Keyboard'),
      h('p.note', 'Tab moves between controls. Pair names in tables are links. Menus open with Enter or Space and close with Escape. “Skip to main content” appears on the first Tab.')),
  );
  return () => {};
}
