// Hyperliquid trader analysis: who to look at on the public leaderboard, and how each one trades,
// worked out from their public fills. Pure functions (no network) so they can be tested; tools/hl-traders.mjs
// does the fetching.

export const HL = {
  minEquity: 20_000, // account value, USD
  maxEquity: 2_000_000, // above this it is funds and firms, not people trading by hand
  minAllTime: 200_000, // all-time profit, USD
  minPrior: 100_000, // profit already banked before this month: one good month is not a record
  top: 30, // traders to analyse
  scan: 150, // candidates to look through to find them
  days: 60, // how far back to read trades
  maxFillsPerDay: 200, // busier than this is a bot
  fundingDays: 7, // funding is read for the last week and set against the week's profit
};

const num = (v) => (Number.isFinite(+v) ? +v : 0);
const sum = (list, f = (x) => x) => list.reduce((s, x) => s + f(x), 0);
const median = (list) => {
  if (!list.length) return null;
  const a = [...list].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};

/** A leaderboard row as plain numbers: { address, name, equity, day, week, month, allTime: { pnl, roi, vlm } }. */
export function parseRow(row) {
  const out = { address: String(row?.ethAddress ?? '').toLowerCase(), name: row?.displayName || null, equity: num(row?.accountValue) };
  for (const [window, p] of row?.windowPerformances ?? []) out[window] = { pnl: num(p?.pnl), roi: num(p?.roi), vlm: num(p?.vlm) };
  for (const w of ['day', 'week', 'month', 'allTime']) out[w] ??= { pnl: 0, roi: 0, vlm: 0 };
  return out;
}

const validAddress = (a) => /^0x[0-9a-f]{40}$/.test(a);

/**
 * Traders worth studying: a hand-sized account, already well in profit before this month, and still winning this
 * month and this week. Sorted by all-time profit (sort: 'pnl' for this month's profit, 'roi' for this month's %).
 */
export function pickTraders(rows, cfg = HL) {
  const { minEquity, maxEquity, minAllTime, minPrior, top, sort = 'alltime' } = { ...HL, ...cfg };
  const key = sort === 'roi' ? (r) => r.month.roi : sort === 'pnl' ? (r) => r.month.pnl : (r) => r.allTime.pnl;
  return rows
    .map(parseRow)
    .filter((r) => validAddress(r.address) && r.equity >= minEquity && r.equity <= maxEquity && r.allTime.pnl >= minAllTime &&
      r.allTime.pnl - r.month.pnl >= minPrior && r.month.pnl > 0 && r.week.pnl > 0 && r.month.vlm > 0)
    .sort((a, b) => key(b) - key(a))
    .slice(0, top);
}

/**
 * Is this account too busy to be a person? Judged from one page of its most recent fills: a full page
 * (pageSize fills) that spans fewer days than a person could fill it in.
 */
export function tooActive(fills, maxPerDay = HL.maxFillsPerDay, pageSize = 2000) {
  if (fills.length < pageSize) return false;
  const times = fills.map((f) => f.time);
  const days = (Math.max(...times) - Math.min(...times)) / 86_400_000;
  return fills.length / Math.max(days, 1e-6) > maxPerDay;
}

