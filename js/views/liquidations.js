// Live forced liquidations from Binance's public stream, aggregated by pair and side.
import { streamLiquidations } from '../api.js';
import { h, ticker, fmtPrice, fmtUsd } from '../util.js';

const WINDOW_MS = 15 * 60_000;

export function liquidationsView(root, { go }) {
  const events = [];
  let minUsd = 1000;

  const totals = h('div.summary');
  const map = h('div.liq-map');
  const feed = h('ol.feed');

  root.replaceChildren(
    h('section.hero.compact',
      h('div.hero-text',
        h('p.eyebrow', 'Live sample · last 15 minutes'),
        h('h1', 'Liquidations'),
        h('p.lede', 'Positions closed by the exchange because margin ran out. Bigger tiles mean more money liquidated on that pair.'),
        h('p.note', 'This is a sample: Binance’s public stream sends at most one liquidation per pair per second, so in a cascade most liquidations are never shown. Use the long/short split as a direction, not a total.'),
      ),
      totals,
    ),
    h('div.split',
      h('section.panel.grow', h('h2', 'By pair'), map, h('div.legend', h('span.key.long', 'Longs liquidated'), h('span.key.short', 'Shorts liquidated'))),
      h('section.panel.side',
        h('div.toolbar', h('h2', 'Feed'),
          h('label.field.inline', h('span', 'Min size'),
            h('select#liq-min', { onchange: (e) => { minUsd = +e.target.value; renderFeed(); } },
              ...[[0, 'Any'], [1000, '$1K'], [10000, '$10K'], [100000, '$100K']].map(([v, l]) => h('option', { value: v, selected: v === minUsd }, l))))),
        feed),
    ),
  );

  function prune() {
    const cutoff = Date.now() - WINDOW_MS;
    while (events.length && events[0].t < cutoff) events.shift();
  }

  function renderMap() {
    prune();
    const by = new Map();
    for (const e of events) {
      const r = by.get(e.symbol) || { symbol: e.symbol, long: 0, short: 0 };
      r[e.side] += e.usd;
      by.set(e.symbol, r);
    }
    const list = [...by.values()].sort((a, b) => b.long + b.short - (a.long + a.short)).slice(0, 24);
    const max = list[0] ? list[0].long + list[0].short : 1;
    map.replaceChildren(...(list.length ? list.map((r) => {
      const tot = r.long + r.short;
      return h('button.liq-tile', {
        style: { '--size': Math.sqrt(tot / max), '--longshare': r.long / tot },
        title: `${ticker(r.symbol)}: ${fmtUsd(r.long)} longs, ${fmtUsd(r.short)} shorts`,
        onclick: () => go('token', r.symbol),
      }, h('span.pair-name', ticker(r.symbol)), h('span', fmtUsd(tot)));
    }) : [h('p.empty', 'Waiting for liquidations…')]));

    const L = events.reduce((s, e) => s + (e.side === 'long' ? e.usd : 0), 0);
    const S = events.reduce((s, e) => s + (e.side === 'short' ? e.usd : 0), 0);
    const biggest = events.reduce((b, e) => (!b || e.usd > b.usd ? e : b), null);
    totals.replaceChildren(
      h('div.stat', h('span.stat-label', 'Longs liquidated'), h('span.stat-value.down', fmtUsd(L))),
      h('div.stat', h('span.stat-label', 'Shorts liquidated'), h('span.stat-value.up', fmtUsd(S))),
      h('div.stat', h('span.stat-label', 'Biggest single'), h('span.stat-value', biggest ? fmtUsd(biggest.usd) : '–'), h('span.stat-sub', biggest ? `${ticker(biggest.symbol)} ${biggest.side}` : '')),
    );
  }

  function renderFeed() {
    const list = events.filter((e) => e.usd >= minUsd).slice(-40).reverse();
    feed.replaceChildren(...(list.length ? list.map(item) : [h('li.empty', 'No liquidations above this size yet.')]));
  }

  const item = (e) => h(`li.${e.side}`,
    h('span.pair-name', ticker(e.symbol)),
    h('span', e.side === 'long' ? 'Long' : 'Short'),
    h('span.num', fmtUsd(e.usd)),
    h('span.num.muted', `@ ${fmtPrice(e.price)}`),
  );

  let pending = false;
  const stop = streamLiquidations((e) => {
    events.push(e);
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      renderFeed();
      renderMap();
    });
  });
  renderMap();
  renderFeed();
  const timer = setInterval(renderMap, 5000);
  return () => {
    stop();
    clearInterval(timer);
  };
}
