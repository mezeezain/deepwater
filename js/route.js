// Pure hash parsing, kept separate from the DOM so it can be unit-tested.
// Routes are bare hash tokens: #whales, #pumps, a pair such as #SOLUSDT, a signal #sig-SOLUSDT-1730000000000,
// a liquidation map #liqmap-SOLUSDT. An optional query may follow: #SOLUSDT?i=4h
export const ROUTE_IDS = ['whales', 'pumps', 'charts', 'ideas', 'setups', 'liqmap', 'liquidations', 'heatmap', 'funding', 'calculator', 'guide'];
const SYMBOL = /^[A-Z0-9一-鿿]{1,30}USDT$/;

export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // malformed escape such as %E0%A4%A
  }
}

/** @returns {{route:string, symbol?:string, id?:string, params:Object<string,string>, unknown?:boolean}} */
export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  const params = {};
  if (q !== -1) for (const [k, v] of new URLSearchParams(raw.slice(q + 1))) if (!(k in params)) params[k] = v;
  const token = safeDecode(path);
  if (token == null) return { route: 'whales', params: {}, unknown: true };
  if (ROUTE_IDS.includes(token)) return { route: token, params };
  if (token.startsWith('sig-') && token.length > 4) return { route: 'signal', id: token.slice(4), params };
  if (token.startsWith('liqmap-') && SYMBOL.test(token.slice(7))) return { route: 'liqmap', symbol: token.slice(7), params };
  if (SYMBOL.test(token)) return { route: 'token', symbol: token, params };
  return { route: 'whales', params: {}, unknown: token !== '' };
}

/** Build the hash for a route; the inverse of parseHash. */
export function buildHash(route, arg, params) {
  const base = route === 'token' ? arg : route === 'signal' ? `sig-${arg}` : route === 'liqmap' && arg ? `liqmap-${arg}` : route;
  const qs = params && Object.keys(params).length ? '?' + new URLSearchParams(params).toString().replace(/%2C/g, ',') : '';
  return base + qs;
}

/** What to type into the pair box: "sol", "SOLUSDT", "1000pepe" -> a symbol, or null if it can't be one. */
export function normalizePair(input) {
  const v = String(input || '').trim().toUpperCase().replace(/[\s/_-]+/g, '');
  if (!v) return null;
  const sym = v.endsWith('USDT') ? v : v + 'USDT';
  return SYMBOL.test(sym) ? sym : null;
}
