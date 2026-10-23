// Pump catcher engine. Pure functions with no browser or Node globals, so the web app
// and the background worker (worker/catcher.mjs) share exactly the same rules.
//
// A signal goes through three gates:
//   1. Screen  – price has lifted a moderate amount off its rolling 24h low, and moved fast in the last 5 minutes.
//   2. Confirm – the move has fuel: volume spike, taker buying (positive CVD), open interest growing.
//   3. Edge    – positioning favours more upside: whales longer than the crowd, or a heavily short crowd.
// Once fired, a signal is tracked until it fails or gives back most of its gain.

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
};

const pct = (a, b) => ((a - b) / b) * 100;

/**
 * Gate 1, cheap and run on every pair every cycle.
 * ticker: { price, low24h }, price5mAgo: number | null
 */
export function screen(ticker, price5mAgo, cfg = DEFAULTS) {
  if (!(ticker.low24h > 0) || !(ticker.price > 0)) return { pass: false, rise: 0, impulse: 0 };
  const rise = pct(ticker.price, ticker.low24h);
  const impulse = price5mAgo > 0 ? pct(ticker.price, price5mAgo) : 0;
  return {
    pass: rise >= cfg.minRise && rise <= cfg.maxRise && impulse >= cfg.minImpulse,
    inBand: rise >= cfg.minRise && rise <= cfg.maxRise,
    rise,
    impulse,
  };
}

/**
 * Order flow from 1-minute klines (Binance kline arrays or { v, takerBuy } objects).
 * Returns relative volume and taker buy share for the last 5 minutes.
 */
export function orderFlow(klines) {
  const rows = klines.map((k) => (Array.isArray(k) ? { v: +k[7], takerBuy: +k[10] } : k));
  if (rows.length < 10) return { rvol: 0, takerBuy: 0.5, cvd5m: 0 };
  const last = rows.slice(-5);
  const prior = rows.slice(0, -5);
  const lastVol = last.reduce((s, r) => s + r.v, 0);
  const windows = Math.max(1, Math.floor(prior.length / 5));
  const avg5 = prior.reduce((s, r) => s + r.v, 0) / windows;
  const buys = last.reduce((s, r) => s + r.takerBuy, 0);
  return {
    rvol: avg5 > 0 ? lastVol / avg5 : 0,
    takerBuy: lastVol > 0 ? buys / lastVol : 0.5,
    cvd5m: buys - (lastVol - buys), // in quote currency (USDT)
  };
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
      label: edgeSqueeze && !edgeWhales ? 'Crowd heavily short' : 'Whales longer than crowd',
      value: gap,
      ok: !cfg.requireEdge || edgeWhales || edgeSqueeze,
    },
  ];
  return { pass: checks.every((c) => c.ok), checks, gap };
}

export function createSignal({ symbol, price, t, rise, impulse, ctx = {}, gap = null }) {
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
  const now = pct(price, sig.alertPrice);
  if (now <= -cfg.stopPct) close(sig, t, 'Fell below alert price');
  else if (sig.rise >= cfg.trailFrom && now < sig.rise * (1 - cfg.trailGiveBack)) close(sig, t, 'Gave back most of the gain');
  else if (t - sig.alertT > cfg.maxTrackHours * 3_600_000) close(sig, t, 'Tracking window ended');
  return sig;
}

function close(sig, t, reason) {
  sig.status = 'CLOSED';
  sig.closedT = t;
  sig.closeReason = reason;
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
export function stats(signals) {
  const done = signals.filter((s) => s.rise != null);
  const hit = (n) => done.filter((s) => s.rise >= n).length;
  const median = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  return {
    count: signals.length,
    tracking: signals.filter((s) => s.status === 'TRACKING').length,
    hit5: done.length ? hit(5) / done.length : null,
    hit10: done.length ? hit(10) / done.length : null,
    medianRise: median(done.map((s) => s.rise)),
    medianDip: median(done.map((s) => s.dip)),
  };
}
