// Binance "Smart Money" cohort data: parsing, cohort choice and snapshot diffs.
// Pure functions shared by the worker (which polls Binance) and the web app (which reads the worker).
//
// The overview endpoint (checked against a live response, October 2026) reports per side (long / short)
// for two groups:
//   Whales   – the largest smart-money traders           → cohort 'whale'
//   Traders  – all tracked smart-money traders, whales included → cohort 'smart'
// with trader count, position size in coins (Qty), average entry price and how many traders are in profit,
// plus updateTime (when Binance last recalculated it). Example fields:
//   longWhales, longWhalesQty, longWhalesAvgEntryPrice, longProfitWhales,
//   longTraders, longTradersQty, longTradersAvgEntryPrice, longProfitTraders, updateTime
// USD value and unrealized PnL aren't sent; they follow exactly from size, entry and the mark price.
// It is a snapshot of open positions, so moves and opens come from comparing consecutive snapshots.
//
// The endpoint is undocumented. If the known field names disappear, a generic matcher tries to place
// fields by meaning (cohort + side + metric) and reports anything it couldn't place.

export const COHORTS = ['whale', 'smart'];
export const SIDES = ['long', 'short'];

const KNOWN_WORD = { whale: 'Whales', smart: 'Traders' };

// Generic matcher, used only when the known field names are missing. First matching metric wins.
const METRIC_PATTERNS = [
  ['entry', /entry|avg_?price|average_?price|avgprice|costprice/],
  ['upnl', /unreali[sz]ed|upnl|floatingpnl|pnl/],
  ['winRate', /profitable|winrate|win_?rate|profit_?(rate|ratio|share|pct|percent)/],
  ['qty', /qty|quantity|contracts|amountbase/],
  ['count', /count|number|num$|traders?$|headcount|users?$|whales?$/],
  ['usd', /value|notional|amount|size|usd|volume|position$/],
];

/** Flatten nested objects into [path, value] pairs, e.g. ['data.whale.long.positionValue', '123']. */
export function flatten(obj, prefix = '', out = []) {
  if (obj == null) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.push([prefix, obj]);
  return out;
}

function classify(path) {
  const p = path.toLowerCase().replace(/\[\d+\]/g, '');
  const leaf = p.split('.').pop();
  const cohort = /whale/.test(p) ? 'whale' : /smart|sm_|elite|top|trader/.test(p) ? 'smart' : null;
  const side = /long|buy|bull/.test(leaf) || /(^|\.)long(\.|$)/.test(p) ? 'long' : /short|sell|bear/.test(leaf) || /(^|\.)short(\.|$)/.test(p) ? 'short' : null;
  if (!cohort || !side) return null;
  const rest = leaf.replace(/smartmoney|smart|long|short|buy|sell/g, '');
  if (/profit/.test(rest) && !/rate|ratio|pct|percent|share/.test(rest)) return { cohort, side, metric: 'profitCount' };
  const metricText = rest.replace(/whales?|traders?/g, (m) => (rest === m ? 'count' : ''));
  for (const [metric, re] of METRIC_PATTERNS) if (re.test(metricText)) return { cohort, side, metric };
  return null;
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(/[,%$]/g, '')) : +v;
  return Number.isFinite(n) ? n : null;
};

const emptySide = () => ({ count: null, qty: null, usd: null, entry: null, upnl: null, profitCount: null, winRate: null });

function finishSide(s) {
  if (s.winRate == null && s.profitCount != null && s.count > 0) s.winRate = s.profitCount / s.count;
  return s;
}

/**
 * Normalise one overview response.
 * Returns { symbol, t, sourceT, whale: { long, short }, smart: { long, short }, format, matched, unmatched }.
 * t is when Binance measured the positions (its updateTime) when present, otherwise `t`.
 * `raw` may be the full { success, data } envelope or just `data`.
 */
