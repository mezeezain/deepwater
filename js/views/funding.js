// Funding rates for every pair, with yearly equivalent and time to the next payment.
import { getMarket } from '../api.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, fmtCountdown, signClass, sortRows } from '../util.js';

export function fundingView(root, { go }) {
  let rows = [];
  let sort = { key: 'abs', dir: -1 };
  let query = '';
  let minVol = 10e6;

  const summary = h('div.summary');
  const tableWrap = h('div.table-wrap');

  root.replaceChildren(
    h('section.hero.compact',
      h('div.hero-text',
        h('p.eyebrow', 'Paid every 8 hours on most pairs'),
        h('h1', 'Funding rates'),
        h('p.lede', 'Positive funding means longs pay shorts, so the market is crowded long. Extreme rates often come before squeezes.'),
      ),
      summary,
    ),
    h('section.panel',
      h('div.toolbar',
        h('input#funding-search.search', { type: 'search', placeholder: 'Filter pairs', 'aria-label': 'Filter pairs', oninput: (e) => { query = e.target.value.trim().toUpperCase(); render(); } }),
        h('label.field.inline', h('span', 'Min 24h volume'),
          h('select#funding-vol', { onchange: (e) => { minVol = +e.target.value; render(); } },
            h('option', { value: 0 }, 'Any'),
            h('option', { value: 10e6, selected: true }, '$10M'),
            h('option', { value: 100e6 }, '$100M'),
            h('option', { value: 1e9 }, '$1B'))),
      ),
      tableWrap,
    ),
  );

  function render() {
    const list = sortRows(
      rows.filter((r) => r.quoteVolume >= minVol && (!query || r.symbol.includes(query))),
      sort.key === 'abs' ? (r) => Math.abs(r.funding) : sort.key, sort.dir);
    const th = (key, label) => h('th', { scope: 'col', 'aria-sort': sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button.th-btn', { onclick: () => { sort = { key, dir: sort.key === key ? -sort.dir : -1 }; render(); } }, label, sort.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''));
    const maxAbs = Math.max(...list.map((r) => Math.abs(r.funding)), 1e-6);
    tableWrap.replaceChildren(h('table.grid',
      h('thead', h('tr', th('symbol', 'Pair'), th('funding', 'Rate / 8h'), h('th', { scope: 'col' }, 'Pressure'), th('apr', 'Per year'), th('nextFundingTime', 'Next'), th('price', 'Price'), th('change24h', '24h'), th('quoteVolume', 'Volume'))),
      h('tbody', list.slice(0, 150).map((r) => h('tr', { tabIndex: 0, onclick: () => go('token', r.symbol), onkeydown: (e) => e.key === 'Enter' && go('token', r.symbol) },
        h('th.pair', { scope: 'row' }, h('span.pair-name', ticker(r.symbol))),
        h(`td.num.${signClass(r.funding)}`, (r.funding * 100).toFixed(4) + '%'),
        h('td', h('div.pressure', h(`span.${r.funding >= 0 ? 'up' : 'down'}`, { style: { '--w': Math.abs(r.funding) / maxAbs } }))),
        h(`td.num.${signClass(r.apr)}`, fmtPct(r.apr, 1)),
        h('td.num', r.nextFundingTime ? fmtCountdown(r.nextFundingTime - Date.now()) : '–'),
        h('td.num', fmtPrice(r.price)),
        h(`td.num.${signClass(r.change24h)}`, fmtPct(r.change24h)),
        h('td.num', fmtUsd(r.quoteVolume)),
      ))),
    ));
    const pos = rows.filter((r) => r.funding > 0).length;
    summary.replaceChildren(
      h('div.stat', h('span.stat-label', 'Pairs paying longs → shorts'), h('span.stat-value', `${Math.round((pos / (rows.length || 1)) * 100)}%`), h('span.stat-sub', `${pos} of ${rows.length}`)),
      h('div.stat', h('span.stat-label', 'Highest rate'), h('span.stat-value', rows.length ? ticker(sortRows(rows, 'funding', -1)[0].symbol) : '–')),
      h('div.stat', h('span.stat-label', 'Most negative'), h('span.stat-value', rows.length ? ticker(sortRows(rows, 'funding', 1)[0].symbol) : '–')),
    );
  }

  async function load() {
    rows = (await getMarket()).filter((r) => r.funding != null).map((r) => ({ ...r, apr: r.funding * 3 * 365 * 100 }));
    render();
  }
  load().catch((e) => tableWrap.replaceChildren(h('p.error', e.message)));
  const timer = setInterval(() => load().catch(() => {}), 60_000);
  return () => clearInterval(timer);
}
