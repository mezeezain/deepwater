#!/usr/bin/env node
// Runs the pump catcher around the clock and posts alerts to Telegram.
// Same engine and rules as the web app. Needs Node 22+ (built-in fetch and WebSocket).
//
//   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=-100123 node worker/catcher.mjs
//   node worker/catcher.mjs --demo          # simulated market, no network
//
// Optional: SIGNALS_FILE (default worker/signals.json), CATCHER_CONFIG='{"minRise":5}'
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Catcher } from '../js/catcher.js';
import { createBinanceSource, REST } from '../js/binance.js';
import { createDemoMarket } from '../js/demo-market.js';

const demo = process.argv.includes('--demo');
const file = process.env.SIGNALS_FILE || fileURLToPath(new URL('./signals.json', import.meta.url));
const cfg = process.env.CATCHER_CONFIG ? JSON.parse(process.env.CATCHER_CONFIG) : {};
const tg = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };

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
const catcher = new Catcher({ source, store, cfg });

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
      `Whales ${Math.round(s.whaleLong * 100)}% long vs crowd ${Math.round(s.crowdLong * 100)}%`,
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

log(`Starting pump catcher (${demo ? 'demo market' : 'Binance live'})${tg.token ? ', Telegram on' : ''}`);
catcher.start().catch((err) => {
  console.error('Could not start:', err.message);
  process.exit(1);
});
