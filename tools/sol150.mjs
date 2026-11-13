#!/usr/bin/env node
// A real check of the "4H Regime + 1H Liquidity Sweep (SOL-150)" plan: its rules replayed on real Binance
// futures candles, with real funding, instead of the "modelled" 120-trade table that came with it.
// Run where Binance is reachable (your VPS). Node 22+, no dependencies.
//
//   node tools/sol150.mjs                    # SOLUSDT, about 560 days of 1h candles, plus the top 15 coins pooled
//   node tools/sol150.mjs --symbol ETHUSDT
//   node tools/sol150.mjs --pairs 0          # the one coin only
//   node tools/sol150.mjs --days 300
//
// The rules are in js/sweep-regime.js, exactly as the plan states them: 4h EMA 20/50 + ADX > 20 + ATR(14) > ATR(50)
// regime; a 1h wick through a swing high/low near the 4h EMA 20 that closes back inside with RSI turning; limit
// entry at that close; stop 1.2 ATR beyond the wick; half off at +2R, stop to a 0.1R profit, rest at +4R; funding
// and BTC gates; one position at a time; 1.5% risk compounding from $150. Costs: 0.02% maker in and on targets,
// 0.05% taker + 0.05% slippage on stops, funding as actually paid. A candle that touches both the stop and a
// target counts as the stop. Not modelled: the "no trading around CPI / FOMC / NFP" rule.
//
// What to compare with: the plan claims 27% of trades hit both targets, 22% hit the first, 52% stop out
// (+0.445R a trade, profit factor 1.78, $150 -> $295 in six months, 20 trades a month). With no edge at all,
// this exit plan gives 17% / 17% / 67% and zero before costs: that is just the arithmetic of a 2R and a 4R target.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SR, signals, simulate, runTrade, tradeSummary, to4h, regime4h, last4hIndex } from '../js/sweep-regime.js';
import { atr } from '../js/setups.js';

