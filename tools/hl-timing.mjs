#!/usr/bin/env node
// Were the picked Hyperliquid traders' entries well timed, or were they simply on the right side of the market?
// Run after tools/hl-traders.mjs, where Hyperliquid is reachable (your VPS). Node 22+, no dependencies.
//
//   node tools/hl-timing.mjs                  # the traders saved by the last hl-traders run, last 60 days
//   node tools/hl-timing.mjs --coins 60       # fetch candles for more coins (default: the 40 they enter most)
//   node tools/hl-timing.mjs --address 0xabc…,0xdef…   # specific accounts instead
//
// An "entry" is any hour in which a trader made a futures position bigger (all their small orders in that hour,
// on one coin and side, count once). For each entry it measures, on hourly candles:
//   before   what price did in the 24 hours before (did they buy after a rise, or after a fall?) and where their
//            price sat in the last 7 days' range (0 = the low, 1 = the high)
//   after    the % result in their direction 24 and 72 hours later, from their own price
// and compares "after" with entering the SAME side on the SAME coin at any hour of their active period. A trader
// who was short while the market fell made money at any hour: that part is "side". What is left over is "timing".
// If timing is about zero, copying their entries teaches nothing: the money came from which side they were on
// (and how big), and this month's winners are by definition the ones who were on the right side this month.
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { entryEvents, timingStats, meanSe } from '../js/hl.js';
import { windowFills, hourly, GAP } from './hl-api.mjs';

