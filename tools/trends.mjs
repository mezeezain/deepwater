#!/usr/bin/env node
// Does the Trend radar find anything? Event study over many coins, run where Binance is reachable (your VPS).
// Node 22+, no dependencies.
//
//   node tools/trends.mjs                 # top 60 coins by volume, 4h candles (about 500 days)
//   node tools/trends.mjs --tf 1h         # 1h candles (about 125 days)
//   node tools/trends.mjs --pairs 100
//
// For every fresh trend the radar would have shown (js/trend.js, first candle it qualified), it measures what
// price did next in the trend's direction, after 0.1% round-trip costs:
//   +6 / +12 / +24 candles   % return from that candle's close
//   2:1 race                 share that reached +2 ATR before -1 ATR within 24 candles (break-even: 33%)
// and compares with two baselines:
//   every candle             trading in the EMA 20/50 direction on any candle (is "fresh" better than "any"?)
//   late trends              the same rules, but trends older than the fresh window (is fresh better than late?)
// It also tests two other common definitions of "trending now":
//   B  the first close at a new 50-candle high (low) in 50 candles, EMA 20/50 agreeing
//   C  cross-coin momentum: every 24 candles, the top 10% of coins by 120-candle return (long) and bottom 10% (short)
// Then splits fresh trends by where price was (near support, near resistance, clear, open) and stretched or not,
// and checks each pair's older 70% against its newest 30%.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TREND, indicators, trendAt, location } from '../js/trend.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PAIRS = +arg('pairs', 60);
const TF = arg('tf', '4h');
const MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[TF];
if (!MS) throw new Error('--tf must be 15m, 1h, 4h or 1d');
const OUT = arg('out', fileURLToPath(new URL(`../worker/data/trends-${TF}.json`, import.meta.url)));
const FAPI = process.env.FAPI_URL || 'https://fapi.binance.com';
const COST = 0.1; // % round trip
const HORIZONS = [6, 12, 24];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function get(path, params) {
  const wait = lastCall + 250 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${FAPI}${path}?${new URLSearchParams(params)}`);
    if ((res.status === 429 || res.status === 418) && attempt < 5) {
      await sleep((+res.headers.get('retry-after') || 60) * 1000);
      continue;
    }
    if (res.status === 451) throw new Error('Binance blocks this machine’s region (HTTP 451).');
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return res.json();
  }
}

/** Up to 3,000 closed candles, two requests. */
async function candles(symbol) {
  const now = Date.now();
  const older = await get('/fapi/v1/klines', { symbol, interval: TF, limit: 1500, endTime: now - 1500 * MS });
  const newer = await get('/fapi/v1/klines', { symbol, interval: TF, limit: 1500 });
  const seen = new Set();
  return [...older, ...newer]
    .filter((k) => k[0] + MS <= now && !seen.has(k[0]) && seen.add(k[0]))
    .sort((a, b) => a[0] - b[0])
    .map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] }));
}

/** Forward outcome of entering at bar i's close in direction side. */
function outcome(bars, i, side, atrNow) {
  if (i + HORIZONS.at(-1) >= bars.length) return null;
  const c = bars[i].c;
  const ret = {};
  for (const h of HORIZONS) ret[h] = side * ((bars[i + h].c - c) / c) * 100 - COST;
  let race = null;
  for (let k = i + 1; k <= i + 24 && race == null; k++) {
    const hitStop = side > 0 ? bars[k].l <= c - atrNow : bars[k].h >= c + atrNow;
    const hitTarget = side > 0 ? bars[k].h >= c + 2 * atrNow : bars[k].l <= c - 2 * atrNow;
    if (hitStop) race = 0; // same candle: count the stop first
    else if (hitTarget) race = 1;
  }
  return { ret, race: race ?? 0 };
}

function summary(list) {
  const n = list.length;
  if (!n) return { n: 0 };
  const out = { n };
  for (const h of HORIZONS) {
    const v = list.map((x) => x.ret[h]).sort((a, b) => a - b);
    const mean = v.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
    out[h] = { mean, median: v[Math.floor(n / 2)], up: v.filter((x) => x > 0).length / n, se: sd / Math.sqrt(n) };
  }
  out.race = list.reduce((s, x) => s + x.race, 0) / n;
  return out;
}

const top = (await get('/fapi/v1/ticker/24hr'))
  .filter((t) => /USDT$/.test(t.symbol))
  .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
  .slice(0, PAIRS)
  .map((t) => t.symbol);

const fresh = [], late = [], every = [], highs = [], everyLong = [];
const coins = new Map(); // symbol -> { bars, ind, at: Map(t -> index) } for the cross-coin momentum test
let cutT = new Map();
for (const [n, symbol] of top.entries()) {
  let bars;
  try {
    bars = await candles(symbol);
  } catch (e) {
    console.log(`${n + 1}/${top.length} ${symbol} skipped: ${e.message}`);
    continue;
  }
  if (bars.length < 200) {
    console.log(`${n + 1}/${top.length} ${symbol} skipped: only ${bars.length} candles`);
    continue;
  }
  cutT.set(symbol, bars[0].t + (bars.at(-1).t - bars[0].t) * 0.7);
  const ind = indicators(bars, TREND);
  coins.set(symbol, { bars, ind, at: new Map(bars.map((b, i) => [b.t, i])) });
  // Variant B: first close at a new 50-candle high (low) in 50 candles, with EMA 20/50 agreeing.
  let lastHigh = -Infinity;
  for (let i = 100; i < bars.length - HORIZONS.at(-1); i++) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - 50; k < i; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
    const side = bars[i].c > hi ? 1 : bars[i].c < lo ? -1 : 0;
    if (!side || side * (ind.fast[i] - ind.slow[i]) <= 0 || i - lastHigh < 50) continue;
    lastHigh = i;
    const o = outcome(bars, i, side, ind.atr[i]);
    if (o) highs.push({ symbol, t: bars[i].t, side, ...o });
  }
  let lastCross = -1, lastLateCross = -1, count = 0;
  for (let i = TREND.slow + TREND.breakoutN + 5; i < bars.length - HORIZONS.at(-1); i++) {
    const side = Math.sign(ind.fast[i] - ind.slow[i]);
    if (side && i % 6 === 0) {
      const o = outcome(bars, i, side, ind.atr[i]);
      if (o) every.push({ symbol, t: bars[i].t, side, ...o });
      const ol = outcome(bars, i, 1, ind.atr[i]);
      if (ol) everyLong.push({ symbol, t: bars[i].t, side: 1, ...ol }); // buy anything: the market's own drift
    }
    const tr = trendAt(bars, i, TREND, ind);
    if (!tr) continue;
    if (tr.fresh && tr.cross !== lastCross) {
      lastCross = tr.cross;
      const o = outcome(bars, i, tr.side, ind.atr[i]);
      if (!o) continue;
      const loc = location(bars, i, tr.side, TREND, ind.atr[i]);
      fresh.push({ symbol, t: bars[i].t, side: tr.side, age: tr.age, adx: tr.adx, stretched: tr.stretched, zone: loc.zone, ...o });
      count++;
    } else if (!tr.fresh && tr.cross !== lastLateCross) {
      lastLateCross = tr.cross;
      const o = outcome(bars, i, tr.side, ind.atr[i]);
      if (o) late.push({ symbol, t: bars[i].t, side: tr.side, ...o });
    }
  }
  console.log(`${n + 1}/${top.length} ${symbol}: ${bars.length} candles, ${count} fresh trends`);
}

const pct = (v) => (v == null ? '     –' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`.padStart(7));
const row = (label, s) =>
  s.n
    ? `${label.padEnd(34)} ${String(s.n).padStart(5)}  ${HORIZONS.map((h) => `${pct(s[h].mean)} ${`${Math.round(s[h].up * 100)}%`.padStart(4)}`).join('  ')}  ${`${Math.round(s.race * 100)}%`.padStart(4)}`
    : `${label.padEnd(34)}     0`;
