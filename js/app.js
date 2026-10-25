// App shell: navigation, routing by #hash, live/demo status.
import { status, ensureMode, setDemo, retryLive } from './api.js';
import { h, $, store, toast, fill } from './util.js';
import { parseHash, buildHash, normalizePair, ROUTE_IDS } from './route.js';

// Views load on demand so the first screen only downloads what it shows.
const lazy = (path, name) => () => import(path).then((m) => m[name]);
const ROUTES = {
  whales: { label: 'Whales', load: lazy('./views/whales.js', 'whalesView') },
  pumps: { label: 'Pump catcher', load: lazy('./views/pumps.js', 'pumpsView') },
  charts: { label: 'Charts', load: () => import('./views/token.js').then((m) => (root, ctx) => m.tokenView(root, { ...ctx, symbol: store.get('last-pair', 'BTCUSDT') })) },
  ideas: { label: 'Live setups', load: lazy('./views/ideas.js', 'ideasView') },
  setups: { label: 'Setups lab', load: lazy('./views/setups.js', 'setupsView') },
  liqmap: { label: 'Liq map', load: lazy('./views/liqmap.js', 'liqmapView') },
  liquidations: { label: 'Liquidations', load: lazy('./views/liquidations.js', 'liquidationsView') },
  heatmap: { label: 'Heatmap', load: lazy('./views/heatmap.js', 'heatmapView') },
  funding: { label: 'Funding', load: lazy('./views/funding.js', 'fundingView') },
  calculator: { label: 'Calculator', load: lazy('./views/calculator.js', 'calculatorView') },
  guide: { label: 'Guide', load: lazy('./views/guide.js', 'guideView') },
};
const EXTRA = { token: lazy('./views/token.js', 'tokenView'), signal: lazy('./views/signal.js', 'signalView') };
if (ROUTE_IDS.some((id) => !ROUTES[id])) throw new Error('route table out of sync with route.js');

// Navigation: one link, three small menus. Fewer top-level items fit any screen width.
const NAV = [
  { id: 'whales' },
  { group: 'Signals', items: ['pumps', 'ideas', 'setups'] },
  { group: 'Markets', items: ['charts', 'funding', 'heatmap'] },
  { group: 'Risk', items: ['liqmap', 'liquidations', 'calculator'] },
  { id: 'guide' },
];

// Web fonts load after first paint (a stylesheet in <head> would block rendering); system fonts show meanwhile.
const fontLink = document.createElement('link');
fontLink.rel = 'stylesheet';
fontLink.href = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..700&family=JetBrains+Mono:wght@400;500;600&display=swap';
document.head.append(fontLink);

const main = $('#main');
const nav = $('#nav');
const banner = $('#status');
let dispose = () => {};
let seq = 0;
let first = true;

export function go(route, arg, params) {
  const hash = buildHash(route, arg, params);
  if (location.hash.slice(1) === hash) render();
  else location.hash = hash;
}

/** Update the query part of the current address without adding a history entry (shareable view state). */
export function setParams(params) {
  const { route, symbol, id } = parseHash(location.hash);
  const hash = '#' + buildHash(route, route === 'signal' ? id : symbol, params);
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

async function render() {
  const mine = ++seq;
  const { route, symbol, id, params, unknown } = parseHash(location.hash);
  dispose();
  dispose = () => {};
  const navRoute = route === 'signal' ? 'pumps' : route === 'token' ? 'charts' : route;
  markNav(navRoute);
  window.scrollTo(0, 0);
  main.setAttribute('aria-busy', 'true');
  fill(main, h('div.loading', { role: 'status' }, 'Loading…'));
  let view;
  try {
    view = await (route === 'token' || route === 'signal' ? EXTRA[route] : ROUTES[route].load)();
  } catch (e) {
    if (mine !== seq) return;
    main.removeAttribute('aria-busy');
    fill(main, h('section.panel', h('h2', 'This page could not load'), h('p.note', 'Check your connection and reload. ' + (e?.message || ''))));
    return;
  }
  if (mine !== seq) return; // a newer navigation won
  fill(main, );
  main.removeAttribute('aria-busy');
  try {
    dispose = view(main, { symbol, id, params, go, setParams }) || (() => {});
  } catch (e) {
    console.error(e);
    fill(main, h('section.panel', h('h2', 'Something went wrong on this page'), h('p.note', 'Reload to try again. ' + (e?.message || ''))));
  }
  const label = ROUTES[route]?.label;
  document.title = (status.mode === 'demo' ? 'DEMO · ' : '') + (
    route === 'token' ? `${symbol.replace(/USDT$/, '')} · Deepwater`
    : route === 'liqmap' && symbol ? `${symbol.replace(/USDT$/, '')} liquidation map · Deepwater`
    : route === 'signal' ? `${id.split('-')[0].replace(/USDT$/, '')} signal · Deepwater`
    : `Deepwater · ${label}`);
  // Move keyboard and screen-reader focus to the new page (not on the very first load).
  if (!first) main.focus({ preventScroll: true });
  first = false;
  if (unknown) toast('That address is not a page here, so Whales is shown.');
}

function markNav(active) {
  nav.querySelectorAll('a[data-route]').forEach((a) => {
    if (a.dataset.route === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  nav.querySelectorAll('button[data-group]').forEach((b) => {
    const has = ROUTES[active] && NAV.find((n) => n.group === b.dataset.group)?.items.includes(active);
    if (has) b.setAttribute('data-current', 'true');
    else b.removeAttribute('data-current');
  });
}

function closeMenus(except) {
  nav.querySelectorAll('button[data-group][aria-expanded="true"]').forEach((b) => {
    if (b === except) return;
    b.setAttribute('aria-expanded', 'false');
    b.nextElementSibling.hidden = true;
  });
}

function buildNav() {
  const link = (id) => h('a', { href: '#' + id, 'data-route': id }, ROUTES[id].label);
  fill(nav, ...NAV.map((n, i) => {
    if (n.id) return link(n.id);
    const menuId = `menu-${i}`;
    const btn = h('button', { type: 'button', 'data-group': n.group, 'aria-expanded': 'false', 'aria-controls': menuId }, n.group, h('span.caret', { 'aria-hidden': 'true' }, '▾'));
    const menu = h('div.menu', { id: menuId, hidden: true }, n.items.map(link));
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      closeMenus(btn);
      btn.setAttribute('aria-expanded', String(!open));
      menu.hidden = open;
    });
    return h('div.group', btn, menu);
  }));
  nav.addEventListener('click', (e) => { if (e.target.closest('.menu a')) closeMenus(); });
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = nav.querySelector('button[aria-expanded="true"]');
    if (open) { closeMenus(); open.focus(); }
  });
  nav.addEventListener('focusout', (e) => { if (!e.relatedTarget || !nav.contains(e.relatedTarget)) closeMenus(); });
  document.addEventListener('click', (e) => { if (!nav.contains(e.target)) closeMenus(); });
}
buildNav();

