// Pump catcher engine. Pure functions with no browser or Node globals, so the web app
// and the background worker (worker/catcher.mjs) share exactly the same rules.
//
// A signal goes through three gates:
//   1. Screen  – price has lifted a moderate amount off its rolling 24h low, moved fast in the last 5 minutes,
//                and isn't just bouncing far below its 24h high.
//   2. Confirm – order flow backs the move: volume spike, taker buying (positive CVD), open interest growing.
//   3. Edge    – positioning: top accounts longer than the crowd, or a heavily short crowd.
// Once fired, a signal is tracked until it fails or gives back most of its gain, and its exit price is stored
// so results can be reported as realised returns after costs, not only as the best price reached.

export const DEFAULTS = {
  minRise: 4.5, // % above the 24h low, lower bound
  maxRise: 18, // % above the 24h low, upper bound: past this the move is usually spent
  minImpulse: 1.5, // % price change over the last 5 minutes
  minRvol: 2.5, // last 5m volume ÷ average 5m volume over the previous 30 minutes
  minTakerBuy: 0.56, // taker buy share of volume, last 5 minutes (0.5 = balanced)
  minOiChange: 1.5, // % open interest change over 15 minutes
  requireEdge: true,
  minGap: 5, // whale long % minus crowd long %, in points
  squeezeCrowdLong: 0.4, // crowd long share below this counts as squeeze fuel
  stopPct: 5, // close when price falls this % below the alert price
  trailFrom: 8, // trailing close only arms once the rise reaches this %
  trailGiveBack: 0.45, // close after giving back this share of the best rise
  maxTrackHours: 72,
  cooldownMin: 60, // no new alert on the same pair for this long after one closes
  requireWhaleBias: false, // optional: skip alerts when Binance Smart Money whales lean the other way
  maxBelowHigh: 20, // skip when price is more than this % below its 24h high (a bounce after a drop, not a breakout)
  stopMode: 'fixed', // 'fixed': stopPct below the alert; 'vol': volStopMult × recent 5-minute range, kept within 3–12%
  volStopMult: 3,
  costPct: 0.15, // assumed round-trip fees + slippage, %, taken off every realised result
};

// Settings that decide which signals fire and how they close. Stored on each signal so the
// record can be split by rule set after Settings change.
const RULE_KEYS = ['minRise', 'maxRise', 'minImpulse', 'minRvol', 'minTakerBuy', 'minOiChange', 'requireEdge', 'minGap', 'squeezeCrowdLong', 'requireWhaleBias', 'maxBelowHigh', 'stopMode', 'stopPct', 'volStopMult', 'trailFrom', 'trailGiveBack', 'maxTrackHours'];

export function ruleSet(cfg = DEFAULTS) {
  return Object.fromEntries(RULE_KEYS.map((k) => [k, cfg[k] ?? DEFAULTS[k]]));
}