/** A random sample of ordinary accounts of the same size, to compare the picks with later. `rand` is injectable for tests. */
export function pickControl(rows, exclude, n = 200, cfg = HL, rand = Math.random) {
  const { minEquity, maxEquity } = { ...HL, ...cfg };
  const skip = new Set(exclude);
  const pool = rows.map(parseRow).filter((r) => validAddress(r.address) && r.equity >= minEquity && r.equity <= maxEquity && !skip.has(r.address));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

const isPerp = (coin) => typeof coin === 'string' && !coin.startsWith('@') && !coin.includes('/');

/**
 * Round trips from a trader's perp fills: from flat, through any adds and partial exits, back to flat (or a flip).
 * Each: { coin, side: 1|-1, t0, t1, holdMs, pnl (after fees), entryNotional, retPct, adds, addWith, addAgainst }.
 * Positions that were already open when the fills begin are skipped: their entry was not seen.
 */
export function roundTrips(fills) {
  const open = new Map();
  const trips = [];
  const sorted = fills.filter((f) => isPerp(f.coin)).sort((a, b) => a.time - b.time);
  for (const f of sorted) {
    const px = num(f.px), sz = num(f.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    const signed = f.side === 'B' ? sz : -sz;
    const start = num(f.startPosition);
    const end = start + signed;
    const eps = 1e-9 * Math.max(Math.abs(start), sz) + 1e-12;
    const flatBefore = Math.abs(start) < eps, flatAfter = Math.abs(end) < eps;
    const net = num(f.closedPnl) - num(f.fee);
    let trip = open.get(f.coin);
    if (!trip) {
      // Either a fresh entry, or the tail of a position opened before our window (unknown entry: tracked but not reported).
      trip = newTrip(f.coin, flatBefore ? Math.sign(signed) : Math.sign(start), f.time, !flatBefore);
      open.set(f.coin, trip);
    }
    trip.pnl += net;
    const opening = Math.sign(signed) === trip.side;
    if (opening) addEntry(trip, px, sz);
    const flipped = !flatBefore && !flatAfter && Math.sign(end) !== Math.sign(start);
    if (flatAfter || flipped) {
      trip.t1 = f.time;
      if (!trip.partial) trips.push(finish(trip));
      open.delete(f.coin);
      if (flipped) {
        const next = newTrip(f.coin, Math.sign(end), f.time, false);
        addEntry(next, px, Math.abs(end));
        open.set(f.coin, next);
      }
    }
  }
  return trips;
}

function newTrip(coin, side, t0, partial) {
  return { coin, side, t0, t1: null, pnl: 0, entryNotional: 0, entrySize: 0, adds: 0, addWith: 0, addAgainst: 0, partial };
}

function addEntry(trip, px, sz) {
  if (trip.entrySize > 0) {
    const avg = trip.entryNotional / trip.entrySize;
    trip.adds++;
    // Long: buying more below the average entry is adding to a loser; above it, adding to a winner. Mirror for shorts.
    if ((px - avg) * trip.side < 0) trip.addAgainst++;
    else if ((px - avg) * trip.side > 0) trip.addWith++;
  }
  trip.entryNotional += px * sz;
  trip.entrySize += sz;
}

function finish(t) {
  return {
    coin: t.coin, side: t.side, t0: t.t0, t1: t.t1, holdMs: t.t1 - t.t0, pnl: t.pnl,
    entryNotional: t.entryNotional, retPct: t.entryNotional > 0 ? (t.pnl / t.entryNotional) * 100 : 0,
    adds: t.adds, addWith: t.addWith, addAgainst: t.addAgainst,
  };
}

/** Shape of the profit curve from [[t, pnl], ...]: share of steps that rose, and the worst drop as a share of the peak. */
export function curveStats(history) {
  const pts = (history ?? []).map(([t, v]) => [t, num(v)]).filter(([t]) => Number.isFinite(t));
  if (pts.length < 3) return null;
  let up = 0, moves = 0, peak = pts[0][1], worst = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i][1] - pts[i - 1][1];
    if (d !== 0) { moves++; if (d > 0) up++; }
    peak = Math.max(peak, pts[i][1]);
    worst = Math.max(worst, peak - pts[i][1]);
  }
  return { points: pts.length, upShare: moves ? up / moves : null, drawdown: worst, drawdownShare: peak > 0 ? worst / peak : null };
}

/**
 * Everything measurable about how one trader trades.
 * fills: Hyperliquid fill objects. funding: userFunding rows for the last week, weekPnl: the leaderboard's profit
 * for the same week (so funding is compared with profit over the same days). state: clearinghouseState.
 * capped: the fill history hit the API's limit, so the window is shorter than asked.
 */
