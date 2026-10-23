// Simulated futures market for the pump catcher's demo mode.
// Same interface as createBinanceSource(), so the scanner runs unchanged.
// Every pair name and number here is invented.
import { createSignal, updateSignal } from './engine.js';

const NAMES = [
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'ADA', 'AVAX', 'LINK', 'TON', 'SUI', 'WIF', 'ARB', 'OP', 'NEAR', 'APT',
  'INJ', 'TIA', 'SEI', 'LTC', 'DOT', 'FIL', 'ATOM', 'UNI', 'AAVE', 'ENA', 'ORDI', 'FET', 'JUP', 'TRX', 'ETC', 'HBAR',
  'ZEC', 'BCH', 'STX', 'IMX', 'GALA', 'SAND', 'MANA', 'AXS', 'CRV', 'LDO', 'DYDX', 'GMX', 'PENDLE', 'RUNE', 'KAVA',
  'ROSE', 'CELO', 'ONE', 'ZIL', 'IOTA', 'XLM', 'ALGO', 'EGLD', 'FLOW', 'MINA', 'KSM', 'COMP', 'SNX', 'MKR', 'YFI',
  'SUSHI', 'BAND', 'ANKR', 'STORJ', 'SKL', 'CHZ', 'ENJ', 'MASK', 'API3', 'BLUR', 'ID', 'ARKM', 'CYBER', 'NTRN',
  'ALT', 'PIXEL', 'PORTAL', 'AEVO', 'ETHFI', 'OMNI', 'SAGA', 'REZ', 'NOT', 'IO', 'ZK', 'LISTA', 'BANANA', 'RARE',
];

function rand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDemoMarket({ now = () => Date.now(), seed = 7, tickMs = 1000 } = {}) {
  const r = rand(seed);
  const pairs = NAMES.map((n, i) => {
    const price = +(10 ** (r() * 5 - 2)).toPrecision(5);
    return {
      symbol: n + 'USDT',
      price,
      low24h: price * (1 - r() * 0.04),
      high24h: price * (1 + 0.05 + r() * 0.1),
      open24h: price * (1 + (r() - 0.5) * 0.06),
      quoteVolume: 3e9 / (i + 1) ** 1.2,
      mode: 'calm',
      left: 0,
      rate: 0,
      fake: false,
      lastPumpT: 0,
      path: [], // [{ t, price }] for charts and catch-up
    };
  });
  const bySymbol = new Map(pairs.map((p) => [p.symbol, p]));

  function step() {
    const t = now();
    for (const p of pairs) {
      if (p.mode === 'calm' && r() < 1 / 2500) {
        // Start a pump from close to the 24h low.
        p.price = p.low24h * (1.01 + r() * 0.02);
        p.mode = 'pump';
        p.left = 20 + Math.floor(r() * 70);
        p.rate = 0.003 + r() * 0.006;
        p.fake = r() < 0.3;
        p.lastPumpT = t;
      }
      let drift = (r() - 0.5) * 0.002;
      if (p.mode === 'pump') {
        drift += p.fake && p.left < 12 ? -p.rate * 1.6 : p.rate;
        if (--p.left <= 0) {
          p.mode = 'fade';
          p.left = 60 + Math.floor(r() * 120);
        }
      } else if (p.mode === 'fade') {
        drift += (r() - 0.6) * 0.004;
        if (--p.left <= 0) p.mode = 'calm';
      }
      p.price *= 1 + drift;
      p.low24h = Math.min(p.low24h, p.price);
      p.high24h = Math.max(p.high24h, p.price);
      p.path.push({ t, price: p.price });
      if (p.path.length > 4 * 3600) p.path.shift();
    }
  }

  const toTicker = (p) => ({
    symbol: p.symbol,
    price: p.price,
    low24h: p.low24h,
    high24h: p.high24h,
    change24h: ((p.price - p.open24h) / p.open24h) * 100,
    quoteVolume: p.quoteVolume,
    t: now(),
  });

  // Seven minutes of history so the scanner can measure 5m moves straight away.
  for (let i = 0; i < 420; i++) step();
  pairs.forEach((p) => p.path.forEach((pt, i) => (pt.t = now() - (p.path.length - i) * tickMs)));

  return {
    name: 'demo',
    pairs,

    async getUniverse() {
      return pairs.map(toTicker);
    },

    streamTickers(onBatch, onState = () => {}) {
      onState('open');
      const id = setInterval(() => {
        step();
        onBatch(pairs.map(toTicker));
      }, tickMs);
      return () => clearInterval(id);
    },

    async getPrice5mAgo(symbol) {
      const p = bySymbol.get(symbol);
      const target = now() - 5 * 60_000;
      return (p.path.find((x) => x.t >= target) || p.path[0])?.price ?? null;
    },

    async getContext(symbol) {
      const p = bySymbol.get(symbol);
      const hot = p.mode === 'pump' || now() - p.lastPumpT < 10 * 60_000;
      const strong = hot && !p.fake;
      const v = 1000 + r() * 500;
      const klines = Array.from({ length: 35 }, (_, i) => {
        const burst = i >= 30 && hot;
        const vol = v * (burst ? 2.5 + r() * 3 : 0.7 + r() * 0.6);
        const buy = vol * (burst ? (strong ? 0.58 + r() * 0.14 : 0.42 + r() * 0.1) : 0.45 + r() * 0.1);
        return { v: vol, takerBuy: buy };
      });
      const whale = strong ? 0.55 + r() * 0.25 : 0.3 + r() * 0.4;
      const crowd = strong ? 0.3 + r() * 0.2 : 0.45 + r() * 0.3;
      return {
        klines,
        oiChange: strong ? 1.6 + r() * 5 : (r() - 0.6) * 4,
        whaleLong: whale,
        crowdLong: crowd,
      };
    },

    async getCandles1m(symbol, startTime) {
      return candlesFrom(bySymbol.get(symbol)?.path || [], 60_000, startTime);
    },

    async getCandles(symbol, interval, startTime) {
      const ms = { '1m': 60_000, '5m': 300_000, '15m': 900_000 }[interval] || 60_000;
      return candlesFrom(bySymbol.get(symbol)?.path || [], ms, startTime);
    },
  };
}

