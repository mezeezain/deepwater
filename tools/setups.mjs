#!/usr/bin/env node
// Setups lab over many pairs: the same engine as the Setups lab page, with a sample large enough to judge.
// Node 22+, no dependencies. Run it where Binance is reachable (e.g. your whale data server).
//
//   node tools/setups.mjs                    # top 40 pairs by volume, 1h candles
//   node tools/setups.mjs --pairs 80 --tf 4h
//   node tools/setups.mjs --compare          # does each quality filter help? baseline vs each filter vs all,
//                                            # on the older 70% of each pair's history and the newest 30%
//
// Prints paper vs realistic results per setup and the split by whale positioning; saves the trades as JSON (--out).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLab, breakdown, summarizeTrades, MODELS, FILTERS, LAB_DEFAULTS } from '../js/setups.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PAIRS = +arg('pairs', 40);
const COMPARE = process.argv.includes('--compare');
const TF = arg('tf', '1h');
const OUT = arg('out', fileURLToPath(new URL(`../worker/data/setups-${TF}.json`, import.meta.url)));
const FAPI = process.env.FAPI_URL || 'https://fapi.binance.com';
const MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 }[TF];
if (!MS) throw new Error('--tf must be 15m, 1h or 4h');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function get(path, params) {
  const wait = lastCall + 300 - Date.now();
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

async function positioning(path, symbol) {
  const from = Date.now() - 30 * 86_400_000 + 60_000;
  const out = new Map();
  let end = Date.now();
  while (end > from) {
    let rows;
    try {
      rows = await get(path, { symbol, period: TF, limit: 500, endTime: end });
    } catch {
      break;
    }
    if (!rows.length) break;
    for (const r of rows) out.set(Math.floor((+r.timestamp - 1) / MS) * MS, +r.longAccount);
    const earliest = Math.min(...rows.map((r) => +r.timestamp));
    if (rows.length < 500 || earliest >= end) break;
    end = earliest - 1;
  }
  return out;
}

async function pair(symbol) {
  const kl = await get('/fapi/v1/klines', { symbol, interval: TF, limit: 1500 });
  const w = await positioning('/futures/data/topLongShortPositionRatio', symbol);
  const c = await positioning('/futures/data/globalLongShortAccountRatio', symbol);
  const funding = (await get('/fapi/v1/fundingRate', { symbol, limit: 1000 })).map((r) => ({ t: +r.fundingTime, rate: +r.fundingRate }));
  const bars = kl.filter((k) => k[0] + MS <= Date.now()).map((k) => ({
    t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7], takerBuy: +k[10],
    whaleLong: w.get(k[0]) ?? null, crowdLong: c.get(k[0]) ?? null,
  }));
  return { symbol, bars, funding };
}

const tickers = await get('/fapi/v1/ticker/24hr', {});
const symbols = tickers.filter((t) => t.symbol.endsWith('USDT')).sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, PAIRS).map((t) => t.symbol);
const loaded = [];
for (const [n, s] of symbols.entries()) {
  try {
    loaded.push(await pair(s));
    console.log(`${n + 1}/${symbols.length} ${s}`);
  } catch (e) {
    console.log(`${n + 1}/${symbols.length} ${s} skipped: ${e.message}`);
  }
}
const labTrades = (cfg) => loaded.flatMap(({ symbol, bars, funding }) => runLab(bars, cfg, funding).trades.map((t) => ({ ...t, symbol })));
const trades = labTrades(LAB_DEFAULTS);
if (COMPARE) {
  compare();
  process.exit(0);
}

/**
 * Baseline vs each filter vs all filters together. Each pair's history is split by time: the older 70%
 * ("seen") and the newest 30% ("unseen"). A filter is worth switching on only if it also helps on the
 * unseen part, with enough trades left to tell.
 */