process.on('uncaughtException', (e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const DATA = fileURLToPath(new URL('../worker/data/', import.meta.url));
const DAY = 86_400_000, HOUR = 3_600_000;
const HORIZONS = [24, 72];
const MAX_COINS = +arg('coins', 40);
const MIN_ENTRIES = 15;

function latest() {
  let names = [];
  try {
    names = readdirSync(DATA).filter((n) => /^hl-traders-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  } catch { /* no data folder yet */ }
  return names.length ? DATA + names.at(-1) : null;
}

let traders, days = +arg('days', 60);
const addresses = arg('address', null);
if (addresses) {
  traders = addresses.split(',').map((a) => ({ address: a.trim().toLowerCase(), style: '' })).filter((t) => /^0x[0-9a-f]{40}$/.test(t.address));
  if (!traders.length) throw new Error('--address needs one or more 0x… addresses, separated by commas.');
} else {
  const file = arg('file', latest());
  if (!file) throw new Error('No saved traders. Run node tools/hl-traders.mjs first.');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  days = +arg('days', saved.days ?? 60);
  traders = saved.traders.filter((t) => t.stats && t.stats.fills >= 30 && t.stats.style !== 'Mostly spot').map((t) => ({ address: t.address, name: t.name, style: t.stats.style }));
  console.log(`Using ${file}: ${traders.length} of ${saved.traders.length} traders have enough futures trades to study.`);
}
traders = traders.slice(0, +arg('top', traders.length));

const now = Date.now();
const since = now - days * DAY;
console.log(`Reading ${traders.length} traders' last ${days} days of fills, then hourly candles for up to ${MAX_COINS} coins. About ${Math.ceil(((traders.length * 3 + MAX_COINS * 2) * GAP) / 60_000)} minutes…\n`);

// 1. Entries per trader.
const perCoin = new Map();
for (const t of traders) {
  try {
    t.events = entryEvents((await windowFills(t.address, since)).list);
  } catch (e) {
    t.events = [];
    console.log(`(could not read ${t.address}: ${e.message})`);
  }
  for (const ev of t.events) perCoin.set(ev.coin, (perCoin.get(ev.coin) ?? 0) + 1);
}

// 2. Candles for the coins they enter most: a week before the window (for the range) up to now.
const coins = [...perCoin.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_COINS).map(([c]) => c);
const bars = new Map();
for (const coin of coins) {
  try {
    const list = await hourly(coin, since - 8 * DAY, now);
    if (list.length >= 200) bars.set(coin, list);
  } catch { /* a delisted or renamed coin: its entries are left out */ }
}
const covered = [...perCoin.entries()].filter(([c]) => bars.has(c)).reduce((s, [, n]) => s + n, 0);
const total = [...perCoin.values()].reduce((s, n) => s + n, 0);
console.log(`${total} entries across ${perCoin.size} coins; candles for ${bars.size} coins cover ${total ? Math.round((covered / total) * 100) : 0}% of them.\n`);

// 3. Per trader.
const pc = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const ret = (v) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`);
const results = [];
for (const [i, t] of traders.entries()) {
  const s = timingStats(t.events.filter((ev) => bars.has(ev.coin)), bars, HORIZONS);
  const h24 = s?.horizons[24];
  console.log(`#${i + 1} ${t.address}${t.name ? ` (${t.name})` : ''}${t.style ? ` · ${t.style}` : ''}`);
  if (!s || !h24 || h24.n < MIN_ENTRIES) {
    console.log(`   Too few entries to measure (${h24?.n ?? 0}).\n`);
    continue;
  }
  results.push({ ...t, events: undefined, timing: { ...s, horizons: Object.fromEntries(HORIZONS.map((n) => [n, { ...s.horizons[n], edges: undefined }])) }, edges: Object.fromEntries(HORIZONS.map((n) => [n, s.horizons[n].edges])) });
  console.log(`   ${s.entries} entries on ${s.coins} coin${s.coins === 1 ? '' : 's'} · ${pc(s.longShare)} of them longs`);
  console.log(`   Before: ${pc(s.withMove)} came after price had already moved their way in the last 24h${s.withMove == null ? '' : s.withMove >= 0.6 ? ' (follows moves)' : s.withMove <= 0.4 ? ' (goes against moves)' : ' (no lean)'} · longs placed at ${s.longRangePos == null ? '–' : s.longRangePos.toFixed(2)} of the week's range, shorts at ${s.shortRangePos == null ? '–' : s.shortRangePos.toFixed(2)}`);
  for (const n of HORIZONS) {
    const h = s.horizons[n];
    if (!h.n) continue;
    const call = h.timing > h.noise ? 'well timed' : h.timing < -h.noise ? 'badly timed' : 'no clear timing';
    console.log(`   After ${n}h: their entries ${ret(h.own)} · same side at any hour ${ret(h.side)} · timing ${ret(h.timing)} ±${h.noise.toFixed(2)} (${call}, ${h.n} entries)`);
  }
  console.log('');
}

// 4. Together.
if (!results.length) throw new Error('No trader had enough entries to measure.');
console.log(`Together (${results.length} trader${results.length === 1 ? '' : 's'} with ${MIN_ENTRIES}+ measured entries). ±: noise range, 2 standard errors; entries overlap in time, so the true range is wider.`);
const summary = {};
for (const n of HORIZONS) {
  const edges = results.flatMap((r) => r.edges[n]);
  const pooled = meanSe(edges);
  const per = results.map((r) => r.timing.horizons[n]).filter((h) => h.n >= MIN_ENTRIES);
  const sorted = per.map((h) => h.timing).sort((a, b) => a - b);
  const mid = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const good = per.filter((h) => h.timing > h.noise).length, bad = per.filter((h) => h.timing < -h.noise).length;
  const own = meanSe(per.map((h) => h.own)).mean, side = meanSe(per.map((h) => h.side)).mean;
  summary[n] = { entries: pooled.n, timing: pooled.mean, noise: pooled.noise, middleTrader: mid, wellTimed: good, badlyTimed: bad, traders: per.length, own, side };
  console.log(`  After ${n}h: average trader's entries ${ret(own)}, of which side ${ret(side)} · all ${pooled.n} entries pooled: timing ${ret(pooled.mean)} ±${pooled.noise.toFixed(2)} · middle trader ${ret(mid)} · ${good} of ${per.length} well timed, ${bad} badly timed`);
}
const moves = results.map((r) => r.timing.withMove).filter((v) => v != null).sort((a, b) => a - b);
const follow = moves.filter((v) => v >= 0.6).length, fade = moves.filter((v) => v <= 0.4).length;
console.log(`  How they enter: ${follow} follow the last day's move, ${fade} go against it, ${moves.length - follow - fade} show no lean.`);
const a = summary[24], b = summary[72];
const timed = a.timing > a.noise && b.timing > b.noise && a.middleTrader > 0 && b.middleTrader > 0;
const verdict = timed
  ? 'Their entries did better than entering the same side at any hour, at both horizons: timing was part of the edge.'
  : (a.side > 0 && Math.abs(a.timing) <= Math.max(a.noise, Math.abs(a.side)))
    ? 'Their entries did about as well as entering the same side at any hour: the money came from which side they were on, not from when they entered.'
    : 'No clear timing edge in their entries.';
console.log(`\nVerdict: ${verdict}`);
console.log('Remember how they were picked: accounts in profit this month and this week. Being on the right side lately is how they got on the list.');

mkdirSync(DATA, { recursive: true });
const out = arg('out', `${DATA}hl-timing-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(out, JSON.stringify({ t: now, days, coins: bars.size, summary, verdict, traders: results.map(({ edges, ...r }) => r) }, null, 1));
console.log(`Saved to ${out}.`);
