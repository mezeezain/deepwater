// Whales vs crowd: who is long when everyone else is short, across the most traded pairs.
import { getMarket, getPositioning } from '../api.js';
import { sparkline } from '../chart.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, fmtShare, signClass, shareBar, sortRows, csv, copyText, toast, watchlist, store } from '../util.js';

const SCAN_LIMIT = 60; // pairs by volume; 4 requests each, well inside Binance's public limits

const LENSES = [
  { id: 'gap', label: 'Biggest gap', sort: (r) => r.gap, dir: -1, hint: 'Whales and the crowd disagree the most' },
  { id: 'wlong', label: 'Whales most long', sort: (r) => r.whaleLong, dir: -1 },
  { id: 'wshort', label: 'Whales most short', sort: (r) => r.whaleLong, dir: 1 },
  { id: 'shift', label: 'Biggest whale shift 24h', sort: (r) => Math.abs(r.shift24h), dir: -1 },
  { id: 'contra', label: 'Contrarian setups', filter: (r) => r.signal === 'contrarian', sort: (r) => r.gap, dir: -1, hint: 'Whales on the opposite side of a lopsided crowd' },
  { id: 'watch', label: 'Watchlist', filter: (r) => watchlist.has(r.symbol), sort: (r) => r.quoteVolume, dir: -1 },
];

const COLUMNS = [
  { key: 'symbol', label: 'Pair', get: (r) => r.symbol },
  { key: 'whaleLong', label: 'Whales long', get: (r) => fmtShare(r.whaleLong) },
  { key: 'crowdLong', label: 'Crowd long', get: (r) => fmtShare(r.crowdLong) },
  { key: 'gap', label: 'Gap', get: (r) => Math.round(r.gap) },
  { key: 'smartLong', label: 'Top accounts long', get: (r) => fmtShare(r.smartLong) },
  { key: 'shift24h', label: 'Whale shift 24h', get: (r) => Math.round(r.shift24h) },
  { key: 'oiChange', label: 'Open interest 24h', get: (r) => fmtPct(r.oiChange) },
  { key: 'funding', label: 'Funding', get: (r) => (r.funding == null ? '' : (r.funding * 100).toFixed(4) + '%') },
  { key: 'price', label: 'Price', get: (r) => r.price },
  { key: 'change24h', label: '24h', get: (r) => fmtPct(r.change24h) },
];

function classify(r) {
  const crowdLopsided = Math.abs(r.crowdLong - 0.5) > 0.15;
  const opposite = (r.whaleLong - 0.5) * (r.crowdLong - 0.5) < 0;
  if (crowdLopsided && opposite && r.gap >= 40) return 'contrarian';
  if (Math.abs(r.shift24h) >= 20) return 'shifting';
  if (!opposite && Math.abs(r.whaleLong - 0.5) > 0.2) return 'aligned';
  return null;
}

const SIGNAL_TEXT = {
  contrarian: ['Contrarian', 'Whales are on the other side of a lopsided crowd'],
  shifting: ['Shifting', 'Whale long share moved 20+ points in 24h'],
  aligned: ['Aligned', 'Whales and crowd lean the same way'],
};