function candlesFrom(path, ms, startTime = 0) {
  const out = [];
  for (const pt of path) {
    if (pt.t < startTime) continue;
    const bucket = Math.floor(pt.t / ms) * ms;
    const last = out[out.length - 1];
    if (!last || last.t !== bucket) out.push({ t: bucket, o: pt.price, h: pt.price, l: pt.price, c: pt.price, v: 0 });
    else {
      last.h = Math.max(last.h, pt.price);
      last.l = Math.min(last.l, pt.price);
      last.c = pt.price;
    }
  }
  return out;
}

/**
 * An invented 30-day log so the demo opens with history to look at.
 * Each signal is produced by running a made-up price path through the real engine.
 */
export function demoHistory(market, now = Date.now()) {
  const r = rand(99);
  const out = [];
  const names = market.pairs.map((p) => p.symbol);
  for (let i = 0; i < 26; i++) {
    const symbol = names[5 + Math.floor(r() * (names.length - 5))];
    const alertT = now - (0.3 + r() ** 1.4 * 29.5) * 86_400_000;
    const price = +(10 ** (r() * 3 - 2)).toPrecision(5);
    const sig = createSignal({
      symbol,
      price,
      t: alertT,
      rise: 4.5 + r() * 9,
      impulse: 1.5 + r() * 3,
      ctx: { rvol: 2.5 + r() * 5, takerBuy: 0.56 + r() * 0.15, oiChange: 1.5 + r() * 6, whaleLong: 0.55 + r() * 0.3, crowdLong: 0.3 + r() * 0.2 },
    });
    sig.gap = (sig.whaleLong - sig.crowdLong) * 100;
    // Random walk with a pump bias of varying strength; some fail straight away.
    // Roughly: a quarter fail at once, most add a few percent, a few run hard.
    const strength = r() < 0.25 ? -0.0004 : r() ** 3 * 0.0012;
    let p = price;
    for (let m = 1; m < 72 * 60 && sig.status === 'TRACKING' && alertT + m * 60_000 < now; m++) {
      const fade = m > 60 + r() * 600 ? -strength * 0.6 : strength;
      p *= 1 + fade * Math.exp(-m / 400) + (r() - 0.5) * 0.006;
      updateSignal(sig, p, alertT + m * 60_000);
    }
    sig.demo = true;
    out.push(sig);
  }
  return out.sort((a, b) => b.alertT - a.alertT);
}

/** Candles around a demo history signal, rebuilt from its numbers. */
export function demoSignalCandles(sig, ms = 300_000) {
  const r = rand(sig.alertT % 100000);
  const end = sig.closedT || Date.now();
  const start = sig.alertT - 12 * ms;
  const pts = [];
  const dipT = sig.alertT + (sig.peakT - sig.alertT) * 0.2;
  const target = (t) => {
    if (t < sig.alertT) return sig.alertPrice * (1 - 0.05 * (1 - (t - start) / (sig.alertT - start)));
    if (t < dipT) return sig.alertPrice * (1 + (sig.dip / 100) * ((t - sig.alertT) / (dipT - sig.alertT || 1)));
    if (t <= sig.peakT) {
      const k = (t - dipT) / (sig.peakT - dipT || 1);
      return sig.alertPrice * (1 + sig.dip / 100) + (sig.peakPrice - sig.alertPrice * (1 + sig.dip / 100)) * k;
    }
    const k = (t - sig.peakT) / (end - sig.peakT || 1);
    return sig.peakPrice + (sig.lastPrice - sig.peakPrice) * k;
  };
  for (let t = start; t <= end; t += ms / 4) pts.push({ t, price: target(t) * (1 + (r() - 0.5) * 0.004) });
  return candlesFrom(pts, ms, start);
}
