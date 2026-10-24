// App shell: navigation, routing by #hash, live/demo status.
import { status, ensureMode, setDemo, retryLive } from './api.js';
import { h, $, store } from './util.js';
import { whalesView } from './views/whales.js';
import { tokenView } from './views/token.js';
import { pumpsView } from './views/pumps.js';
import { signalView } from './views/signal.js';
import { liqmapView } from './views/liqmap.js';
import { fundingView } from './views/funding.js';
import { liquidationsView } from './views/liquidations.js';
import { heatmapView } from './views/heatmap.js';
import { calculatorView } from './views/calculator.js';
import { setupsView } from './views/setups.js';

const ROUTES = {
  whales: { label: 'Whales', view: whalesView },
  pumps: { label: 'Pump catcher', view: pumpsView },
  charts: { label: 'Charts', view: (root, ctx) => tokenView(root, { ...ctx, symbol: store.get('last-pair', 'BTCUSDT') }) },
  setups: { label: 'Setups lab', view: setupsView },
  liqmap: { label: 'Liq map', view: liqmapView },
  liquidations: { label: 'Liquidations', view: liquidationsView },
  heatmap: { label: 'Heatmap', view: heatmapView },
  funding: { label: 'Funding', view: fundingView },
  calculator: { label: 'Calculator', view: calculatorView },
};

const main = $('#main');
const nav = $('#nav');
const banner = $('#status');
let dispose = () => {};

// Routes are bare hash tokens: #whales, #pumps, a pair such as #SOLUSDT, or a signal: #sig-SOLUSDT-1730000000000.
function parse() {
  const token = decodeURIComponent(location.hash.slice(1));
  if (ROUTES[token]) return { route: token };
  if (token.startsWith('sig-')) return { route: 'signal', id: token.slice(4) };
  if (token.startsWith('liqmap-')) return { route: 'liqmap', symbol: token.slice(7) };
  if (/^[A-Z0-9\u4e00-\u9fff]+USDT$/.test(token)) return { route: 'token', symbol: token };
  return { route: 'whales' };
}

export function go(route, arg) {
  const hash = route === 'token' ? arg : route === 'signal' ? `sig-${arg}` : route === 'liqmap' && arg ? `liqmap-${arg}` : route;
  if (location.hash.slice(1) === hash) render();
  else location.hash = hash;
}

function render() {
  const { route, symbol, id } = parse();
  dispose();
  window.scrollTo(0, 0);
  const navRoute = route === 'signal' ? 'pumps' : route === 'token' ? 'charts' : route;
  nav.querySelectorAll('a').forEach((a) => a.setAttribute('aria-current', a.dataset.route === navRoute ? 'page' : 'false'));
  const view = route === 'token' ? tokenView : route === 'signal' ? signalView : ROUTES[route].view;
  dispose = view(main, { symbol, id, go }) || (() => {});
  document.title = (status.mode === 'demo' ? 'DEMO · ' : '') + (
    route === 'token' ? `${symbol.replace(/USDT$/, '')} · Deepwater`
    : route === 'liqmap' && symbol ? `${symbol.replace(/USDT$/, '')} liquidation map · Deepwater`
    : route === 'signal' ? `${id.split('-')[0].replace(/USDT$/, '')} signal · Deepwater`
    : `Deepwater · ${ROUTES[route].label}`);
}

nav.replaceChildren(...Object.entries(ROUTES).map(([id, r]) => h('a', { href: '#' + id, 'data-route': id }, r.label)));

$('#jump').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#jump-input').value.trim().toUpperCase();
  if (!v) return;
  go('token', v.endsWith('USDT') ? v : v + 'USDT');
  $('#jump-input').value = '';
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
    banner.replaceChildren(h('span.dot'), 'Live data from Binance');
  } else if (mode === 'demo') {
    const retry = h('span.retry');
    const tick = () => {
      const s = status.nextRetry ? Math.max(0, Math.round((status.nextRetry - Date.now()) / 1000)) : null;
      retry.textContent = status.chosen ? '' : s != null ? `Checking Binance again in ${s} s.` : '';
    };
    tick();
    if (!status.chosen) countdown = setInterval(tick, 1000);
    banner.replaceChildren(
      h('span.dot'),
      h('span', h('strong', 'DEMO DATA: simulated, not real market prices. '), reason ? reason + ' ' : '', retry),
      status.chosen
        ? h('button.btn', { onclick: () => setDemo(false) }, 'Switch to live data')
        : h('button.btn', { onclick: async (e) => { e.target.disabled = true; e.target.textContent = 'Checking…'; if (!(await retryLive())) { e.target.disabled = false; e.target.textContent = 'Try live now'; } } }, 'Try live now'),
    );
  } else if (mode === 'reconnected') {
    banner.replaceChildren(h('span.dot'), h('strong', reason));
  } else {
    banner.replaceChildren(h('span.dot'), 'Connecting to Binance…');
  }
}
status.listeners.add(paintStatus);
paintStatus(status.mode);

// New pump alerts show up on every screen once the catcher is running.
document.addEventListener('catcher-alert', (e) => {
  const { sig, text } = e.detail;
  const el = h('button.alert-toast', { onclick: () => { el.remove(); go('signal', sig.id); } }, h('strong', 'Pump alert '), text);
  document.body.append(el);
  setTimeout(() => el.remove(), 8000);
});

window.addEventListener('hashchange', render);
ensureMode().then(render);
