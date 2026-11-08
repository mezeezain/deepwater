// Runs the Trend radar (js/trend.js) and Fib pullbacks (js/fib.js) over many coins, on the same candles.
// Environment-agnostic: the server and the browser pass their own Binance `get`. Also builds demo rows.
import { radarRow, TREND } from './trend.js';
import { fibRow, FIB } from './fib.js';

export const RADAR_FRAMES = { '1h': 3_600_000, '4h': 14_400_000 };
export const RADAR_LIMIT = 300; // candles per coin: enough for EMA 50, ADX and 200 candles of levels

const toBars = (rows, ms, now) => rows.filter((k) => k[0] + ms <= now).map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] }));

/**
 * symbols: [{ symbol, volume24h }]. Returns { t, tf, scanned, rows, fib }: trend rows sorted newest trend first,
 * fib rows (coins in the first pullback after a pump) sorted by most recent high.
 * onProgress(done, total) is optional.
 */
export async function scanTrends({ get, symbols, tf, now = () => Date.now(), concurrency = 4, onProgress }) {
  const ms = RADAR_FRAMES[tf];
  if (!ms) throw new Error(`Unknown timeframe ${tf}`);
  const rows = [], fib = [];
  let done = 0, failed = 0;
  for (let i = 0; i < symbols.length; i += concurrency) {
    await Promise.all(symbols.slice(i, i + concurrency).map(async ({ symbol, volume24h }) => {
      try {
        const bars = toBars(await get('/fapi/v1/klines', { symbol, interval: tf, limit: RADAR_LIMIT }), ms, now());
        const r = radarRow(bars, TREND);
        if (r) rows.push(compact(symbol, volume24h, r));
        const f = fibRow(bars, FIB);
        if (f) fib.push(compactFib(symbol, volume24h, f));
      } catch {
        failed++;
      }
      onProgress?.(++done, symbols.length);
    }));
  }
  rows.sort((a, b) => a.age - b.age || b.adx - a.adx);
  fib.sort((a, b) => a.sinceHigh - b.sinceHigh);
  return { t: now(), tf, scanned: symbols.length - failed, rows, fib };
}

function compactFib(symbol, volume24h, f) {
  return {
    symbol,
    volume24h: volume24h ?? null,
    price: f.price,
    low: f.low,
    high: f.high,
    lowT: f.lowT,
    highT: f.highT,
    pumpPct: +f.pumpPct.toFixed(1),
    legCandles: f.legCandles,
    sinceHigh: f.sinceHigh,
    r: +f.r.toFixed(3),
    deepest: +f.deepest.toFixed(3),
    atLevel: f.atLevel,
    nearest: f.nearest,
    levels: f.levels.map((l) => ({ ratio: l.ratio, price: l.price, pct: +l.pct.toFixed(2) })),
  };
}

export function validFibRow(f) {
  const num = (v) => Number.isFinite(v);
  return !!f && /^[A-Z0-9一-鿿]{1,30}USDT$/.test(f.symbol) &&
    ['price', 'low', 'high', 'lowT', 'highT', 'pumpPct', 'legCandles', 'sinceHigh', 'r', 'deepest', 'nearest'].every((k) => num(f[k])) &&
    (f.atLevel == null || num(f.atLevel)) && Array.isArray(f.levels) && f.levels.every((l) => l && num(l.ratio) && num(l.price) && num(l.pct));
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
  const rows = [], fib = [];
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
    const vol = 5e6 + r() * 5e8;
    const row = radarRow(bars, TREND);
    if (row) rows.push({ ...compact(symbol, vol, row), demo: true });
    // About a quarter of the non-trending demo coins get a pump and a first pullback of random depth.
    if (!runLen && r() < 0.25) {
      const pb = [];
      const up = 12 + Math.floor(r() * 12), back = 2 + Math.floor(r() * 10), depth = 0.25 + r() * 0.55;
      const top = base * (1.18 + r() * 0.6);
      for (let i = 0; i < RADAR_LIMIT; i++) {
        const k = i - (RADAR_LIMIT - up - back);
        let c = base * (1 + (r() - 0.5) * 0.01);
        if (k >= 0 && k < up) c = base + ((top - base) * (k + 1)) / up;
        else if (k >= up) c = top - (top - base) * depth * ((k - up + 1) / back);
        const o = pb.at(-1)?.c ?? c;
        pb.push({ t: start + i * ms, o, h: Math.max(o, c) * (1 + r() * 0.004), l: Math.min(o, c) * (1 - r() * 0.004), c, v: 1e6 });
      }
      const f = fibRow(pb, FIB);
      if (f) fib.push({ ...compactFib(symbol, vol, f), demo: true });
    }
  }
  rows.sort((a, b) => a.age - b.age || b.adx - a.adx);
  fib.sort((a, b) => a.sinceHigh - b.sinceHigh);
  return { t: now, tf, scanned: names.length, rows, fib, demo: true };
}
