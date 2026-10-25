// Market heatmap: tile area by 24h volume, colour by price change (or funding).
import { getMarket } from '../api.js';
import { h, ticker, fmtPct, fmtUsd, fmtPrice, fill } from '../util.js';

export function heatmapView(root, { go }) {
  let metric = 'change24h';
  let rows = [];
  const grid = h('div.heat');
  const scaleNote = h('p.note');

  fill(root, 
    h('section.hero.compact',
      h('div.hero-text',
        h('p.eyebrow', 'Top 60 pairs by 24h volume'),
        h('h1', 'Market heatmap'),
        h('p.lede', 'Tile size shows trading volume. Colour shows the 24h move, or the funding rate if you switch.'),
      ),
    ),
    h('section.panel',
      h('div.toolbar', h('div.lenses', { role: 'group', 'aria-label': 'Colour by' },
        ...[['change24h', '24h change'], ['funding', 'Funding']].map(([id, label]) =>
          h('button.lens', { type: 'button', 'aria-pressed': String(id === metric), onclick: (e) => {
            metric = id;
            e.target.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target)));
            render();
          } }, label))), scaleNote),
      grid,
    ),
  );

  function render() {
    const val = (r) => (metric === 'funding' ? (r.funding ?? 0) * 100 : r.change24h);
    const cap = metric === 'funding' ? 0.05 : 10;
    scaleNote.textContent = metric === 'funding' ? 'Full colour at ±0.05% per funding payment' : 'Full colour at ±10%';
    const maxV = rows[0]?.quoteVolume || 1;
    fill(grid, ...rows.map((r) => {
      const v = val(r);
      return h('button.heat-tile', {
        style: { '--grow': Math.max(0.6, Math.sqrt(r.quoteVolume / maxV) * 8), '--t': Math.max(-1, Math.min(1, v / cap)) },
        'data-dir': v >= 0 ? 'up' : 'down',
        title: `${r.symbol} ${fmtPrice(r.price)} · ${fmtUsd(r.quoteVolume)} volume`,
        onclick: () => go('token', r.symbol),
      }, h('span.pair-name', ticker(r.symbol)), h('span.heat-val', metric === 'funding' ? `${v.toFixed(4)}%` : fmtPct(v)));
    }));
  }

  getMarket().then((m) => { rows = m.slice(0, 60); render(); }).catch((e) => fill(grid, h('p.error', e.message)));
  return () => {};
}
