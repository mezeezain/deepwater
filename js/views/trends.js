// Trend radar: coins whose trend started recently, with the nearest support and resistance.
import { get, isDemo, whaleServer } from '../api.js';
import { scanTrends, demoTrends, validRadarRow, RADAR_FRAMES } from '../trend-scan.js';
import { createDemoMarket } from '../demo-market.js';
import { TREND } from '../trend.js';
import { h, fill, ticker, fmtPrice, fmtPct, fmtUsd, fmtAgo, store, riskNote } from '../util.js';

const LOCAL_TOP = 60; // coins scanned in the browser when the server isn't reachable
const SORTS = {
  age: { label: 'Newest trend', key: (r) => r.age, asc: true },
  adx: { label: 'Strongest (ADX)', key: (r) => r.adx },
  move: { label: 'Biggest move', key: (r) => Math.abs(r.movePct) },
  volume: { label: 'Volume 24h', key: (r) => r.volume24h ?? 0 },
};
const PLACES = {
  all: 'Anywhere',
  room: 'Room to run',
  pullback: 'Pulled back to a level',
  pressing: 'Pressing into a level',
};

/** The level a trend runs into is "ahead"; the one behind it is where a pullback would land. */
export function placeOf(r) {
  if (r.zone === 'open' || r.zone === 'clear') return 'room';
  const behind = r.side > 0 ? 'support' : 'resistance';
  return r.zone === behind ? 'pullback' : 'pressing';
}

const placeText = (r) => {
  const up = r.side > 0;
  switch (r.zone) {
    case 'open': return up ? 'Above every level' : 'Below every level';
    case 'clear': return 'Room to run';
    case 'support': return up ? 'Near support (pullback)' : 'At support';
    case 'resistance': return up ? 'At resistance' : 'Near resistance (pullback)';
    default: return r.zone;
  }
};
const placeClass = (r) => ({ room: 'good', pullback: 'good', pressing: 'warn' })[placeOf(r)];