/** Short stable id for a rule set, e.g. "r3f9a2c". */
export function configId(cfg = DEFAULTS) {
  const text = JSON.stringify(ruleSet(cfg));
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return 'r' + (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

const pct = (a, b) => ((a - b) / b) * 100;

/**
 * Gate 1, cheap and run on every pair every cycle.
 * ticker: { price, low24h, high24h }, price5mAgo: number | null
 * belowHigh separates a breakout (near the 24h high) from a bounce after a drop (far below it).
 */
export function screen(ticker, price5mAgo, cfg = DEFAULTS) {
  if (!(ticker.low24h > 0) || !(ticker.price > 0)) return { pass: false, inBand: false, rise: 0, impulse: 0, belowHigh: null };
  const rise = pct(ticker.price, ticker.low24h);
  const impulse = price5mAgo > 0 ? pct(ticker.price, price5mAgo) : 0;
  const belowHigh = ticker.high24h > 0 ? Math.max(0, ((ticker.high24h - ticker.price) / ticker.high24h) * 100) : null;
  const notBounce = belowHigh == null || cfg.maxBelowHigh == null || belowHigh <= cfg.maxBelowHigh;
  const inBand = rise >= cfg.minRise && rise <= cfg.maxRise && notBounce;
  return { pass: inBand && impulse >= cfg.minImpulse, inBand, rise, impulse, belowHigh };
}

/**
 * Order flow from 1-minute klines (Binance kline arrays or { v, takerBuy, h, l, c } objects).
 * Returns relative volume and taker buy share for the last 5 minutes, and the typical 5-minute
 * price range (%) over the minutes before, used by the volatility-based stop.
 */
export function orderFlow(klines) {
  const rows = klines.map((k) => (Array.isArray(k) ? { v: +k[7], takerBuy: +k[10], h: +k[2], l: +k[3], c: +k[4] } : k));
  if (rows.length < 10) return { rvol: 0, takerBuy: 0.5, cvd5m: 0, range5m: null };
  const last = rows.slice(-5);
  const prior = rows.slice(0, -5);
  const lastVol = last.reduce((s, r) => s + r.v, 0);
  // Average volume per minute × 5, so any number of prior minutes gives a fair 5-minute baseline.
  const avg5 = (prior.reduce((s, r) => s + r.v, 0) / prior.length) * 5;
  const buys = last.reduce((s, r) => s + r.takerBuy, 0);
  return {
    rvol: avg5 > 0 ? lastVol / avg5 : 0,
    takerBuy: lastVol > 0 ? buys / lastVol : 0.5,
    cvd5m: buys - (lastVol - buys), // in quote currency (USDT)
    range5m: typicalRange(prior),
  };
}

/** Median high–low range of complete 5-minute windows, % of close. */
function typicalRange(rows) {
  if (!rows.length || rows[0].h == null) return null;
  const ranges = [];
  for (let i = rows.length % 5; i + 5 <= rows.length; i += 5) {
    const w = rows.slice(i, i + 5);
    const hi = Math.max(...w.map((r) => r.h));
    const lo = Math.min(...w.map((r) => r.l));
    const c = w[4].c;
    if (c > 0 && hi >= lo) ranges.push(((hi - lo) / c) * 100);
  }
  if (!ranges.length) return null;
  ranges.sort((a, b) => a - b);
  return ranges[Math.floor(ranges.length / 2)];
}

/** Stop distance (%) for a new signal: fixed, or a multiple of the typical 5-minute range. */
export function stopFor(cfg, range5m) {
  if (cfg.stopMode === 'vol' && range5m > 0) return Math.min(12, Math.max(3, range5m * cfg.volStopMult));
  return cfg.stopPct;
}

/**
 * Gates 2 and 3. ctx: { rvol, takerBuy, oiChange, whaleLong, crowdLong }
 * Every check is returned so the UI can show why a pair did or didn't fire.
 */
export function confirm(ctx, cfg = DEFAULTS) {
  const gap = ctx.whaleLong != null && ctx.crowdLong != null ? (ctx.whaleLong - ctx.crowdLong) * 100 : null;
  const edgeWhales = gap != null && gap > cfg.minGap;
  const edgeSqueeze = ctx.crowdLong != null && ctx.crowdLong < cfg.squeezeCrowdLong;
  const checks = [
    { id: 'rvol', label: 'Volume spike', value: ctx.rvol, ok: ctx.rvol >= cfg.minRvol },
    { id: 'cvd', label: 'Taker buying', value: ctx.takerBuy, ok: ctx.takerBuy >= cfg.minTakerBuy },
    { id: 'oi', label: 'Open interest rising', value: ctx.oiChange, ok: ctx.oiChange != null && ctx.oiChange >= cfg.minOiChange },
    {
      id: 'edge',
      label: edgeSqueeze && !edgeWhales ? 'Crowd heavily short' : 'Top accounts longer than crowd',
      value: gap,
      ok: !cfg.requireEdge || edgeWhales || edgeSqueeze,
    },
  ];
  return { pass: checks.every((c) => c.ok), checks, gap };
}

export function createSignal({ symbol, price, t, rise, impulse, ctx = {}, gap = null, cfg = null, belowHigh = null }) {
  const rules = cfg ? ruleSet(cfg) : null;
  return {
    id: `${symbol}-${t}`,
    symbol,
    status: 'TRACKING',
    alertT: t,
    alertPrice: price,
    riseFromLow: rise,
    impulse,
    rvol: ctx.rvol ?? null,
    takerBuy: ctx.takerBuy ?? null,
    oiChange: ctx.oiChange ?? null,
    whaleLong: ctx.whaleLong ?? null,
    crowdLong: ctx.crowdLong ?? null,
    gap,
    lastPrice: price,
    lastT: t,
    peakPrice: price,
    peakT: t,
    lowSinceAlert: price,
    rise: 0, // best gain after the alert, %   (maximum favourable excursion)
    dip: 0, // worst drawdown before that best gain, %   (maximum adverse excursion up to the peak)
    closedT: null,
    closeReason: null,
    exitPrice: null, // price when tracking closed
    belowHigh,
    range5m: ctx.range5m ?? null,
    stopPct: cfg ? stopFor(cfg, ctx.range5m) : null, // the stop this signal was given, % below the alert
    cfgId: cfg ? configId(cfg) : null,
    rules,
  };
}

/** Feed one price into a tracking signal. Mutates and returns it. */
export function updateSignal(sig, price, t, cfg = DEFAULTS) {
  if (sig.status !== 'TRACKING' || !(price > 0) || t < sig.lastT) return sig;
  sig.lastPrice = price;
  sig.lastT = t;
  if (price < sig.lowSinceAlert) sig.lowSinceAlert = price;
  if (price > sig.peakPrice) {
    sig.peakPrice = price;
    sig.peakT = t;
    sig.rise = pct(price, sig.alertPrice);
    // Frozen at each new high: later drawdowns after the peak don't count as "dip before peak".
    sig.dip = Math.min(0, pct(sig.lowSinceAlert, sig.alertPrice));
  }
  // Each signal keeps the exit rules it fired with, so later Settings changes don't rewrite open trades.
  const r = sig.rules ?? cfg;
  const stop = sig.stopPct ?? r.stopPct;
  const now = pct(price, sig.alertPrice);
  if (now <= -stop) close(sig, t, price, 'Hit the stop');
  else if (sig.rise >= r.trailFrom && now < sig.rise * (1 - r.trailGiveBack)) close(sig, t, price, 'Gave back most of the gain');
  else if (t - sig.alertT > r.maxTrackHours * 3_600_000) close(sig, t, price, 'Tracking window ended');
  return sig;
}

function close(sig, t, price, reason) {
  sig.status = 'CLOSED';
  sig.closedT = t;
  sig.exitPrice = price;
  sig.closeReason = reason;
}

/**
 * Realised result of a closed signal, % after costs: bought at the alert price, sold at the exit.
 * Older signals saved before exit prices were stored use the last tracked price, which is the same thing.
 * Returns null for signals still open.
 */
export function realised(sig, costPct = DEFAULTS.costPct) {
  if (sig.status !== 'CLOSED') return null;
  const exit = sig.exitPrice ?? sig.lastPrice;
  if (!(exit > 0) || !(sig.alertPrice > 0)) return null;
  return pct(exit, sig.alertPrice) - costPct;
}

/**
 * Catch up a signal from candles (after a reload or a dropped connection).
 * Within each candle the path is assumed to be open → nearer extreme → farther extreme → close.
 */
export function replayCandles(sig, candles, cfg = DEFAULTS) {
  for (const k of candles) {
    if (sig.status !== 'TRACKING') break;
    if (k.t + 60_000 <= sig.lastT) continue;
    const lowFirst = k.c >= k.o;
    const path = lowFirst ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    const step = 15_000;
    path.forEach((p, i) => updateSignal(sig, p, Math.max(sig.lastT, k.t + i * step), cfg));
  }
  return sig;
}

export function inCooldown(symbol, signals, t, cfg = DEFAULTS) {
  return signals.some((s) => s.symbol === symbol && (s.status === 'TRACKING' || t - (s.closedT ?? 0) < cfg.cooldownMin * 60_000));
}

/** Summary numbers for a list of signals. */
/**
 * Whale positioning at the alert price, from a Binance Smart Money summary (smartmoney.summarize output).
 * Context only: Binance recalculates this data infrequently, so it describes standing positions,
 * not what whales did in the last few minutes.
 *   shortsUnderwater  price is above the whales' average short entry, so their shorts are losing (squeeze fuel)
 *   nearLongEntry     price within 2% of the whales' average long entry
 *   agrees            whales lean long, or their shorts are under water: either favours a move up
 */
export function whaleContext(sum, price, now = Date.now()) {
  if (!sum || !(price > 0) || sum.longShare == null) return null;
  const { longQty, shortQty, longEntry, shortEntry, longShare } = sum;
  const longUpnl = longQty > 0 && longEntry > 0 ? (price - longEntry) * longQty : null;
  const shortUpnl = shortQty > 0 && shortEntry > 0 ? (shortEntry - price) * shortQty : null;
  const distLong = longEntry > 0 ? ((price - longEntry) / longEntry) * 100 : null;
  const distShort = shortEntry > 0 ? ((price - shortEntry) / shortEntry) * 100 : null;
  const shortsUnderwater = shortUpnl != null && shortUpnl < 0;
  const nearLongEntry = distLong != null && Math.abs(distLong) <= 2;
  return {
    cohort: sum.cohort,
    longShare,
    longEntry: longEntry ?? null,
    shortEntry: shortEntry ?? null,
    distLong,
    distShort,
    longUpnl,
    shortUpnl,
    shortsUnderwater,
    nearLongEntry,
    leaning: longShare >= 0.6 ? 'long' : longShare <= 0.4 ? 'short' : 'mixed',
    agrees: longShare >= 0.5 || shortsUnderwater,
    updatedAt: sum.t ?? null,
    ageH: sum.t ? (now - sum.t) / 3_600_000 : null,
  };
}

/**
 * Track record. Performance counts closed signals only; open ones are reported separately.
 *   winRate / avgWin / avgLoss / expectancy  from realised results after costPct (what following the
 *                                             close rules would have returned)
 *   hit10 / medianPeak                        best price reached (best case, not achievable in practice)
 */
export function stats(signals, { costPct = DEFAULTS.costPct } = {}) {
  const closed = signals.filter((s) => s.status === 'CLOSED');
  const results = closed.map((s) => realised(s, costPct)).filter((v) => v != null);
  const wins = results.filter((v) => v > 0);
  const losses = results.filter((v) => v <= 0);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const median = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  return {
    count: signals.length,
    tracking: signals.length - closed.length,
    closed: closed.length,
    winRate: results.length ? wins.length / results.length : null,
    avgWin: mean(wins),
    avgLoss: mean(losses),
    expectancy: mean(results),
    stopped: closed.length ? closed.filter((s) => /stop|Fell below/.test(s.closeReason || '')).length / closed.length : null,
    hit10: closed.length ? closed.filter((s) => s.rise >= 10).length / closed.length : null,
    medianPeak: median(closed.map((s) => s.rise)),
    medianDip: median(closed.map((s) => s.dip)),
    costPct,
  };
}