export function parseOverview(raw, { symbol = null, t = Date.now() } = {}) {
  const data = raw && typeof raw === 'object' && 'data' in raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const snap = {
    symbol, t, sourceT: null, totalUsd: null, format: null,
    whale: { long: emptySide(), short: emptySide() },
    smart: { long: emptySide(), short: emptySide() },
    matched: [], unmatched: [],
  };
  if (!data || typeof data !== 'object') return snap;
  if (typeof data.symbol === 'string') snap.symbol = data.symbol;
  snap.sourceT = num(data.updateTime);
  snap.totalUsd = num(data.totalPositions);
  if (snap.sourceT) snap.t = snap.sourceT;

  const used = new Set(['symbol', 'updateTime', 'totalPositions']);
  const isKnown = ['longWhalesQty', 'shortWhalesQty', 'longTradersQty', 'shortTradersQty'].some((k) => k in data);
  if (isKnown) {
    snap.format = 'known';
    for (const [cohort, word] of Object.entries(KNOWN_WORD)) {
      for (const side of SIDES) {
        const fields = {
          count: `${side}${word}`,
          qty: `${side}${word}Qty`,
          entry: `${side}${word}AvgEntryPrice`,
          profitCount: `${side}Profit${word}`,
        };
        for (const [metric, key] of Object.entries(fields)) {
          if (!(key in data)) continue;
          snap[cohort][side][metric] = num(data[key]);
          used.add(key);
          snap.matched.push(`${key} → ${cohort}.${side}.${metric}`);
        }
        finishSide(snap[cohort][side]);
      }
    }
    snap.unmatched = Object.keys(data).filter((k) => !used.has(k));
    return snap;
  }

  snap.format = 'generic';
  for (const [path, value] of flatten(data)) {
    if (used.has(path)) continue;
    const c = classify(path);
    const n = num(value);
    if (!c || n == null) {
      snap.unmatched.push(path);
      continue;
    }
    const slot = snap[c.cohort][c.side];
    if (slot[c.metric] != null) {
      snap.unmatched.push(path); // keep the first match; report the duplicate
      continue;
    }
    slot[c.metric] = c.metric === 'winRate' && n > 1 ? n / 100 : n;
    snap.matched.push(`${path} → ${c.cohort}.${c.side}.${c.metric}`);
  }
  for (const k of COHORTS) for (const s of SIDES) finishSide(snap[k][s]);
  return snap;
}

const hasSize = (s) => s.qty != null || s.usd != null;

export function hasCohort(snap, cohort) {
  const c = snap?.[cohort];
  return !!c && (hasSize(c.long) || hasSize(c.short));
}

/** Whales unless fewer than `minWhales` hold positions on this pair; then all smart-money traders. */
export function pickCohort(snap, minWhales = 10) {
  const w = snap.whale;
  const whales = (w.long.count ?? 0) + (w.short.count ?? 0);
  const countsKnown = w.long.count != null || w.short.count != null;
  if (hasCohort(snap, 'whale') && (!countsKnown || whales >= minWhales)) return 'whale';
  if (hasCohort(snap, 'smart')) return 'smart';
  return hasCohort(snap, 'whale') ? 'whale' : null;
}

/** Size in coins: reported directly, or USD ÷ mark price. */
function qtyOf(side, mark) {
  if (side.qty != null) return side.qty;
  if (side.usd != null && mark > 0) return side.usd / mark;
  return null;
}

/** One side priced at `mark`: USD value and unrealized PnL, computed when Binance doesn't send them. */
function priced(side, mark, dir) {
  const qty = qtyOf(side, mark);
  const usd = side.usd ?? (qty != null && mark > 0 ? qty * mark : null);
  const upnl = side.upnl ?? (qty != null && side.entry > 0 && mark > 0 ? dir * (mark - side.entry) * qty : null);
  return { qty, usd, upnl };
}

/**
 * Headline numbers for one cohort, priced at snap.mark.
 * oiUsd (total open interest in USD) gives the crowd as everyone else, for reference.
 */
export function summarize(snap, cohort = pickCohort(snap), oiUsd = null) {
  if (!cohort || !hasCohort(snap, cohort)) return null;
  const c = snap[cohort];
  const mark = snap.mark;
  const L = priced(c.long, mark, 1);
  const S = priced(c.short, mark, -1);
  // Long share by size: coins when known, otherwise USD (same thing at one price).
  const lq = L.qty ?? L.usd ?? 0;
  const sq = S.qty ?? S.usd ?? 0;
  const out = {
    cohort,
    t: snap.t,
    mark: mark ?? null,
    longQty: L.qty,
    shortQty: S.qty,
    longUsd: L.usd ?? 0,
    shortUsd: S.usd ?? 0,
    net: (L.usd ?? 0) - (S.usd ?? 0),
    longShare: lq + sq > 0 ? lq / (lq + sq) : null,
    longCount: c.long.count,
    shortCount: c.short.count,
    longEntry: c.long.entry,
    shortEntry: c.short.entry,
    longUpnl: L.upnl,
    shortUpnl: S.upnl,
    longProfitCount: c.long.profitCount,
    shortProfitCount: c.short.profitCount,
    longWinRate: c.long.winRate,
    shortWinRate: c.short.winRate,
    crowdLongShare: null,
  };
  // Every contract has one long and one short holder, so open interest = total long size = total short size.
  if (oiUsd > 0 && L.usd != null && S.usd != null) {
    const cl = Math.max(0, oiUsd - L.usd);
    const cs = Math.max(0, oiUsd - S.usd);
    out.crowdLongShare = cl + cs > 0 ? cl / (cl + cs) : null;
  }
  return out;
}

