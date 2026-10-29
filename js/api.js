// Binance USDⓈ-M futures public data, with caching, a request queue and a demo fallback.
// Every endpoint used here is public and needs no API key.
import * as demo from './demo.js';
import { labDataFrom, fillGaps } from './setup-feed.js';
import { demoSnapshots } from './smartmoney-demo.js';
import { pickCohort, summarize } from './smartmoney.js';
import { cleanServerUrl } from './validate.js';

const BASE = 'https://fapi.binance.com';
const CACHE_MS = 60_000;
const MAX_CONCURRENT = 6;

const cache = new Map();
let active = 0;
const queue = [];

export const status = {
  mode: 'connecting', // 'live' | 'demo' | 'connecting' | 'reconnected'
  reason: '',
  chosen: false, // true when the viewer asked for demo (?demo), false when Binance couldn't be reached
  nextRetry: null, // time of the next automatic check, while in fallback demo
  listeners: new Set(),
  set(mode, reason = '', extra = {}) {
    this.mode = mode;
    this.reason = reason;
    Object.assign(this, extra);
    this.listeners.forEach((fn) => fn(mode, reason));
  },
};

// Demo only when the address says so (?demo). It never sticks between visits.
function forceDemo() {
  try {
    localStorage.removeItem('dw:demo'); // older versions remembered demo mode; drop that
  } catch {}
  try {
    return new URLSearchParams(location.search).has('demo');
  } catch {
    return false;
  }
}

function explain(err) {
  if (/451|403/.test(err?.message || '')) return 'Binance blocks its futures data in your region (HTTP 451/403), so this page can’t show real prices here.';
  if (/429|418/.test(err?.message || '')) return 'Binance is rate-limiting this connection.';
  return 'Binance couldn’t be reached from this page (a network problem or a regional block).';
}

// Retry delays after a failed check: 10 s, 30 s, 1 min, 2 min, then every 5 min.
const RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
function scheduleRetry(attempt) {
  const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
  status.set('demo', status.reason, { nextRetry: Date.now() + wait });
  setTimeout(async () => {
    try {
      await get('/fapi/v1/ping', {}, 0);
      // Everything loaded so far is simulated; reload so every screen starts again from live data.
      status.set('reconnected', 'Binance is reachable again. Switching to live data…');
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      status.reason = explain(err);
      scheduleRetry(attempt + 1);
    }
  }, wait);
}