process.on('uncaughtException', (e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const SYMBOL = String(arg('symbol', 'SOLUSDT')).toUpperCase();
const DAYS = +arg('days', 560);
const PAIRS = +arg('pairs', 15);
const OUT = arg('out', fileURLToPath(new URL(`../worker/data/sol150-${SYMBOL}.json`, import.meta.url)));
const FAPI = process.env.FAPI_URL || 'https://fapi.binance.com';
const GAP = +(process.env.FAPI_GAP_MS ?? 400);
const HOUR = 3_600_000, DAY = 86_400_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function get(path, params) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
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

/** Closed 1h candles for the last `days` days, oldest first. */
async function candles(symbol, days, now) {
  const from = now - days * DAY;
  const seen = new Map();
  let end = now;
  for (let page = 0; page < 40 && end > from; page++) {
    const batch = await get('/fapi/v1/klines', { symbol, interval: '1h', limit: 1500, endTime: end });
    if (!Array.isArray(batch) || !batch.length) break;
    for (const k of batch) seen.set(k[0], { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
    const first = batch[0][0];
    if (first >= end) break;
    end = first - 1;
    if (batch.length < 1500) break;
  }
  return [...seen.values()].filter((b) => b.t >= from && b.t + HOUR <= now).sort((a, b) => a.t - b.t);
}

/** Funding payments since `from`, oldest first: [{ t, rate }]. */
async function fundingHistory(symbol, from) {
  const out = [];
  let start = from;
  for (let page = 0; page < 10; page++) {
    const batch = await get('/fapi/v1/fundingRate', { symbol, startTime: start, limit: 1000 });
    if (!Array.isArray(batch) || !batch.length) break;
    for (const f of batch) out.push({ t: +f.fundingTime, rate: +f.fundingRate });
    if (batch.length < 1000) break;
    start = out.at(-1).t + 1;
  }
  return out;
}

function context(fund, btc) {
  const btcAt = new Map(btc.map((b, i) => [b.t + HOUR, i]));
  return {
    funding(t) {
      let lo = 0, hi = fund.length - 1, best = null;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (fund[mid].t <= t) { best = fund[mid].rate; lo = mid + 1; } else hi = mid - 1; }
      return best;
    },
    btcMove(t) {
      const i = btcAt.get(t);
      return i == null || i < 4 ? null : (btc[i].c / btc[i - 4].c - 1) * 100;
    },
    between: (t0, t1) => fund.reduce((s, f) => (f.t > t0 && f.t <= t1 ? s + f.rate : s), 0),
  };
}

/** The control: enter at the next open on every 4th candle while the regime (and the gates) allow, same stop size and exits. */
function anyHour(bars, cfg, ctx, stopAtrs) {
  const a1 = atr(bars, 14), bars4 = to4h(bars), reg = regime4h(bars4, cfg), map = last4hIndex(bars, bars4);
  const trades = [];
  for (let i = 60; i + 1 < bars.length; i += 4) {
    const g = map[i] >= 0 ? reg[map[i]] : null;
    if (!g || !g.side || a1[i] == null) continue;
    const f = ctx.funding(bars[i].t + HOUR), m = ctx.btcMove(bars[i].t + HOUR);
    if (f != null && (g.side > 0 ? f > cfg.fundingMax : f < -cfg.fundingMax)) continue;
    if (m != null && m * g.side < -cfg.btcMovePct) continue;
    const entry = bars[i + 1].o, r = stopAtrs * a1[i];
    const res = runTrade(bars, i + 1, { side: g.side, entry, stop: entry - g.side * r, r }, { ...cfg, marketEntry: true }, ctx.between);
    if (res.exit !== 'open') trades.push({ t: bars[i + 1].t, side: g.side, exit: res.exit, r: res.r, cost: res.cost, stopPct: (r / entry) * 100 });
  }
  return trades;
}

async function study(symbol, btc, now) {
  const bars = symbol === 'BTCUSDT' ? btc : await candles(symbol, DAYS, now);
  if (bars.length < 1000) throw new Error(`only ${bars.length} candles`);
  const ctx = context(await fundingHistory(symbol, bars[0].t), btc);
  const run = (cfg, funnel = null) => {
    const sigs = signals(bars, cfg, { ...ctx, funnel });
    return { ...simulate(bars, sigs, cfg, ctx.between), sigs, funnel };
  };
  const main = run(SR, {});
  const a1 = atr(bars, 14);
  const ratios = main.sigs.map((s) => s.r / a1[s.i]).sort((a, b) => a - b);
  const stopAtrs = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 2;
  return {
    symbol, bars, main,
    noZone: run({ ...SR, zone: false }),
    market: run({ ...SR, marketEntry: true }),
    control: anyHour(bars, SR, ctx, stopAtrs),
    stopAtrs,
  };
}

const pc = (v) => (v == null ? '  –' : `${Math.round(v * 100)}%`.padStart(4));
const fmtR = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
const months = (bars) => (bars.at(-1).t - bars[0].t) / (30.44 * DAY);
function line(label, trades, span) {
  const s = tradeSummary(trades, SR, 150);
  if (!s.n) return console.log(`${label.padEnd(36)}      0 trades`) ?? s;
  console.log(`${label.padEnd(36)} ${String(s.n).padStart(6)} ${span ? (s.n / span).toFixed(1).padStart(7) : '      –'}   ${pc(s.full)}     ${pc(s.partial)}     ${pc(s.stop)}    ${fmtR(s.expR)} ±${s.noise.toFixed(2)}  ${s.profitFactor == null ? '   –' : s.profitFactor.toFixed(2)}   ${`$${s.equity.toFixed(0)}`.padStart(6)}   ${String(s.losingStreak).padStart(3)}   ${pc(s.maxDrawdown)}`);
  return s;
}
const header = () => console.log(`${''.padEnd(36)} trades  /month  both targets  first only  stopped   net per trade    PF   $150 ->  streak  drawdown`);

// ---- run ----
const now = Math.floor(Date.now() / HOUR) * HOUR;
console.log(`Downloading ${DAYS} days of 1h candles and funding for BTCUSDT and ${SYMBOL}…`);
const btc = await candles('BTCUSDT', DAYS, now);
const one = await study(SYMBOL, btc, now);
const { bars } = one;
const span = months(bars);
const d = (t) => new Date(t).toISOString().slice(0, 10);
const jan1 = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
const startOfYear = bars.find((b) => b.t >= jan1);
console.log(`\n${SYMBOL}: ${bars.length} hourly candles, ${d(bars[0].t)} to ${d(bars.at(-1).t)} (${span.toFixed(1)} months).`);
if (startOfYear && startOfYear.t - jan1 < DAY) console.log(`Price: ${startOfYear.o} on 1 January, ${bars.at(-1).c} now (${((bars.at(-1).c / startOfYear.o - 1) * 100).toFixed(1)}% this year).`);
const fn = one.main.funnel;
console.log(`Hours checked ${bars.length} → 4h regime on ${fn.regime ?? 0} → wicked through a swing ${fn.swept ?? 0} → closed back inside ${fn.closedBack ?? 0} → beyond the 1h EMA 20 ${fn.ema ?? 0} → RSI turning ${fn.rsi ?? 0} → near the 4h EMA 20 ${fn.zone ?? 0} → after funding and BTC gates ${fn.signal ?? 0}.`);
console.log(`Signals ${one.main.signals} · limit orders never filled ${one.main.unfilled} · skipped while already in a trade ${one.main.skippedBusy} · typical stop ${one.stopAtrs.toFixed(1)} ATR.\n`);

header();
console.log(`${'The plan’s own table (claimed)'.padEnd(36)}    120    20.0    27%      22%      52%    +0.45R         1.78     $295     7    11%`);
console.log(`${'No edge at all (arithmetic)'.padEnd(36)}      –       –    17%      17%      67%    0R before costs`);
const all = line(`${SYMBOL}: rules as written`, one.main.trades, span);
const result = { t: now, symbol: SYMBOL, days: DAYS, from: bars[0].t, to: bars.at(-1).t, cfg: SR, funnel: fn, groups: { main: all } };
const thisYear = one.main.trades.filter((t) => t.t >= jan1);
result.groups.thisYear = line('  this year only', thisYear, (bars.at(-1).t - Math.max(jan1, bars[0].t)) / (30.44 * DAY));
const cut = bars[0].t + (bars.at(-1).t - bars[0].t) * 0.7;
const older = line('  older 70% of the period', one.main.trades.filter((t) => t.t < cut), span * 0.7);
const newer = line('  newest 30%', one.main.trades.filter((t) => t.t >= cut), span * 0.3);
result.groups.older = older; result.groups.newer = newer;
result.groups.longs = line('  longs', one.main.trades.filter((t) => t.side > 0));
result.groups.shorts = line('  shorts', one.main.trades.filter((t) => t.side < 0));
result.groups.noZone = line('Without the "near 4h EMA 20" rule', one.noZone.trades, span);
result.groups.market = line('Market entry at the next open', one.market.trades, span);
result.groups.control = line('Any hour in the regime (control)', one.control);

let pooled = null;
if (PAIRS > 0) {
  const top = (await get('/fapi/v1/ticker/24hr', {}))
    .filter((t) => /USDT$/.test(t.symbol) && t.symbol !== SYMBOL)
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, PAIRS)
    .map((t) => t.symbol);
  console.log(`\nThe same rules on the ${top.length} busiest other coins (a real edge should not exist on one coin only)…`);
  const main = [], control = [], noZone = [];
  let coinMonths = 0, done = 0;
  for (const symbol of top) {
    try {
      const s = await study(symbol, btc, now);
      main.push(...s.main.trades); noZone.push(...s.noZone.trades); control.push(...s.control);
      coinMonths += months(s.bars);
      done++;
    } catch (e) {
      console.log(`  ${symbol} skipped: ${e.message}`);
    }
  }
  // Pooled trades are shown in time order so the streak and drawdown columns mean something (one $150 account per coin, averaged).
  const byTime = (list) => list.sort((a, b) => a.t - b.t);
  header();
  pooled = line(`${done} other coins: rules as written`, byTime(main), coinMonths);
  result.groups.pooled = pooled;
  result.groups.pooledNoZone = line('  without the "near 4h EMA 20" rule', byTime(noZone), coinMonths);
  result.groups.pooledControl = line('  any hour in the regime (control)', byTime(control));
  console.log('  (/month is per coin. $150 ->, streak and drawdown here treat all coins as one account, so read the R columns.)');
}

// ---- verdict ----
const perMonth = all.n ? all.n / span : 0;
const parts = [];
if (!all.n) parts.push(`The rules as written produced no trades on ${SYMBOL} in ${span.toFixed(0)} months.`);
else {
  parts.push(`On real ${SYMBOL} candles the rules gave ${all.n} trades in ${span.toFixed(0)} months (${perMonth.toFixed(1)} a month; the plan claims 20 a month).`);
  if (all.n < 30) parts.push(`That is too few to judge ${SYMBOL} alone: ${fmtR(all.expR)} a trade, noise ±${all.noise.toFixed(2)}R.`);
  else if (all.expR > all.noise && older.n && newer.n && older.expR > 0 && newer.expR > 0) parts.push(`It made ${fmtR(all.expR)} a trade after costs, beyond noise and on both halves of the period.`);
  else if (all.expR + all.noise < 0) parts.push(`It lost ${fmtR(all.expR)} a trade after costs, beyond noise.`);
  else parts.push(`It made ${fmtR(all.expR)} a trade after costs, which is inside the noise (±${all.noise.toFixed(2)}R): no evidence of an edge.`);
  parts.push(`${Math.round(all.full * 100)}% of trades hit both targets (claimed 27%, no-edge 17%).`);
}
if (pooled?.n) {
  const c = result.groups.pooledControl;
  parts.push(pooled.expR > pooled.noise
    ? `Across the other coins it made ${fmtR(pooled.expR)} a trade over ${pooled.n} trades, beyond noise${c?.n ? ` (entering at any hour in the same regime: ${fmtR(c.expR)})` : ''}.`
    : `Across the other coins: ${fmtR(pooled.expR)} a trade over ${pooled.n} trades (noise ±${pooled.noise.toFixed(2)}R)${c?.n ? `, against ${fmtR(c.expR)} for entering at any hour in the same regime` : ''}: ${pooled.expR + pooled.noise < 0 ? 'a loss' : 'no edge shown'}.`);
}
result.verdict = parts.join(' ');
console.log(`\nVerdict: ${result.verdict}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(`Saved to ${OUT}.`);
