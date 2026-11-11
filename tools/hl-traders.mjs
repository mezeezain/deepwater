#!/usr/bin/env node
// Who is making money on Hyperliquid, and how? Everything on Hyperliquid is public: the leaderboard, and every
// fill of every account. Run where Hyperliquid is reachable (your VPS). Node 22+, no dependencies, no API key.
//
//   node tools/hl-traders.mjs                 # 30 proven hand-sized traders, their last 60 days (about 8 minutes)
//   node tools/hl-traders.mjs --top 50 --days 30
//   node tools/hl-traders.mjs --sort roi      # rank candidates by this month's % return (default: all-time profit)
//   node tools/hl-traders.mjs --max-equity 500000 --min-alltime 50000   # smaller accounts
//   node tools/hl-traders.mjs --whales        # the biggest winners of the month instead (funds, market makers)
//   node tools/hl-traders.mjs --check         # weeks later: did the traders picked last time keep winning?
//
// Step 1 picks candidates (js/hl.js): account between $20k and $2M, over $200k all-time profit of which at least
// $100k was made before this month, and in profit this month and this week. The first run of this tool ranked by
// this month's dollars and found only $5M–$170M accounts and market makers, a third of them in the red until this
// month: nothing a person could copy. Hence the size cap and the "already a winner" rule.
// Step 2 screens out bots: an account whose last 2,000 fills took fewer than 10 days is not trading by hand.
// Step 3 downloads each remaining trader's fills and works out how they trade: how often, how long they hold, how
// often they win and how big wins are against losses, whether they rest orders or hit the market, whether they
// add to winners or to losers, last week's funding against last week's profit, and how much rides on a few trades.
// Step 4 labels the style and says which ones a retail trader could test.
//
// The catch is survivorship: a leaderboard is the list of people it went well for, skilled or lucky. So the run
// also saves a random sample of ordinary accounts of the same size. `--check` later compares the two groups from
// the day they were picked: if the picks do no better than the random sample, their past profit was not a signal.
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HL, pickTraders, pickControl, parseRow, tooActive, traderStats, curveStats } from '../js/hl.js';

process.on('uncaughtException', (e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const WHALES = flag('whales');
const TOP = +arg('top', HL.top);
const SCAN = +arg('scan', HL.scan);
const DAYS = +arg('days', HL.days);
const SORT = arg('sort', WHALES ? 'pnl' : 'alltime');
const MAX_FILLS = +arg('max-fills', WHALES ? Infinity : HL.maxFillsPerDay);
const CFG = WHALES
  ? { minEquity: 100_000, maxEquity: Infinity, minAllTime: 500_000, minPrior: -Infinity, sort: SORT }
  : { minEquity: +arg('min-equity', HL.minEquity), maxEquity: +arg('max-equity', HL.maxEquity), minAllTime: +arg('min-alltime', HL.minAllTime), minPrior: +arg('min-prior', HL.minPrior), sort: SORT };
const API = process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const BOARD = process.env.HL_LEADERBOARD || 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const DATA = fileURLToPath(new URL('../worker/data/', import.meta.url));
const PAGE = 2000, MAX_PAGES = 6; // the API serves at most 2,000 fills a call and the latest 10,000 per account
const GAP = +(process.env.HL_GAP_MS ?? 1300); // ms between calls: well inside the public rate limit
const DAY = 86_400_000;

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

/** Funding payments since `since`. Returns the rows and whether the whole period was read. */
async function funding(user, since) {
  const out = [];
  let start = since, complete = false;
  for (let page = 0; page < 10; page++) {
    const batch = await info({ type: 'userFunding', user, startTime: start });
    if (!Array.isArray(batch) || !batch.length) { complete = true; break; }
    out.push(...batch);
    const last = Math.max(...batch.map((x) => x.time));
    if (batch.length < 500 || last < start) { complete = true; break; }
    start = last + 1;
  }
  return { rows: out, complete };
}

const usd = (v) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}k` : `${s}$${a.toFixed(0)}`;
};
const signed = (v) => (v >= 0 ? `+${usd(v)}` : usd(v));
const pct = (v, d = 0) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
const ret = (v) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`);
const hold = (ms) => (ms == null ? '–' : ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < DAY ? `${(ms / 3_600_000).toFixed(1)} h` : `${(ms / DAY).toFixed(1)} days`);
const med = (list) => {
  const a = list.filter((v) => v != null).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
};

