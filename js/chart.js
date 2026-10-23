// Small canvas chart: candles or a line on top, optional percentage lines in a lower pane.
// Redraws on resize and theme change. No dependencies.
import { cssVar, fmtPrice } from './util.js';

export function priceChart(container, { candles, overlays = [], markers = [], levels = [], label = 'Price chart with whale and crowd long share' }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'chart-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label);
  container.replaceChildren(canvas);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.append(tip);

  let hover = -1;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = container.clientWidth;
    const H = container.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const c = {
      grid: cssVar('--line'),
      text: cssVar('--muted'),
      up: cssVar('--long'),
      down: cssVar('--short'),
      fg: cssVar('--fg'),
    };
    ctx.font = `11px ${cssVar('--font-data')}`;

    const padR = 64;
    const pane2 = overlays.length ? Math.round(H * 0.32) : 0;
    const top = 10;
    const priceH = H - pane2 - 26 - top;
    const plotW = W - padR - 8;
    const n = candles.length;
    const bw = plotW / n;
    const x = (i) => 8 + i * bw + bw / 2;

    const hi = Math.max(...candles.map((k) => k.h), ...levels.map((l) => l.price));
    const lo = Math.min(...candles.map((k) => k.l), ...levels.map((l) => l.price));
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    const y = (p) => top + ((hi + pad - p) / (hi - lo + 2 * pad)) * priceH;

    // Grid and price axis
    ctx.strokeStyle = c.grid;
    ctx.fillStyle = c.text;
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const p = lo - pad + ((hi - lo + 2 * pad) * g) / 4;
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(8, yy);
      ctx.lineTo(8 + plotW, yy);
      ctx.stroke();
      ctx.fillText(fmtPrice(p), plotW + 14, yy);
    }

    // Candles
    for (let i = 0; i < n; i++) {
      const k = candles[i];
      const col = k.c >= k.o ? c.up : c.down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x(i), y(k.h));
      ctx.lineTo(x(i), y(k.l));
      ctx.stroke();
      const bodyTop = y(Math.max(k.o, k.c));
      const bodyH = Math.max(1, Math.abs(y(k.o) - y(k.c)));
      ctx.fillRect(x(i) - Math.max(1, bw * 0.35), bodyTop, Math.max(2, bw * 0.7), bodyH);
    }

    // Last price tag
    const last = candles[n - 1];
    const ly = y(last.c);
    ctx.fillStyle = last.c >= last.o ? c.up : c.down;
    ctx.fillRect(plotW + 10, ly - 9, padR - 6, 18);
    ctx.fillStyle = cssVar('--bg');
    ctx.fillText(fmtPrice(last.c), plotW + 14, ly);

    // Markers for big whale moves
    for (const m of markers) {
      const i = nearestIndex(m.t);
      if (i < 0) continue;
      const k = candles[i];
      const up = m.dir > 0;
      const my = up ? y(k.l) + 12 : y(k.h) - 12;
      ctx.fillStyle = up ? c.up : c.down;
      ctx.beginPath();
      ctx.moveTo(x(i), up ? my - 6 : my + 6);
      ctx.lineTo(x(i) - 5, up ? my + 3 : my - 3);
      ctx.lineTo(x(i) + 5, up ? my + 3 : my - 3);
      ctx.fill();
    }

    // Horizontal levels (alert price, peak, …) with a label at the left edge
    for (const lv of levels) {
      const ly2 = Math.round(y(lv.price)) + 0.5;
      ctx.strokeStyle = cssVar(lv.color || '--accent');
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(8, ly2);
      ctx.lineTo(8 + plotW, ly2);
      ctx.stroke();
      ctx.setLineDash([]);
      const text = `${lv.label} ${fmtPrice(lv.price)}`;
      const tw = ctx.measureText(text).width + 10;
      ctx.fillStyle = cssVar('--surface');
      ctx.fillRect(10, ly2 - 9, tw, 18);
      ctx.fillStyle = cssVar(lv.color || '--accent');
      ctx.fillText(text, 15, ly2);
    }

    // Lower pane: long share lines (0–100%)
    if (pane2) {
      const p2top = top + priceH + 22;
      const p2h = pane2 - 8;
      const yy = (v) => p2top + (1 - v) * p2h;
      ctx.strokeStyle = c.grid;
      ctx.fillStyle = c.text;
      for (const v of [0, 0.5, 1]) {
        const ly2 = Math.round(yy(v)) + 0.5;
        ctx.beginPath();
        ctx.setLineDash(v === 0.5 ? [3, 3] : []);
        ctx.moveTo(8, ly2);
        ctx.lineTo(8 + plotW, ly2);
        ctx.stroke();
        ctx.fillText(`${v * 100}% long`, plotW + 14, ly2);
      }
      ctx.setLineDash([]);
      for (const o of overlays) {
        ctx.strokeStyle = cssVar(o.color);
        ctx.lineWidth = o.width || 1.75;
        ctx.beginPath();
        let started = false;
        for (const pt of o.points) {
          const i = nearestIndex(pt.t);
          if (i < 0) continue;
          started ? ctx.lineTo(x(i), yy(pt.v)) : ctx.moveTo(x(i), yy(pt.v));
          started = true;
        }
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }

    // Crosshair
    if (hover >= 0 && hover < n) {
      ctx.strokeStyle = c.text;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x(hover) + 0.5, top);
      ctx.lineTo(x(hover) + 0.5, H - 4);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function nearestIndex(t) {
    const step = candles.length > 1 ? candles[1].t - candles[0].t : 1;
    const i = Math.round((t - candles[0].t) / step);
    return i >= 0 && i < candles.length ? i : -1;
  }

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - 72;
    const i = Math.floor(((e.clientX - rect.left - 8) / plotW) * candles.length);
    if (i < 0 || i >= candles.length) return;
    hover = i;
    draw();
    const k = candles[i];
    const lines = [
      new Date(k.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      `O ${fmtPrice(k.o)}  H ${fmtPrice(k.h)}`,
      `L ${fmtPrice(k.l)}  C ${fmtPrice(k.c)}`,
    ];
    for (const o of overlays) {
      const pt = o.points.find((p) => nearestIndex(p.t) === i);
      if (pt) lines.push(`${o.label} ${Math.round(pt.v * 100)}% long`);
    }
    tip.textContent = lines.join('\n');
    tip.hidden = false;
    const left = e.clientX - rect.left;
    tip.style.left = Math.min(left + 12, rect.width - 170) + 'px';
    tip.style.top = '8px';
  });
  canvas.addEventListener('pointerleave', () => {
    hover = -1;
    tip.hidden = true;
    draw();
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', draw);
  return () => {
    ro.disconnect();
    mq.removeEventListener('change', draw);
  };
}

/** Tiny inline sparkline as an SVG string-free element. */
export function sparkline(values, { width = 96, height = 26, colorVar = '--accent' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('class', 'spark');
  if (values.length < 2) return svg;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 2, height - 3 - ((v - lo) / (hi - lo || 1)) * (height - 6)]);
  const path = document.createElementNS(ns, 'polyline');
  path.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', `var(${colorVar})`);
  path.setAttribute('stroke-width', '1.5');
  const dot = document.createElementNS(ns, 'circle');
  const [lx, ly] = pts[pts.length - 1];
  dot.setAttribute('cx', lx);
  dot.setAttribute('cy', ly);
  dot.setAttribute('r', '2.2');
  dot.setAttribute('fill', `var(${colorVar})`);
  svg.append(path, dot);
  return svg;
}
