// Simulated futures market for the Pump Catcher's demo mode.
// Same interface as createBinanceSource(), so the scanner runs unchanged.
// Every pair name and number here is invented.
import { createSignal, updateSignal, THRESHOLD } from './pump.js';

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
      pumpedBefore: r() < 0.4, // demo history: 40% of pairs had an earlier pump, so the first-breakout filter has work to do
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

    async getTickers() {
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

    async getOpenInterest(symbol) {
      const p = bySymbol.get(symbol);
      return p ? (p.quoteVolume * 0.35) / p.price : null;
    },

    async getCandles1m(symbol, startTime) {
      return candlesFrom(bySymbol.get(symbol)?.path || [], 60_000, startTime);
    },

    async getCandles(symbol, interval, startTime) {
      const ms = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[interval] || 60_000;
      const p = bySymbol.get(symbol);
      const recent = candlesFrom(p?.path || [], ms, startTime);
      if (!p || !p.path.length || startTime >= p.path[0].t) return recent;
      return [...syntheticHistory(p, ms, startTime, p.path[0].t), ...recent];
    },
  };
}

/**
 * Invented older candles for a demo pair: a quiet range just above its 24h low, with an earlier +60% spike
 * for pairs marked pumpedBefore. Volume is a third of today's, so a pump in a quiet pair counts as a volume
 * breakout.
 */
function syntheticHistory(p, ms, from, to) {
  const r = rand(p.symbol.length * 7919 + p.symbol.charCodeAt(0));
  const base = p.low24h * 1.04;
  const spikeAt = to - (12 + r() * 14) * 86_400_000;
  const out = [];
  let level = base;
  for (let t = Math.floor(from / ms) * ms; t + ms <= to; t += ms) {
    level = Math.min(base * 1.12, Math.max(base * 0.92, level * (1 + (r() - 0.5) * 0.02)));
    const spike = p.pumpedBefore && Math.abs(t - spikeAt) < 18 * 3_600_000 ? 1 + 0.6 * (1 - Math.abs(t - spikeAt) / (18 * 3_600_000)) : 1;
    const c = level * spike;
    const o = c * (1 + (r() - 0.5) * 0.01);
    out.push({ t, o, h: Math.max(o, c) * (1 + r() * 0.008), l: Math.min(o, c) * (1 - r() * 0.008), c, v: (p.quoteVolume / 3) * (ms / 86_400_000) * (0.7 + r() * 0.6) });
  }
  return out;
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
 * Each signal is produced by running a made-up price path through the real tracking rules.
 */
export function demoHistory(market, now = Date.now()) {
  const r = rand(99);
  const out = [];
  const names = market.pairs.map((p) => p.symbol);
  for (let i = 0; i < 40; i++) {
    const symbol = names[5 + Math.floor(r() * (names.length - 5))];
    const alertT = Math.round(now - (0.05 + r() ** 1.3 * 29.5) * 86_400_000);
    const low = +(10 ** (r() * 3 - 2)).toPrecision(5);
    const price = low * (1 + THRESHOLD / 100) * (1 + r() * 0.004); // first tick at or just past the line
    const rangeHigh = low * (1.12 + r() * 0.1);
    const breakout = {
      rangeHigh,
      rangeLow: low * (0.9 + r() * 0.08),
      priorRise: 6 + r() * 15,
      baseRange: 18 + r() * 35,
      volMult: 2 + r() * 6,
      days: 40,
    };
    const sig = createSignal({ symbol, price, low24h: low, t: alertT, volume24h: 2e6 + r() ** 2 * 4e8, breakout: { ...breakout, checks: demoChecks(breakout, price) } });
    sig.oiUsd = sig.volume24h * (0.15 + r() * 0.4);
    // Random walk with a pump bias of varying strength: some reverse at once, most add a little, a few run hard.
    const strength = r() < 0.3 ? -0.0006 : r() ** 3 * 0.0016;
    let p = price;
    for (let m = 1; m < 30 * 1440 && sig.status === 'TRACKING' && alertT + m * 60_000 < now; m += m < 600 ? 1 : 15) {
      const fade = m > 60 + r() * 900 ? -strength * 0.5 : strength;
      p *= 1 + fade * Math.exp(-m / 500) + (r() - 0.5) * (m < 600 ? 0.006 : 0.02);
      updateSignal(sig, p, alertT + m * 60_000);
    }
    // A still-open example keeps being tracked against the simulated market's prices, so move it onto
    // that pair's current price level (percentages are unchanged); otherwise tracking jumps scales.
    const pair = market.pairs.find((x) => x.symbol === symbol);
    if (sig.status === 'TRACKING' && pair?.price > 0) {
      const k = pair.price / sig.lastPrice;
      for (const f of ['startPrice', 'alertPrice', 'lastPrice', 'peakPrice', 'lowSinceAlert', 'dipLow']) sig[f] *= k;
      sig.breakout.rangeHigh *= k;
      sig.breakout.rangeLow *= k;
    }
    sig.demo = true;
    out.push(sig);
  }
  // One move per pair at a time, as the live scanner does.
  out.sort((a, b) => b.alertT - a.alertT);
  const seen = new Set();
  for (const s of out) {
    if (s.status === 'TRACKING' && seen.has(s.symbol)) Object.assign(s, { status: 'CLOSED', closedT: s.lastT, closeReason: 'A new signal fired on this pair' });
    seen.add(s.symbol);
  }
  return out;
}

function demoChecks(b, price) {
  return [
    { id: 'history', label: 'At least 14 days of history', value: b.days, ok: true },
    { id: 'fresh', label: 'No earlier pump in 40 days', value: b.priorRise, ok: true },
    { id: 'breakout', label: 'First break above its 40-day high', value: ((price - b.rangeHigh) / b.rangeHigh) * 100, ok: true },
    { id: 'base', label: 'Out of a flat base', value: b.baseRange, ok: true },
    { id: 'volume', label: 'Volume at least 2× a normal day', value: b.volMult, ok: true },
  ];
}

/** Candles around a demo history signal, rebuilt from its numbers. */
export function demoSignalCandles(sig, ms = 900_000) {
  const r = rand(sig.alertT % 100000);
  const end = sig.closedT || Date.now();
  const start = Math.min(sig.alertT - 30 * ms, sig.alertT - 86_400_000);
  const pts = [];
  const dipT = sig.alertT + (sig.peakT - sig.alertT) * 0.2;
  const lowT = sig.alertT - (sig.alertT - start) * 0.35;
  const target = (t) => {
    if (t < lowT) return sig.startPrice * (1.08 - 0.08 * ((t - start) / (lowT - start || 1)));
    if (t < sig.alertT) return sig.startPrice + (sig.alertPrice - sig.startPrice) * ((t - lowT) / (sig.alertT - lowT || 1)) ** 2;
    if (t < dipT) return sig.alertPrice + (sig.dipLow - sig.alertPrice) * ((t - sig.alertT) / (dipT - sig.alertT || 1));
    if (t <= sig.peakT) return sig.dipLow + (sig.peakPrice - sig.dipLow) * ((t - dipT) / (sig.peakT - dipT || 1));
    return sig.peakPrice + (sig.lastPrice - sig.peakPrice) * ((t - sig.peakT) / (end - sig.peakT || 1));
  };
  const step = Math.max(ms / 4, (end - start) / 2000);
  for (let t = start; t <= end; t += step) pts.push({ t, price: Math.max(target(t), sig.startPrice * 0.999) * (1 + (r() - 0.5) * 0.004) });
  return candlesFrom(pts, ms, start);
}
