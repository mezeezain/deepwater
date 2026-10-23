// App shell: navigation, routing by #hash, live/demo status.
import { status, ensureMode, setDemo } from './api.js';
import { h, $ } from './util.js';
import { whalesView } from './views/whales.js';
import { tokenView } from './views/token.js';
import { pumpsView } from './views/pumps.js';
import { fundingView } from './views/funding.js';
import { liquidationsView } from './views/liquidations.js';
import { heatmapView } from './views/heatmap.js';
import { calculatorView } from './views/calculator.js';

const ROUTES = {
  whales: { label: 'Whales', view: whalesView },
  pumps: { label: 'Pump scanner', view: pumpsView },
  liquidations: { label: 'Liquidations', view: liquidationsView },
  heatmap: { label: 'Heatmap', view: heatmapView },
  funding: { label: 'Funding', view: fundingView },
  calculator: { label: 'Calculator', view: calculatorView },
};

const main = $('#main');
const nav = $('#nav');
const banner = $('#status');
let dispose = () => {};

// Routes are bare hash tokens: #whales, #pumps, or a pair such as #SOLUSDT.
function parse() {
  const token = decodeURIComponent(location.hash.slice(1));
  if (ROUTES[token]) return { route: token };
  if (/^[A-Z0-9一-鿿]+USDT$/.test(token)) return { route: 'token', symbol: token };
  return { route: 'whales' };
}

export function go(route, symbol) {
  const hash = route === 'token' ? symbol : route;
  if (location.hash.slice(1) === hash) render();
  else location.hash = hash;
}

function render() {
  const { route, symbol } = parse();
  dispose();
  window.scrollTo(0, 0);
  nav.querySelectorAll('a').forEach((a) => a.setAttribute('aria-current', a.dataset.route === route ? 'page' : 'false'));
  const view = route === 'token' ? tokenView : ROUTES[route].view;
  dispose = view(main, { symbol, go }) || (() => {});
  document.title = route === 'token' ? `${symbol.replace(/USDT$/, '')} · Deepwater` : `Deepwater · ${ROUTES[route].label}`;
}

nav.replaceChildren(...Object.entries(ROUTES).map(([id, r]) => h('a', { href: '#' + id, 'data-route': id }, r.label)));

$('#jump').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#jump-input').value.trim().toUpperCase();
  if (!v) return;
  go('token', v.endsWith('USDT') ? v : v + 'USDT');
  $('#jump-input').value = '';
});

function paintStatus(mode, reason) {
  banner.dataset.mode = mode;
  if (mode === 'live') {
    banner.replaceChildren(h('span.dot'), 'Live data from Binance');
  } else if (mode === 'demo') {
    banner.replaceChildren(
      h('span.dot'),
      h('span', h('strong', 'Demo data. '), reason ? reason + ' ' : '', 'Numbers are made up so you can try every screen.'),
      h('button.link', { onclick: () => setDemo(false) }, 'Try live data'),
    );
  } else {
    banner.replaceChildren(h('span.dot'), 'Connecting to Binance…');
  }
}
status.listeners.add(paintStatus);
paintStatus(status.mode);

window.addEventListener('hashchange', render);
ensureMode().then(render);
