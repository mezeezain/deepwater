#!/usr/bin/env node
// Who is making money on Hyperliquid, and how? Everything on Hyperliquid is public: the leaderboard, and every
// fill of every account. Run where Hyperliquid is reachable (your VPS). Node 22+, no dependencies, no API key.
//
//   node tools/hl-traders.mjs                 # 30 proven traders, their last 30 days
//   node tools/hl-traders.mjs --top 50 --days 14
//   node tools/hl-traders.mjs --sort roi      # rank by this month's % return instead of dollars
//   node tools/hl-traders.mjs --min-equity 20000 --min-alltime 100000   # smaller accounts
//   node tools/hl-traders.mjs --check         # weeks later: did the traders picked last time keep winning?
//
// Step 1 picks traders (js/hl.js): account over $100k, over $500k all-time profit, and in profit this month and
// this week. Step 2 downloads each one's fills and works out how they trade: how often, how long they hold, how
// often they win and how big wins are against losses, whether they rest orders (maker) or hit the market (taker),
// whether they add to winners or to losers, how much comes from funding, and how much rides on a few trades.
// Step 3 labels the style and says which ones a retail trader could test.
//
// The catch is survivorship: a leaderboard is the list of people it went well for, skilled or lucky. So the run
// also saves a random sample of ordinary accounts of the same size. `--check` later compares the two groups from
// the day they were picked: if the picks do no better than the random sample, their past profit was not a signal.
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HL, pickTraders, pickControl, parseRow, traderStats, curveStats } from '../js/hl.js';

