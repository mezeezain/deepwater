// One pair in depth: price with order-flow and positioning layers, setup check, whale moves, funding.
import { getMarket, getChartData, CHART_INTERVALS } from '../api.js';
import { multiChart } from '../multichart.js';
import { marketLayers, whaleLayers, whaleEntries, liquidationLevels, setupCheck, fmtCompact } from '../indicators.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, signClass, shareBar, watchlist, store } from '../util.js';

const usd = (v) => `${v < 0 ? '-' : ''}$${fmtCompact(Math.abs(v))}`;
const share = (v) => `${Math.round(v * 100)}%`;

// Each layer: a pane under the price chart, or an overlay on the price chart.
export const LAYERS = [
  { id: 'gap', group: 'Whales', label: 'Whales vs crowd', hint: 'Long share of top traders (by position) against all accounts' },
  { id: 'shift', group: 'Whales', label: 'Whale moves', hint: 'Change in estimated whale net exposure. Grey dots: likely ranking change, not a trade' },
  { id: 'opens', group: 'Whales', label: 'Whale opens', hint: 'Newly added whale exposure only, closures excluded (estimate)' },
  { id: 'net', group: 'Whales', label: 'Whale net position', hint: 'Estimated whale longs minus shorts' },
  { id: 'entries', group: 'Whales', label: 'Whale entry lines', overlay: true, hint: 'Estimated average entry of whale longs and shorts in this window' },
  { id: 'flow', group: 'Market', label: 'Net longs / shorts', hint: 'Open interest change split by which side was aggressive (estimate)' },
  { id: 'cvd', group: 'Market', label: 'CVD', hint: 'Cumulative taker buy minus taker sell volume' },
  { id: 'oi', group: 'Market', label: 'Open interest', hint: 'Open contracts, valued in USDT' },
  { id: 'liq', group: 'Market', label: 'Liquidations', hint: 'Estimated forced closes: sharp OI drop on a wide, one-sided candle' },
  { id: 'funding', group: 'Market', label: 'Funding', hint: 'Funding rate per 8h' },
  { id: 'volume', group: 'Market', label: 'Volume', hint: 'Taker buy volume up, taker sell volume down' },
  { id: 'absorb', group: 'Market', label: 'Absorption dots', overlay: true, hint: 'Heavy one-sided taker flow that failed to move price' },
];
const DEFAULT_LAYERS = ['gap', 'shift', 'flow', 'cvd', 'oi', 'entries', 'absorb'];

