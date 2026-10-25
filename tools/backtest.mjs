#!/usr/bin/env node
// Replays the pump catcher over Binance's recent history and reports how its alerts would have done.
// Tunes on the first part of the period and tests on the rest, which the tuning never saw.
// Node 22+, no dependencies. Run it where Binance is reachable (e.g. your whale data server).
//
//   node tools/backtest.mjs                      # 40 pairs, 29 days (+1 day warm-up), tune 19 / test 10
//   node tools/backtest.mjs --pairs 80 --train 15
//   node tools/backtest.mjs --pairs all          # every perpetual that was trading at the start (about 3x longer)
//   node tools/backtest.mjs --cost 0.5           # assumed round-trip cost, % (default 0.3)
//
// Pairs are ranked by their volume on the first day of the window, not today, so coins that are pumping now
// are not favoured. Coins delisted since the window began are not in Binance's list and cannot be included.
// Funding paid while a signal was open is charged to it.
//   node tools/backtest.mjs --demo               # synthetic data, no network (checks the tool runs)
//
// Writes worker/data/backtest.json (or --out), which the pump catcher worker serves at /api/backtest.
// Downloading takes about 20–30 minutes for 40 pairs: requests are paced to stay well inside Binance's limits.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../js/backtest.js';
import { DEFAULTS } from '../js/engine.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const demo = process.argv.includes('--demo');
const PAIRS_ARG = arg('pairs', '40');
const PAIRS = PAIRS_ARG === 'all' ? Infinity : +PAIRS_ARG;
const COST = +arg('cost', DEFAULTS.costPct);
const STEP = +arg('step', 5);
const DAYS = +arg('days', 29); // Binance keeps 30 days of positioning; one more day is used as warm-up
const TRAIN = +arg('train', 19);
const OUT = arg('out', fileURLToPath(new URL('../worker/data/backtest.json', import.meta.url)));
const FAPI = process.env.FAPI_URL || 'https://fapi.binance.com';
const MIN = 60_000;
const SLOT = 5 * MIN;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
async function get(path, params) {
  // ~3 requests a second, and back off when Binance asks.
  const wait = lastCall + 330 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${FAPI}${path}?${new URLSearchParams(params)}`);
    if ((res.status === 429 || res.status === 418) && attempt < 5) {
      const pause = (+res.headers.get('retry-after') || 60) * 1000;
      log(`Rate limited; pausing ${pause / 1000}s`);
      await sleep(pause);
      continue;
    }
    if (res.status === 451) throw new Error('Binance blocks this machine’s region (HTTP 451).');
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path} ${JSON.stringify(params)}`);
    return res.json();
  }
}

async function minutesFor(symbol, from, to) {
  const out = [];
  let start = from;
  while (start < to) {
    const rows = await get('/fapi/v1/klines', { symbol, interval: '1m', startTime: start, endTime: to, limit: 1500 });
    if (!rows.length) break;
    for (const k of rows) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7], takerBuy: +k[10] });
    start = rows.at(-1)[0] + MIN;
    if (rows.length < 1500) break;
  }
  return out.filter((m) => m.t + MIN <= to); // closed minutes only
}

// Paged backwards from `to`: with only endTime set, Binance returns the latest rows before it, so this
// works whichever end of a range the endpoint would otherwise start from.
async function historyFor(path, symbol, from, to, field) {
  const out = new Map();
  let end = to;
  while (end > from) {
    const rows = await get(path, { symbol, period: '5m', endTime: end, limit: 500 });
    if (!rows.length) break;
    for (const r of rows) if (+r.timestamp >= from) out.set(+r.timestamp, +r[field]);
    const earliest = Math.min(...rows.map((r) => +r.timestamp));
    if (earliest >= end || rows.length < 500) break;
    end = earliest - 1;
  }
  return out;
}

/** Positioning keyed by the 5-minute slot of Binance's timestamp; the backtest reads it one slot late, which is safe whether the stamp is the start or the end of the period. */
function mergePositioning(oi, whales, crowd) {
  const pos = new Map();
  const put = (map, key) => {
    for (const [ts, v] of map) {
      const slot = Math.floor(ts / SLOT) * SLOT;
      const row = pos.get(slot) || { oi: null, whaleLong: null, crowdLong: null };
      row[key] = v;
      pos.set(slot, row);
    }
  };
  put(oi, 'oi');
  put(whales, 'whaleLong');
  put(crowd, 'crowdLong');
  return pos;
}

async function download() {
  const now = Math.floor(Date.now() / MIN) * MIN;
  const from = now - (DAYS + 1) * 1440 * MIN;
  const posFrom = now - 30 * 1440 * MIN + 10 * MIN; // Binance rejects positioning requests older than 30 days
  const [info, tickers] = await Promise.all([get('/fapi/v1/exchangeInfo', {}), get('/fapi/v1/ticker/24hr', {})]);
  const ok = new Set(info.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.onboardDate < from).map((s) => s.symbol));
  let symbols = tickers.filter((t) => ok.has(t.symbol)).map((t) => t.symbol);
  if (symbols.length > PAIRS) {
    // Rank by the first full day of the window, so today's pumpers are not favoured.
    log(`Ranking ${symbols.length} pairs by their volume on the first day of the window…`);
    const vol = new Map();
    for (const symbol of symbols) {
      try {
        const k = await get('/fapi/v1/klines', { symbol, interval: '1d', startTime: from, limit: 1 });
        vol.set(symbol, k.length ? +k[0][7] : 0);
      } catch {
        vol.set(symbol, 0);
      }
    }
    symbols = symbols.sort((a, b) => vol.get(b) - vol.get(a)).slice(0, PAIRS);
  }
  const data = [];
  for (const [n, symbol] of symbols.entries()) {
    log(`${n + 1}/${symbols.length} ${symbol}`);
    try {
      const minutes = await minutesFor(symbol, from, now);
      const oi = await historyFor('/futures/data/openInterestHist', symbol, posFrom, now, 'sumOpenInterest');
      const whales = await historyFor('/futures/data/topLongShortPositionRatio', symbol, posFrom, now, 'longAccount');
      const crowd = await historyFor('/futures/data/globalLongShortAccountRatio', symbol, posFrom, now, 'longAccount');
      if (minutes.length < 2 * 1440) throw new Error('not enough history');
      let funding = [];
      try {
        funding = (await get('/fapi/v1/fundingRate', { symbol, startTime: from, limit: 1000 })).map((r) => ({ t: +r.fundingTime, rate: +r.fundingRate }));
      } catch (e) {
        log(`  funding unavailable for ${symbol}: ${e.message}`);
      }
      data.push({ symbol, minutes, funding, pos: mergePositioning(oi, whales, crowd) });
    } catch (e) {
      log(`  skipped: ${e.message}`);
    }
  }
  return data;
}