/**
 * Compare two snapshots of the same pair. Sizes are compared in coins, so a price move alone
 * never looks like whales adding; USD amounts use the newer snapshot's mark price.
 *
 * Returns { move, opensLong, opensShort, net, roster, reason }:
 *   move        change in net exposure in USD (longs added or shorts closed > 0)
 *   opensLong   newly added long exposure only; closures are excluded
 *   opensShort  newly added short exposure only
 *   roster      true when the change looks like traders entering or leaving the group, not trading;
 *               move and opens are then 0
 *
 * Roster test: adding at price P moves the average entry to (E0·Q0 + P·ΔQ) / (Q0 + ΔQ); closing leaves it
 * unchanged. If the reported entry is far from that, someone with a different cost basis joined or left.
 * Binance recalculates this data only every so often, so P is unknown between updates; the tolerance is
 * relative to how far price moved between the two snapshots.
 */
export function diffSnapshots(prev, cur, { cohort, entryTol = 0.004, maxGapMs = 36 * 3_600_000 } = {}) {
  const k = cohort ?? pickCohort(cur);
  const kPrev = cohort ?? pickCohort(prev);
  const P1 = cur.mark;
  const P0 = prev.mark;
  const zero = { move: 0, opensLong: 0, opensShort: 0, net: null, roster: false, reason: null };
  if (!k || !(P1 > 0)) return { ...zero, reason: 'missing price' };
  const now = cur[k];
  const before = prev[k];
  const Q1 = { long: qtyOf(now.long, P1) ?? 0, short: qtyOf(now.short, P1) ?? 0 };
  const net = (Q1.long - Q1.short) * P1;
  if (k !== kPrev) return { ...zero, net, roster: true, reason: 'cohort switched' };
  if (cur.t === prev.t) return { ...zero, net, reason: 'same update' };
  if (cur.t - prev.t > maxGapMs) return { ...zero, net, reason: 'gap' };

  const d = {};
  let roster = false;
  // Trades happened somewhere between the two prices; allow for that range in the entry check.
  const priceSpread = P0 > 0 ? Math.abs(P1 - P0) / P1 : 0;
  for (const side of SIDES) {
    const Q0 = qtyOf(before[side], P0 || P1) ?? 0;
    const dQ = Q1[side] - Q0;
    d[side] = dQ;
    const E0 = before[side].entry;
    const E1 = now[side].entry;
    if (E0 > 0 && E1 > 0 && Q0 > 0 && Q1[side] > 0) {
      const expected = dQ > 0 ? (E0 * Q0 + P1 * dQ) / Q1[side] : E0;
      const slack = dQ > 0 ? (dQ / Q1[side]) * priceSpread : 0;
      if (Math.abs(E1 - expected) / P1 > entryTol + slack) roster = true;
    }
  }
  if (roster) return { ...zero, net, roster: true, reason: 'entry price jumped' };
  return {
    move: (d.long - d.short) * P1,
    opensLong: Math.max(0, d.long) * P1,
    opensShort: Math.max(0, d.short) * P1,
    net,
    roster: false,
    reason: null,
  };
}

/**
 * Turn a pair's snapshot history into per-candle values aligned with `bars`.
 * Each candle gets the sum of moves/opens from snapshots taken inside it, the last net position,
 * long share and entries, and roster=true if any diff inside it was a roster change.
 * Position state carries forward until the next snapshot; candles before the first snapshot stay null.
 */
export function alignToBars(snapshots, bars, ms) {
  const out = bars.map((b) => ({ t: b.t, move: null, opensLong: null, opensShort: null, net: null, longShare: null, longEntry: null, shortEntry: null, roster: false, cohort: null }));
  if (!bars.length) return out;
  const first = bars[0].t;
  const idx = (t) => Math.floor((t - first) / ms);
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    const j = idx(s.t);
    if (j < 0 || j >= out.length) continue;
    const row = out[j];
    const sum = summarize(s);
    if (!sum) continue;
    row.net = sum.net;
    row.longShare = sum.longShare;
    row.longEntry = sum.longEntry;
    row.shortEntry = sum.shortEntry;
    row.cohort = sum.cohort;
    if (i > 0) {
      const d = diffSnapshots(snapshots[i - 1], s);
      if (d.roster) row.roster = true;
      if (d.reason) continue;
      row.move = (row.move ?? 0) + d.move;
      row.opensLong = (row.opensLong ?? 0) + d.opensLong;
      row.opensShort = (row.opensShort ?? 0) + d.opensShort;
    }
  }
  // A snapshot describes open positions until Binance's next update, so carry the position state
  // (not moves or opens, which happen once) forward to every later candle.
  let held = null;
  for (const row of out) {
    if (row.net != null) held = row;
    else if (held) Object.assign(row, { net: held.net, longShare: held.longShare, longEntry: held.longEntry, shortEntry: held.shortEntry, cohort: held.cohort });
  }
  return out;
}