process.on('uncaughtException', (e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const TOP = +arg('top', HL.top);
const DAYS = +arg('days', HL.days);
const SORT = arg('sort', 'pnl');
const CFG = { minEquity: +arg('min-equity', HL.minEquity), minAllTime: +arg('min-alltime', HL.minAllTime), top: TOP, sort: SORT };
const API = process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const BOARD = process.env.HL_LEADERBOARD || 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const DATA = fileURLToPath(new URL('../worker/data/', import.meta.url));
const PAGE = 2000, MAX_PAGES = 6; // the API serves at most 2,000 fills a call and the latest 10,000 per account
const GAP = +(process.env.HL_GAP_MS ?? 1300); // ms between calls: well inside the public rate limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function info(body) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 429 && attempt < 5) {
      await sleep(+(process.env.HL_BACKOFF_MS ?? 15_000) * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${body.type}`);
    return res.json();
  }
}

async function leaderboard() {
  const res = await fetch(BOARD);
  if (!res.ok) throw new Error(`HTTP ${res.status} for the leaderboard`);
  const rows = (await res.json())?.leaderboardRows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('The leaderboard came back empty or in a new shape.');
  return rows;
}

/** Fills since `since`, oldest first, following the API's paging rule (next page starts at the last fill's time). */
async function fills(user, since) {
  const seen = new Map();
  let start = since, capped = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await info({ type: 'userFillsByTime', user, startTime: start, aggregateByTime: true });
    if (!Array.isArray(batch) || !batch.length) break;
    const before = seen.size;
    for (const f of batch) seen.set(`${f.tid}:${f.oid}:${f.time}`, f);
    const last = Math.max(...batch.map((f) => f.time));
    if (batch.length < PAGE || seen.size === before) break;
    if (page === MAX_PAGES - 1) capped = true;
    start = last;
  }
  return { list: [...seen.values()].sort((a, b) => a.time - b.time), capped: capped || seen.size >= 10_000 };
}

async function funding(user, since) {
  const out = [];
  let start = since;
  for (let page = 0; page < 4; page++) {
    const batch = await info({ type: 'userFunding', user, startTime: start });
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 500) break;
    start = Math.max(...batch.map((x) => x.time)) + 1;
  }
  return out;
}

const usd = (v) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}k` : `${s}$${a.toFixed(0)}`;
};
const signed = (v) => (v >= 0 ? `+${usd(v)}` : usd(v));
const pct = (v, d = 0) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
const hold = (ms) => (ms == null ? '–' : ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 86_400_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${(ms / 86_400_000).toFixed(1)} days`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function latestFile(oldest = false) {
  let names = [];
  try {
    names = readdirSync(DATA).filter((n) => /^hl-traders-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  } catch { /* no data folder yet */ }
  return names.length ? DATA + (oldest ? names[0] : names.at(-1)) : null;
}

// ---- --check: did the picks keep winning after they were picked? ----
if (flag('check')) {
  const file = arg('check', latestFile(true));
  if (!file) throw new Error('Nothing to check yet. Run node tools/hl-traders.mjs first, then --check a few weeks later.');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const days = (Date.now() - saved.t) / 86_400_000;
  console.log(`Checking ${file}\nPicked ${days.toFixed(1)} days ago. Downloading today's leaderboard…`);
  const now = new Map((await leaderboard()).map((r) => { const p = parseRow(r); return [p.address, p]; }));
  const since = (list) => list.map((x) => ({ ...x, change: now.has(x.address) ? now.get(x.address).allTime.pnl - x.allTime : null }));
  const report = (label, list) => {
    const got = since(list).filter((x) => x.change != null);
    const up = got.filter((x) => x.change > 0).length;
    const med = got.map((x) => x.change).sort((a, b) => a - b)[Math.floor(got.length / 2)] ?? 0;
    const medRet = got.map((x) => (x.equity > 0 ? x.change / x.equity : 0)).sort((a, b) => a - b)[Math.floor(got.length / 2)] ?? 0;
    console.log(`${label.padEnd(26)} ${String(got.length).padStart(4)} still listed · ${pct(got.length ? up / got.length : null).padStart(4)} made money since · median ${signed(med)} (${(medRet * 100).toFixed(1)}% of account) · ${list.length - got.length} gone from the board`);
    return { n: got.length, upShare: got.length ? up / got.length : null, medRet };
  };
  console.log('');
  const a = report('Picked traders', saved.traders.map((x) => ({ address: x.address, allTime: x.allTime.pnl, equity: x.equity })));
  const b = report('Random accounts (control)', saved.control);
  console.log('\nEach picked trader since then:');
  for (const x of since(saved.traders.map((t) => ({ address: t.address, allTime: t.allTime.pnl, style: t.stats?.style ?? '?' })))) {
    console.log(`  ${x.address}  ${String(x.style).padEnd(24)} ${x.change == null ? 'gone from the board' : signed(x.change)}`);
  }
  const verdict = days < 14 ? `Only ${days.toFixed(0)} days have passed: too soon to judge. Check again after a month.`
    : a.n < 10 || b.n < 50 ? 'Too few accounts left to compare.'
      : a.upShare > b.upShare + 0.15 && a.medRet > b.medRet ? 'The picks kept doing better than ordinary accounts: their record carried forward this time.'
        : 'The picks did not clearly beat ordinary accounts after being picked: their past profit was not a reliable signal.';
  console.log(`\nVerdict: ${verdict}`);
  process.exit(0);
}

// ---- pick and analyse ----
console.log('Downloading the Hyperliquid leaderboard (large file, give it a minute)…');
const rows = await leaderboard();
const picks = pickTraders(rows, CFG);
if (!picks.length) throw new Error('No trader passed the filter. Try lower --min-equity / --min-alltime.');
const control = pickControl(rows, picks.map((p) => p.address), 200, CFG).map((p) => ({ address: p.address, equity: p.equity, allTime: p.allTime.pnl }));
console.log(`${rows.length} accounts on the board. ${picks.length} picked: account over ${usd(CFG.minEquity)}, all-time profit over ${usd(CFG.minAllTime)}, in profit this month and this week, ranked by this month's ${SORT === 'roi' ? '% return' : 'profit'}.`);
console.log(`Reading each one's last ${DAYS} days of trades (about ${Math.ceil((picks.length * 6 * GAP) / 60_000)} minutes)…\n`);

const since = Date.now() - DAYS * 86_400_000;
const traders = [];
for (const [i, p] of picks.entries()) {
  let stats = null, curve = null, error = null;
  try {
    const f = await fills(p.address, since);
    const fund = await funding(p.address, since);
    const state = await info({ type: 'clearinghouseState', user: p.address });
    const portfolio = await info({ type: 'portfolio', user: p.address });
    stats = traderStats({ fills: f.list, funding: fund, state, capped: f.capped });
    const monthCurve = (Array.isArray(portfolio) ? portfolio : []).find(([k]) => k === 'perpMonth') ?? (Array.isArray(portfolio) ? portfolio : []).find(([k]) => k === 'month');
    curve = curveStats(monthCurve?.[1]?.pnlHistory);
  } catch (e) {
    error = e.message;
  }
  traders.push({ ...p, stats, curve, error });
  const head = `#${i + 1} ${p.address}${p.name ? ` (${p.name})` : ''}`;
  console.log(`${head}\n   Account ${usd(p.equity)} · this month ${signed(p.month.pnl)} (${pct(p.month.roi, 1)}) · all-time ${signed(p.allTime.pnl)}`);
  if (error || !stats) {
    console.log(`   Could not read trades: ${error}\n`);
    continue;
  }
  const s = stats;
  console.log(`   Style: ${s.style}${s.testable ? '  [can be tested]' : ''} — ${s.why}`);
  console.log(`   ${s.fills} fills over ${s.spanDays.toFixed(0)} days${s.capped ? ' (history limit reached: very active)' : ''} · ${s.trips} completed trade${s.trips === 1 ? '' : 's'} (${s.tripsPerDay.toFixed(1)}/day) · ${s.coins} coin${s.coins === 1 ? '' : 's'}${s.topCoin ? `, ${pct(s.topCoin.share)} in ${s.topCoin.coin}` : ''} · ${pct(s.makerShare)} resting orders`);
  if (s.trips) {
    console.log(`   Wins ${pct(s.winRate)} · average win ${s.avgWinPct == null ? '–' : `+${s.avgWinPct.toFixed(2)}%`} / loss ${s.avgLossPct == null ? '–' : `${s.avgLossPct.toFixed(2)}%`} · win size ÷ loss size ${s.payoff == null ? '–' : s.payoff.toFixed(2)} · typical hold ${hold(s.medianHoldMs)} · long ${pct(s.longShare)}`);
    console.log(`   Adds per trade ${s.addsPerTrip.toFixed(1)}${s.addAgainstShare == null ? '' : ` (${pct(s.addAgainstShare)} into losing positions)`} · biggest loss ${s.worstVsAvgWin == null ? '–' : `${s.worstVsAvgWin.toFixed(1)}× an average win`} · top 3 trades = ${pct(s.top3Share)} of winnings`);
  }
  console.log(`   Closed trades ${signed(s.realized)} after ${usd(s.fees)} fees · funding ${signed(s.funding)} · leverage now ${s.leverage == null ? '–' : `${s.leverage.toFixed(1)}×`} (${s.openPositions} open)${curve ? ` · ${pct(curve.upShare)} of steps up this month, worst drop ${usd(curve.drawdown)}` : ''}\n`);
}

// ---- summary ----
const ok = traders.filter((t) => t.stats);
const styles = new Map();
for (const t of ok) {
  const g = styles.get(t.stats.style) ?? { n: 0, month: 0, testable: 0 };
  g.n++; g.month += t.month.pnl; g.testable += t.stats.testable ? 1 : 0;
  styles.set(t.stats.style, g);
}
console.log('How the picked traders make money:');
for (const [style, g] of [...styles.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${style.padEnd(26)} ${String(g.n).padStart(3)} trader${g.n === 1 ? ' ' : 's'} · ${signed(g.month).padStart(9)} this month combined`);
}
const testable = ok.filter((t) => t.stats.testable);
const med = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : null);
if (testable.length) {
  console.log(`\nThe ${testable.length} whose way of trading could be tested by hand (typical trade lasts an hour or more, 20+ trades):`);
  console.log(`  typical win rate ${pct(med(testable.map((t) => t.stats.winRate)))} · win size ÷ loss size ${med(testable.map((t) => t.stats.payoff ?? 0))?.toFixed(2)} · typical hold ${hold(med(testable.map((t) => t.stats.medianHoldMs)))} · leverage ${med(testable.map((t) => t.stats.leverage ?? 0))?.toFixed(1)}×`);
  for (const t of testable) console.log(`  ${t.address}  ${t.stats.style}`);
} else {
  console.log('\nNone of the picked traders trades in a way that can be tested by hand (too fast, too few trades, or hedged).');
}
console.log('\nRead this as a description, not a recipe: a leaderboard lists the people it went well for. Run this again');
console.log('with --check in a month to see whether these traders kept winning against a random sample of accounts.');

mkdirSync(DATA, { recursive: true });
const out = arg('out', `${DATA}hl-traders-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(out, JSON.stringify({ t: Date.now(), days: DAYS, cfg: CFG, boardSize: rows.length, traders, control }, null, 1));
console.log(`\nSaved to ${out}. To see an account's trades, paste its address into the Hyperliquid explorer.`);
