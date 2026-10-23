// Formatting, DOM and storage helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);

/** h('div.cls', { onclick }, child, 'text') */
export function h(tag, props, ...children) {
  const [head, ...classes] = tag.split('.');
  const [name, id] = head.split('#');
  const el = document.createElement(name || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      // setProperty is the only way to set CSS custom properties (--x) from script.
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const ticker = (symbol) => symbol.replace(/USDT$/, '');

export function fmtPrice(p) {
  if (p == null || !isFinite(p)) return '–';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4).replace(/0{1,2}$/, '');
  if (p >= 0.01) return p.toFixed(5);
  return p.toPrecision(4);
}

export function fmtUsd(v, sign = false) {
  if (v == null || !isFinite(v)) return '–';
  const s = sign && v > 0 ? '+' : v < 0 ? '-' : '';
  const a = Math.abs(v);
  const n = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0);
  return `${s}$${n}`;
}

export const fmtPct = (v, digits = 1, sign = true) =>
  v == null || !isFinite(v) ? '–' : `${sign && v > 0 ? '+' : ''}${v.toFixed(digits)}%`;

export const fmtShare = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);

export function fmtAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60_000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export const signClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('dw:' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('dw:' + key, JSON.stringify(value));
    } catch {}
  },
};

export const watchlist = {
  all: () => new Set(store.get('watch', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])),
  has: (s) => watchlist.all().has(s),
  toggle(s) {
    const w = watchlist.all();
    w.has(s) ? w.delete(s) : w.add(s);
    store.set('watch', [...w]);
    return w.has(s);
  },
};

/** Two-segment long/short bar. share is 0..1. */
export function shareBar(share, label) {
  const pct = Math.round(share * 100);
  return h(
    'div.sharebar',
    { title: `${label}: ${pct}% long, ${100 - pct}% short` },
    h('span.sharebar-long', { style: { width: pct + '%' } }),
    h('span.sharebar-num', `${pct}%`),
  );
}

export function sortRows(rows, key, dir) {
  return [...rows].sort((a, b) => {
    const x = typeof key === 'function' ? key(a) : a[key];
    const y = typeof key === 'function' ? key(b) : b[key];
    if (x == null) return 1;
    if (y == null) return -1;
    return typeof x === 'string' ? x.localeCompare(y) * dir : (x - y) * dir;
  });
}

export function csv(rows, columns) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [columns.map((c) => c.label).join(','), ...rows.map((r) => columns.map((c) => esc(c.get(r) ?? '')).join(','))].join('\n');
}

/** Copy text; returns true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function toast(msg) {
  const t = h('div.toast', { role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