const header = () => console.log(`${''.padEnd(34)} ${'n'.padStart(5)}  ${HORIZONS.map((h) => `+${h} candles`.padEnd(12)).join('  ')}  2:1 race`);
const split = (list) => [list.filter((x) => x.t < cutT.get(x.symbol)), list.filter((x) => x.t >= cutT.get(x.symbol))];

const result = { t: Date.now(), tf: TF, pairs: top.length, cfg: TREND, groups: {} };
const show = (label, list) => {
  const s = summary(list);
  result.groups[label] = s;
  console.log(row(label, s));
};

console.log(`\nTrend radar test, ${TF} candles, ${cutT.size} coins. Return in the trend's direction after ${COST}% costs; % = share that went the right way; 2:1 race = reached +2 ATR before -1 ATR (break-even 33%).\n`);
header();
show('Fresh trends (radar)', fresh);
show('Late trends (same rules, older)', late);
show('Every candle, EMA direction', every);
const [fs, fu] = split(fresh);
const [es, eu] = split(every);
show('Fresh, older 70%', fs);
show('Fresh, newest 30%', fu);
show('Every candle, older 70%', es);
show('Every candle, newest 30%', eu);
console.log('\nFresh trends by where price was:');
header();
for (const z of ['open', 'clear', 'support', 'resistance']) show(`  near ${z}`.replace('near open', 'open (no level ahead)').replace('near clear', 'clear (room both ways)'), fresh.filter((x) => x.zone === z));
show('  stretched (> 2.5 ATR past EMA 20)', fresh.filter((x) => x.stretched));
show('  not stretched', fresh.filter((x) => !x.stretched));
show('  ADX under 15', fresh.filter((x) => x.adx < 15));
show('  ADX 15–25', fresh.filter((x) => x.adx >= 15 && x.adx < 25));
show('  ADX 25 or more', fresh.filter((x) => x.adx >= 25));
show('  started 0–3 candles ago', fresh.filter((x) => x.age <= 3));
show('  started 4–8 candles ago', fresh.filter((x) => x.age >= 4 && x.age <= 8));
show('  started 9–12 candles ago', fresh.filter((x) => x.age >= 9));
show('  uptrends', fresh.filter((x) => x.side > 0));
show('  downtrends', fresh.filter((x) => x.side < 0));

