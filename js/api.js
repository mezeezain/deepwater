// Binance USDⓈ-M futures public data, with caching, a request queue and a demo fallback.
// Every endpoint used here is public and needs no API key.
import * as demo from './demo.js';

const BASE = 'https://fapi.binance.com';
const CACHE_MS = 60_000;
const MAX_CONCURRENT = 6;

const cache = new Map();
let active = 0;
const queue = [];

export const status = {
  mode: 'connecting', // 'live' | 'demo' | 'connecting'
  reason: '',
  listeners: new Set(),
  set(mode, reason = '') {
    this.mode = mode;
    this.reason = reason;
    this.listeners.forEach((fn) => fn(mode, reason));
  },
};

function forceDemo() {
  try {
    return new URLSearchParams(location.search).has('demo') || localStorage.getItem('dw:demo') === '1';
  } catch {
    return false;
  }
}

function runQueued(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active++;
    task().then(resolve, reject).finally(() => {
      active--;
      pump();
    });
  }
}

export async function get(path, params = {}, ttl = CACHE_MS) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;

  const data = await runQueued(async () => {
    const res = await fetch(url);
    if (res.status === 451 || res.status === 403) throw new Error('Binance blocks requests from your region (HTTP ' + res.status + ').');
    if (res.status === 429 || res.status === 418) throw new Error('Rate limited by Binance. Wait a minute and refresh.');
    if (!res.ok) throw new Error(`Binance returned HTTP ${res.status} for ${path}`);
    return res.json();
  });
  cache.set(url, { at: Date.now(), data });
  return data;
}

// Decide once whether live data is reachable.
let modePromise;
export function ensureMode() {
  if (!modePromise) {
    modePromise = (async () => {
      if (forceDemo()) {
        status.set('demo', 'Demo mode is switched on.');
        return 'demo';
      }
      try {
        await get('/fapi/v1/ping', {}, 0);
        status.set('live');
        return 'live';
      } catch (err) {
        const reason = err instanceof TypeError ? 'Binance could not be reached from this page.' : err.message;
        status.set('demo', reason);
        return 'demo';
      }
    })();
  }
  return modePromise;
}

export const isDemo = async () => (await ensureMode()) === 'demo';

/** All perpetual USDT pairs that are trading, with price, 24h stats and funding. */
export async function getMarket() {
  if (await isDemo()) return demo.market();
  const [info, tickers, premium] = await Promise.all([
    get('/fapi/v1/exchangeInfo', {}, 10 * 60_000),
    get('/fapi/v1/ticker/24hr'),
    get('/fapi/v1/premiumIndex'),
  ]);
  const tradable = new Set(
    info.symbols
      .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
      .map((s) => s.symbol),
  );
  const fundingBy = new Map(premium.map((p) => [p.symbol, p]));
  return tickers
    .filter((t) => tradable.has(t.symbol))
    .map((t) => {
      const p = fundingBy.get(t.symbol) || {};
      return {
        symbol: t.symbol,
        price: +t.lastPrice,
        change24h: +t.priceChangePercent,
        quoteVolume: +t.quoteVolume,
        high: +t.highPrice,
        low: +t.lowPrice,
        funding: p.lastFundingRate != null ? +p.lastFundingRate : null,
        nextFundingTime: p.nextFundingTime ? +p.nextFundingTime : null,
        markPrice: p.markPrice ? +p.markPrice : +t.lastPrice,
      };
    })
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
}

/**
 * Positioning for one symbol, hourly for the last 24h.
 * whales = top traders by position size, smart = top traders by account count, crowd = all accounts.
 */
export async function getPositioning(symbol, period = '1h', limit = 25) {
  if (await isDemo()) return demo.positioning(symbol, period, limit);
  const params = { symbol, period, limit };
  const [whales, smart, crowd, oi] = await Promise.all([
    get('/futures/data/topLongShortPositionRatio', params),
    get('/futures/data/topLongShortAccountRatio', params),
    get('/futures/data/globalLongShortAccountRatio', params),
    get('/futures/data/openInterestHist', params),
  ]);
  const toSeries = (rows) => rows.map((r) => ({ t: +r.timestamp, long: +r.longAccount }));
  return {
    whales: toSeries(whales),
    smart: toSeries(smart),
    crowd: toSeries(crowd),
    oi: oi.map((r) => ({ t: +r.timestamp, value: +r.sumOpenInterestValue })),
  };
}

/** Candles: [{ t, o, h, l, c, v }] */
export async function getCandles(symbol, interval = '1h', limit = 120) {
  if (await isDemo()) return demo.candles(symbol, interval, limit);
  const rows = await get('/fapi/v1/klines', { symbol, interval, limit }, 30_000);
  return rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] }));
}

export const CHART_INTERVALS = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

