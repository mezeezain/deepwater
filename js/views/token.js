// One pair in depth: price, whale vs crowd history, notable whale moves, funding.
import { getMarket, getPositioning, getCandles, getFundingHistory } from '../api.js';
import { priceChart } from '../chart.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, fmtShare, signClass, shareBar, watchlist } from '../util.js';

const RANGES = [
  { id: '1d', label: '1D', interval: '15m', candles: 96, period: '15m', points: 96 },
  { id: '1w', label: '1W', interval: '1h', candles: 168, period: '1h', points: 168 },
  { id: '1m', label: '1M', interval: '4h', candles: 180, period: '4h', points: 180 },
];

export function tokenView(root, { symbol, go }) {
  let range = RANGES[0];
  let disposeChart = () => {};
  let alive = true;

  const starBtn = h('button.btn.ghost', {
    onclick: () => {
      watchlist.toggle(symbol);
      paintStar();
    },
  });
  const paintStar = () => {
    const on = watchlist.has(symbol);
    starBtn.textContent = on ? '★ Watching' : '☆ Watch';
    starBtn.setAttribute('aria-pressed', String(on));
  };
  paintStar();

  const head = h('div.token-head');
  const rangeBar = h('div.lenses', { role: 'tablist', 'aria-label': 'Chart range' });
  const chartBox = h('div.chart');
  const legend = h('div.legend',
    h('span.key.whale', 'Whales long share'),
    h('span.key.crowd', 'Crowd long share'),
    h('span.key.marker', 'Big whale move'),
  );
  const facts = h('div.facts');
  const moves = h('div.moves');
  const funding = h('div.funding-bars');

  root.replaceChildren(
    h('button.back', { onclick: () => go('whales') }, '← All pairs'),
    h('section.panel', h('div.token-top', head, starBtn)),
    h('div.split',
      h('section.panel.grow', h('div.toolbar', h('h2', 'Price and positioning'), rangeBar), chartBox, legend),
      h('aside.panel.side', h('h2', 'Right now'), facts),
    ),
    h('div.split',
      h('section.panel.grow', h('h2', 'Whale moves'), h('p.note', 'Hours where whale long share jumped 6 points or more.'), moves),
      h('section.panel.grow', h('h2', 'Funding, last 10 days'), h('p.note', 'Positive means longs pay shorts every 8 hours.'), funding),
    ),
  );

  function renderRange() {
    rangeBar.replaceChildren(...RANGES.map((r) =>
      h('button.lens', { role: 'tab', 'aria-selected': String(r === range), onclick: () => { range = r; loadChart(); } }, r.label)));
  }

  async function loadHead() {
    const market = await getMarket();
    const m = market.find((x) => x.symbol === symbol);
    if (!m) {
      head.replaceChildren(h('h1', ticker(symbol)), h('p.error', `${symbol} isn't a trading USDT perpetual on Binance. Check the ticker and try again.`));
      return null;
    }
    head.replaceChildren(
      h('div',
        h('p.eyebrow', `${symbol} · perpetual`),
        h('h1.token-title', ticker(symbol), h('span.token-price', fmtPrice(m.price)), h(`span.token-chg.${signClass(m.change24h)}`, fmtPct(m.change24h))),
      ),
      h('dl.inline-stats',
        h('div', h('dt', '24h volume'), h('dd', fmtUsd(m.quoteVolume))),
        h('div', h('dt', '24h range'), h('dd', `${fmtPrice(m.low)} – ${fmtPrice(m.high)}`)),
        h('div', h('dt', 'Funding'), h(`dd.${signClass(m.funding)}`, m.funding == null ? '–' : (m.funding * 100).toFixed(4) + '%')),
      ),
    );
    return m;
  }

  async function loadChart() {
    renderRange();
    chartBox.replaceChildren(h('p.loading', 'Loading chart…'));
    const [candles, pos] = await Promise.all([
      getCandles(symbol, range.interval, range.candles),
      getPositioning(symbol, range.period, Math.min(range.points, 500)),
    ]);
    if (!alive) return;
    disposeChart();
    const big = whaleMoves(pos.whales);
    disposeChart = priceChart(chartBox, {
      candles,
      overlays: [
        { label: 'Whales', color: '--whale', points: pos.whales.map((p) => ({ t: p.t, v: p.long })), width: 2 },
        { label: 'Crowd', color: '--crowd', points: pos.crowd.map((p) => ({ t: p.t, v: p.long })) },
      ],
      markers: big.map((b) => ({ t: b.t, dir: b.delta })),
    });
    renderFacts(pos);
    renderMoves(big, candles);
  }

  function whaleMoves(series) {
    const out = [];
    for (let i = 1; i < series.length; i++) {
      const delta = (series[i].long - series[i - 1].long) * 100;
      if (Math.abs(delta) >= 6) out.push({ t: series[i].t, delta, after: series[i].long });
    }
    return out;
  }

  function renderFacts(pos) {
    const w = pos.whales.at(-1)?.long;
    const s = pos.smart.at(-1)?.long;
    const c = pos.crowd.at(-1)?.long;
    const oi = pos.oi;
    const oiChg = oi.length > 1 ? ((oi.at(-1).value - oi[0].value) / oi[0].value) * 100 : null;
    let read = 'Whales and the crowd are roughly in agreement.';
    if (w != null && c != null) {
      const gap = Math.abs(w - c) * 100;
      if (gap >= 40) read = w > c
        ? `Whales are much more long than the crowd (${Math.round(gap)} point gap). The crowd is leaning short.`
        : `Whales are much more short than the crowd (${Math.round(gap)} point gap). The crowd is leaning long.`;
      else if (gap >= 20) read = `A moderate ${Math.round(gap)} point gap between whales and the crowd.`;
    }
    facts.replaceChildren(
      h('div.fact', h('span.fact-label', 'Whales'), shareBar(w ?? 0.5, 'Whales')),
      h('div.fact', h('span.fact-label', 'Top accounts'), shareBar(s ?? 0.5, 'Top accounts')),
      h('div.fact', h('span.fact-label', 'Crowd'), shareBar(c ?? 0.5, 'Crowd')),
      h('p.read', read),
      h('div.fact-row', h('span', 'Open interest'), h('strong', fmtUsd(oi.at(-1)?.value))),
      h('div.fact-row', h('span', 'Open interest change, chart range'), h(`strong.${signClass(oiChg)}`, fmtPct(oiChg))),
    );
  }

  function renderMoves(big, candles) {
    if (!big.length) {
      moves.replaceChildren(h('p.empty', 'No large whale moves in this range.'));
      return;
    }
    const priceAt = (t) => candles.reduce((best, k) => (Math.abs(k.t - t) < Math.abs(best.t - t) ? k : best), candles[0]).c;
    moves.replaceChildren(h('ol.move-list', ...big.slice(-12).reverse().map((b) =>
      h('li',
        h(`span.move-dir.${b.delta > 0 ? 'up' : 'down'}`, b.delta > 0 ? 'Added longs' : 'Added shorts'),
        h('span.move-size', `${b.delta > 0 ? '+' : ''}${b.delta.toFixed(1)} pts → ${fmtShare(b.after)} long`),
        h('span.move-meta', `at ${fmtPrice(priceAt(b.t))} · ${new Date(b.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`),
      ))));
  }

  async function loadFunding() {
    const hist = await getFundingHistory(symbol, 30);
    const max = Math.max(...hist.map((x) => Math.abs(x.rate)), 1e-6);
    funding.replaceChildren(
      h('div.fbars', ...hist.map((f) => h(`span.fbar.${f.rate >= 0 ? 'up' : 'down'}`, {
        style: { '--h': Math.abs(f.rate) / max },
        title: `${new Date(f.t).toLocaleString()}: ${(f.rate * 100).toFixed(4)}%`,
      }))),
      h('p.note', `Average ${(hist.reduce((s, x) => s + x.rate, 0) / hist.length * 100).toFixed(4)}% per 8h, about ${(hist.reduce((s, x) => s + x.rate, 0) / hist.length * 3 * 365 * 100).toFixed(1)}% a year.`),
    );
  }

  loadHead().then((m) => {
    if (!m) return;
    loadChart().catch((e) => chartBox.replaceChildren(h('p.error', `Couldn't load the chart. ${e.message}`)));
    loadFunding().catch(() => funding.replaceChildren(h('p.empty', 'Funding history is unavailable.')));
  }).catch((e) => head.replaceChildren(h('p.error', e.message)));

  return () => {
    alive = false;
    disposeChart();
  };
}