$('#jump').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#jump-input');
  const sym = normalizePair(input.value);
  if (!sym) {
    if (input.value.trim()) toast('Type a ticker such as SOL or BTCUSDT.');
    return;
  }
  go('token', sym);
  input.value = '';
});

const statusbar = $('#statusbar');
const demoPill = $('#demo-pill');
let countdown;

function paintStatus(mode, reason) {
  const demo = mode === 'demo';
  banner.dataset.mode = mode;
  statusbar.dataset.mode = mode;
  demoPill.hidden = !demo;
  document.documentElement.dataset.demo = demo ? '1' : '';
  if (!document.title.startsWith('DEMO · ') && demo) document.title = 'DEMO · ' + document.title;
  clearInterval(countdown);
  if (mode === 'live') {
    fill(banner, h('span.dot'), 'Live data from Binance');
  } else if (mode === 'demo') {
    const retry = h('span.retry');
    const tick = () => {
      const s = status.nextRetry ? Math.max(0, Math.round((status.nextRetry - Date.now()) / 1000)) : null;
      retry.textContent = status.chosen ? '' : s != null ? `Checking Binance again in ${s} s.` : '';
    };
    tick();
    if (!status.chosen) countdown = setInterval(tick, 1000);
    fill(banner, 
      h('span.dot'),
      h('span', h('strong', 'DEMO DATA: simulated, not real market prices. '), reason ? reason + ' ' : '', retry),
      status.chosen
        ? h('button.btn', { onclick: () => setDemo(false) }, 'Switch to live data')
        : h('button.btn', { onclick: async (e) => { e.target.disabled = true; e.target.textContent = 'Checking…'; if (!(await retryLive())) { e.target.disabled = false; e.target.textContent = 'Try live now'; } } }, 'Try live now'),
    );
  } else if (mode === 'reconnected') {
    fill(banner, h('span.dot'), h('strong', reason));
  } else {
    fill(banner, h('span.dot'), 'Connecting to Binance…');
  }
}
status.listeners.add(paintStatus);
paintStatus(status.mode);

// New pump alerts show up on every screen once the catcher is running.
document.addEventListener('catcher-alert', (e) => {
  const { sig, text } = e.detail;
  const el = h('button.alert-toast', { onclick: () => { el.remove(); go('signal', sig.id); } }, h('strong', 'Pump alert '), text);
  let live = document.getElementById('alerts');
  if (!live) {
    live = h('div#alerts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(live);
  }
  live.append(el);
  setTimeout(() => el.remove(), 12000);
});

window.addEventListener('hashchange', render);
ensureMode().then(render);

// ---- Light / dark toggle ----
(function initTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : mq.matches;
  };
  const ns = 'http://www.w3.org/2000/svg';
  const icon = (dark) => {
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p = (tag, attrs) => {
      const e = document.createElementNS(ns, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      svg.append(e);
    };
    if (dark) {
      // currently dark -> show sun (switch to light)
      p('circle', { cx: 12, cy: 12, r: 4 });
      p('path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' });
    } else {
      p('path', { d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' });
    }
    return svg;
  };
  const render = () => {
    const dark = isDark();
    btn.replaceChildren(icon(dark));
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0a1215' : '#0b6e6a');
  };
  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('dw-theme', next); } catch (e) { /* ignore */ }
    render();
  });
  mq.addEventListener('change', render);
  render();
})();