export function whalesView(root, { go }) {
  let rows = [];
  let lens = store.get('lens', 'gap');
  let sort = null; // { key, dir } when a column header was clicked
  let query = '';
  let showAll = false;
  let loaded = 0;
  let total = 0;
  let alive = true;

  const summary = h('div.summary');
  const lensBar = h('div.lenses', { role: 'tablist', 'aria-label': 'Ranking' });
  const search = h('input#whale-search.search', {
    type: 'search',
    placeholder: 'Filter pairs, e.g. SOL',
    'aria-label': 'Filter pairs',
    oninput: (e) => {
      query = e.target.value.trim().toUpperCase();
      render();
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && query) go('token', (query.endsWith('USDT') ? query : query + 'USDT'));
    },
  });
  const progress = h('div.progress', h('span'));
  const tableWrap = h('div.table-wrap');
  const more = h('button.btn.ghost', { onclick: () => ((showAll = !showAll), render()) });
  const exportBtn = h('button.btn.ghost', { onclick: exportCsv }, 'Copy as CSV');

  root.replaceChildren(
    h('section.hero',
      h('div.hero-text',
        h('p.eyebrow', 'Binance USDⓈ-M perpetuals · top traders vs all accounts'),
        h('h1', 'Where the big money leans'),
        h('p.lede', 'Compare how the largest traders are positioned with everyone else on the same pair. A wide gap means the two groups disagree.'),
      ),
      summary,
    ),
    h('section.panel',
      h('div.toolbar', lensBar, h('div.toolbar-right', search, exportBtn)),
      progress,
      tableWrap,
      h('div.table-foot', more,
        h('p.note', 'Whales: top traders ranked by position size. Top accounts: top traders ranked by account. Crowd: all accounts on the pair. Shows positioning, not a forecast.')),
    ),
  );

  function renderLenses() {
    lensBar.replaceChildren(
      ...LENSES.map((l) =>
        h('button.lens', {
          role: 'tab',
          'aria-selected': String(l.id === lens && !sort),
          title: l.hint || '',
          onclick: () => {
            lens = l.id;
            sort = null;
            store.set('lens', lens);
            render();
          },
        }, l.label),
      ),
    );
  }

  function currentRows() {
    const l = LENSES.find((x) => x.id === lens) || LENSES[0];
    let out = rows;
    if (l.filter) out = out.filter(l.filter);
    if (query) out = out.filter((r) => r.symbol.includes(query));
    return sort ? sortRows(out, sort.key, sort.dir) : sortRows(out, l.sort, l.dir);
  }

  function render() {
    if (!alive) return;
    renderLenses();
    renderSummary();
    const list = currentRows();
    const visible = showAll ? list : list.slice(0, 20);
    more.hidden = list.length <= 20;
    more.textContent = showAll ? 'Show top 20' : `Show all ${list.length}`;

    const th = (key, label, title) =>
      h('th', {
        scope: 'col',
        title: title || '',
        'aria-sort': sort?.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none',
      },
      h('button.th-btn', {
        onclick: () => {
          sort = { key, dir: sort?.key === key ? -sort.dir : key === 'symbol' ? 1 : -1 };
          render();
        },
      }, label, sort?.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''));

    const table = h('table.grid',
      h('thead', h('tr',
        h('th', { scope: 'col' }, h('span.sr', 'Watch')),
        th('symbol', 'Pair'),
        th('whaleLong', 'Whales long', 'Long share of positions held by top traders'),
        th('crowdLong', 'Crowd long', 'Share of all accounts that are long'),
        th('gap', 'Gap', 'Points between whale and crowd long share'),
        th('smartLong', 'Top accts', 'Long share of top trader accounts'),
        th('shift24h', 'Whale 24h', 'Change in whale long share over 24 hours, in points'),
        h('th', { scope: 'col' }, 'Trend'),
        th('oiChange', 'OI 24h', 'Change in open interest value over 24 hours'),
        th('funding', 'Funding'),
        th('price', 'Price'),
        th('change24h', '24h'),
      )),
      h('tbody', visible.length ? visible.map(rowEl) : h('tr', h('td.empty', { colSpan: 12 }, emptyText()))),
    );
    tableWrap.replaceChildren(table);
  }

  function emptyText() {
    if (loaded < total) return 'Loading positioning data…';
    if (lens === 'watch') return 'Your watchlist is empty. Star a pair to add it.';
    if (lens === 'contra') return 'No contrarian setups right now. Try another ranking.';
    return 'No pairs match that filter.';
  }

  function rowEl(r) {
    const starred = watchlist.has(r.symbol);
    const sig = r.signal && SIGNAL_TEXT[r.signal];
    return h('tr', { tabIndex: 0, onclick: () => go('token', r.symbol), onkeydown: (e) => e.key === 'Enter' && go('token', r.symbol) },
      h('td', h('button.star', {
        'aria-label': starred ? `Remove ${ticker(r.symbol)} from watchlist` : `Add ${ticker(r.symbol)} to watchlist`,
        'aria-pressed': String(starred),
        onclick: (e) => {
          e.stopPropagation();
          watchlist.toggle(r.symbol);
          render();
        },
      }, starred ? '★' : '☆')),
      h('th.pair', { scope: 'row' }, h('span.pair-name', ticker(r.symbol)), sig && h(`span.chip.${r.signal}`, { title: sig[1] }, sig[0])),
      h('td', shareBar(r.whaleLong, 'Whales')),
      h('td', shareBar(r.crowdLong, 'Crowd')),
      h('td.num.gap', { style: { '--gap': Math.min(1, r.gap / 90) } }, Math.round(r.gap)),
      h('td.num', fmtShare(r.smartLong)),
      h(`td.num.${signClass(r.shift24h)}`, `${r.shift24h > 0 ? '+' : ''}${Math.round(r.shift24h)}`),
      h('td', sparkline(r.trend, { colorVar: '--whale' })),
      h(`td.num.${signClass(r.oiChange)}`, fmtPct(r.oiChange)),
      h(`td.num.${signClass(r.funding)}`, r.funding == null ? '–' : (r.funding * 100).toFixed(4) + '%'),
      h('td.num', fmtPrice(r.price)),
      h(`td.num.${signClass(r.change24h)}`, fmtPct(r.change24h)),
    );
  }

  function renderSummary() {
    if (!rows.length) {
      summary.replaceChildren(h('div.stat', h('span.stat-label', 'Scanning'), h('span.stat-value', '…')));
      return;
    }
    const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
    const whale = avg((r) => r.whaleLong);
    const crowd = avg((r) => r.crowdLong);
    const contra = rows.filter((r) => r.signal === 'contrarian').length;
    summary.replaceChildren(
      h('div.stat', h('span.stat-label', 'Whales long, average'), h('span.stat-value', fmtShare(whale)), shareBar(whale, 'Whales')),
      h('div.stat', h('span.stat-label', 'Crowd long, average'), h('span.stat-value', fmtShare(crowd)), shareBar(crowd, 'Crowd')),
      h('div.stat', h('span.stat-label', 'Contrarian setups'), h('span.stat-value', contra), h('span.stat-sub', `of ${rows.length} pairs scanned`)),
    );
  }

  async function exportCsv() {
    const text = csv(currentRows(), COLUMNS);
    if (await copyText(text)) toast(`Copied ${currentRows().length} rows as CSV`);
    else toast('Your browser blocked the clipboard. Select the table and copy it instead.');
  }

  async function load() {
    const market = await getMarket();
    const top = market.slice(0, SCAN_LIMIT);
    // Always include starred pairs, even if they are outside the top by volume.
    for (const s of watchlist.all()) {
      const m = market.find((x) => x.symbol === s);
      if (m && !top.includes(m)) top.push(m);
    }
    total = top.length;
    loaded = 0;
    const byBatch = [];
    await Promise.all(
      top.map(async (m) => {
        try {
          const p = await getPositioning(m.symbol);
          if (!p.whales.length || !p.crowd.length) return;
          const now = p.whales.at(-1).long;
          const then = p.whales[0].long;
          const crowdLong = p.crowd.at(-1).long;
          const oiNow = p.oi.at(-1)?.value;
          const oiThen = p.oi[0]?.value;
          const r = {
            ...m,
            whaleLong: now,
            crowdLong,
            smartLong: p.smart.at(-1)?.long ?? null,
            gap: Math.abs(now - crowdLong) * 100,
            shift24h: (now - then) * 100,
            oiChange: oiThen ? ((oiNow - oiThen) / oiThen) * 100 : null,
            trend: p.whales.map((x) => x.long),
          };
          r.signal = classify(r);
          byBatch.push(r);
        } catch {
          // A pair without positioning data (new listing) is skipped.
        } finally {
          loaded++;
          progress.firstChild.style.width = `${(loaded / total) * 100}%`;
          progress.hidden = loaded >= total;
          if (loaded % 8 === 0 || loaded === total) {
            rows = [...byBatch];
            render();
          }
        }
      }),
    );
  }

  render();
  load().catch((err) => {
    tableWrap.replaceChildren(h('p.error', `Couldn't load market data. ${err.message}`));
  });
  const timer = setInterval(() => load().catch(() => {}), 5 * 60_000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