export function tokenView(root, { symbol, go }) {
  let interval = store.get('chart-interval', '1h');
  let layers = new Set(store.get('chart-layers', DEFAULT_LAYERS));
  let data = null;
  let disposeChart = () => {};
  let alive = true;
  store.set('last-pair', symbol);

  const starBtn = h('button.btn.ghost', { onclick: () => { watchlist.toggle(symbol); paintStar(); } });
  const paintStar = () => {
    const on = watchlist.has(symbol);
    starBtn.textContent = on ? '★ Watching' : '☆ Watch';
    starBtn.setAttribute('aria-pressed', String(on));
  };
  paintStar();

  const head = h('div.token-head');
  const intervalBar = h('div.lenses', { role: 'tablist', 'aria-label': 'Candle interval' });
  const layerBar = h('div.layer-bar');
  const chartBox = h('div.chart.multi');
  const checks = h('div.checks-list');
  const facts = h('div.facts');
  const moves = h('div.moves');
  const funding = h('div.funding-bars');

  root.replaceChildren(
    h('button.back', { onclick: () => go('whales') }, '← All pairs'),
    h('section.panel', h('div.token-top', head, h('div.toolbar-right', h('button.btn.ghost', { onclick: () => go('liqmap', symbol) }, 'Liquidation map →'), starBtn))),
    h('section.panel', h('div.toolbar', h('h2', 'Chart'), intervalBar), layerBar, chartBox),
    h('div.split',
      h('section.panel.grow', h('h2', 'Setup check'), h('p.note', 'Four questions to ask before trusting a move, answered from the last 12 candles.'), checks),
      h('aside.panel.side', h('h2', 'Right now'), facts),
    ),
    h('div.split',
      h('section.panel.grow', h('h2', 'Biggest whale moves'), h('p.note', 'Largest estimated changes in whale net exposure in this window. Likely ranking changes are left out.'), moves),
      h('section.panel.grow', h('h2', 'Funding'), h('p.note', 'Positive means longs pay shorts, usually every 8 hours.'), funding),
    ),
  );

  function renderControls() {
    intervalBar.replaceChildren(...Object.keys(CHART_INTERVALS).map((iv) =>
      h('button.lens', { role: 'tab', 'aria-selected': String(iv === interval), onclick: () => {
        interval = iv;
        store.set('chart-interval', iv);
        load();
      } }, iv)));
    const groups = [...new Set(LAYERS.map((l) => l.group))];
    layerBar.replaceChildren(...groups.map((g) => h('div.layer-group',
      h('span.layer-group-label', g),
      ...LAYERS.filter((l) => l.group === g).map((l) =>
        h('button.layer', { 'aria-pressed': String(layers.has(l.id)), title: l.hint, onclick: () => {
          layers.has(l.id) ? layers.delete(l.id) : layers.add(l.id);
          store.set('chart-layers', [...layers]);
          renderControls();
          renderChart();
        } }, l.label)))));
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

  async function load() {
    renderControls();
    chartBox.style.height = '';
    chartBox.replaceChildren(h('p.loading', 'Loading chart…'));
    try {
      const raw = await getChartData(symbol, interval, 300);
      if (!alive) return;
      if (raw.bars.length < 20) {
        chartBox.replaceChildren(h('p.empty', 'Not enough history for this pair yet.'));
        return;
      }
      const market = marketLayers(raw.bars);
      const whales = whaleLayers(raw.bars);
      const levels = liquidationLevels(raw.bars, market).active;
      data = { ...raw, market, whales, levels, entries: whaleEntries(raw.bars, whales) };
      renderChart();
      renderChecks();
      renderFacts();
      renderMoves();
      renderFunding();
    } catch (e) {
      chartBox.replaceChildren(h('p.error', `Couldn't load the chart. ${e.message}`));
    }
  }

  function fundingAt(t) {
    let rate = null;
    for (const f of data.funding) {
      if (f.t <= t) rate = f.rate;
      else break;
    }
    return rate;
  }

  function renderChart() {
    if (!data) return;
    disposeChart();
    const { bars, market, whales, entries } = data;
    const panes = [];
    const add = (id, pane) => layers.has(id) && panes.push(pane);
    const hasWhales = whales.some((w) => w.longUsd != null);
    add('gap', {
      id: 'gap', label: 'Whales vs crowd', kind: 'share', format: share,
      series: [
        { name: 'Whales', values: bars.map((b) => b.whaleLong ?? b.smartLong), color: '--whale', width: 2 },
        { name: 'Crowd', values: bars.map((b) => b.crowdLong), color: '--crowd' },
      ],
    });
    if (hasWhales) {
      add('shift', {
        id: 'shift', label: 'Whale moves (est.)', kind: 'hist', format: usd,
        series: [
          { values: whales.map((w) => w.shift), color: '--long', colorDown: '--short' },
          { kind: 'dots', values: whales.map((w) => w.rosterChange), color: '--muted' },
        ],
      });
      add('opens', {
        id: 'opens', label: 'Whale opens (est.)', kind: 'hist', format: usd,
        series: [
          { name: 'Long', values: whales.map((w) => w.opensLong), color: '--long' },
          { name: 'Short', values: whales.map((w) => -w.opensShort), color: '--short', colorDown: '--short' },
        ],
      });
      add('net', { id: 'net', label: 'Whale net position (est.)', kind: 'step', format: usd, series: [{ values: whales.map((w) => w.net), color: '--long', colorDown: '--short', width: 2 }] });
    }
    add('flow', {
      id: 'flow', label: 'Net longs / shorts (est.)', kind: 'line', format: usd,
      series: [
        { name: 'Longs', values: market.map((m) => m.netLongs), color: '--long' },
        { name: 'Shorts', values: market.map((m) => m.netShorts), color: '--short' },
      ],
    });
    add('cvd', { id: 'cvd', label: 'CVD', kind: 'line', format: usd, series: [{ values: market.map((m) => m.cvd), color: '--accent' }] });
    add('oi', { id: 'oi', label: 'Open interest', kind: 'line', format: usd, series: [{ values: bars.map((b) => (b.oi != null ? b.oi * b.c : null)), color: '--crowd' }] });
    add('liq', {
      id: 'liq', label: 'Liquidations (est.)', kind: 'hist', format: (v) => usd(Math.abs(v)),
      series: [{ name: '', values: market.map((m) => (m.liq ? (m.liq.side === 'short' ? m.liq.usd : -m.liq.usd) : null)), color: '--long', colorDown: '--short', hideValue: false }],
    });
    add('funding', { id: 'funding', label: 'Funding / 8h', kind: 'step', format: (v) => `${(v * 100).toFixed(4)}%`, series: [{ values: bars.map((b) => fundingAt(b.t)), color: '--long', colorDown: '--short' }] });
    add('volume', {
      id: 'volume', label: 'Volume', kind: 'hist', format: (v) => usd(Math.abs(v)),
      series: [
        { name: 'Buy', values: bars.map((b) => b.takerBuy), color: '--long' },
        { name: 'Sell', values: bars.map((b) => -(b.v - b.takerBuy)), color: '--short', colorDown: '--short' },
      ],
    });

    const levels = [];
    if (layers.has('entries') && hasWhales) {
      if (entries.long) levels.push({ price: entries.long, label: 'Whale long entry est.', color: '--long' });
      if (entries.short) levels.push({ price: entries.short, label: 'Whale short entry est.', color: '--short' });
    }
    const markers = [];
    if (layers.has('absorb')) {
      market.forEach((m) => {
        if (m.absorption) markers.push({ t: m.t, shape: 'dot', color: m.absorption === 'sellers-absorbed' ? '--long' : '--short' });
      });
    }
    if (data.listedAt && data.listedAt >= bars[0].t) markers.push({ t: data.listedAt, shape: 'line', color: '--whale', title: 'Listed on Binance futures' });

    disposeChart = multiChart(chartBox, { bars, panes, price: { levels, markers }, label: `${ticker(symbol)} ${interval} chart with ${panes.length} indicator panes` });
  }

  function renderChecks() {
    const items = setupCheck(data.bars, data.market, data.whales, { levels: data.levels });
    const icon = { good: '✓', warn: '!', bad: '✕', na: '–' };
    checks.replaceChildren(...(items.length
      ? items.map((it) => h(`div.check-item.${it.state}`, h('span.check-icon', { 'aria-hidden': 'true' }, icon[it.state]), h('div', h('strong', it.label), h('p', it.detail))))
      : [h('p.empty', 'Not enough data for a setup check.')]));
  }

  function renderFacts() {
    const last = data.bars.at(-1);
    const w = last.whaleLong ?? last.smartLong;
    const m = data.market;
    const recentLiq = m.slice(-24).filter((x) => x.liq);
    const { entries } = data;
    const row = (label, value, cls = '') => h('div.fact-row', h('span', label), h(`strong.${cls}`, value));
    facts.replaceChildren(
      h('div.fact', h('span.fact-label', 'Whales'), shareBar(w ?? 0.5, 'Whales')),
      h('div.fact', h('span.fact-label', 'Top accounts'), shareBar(last.smartLong ?? 0.5, 'Top accounts')),
      h('div.fact', h('span.fact-label', 'Crowd'), shareBar(last.crowdLong ?? 0.5, 'Crowd')),
      row('Open interest', last.oi != null ? fmtUsd(last.oi * last.c) : '–'),
      row('CVD, last 24 candles', usd(m.at(-1).cvd - m.at(-25).cvd), signClass(m.at(-1).cvd - m.at(-25).cvd)),
      row('Whale long entry est.', entries.long ? fmtPrice(entries.long) : '–'),
      row('Whale short entry est.', entries.short ? fmtPrice(entries.short) : '–'),
      row('Liquidation events, 24 candles', String(recentLiq.length)),
      data.listedAt && row('Listed on Binance futures', new Date(data.listedAt).toLocaleDateString()),
    );
  }

  function renderMoves() {
    const { whales, bars } = data;
    const big = whales.map((w, i) => ({ ...w, price: bars[i].c })).filter((w) => !w.rosterChange && w.shift !== 0)
      .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift)).slice(0, 8).sort((a, b) => b.t - a.t);
    if (!big.length) {
      moves.replaceChildren(h('p.empty', 'No whale data for this pair.'));
      return;
    }
    moves.replaceChildren(h('ol.move-list', ...big.map((b) =>
      h('li',
        h(`span.move-dir.${b.shift > 0 ? 'up' : 'down'}`, b.shift > 0 ? 'Toward long' : 'Toward short'),
        h('span.move-size', `${b.shift > 0 ? '+' : ''}${usd(b.shift)}${b.opensLong || b.opensShort ? ` · opened ${b.opensLong >= b.opensShort ? 'longs ' + usd(b.opensLong) : 'shorts ' + usd(b.opensShort)}` : ' · closing only'}`),
        h('span.move-meta', `at ${fmtPrice(b.price)} · ${new Date(b.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`),
      ))));
  }

  function renderFunding() {
    const hist = data.funding.slice(-30);
    if (!hist.length) {
      funding.replaceChildren(h('p.empty', 'Funding history is unavailable.'));
      return;
    }
    const max = Math.max(...hist.map((x) => Math.abs(x.rate)), 1e-6);
    const mean = hist.reduce((s, x) => s + x.rate, 0) / hist.length;
    funding.replaceChildren(
      h('div.fbars', ...hist.map((f) => h(`span.fbar.${f.rate >= 0 ? 'up' : 'down'}`, {
        style: { '--h': Math.abs(f.rate) / max },
        title: `${new Date(f.t).toLocaleString()}: ${(f.rate * 100).toFixed(4)}%`,
      }))),
      h('p.note', `Last ${hist.length} payments average ${(mean * 100).toFixed(4)}%, about ${(mean * 3 * 365 * 100).toFixed(1)}% a year.${mean < 0 ? ' Negative: shorts are paying to stay short.' : ''}`),
    );
  }

  renderControls();
  loadHead().then((m) => m && load()).catch((e) => head.replaceChildren(h('p.error', e.message)));

  return () => {
    alive = false;
    disposeChart();
  };
}
