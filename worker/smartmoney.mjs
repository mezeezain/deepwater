#!/usr/bin/env node
// Whale data server: polls Binance's Smart Money overview for each pair, keeps snapshot history,
// and serves it to the web app (browsers can't call Binance's website API directly).
// Node 22+, no dependencies.
//
//   node worker/smartmoney.mjs --probe BTCUSDT   # show the raw response and how it was understood
//   node worker/smartmoney.mjs                   # poll and serve on http://localhost:8787
//   node worker/smartmoney.mjs --demo            # simulated data, no network
//
// Settings (environment variables):
//   PORT=8787           HTTP port
//   TOP=120             how many pairs to poll, by 24h volume (all pairs: TOP=1000)
//   RATE_MS=1200        delay between Binance website requests (keep this polite)
//   KEEP_HOURS=720      snapshot history kept per pair (Binance updates slowly, so keep weeks)
//   HOST=127.0.0.1      address to listen on (use 0.0.0.0 only without a reverse proxy)
//   ALLOW_ORIGIN=...    comma-separated origins allowed to read the API (default: the Deepwater site and localhost:8000; * = anyone)
//   RATE_LIMIT=120      requests per minute per client
//   POSITIONING_TOP=60  pairs whose ratio series are cached for /api/positioning (0 = off)
//   DATA_DIR=worker/data
//   SMART_MONEY_URL     override the overview endpoint if Binance moves it
//   FAPI_URL            override the futures API base (for testing)
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOverview, pickCohort, summarize } from '../js/smartmoney.js';
import { demoSnapshots } from '../js/smartmoney-demo.js';
import { guardedHandler, parseOrigins } from './http-util.mjs';

const OVERVIEW_URL = process.env.SMART_MONEY_URL || 'https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/overview';
const FAPI = process.env.FAPI_URL || 'https://fapi.binance.com';
const PORT = +(process.env.PORT || 8787);
const TOP = +(process.env.TOP || 120);
const RATE_MS = Math.max(500, +(process.env.RATE_MS || 1200));
const KEEP_MS = +(process.env.KEEP_HOURS || 720) * 3_600_000;
const ORIGINS = parseOrigins(process.env.ALLOW_ORIGIN);
const HOST = process.env.HOST || '127.0.0.1';
const RATE_LIMIT = +(process.env.RATE_LIMIT || 120);
const POS_TOP = +(process.env.POSITIONING_TOP ?? 60);
const POS_EVERY_MS = +(process.env.POSITIONING_EVERY_MS || 600_000);
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL('./data', import.meta.url));
const HEADERS = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; deepwater-whale-worker)' };

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof fetch === 'undefined') {
  console.error('This worker needs Node 22 or newer.');
  process.exit(1);
}

// ---------------------------------------------------------------- Binance requests

let blockedUntil = 0;
let backoff = 60_000;