/** Check Binance again now (the banner's "Try live now" button). */
export async function retryLive() {
  try {
    await get('/fapi/v1/ping', {}, 0);
    status.set('reconnected', 'Binance is reachable again. Switching to live data…');
    setTimeout(() => location.reload(), 800);
    return true;
  } catch (err) {
    status.set('demo', explain(err), { nextRetry: status.nextRetry });
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
        status.set('demo', 'You opened the demo version of this page.', { chosen: true });
        return 'demo';
      }
      // A brief blip shouldn't drop the whole session into demo: try three times before giving up.
      let lastErr;
      for (let i = 0; i < 3; i++) {
        try {
          await get('/fapi/v1/ping', {}, 0);
          status.set('live');
          return 'live';
        } catch (err) {
          lastErr = err;
          if (/451|403/.test(err?.message || '')) break; // a region block won't change in a second
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      status.set('demo', explain(lastErr), { chosen: false });
      scheduleRetry(0);
      return 'demo';
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

/**
 * Positioning for many symbols at once: Map(symbol -> positioning). The whale data server keeps the same four
 * series for its tracked pairs and serves them in one request; anything it does not have is fetched directly
 * from Binance, a few at a time. onProgress(done, total) is called as pairs complete.
 */
export async function getPositioningMap(symbols, onProgress = () => {}) {
  const out = new Map();
  const total = symbols.length;
  let done = 0;
  const tick = () => onProgress(++done, total);
  if (!(await isDemo())) {
    try {
      const body = await fromServer('/api/positioning', 120_000);
      if (body && Date.now() - body.t < 30 * 60_000) {
        for (const r of body.rows) if (validPositioningRow(r)) out.set(r.symbol, r);
      }
    } catch {
      // The server being down only means falling back to Binance directly.
    }
  }
  for (const sym of symbols) if (out.has(sym)) tick();
  await Promise.all(symbols.filter((sym) => !out.has(sym)).map(async (sym) => {
    try {
      out.set(sym, await getPositioning(sym));
    } catch {
      // A pair without positioning data (new listing) is skipped.
    }
    tick();
  }));
  return out;
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
  // When the newest positioning snapshot was taken (before short gaps are filled forward).
  const lastPos = [...bars].reverse().find((b) => b.crowdLong != null || b.oi != null);
  const positioningAsOf = lastPos ? lastPos.t + ms : null;
  fillGaps(bars, ['oi', 'whaleLong', 'smartLong', 'crowdLong']);
  const meta = info.symbols.find((x) => x.symbol === symbol);
  return {
    bars,
    positioningAsOf,
    funding: funding.map((r) => ({ t: +r.fundingTime, rate: +r.fundingRate })),
    listedAt: meta?.onboardDate ?? null,
  };
}

/**
 * Longer history for the setups lab: up to 1,500 closed candles, top-trader and all-accounts long share
 * for the last 30 days (all Binance keeps), and funding payments. Bars older than 30 days have no
 * positioning, which the lab reports as "no whale data".
 */
export async function getLabData(symbol, interval = '1h') {
  if (await isDemo()) {
    const d = demo.chartData(symbol, interval, 500);
    return { bars: d.bars.slice(0, -1), funding: d.funding, positioningFrom: d.bars[0].t };
  }
  const ms = CHART_INTERVALS[interval];
  const [klines, whales, crowd, funding] = await Promise.all([
    get('/fapi/v1/klines', { symbol, interval, limit: 1500 }, 60_000),
    positioningHistory('/futures/data/topLongShortPositionRatio', symbol, interval),
    positioningHistory('/futures/data/globalLongShortAccountRatio', symbol, interval),
    get('/fapi/v1/fundingRate', { symbol, limit: 1000 }, 10 * 60_000).catch(() => []),
  ]);
  return labDataFrom({ klines, whales, crowd, funding }, ms);
}

/** Latest trade price for a few pairs: Map(symbol → price). */
export async function getPrices(symbols) {
  if (await isDemo()) return new Map(demo.market().filter((m) => symbols.includes(m.symbol)).map((m) => [m.symbol, m.price]));
  const rows = await Promise.all(symbols.map((symbol) => get('/fapi/v1/ticker/price', { symbol }, 4_000).catch(() => null)));
  return new Map(rows.filter(Boolean).map((r) => [r.symbol, +r.price]));
}

/** Positioning rows for the last 30 days, paged backwards 500 at a time. */
async function positioningHistory(path, symbol, period) {
  const from = Date.now() - 30 * 86_400_000 + 60_000;
  const out = [];
  let end = Date.now();
  for (let page = 0; page < 10 && end > from; page++) {
    let rows;
    try {
      rows = await get(path, { symbol, period, limit: 500, endTime: end }, 5 * 60_000);
    } catch {
      break; // older pages are refused once past 30 days; keep what we have
    }
    if (!rows.length) break;
    out.push(...rows);
    const earliest = Math.min(...rows.map((r) => +r.timestamp));
    if (rows.length < 500 || earliest >= end) break;
    end = earliest - 1;
  }
  return out;
}

// ---------------------------------------------------------------- exact whale data (whale data server)
// Binance's Smart Money numbers (whale headcount, position value, average entry, unrealized PnL) come
// from its website API, which browsers can't call from another site. worker/smartmoney.mjs polls it and
// serves the results; the app reads them from the address saved here.

// The server this site uses by default, so every device and visitor gets exact whale data and the
// shared signal log without setting anything up. Change it if you fork the project.
export const DEFAULT_WHALE_SERVER = 'https://deepwater-whales.duckdns.org';

export const whaleServer = {
  /** Saved address; the default when nothing is saved; '' after the viewer chose Disconnect. */
  get() {
    try {
      const saved = localStorage.getItem('dw:whale-server');
      if (saved == null) return DEFAULT_WHALE_SERVER;
      return saved === '' ? '' : cleanServerUrl(saved) || DEFAULT_WHALE_SERVER; // ignore a tampered or old unsafe value
    } catch {
      return DEFAULT_WHALE_SERVER;
    }
  },
  reset() {
    try {
      localStorage.removeItem('dw:whale-server');
    } catch {}
    cache.clear();
  },
  set(url) {
    const clean = url ? cleanServerUrl(url) : '';
    if (clean == null) throw new Error('Use an https:// address (http:// is allowed only for localhost).');
    try {
      localStorage.setItem('dw:whale-server', clean);
    } catch {}
    cache.clear();
  },
};

async function fromServer(path, ttl) {
  const base = whaleServer.get();
  if (!base) return null;
  const url = base + path;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Whale data server returned HTTP ${res.status}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

/** Check a whale data server address. Returns its health report or throws a readable error. */
export async function testWhaleServer(url) {
  const base = cleanServerUrl(url);
  if (!base) throw new Error('Use an https:// address (http:// is allowed only for localhost).');
  let res;
  try {
    res = await fetch(base + '/api/health');
  } catch {
    throw new Error('Could not reach that address. Check the URL, that the server is running, and that it allows requests from this site (ALLOW_ORIGIN).');
  }
  if (!res.ok) throw new Error(`The server answered HTTP ${res.status}. Is this the whale data server?`);
  return res.json();
}

function demoHistoryFor(symbol) {
  const { bars } = demo.chartData(symbol, '5m', 500);
  return demoSnapshots(symbol, bars, (b) => b.oi * b.c);
}

/**
 * Latest exact whale numbers for every pair the server tracks.
 * Returns { source: 'server' | 'demo', rows: Map(symbol -> row) } or null when no server is set.
 * row: { symbol, t, cohort, shown, whale, smart } where shown/whale/smart come from summarize().
 */
export async function getSmartOverview() {
  if (await isDemo()) {
    const key = 'demo-smart-overview';
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.data;
    const rows = new Map();
    for (const m of demo.market()) {
      const s = demoHistoryFor(m.symbol).at(-1);
      const cohort = pickCohort(s);
      rows.set(m.symbol, { symbol: m.symbol, t: s.t, cohort, shown: summarize(s, cohort, s.oiUsd), whale: summarize(s, 'whale', s.oiUsd), smart: summarize(s, 'smart', s.oiUsd) });
    }
    const data = { source: 'demo', rows };
    cache.set(key, { at: Date.now(), data });
    return data;
  }
  const body = await fromServer('/api/overview', 60_000);
  if (!body) return null;
  return { source: 'server', rows: new Map(body.rows.filter(validOverviewRow).map((r) => [r.symbol, r])) };
}

export function validPositioningRow(r) {
  const okSeries = (a) => Array.isArray(a) && a.length > 0 && a.every((p) => Number.isFinite(p?.t) && Number.isFinite(p?.long) && p.long >= 0 && p.long <= 1);
  return !!r && typeof r.symbol === 'string' && /^[A-Z0-9]{1,30}USDT$/.test(r.symbol) && okSeries(r.whales) && okSeries(r.crowd) && okSeries(r.smart)
    && Array.isArray(r.oi) && r.oi.every((p) => Number.isFinite(p?.t) && Number.isFinite(p?.value));
}

/**
 * A server row is only used when it looks like one: a real symbol, shares between 0 and 1. The server is a third party
 * from the browser's point of view, so a broken or hijacked one can't push absurd numbers into the tables.
 */
export function validOverviewRow(r) {
  const share = r?.shown?.longShare;
  return !!r && typeof r.symbol === 'string' && /^[A-Z0-9]{1,30}USDT$/.test(r.symbol) && (share == null || (Number.isFinite(share) && share >= 0 && share <= 1));
}

/** Snapshot history for one pair (oldest first), or null when unavailable. */
export async function getSmartHistory(symbol) {
  if (await isDemo()) return { source: 'demo', snapshots: demoHistoryFor(symbol) };
  const body = await fromServer(`/api/symbol/${encodeURIComponent(symbol)}`, 60_000);
  return body ? { source: 'server', snapshots: body.snapshots, mark: body.mark } : null;
}

/**
 * Whether the futures pair's base coin trades against USDT on Binance spot: true, false, or null if unknown.
 * Used to warn that futures positioning doesn't map one-to-one to spot (or that there is no spot market).
 */
const spotCache = new Map();
export async function spotListed(symbol) {
  if (await isDemo()) return null;
  if (spotCache.has(symbol)) return spotCache.get(symbol);
  // Futures-only multipliers like 1000PEPEUSDT trade on spot as PEPEUSDT.
  const spotSymbol = symbol.replace(/^1000+|^1M/, '');
  let listed = null;
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(spotSymbol)}`);
    listed = res.ok ? true : res.status === 400 ? false : null;
  } catch {
    listed = null;
  }
  spotCache.set(symbol, listed);
  return listed;
}

/** Order book snapshot: { bids: [[price, qty]], asks: [[price, qty]] } */
export async function getDepth(symbol) {
  if (await isDemo()) return demo.depth(symbol);
  return get('/fapi/v1/depth', { symbol, limit: 1000 }, 10_000);
}

/**
 * Funding interval in hours per symbol (most are 8, some pairs settle every 4 or 1).
 * Returns Map(symbol -> hours); symbols missing from the map use the 8 h default.
 */
export async function getFundingIntervals() {
  if (await isDemo()) return new Map();
  try {
    const rows = await get('/fapi/v1/fundingInfo', {}, 60 * 60_000);
    return new Map(rows.filter((r) => r.fundingIntervalHours).map((r) => [r.symbol, +r.fundingIntervalHours]));
  } catch {
    return new Map();
  }
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
    let delay = 3000;
    const connect = () => {
      ws = new WebSocket('wss://fstream.binance.com/market/ws/!forceOrder@arr');
      ws.onmessage = (msg) => {
        delay = 3000;
        let o;
        try {
          o = JSON.parse(msg.data).o;
        } catch {
          return;
        }
        if (!o) return;
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
        if (!stopped) {
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 60_000);
        }
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
  const url = new URL(location.href);
  if (on) url.searchParams.set('demo', '');
  else url.searchParams.delete('demo');
  location.href = url.toString();
}
