// Binance "Smart Money" cohort data: parsing, cohort choice and snapshot diffs.
// Pure functions shared by the worker (which polls Binance) and the web app (which reads the worker).
//
// Binance's web terminal reports, per pair and per side (long / short), for two cohorts:
//   whales        – large, consistently profitable futures accounts
//   smart traders – profitable accounts with smaller positions
// trader count, position value (USD), average entry price, unrealized PnL and share of traders in profit.
// It is a snapshot of open positions, so moves and opens come from comparing consecutive snapshots.
//
// The endpoint is undocumented and its field names may change, so parseOverview matches fields by
// meaning (cohort + side + metric) instead of exact names, and reports anything it couldn't place.

export const COHORTS = ['whale', 'smart'];
export const SIDES = ['long', 'short'];
export const METRICS = ['count', 'usd', 'entry', 'upnl', 'winRate'];

// Order matters: the first metric whose pattern matches a field wins.
const METRIC_PATTERNS = [
  ['entry', /entry|avg_?price|average_?price|avgprice|costprice/],
  ['upnl', /unreali[sz]ed|upnl|floatingpnl|pnl/],
  ['winRate', /profitable|winrate|win_?rate|profit_?(rate|ratio|share|pct|percent)/],
  ['count', /count|number|num$|traders?$|headcount|users?$/],
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
  const cohort = /whale/.test(p) ? 'whale' : /smart|sm_|elite|top/.test(p) ? 'smart' : null;
  const side = /long|buy|bull/.test(leaf) || /(^|\.)long(\.|$)/.test(p) ? 'long' : /short|sell|bear/.test(leaf) || /(^|\.)short(\.|$)/.test(p) ? 'short' : null;
  if (!cohort || !side) return null;
  // Strip cohort and side words so they don't trigger metric patterns ("longs" ≠ "count").
  const rest = leaf.replace(/whale|smartmoney|smart|long|short|buy|sell/g, '');
  for (const [metric, re] of METRIC_PATTERNS) if (re.test(rest)) return { cohort, side, metric };
  return null;
}

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[,%$]/g, '')) : +v;
  return Number.isFinite(n) ? n : null;
};

const emptySide = () => ({ count: null, usd: null, entry: null, upnl: null, winRate: null });

/**
 * Normalise one overview response.
 * Returns { symbol, t, whale: { long, short }, smart: { long, short }, matched: [...], unmatched: [...] }.
 * `raw` may be the full { success, data } envelope or just `data`.
 */
export function parseOverview(raw, { symbol = null, t = Date.now() } = {}) {
  const data = raw && typeof raw === 'object' && 'data' in raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const snap = { symbol, t, whale: { long: emptySide(), short: emptySide() }, smart: { long: emptySide(), short: emptySide() }, matched: [], unmatched: [] };
  for (const [path, value] of flatten(data)) {
    if (!snap.symbol && /(^|\.)symbol$/i.test(path) && typeof value === 'string') {
      snap.symbol = value;
      continue;
    }
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
  return snap;
}

export function hasCohort(snap, cohort) {
  const c = snap?.[cohort];
  return !!c && (c.long.usd != null || c.short.usd != null);
}

/** Whales unless fewer than `minWhales` hold positions on this pair; then smart traders. */
export function pickCohort(snap, minWhales = 10) {
  const w = snap.whale;
  const whales = (w.long.count ?? 0) + (w.short.count ?? 0);
  const countsKnown = w.long.count != null || w.short.count != null;
  if (hasCohort(snap, 'whale') && (!countsKnown || whales >= minWhales)) return 'whale';
  if (hasCohort(snap, 'smart')) return 'smart';
  return hasCohort(snap, 'whale') ? 'whale' : null;
}

/** Headline numbers for one cohort. oiUsd (total open interest in USD) gives the crowd = everyone else. */
export function summarize(snap, cohort = pickCohort(snap), oiUsd = null) {
  if (!cohort) return null;
  const c = snap[cohort];
  const L = c.long.usd ?? 0;
  const S = c.short.usd ?? 0;
  const out = {
    cohort,
    longUsd: L,
    shortUsd: S,
    net: L - S,
    longShare: L + S > 0 ? L / (L + S) : null,
    longCount: c.long.count,
    shortCount: c.short.count,
    longEntry: c.long.entry,
    shortEntry: c.short.entry,
    longUpnl: c.long.upnl,
    shortUpnl: c.short.upnl,
    longWinRate: c.long.winRate,
    shortWinRate: c.short.winRate,
    crowdLongShare: null,
  };
  // Every contract has one long and one short holder, so open interest = total long notional = total short notional.
  if (oiUsd > 0) {
    const cl = Math.max(0, oiUsd - L);
    const cs = Math.max(0, oiUsd - S);
    out.crowdLongShare = cl + cs > 0 ? cl / (cl + cs) : null;
  }
  return out;
}

/**
 * Compare two snapshots of the same pair. mark price is needed to turn USD into contracts,
 * so a price move alone doesn't look like whales adding.
 *
 * Returns { move, opensLong, opensShort, net, roster, reason }:
 *   move        change in net exposure in USD at the new price (longs added or shorts closed > 0)
 *   opensLong   newly added long exposure only; closures are excluded
 *   opensShort  newly added short exposure only
 *   roster      true when the change looks like traders entering or leaving the cohort, not trading;
 *               move and opens are then 0
 *
 * Roster test: adding at price P moves the average entry to (E0·Q0 + P·ΔQ) / (Q0 + ΔQ); closing leaves it
 * unchanged. If the reported entry is far from that, someone with a different cost basis joined or left.
 */
export function diffSnapshots(prev, cur, { cohort, entryTol = 0.004, maxGapMs = 20 * 60_000 } = {}) {
  const k = cohort ?? pickCohort(cur);
  const kPrev = cohort ?? pickCohort(prev);
  const P1 = cur.mark;
  const P0 = prev.mark;
  const zero = { move: 0, opensLong: 0, opensShort: 0, net: null, roster: false, reason: null };
  if (!k || !(P1 > 0) || !(P0 > 0)) return { ...zero, reason: 'missing price' };
  const now = cur[k];
  const net = ((now.long.usd ?? 0) - (now.short.usd ?? 0));
  if (k !== kPrev) return { ...zero, net, roster: true, reason: 'cohort switched' };
  if (cur.t - prev.t > maxGapMs) return { ...zero, net, reason: 'gap' };

  const before = prev[k];
  const d = {};
  let roster = false;
  for (const side of SIDES) {
    const Q0 = (before[side].usd ?? 0) / P0;
    const Q1 = (now[side].usd ?? 0) / P1;
    const dQ = Q1 - Q0;
    d[side] = dQ;
    const E0 = before[side].entry;
    const E1 = now[side].entry;
    if (E0 > 0 && E1 > 0 && Q0 > 0 && Q1 > 0) {
      const expected = dQ > 0 ? (E0 * Q0 + P1 * dQ) / Q1 : E0;
      if (Math.abs(E1 - expected) / P1 > entryTol) roster = true;
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
 * Candles with no snapshot get nulls, so charts show a gap rather than invented values.
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
      if (d.reason === 'gap' || d.reason === 'missing price') continue;
      row.move = (row.move ?? 0) + d.move;
      row.opensLong = (row.opensLong ?? 0) + d.opensLong;
      row.opensShort = (row.opensShort ?? 0) + d.opensShort;
    }
  }
  return out;
}