async function fetchOverview(symbol) {
  const url = `${OVERVIEW_URL}?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: HEADERS });
  if (res.status === 418 || res.status === 429 || res.status === 403) {
    // Binance is asking us to slow down. Respect it: pause everything, then double the pause next time.
    const retry = (+res.headers.get('retry-after') || 0) * 1000;
    const wait = Math.max(retry, backoff);
    blockedUntil = Date.now() + wait;
    backoff = Math.min(backoff * 2, 30 * 60_000);
    throw new Error(`HTTP ${res.status} from Binance; pausing ${Math.round(wait / 1000)}s`);
  }
  if (res.status === 451) throw new Error('HTTP 451: Binance blocks this server’s region. Run the worker from a supported country.');
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const body = await res.json();
  if (body && body.success === false) throw new Error(`Binance said: ${body.message || body.code || 'request failed'}`);
  backoff = 60_000;
  return body;
}

async function fapi(path, params = {}) {
  const res = await fetch(`${FAPI}${path}?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

// ---------------------------------------------------------------- probe

if (args[0] === '--probe') {
  const symbol = (args[1] || 'BTCUSDT').toUpperCase();
  try {
    const raw = await fetchOverview(symbol);
    console.log('Raw response (first 3000 characters):\n' + JSON.stringify(raw, null, 2).slice(0, 3000));
    const snap = parseOverview(raw, { symbol });
    snap.mark = +(await fapi('/fapi/v1/premiumIndex', { symbol })).markPrice;
    console.log(`\nFormat: ${snap.format}. Binance last updated this ${snap.sourceT ? `${((Date.now() - snap.sourceT) / 3_600_000).toFixed(1)} hours ago` : '(no updateTime field)'}. Mark price ${snap.mark}.`);
    console.log('\nUnderstood fields:\n  ' + (snap.matched.join('\n  ') || '(none)'));
    console.log('\nFields not used:\n  ' + (snap.unmatched.join('\n  ') || '(none)'));
    const cohort = pickCohort(snap);
    console.log('\nCohort shown:', cohort ?? 'none found', '\nSummary:', summarize(snap, cohort));
    if (!cohort) console.log('\nNo whale or smart-trader positions were recognised. Send this output so the parser can be adjusted.');
  } catch (e) {
    console.error('Probe failed:', e.message, e.cause?.code ? `(${e.cause.code}: is www.binance.com reachable from this machine?)` : '');
    process.exitCode = 1;
  }
  process.exit();
}

// ---------------------------------------------------------------- state

const history = new Map(); // symbol -> [snapshot], one per Binance update
const latest = new Map(); // symbol -> { mark, oiUsd, checkedAt } from the most recent poll
const status = { started: Date.now(), lastSweepStart: null, lastSweepMs: null, symbols: 0, polls: 0, newUpdates: 0, errors: 0, lastError: null, sample: null };

mkdirSync(DATA_DIR, { recursive: true });
for (const f of readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'))) {
  try {
    const rows = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
    history.set(f.replace(/\.json$/, ''), rows.filter((s) => Date.now() - s.t < KEEP_MS));
  } catch {}
}

function compact(snap) {
  const side = (s) => ({ count: s.count, qty: s.qty, usd: s.usd, entry: s.entry, upnl: s.upnl, profitCount: s.profitCount, winRate: s.winRate });
  return {
    symbol: snap.symbol, t: snap.t, sourceT: snap.sourceT, mark: snap.mark, oiUsd: snap.oiUsd,
    whale: { long: side(snap.whale.long), short: side(snap.whale.short) },
    smart: { long: side(snap.smart.long), short: side(snap.smart.short) },
  };
}

/** Store a snapshot only when Binance has recalculated (new updateTime); returns true if stored. */
function record(snap) {
  const rows = history.get(snap.symbol) || [];
  if (rows.length && rows.at(-1).t === snap.t) return false;
  rows.push(compact(snap));
  while (rows.length && Date.now() - rows[0].t > KEEP_MS) rows.shift();
  history.set(snap.symbol, rows);
  return true;
}

function persist() {
  for (const [symbol, rows] of history) {
    const file = join(DATA_DIR, `${symbol}.json`);
    writeFileSync(file + '.tmp', JSON.stringify(rows));
    renameSync(file + '.tmp', file);
  }
}

// ---------------------------------------------------------------- polling

async function universe() {
  const [tickers, premium, info] = await Promise.all([fapi('/fapi/v1/ticker/24hr'), fapi('/fapi/v1/premiumIndex'), fapi('/fapi/v1/exchangeInfo')]);
  const ok = new Set(info.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING').map((s) => s.symbol));
  const mark = new Map(premium.map((p) => [p.symbol, +p.markPrice]));
  return tickers.filter((t) => ok.has(t.symbol)).sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, TOP).map((t) => ({ symbol: t.symbol, mark: mark.get(t.symbol) || +t.lastPrice }));
}

async function sweep() {
  status.lastSweepStart = Date.now();
  const list = await universe();
  status.symbols = list.length;
  for (const { symbol } of list) {
    if (Date.now() < blockedUntil) await sleep(blockedUntil - Date.now());
    try {
      // Fresh mark price and open interest at the moment of the snapshot.
      const [raw, mark, oi] = await Promise.all([
        fetchOverview(symbol),
        fapi('/fapi/v1/premiumIndex', { symbol }),
        fapi('/fapi/v1/openInterest', { symbol }),
      ]);
      const snap = parseOverview(raw, { symbol, t: Date.now() });
      snap.symbol = symbol;
      snap.mark = +mark.markPrice;
      snap.oiUsd = +oi.openInterest * snap.mark;
      if (!pickCohort(snap)) throw new Error(`no whale fields recognised for ${symbol} (run --probe ${symbol})`);
      if (!status.sample) status.sample = snap.matched;
      latest.set(symbol, { mark: snap.mark, oiUsd: snap.oiUsd, checkedAt: Date.now() });
      status.polls++;
      if (record(snap)) status.newUpdates++;
    } catch (e) {
      status.errors++;
      status.lastError = `${new Date().toISOString()} ${e.message}`;
      log(symbol, e.message);
    }
    await sleep(RATE_MS);
  }
  status.lastSweepMs = Date.now() - status.lastSweepStart;
  persist();
  log(`Sweep done: ${list.length} pairs in ${Math.round(status.lastSweepMs / 1000)}s, ${status.errors} errors so far`);
}

async function loop() {
  for (;;) {
    try {
      await sweep();
    } catch (e) {
      status.lastError = `${new Date().toISOString()} ${e.message}`;
      log('Sweep failed:', e.message);
      await sleep(30_000);
    }
  }
}

// Cached copy of the four ratio series per pair, so every browser makes one request instead of 240 to Binance.
let positioning = { t: 0, rows: [] };

async function refreshPositioning() {
  const list = (await universe()).slice(0, POS_TOP);
  const rows = [];
  const series = (rs) => rs.map((r) => ({ t: +r.timestamp, long: +r.longAccount }));
  for (const { symbol } of list) {
    try {
      const params = { symbol, period: '1h', limit: 25 };
      const [whales, smart, crowd, oi] = await Promise.all([
        fapi('/futures/data/topLongShortPositionRatio', params),
        fapi('/futures/data/topLongShortAccountRatio', params),
        fapi('/futures/data/globalLongShortAccountRatio', params),
        fapi('/futures/data/openInterestHist', params),
      ]);
      rows.push({ symbol, whales: series(whales), smart: series(smart), crowd: series(crowd), oi: oi.map((r) => ({ t: +r.timestamp, value: +r.sumOpenInterestValue })) });
    } catch (e) {
      log('positioning', symbol, e.message);
      if (/HTTP (418|429)/.test(e.message)) await sleep(60_000);
    }
    await sleep(1500); // the futures/data endpoints allow 1000 requests per 5 minutes per IP
  }
  if (rows.length) positioning = { t: Date.now(), period: '1h', rows };
  log(`Positioning cache: ${rows.length} of ${list.length} pairs`);
}

async function positioningLoop() {
  for (;;) {
    try {
      await refreshPositioning();
    } catch (e) {
      log('Positioning refresh failed:', e.message);
    }
    await sleep(POS_EVERY_MS);
  }
}

// Demo: simulated pairs, refreshed every minute.
function demoLoop() {
  const pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'SUIUSDT', 'WIFUSDT', 'PEPEUSDT'];
  const fill = () => {
    for (const [i, symbol] of pairs.entries()) {
      let p = 10 ** (4 - i * 0.6);
      const bars = [];
      for (let t = Date.now() - KEEP_MS; t < Date.now(); t += 180_000) bars.push({ t, c: (p *= 1 + (Math.sin(t / 3e6 + i) * 0.001)) });
      history.set(symbol, demoSnapshots(symbol, bars, () => 4e8 / (i + 1)));
    }
    status.symbols = pairs.length;
    status.lastSweepStart = Date.now();
    status.lastSweepMs = 0;
  };
  fill();
  setInterval(fill, 60_000);
}

