#!/usr/bin/env node
// Do Fibonacci levels matter in the first pullback after a pump? Run where Binance is reachable (your VPS).
// Node 22+, no dependencies.
//
//   node tools/fib.mjs                 # top 60 coins by volume, 4h candles (about 500 days)
//   node tools/fib.mjs --tf 1h
//   node tools/fib.mjs --pairs 100
//
// For every clean pump (js/fib.js) it buys the first touch of each retracement level during the first
// correction, with the classic plan: stop just under the pump's low, target the pump's high, 48 candles max.
// Results in R (1R = entry to the low), after 0.1% costs. The question is whether the Fibonacci levels
// (0.382 / 0.5 / 0.618 / 0.786) do better than the same plan at other depths (0.30 / 0.44 / 0.56 / 0.70):
// if Fibonacci levels are special, buying at them should beat buying a little above or below them.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIB, fibTouches } from '../js/fib.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PAIRS = +arg('pairs', 60);
const TF = arg('tf', '4h');
const MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[TF];
if (!MS) throw new Error('--tf must be 15m, 1h, 4h or 1d');
const OUT = arg('out', fileURLToPath(new URL(`../worker/data/fib-${TF}.json`, import.meta.url)));
const FAPI = process.env.FAPI_URL || 'https://fapi.binance.com';
const COST = 0.1; // % round trip
const MAX_HOLD = 48;
const FIBS = [0.382, 0.5, 0.618, 0.786];
const CONTROLS = [0.3, 0.44, 0.56, 0.7];

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

/** Plan from the touch: stop just under the pump's low, target the pump's high. Result in R after costs. */
function trade(bars, ev) {
  const { i, entry, high, low } = ev;
  const stop = low * 0.998;
  const risk = entry - stop;
  if (!(risk > 0) || i + MAX_HOLD >= bars.length) return null;
  const costR = (entry * COST) / 100 / risk;
  // The touching candle itself: if it also ran through the stop, count the stop (worst case).
  if (bars[i].l <= stop) return { ...ev, r: -1 - costR, exit: 'stop', bars: 0 };
  for (let k = i + 1; k <= i + MAX_HOLD; k++) {
    if (bars[k].l <= stop) return { ...ev, r: -1 - costR, exit: 'stop', bars: k - i };
    if (bars[k].h >= high) return { ...ev, r: (high - entry) / risk - costR, exit: 'target', bars: k - i };
  }
  const c = bars[i + MAX_HOLD].c;
  return { ...ev, r: (c - entry) / risk - costR, exit: 'time', bars: MAX_HOLD };
}

function summary(list) {
  const n = list.length;
  if (!n) return { n: 0 };
  const rs = list.map((x) => x.r);
  const mean = rs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  return {
    n,
    expR: mean,
    se: sd / Math.sqrt(n),
    target: list.filter((x) => x.exit === 'target').length / n,
    stop: list.filter((x) => x.exit === 'stop').length / n,
    win: list.filter((x) => x.r > 0).length / n,
    avgWinR: list.filter((x) => x.r > 0).reduce((s, x) => s + x.r, 0) / Math.max(1, list.filter((x) => x.r > 0).length),
  };
}

const top = (await get('/fapi/v1/ticker/24hr'))
  .filter((t) => /USDT$/.test(t.symbol))
  .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
  .slice(0, PAIRS)
  .map((t) => t.symbol);

const trades = [];
const cutT = new Map();
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
  const touches = fibTouches(bars, [...FIBS, ...CONTROLS], FIB);
  const pumps = new Set(touches.map((x) => x.iH)).size;
  let count = 0;
  for (const ev of touches) {
    const tr = trade(bars, ev);
    if (!tr) continue;
    trades.push({ symbol, t: bars[ev.i].t, ratio: ev.ratio, fib: FIBS.includes(ev.ratio), pumpPct: ev.pumpPct, r: tr.r, exit: tr.exit });
    count++;
  }
  console.log(`${n + 1}/${top.length} ${symbol}: ${bars.length} candles, ${pumps} pumps with a first pullback, ${count} level touches`);
}

