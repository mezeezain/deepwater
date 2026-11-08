// Runs the Trend radar (js/trend.js) over many coins. Environment-agnostic: the server and the browser pass
// their own Binance `get`. Also builds the invented rows for demo mode.
import { radarRow, TREND } from './trend.js';

export const RADAR_FRAMES = { '1h': 3_600_000, '4h': 14_400_000 };
export const RADAR_LIMIT = 300; // candles per coin: enough for EMA 50, ADX and 200 candles of levels

const toBars = (rows, ms, now) => rows.filter((k) => k[0] + ms <= now).map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] }));

/**
 * symbols: [{ symbol, volume24h }]. Returns { t, tf, scanned, rows } with rows sorted newest trend first.
 * onProgress(done, total) is optional.
 */
export async function scanTrends({ get, symbols, tf, now = () => Date.now(), concurrency = 4, onProgress }) {
  const ms = RADAR_FRAMES[tf];
  if (!ms) throw new Error(`Unknown timeframe ${tf}`);
  const rows = [];
  let done = 0, failed = 0;
  for (let i = 0; i < symbols.length; i += concurrency) {
    await Promise.all(symbols.slice(i, i + concurrency).map(async ({ symbol, volume24h }) => {
      try {
        const bars = toBars(await get('/fapi/v1/klines', { symbol, interval: tf, limit: RADAR_LIMIT }), ms, now());
        const r = radarRow(bars, TREND);
        if (r) rows.push(compact(symbol, volume24h, r));
      } catch {
        failed++;
      }
      onProgress?.(++done, symbols.length);
    }));
  }
  rows.sort((a, b) => a.age - b.age || b.adx - a.adx);
  return { t: now(), tf, scanned: symbols.length - failed, rows };
}

/** Only what the page shows, rounded, so the server's response stays small. */
function compact(symbol, volume24h, r) {
  const lv = (l) => (l ? { price: l.price, pct: +l.pct.toFixed(2), atr: +l.atr.toFixed(2), touches: l.touches } : null);
  return {
    symbol,
    volume24h: volume24h ?? null,
    side: r.side,
    age: r.age,
    startT: r.startT,
    startPrice: r.startPrice,
    price: r.price,
    movePct: +r.movePct.toFixed(2),
    adx: +r.adx.toFixed(1),
    extension: +r.extension.toFixed(2),
    stretched: r.stretched,
    volRatio: r.volRatio == null ? null : +r.volRatio.toFixed(2),
    zone: r.zone,
    support: lv(r.support),
    resistance: lv(r.resistance),
  };
}

/** Shape check for rows from a server. */
export function validRadarRow(r) {
  const num = (v) => Number.isFinite(v);
  const lvOk = (l) => l == null || (num(l.price) && num(l.pct) && num(l.atr));
  return !!r && /^[A-Z0-9一-鿿]{1,30}USDT$/.test(r.symbol) && (r.side === 1 || r.side === -1) &&
    ['age', 'startT', 'startPrice', 'price', 'movePct', 'adx', 'extension'].every((k) => num(r[k])) &&
    ['support', 'resistance', 'open', 'clear'].includes(r.zone) && lvOk(r.support) && lvOk(r.resistance);
}

/** Invented radar for demo mode: real rules run over made-up candles. */
export function demoTrends(tf, names, now = Date.now()) {
  const ms = RADAR_FRAMES[tf];
  let seed = tf === '1h' ? 11 : 29;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rows = [];
  for (const symbol of names) {
    const base = 10 ** (r() * 4 - 1);
    const runLen = r() < 0.3 ? 2 + Math.floor(r() * 12) : 0; // about 30% of demo coins trend
    const side = r() < 0.6 ? 1 : -1;
    const step = base * (0.004 + r() * 0.012) * side;
    const bars = [];
    const start = Math.floor(now / ms) * ms - RADAR_LIMIT * ms;
    let c = base;
    for (let i = 0; i < RADAR_LIMIT; i++) {
      const trending = i >= RADAR_LIMIT - runLen;
      const o = c;
      c = trending ? c + step * (0.6 + r()) : base * (1 + (r() - 0.5) * 0.02);
      const hi = Math.max(o, c) * (1 + r() * 0.012), lo = Math.min(o, c) * (1 - r() * 0.012);
      bars.push({ t: start + i * ms, o, h: hi, l: lo, c, v: (trending ? 2 : 1) * (0.5 + r()) * 1e6 });
    }
    const row = radarRow(bars, TREND);
    if (row) rows.push({ ...compact(symbol, 5e6 + r() * 5e8, row), demo: true });
  }
  rows.sort((a, b) => a.age - b.age || b.adx - a.adx);
  return { t: now, tf, scanned: names.length, rows, demo: true };
}