export function trendsView(root, { go }) {
  const saved = store.get('radar', {});
  const opts = {
    tf: RADAR_FRAMES[saved.tf] ? saved.tf : '4h',
    dir: ['all', 'up', 'down'].includes(saved.dir) ? saved.dir : 'all',
    place: PLACES[saved.place] ? saved.place : 'all',
    hideStretched: !!saved.hideStretched,
    sort: SORTS[saved.sort] ? saved.sort : 'age',
  };
  let alive = true;
  let data = null; // { t, tf, scanned, rows, source, tested }
  let busy = false;

  const status = h('p.note', 'Loading…');
  const sourceLine = h('div.source-banner');
  const frames = h('div.lenses', { role: 'group', 'aria-label': 'Timeframe' });
  const dirs = h('div.lenses', { role: 'group', 'aria-label': 'Direction' });
  const filters = h('div.toolbar-right');
  const tableWrap = h('div.table-wrap');
  const testedBox = h('div');

  fill(root,
    riskNote('A fresh trend is a description of what price has done, not a forecast. '),
    h('section.hero',
      h('div.hero-text',
        h('p.eyebrow', 'Fresh trends · support and resistance'),
        h('h1', 'Trend radar'),
        h('p.lede', `Coins whose trend started in the last ${TREND.maxAge} candles: EMA 20 crossed EMA 50, price broke out of its previous 20-candle range, and ADX is rising. Each row shows the nearest support and resistance and whether price has room to run or is pressing into a level.`),
      ),
    ),
    sourceLine,
    h('section.panel',
      h('div.toolbar', h('div.toolbar-left', frames, dirs), filters),
      status,
      tableWrap,
      h('p.note', 'Click a row for its chart. Levels are swing highs and lows of the last 200 candles, merged into zones; “near” means within 1 ATR (a normal candle’s range).')),
    h('div.split',
      h('section.panel.grow', h('h2', 'Has it been tested?'), testedBox),
      h('section.panel.side', h('h2', 'How to read it'),
        h('ul.plain',
          h('li', h('strong', 'Started: '), 'candles since the trend began (the later of the EMA cross and the breakout).'),
          h('li', h('strong', 'Move: '), 'price change since then. A big move in few candles is often already priced in.'),
          h('li', h('strong', 'ADX: '), 'trend strength; it lags, so a young trend often shows a low but rising value.'),
          h('li', h('strong', 'From EMA 20: '), `distance in ATRs. Over ${TREND.extendedAtr} is “stretched”: price tends to pause or pull back before going further.`),
          h('li', h('strong', 'Where: '), '“Room to run” and “pullback to a level” are the classic places to look; “pressing into a level” means the trend is meeting a ceiling (or floor) right now.')))),
  );

  const persist = () => store.set('radar', opts);
  const set = (patch, reload = false) => {
    Object.assign(opts, patch);
    persist();
    if (reload) load();
    else render();
  };

  async function load() {
    if (busy) return;
    busy = true;
    data = null;
    render();
    try {
      data = await fetchRadar(opts.tf, (done, total) => {
        status.textContent = `Scanning in this browser… ${done}/${total} coins`;
      });
    } catch (e) {
      data = { error: e.message };
    }
    busy = false;
    if (alive) render();
  }

  function render() {
    fill(frames, ...Object.keys(RADAR_FRAMES).map((tf) =>
      h('button.lens', { type: 'button', 'aria-pressed': String(opts.tf === tf), onclick: () => set({ tf }, true) }, tf.toUpperCase())));
    fill(dirs, ...[['all', 'All'], ['up', '▲ Up'], ['down', '▼ Down']].map(([id, label]) =>
      h('button.lens', { type: 'button', 'aria-pressed': String(opts.dir === id), onclick: () => set({ dir: id }) }, label)));
    fill(filters,
      h('label.field.inline', h('span', 'Where'),
        h('select#radar-place', { onchange: (e) => set({ place: e.target.value }) },
          ...Object.entries(PLACES).map(([id, label]) => h('option', { value: id, selected: opts.place === id }, label)))),
      h('label.check', h('input#radar-stretched', { type: 'checkbox', checked: opts.hideStretched, onchange: (e) => set({ hideStretched: e.target.checked }) }), 'Hide stretched'),
      h('label.field.inline', h('span', 'Sort'),
        h('select#radar-sort', { onchange: (e) => set({ sort: e.target.value }) },
          ...Object.entries(SORTS).map(([id, s]) => h('option', { value: id, selected: opts.sort === id }, s.label)))),
    );
    if (!data) {
      fill(tableWrap);
      status.textContent = 'Loading…';
      return;
    }
    if (data.error) {
      fill(tableWrap, h('p.error', `Couldn’t load the radar. ${data.error}`));
      status.textContent = '';
      return;
    }
    renderSource();
    renderTested();
    let rows = data.rows.filter((r) => (opts.dir === 'all' || (opts.dir === 'up') === (r.side > 0)) && (opts.place === 'all' || placeOf(r) === opts.place) && !(opts.hideStretched && r.stretched));
    const s = SORTS[opts.sort];
    rows = rows.sort((a, b) => (s.asc ? s.key(a) - s.key(b) : s.key(b) - s.key(a)));
    const ups = data.rows.filter((r) => r.side > 0).length;
    status.textContent = `${data.rows.length} of ${data.scanned} coins in a fresh ${opts.tf} trend (${ups} up, ${data.rows.length - ups} down) · checked ${fmtAgo(data.t)}${rows.length !== data.rows.length ? ` · ${rows.length} shown` : ''}`;
    const th = (label, title) => h('th', { scope: 'col', title: title || null }, label);
    const lvCell = (l) => (l ? h('td.num', fmtPrice(l.price), h('span.muted', ` ${fmtPct(l.pct)}`)) : h('td.num.muted', 'none'));
    fill(tableWrap, h('table.grid.radar',
      h('thead', h('tr',
        th('Coin'), th('Trend'), th('Started', 'Candles since the trend began'), th('Move', 'Price change since the trend began'),
        th('ADX'), th('From EMA 20', 'Distance from EMA 20 in ATRs'), th('Support'), th('Resistance'), th('Where'), th('Volume 24h'))),
      h('tbody', rows.length
        ? rows.map((r) => h('tr', { tabIndex: 0, onclick: () => go('token', r.symbol), onkeydown: (e) => e.key === 'Enter' && go('token', r.symbol) },
            h('th.pair', { scope: 'row' }, h('span.pair-name', ticker(r.symbol)), r.demo && h('span.chip.aligned', 'Example')),
            h('td', h(`span.trend-chip.${r.side > 0 ? 'up' : 'down'}`, r.side > 0 ? '▲ Up' : '▼ Down')),
            h('td.num', { title: new Date(r.startT).toLocaleString() }, `${r.age} candle${r.age === 1 ? '' : 's'}`, h('span.muted', ` · ${fmtAgo(r.startT)}`)),
            h(`td.num.${r.movePct * r.side > 0 ? 'up' : 'down'}`, fmtPct(r.movePct)),
            h('td.num', r.adx.toFixed(0)),
            h('td.num', `${r.extension.toFixed(1)} ATR`, r.stretched && h('span.chip.contrarian', 'stretched')),
            lvCell(r.support),
            lvCell(r.resistance),
            h('td', h(`span.place.${placeClass(r)}`, placeText(r))),
            h('td.num', r.volume24h == null ? '–' : fmtUsd(r.volume24h))))
        : h('tr', h('td.empty', { colSpan: 10 }, data.rows.length ? 'No coins match these filters.' : `No coin is in a fresh ${opts.tf} trend right now.`)))));
  }

  function renderSource() {
    const st = data.source;
    sourceLine.dataset.state = st === 'server' ? 'shared' : st === 'demo' ? 'demo' : 'local';
    fill(sourceLine, h('span', st === 'server'
      ? [h('strong', 'Server scan. '), `Every coin trading over ${fmtUsd(data.minVolume ?? 5e6)} a day, rechecked after each ${opts.tf} candle closes.`]
      : st === 'demo'
        ? [h('strong', 'Demo. '), 'Invented coins and candles, run through the real rules.']
        : [h('strong', 'This browser. '), `The server isn’t reachable, so only the top ${LOCAL_TOP} coins by volume were scanned here.`]));
  }

  function renderTested() {
    const t = data.tested?.[opts.tf];
    if (!t) {
      fill(testedBox,
        h('p', 'Not measured yet. The rules are standard trend-following ones, but whether coins on this radar actually kept going is a question for the data, not for the rules.'),
        h('p.note', `On your server, run node tools/trends.mjs${opts.tf === '4h' ? '' : ' --tf 1h'}. It replays the radar over the top 60 coins’ history and compares what happened next with trading any candle in the trend’s direction. The result then shows here.`));
      return;
    }
    const g = t.groups || {};
    const line = (label, s) => s?.n
      ? h('tr', h('th', { scope: 'row' }, label), h('td.num', s.n), h(`td.num.${s['12'].mean > 0 ? 'up' : 'down'}`, fmtPct(s['12'].mean, 2)), h('td.num', `${Math.round(s['12'].up * 100)}%`), h('td.num', `${Math.round(s.race * 100)}%`))
      : null;
    fill(testedBox,
      h('p', h('strong', t.verdict)),
      h('div.table-wrap', h('table.grid',
        h('thead', h('tr', h('th', ''), h('th', 'Cases'), h('th', '+12 candles'), h('th', 'Went right way'), h('th', '2:1 race'))),
        h('tbody',
          line('Radar (fresh trends)', g['Fresh trends (radar)']),
          line('Late trends', g['Late trends (same rules, older)']),
          line('Any candle, trend direction', g['Every candle, EMA direction']),
          line('Radar, room to run', g['open (no level ahead)']),
          line('Radar, near support', g['  near support']),
          line('Radar, near resistance', g['  near resistance'])))),
      h('p.note', `Measured ${fmtAgo(t.t)} on ${t.pairs} coins, ${opts.tf} candles, after 0.1% costs. 2:1 race: reached +2 ATR before −1 ATR (break-even 33%). Past behaviour, not a promise.`));
  }

  load();
  const timer = setInterval(() => { if (!document.hidden && !busy) load(); }, 5 * 60_000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

async function fetchRadar(tf, onProgress) {
  if (await isDemo()) {
    const names = createDemoMarket().pairs.map((p) => p.symbol);
    return { ...demoTrends(tf, names), source: 'demo' };
  }
  const base = whaleServer.get();
  if (base) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${base}/api/catcher/trends`, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const body = await res.json();
        const f = body.frames?.[tf];
        if (!body.demo && f && Array.isArray(f.rows)) {
          return { t: f.t, scanned: f.scanned, rows: f.rows.filter(validRadarRow), source: 'server', minVolume: body.minVolume, tested: body.tested };
        }
      }
    } catch {
      // fall back to scanning here
    }
  }
  const tickers = await get('/fapi/v1/ticker/24hr', {}, 60_000);
  const symbols = tickers
    .filter((t) => /USDT$/.test(t.symbol))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, LOCAL_TOP)
    .map((t) => ({ symbol: t.symbol, volume24h: +t.quoteVolume }));
  const res = await scanTrends({ get: (path, params) => get(path, params, 60_000), symbols, tf, onProgress });
  return { ...res, source: 'local' };
}
