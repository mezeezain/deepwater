// Stacked chart: candles on top, any number of indicator panes below, one shared time axis
// and crosshair. Canvas only, no dependencies. Colours come from CSS tokens so both themes work.
import { cssVar, fmtPrice } from './util.js';

const PRICE_H = 300;
const PANE_H = 92;
const AXIS_W = 70;
const GAP = 8;

/**
 * bars:   [{ t, o, h, l, c }]
 * price:  { levels: [{ price, label, color }], markers: [{ t, color, shape: 'up'|'down'|'dot'|'line', title }] }
 * panes:  [{ id, label, kind: 'line'|'hist'|'step'|'share', series: [{ name, values, color, colorDown, kind }], format }]
 *         values align with bars; null = no value. A series with kind 'dots' draws markers on the pane's zero line.
 */
export function multiChart(container, { bars, price = {}, panes = [], label = 'Price and indicator chart' }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'chart-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label);
  container.replaceChildren(canvas);
  container.style.height = PRICE_H + panes.length * (PANE_H + GAP) + 28 + 'px';
  let hover = -1;

  function layout(W) {
    const plotW = W - AXIS_W - 8;
    const rects = [{ y: 6, h: PRICE_H - 6 }];
    let y = PRICE_H + GAP;
    for (let i = 0; i < panes.length; i++) {
      rects.push({ y, h: PANE_H });
      y += PANE_H + GAP;
    }
    return { plotW, rects, bottom: y };
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = container.clientWidth;
    const H = container.clientHeight;
    if (!W || !H) return;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const col = { grid: cssVar('--line'), text: cssVar('--muted'), fg: cssVar('--fg'), up: cssVar('--long'), down: cssVar('--short'), bg: cssVar('--surface') };
    const font = cssVar('--font-data');
    ctx.font = `11px ${font}`;
    ctx.textBaseline = 'middle';
    const n = bars.length;
    const { plotW, rects } = layout(W);
    const bw = plotW / n;
    const x = (i) => 8 + i * bw + bw / 2;
    const idx = hover >= 0 ? hover : n - 1;

    // ---- price pane
    const pr = rects[0];
    const levelPrices = (price.levels || []).map((l) => l.price).filter((p) => p > 0);
    let hi = Math.max(...bars.map((b) => b.h));
    let lo = Math.min(...bars.map((b) => b.l));
    // Keep levels in range only if they're near price; far ones would squash the candles.
    for (const p of levelPrices) if (p < hi * 1.15 && p > lo * 0.85) { hi = Math.max(hi, p); lo = Math.min(lo, p); }
    const pad = (hi - lo) * 0.05 || hi * 0.01;
    const yP = (p) => pr.y + ((hi + pad - p) / (hi - lo + 2 * pad)) * pr.h;
    grid(ctx, col, pr, plotW, 4, (g) => {
      const p = lo - pad + ((hi - lo + 2 * pad) * (4 - g)) / 4;
      return { y: yP(p), text: fmtPrice(p) };
    });
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const c = b.c >= b.o ? col.up : col.down;
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(x(i), yP(b.h));
      ctx.lineTo(x(i), yP(b.l));
      ctx.stroke();
      ctx.fillRect(x(i) - Math.max(0.5, bw * 0.35), yP(Math.max(b.o, b.c)), Math.max(1, bw * 0.7), Math.max(1, Math.abs(yP(b.o) - yP(b.c))));
    }
    for (const lv of price.levels || []) {
      if (!(lv.price > lo - pad && lv.price < hi + pad)) continue;
      const ly = Math.round(yP(lv.price)) + 0.5;
      ctx.strokeStyle = cssVar(lv.color);
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(8, ly);
      ctx.lineTo(8 + plotW, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      const text = `${lv.label} ${fmtPrice(lv.price)}`;
      tag(ctx, text, 8 + plotW - ctx.measureText(text).width - 14, ly, cssVar(lv.color), col.bg);
    }
    for (const m of price.markers || []) {
      const i = indexOf(m.t);
      if (i < 0) continue;
      const b = bars[i];
      ctx.fillStyle = ctx.strokeStyle = cssVar(m.color);
      if (m.shape === 'line') {
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x(i), pr.y);
        ctx.lineTo(x(i), pr.y + pr.h);
        ctx.stroke();
        ctx.setLineDash([]);
        tag(ctx, m.title, Math.min(x(i) + 4, plotW - 80), pr.y + 10, cssVar(m.color), col.bg);
      } else if (m.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(x(i), yP(b.l) + 8, 2.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const up = m.shape === 'up';
        const my = up ? yP(b.l) + 10 : yP(b.h) - 10;
        ctx.beginPath();
        ctx.moveTo(x(i), up ? my - 5 : my + 5);
        ctx.lineTo(x(i) - 4, up ? my + 3 : my - 3);
        ctx.lineTo(x(i) + 4, up ? my + 3 : my - 3);
        ctx.fill();
      }
    }
    const last = bars[n - 1];
    tag(ctx, fmtPrice(last.c), plotW + 12, yP(last.c), col.bg, last.c >= last.o ? col.up : col.down);
    const hb = bars[idx];
    legend(ctx, font, 12, pr.y + 12, [
      [new Date(hb.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), col.text],
      [`O ${fmtPrice(hb.o)} H ${fmtPrice(hb.h)} L ${fmtPrice(hb.l)} C ${fmtPrice(hb.c)}`, col.fg],
    ], col.bg, 8 + plotW - 4);

    // ---- indicator panes
    panes.forEach((pane, k) => {
      const r = rects[k + 1];
      const vals = pane.series.filter((s) => s.kind !== 'dots').flatMap((s) => s.values.filter((v) => v != null && isFinite(v)));
      if (pane.emptyText && !vals.some((v) => v !== 0)) {
        ctx.strokeStyle = col.grid;
        ctx.strokeRect(8.5, r.y + 0.5, plotW, r.h);
        ctx.fillStyle = col.text;
        ctx.textAlign = 'center';
        ctx.fillText(pane.emptyText, 8 + plotW / 2, r.y + r.h / 2 + 6, plotW - 16);
        ctx.textAlign = 'left';
        legend(ctx, font, 12, r.y + 11, [[pane.label, col.text]], col.bg, 8 + plotW - 4);
        return;
      }
      let pmin, pmax;
      if (pane.kind === 'share') {
        pmin = 0;
        pmax = 1;
      } else {
        pmin = Math.min(0, ...vals);
        pmax = Math.max(0, ...vals);
        if (pane.kind === 'line' && vals.length) {
          pmin = Math.min(...vals);
          pmax = Math.max(...vals);
        }
        if (pmin === pmax) { pmin -= 1; pmax += 1; }
        const pp = (pmax - pmin) * 0.08;
        pmax += pp;
        if (pmin < 0 || pane.kind === 'line') pmin -= pp;
      }
      const yv = (v) => r.y + ((pmax - v) / (pmax - pmin)) * r.h;
      ctx.strokeStyle = col.grid;
      ctx.strokeRect(8.5, r.y + 0.5, plotW, r.h);
      const fmt = pane.format || ((v) => v.toFixed(2));
      ctx.fillStyle = col.text;
      ctx.fillText(fmt(pmax), plotW + 14, r.y + 8);
      ctx.fillText(fmt(pmin), plotW + 14, r.y + r.h - 8);
      if (pmin < 0 && pmax > 0 || pane.kind === 'share') {
        const zv = pane.kind === 'share' ? 0.5 : 0;
        const zy = Math.round(yv(zv)) + 0.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(8, zy);
        ctx.lineTo(8 + plotW, zy);
        ctx.stroke();
        ctx.setLineDash([]);
        if (pane.kind === 'share') ctx.fillText('50%', plotW + 14, zy);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(8, r.y, plotW, r.h);
      ctx.clip();
      for (const s of pane.series) drawSeries(ctx, s, pane, { n, x, bw, yv, col, r });
      ctx.restore();
      const items = [[pane.label, col.text]];
      for (const s of pane.series) {
        if (s.kind === 'dots' || s.hideValue) continue;
        const v = s.values[idx];
        if (v != null) items.push([`${s.name ? s.name + ' ' : ''}${fmt(v)}`, cssVar(s.color)]);
      }
      legend(ctx, font, 12, r.y + 11, items, col.bg, 8 + plotW - 4);
    });

    // ---- crosshair
    if (hover >= 0) {
      ctx.strokeStyle = col.text;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x(hover) + 0.5, 4);
      ctx.lineTo(x(hover) + 0.5, rects.at(-1).y + rects.at(-1).h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // time labels
    ctx.fillStyle = col.text;
    ctx.textAlign = 'center';
    const lastRect = rects.at(-1);
    const span = bars[n - 1].t - bars[0].t;
    // As many labels as fit without touching (2 on a phone, 5 on a wide screen).
    const labels = Math.max(1, Math.min(4, Math.floor(plotW / 110)));
    for (let g = 0; g <= labels; g++) {
      const i = Math.round(((n - 1) * g) / labels);
      const d = new Date(bars[i].t);
      const text = span > 3 * 86_400_000 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const half = ctx.measureText(text).width / 2;
      ctx.fillText(text, Math.min(Math.max(x(i), 8 + half), 8 + plotW - half), lastRect.y + lastRect.h + 12);
    }
    ctx.textAlign = 'left';
  }

  function indexOf(t) {
    if (t < bars[0].t) return -1;
    const step = bars.length > 1 ? bars[1].t - bars[0].t : 1;
    const i = Math.floor((t - bars[0].t) / step);
    return i < bars.length ? i : -1;
  }

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - AXIS_W - 8;
    const i = Math.floor(((e.clientX - rect.left - 8) / plotW) * bars.length);
    const next = i >= 0 && i < bars.length ? i : -1;
    if (next !== hover) {
      hover = next;
      draw();
    }
  });
  canvas.addEventListener('pointerleave', () => {
    hover = -1;
    draw();
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', draw);
  const themeObs = new MutationObserver(draw);
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  draw();
  return () => {
    ro.disconnect();
    themeObs.disconnect();
    mq.removeEventListener('change', draw);
  };
}

function drawSeries(ctx, s, pane, { n, x, bw, yv, col, r }) {
  const color = cssVar(s.color);
  const colorDown = s.colorDown ? cssVar(s.colorDown) : color;
  const kind = s.kind || pane.kind;
  if (kind === 'dots') {
    const zy = yv(pane.kind === 'share' ? 0.5 : 0);
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      if (!s.values[i]) continue;
      ctx.beginPath();
      ctx.arc(x(i), zy, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (kind === 'hist') {
    const z = yv(0);
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v == null || v === 0) continue;
      ctx.fillStyle = v >= 0 ? color : colorDown;
      const y = yv(v);
      ctx.fillRect(x(i) - Math.max(0.5, bw * 0.35), Math.min(y, z), Math.max(1, bw * 0.7), Math.max(1, Math.abs(z - y)));
    }
    return;
  }
  ctx.lineWidth = s.width || 1.6;
  let prev = null;
  for (let i = 0; i < n; i++) {
    const v = s.values[i];
    if (v == null || !isFinite(v)) {
      prev = null;
      continue;
    }
    if (prev) {
      ctx.strokeStyle = kind === 'step' && v < prev.v ? colorDown : color;
      ctx.beginPath();
      ctx.moveTo(prev.x, yv(prev.v));
      if (kind === 'step') {
        ctx.lineTo(x(i), yv(prev.v));
        ctx.lineTo(x(i), yv(v));
      } else ctx.lineTo(x(i), yv(v));
      ctx.stroke();
    }
    prev = { x: x(i), v };
  }
  ctx.lineWidth = 1;
}

function grid(ctx, col, r, plotW, lines, at) {
  ctx.strokeStyle = col.grid;
  ctx.fillStyle = col.text;
  for (let g = 0; g <= lines; g++) {
    const { y, text } = at(g);
    const yy = Math.round(y) + 0.5;
    ctx.beginPath();
    ctx.moveTo(8, yy);
    ctx.lineTo(8 + plotW, yy);
    ctx.stroke();
    ctx.fillText(text, plotW + 14, yy);
  }
}

/** Text on a solid label: `bg` fills the box, `fg` colours the text. */
function tag(ctx, text, x, y, fg, bg) {
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = bg;
  ctx.fillRect(x - 4, y - 9, w, 18);
  ctx.fillStyle = fg;
  ctx.fillText(text, x + 1, y);
}

/** Items left to right; stops before an item would run past maxX (the price axis). */
function legend(ctx, font, x, y, items, bg, maxX = Infinity) {
  let cx = x;
  ctx.font = `11px ${font}`;
  for (const [i, [text, color]] of items.entries()) {
    const w = ctx.measureText(text).width;
    if (i > 0 && cx + w > maxX) break;
    ctx.fillStyle = bg;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(cx - 3, y - 8, w + 6, 16);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(text, cx, y);
    cx += w + 12;
  }
}
