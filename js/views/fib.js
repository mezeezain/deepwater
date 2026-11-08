// Fib pullbacks: coins that pumped recently and are in the first correction of that pump, with Fibonacci levels.
import { fetchRadar } from './trends.js';
import { RADAR_FRAMES } from '../trend-scan.js';
import { FIB } from '../fib.js';
import { h, fill, ticker, fmtPrice, fmtPct, fmtUsd, fmtAgo, store, riskNote } from '../util.js';

const SORTS = {
  recent: { label: 'Most recent high', key: (f) => f.sinceHigh, asc: true },
  pump: { label: 'Biggest pump', key: (f) => f.pumpPct },
  depth: { label: 'Deepest pullback', key: (f) => f.r },
  volume: { label: 'Volume 24h', key: (f) => f.volume24h ?? 0 },
};
const LEVEL_NAMES = { 0.382: '0.382', 0.5: '0.5', 0.618: '0.618 (golden)', 0.786: '0.786' };

export function fibView(root, { go }) {
  const saved = store.get('fib-view', {});
  const opts = {
    tf: RADAR_FRAMES[saved.tf] ? saved.tf : '4h',
    atOnly: !!saved.atOnly,
    sort: SORTS[saved.sort] ? saved.sort : 'recent',
  };
  let data = null;
  let busy = false;
  let alive = true;

  const status = h('p.note', 'Loading…');
  const sourceLine = h('div.source-banner');
  const frames = h('div.lenses', { role: 'group', 'aria-label': 'Timeframe' });
  const filters = h('div.toolbar-right');
  const tableWrap = h('div.table-wrap');
  const testedBox = h('div');

  fill(root,
    riskNote('A pullback can keep going: the low of the pump is the line that says the move failed. '),
    h('section.hero',
      h('div.hero-text',
        h('p.eyebrow', 'First correction after a pump · Fibonacci levels'),
        h('h1', 'Fib pullbacks'),
        h('p.lede', `Coins that pumped at least ${FIB.minPump}% in the last ${FIB.maxSinceHigh} candles without correcting on the way up, and are now in their first pullback. Only first corrections: once a coin makes a new high, or falls back past ${FIB.maxRetrace} of the move, it drops off the list.`),
      ),
    ),
    sourceLine,
    h('section.panel',
      h('div.toolbar', h('div.toolbar-left', frames), filters),
      status,
      tableWrap,
      h('p.note', `Retracement 0 = the pump’s high, 1 = back at its low. “At level” = within ${Math.round(FIB.tol * 100)}% of the move from a Fibonacci level. Click a row for the chart.`)),
    h('div.split',
      h('section.panel.grow', h('h2', 'Has it been tested?'), testedBox),
      h('section.panel.side', h('h2', 'How it is found'),
        h('ul.plain',
          h('li', h('strong', 'The pump: '), `the highest high of the last ${FIB.window} candles (made 1–${FIB.maxSinceHigh} candles ago) and the lowest low of the ${FIB.maxLeg} candles before it, at least ${FIB.minPump}% apart.`),
          h('li', h('strong', 'Clean: '), `on the way up it never gave back more than ${FIB.cleanMax} of the move so far, so this pullback is its first.`),
          h('li', h('strong', 'Now: '), `price is at least ${FIB.minRetrace} below the high, has not made a new high since, and has not gone below ${FIB.maxRetrace} of the move.`),
          h('li', h('strong', 'Levels: '), 'high − ratio × (high − low) for 0.382, 0.5, 0.618 and 0.786.')))),
  );

  const set = (patch, reload = false) => {
    Object.assign(opts, patch);
    store.set('fib-view', opts);
    if (reload) load();
    else render();
  };

  async function load() {
    if (busy) return;
    busy = true;
    data = null;
    render();
    try {
      data = await fetchRadar(opts.tf, (done, total) => { status.textContent = `Scanning in this browser… ${done}/${total} coins`; }, { needFib: true });
    } catch (e) {
      data = { error: e.message };
    }
    busy = false;
    if (alive) render();
  }

  function render() {
    fill(frames, ...Object.keys(RADAR_FRAMES).map((tf) =>
      h('button.lens', { type: 'button', 'aria-pressed': String(opts.tf === tf), onclick: () => set({ tf }, true) }, tf.toUpperCase())));
    fill(filters,
      h('label.check', h('input#fib-at', { type: 'checkbox', checked: opts.atOnly, onchange: (e) => set({ atOnly: e.target.checked }) }), 'Only at a level now'),
      h('label.field.inline', h('span', 'Sort'),
        h('select#fib-sort', { onchange: (e) => set({ sort: e.target.value }) },
          ...Object.entries(SORTS).map(([id, s]) => h('option', { value: id, selected: opts.sort === id }, s.label)))));
    if (!data) {
      fill(tableWrap);
      status.textContent = 'Loading…';
      return;
    }
    if (data.error) {
      fill(tableWrap, h('p.error', `Couldn’t load. ${data.error}`));
      status.textContent = '';
      return;
    }
    sourceLine.dataset.state = data.source === 'server' ? 'shared' : data.source === 'demo' ? 'demo' : 'local';
    fill(sourceLine, h('span', data.source === 'server'
      ? [h('strong', 'Server scan. '), `Every coin trading over ${fmtUsd(data.minVolume ?? 5e6)} a day, rechecked after each ${opts.tf} candle closes.`]
      : data.source === 'demo' ? [h('strong', 'Demo. '), 'Invented coins and candles, run through the real rules.']
        : [h('strong', 'This browser. '), 'The server isn’t reachable (or hasn’t been updated), so only the top 60 coins by volume were scanned here.']));
    renderTested();
    const all = data.fib ?? [];
    const s = SORTS[opts.sort];
    const rows = all.filter((f) => !opts.atOnly || f.atLevel != null).sort((a, b) => (s.asc ? s.key(a) - s.key(b) : s.key(b) - s.key(a)));
    const at = all.filter((f) => f.atLevel != null).length;
    status.textContent = `${all.length} of ${data.scanned} coins in a first pullback on ${opts.tf} (${at} at a Fibonacci level now) · checked ${fmtAgo(data.t)}`;
    const th = (label, title) => h('th', { scope: 'col', title: title || null }, label);
    fill(tableWrap, h('table.grid.fibs',
      h('thead', h('tr',
        th('Coin'), th('Pump', 'Low to high of the pump, and how many candles it took'), th('High', 'When the pump peaked'), th('Pulled back', 'Retracement now (0 = high, 1 = low)'),
        th('Where'), th('0.382'), th('0.5'), th('0.618'), th('0.786'), th('Pump low', 'Below this, the pump has failed'), th('Volume 24h'))),
      h('tbody', rows.length
        ? rows.map((f) => {
            const lv = (ratio) => {
              const l = f.levels.find((x) => x.ratio === ratio);
              if (!l) return h('td.num', '–');
              const cls = f.atLevel === ratio ? 'td.num.at-level' : l.price > f.price ? 'td.num.muted' : 'td.num';
              return h(cls, { title: `${fmtPct(l.pct)} from price` }, fmtPrice(l.price));
            };
            return h('tr', { tabIndex: 0, onclick: () => go('token', f.symbol), onkeydown: (e) => e.key === 'Enter' && go('token', f.symbol) },
              h('th.pair', { scope: 'row' }, h('span.pair-name', ticker(f.symbol)), f.demo && h('span.chip.aligned', 'Example')),
              h('td.num.up', `+${f.pumpPct.toFixed(0)}%`, h('span.muted', ` in ${f.legCandles}`)),
              h('td.num', { title: new Date(f.highT).toLocaleString() }, `${f.sinceHigh} candle${f.sinceHigh === 1 ? '' : 's'} ago`),
              h('td.num', depthBar(f), ` ${f.r.toFixed(2)}`),
              h('td', f.atLevel != null
                ? h('span.place.good', `At ${LEVEL_NAMES[f.atLevel] ?? f.atLevel}`)
                : h('span.place', f.r < FIB.levels[0] ? 'Above 0.382' : `Between levels`)),
              lv(0.382), lv(0.5), lv(0.618), lv(0.786),
              h('td.num.muted', fmtPrice(f.low)),
              h('td.num', f.volume24h == null ? '–' : fmtUsd(f.volume24h)));
          })
        : h('tr', h('td.empty', { colSpan: 11 }, all.length ? 'None at a level right now.' : `No coin is in a first pullback on ${opts.tf} right now.`)))));
  }

  function depthBar(f) {
    // A small bar: how far back from the high (left) toward the low (right), with the deepest point marked.
    const bar = h('span.depth', { 'aria-hidden': 'true' });
    bar.append(h('span.depth-now'));
    bar.firstChild.style.width = `${Math.min(100, f.r * 100)}%`;
    const deep = h('span.depth-deep');
    deep.style.left = `${Math.min(100, f.deepest * 100)}%`;
    bar.append(deep);
    return bar;
  }

  function renderTested() {
    const t = data.fibTested?.[opts.tf];
    if (!t) {
      fill(testedBox,
        h('p', 'Not measured yet. Whether Fibonacci levels hold better than any other depth is a question for the data.'),
        h('p.note', `On your server, run node tools/fib.mjs${opts.tf === '4h' ? '' : ' --tf 1h'}. It buys the first touch of each level in every first pullback (stop under the pump’s low, target its high) and compares Fibonacci levels with other depths. The result then shows here.`));
      return;
    }
    const g = t.groups || {};
    const line = (label, s) => s?.n
      ? h('tr', h('th', { scope: 'row' }, label), h('td.num', s.n), h(`td.num.${s.expR > 0 ? 'up' : 'down'}`, `${s.expR >= 0 ? '+' : ''}${s.expR.toFixed(2)}R`), h('td.num', `${Math.round(s.target * 100)}%`), h('td.num', `${Math.round(s.stop * 100)}%`))
      : null;
    fill(testedBox,
      h('p', h('strong', t.verdict)),
      t.planVerdict && h('p', t.planVerdict),
      h('div.table-wrap', h('table.grid',
        h('thead', h('tr', h('th', ''), h('th', 'Touches'), h('th', 'Per trade'), h('th', 'Back to the high'), h('th', 'Stopped'))),
        h('tbody',
          line('All Fibonacci levels', g['All Fibonacci levels']),
          line('Other depths (control)', g['All other depths (control)']),
          ...['0.382', '0.500', '0.618', '0.786'].map((r) => line(`At ${r}`, g[`* ${r}`]))))),
      h('p.note', `Measured ${fmtAgo(t.t)} on ${t.pairs} coins, ${opts.tf} candles, 0.1% costs. R = the distance from entry to the pump’s low. Past behaviour, not a promise.`));
  }

  load();
  const timer = setInterval(() => { if (!document.hidden && !busy) load(); }, 5 * 60_000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