// ---------------------------------------------------------------- HTTP API

function latestRow(symbol, rows) {
  // Positions as of Binance's last update, valued at the latest mark price.
  const now = latest.get(symbol);
  const s = now ? { ...rows.at(-1), mark: now.mark, oiUsd: now.oiUsd } : rows.at(-1);
  const cohort = pickCohort(s);
  return { symbol, t: s.t, checkedAt: now?.checkedAt ?? null, mark: s.mark, oiUsd: s.oiUsd, cohort, shown: summarize(s, cohort, s.oiUsd), whale: summarize(s, 'whale', s.oiUsd), smart: summarize(s, 'smart', s.oiUsd) };
}

function binanceAges() {
  const ts = [...history.values()].map((rows) => rows.at(-1)?.t).filter(Boolean);
  if (!ts.length) return { newestUpdate: null, oldestUpdate: null };
  return { newestUpdate: Math.max(...ts), oldestUpdate: Math.min(...ts) };
}

const server = http.createServer(guardedHandler({
  origins: ORIGINS,
  perMinute: RATE_LIMIT,
  trustProxy: HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost', // behind our own reverse proxy
  handler(req, res, { url, send, direct }) {
    if (url.pathname === '/api/health') {
      // Public health is deliberately thin. Detail (errors, counters) is only for requests made directly on the machine.
      const pub = { ok: true, demo, pairsWithData: history.size, keepHours: KEEP_MS / 3_600_000, ...binanceAges() };
      if (direct && url.searchParams.has('detail')) Object.assign(pub, status, { blockedUntil: blockedUntil > Date.now() ? blockedUntil : null });
      return send(200, pub);
    }
    if (url.pathname === '/api/overview') {
      const rows = [];
      for (const [symbol, list] of history) if (list.length) rows.push(latestRow(symbol, list));
      return send(200, { t: Date.now(), rows });
    }
    if (url.pathname === '/api/positioning') {
      if (!positioning.rows.length) return send(404, { error: 'Positioning cache is still filling' });
      return send(200, { t: positioning.t, period: positioning.period, rows: positioning.rows });
    }
    const m = url.pathname.match(/^\/api\/symbol\/([A-Z0-9]{1,30})$/);
    if (m) {
      const since = Math.max(0, +(url.searchParams.get('since') || 0)) || 0;
      const rows = (history.get(m[1]) || []).filter((s) => s.t >= since);
      const now = latest.get(m[1]);
      return send(rows.length ? 200 : 404, { symbol: m[1], snapshots: rows, mark: now?.mark ?? null, oiUsd: now?.oiUsd ?? null, checkedAt: now?.checkedAt ?? null });
    }
    send(404, { error: 'Not found. Try /api/health, /api/overview, /api/positioning or /api/symbol/BTCUSDT' });
  },
}));

server.listen(PORT, HOST, () => {
  log(`Whale data server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (${demo ? 'demo data' : `polling top ${TOP} pairs, one request every ${RATE_MS}ms`}), CORS: ${ORIGINS.join(', ')}`);
  log(`In the web app: Whales page → Whale data → paste the server's https address`);
});

if (demo) demoLoop();
else {
  loop();
  if (POS_TOP > 0) positioningLoop();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!demo) persist();
    process.exit(0);
  });
}
