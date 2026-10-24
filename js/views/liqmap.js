// Liquidation map: where leveraged positions opened in this window would be forced out,
// with the live order book alongside. Estimated levels disappear once a wick trades through them.
import { getChartData, getDepth, getSmartHistory } from '../api.js';
import { pickCohort, summarize } from '../smartmoney.js';
import { marketLayers, whaleLayers, whaleEntries, liquidationLevels, bucketLevels, findWalls, fmtCompact } from '../indicators.js';
import { h, ticker, fmtPrice, cssVar, store, demoWatermark } from '../util.js';

const INTERVALS = { '5m': 288, '15m': 288, '1h': 300 };
const BUCKET_PCT = 0.25;
const usd = (v) => `$${fmtCompact(v)}`;

export function liqmapView(root, { symbol, go }) {
  symbol = symbol || store.get('last-pair', 'BTCUSDT');
  store.set('last-pair', symbol);
  let interval = store.get('liqmap-interval', '15m');
  // Highest leverage assumed for this pair. Binance allows 100×+ on majors but often 20–75× on altcoins.
  let maxLev = store.get('liqmap-lev-' + symbol, /^(BTC|ETH)USDT$/.test(symbol) ? 100 : 50);
  const levSelect = h('label.field.inline', h('span', 'Max leverage'),
    h('select#liq-lev', { onchange: (e) => { maxLev = +e.target.value; store.set('liqmap-lev-' + symbol, maxLev); load(); } },
      ...[10, 25, 50, 100].map((v) => h('option', { value: v, selected: v === maxLev }, `${v}×`))));
  let model = null;
  let book = null;
  const wallSeen = new Map(); // "side:bucket" -> first seen time
  let alive = true;
  let hover = null;

  const pairForm = h('form.pair-form', { onsubmit: (e) => {
    e.preventDefault();
    const v = e.target.elements['liq-pair'].value.trim().toUpperCase();
    if (v) go('liqmap', v.endsWith('USDT') ? v : v + 'USDT');
  } }, h('input#liq-pair.search', { name: 'liq-pair', placeholder: 'Pair, e.g. ETH', 'aria-label': 'Pair', value: ticker(symbol), autocomplete: 'off' }), h('button.btn', { type: 'submit' }, 'Open'));
  const intervalBar = h('div.lenses', { role: 'tablist', 'aria-label': 'Candle interval' });
  const box = h('div.liqmap');
  const canvas = h('canvas.chart-canvas', { role: 'img', 'aria-label': `${ticker(symbol)} estimated liquidation map with order book` });
  const tip = h('div.chart-tip');
  tip.hidden = true;
  const msg = h('p.map-msg');
  msg.hidden = true;
  box.append(canvas, tip, msg);
  const say = (text, cls = 'empty') => {
    msg.className = `map-msg ${cls}`;
    msg.textContent = text;
    msg.hidden = !text;
    canvas.hidden = !!text;
  };
  const clusters = h('div');
  const walls = h('div');
  const stamp = h('p.note');

  root.replaceChildren(
    h('section.hero.compact',
      h('div.hero-text',
        h('p.eyebrow', 'Illustrative · estimated from open interest · order book live'),
        h('h1', `${ticker(symbol)} liquidation map`),
        h('p.lede', 'Bright bands are rough zones where positions opened in this window could be liquidated, assuming a spread of leverage up to the maximum you pick. Each new contract adds a long and a short, so both sides get bands. A band disappears once price trades through it. The right column is the live order book.'),
        h('p.note', 'Assumptions, not Binance data: the leverage mix (35/30/20/15% across 10/25/50/100×), a flat 0.5% maintenance margin (Binance uses tiers), and isolated margin (cross-margin positions liquidate elsewhere). Use it for context, not as exact levels to trade against.'),
      ),
    ),
    h('section.panel',
      h('div.toolbar', pairForm, intervalBar, levSelect, h('button.btn.ghost', { onclick: () => go('token', symbol) }, `${ticker(symbol)} chart →`)),
      box,
      h('div.legend',
        h('span.key.heat', 'Estimated liquidations'),
        h('span.key.bid', 'Bids'),
        h('span.key.ask', 'Asks'),
        h('span.key.whale-long', 'Whale long entry est.'),
        h('span.key.whale-short', 'Whale short entry est.'),
      ),
      stamp,
    ),
    h('div.split',
      h('section.panel.grow', h('h2', 'Nearest liquidation clusters'), h('p.note', 'Price tends to get pulled toward large clusters, because each one is a pool of forced orders.'), clusters),
      h('section.panel.grow', h('h2', 'Order book walls'), h('p.note', 'Resting orders at least 4× the typical size nearby. Walls that last longer are more likely to be real.'), walls),
    ),
  );

  function renderIntervals() {
    intervalBar.replaceChildren(...Object.keys(INTERVALS).map((iv) => h('button.lens', { role: 'tab', 'aria-selected': String(iv === interval), onclick: () => {
      interval = iv;
      store.set('liqmap-interval', iv);
      load();
    } }, iv)));
  }

  async function load() {
    renderIntervals();
    try {
      const [raw, smartHist] = await Promise.all([getChartData(symbol, interval, INTERVALS[interval]), getSmartHistory(symbol).catch(() => null)]);
      if (!alive) return;
      if (raw.bars.length < 20 || !raw.bars.some((b) => b.oi != null)) {
        say('Binance has no open interest history for this pair, so there is nothing to map.');
        return;
      }
      const market = marketLayers(raw.bars);
      const whales = whaleLayers(raw.bars);
      const { columns, active } = liquidationLevels(raw.bars, market, { maxLev });
      model = { bars: raw.bars, columns, active, entries: whaleEntries(raw.bars, whales), exactEntries: false };
      // Prefer exact average entries from the whale data server.
      const last = smartHist?.snapshots?.at(-1);
      const sum = last && summarize(last, pickCohort(last));
      if (sum && (sum.longEntry || sum.shortEntry)) {
        model.entries = { long: sum.longEntry, short: sum.shortEntry };
        model.exactEntries = true;
      }
      say('');
      draw();
      renderClusters();
    } catch (e) {
      say(`Couldn't load data for ${symbol}. ${e.message}`, 'error');
    }
  }

  async function loadBook() {
    try {
      book = await getDepth(symbol);
      if (!alive) return;
      const now = Date.now();
      const found = findWalls(book, { pct: BUCKET_PCT });
      const keys = new Set();
      for (const w of found) {
        w.key = `${w.side}:${Math.round(w.price * 1e8)}`;
        keys.add(w.key);
        if (!wallSeen.has(w.key)) wallSeen.set(w.key, now);
        w.since = wallSeen.get(w.key);
      }
      for (const k of wallSeen.keys()) if (!keys.has(k)) wallSeen.delete(k);
      book.walls = found;
      stamp.textContent = `Order book updated ${new Date().toLocaleTimeString()} · refreshes every 15 seconds while this page is open.`;
      draw();
      renderWalls();
    } catch (e) {
      stamp.textContent = `Order book unavailable: ${e.message}`;
    }
  }

  function geometry() {
    const W = box.clientWidth;
    const H = box.clientHeight;
    const nowW = W < 560 ? 96 : 150;
    const axisW = 64;
    const plotW = W - nowW - axisW - 12;
    const last = model.bars.at(-1).c;
    let hi = Math.max(...model.bars.map((b) => b.h)) * 1.04;
    let lo = Math.min(...model.bars.map((b) => b.l)) * 0.96;
    // Never zoom out past ±25% of price, or the map turns into a thin strip.
    hi = Math.min(hi, last * 1.25);
    lo = Math.max(lo, last * 0.75);
    return { W, H, nowW, axisW, plotW, hi, lo, last, top: 8, plotH: H - 30 };
  }

  function draw() {
    if (!model || !box.isConnected) return;
    const g = geometry();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = g.W * dpr;
    canvas.height = g.H * dpr;
    canvas.style.width = g.W + 'px';
    canvas.style.height = g.H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const col = { grid: cssVar('--line'), text: cssVar('--muted'), fg: cssVar('--fg'), heat: cssVar('--whale'), bid: cssVar('--long'), ask: cssVar('--short'), bg: cssVar('--surface') };
    ctx.font = `11px ${cssVar('--font-data')}`;
    ctx.textBaseline = 'middle';
    const { bars, columns } = model;
    const n = bars.length;
    const y = (p) => g.top + (Math.log(g.hi / p) / Math.log(g.hi / g.lo)) * g.plotH;
    const step = Math.log(1 + BUCKET_PCT / 100);
    const nb = Math.ceil(Math.log(g.hi / g.lo) / step);
    const cellH = g.plotH / nb;
    const cw = g.plotW / n;
    const bucketOf = (p) => Math.floor(Math.log(g.hi / p) / step);

    // Heat cells: sum of standing levels per (bar, price bucket).
    const grid = columns.map((levels) => {
      const m = new Float64Array(nb);
      for (const lv of levels) {
        if (lv.price >= g.hi || lv.price <= g.lo) continue;
        m[bucketOf(lv.price)] += lv.usd;
      }
      return m;
    });
    let max = 0;
    for (const c of grid) for (const v of c) if (v > max) max = v;
    model.grid = grid;
    ctx.fillStyle = col.heat;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < nb; k++) {
        const v = grid[i][k];
        if (!v) continue;
        ctx.globalAlpha = Math.min(1, 0.08 + Math.sqrt(v / max) * 0.92);
        ctx.fillRect(8 + i * cw, g.top + k * cellH, Math.ceil(cw), Math.ceil(cellH));
      }
    }
    ctx.globalAlpha = 1;

    // Price axis
    ctx.strokeStyle = col.grid;
    ctx.fillStyle = col.text;
    for (let t = 0; t <= 6; t++) {
      const p = g.hi * Math.pow(g.lo / g.hi, t / 6);
      const yy = Math.round(y(p)) + 0.5;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(8, yy);
      ctx.lineTo(8 + g.plotW, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(fmtPrice(p), 8 + g.plotW + 6, yy);
    }

    // Price path: high-low range and close line
    ctx.strokeStyle = col.fg;
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.moveTo(8 + (i + 0.5) * cw, y(bars[i].h));
      ctx.lineTo(8 + (i + 0.5) * cw, y(bars[i].l));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    bars.forEach((b, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, 8 + (i + 0.5) * cw, y(b.c)));
    ctx.stroke();
    ctx.lineWidth = 1;

    // Whale entry estimates
    const lines = [
      [model.entries.long, '--long', model.exactEntries ? 'Whale long entry' : 'Whale long est.'],
      [model.entries.short, '--short', model.exactEntries ? 'Whale short entry' : 'Whale short est.'],
    ];
    for (const [p, color, label] of lines) {
      if (!p || p >= g.hi || p <= g.lo) continue;
      const yy = Math.round(y(p)) + 0.5;
      ctx.strokeStyle = cssVar(color);
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(8, yy);
      ctx.lineTo(8 + g.plotW + g.axisW + g.nowW, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      const text = `${label} ${fmtPrice(p)}`;
      ctx.fillStyle = col.bg;
      ctx.fillRect(12, yy - 9, ctx.measureText(text).width + 10, 18);
      ctx.fillStyle = cssVar(color);
      ctx.fillText(text, 17, yy);
    }

    // Now column: standing liquidations (left half) and order book (right half), same price buckets
    const nx = 8 + g.plotW + g.axisW;
    ctx.strokeStyle = col.grid;
    ctx.strokeRect(nx + 0.5, g.top + 0.5, g.nowW - 4, g.plotH);
    const half = (g.nowW - 8) / 2;
    const nowLiq = grid[n - 1];
    const liqMax = Math.max(...nowLiq, 1);
    ctx.fillStyle = col.heat;
    for (let k = 0; k < nb; k++) {
      if (!nowLiq[k]) continue;
      const w = (nowLiq[k] / liqMax) * half;
      ctx.fillRect(nx + 2 + half - w, g.top + k * cellH, w, Math.max(1, cellH - 0.5));
    }
    if (book) {
      const depth = new Float64Array(nb);
      const sideOf = new Array(nb);
      for (const [side, rows] of [['bid', book.bids], ['ask', book.asks]]) {
        for (const [p, q] of rows) {
          const price = +p;
          if (price >= g.hi || price <= g.lo) continue;
          const k = bucketOf(price);
          depth[k] += price * +q;
          sideOf[k] = side;
        }
      }
      const dMax = Math.max(...depth, 1);
      for (let k = 0; k < nb; k++) {
        if (!depth[k]) continue;
        ctx.fillStyle = sideOf[k] === 'bid' ? col.bid : col.ask;
        ctx.globalAlpha = 0.75;
        ctx.fillRect(nx + 4 + half, g.top + k * cellH, (depth[k] / dMax) * half, Math.max(1, cellH - 0.5));
      }
      ctx.globalAlpha = 1;
      // Label the biggest walls in range
      const shown = (book.walls || []).filter((w) => w.price < g.hi && w.price > g.lo).slice(0, 4);
      ctx.textAlign = 'right';
      const used = [];
      for (const w of shown) {
        const yy = y(w.price);
        if (used.some((u) => Math.abs(u - yy) < 18)) continue;
        used.push(yy);
        const text = `${usd(w.usd)} · ${w.multiple.toFixed(1)}×`;
        const tw = ctx.measureText(text).width + 8;
        ctx.fillStyle = col.bg;
        ctx.fillRect(nx - 4 - tw, yy - 8, tw, 16);
        ctx.fillStyle = w.side === 'bid' ? col.bid : col.ask;
        ctx.fillText(text, nx - 8, yy);
      }
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = col.text;
    ctx.fillText('Now', nx + 4, g.top + g.plotH + 14);
    // Current price
    const py = Math.round(y(g.last)) + 0.5;
    ctx.strokeStyle = col.fg;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(8, py);
    ctx.lineTo(nx + g.nowW - 4, py);
    ctx.stroke();
    ctx.setLineDash([]);

    // Time labels
    ctx.textAlign = 'center';
    const narrow = g.plotW < 420;
    const labels = narrow ? 2 : 3;
    for (let t = 0; t <= labels; t++) {
      const i = Math.round(((n - 1) * t) / labels);
      const d = new Date(bars[i].t);
      const text = narrow ? d.toLocaleString([], { month: 'short', day: 'numeric' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const half = ctx.measureText(text).width / 2;
      ctx.fillText(text, Math.min(Math.max(8 + (i + 0.5) * cw, 8 + half), 8 + g.plotW - half), g.top + g.plotH + 14);
    }
    ctx.textAlign = 'left';

    if (hover) {
      ctx.strokeStyle = col.fg;
      ctx.strokeRect(8 + hover.i * cw, g.top + hover.k * cellH, Math.max(2, cw), Math.max(2, cellH));
    }
    demoWatermark(ctx, g.W, g.H);
    model.geo = { ...g, cw, cellH, nb, step };
  }

  canvas.addEventListener('pointermove', (e) => {
    if (!model?.geo) return;
    const g = model.geo;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const i = Math.floor((mx - 8) / g.cw);
    const k = Math.floor((my - g.top) / g.cellH);
    if (i < 0 || i >= model.bars.length || k < 0 || k >= g.nb) {
      hover = null;
      tip.hidden = true;
      draw();
      return;
    }
    hover = { i, k };
    const price = g.hi * Math.exp(-(k + 0.5) * g.step);
    const v = model.grid[i][k];
    tip.textContent = `${new Date(model.bars[i].t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}\n${fmtPrice(price)}\n${v ? `Est. liquidations ${usd(v)}` : 'No estimated liquidations'}`;
    tip.hidden = false;
    tip.style.left = Math.min(mx + 12, rect.width - 190) + 'px';
    tip.style.top = Math.max(4, my - 60) + 'px';
    draw();
  });
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    tip.hidden = true;
    draw();
  });

  function renderClusters() {
    const last = model.bars.at(-1).c;
    const buckets = bucketLevels(model.active, last, 0.5);
    const above = buckets.filter((b) => b.price > last && b.short > 0).sort((a, b) => a.price - b.price);
    const below = buckets.filter((b) => b.price < last && b.long > 0).sort((a, b) => b.price - a.price);
    const top = (arr, key) => [...arr].sort((a, b) => b[key] - a[key]).slice(0, 4).sort((a, b) => Math.abs(a.price - last) - Math.abs(b.price - last));
    const row = (b, key, side) => h('li', h(`span.side-dot.${side}`), h('span.num', fmtPrice(b.price)), h('span.num.muted', `${(((b.price - last) / last) * 100).toFixed(1)}%`), h('span.num', usd(b[key])));
    clusters.replaceChildren(
      h('div.cluster-cols',
        h('div', h('h3', 'Above: shorts would be liquidated'), above.length ? h('ul.cluster-list', ...top(above, 'short').map((b) => row(b, 'short', 'ask'))) : h('p.empty', 'None estimated.')),
        h('div', h('h3', 'Below: longs would be liquidated'), below.length ? h('ul.cluster-list', ...top(below, 'long').map((b) => row(b, 'long', 'bid'))) : h('p.empty', 'None estimated.')),
      ),
    );
  }

  function renderWalls() {
    const list = (book?.walls || []).slice(0, 10).sort((a, b) => b.price - a.price);
    if (!list.length) {
      walls.replaceChildren(h('p.empty', 'No unusually large orders in the book right now.'));
      return;
    }
    const mins = (t) => Math.max(0, Math.round((Date.now() - t) / 60_000));
    walls.replaceChildren(h('div.table-wrap', h('table.grid',
      h('thead', h('tr', h('th', { scope: 'col' }, 'Side'), h('th', { scope: 'col' }, 'Price'), h('th', { scope: 'col' }, 'Size'), h('th', { scope: 'col' }, 'vs typical'), h('th', { scope: 'col' }, 'Distance'), h('th', { scope: 'col' }, 'Resting'))),
      h('tbody', ...list.map((w) => h('tr.static',
        h('td', h(`span.${w.side === 'bid' ? 'up' : 'down'}`, w.side === 'bid' ? 'Bid' : 'Ask')),
        h('td.num', fmtPrice(w.price)),
        h('td.num', usd(w.usd)),
        h('td.num', `${w.multiple.toFixed(1)}×`),
        h('td.num', `${w.distPct > 0 ? '+' : ''}${w.distPct.toFixed(2)}%`),
        h('td.num.muted', mins(w.since) < 1 ? 'just now' : `${mins(w.since)}m`),
      ))),
    )));
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(box);
  load();
  loadBook();
  const bookTimer = setInterval(loadBook, 15_000);
  const dataTimer = setInterval(load, 60_000);
  return () => {
    alive = false;
    ro.disconnect();
    clearInterval(bookTimer);
    clearInterval(dataTimer);
  };
}