/** Synthetic market for --demo: noise plus occasional pumps, some of which fail. */
function synthetic() {
  const data = [];
  for (let p = 0; p < 6; p++) {
    let seed = 11 + p;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const minutes = [];
    const pos = new Map();
    let price = 10 + p * 7;
    let oi = 1e6;
    let pump = 0;
    let fail = false;
    const start = Date.UTC(2026, 8, 1);
    for (let i = 0; i < (DAYS + 1) * 1440; i++) {
      if (!pump && rnd() < 1 / 900) {
        pump = 10 + Math.floor(rnd() * 10);
        fail = rnd() < 0.5;
      }
      const o = price;
      const busy = pump > 0;
      if (busy) price *= 1 + 0.004 + rnd() * 0.006;
      else price *= 1 + (rnd() - (fail ? 0.53 : 0.5)) * 0.004;
      if (busy && --pump === 0 && fail) price *= 0.97;
      const v = (busy ? 4 : 1) * (800 + rnd() * 400);
      minutes.push({ t: start + i * MIN, o, h: Math.max(o, price) * (1 + rnd() * 0.001), l: Math.min(o, price) * (1 - rnd() * 0.001), c: price, v, takerBuy: v * (busy ? 0.68 : 0.48 + rnd() * 0.04) });
      if (i % 5 === 0) {
        oi *= busy ? 1.012 : 1 + (rnd() - 0.5) * 0.002;
        pos.set(start + i * MIN, { oi, whaleLong: 0.5 + (rnd() - 0.3) * 0.3, crowdLong: 0.4 + rnd() * 0.3 });
      }
    }
    data.push({ symbol: `DEMO${p}USDT`, minutes, pos });
  }
  return data;
}

const t0 = Date.now();
log(demo ? 'Backtest on synthetic data (--demo)' : `Downloading ${DAYS + 1} days for ${PAIRS === Infinity ? 'every pair' : `the top ${PAIRS} pairs by first-day volume`}…`);
const data = demo ? synthetic() : await download();
if (!data.length) {
  console.error('No data downloaded; nothing to test.');
  process.exit(1);
}
log(`Replaying ${data.length} pairs…`);
const report = runBacktest(data, {
  trainDays: TRAIN,
  stepDays: STEP,
  costPct: COST,
  onProgress: (k, n) => k % 9 === 0 && log(`  rule set ${k}/${n}`),
});
report.demo = demo;
report.symbols = data.map((d) => d.symbol);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 1));

const ci = (v, d = 2) => (v ? ` (95% range ${v[0].toFixed(d)} to ${v[1].toFixed(d)})` : '');
const fmt = (r) => `${r.signals} signals (${r.unresolved} too recent to judge), ${r.closed} closed, win rate ${r.winRate == null ? '–' : Math.round(r.winRate * 100) + '%'}, expectancy ${r.expectancy == null ? '–' : r.expectancy.toFixed(2) + '%'} per signal${ci(r.expectancyCI)}`;
const g = report.gridSpread;
console.log(`
Best rules on the tuning period (${report.bestRuleId}): ${JSON.stringify(report.bestRules)}${report.enoughSignals ? '' : '  (fewer than 30 closed signals: too few to choose reliably)'}
  Tuning, first ${report.trainDays} days: ${fmt(report.train)}
  Test, last ${report.testDays} days (unseen): ${fmt(report.test)}
Defaults (${report.defaults.ruleId}):
  Tuning: ${fmt(report.defaults.train)}
  Test:   ${fmt(report.defaults.test)}
Across all ${g.ruleSets} rule sets on the test period: median ${g.median == null ? '–' : g.median.toFixed(2) + '%'}, middle half ${g.p25 == null ? '–' : g.p25.toFixed(2)} to ${g.p75 == null ? '–' : g.p75.toFixed(2)}%, ${g.positiveShare == null ? '–' : Math.round(g.positiveShare * 100) + '%'} of rule sets positive.
${report.walkForward ? `Walk-forward (${report.walkForward.folds.length} folds, tuned before each split): ${report.walkForward.pooled.signals} signals, expectancy ${report.walkForward.pooled.expectancy == null ? '–' : report.walkForward.pooled.expectancy.toFixed(2) + '%'}${ci(report.walkForward.pooled.expectancyCI)}` : 'Walk-forward: not enough days for it.'}
All results after ${report.costPct}% round-trip costs${report.fundingIncluded ? ' plus funding' : ''}. Saved to ${OUT} (${Math.round((Date.now() - t0) / 1000)}s).
`);
