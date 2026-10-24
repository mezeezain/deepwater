// One pair in depth: price with order-flow and positioning layers, setup check, whale moves, funding.
import { getMarket, getChartData, getSmartHistory, CHART_INTERVALS } from '../api.js';
import { alignToBars, pickCohort, summarize } from '../smartmoney.js';
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
  const smartBox = h('div.smart-box');
  const sourceTag = h('span.source-tag');

  root.replaceChildren(
    h('button.back', { onclick: () => go('whales') }, '← All pairs'),
    h('section.panel', h('div.token-top', head, h('div.toolbar-right', h('button.btn.ghost', { onclick: () => go('liqmap', symbol) }, 'Liquidation map →'), starBtn))),
    h('section.panel', h('div.toolbar', h('div.title-row', h('h2', 'Chart'), sourceTag), intervalBar), layerBar, chartBox),
    h('section.panel', h('h2', 'Smart money positions'), smartBox),
    h('div.split',
      h('section.panel.grow', h('h2', 'Setup check'), h('p.note', 'Four questions to ask before trusting a move, answered from the last 12 candles.'), checks),
      h('aside.panel.side', h('h2', 'Right now'), facts),
    ),
    h('div.split',
      h('section.panel.grow', h('h2', 'Biggest whale moves'), h('p.note', 'Largest changes in whale net exposure in this window. Changes caused by traders joining or leaving the whale group are left out.'), moves),
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
      const [raw, smartHist] = await Promise.all([
        getChartData(symbol, interval, 300),
        getSmartHistory(symbol).catch((e) => ({ error: e.message })),
      ]);
      if (!alive) return;
      if (raw.bars.length < 20) {
        chartBox.replaceChildren(h('p.empty', 'Not enough history for this pair yet.'));
        return;
      }
      const market = marketLayers(raw.bars);
      const whales = whaleLayers(raw.bars);
      const levels = liquidationLevels(raw.bars, market).active;
      data = { ...raw, market, whales, levels, entries: whaleEntries(raw.bars, whales), exact: null, smartError: smartHist?.error ?? null };
      // Exact whale data: per-candle moves/opens from consecutive Smart Money snapshots.
      const snaps = smartHist?.snapshots;
      if (snaps?.length) {
        // Positions as of Binance's last update, valued at today's price.
        const last = { ...snaps.at(-1), mark: smartHist.mark || raw.bars.at(-1).c };
        const cohort = pickCohort(last);
        const aligned = alignToBars(snaps, raw.bars, CHART_INTERVALS[interval]);
        if (cohort && aligned.some((a) => a.net != null)) {
          data.exact = { source: smartHist.source, aligned, latest: summarize(last, cohort, last.oiUsd), whale: summarize(last, 'whale', last.oiUsd), smart: summarize(last, 'smart', last.oiUsd), t: last.t, firstT: snaps[0].t };
        }
      }
      renderChart();
      renderSmart();
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
    const { bars, market, whales, entries, exact } = data;
    const panes = [];
    const ex = exact?.aligned;
    const est = ex ? '' : ' (est.)';
    sourceTag.textContent = ex ? (exact.source === 'demo' ? 'Whale layers: exact (simulated)' : 'Whale layers: exact') : 'Whale layers: estimated';
    sourceTag.dataset.state = ex ? 'exact' : 'est';
    const add = (id, pane) => layers.has(id) && panes.push(pane);
    const hasWhales = whales.some((w) => w.longUsd != null);
    add('gap', {
      id: 'gap', label: 'Whales vs crowd', kind: 'share', format: share,
      series: ex
        ? [
            { name: exact.latest.cohort === 'smart' ? 'Smart money' : 'Whales', values: ex.map((a) => a.longShare), color: '--whale', width: 2 },
            { name: 'Top-trader ratio', values: bars.map((b) => b.whaleLong ?? b.smartLong), color: '--muted', width: 1 },
            { name: 'Crowd', values: bars.map((b) => b.crowdLong), color: '--crowd' },
          ]
        : [
            { name: 'Whales', values: bars.map((b) => b.whaleLong ?? b.smartLong), color: '--whale', width: 2 },
            { name: 'Crowd', values: bars.map((b) => b.crowdLong), color: '--crowd' },
          ],
    });
    if (hasWhales || ex) {
      const src = ex
        ? ex.map((a) => ({ shift: a.move, opensLong: a.opensLong, opensShort: a.opensShort == null ? null : a.opensShort, net: a.net, rosterChange: a.roster }))
        : whales;
      add('shift', {
        id: 'shift', label: `Whale moves${est}`, kind: 'hist', format: usd,
        emptyText: ex ? "No changes yet: moves appear when Binance next updates its Smart Money data" : null,
        series: [
          { values: src.map((w) => w.shift), color: '--long', colorDown: '--short' },
          { kind: 'dots', values: src.map((w) => w.rosterChange), color: '--muted' },
        ],
      });
      add('opens', {
        id: 'opens', label: `Whale opens${est}`, kind: 'hist', format: usd,
        emptyText: ex ? 'No new positions yet: opens appear at the next Binance update' : null,
        series: [
          { name: 'Long', values: src.map((w) => w.opensLong), color: '--long' },
          { name: 'Short', values: src.map((w) => (w.opensShort == null ? null : -w.opensShort)), color: '--short', colorDown: '--short' },
        ],
      });
      add('net', { id: 'net', label: `Whale net position${est}`, kind: 'step', format: usd, series: [{ values: src.map((w) => w.net), color: '--long', colorDown: '--short', width: 2 }] });
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
    if (layers.has('entries') && ex) {
      const who = exact.latest.cohort === 'smart' ? 'Smart money' : 'Whale';
      if (exact.latest.longEntry) levels.push({ price: exact.latest.longEntry, label: `${who} long entry`, color: '--long' });
      if (exact.latest.shortEntry) levels.push({ price: exact.latest.shortEntry, label: `${who} short entry`, color: '--short' });
    } else if (layers.has('entries') && hasWhales) {
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
    const ex = data.exact;
    const whalesForCheck = ex
      ? ex.aligned.map((a, i) => ({ ...data.whales[i], longUsd: a.net == null ? null : 1, opensLong: a.opensLong ?? 0, opensShort: a.opensShort ?? 0 }))
      : data.whales;
    const items = setupCheck(data.bars, data.market, whalesForCheck, {
      levels: data.levels,
      entries: ex ? { long: ex.latest.longEntry, short: ex.latest.shortEntry } : null,
      whaleShare: ex ? ex.latest.longShare : null,
    });
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
      ...(data.exact?.latest?.longShare != null
        ? [h('div.fact', h('span.fact-label', `${data.exact.latest.cohort === 'smart' ? 'Smart money' : 'Whales'} (Binance Smart Money, by size)`), shareBar(data.exact.latest.longShare, 'Whales'))]
        : []),
      h('div.fact', h('span.fact-label', data.exact ? 'Top traders (public ratio, by position)' : 'Whales (top traders, by position)'), shareBar(w ?? 0.5, 'Top traders')),
      h('div.fact', h('span.fact-label', 'Top accounts'), shareBar(last.smartLong ?? 0.5, 'Top accounts')),
      h('div.fact', h('span.fact-label', 'Crowd'), shareBar(last.crowdLong ?? 0.5, 'Crowd')),
      row('Open interest', last.oi != null ? fmtUsd(last.oi * last.c) : '–'),
      row('CVD, last 24 candles', usd(m.at(-1).cvd - m.at(-25).cvd), signClass(m.at(-1).cvd - m.at(-25).cvd)),
      ...(data.exact
        ? [
            row('Whale long entry', data.exact.latest.longEntry ? fmtPrice(data.exact.latest.longEntry) : '–'),
            row('Whale short entry', data.exact.latest.shortEntry ? fmtPrice(data.exact.latest.shortEntry) : '–'),
          ]
        : [
            row('Whale long entry est.', entries.long ? fmtPrice(entries.long) : '–'),
            row('Whale short entry est.', entries.short ? fmtPrice(entries.short) : '–'),
          ]),
      row('Liquidation events, 24 candles', String(recentLiq.length)),
      data.listedAt && row('Listed on Binance futures', new Date(data.listedAt).toLocaleDateString()),
    );
  }

  function renderMoves() {
    const { bars } = data;
    const whales = data.exact
      ? data.exact.aligned.map((a) => ({ t: a.t, shift: a.move ?? 0, opensLong: a.opensLong ?? 0, opensShort: a.opensShort ?? 0, rosterChange: a.roster }))
      : data.whales;
    const big = whales.map((w, i) => ({ ...w, price: bars[i].c })).filter((w) => (data.exact || !w.rosterChange) && w.shift)
      .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift)).slice(0, 8).sort((a, b) => b.t - a.t);
    if (!big.length) {
      moves.replaceChildren(h('p.empty', data.exact ? 'No whale moves recorded in this window yet.' : 'No whale data for this pair.'));
      return;
    }
    moves.replaceChildren(h('ol.move-list', ...big.map((b) =>
      h('li',
        h(`span.move-dir.${b.shift > 0 ? 'up' : 'down'}`, b.shift > 0 ? 'Toward long' : 'Toward short'),
        h('span.move-size', `${b.shift > 0 ? '+' : ''}${usd(b.shift)}${b.opensLong || b.opensShort ? ` · opened ${b.opensLong >= b.opensShort ? 'longs ' + usd(b.opensLong) : 'shorts ' + usd(b.opensShort)}` : ' · closing only'}`),
        h('span.move-meta', `at ${fmtPrice(b.price)} · ${new Date(b.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`),
      ))));
  }

  function renderSmart() {
    const ex = data.exact;
    if (!ex) {
      smartBox.replaceChildren(h('p.note', data.smartError
        ? `Your whale data server couldn't be reached (${data.smartError}). Whale layers above are estimates.`
        : "No exact whale data for this pair. Whale layers above are estimated from Binance's top-trader ratio. To get exact positions, average entries and PnL, run the whale data server (worker/smartmoney.mjs) and connect it on the Whales page."));
      return;
    }
    const price = data.bars.at(-1).c;
    const pctFrom = (entry) => (entry ? `${(((price - entry) / entry) * 100).toFixed(1)}%` : '');
    const rows = [];
    const fmtQty = (q) => (q == null ? '–' : q >= 1000 ? q.toLocaleString('en-US', { maximumFractionDigits: 0 }) : q.toPrecision(4));
    for (const [key, name] of [['whale', 'Whales'], ['smart', 'All smart money']]) {
      const c = ex[key];
      if (!c || (c.longUsd === 0 && c.shortUsd === 0)) continue;
      for (const side of ['long', 'short']) {
        const S = side === 'long' ? 'long' : 'short';
        const upnl = c[`${S}Upnl`];
        const entry = c[`${S}Entry`];
        const count = c[`${S}Count`];
        const inProfit = c[`${S}ProfitCount`];
        const rate = c[`${S}WinRate`];
        rows.push(h(`tr.static${ex.latest.cohort === key ? '.shown' : ''}`,
          h('th', { scope: 'row' }, `${name} ${side}`),
          h('td.num', count ?? '–'),
          h('td.num', fmtQty(c[`${S}Qty`]), h('span.muted', ` ${ticker(symbol)}`)),
          h('td.num', fmtUsd(c[`${S}Usd`])),
          h('td.num', entry ? fmtPrice(entry) : '–', entry ? h('span.muted', ` ${pctFrom(entry)}`) : ''),
          h(`td.num.${signClass(upnl)}`, upnl == null ? '–' : fmtUsd(upnl, true)),
          h('td.num', rate == null ? '–' : `${Math.round(rate * 100)}%`, inProfit != null && count ? h('span.muted', ` ${inProfit}/${count}`) : ''),
        ));
      }
    }
    const fallback = ex.latest.cohort === 'smart';
    const ageH = (Date.now() - ex.t) / 3_600_000;
    const age = ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))} minutes ago` : ageH < 48 ? `${ageH.toFixed(1)} hours ago` : `${Math.round(ageH / 24)} days ago`;
    smartBox.replaceChildren(
      h('p.note', `${ex.source === 'demo' ? 'Simulated data (demo). ' : ''}Binance last recalculated these positions ${age} (${new Date(ex.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}). Value and unrealized PnL use the current price. "All smart money" includes the whales.${fallback ? ' Fewer than 10 whales hold this pair, so the chart uses all smart money.' : ''}`),
      h('div.table-wrap', h('table.grid.smart-table',
        h('thead', h('tr', ...['Group', 'Traders', 'Size', 'Value', 'Avg entry (vs price)', 'Unrealized PnL', 'In profit'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', ...rows),
      )),
      h('p.note', `Exact whale history on this server starts ${new Date(ex.firstT).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}. Whale moves appear on the chart at each Binance update after that.`),
    );
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