export function traderStats({ fills = [], funding = [], weekPnl = null, state = null, capped = false }) {
  const all = fills.filter((f) => num(f.px) > 0 && num(f.sz) > 0);
  const perps = all.filter((f) => isPerp(f.coin));
  const ntl = (f) => num(f.px) * num(f.sz);
  const volume = sum(all, ntl), perpVolume = sum(perps, ntl);
  const times = all.map((f) => f.time);
  const spanDays = times.length ? Math.max(1, (Math.max(...times) - Math.min(...times)) / 86_400_000) : 0;
  const trips = roundTrips(perps);
  const wins = trips.filter((t) => t.pnl > 0), losses = trips.filter((t) => t.pnl <= 0);
  const grossWin = sum(wins, (t) => t.pnl), grossLoss = -sum(losses, (t) => t.pnl);
  const avgWinPct = wins.length ? sum(wins, (t) => t.retPct) / wins.length : null;
  const avgLossPct = losses.length ? sum(losses, (t) => t.retPct) / losses.length : null;
  const avgWin = wins.length ? grossWin / wins.length : null, avgLoss = losses.length ? grossLoss / losses.length : null;
  const adds = sum(trips, (t) => t.addWith + t.addAgainst);
  const byCoin = new Map();
  for (const f of perps) byCoin.set(f.coin, (byCoin.get(f.coin) ?? 0) + ntl(f));
  const topCoin = [...byCoin.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const fees = sum(perps, (f) => num(f.fee));
  const realized = sum(perps, (f) => num(f.closedPnl)) - fees;
  const fundingNet = sum(funding, (x) => num(x?.delta?.usdc));
  const equity = num(state?.marginSummary?.accountValue);
  const positions = (state?.assetPositions ?? []).filter((p) => num(p?.position?.szi) !== 0);
  const exposure = sum(positions, (p) => Math.abs(num(p.position.positionValue)));
  const longExposure = sum(positions.filter((p) => num(p.position.szi) > 0), (p) => Math.abs(num(p.position.positionValue)));
  const top3 = sum([...wins].sort((a, b) => b.pnl - a.pnl).slice(0, 3), (t) => t.pnl);
  const s = {
    fills: all.length, capped, spanDays, volume,
    spotShare: volume > 0 ? (volume - perpVolume) / volume : 0,
    makerShare: perpVolume > 0 ? sum(perps.filter((f) => f.crossed === false), ntl) / perpVolume : null,
    fillsPerDay: spanDays ? all.length / spanDays : 0,
    trips: trips.length, tripsPerDay: spanDays ? trips.length / spanDays : 0,
    winRate: trips.length ? wins.length / trips.length : null,
    avgWinPct, avgLossPct,
    payoff: avgWin != null && avgLoss ? avgWin / avgLoss : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    medianHoldMs: median(trips.map((t) => t.holdMs)),
    longShare: trips.length ? trips.filter((t) => t.side > 0).length / trips.length : null,
    addAgainstShare: adds ? sum(trips, (t) => t.addAgainst) / adds : null,
    addsPerTrip: trips.length ? sum(trips, (t) => t.adds) / trips.length : null,
    top3Share: grossWin > 0 ? top3 / grossWin : null,
    worstVsAvgWin: avgWin && losses.length ? Math.max(...losses.map((t) => -t.pnl)) / avgWin : null,
    coins: byCoin.size, topCoin: topCoin ? { coin: topCoin[0], share: topCoin[1] / perpVolume } : null,
    realized, fees, funding: fundingNet,
    fundingShare: weekPnl > 0 ? fundingNet / weekPnl : null,
    leverage: equity > 0 ? exposure / equity : null, openPositions: positions.length,
    openLongShare: exposure > 0 ? longExposure / exposure : null,
  };
  return { ...s, ...styleOf(s) };
}

const HOUR = 3_600_000;

/** A plain-words label for how the account trades, and whether a retail trader could test the same idea. */
export function styleOf(s) {
  let style, why, testable = false;
  if (!s.fills) {
    style = 'No trades in the period'; why = 'Profit came from positions or coins it was already holding.';
  } else if ((s.makerShare ?? 0) >= 0.7 && s.fillsPerDay >= 300) {
    style = 'Market maker'; why = 'Rests orders on both sides and earns the spread, hundreds of fills a day. Needs speed and fee rebates.';
  } else if (s.medianHoldMs != null && s.medianHoldMs < 5 * 60_000 && s.tripsPerDay >= 50) {
    style = 'High-frequency'; why = 'In and out within minutes, dozens of times a day. A bot with low fees, not a pattern to copy by hand.';
  } else if (s.spotShare >= 0.5) {
    style = 'Mostly spot'; why = 'Most of its trading is buying and selling coins outright, not futures. Not measured here.';
  } else if (s.funding > 0 && (s.fundingShare ?? 0) >= 0.4) {
    style = 'Funding income'; why = 'Funding payments were a large part of the last week\u2019s profit, not just price moves.';
    testable = true;
  } else if (s.trips < 10) {
    if (s.fills >= 100) { style = 'Position holder'; why = 'Builds and trims positions over days or weeks in many orders and rarely goes flat, so few trades complete. Win rate cannot be measured.'; }
    else { style = 'Few trades'; why = 'Hardly traded in the period. Nothing to measure.'; }
  } else if ((s.top3Share ?? 0) >= 0.7) {
    style = 'A few big bets'; why = 'Most of the winnings are three trades. Too few to tell skill from luck.';
  } else if ((s.addAgainstShare ?? 0) >= 0.6 && s.addsPerTrip >= 1 && s.winRate >= 0.7 && (s.payoff ?? 9) < 1) {
    style = 'Averages into losers'; why = 'Buys more as price goes against it and takes small wins. Wins often, then one loss can take back many wins.';
  } else if (s.addAgainstShare != null && s.addAgainstShare <= 0.4 && s.addsPerTrip >= 1 && (s.payoff ?? 0) >= 1.5) {
    style = 'Adds to winners'; why = 'Starts small, adds as the trade works, cuts losers early: wins are bigger than losses.';
    testable = s.medianHoldMs >= HOUR && s.trips >= 20;
  } else {
    style = s.medianHoldMs < HOUR ? 'Scalper' : s.medianHoldMs < 24 * HOUR ? 'Day trader' : 'Swing trader';
    why = s.medianHoldMs < HOUR ? 'Typical trade lasts under an hour.' : s.medianHoldMs < 24 * HOUR ? 'Typical trade lasts hours.' : 'Typical trade lasts days.';
    testable = s.medianHoldMs >= HOUR && s.trips >= 20;
  }
  return { style, why, testable };
}

// ---- Timing: is it when they enter, or which side they are on? ----

/**
 * Entry decisions from fills: every fill that makes a perp position bigger, merged per coin, side and hour
 * (a position built with 200 small orders in an hour is one decision). [{ coin, side, t, px, notional }].
 */
export function entryEvents(fills, bucketMs = HOUR) {
  const buckets = new Map();
  for (const f of fills.filter((x) => isPerp(x.coin)).sort((a, b) => a.time - b.time)) {
    const px = num(f.px), sz = num(f.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    const signed = f.side === 'B' ? sz : -sz;
    const start = num(f.startPosition), end = start + signed;
    const eps = 1e-9 * Math.max(Math.abs(start), sz) + 1e-12;
    let opened = 0; // how much of this fill made the position bigger
    if (Math.abs(start) < eps || Math.sign(signed) === Math.sign(start)) opened = sz;
    else if (Math.abs(end) > eps && Math.sign(end) !== Math.sign(start)) opened = Math.abs(end); // a flip: the part past flat
    if (!(opened > 0)) continue;
    const side = Math.sign(signed);
    const key = `${f.coin}|${side}|${Math.floor(f.time / bucketMs)}`;
    const b = buckets.get(key) ?? { coin: f.coin, side, t: f.time, size: 0, notional: 0 };
    b.size += opened; b.notional += opened * px;
    buckets.set(key, b);
  }
  return [...buckets.values()].map((b) => ({ coin: b.coin, side: b.side, t: b.t, px: b.notional / b.size, notional: b.notional })).sort((a, b) => a.t - b.t);
}

/** Index of the hourly candle that contains time t, or -1. bars: [{ t, h, l, c }] sorted by t. */
function barAt(bars, t, ms = HOUR) {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t + ms <= t) lo = mid + 1;
    else if (bars[mid].t > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/**
 * What price had done before an entry and what it did after, on hourly candles.
 * before24: % move over the 24 candles before the entry candle. rangePos: where the entry price sat in the prior
 * 7 days' range (0 = the low, 1 = the high). fwd: % result in the trade's direction after each horizon (candles),
 * from the trader's own price. Fields are null where there is not enough history or future.
 */
export function eventOutcome(bars, ev, horizons = [24, 72]) {
  const i = barAt(bars, ev.t);
  if (i < 0) return null;
  // The trader's price should sit inside (or right next to) that hour's candle. If it does not, the candles are
  // for something else (a renamed coin, another venue's listing) and the entry cannot be measured.
  if (ev.px > bars[i].h * 1.03 || ev.px < bars[i].l * 0.97) return null;
  const out = { before24: null, rangePos: null, fwd: {} };
  if (i >= 25) out.before24 = (bars[i - 1].c / bars[i - 25].c - 1) * 100;
  if (i >= 168) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - 168; k < i; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
    if (hi > lo) out.rangePos = Math.min(1, Math.max(0, (ev.px - lo) / (hi - lo)));
  }
  for (const n of horizons) out.fwd[n] = i + n < bars.length ? ev.side * (bars[i + n].c / ev.px - 1) * 100 : null;
  return out;
}

/** Average % move over `horizon` candles from every candle that opens in [from, to]: what "any hour" earned a long. */
export function anyHour(bars, from, to, horizon) {
  let total = 0, n = 0;
  for (let j = 0; j + horizon < bars.length; j++) {
    if (bars[j].t < from || bars[j].t > to) continue;
    total += (bars[j + horizon].c / bars[j].c - 1) * 100;
    n++;
  }
  return n ? total / n : null;
}

/** Mean, and the noise range (2 standard errors), of a list of numbers. */
export function meanSe(list) {
  const n = list.length;
  if (!n) return { n: 0, mean: null, noise: null };
  const mean = sum(list) / n;
  const sd = Math.sqrt(sum(list, (x) => (x - mean) ** 2) / Math.max(1, n - 1));
  return { n, mean, noise: (2 * sd) / Math.sqrt(n) };
}

/**
 * One trader's entries against "the same side at any hour". events: entryEvents(). barsByCoin: Map coin -> bars.
 * Returns per horizon: their average result, what the same side earned at any hour in their active window,
 * and the difference (timing) with its noise range; plus how they entered (with or against the last day's move,
 * and where in the week's range).
 */
export function timingStats(events, barsByCoin, horizons = [24, 72]) {
  if (!events.length) return null;
  const from = events[0].t, to = events.at(-1).t;
  const base = new Map();
  const baseline = (coin, n) => {
    const k = `${coin}|${n}`;
    if (!base.has(k)) base.set(k, anyHour(barsByCoin.get(coin), from, to, n));
    return base.get(k);
  };
  const rows = [];
  for (const ev of events) {
    const bars = barsByCoin.get(ev.coin);
    const o = bars ? eventOutcome(bars, ev, horizons) : null;
    if (o) rows.push({ ev, o });
  }
  const out = { entries: rows.length, coins: new Set(rows.map((r) => r.ev.coin)).size, longShare: rows.length ? rows.filter((r) => r.ev.side > 0).length / rows.length : null };
  const moved = rows.filter((r) => r.o.before24 != null && r.o.before24 !== 0);
  out.withMove = moved.length ? moved.filter((r) => r.o.before24 * r.ev.side > 0).length / moved.length : null;
  const pos = (side) => median(rows.filter((r) => r.ev.side === side && r.o.rangePos != null).map((r) => r.o.rangePos));
  out.longRangePos = pos(1); out.shortRangePos = pos(-1);
  out.horizons = {};
  for (const n of horizons) {
    const got = rows.map((r) => ({ own: r.o.fwd[n], any: baseline(r.ev.coin, n), side: r.ev.side })).filter((x) => x.own != null && x.any != null);
    const own = meanSe(got.map((x) => x.own)), side = meanSe(got.map((x) => x.side * x.any)), timing = meanSe(got.map((x) => x.own - x.side * x.any));
    out.horizons[n] = { n: got.length, own: own.mean, side: side.mean, timing: timing.mean, noise: timing.noise, edges: got.map((x) => x.own - x.side * x.any) };
  }
  return out;
}