function compare() {
  const cut = new Map(loaded.map(({ symbol, bars }) => [symbol, bars[0].t + (bars.at(-1).t - bars[0].t) * 0.7]));
  const split = (list) => [list.filter((t) => t.entryT < cut.get(t.symbol)), list.filter((t) => t.entryT >= cut.get(t.symbol))];
  const runs = [
    ['Baseline (no filters)', {}],
    ...Object.entries(FILTERS).map(([id, f]) => [f.name, { [id]: true }]),
    ['All filters together', Object.fromEntries(Object.keys(FILTERS).map((id) => [id, true]))],
  ];
  const r2 = (v) => (v == null ? '    –' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`.padStart(5) + 'R');
  const cell = (st) => (st?.n ? `${String(st.n).padStart(4)} ${r2(st.expR)} ${`${Math.round(st.netWin * 100)}%`.padStart(4)}` : '   0      –    –');
  const result = {};
  const base = {};
  for (const scope of ['all', ...Object.keys(MODELS)]) {
    console.log(`\n${scope === 'all' ? 'All setups' : MODELS[scope].name}, ${TF}, ${loaded.length} pairs. Columns: trades, expectancy per trade after costs, % that made money.`);
    console.log(`${''.padEnd(30)} ${'seen (older 70%)'.padEnd(20)} ${'unseen (newest 30%)'.padEnd(20)} verdict`);
    for (const [label, filters] of runs) {
      const list = labTrades({ ...LAB_DEFAULTS, filters }).filter((t) => scope === 'all' || t.model === scope);
      const [seen, unseen] = split(list).map(summarizeTrades);
      if (!Object.keys(filters).length) base[scope] = { seen, unseen };
      const b0 = base[scope];
      let verdict = '';
      const NOT_FOR = { trend: ['regime'], chop: ['sweep'], sweepCandle: ['retest', 'regime'] };
      const only = Object.keys(filters).length === 1 ? Object.keys(filters)[0] : null;
      if (only && NOT_FOR[only]?.includes(scope)) verdict = 'not applied to this setup';
      else if (Object.keys(filters).length) {
        const better = (x, y) => x?.n && y?.n && x.expR > y.expR;
        if ((unseen.n ?? 0) < 30) verdict = 'too few unseen trades to judge';
        else if (better(seen, b0.seen) && better(unseen, b0.unseen)) verdict = `helps (${r2(unseen.expR - b0.unseen.expR).trim()} per trade unseen)`;
        else if (better(unseen, b0.unseen)) verdict = 'helps on unseen only: not consistent';
        else verdict = 'does not help';
      }
      console.log(`${label.padEnd(30)} ${cell(seen).padEnd(20)} ${cell(unseen).padEnd(20)} ${verdict}`);
      (result[scope] ||= []).push({ label, filters, seen, unseen, verdict });
    }
  }
  const out = OUT.replace(/\.json$/, '-compare.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ t: Date.now(), tf: TF, pairs: loaded.map((p) => p.symbol), result }, null, 1));
  console.log(`\nSaved to ${out}. Expectancy is in R (1R = the distance to the stop). Treat any difference under about 0.05R, or with under 30 unseen trades, as noise.`);
}

const b = breakdown(trades);
const pct = (v) => (v == null ? '  –' : `${Math.round(v * 100)}%`.padStart(4));
const r = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
const line = (label, s) => s?.n
  ? `${label.padEnd(34)} ${String(s.n).padStart(5)}  paper ${pct(s.paperWin)}  net ${pct(s.netWin)}  PF ${s.pf == null ? '–' : s.pf.toFixed(2)}  exp ${r(s.expR)} (${r(s.expLo)} to ${r(s.expHi)})  costs ${r(-s.feeR)}`
  : null;
console.log(`\n${trades.length} trades, ${symbols.length} pairs, ${TF} candles. Paper = TP1 before stop, no costs. Net = after fees, slippage, funding.\n`);
console.log([line('All setups', b.all), ...Object.entries(MODELS).map(([id, m]) => line(m.name, b.models[id]))].filter(Boolean).join('\n'));
console.log('\nBy whale positioning at the signal (top 20% accounts vs all accounts):');
for (const w of ['with', 'neutral', 'against', 'none']) {
  const out = [line(`All · ${w}`, b.whales[w]), ...Object.entries(MODELS).map(([id, m]) => line(`  ${m.name} · ${w}`, b.modelWhale[`${id}:${w}`]))].filter(Boolean);
  if (out.length) console.log(out.join('\n'));
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ t: Date.now(), tf: TF, pairs: symbols, summary: b, trades }, null, 1));
console.log(`\nSaved to ${OUT}`);
