#!/usr/bin/env node
// Pump Catcher server: watches every Binance USDT-M perpetual around the clock, fires when a pair rises 27%
// off its rolling 24h low, follows each move, and posts alerts to Telegram the moment they fire.
// Same rules as the web app (js/pump.js). Needs Node 22+ (built-in fetch and WebSocket).
//
//   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=-100123 node worker/catcher.mjs
//   node worker/catcher.mjs --demo          # simulated market, no network
//   WHALE_SERVER=http://localhost:8787      # whale data server for alert context (default; empty to turn off)
//
// Optional: SIGNALS_FILE (default worker/pumps.json)
//
// It also serves the shared signal log, so every device shows the same record:
//   GET /api/catcher   status and every signal of the last 30 days
//   CATCHER_PORT=8788, HOST=127.0.0.1, ALLOW_ORIGIN (comma-separated; default the Deepwater site and localhost:8000), RATE_LIMIT=120 per minute
import http from 'node:http';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PumpScanner } from '../js/pump-scanner.js';
import { metrics } from '../js/pump.js';
import { createBinanceSource, REST } from '../js/binance.js';
import { createDemoMarket } from '../js/demo-market.js';
import { guardedHandler, parseOrigins } from './http-util.mjs';

const demo = process.argv.includes('--demo');
const file = process.env.SIGNALS_FILE || fileURLToPath(new URL('./pumps.json', import.meta.url));
const tg = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
const PORT = +(process.env.CATCHER_PORT || 8788);
const ORIGINS = parseOrigins(process.env.ALLOW_ORIGIN);
const HOST = process.env.HOST || '127.0.0.1';
const RATE_LIMIT = +(process.env.RATE_LIMIT || 120);
const SITE = (process.env.SITE_URL || 'https://mezeezain.github.io/deepwater/').replace(/\/?$/, '/');

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

const scanner = new PumpScanner({ source, store, whaleLookup });

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

const usd = (v) => (v == null ? '–' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);

scanner.on('alert', (s) => {
  const m = metrics(s);
  log(`ALERT ${s.symbol} @ ${px(s.alertPrice)} | 24h low ${px(s.startPrice)} | ${pct(m.riseAtAlert)} | vol ${usd(s.volume24h)} | OI ${usd(s.oiUsd)}`);
  const w = s.whale;
  telegram(
    `🚀 <b>${name(s)}</b> pump · ${pct(m.riseAtAlert)} off its 24h low\n` +
      `Alert <code>${px(s.alertPrice)}</code> · 24h low <code>${px(s.startPrice)}</code>\n` +
      `Volume 24h ${usd(s.volume24h)} · OI ${usd(s.oiUsd)}` +
      (w
        ? `\nWhales ${Math.round(w.longShare * 100)}% long by size` +
          (w.shortsUnderwater ? ` · whale shorts losing $${Math.round(-w.shortUpnl).toLocaleString('en-US')}` : '') +
          (w.nearLongEntry ? ' · at whale long entry' : '')
        : '') +
      `\n<a href="${SITE}#sig-${encodeURIComponent(s.id)}">Signal page</a>`,
  );
});

scanner.on('closed', (s) => {
  const m = metrics(s);
  log(`CLOSED ${s.symbol} | peak ${pct(m.peak)} | dip before peak ${pct(m.dip)} | ${s.closeReason}`);
});

let lastBeat = 0;
scanner.on('change', () => {
  if (Date.now() - lastBeat < 60_000) return;
  lastBeat = Date.now();
  const tracking = scanner.signals.filter((s) => s.status === 'TRACKING').length;
  log(`${scanner.tickers.size} pairs · ${tracking} active · ${scanner.signals.length} alerts in 30 days`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    scanner.stop();
    log('Stopped, signals saved to', file);
    process.exit(0);
  });
}

// ---------------------------------------------------------------- shared signal log

const server = http.createServer(guardedHandler({
  origins: ORIGINS,
  perMinute: RATE_LIMIT,
  trustProxy: HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost',
  handler(req, res, { url, send }) {
    if (url.pathname === '/api/catcher') {
      return send(200, {
        version: 2,
        t: Date.now(),
        demo,
        state: scanner.state,
        startedAt: scanner.startedAt,
        lastTick: scanner.lastTick,
        pairs: scanner.tickers.size,
        threshold: scanner.threshold,
        signals: scanner.signals,
      });
    }
    send(404, { error: 'Not found. Try /api/catcher' });
  },
}));
server.listen(PORT, HOST, () => log(`Shared signal log on http://${HOST}:${PORT}/api/catcher (CORS: ${ORIGINS.join(', ')})`));

log(`Starting Pump Catcher (${demo ? 'demo market' : 'Binance live'})${tg.token ? ', Telegram on' : ''}`);
scanner.start().catch((err) => {
  console.error('Could not start:', err.message);
  process.exit(1);
});