/**
 * Everything the indicator chart needs, aligned to one row per candle:
 * { t, o, h, l, c, v, takerBuy, oi, whaleLong, smartLong, crowdLong }
 * plus funding history and the pair's Binance futures listing date.
 * Binance keeps positioning history for 30 days and returns at most 500 rows.
 */
export async function getChartData(symbol, interval = '1h', limit = 300) {
  if (await isDemo()) return demo.chartData(symbol, interval, limit);
  const ms = CHART_INTERVALS[interval];
  const n = Math.min(limit, 500, Math.floor((30 * 86_400_000) / ms) - 1);
  const p = { symbol, period: interval, limit: n };
  const optional = (promise) => promise.catch(() => []);
  const [klines, oi, whales, smart, crowd, funding, info] = await Promise.all([
    get('/fapi/v1/klines', { symbol, interval, limit: n }, 30_000),
    optional(get('/futures/data/openInterestHist', p, 60_000)),
    optional(get('/futures/data/topLongShortPositionRatio', p, 60_000)),
    optional(get('/futures/data/topLongShortAccountRatio', p, 60_000)),
    optional(get('/futures/data/globalLongShortAccountRatio', p, 60_000)),
    optional(get('/fapi/v1/fundingRate', { symbol, limit: 200 }, 5 * 60_000)),
    get('/fapi/v1/exchangeInfo', {}, 10 * 60_000),
  ]);
  // Positioning rows are snapshots taken at the end of each period: map them to the candle they close.
  const slot = (ts) => Math.floor((+ts - 1) / ms) * ms;
  const index = (rows, field) => new Map(rows.map((r) => [slot(r.timestamp), +r[field]]));
  const oiBy = index(oi, 'sumOpenInterest');
  const wBy = index(whales, 'longAccount');
  const sBy = index(smart, 'longAccount');
  const cBy = index(crowd, 'longAccount');
  const bars = klines.map((k) => ({
    t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7], takerBuy: +k[10],
    oi: oiBy.get(k[0]) ?? null,
    whaleLong: wBy.get(k[0]) ?? null,
    smartLong: sBy.get(k[0]) ?? null,
    crowdLong: cBy.get(k[0]) ?? null,
  }));
  fillGaps(bars, ['oi', 'whaleLong', 'smartLong', 'crowdLong']);
  const meta = info.symbols.find((x) => x.symbol === symbol);
  return {
    bars,
    funding: funding.map((r) => ({ t: +r.fundingTime, rate: +r.fundingRate })),
    listedAt: meta?.onboardDate ?? null,
  };
}

/** Carry the last known value forward over short gaps (the newest candle often has no snapshot yet). */
function fillGaps(bars, fields) {
  for (const f of fields) {
    let last = null;
    let run = 0;
    for (const b of bars) {
      if (b[f] != null) {
        last = b[f];
        run = 0;
      } else if (last != null && ++run <= 2) b[f] = last;
    }
  }
}

/** Order book snapshot: { bids: [[price, qty]], asks: [[price, qty]] } */
export async function getDepth(symbol) {
  if (await isDemo()) return demo.depth(symbol);
  return get('/fapi/v1/depth', { symbol, limit: 1000 }, 10_000);
}

export async function getFundingHistory(symbol, limit = 30) {
  if (await isDemo()) return demo.fundingHistory(symbol, limit);
  const rows = await get('/fapi/v1/fundingRate', { symbol, limit }, 5 * 60_000);
  return rows.map((r) => ({ t: +r.fundingTime, rate: +r.fundingRate }));
}

/**
 * Live liquidation stream. Calls onEvent({ symbol, side, price, qty, usd, t }).
 * side is the side that got liquidated: 'long' or 'short'. Returns a stop function.
 */
export function streamLiquidations(onEvent) {
  let stopped = false;
  let ws;
  let timer;

  ensureMode().then((mode) => {
    if (stopped) return;
    if (mode === 'demo') {
      timer = setInterval(() => onEvent(demo.liquidation()), 700);
      return;
    }
    const connect = () => {
      ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
      ws.onmessage = (msg) => {
        const o = JSON.parse(msg.data).o;
        const qty = +o.z || +o.q;
        const price = +o.ap || +o.p;
        onEvent({
          symbol: o.s,
          // A SELL order closes a long, so the long side was liquidated.
          side: o.S === 'SELL' ? 'long' : 'short',
          price,
          qty,
          usd: qty * price,
          t: +o.T,
        });
      };
      ws.onclose = () => {
        if (!stopped) timer = setTimeout(connect, 3000);
      };
    };
    connect();
  });

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(timer);
    ws?.close();
  };
}

export function setDemo(on) {
  try {
    localStorage.setItem('dw:demo', on ? '1' : '0');
  } catch {}
  location.reload();
}