const split = (list) => [list.filter((x) => x.t < cutT.get(x.symbol)), list.filter((x) => x.t >= cutT.get(x.symbol))];
const fmtR = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`.padStart(7);
const pc = (v) => `${Math.round(v * 100)}%`.padStart(4);
const result = { t: Date.now(), tf: TF, pairs: cutT.size, cfg: FIB, groups: {} };
const show = (label, list) => {
  const s = summary(list);
  result.groups[label] = s;
  console.log(s.n
    ? `${label.padEnd(30)} ${String(s.n).padStart(5)}  ${fmtR(s.expR)} ±${(2 * s.se).toFixed(2)}  ${pc(s.target)}   ${pc(s.stop)}   ${pc(s.win)}`
    : `${label.padEnd(30)}     0`);
};
const header = () => console.log(`${''.padEnd(30)} ${'n'.padStart(5)}  ${'per trade'.padEnd(13)} to high  stopped  won`);

console.log(`\nFirst-pullback test, ${TF} candles, ${cutT.size} coins. Buy at the level, stop under the pump's low, target the pump's high, ${MAX_HOLD} candles max, ${COST}% costs. ±: noise range (2 standard errors).\n`);
header();
const fib = trades.filter((x) => x.fib), ctl = trades.filter((x) => !x.fib);
show('All Fibonacci levels', fib);
show('All other depths (control)', ctl);
const [fs, fu] = split(fib), [cs, cu] = split(ctl);
show('Fibonacci, older 70%', fs);
show('Fibonacci, newest 30%', fu);
show('Control, older 70%', cs);
show('Control, newest 30%', cu);
console.log('\nBy depth (Fibonacci levels marked *):');
header();
for (const ratio of [...FIBS, ...CONTROLS].sort((a, b) => a - b)) show(`${FIBS.includes(ratio) ? '*' : ' '} ${ratio.toFixed(3)}`, trades.filter((x) => x.ratio === ratio));
console.log('\nFibonacci levels by pump size:');
header();
show('  pump 15–30%', fib.filter((x) => x.pumpPct < 30));
show('  pump 30–60%', fib.filter((x) => x.pumpPct >= 30 && x.pumpPct < 60));
show('  pump 60%+', fib.filter((x) => x.pumpPct >= 60));

const S = (l) => summary(l);
const edge = (a, b) => (S(a).n && S(b).n ? S(a).expR - S(b).expR : null);
const noise = (a, b) => 2 * Math.sqrt(S(a).se ** 2 + S(b).se ** 2);
const e1 = edge(fs, cs), e2 = edge(fu, cu);
let verdict;
if ((S(fu).n ?? 0) < 50 || (S(cu).n ?? 0) < 50) verdict = 'Too few touches on the newest 30% to judge. Try --pairs 100.';
else if (e1 > noise(fs, cs) && e2 > noise(fu, cu)) verdict = `Fibonacci levels beat other depths on both halves, beyond noise (${fmtR(e1).trim()} older, ${fmtR(e2).trim()} newest per trade).`;
else verdict = `Fibonacci levels did not clearly beat other depths (${fmtR(e1).trim()} older, ${fmtR(e2).trim()} newest per trade; noise about ±${noise(fu, cu).toFixed(2)}R).`;
const plan = S(fib);
const planVerdict = (S(fs).expR > 2 * S(fs).se && S(fu).expR > 2 * S(fu).se)
  ? 'The buy-the-pullback plan itself made money on both halves, beyond noise.'
  : 'The buy-the-pullback plan itself did not clearly make money on both halves.';
result.verdict = verdict;
result.planVerdict = planVerdict;
console.log(`\nVerdict: ${verdict}\n${planVerdict} (all Fibonacci touches: ${fmtR(plan.expR ?? 0).trim()} per trade over ${plan.n}).`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(`Saved to ${OUT}.`);
