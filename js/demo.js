// Deterministic sample data used when Binance can't be reached.
// Numbers are invented; the UI labels them as demo data.

const COINS = [
  ['BTCUSDT', 67250], ['ETHUSDT', 3480], ['SOLUSDT', 168.4], ['XRPUSDT', 0.612], ['DOGEUSDT', 0.1584],
  ['BNBUSDT', 592.1], ['ADAUSDT', 0.452], ['AVAXUSDT', 34.21], ['LINKUSDT', 17.84], ['TONUSDT', 6.92],
  ['SUIUSDT', 1.912], ['PEPEUSDT', 0.0000124], ['WIFUSDT', 2.45], ['ARBUSDT', 0.812], ['OPUSDT', 1.94],
  ['NEARUSDT', 5.62], ['APTUSDT', 9.31], ['INJUSDT', 24.6], ['TIAUSDT', 7.88], ['SEIUSDT', 0.452],
  ['LTCUSDT', 81.3], ['DOTUSDT', 6.71], ['FILUSDT', 4.92], ['ATOMUSDT', 7.21], ['UNIUSDT', 9.84],
  ['AAVEUSDT', 142.5], ['ENAUSDT', 0.684], ['ORDIUSDT', 38.2], ['FETUSDT', 1.53], ['RNDRUSDT', 7.94],
  ['JUPUSDT', 1.08], ['BONKUSDT', 0.0000231], ['TRXUSDT', 0.1213], ['ETCUSDT', 26.4], ['HBARUSDT', 0.0921],
  ['XAUUSDT', 2384.5], ['ZECUSDT', 41.2], ['BCHUSDT', 452.1], ['STXUSDT', 2.11], ['IMXUSDT', 1.92],
];

function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Changes every 30s so the demo feels alive without being random noise.
const tick = () => Math.floor(Date.now() / 30_000);
const HOUR = 3_600_000;

export function market() {
  return COINS.map(([symbol, base], i) => {
    const r = rng(symbol + tick());
    const change = (r() - 0.45) * (i < 6 ? 8 : 22);
    const price = base * (1 + change / 100);
    return {
      symbol,
      price,
      change24h: change,
      quoteVolume: (4e9 / (i + 1) ** 1.1) * (0.7 + r() * 0.6),
      high: price * (1 + r() * 0.04),
      low: price * (1 - r() * 0.04),
      funding: (r() - 0.35) * 0.0006,
      nextFundingTime: Math.ceil(Date.now() / (8 * HOUR)) * 8 * HOUR,
      markPrice: price,
    };
  });
}

function walk(r, start, n, vol, lo = 0.03, hi = 0.97) {
  const out = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    v = Math.min(hi, Math.max(lo, v + (r() - 0.5) * vol));
    out.push(v);
  }
  return out;
}

export function positioning(symbol, period, limit) {
  const r = rng('pos' + symbol);
  const step = period === '5m' ? 300_000 : period === '4h' ? 4 * HOUR : HOUR;
  const now = Math.floor(Date.now() / step) * step;
  const t = (i) => now - (limit - 1 - i) * step;
  const whaleStart = r();
  const crowdStart = 0.25 + r() * 0.55;
  const whales = walk(r, whaleStart, limit, 0.08);
  const smart = whales.map((w) => Math.min(0.97, Math.max(0.03, w + (r() - 0.5) * 0.2)));
  const crowd = walk(r, crowdStart, limit, 0.03, 0.15, 0.9);
  const oi = walk(r, 0.5, limit, 0.06, 0.1, 1).map((x) => x * 4e8 * (1 + r()));
  return {
    whales: whales.map((long, i) => ({ t: t(i), long })),
    smart: smart.map((long, i) => ({ t: t(i), long })),
    crowd: crowd.map((long, i) => ({ t: t(i), long })),
    oi: oi.map((value, i) => ({ t: t(i), value })),
  };
}

export function candles(symbol, interval, limit) {
  const base = (COINS.find((c) => c[0] === symbol) || [symbol, 1])[1];
  const step = { '5m': 300_000, '15m': 900_000, '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR }[interval] || HOUR;
  const r = rng('c' + symbol + interval);
  const now = Math.floor(Date.now() / step) * step;
  let price = base * (0.9 + r() * 0.1);
  const out = [];
  for (let i = 0; i < limit; i++) {
    const o = price;
    const drift = (r() - 0.48) * 0.018;
    // Occasional pump candle so the scanner has something to find.
    const spike = r() > 0.97 ? (r() - 0.3) * 0.08 : 0;
    const c = o * (1 + drift + spike);
    const h = Math.max(o, c) * (1 + r() * 0.006);
    const l = Math.min(o, c) * (1 - r() * 0.006);
    const v = base * 2e4 * (0.5 + r()) * (spike ? 6 : 1);
    out.push({ t: now - (limit - 1 - i) * step, o, h, l, c, v });
    price = c;
  }
  return out;
}

export function fundingHistory(symbol, limit) {
  const r = rng('f' + symbol);
  const now = Math.floor(Date.now() / (8 * HOUR)) * 8 * HOUR;
  return Array.from({ length: limit }, (_, i) => ({ t: now - (limit - 1 - i) * 8 * HOUR, rate: (r() - 0.35) * 0.0005 }));
}

const liqRand = rng('liq');
export function liquidation() {
  const i = Math.floor(liqRand() ** 2 * COINS.length);
  const [symbol, base] = COINS[i];
  const usd = 500 + liqRand() ** 4 * 400_000;
  return { symbol, side: liqRand() > 0.45 ? 'long' : 'short', price: base, qty: usd / base, usd, t: Date.now() };
}