function savedFile(oldest = false) {
  let names = [];
  try {
    names = readdirSync(DATA).filter((n) => /^hl-traders-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  } catch { /* no data folder yet */ }
  return names.length ? DATA + (oldest ? names[0] : names.at(-1)) : null;
}

// ---- --check: did the picks keep winning after they were picked? ----
if (flag('check')) {
  const file = arg('check', savedFile(true));
  if (!file) throw new Error('Nothing to check yet. Run node tools/hl-traders.mjs first, then --check a few weeks later.');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const days = (Date.now() - saved.t) / DAY;
  console.log(`Checking ${file}\nPicked ${days.toFixed(1)} days ago. Downloading today's leaderboard…`);
  const now = new Map((await leaderboard()).map((r) => { const p = parseRow(r); return [p.address, p]; }));
  const since = (list) => list.map((x) => ({ ...x, change: now.has(x.address) ? now.get(x.address).allTime.pnl - x.allTime : null }));
  const report = (label, list) => {
    const got = since(list).filter((x) => x.change != null);
    const up = got.filter((x) => x.change > 0).length;
    const medChange = med(got.map((x) => x.change)) ?? 0;
    const medRet = med(got.map((x) => (x.equity > 0 ? x.change / x.equity : 0))) ?? 0;
    console.log(`${label.padEnd(26)} ${String(got.length).padStart(4)} still listed · ${pct(got.length ? up / got.length : null).padStart(4)} made money since · median ${signed(medChange)} (${(medRet * 100).toFixed(1)}% of account) · ${list.length - got.length} gone from the board`);
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

// ---- pick, screen and analyse ----
console.log('Downloading the Hyperliquid leaderboard (large file, give it a minute)…');
const rows = await leaderboard();
const candidates = pickTraders(rows, { ...CFG, top: SCAN });
if (!candidates.length) throw new Error('No trader passed the filter. Try lower --min-equity / --min-alltime, or a higher --max-equity.');
console.log(`${rows.length} accounts on the board. ${candidates.length} candidates: ${WHALES
  ? `account over ${usd(CFG.minEquity)}, all-time profit over ${usd(CFG.minAllTime)}`
  : `account ${usd(CFG.minEquity)}–${usd(CFG.maxEquity)}, all-time profit over ${usd(CFG.minAllTime)} with at least ${usd(CFG.minPrior)} of it made before this month`}, in profit this month and this week.`);
console.log(`Looking for ${TOP} that trade by hand${Number.isFinite(MAX_FILLS) ? ` (under ${MAX_FILLS} fills a day)` : ''} and reading their last ${DAYS} days. About ${Math.ceil(((Math.min(SCAN, candidates.length) + TOP * 5) * GAP) / 60_000)} minutes…\n`);

const now = Date.now();
const since = now - DAYS * DAY;
const traders = [];
const skipped = { bots: 0, idle: 0, failed: 0 };
let looked = 0;
for (const p of candidates) {
  if (traders.length >= TOP) break;
  looked++;
  let stats = null, curve = null, fundingComplete = true;
  try {
    const recent = await info({ type: 'userFills', user: p.address, aggregateByTime: true });
    const list = Array.isArray(recent) ? recent : [];
    if (!list.some((f) => f.time >= since)) { skipped.idle++; continue; }
    if (tooActive(list, MAX_FILLS, PAGE)) { skipped.bots++; continue; }
    const oldest = Math.min(...list.map((f) => f.time));
    // One page reaching back past the window is the whole window; otherwise page through it.
    const f = list.length < PAGE || oldest <= since
      ? { list: list.filter((x) => x.time >= since).sort((a, b) => a.time - b.time), capped: false }
      : await fills(p.address, since);
    const fund = await funding(p.address, now - HL.fundingDays * DAY);
    fundingComplete = fund.complete;
    const state = await info({ type: 'clearinghouseState', user: p.address });
    const portfolio = await info({ type: 'portfolio', user: p.address });
    stats = traderStats({ fills: f.list, funding: fund.rows, weekPnl: p.week.pnl, state, capped: f.capped });
    const windows = Array.isArray(portfolio) ? portfolio : [];
    curve = curveStats((windows.find(([k]) => k === 'perpMonth') ?? windows.find(([k]) => k === 'month'))?.[1]?.pnlHistory);
  } catch (e) {
    skipped.failed++;
    console.log(`   (skipped ${p.address}: ${e.message})`);
    continue;
  }
  traders.push({ ...p, stats, curve });
  const s = stats;
  console.log(`#${traders.length} ${p.address}${p.name ? ` (${p.name})` : ''}`);
  console.log(`   Account ${usd(p.equity)} · all-time ${signed(p.allTime.pnl)} (${signed(p.allTime.pnl - p.month.pnl)} before this month) · this month ${signed(p.month.pnl)} · this week ${signed(p.week.pnl)}`);
  console.log(`   Style: ${s.style}${s.testable ? '  [can be tested]' : ''} — ${s.why}`);
  console.log(`   ${s.fills} fills over ${s.spanDays.toFixed(0)} days${s.capped ? ' (history limit reached)' : ''} · ${s.trips} completed trade${s.trips === 1 ? '' : 's'} (${s.tripsPerDay.toFixed(1)}/day) · ${s.coins} coin${s.coins === 1 ? '' : 's'}${s.topCoin ? `, ${pct(s.topCoin.share)} in ${s.topCoin.coin}` : ''} · ${pct(s.makerShare)} resting orders`);
  if (s.trips) {
    console.log(`   Wins ${pct(s.winRate)} · average win ${ret(s.avgWinPct)} / loss ${ret(s.avgLossPct)} · win size ÷ loss size ${s.payoff == null ? '–' : s.payoff.toFixed(2)} · typical hold ${hold(s.medianHoldMs)} · long ${pct(s.longShare)}`);
    console.log(`   Adds per trade ${s.addsPerTrip.toFixed(1)}${s.addAgainstShare == null ? '' : ` (${pct(s.addAgainstShare)} into losing positions)`} · biggest loss ${s.worstVsAvgWin == null ? '–' : `${s.worstVsAvgWin.toFixed(1)}× an average win`} · top 3 trades = ${pct(s.top3Share)} of winnings`);
  }
  console.log(`   Closed trades ${signed(s.realized)} after ${usd(s.fees)} fees · funding last ${HL.fundingDays} days ${signed(s.funding)}${fundingComplete ? '' : ' (partial)'}${s.fundingShare == null ? '' : ` = ${pct(s.fundingShare)} of the week's profit`}`);
  console.log(`   Now: leverage ${s.leverage == null ? '–' : `${s.leverage.toFixed(1)}×`}, ${s.openPositions} open${s.openLongShare == null ? '' : ` (${pct(s.openLongShare)} long)`}${curve ? ` · this month ${pct(curve.upShare)} of steps up, worst drop ${usd(curve.drawdown)}` : ''}\n`);
}

// ---- summary ----
console.log(`Looked at ${looked} of ${candidates.length} candidates: ${traders.length} analysed, ${skipped.bots} skipped as bots, ${skipped.idle} had no trades in ${DAYS} days${skipped.failed ? `, ${skipped.failed} could not be read` : ''}.`);
if (!traders.length) throw new Error('Nobody left to analyse. Try --scan 400, or --max-fills 1000 to allow busier accounts.');
const styles = new Map();
for (const t of traders) {
  const g = styles.get(t.stats.style) ?? { n: 0, month: 0 };
  g.n++; g.month += t.month.pnl;
  styles.set(t.stats.style, g);
}
console.log('\nHow they make money:');
for (const [style, g] of [...styles.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${style.padEnd(26)} ${String(g.n).padStart(3)} trader${g.n === 1 ? ' ' : 's'} · ${signed(g.month).padStart(9)} this month combined`);
}
const line = (list) => `win rate ${pct(med(list.map((t) => t.stats.winRate)))} · win size ÷ loss size ${med(list.map((t) => t.stats.payoff))?.toFixed(2) ?? '–'} · typical hold ${hold(med(list.map((t) => t.stats.medianHoldMs)))} · trades/day ${med(list.map((t) => t.stats.tripsPerDay))?.toFixed(1) ?? '–'} · adds into losers ${pct(med(list.map((t) => t.stats.addAgainstShare)))} · leverage ${med(list.map((t) => t.stats.leverage))?.toFixed(1) ?? '–'}×`;
const traded = traders.filter((t) => t.stats.trips >= 10);
if (traded.length) console.log(`\nThe middle trader of the ${traded.length} with 10+ completed trades:\n  ${line(traded)}`);
const testable = traders.filter((t) => t.stats.testable);
if (testable.length) {
  console.log(`\nThe ${testable.length} whose way of trading could be tested by hand:`);
  for (const t of testable) console.log(`  ${t.address}  ${t.stats.style}`);
} else {
  console.log('\nNone of them trades in a way that can be tested by hand (too fast, too few trades, or hedged).');
}
console.log('\nRead this as a description, not a recipe: a leaderboard lists the people it went well for. Run this again');
console.log('with --check in a month to see whether these traders kept winning against a random sample of accounts.');

const control = pickControl(rows, traders.map((t) => t.address), 200, CFG).map((p) => ({ address: p.address, equity: p.equity, allTime: p.allTime.pnl }));
mkdirSync(DATA, { recursive: true });
const out = arg('out', `${DATA}hl-traders-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(out, JSON.stringify({ t: now, days: DAYS, cfg: CFG, boardSize: rows.length, looked, skipped, traders, control }, null, 1));
console.log(`\nSaved to ${out}. To see an account's trades, paste its address into the Hyperliquid explorer.`);