// Variant C: cross-coin momentum. Every 24 candles, rank all coins by their return over the last 120 candles;
// go with the top 10% (long) and the bottom 10% (short).
const momentum = [];
const times = [...new Set([...coins.values()].flatMap((c) => c.bars.map((b) => b.t)))].sort((a, b) => a - b);
for (let n = 120; n < times.length; n += 24) {
  const t = times[n];
  const ranked = [];
  for (const [symbol, c] of coins) {
    const i = c.at.get(t);
    if (i == null || i < 120 || i + HORIZONS.at(-1) >= c.bars.length) continue;
    ranked.push({ symbol, c, i, r: c.bars[i].c / c.bars[i - 120].c - 1 });
  }
  if (ranked.length < 10) continue;
  ranked.sort((a, b) => b.r - a.r);
  const k = Math.max(2, Math.round(ranked.length * 0.1));
  for (const [list, side] of [[ranked.slice(0, k), 1], [ranked.slice(-k), -1]]) {
    for (const x of list) {
      const o = outcome(x.c.bars, x.i, side, x.c.ind.atr[x.i]);
      if (o) momentum.push({ symbol: x.symbol, t, side, ...o });
    }
  }
}

console.log('\nOther definitions of "trending now", same measurements:');
header();
show('B: first new 50-candle high/low', highs);
const [hs, hu] = split(highs);
show('B, older 70%', hs);
show('B, newest 30%', hu);
show('C: top/bottom 10% by 120-candle return', momentum);
const [ms, mu] = split(momentum);
show('C, older 70%', ms);
show('C, newest 30%', mu);
show('C, longs (top 10%)', momentum.filter((x) => x.side > 0));
show('C, shorts (bottom 10%)', momentum.filter((x) => x.side < 0));
const cl = momentum.filter((x) => x.side > 0);
const [cls, clu] = split(cl);
show('C longs, older 70%', cls);
show('C longs, newest 30%', clu);
const [ls, lu] = split(everyLong);
show('Buy any coin, any candle', everyLong);
show('Buy any coin, older 70%', ls);
show('Buy any coin, newest 30%', lu);

// Stricter than before: the edge must beat the noise on BOTH halves, not just be positive.
const beats = (a, b, c, d, what) => {
  const [A, B, C, D] = [a, b, c, d].map(summary);
  if ((A.n ?? 0) < 50 || (B.n ?? 0) < 50) return 'too few cases';
  const e1 = A[12].mean - C[12].mean, e2 = B[12].mean - D[12].mean;
  const ok1 = e1 > 2 * A[12].se, ok2 = e2 > 2 * B[12].se;
  const nums = `+12 candles: ${pct(e1).trim()} older (noise ±${(2 * A[12].se).toFixed(2)}%), ${pct(e2).trim()} newest (±${(2 * B[12].se).toFixed(2)}%)`;
  return ok1 && ok2 ? `beats ${what} on both halves, beyond noise (${nums})` : `does not clearly beat ${what} (${nums})`;
};
result.variants = {
  B: beats(hs, hu, es, eu, 'any-candle trend following'),
  C: beats(ms, mu, es, eu, 'any-candle trend following'),
  Clong: beats(cls, clu, ls, lu, 'buying any coin'),
};
console.log(`\nB: ${result.variants.B}\nC: ${result.variants.C}\nC longs only: ${result.variants.Clong}`);

// Verdict on the main question: do fresh trends beat trading any candle in the EMA direction, on both halves?
const edge = (a, b) => (a.n && b.n ? a[12].mean - b[12].mean : null);
const e1 = edge(summary(fs), summary(es)), e2 = edge(summary(fu), summary(eu));
const se = summary(fu)[12]?.se ?? 0;
let verdict;
if ((summary(fu).n ?? 0) < 50) verdict = 'Too few fresh trends on the newest 30% to judge. Try --pairs 100 or another --tf.';
else if (e1 > 0 && e2 > 0 && e2 > se) verdict = `Fresh trends beat any-candle trend following on both halves (+12 candles: ${pct(e1).trim()} older, ${pct(e2).trim()} newest).`;
else if (e2 > 0) verdict = 'Fresh trends did better on the newest 30% only, or by less than the noise: not consistent.';
else verdict = 'Fresh trends did not beat trading any candle in the EMA direction.';
result.verdict = verdict;
console.log(`\nVerdict: ${verdict}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(`Saved to ${OUT}. Differences smaller than about 0.3% at +12 candles are within noise.`);
