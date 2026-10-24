#!/usr/bin/env node
// Runs the pump catcher around the clock and posts alerts to Telegram.
// Same engine and rules as the web app. Needs Node 22+ (built-in fetch and WebSocket).
//
//   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=-100123 node worker/catcher.mjs
//   node worker/catcher.mjs --demo          # simulated market, no network
//   WHALE_SERVER=http://localhost:8787      # whale data server for alert context (default; empty to turn off)
//
// Optional: SIGNALS_FILE (default worker/signals.json), CATCHER_CONFIG='{"minRise":5}'
//
// It also serves the shared signal log, so every device shows the same record:
//   GET /api/catcher   status, settings, signals (30 days) and pairs close to firing
//   GET /api/backtest  latest result of tools/backtest.mjs, if one has been run
//   CATCHER_PORT=8788, ALLOW_ORIGIN=* (set to your site, e.g. https://you.github.io), BACKTEST_FILE
import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Catcher } from '../js/catcher.js';
import { configId } from '../js/engine.js';
import { createBinanceSource, REST } from '../js/binance.js';
import { createDemoMarket } from '../js/demo-market.js';

const demo = process.argv.includes('--demo');
const file = process.env.SIGNALS_FILE || fileURLToPath(new URL('./signals.json', import.meta.url));
const cfg = process.env.CATCHER_CONFIG ? JSON.parse(process.env.CATCHER_CONFIG) : {};
const tg = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
const PORT = +(process.env.CATCHER_PORT || 8788);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const BACKTEST_FILE = process.env.BACKTEST_FILE || fileURLToPath(new URL('./data/backtest.json', import.meta.url));

if (typeof WebSocket === 'undefined') {
  console.error('This worker needs Node 22 or newer (for the built-in WebSocket).');
  process.exit(1);
}

// Binance REST with a small concurrency cap and backoff on rate limits.
let active = 0;
const waiting = [];
async function get(path, params = {}) {
  if (active >= 8) await new Promise((r) => waiting.push(r));
  active++;
  try {
    const url = `${REST}${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url);
      if ((res.status === 429 || res.status === 418) && attempt < 3) {
        const wait = (+res.headers.get('retry-after') || 30) * 1000;
        log(`Rate limited, waiting ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (res.status === 451) throw new Error('Binance blocks this server’s region (HTTP 451). Run the worker from a supported country.');
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      return res.json();
    }
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const store = {
  load() {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  },
  save(signals) {
    writeFileSync(file + '.tmp', JSON.stringify(signals, null, 1));
    renameSync(file + '.tmp', file);
  },
};

const source = demo ? createDemoMarket() : createBinanceSource({ get });
// Whale context from your whale data server (worker/smartmoney.mjs), if one is running.
const WHALE_SERVER = (process.env.WHALE_SERVER ?? 'http://localhost:8787').replace(/\/+$/, '');
let whaleCache = { at: 0, rows: null };
async function whaleLookup(symbol) {
  if (!WHALE_SERVER) return null;
  if (Date.now() - whaleCache.at > 60_000) {
    try {
      const res = await fetch(`${WHALE_SERVER}/api/overview`);
      whaleCache = { at: Date.now(), rows: res.ok ? new Map((await res.json()).rows.map((r) => [r.symbol, r.shown])) : null };
    } catch {
      whaleCache = { at: Date.now(), rows: null };
    }
  }
  return whaleCache.rows?.get(symbol) ?? null;
}

const catcher = new Catcher({ source, store, cfg, whaleLookup });

const name = (s) => s.symbol.replace(/USDT$/, '');
const pct = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const px = (v) => +(+v).toPrecision(6);
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function telegram(text) {
  if (!tg.token || !tg.chat) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) log('Telegram error', res.status, await res.text());
  } catch (err) {
    log('Telegram error', err.message);
  }
}

catcher.on('alert', (s) => {
  log(`ALERT ${s.symbol} @ ${px(s.alertPrice)} | ${pct(s.riseFromLow)} off 24h low | ${s.rvol?.toFixed(1)}x vol | buys ${Math.round(s.takerBuy * 100)}% | OI ${pct(s.oiChange)} | gap ${Math.round(s.gap)}`);
  telegram(
    `🚀 <b>${name(s)}</b> pump alert\n` +
      `Price <code>${px(s.alertPrice)}</code> · ${pct(s.riseFromLow)} off 24h low · ${pct(s.impulse)} in 5m\n` +
      `Volume ${s.rvol?.toFixed(1)}× · Taker buys ${Math.round(s.takerBuy * 100)}% · OI ${pct(s.oiChange)}\n` +
      `Whales ${Math.round(s.whaleLong * 100)}% long vs crowd ${Math.round(s.crowdLong * 100)}%` +
      (s.whale
        ? `\nSmart Money whales ${Math.round(s.whale.longShare * 100)}% long` +
          (s.whale.shortsUnderwater ? ` · whale shorts losing $${Math.round(-s.whale.shortUpnl).toLocaleString('en-US')}` : '') +
          (s.whale.nearLongEntry ? ' · at whale long entry' : '')
        : ''),
  );
});

catcher.on('closed', (s) => {
  log(`CLOSED ${s.symbol} | rise ${pct(s.rise)} | dip before peak ${pct(s.dip)} | ${s.closeReason}`);
  telegram(`🏁 <b>${name(s)}</b> closed · best ${pct(s.rise)} · dip before peak ${pct(s.dip)}\n${s.closeReason}`);
});

let lastBeat = 0;
catcher.on('change', () => {
  if (Date.now() - lastBeat < 60_000) return;
  lastBeat = Date.now();
  const tracking = catcher.signals.filter((s) => s.status === 'TRACKING').length;
  log(`${catcher.tickers.size} pairs · ${tracking} tracking · ${catcher.nearMisses().length} close to firing`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    catcher.stop();
    log('Stopped, signals saved to', file);
    process.exit(0);
  });
}

// ---------------------------------------------------------------- shared signal log

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': ALLOW_ORIGIN, 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': ALLOW_ORIGIN, 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' });
    return res.end();
  }
  if (url.pathname === '/api/catcher') {
    const near = catcher.nearMisses().slice(0, 12).map((c) => ({ symbol: c.symbol, screen: c.screen, checks: c.checks, error: c.error ?? null }));
    return send(200, {
      t: Date.now(),
      demo,
      state: catcher.state,
      startedAt: catcher.startedAt,
      lastEval: catcher.lastEval,
      pairs: catcher.tickers.size,
      cfg: catcher.cfg,
      cfgId: configId(catcher.cfg),
      signals: catcher.signals,
      near,
    });
  }
  if (url.pathname === '/api/backtest') {
    if (!existsSync(BACKTEST_FILE)) return send(404, { error: 'No backtest has been run yet. Run: node tools/backtest.mjs' });
    try {
      return send(200, JSON.parse(readFileSync(BACKTEST_FILE, 'utf8')));
    } catch {
      return send(500, { error: 'Backtest file is unreadable.' });
    }
  }
  send(404, { error: 'Not found. Try /api/catcher or /api/backtest' });
});
server.listen(PORT, () => log(`Shared signal log on http://localhost:${PORT}/api/catcher`));

log(`Starting pump catcher (${demo ? 'demo market' : 'Binance live'})${tg.token ? ', Telegram on' : ''}`);
catcher.start().catch((err) => {
  console.error('Could not start:', err.message);
  process.exit(1);
});
