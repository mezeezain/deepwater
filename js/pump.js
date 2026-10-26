// Pump Catcher rules. Pure functions with no browser or Node globals, so the web app and the
// server (worker/catcher.mjs) apply exactly the same rules.
//
// The whole mechanism, modelled on PumpGlass's Pump Catcher:
//   1. Watch every Binance USDT-M perpetual.
//   2. Track each pair's rolling 24-hour low. That low is the signal's START PRICE.
//   3. Fire when price rises THRESHOLD % above that low (1.27× by default). The first observed price at or
//      past the line is the ALERT PRICE, so alert ÷ start is 1.27 or a little more.
//   4. First-breakout filter (firstBreakout below): only coins that had NOT pumped before, breaking out of a
//      flat base to a new 40-day high on strong volume. Pump-dump-and-bounce coins are filtered out.
//   5. Follow the move: gain now, peak since the alert, time to peak, and the dip before the peak.
// There is no exit rule for trading: the percentages measure what the price did after detection,
// not trading results.

export const THRESHOLD = 27; // % above the rolling 24h low
export const AT_PEAK_PCT = 5; // "At peak": price within this % of the post-alert peak
export const KEEP_DAYS = 30; // log window, and the longest a signal is tracked
export const REARM_MS = 24 * 3_600_000; // a pair can fire again after 24h, or sooner from a lower 24h low

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * First-breakout rules, checked on 1-hour candles when a pair crosses the trigger. The "base" is the history
 * before the current move: up to lookbackDays, ending 24 hours before the alert (the move itself lives in the
 * last 24 hours).
 *   minHistoryDays  enough history to judge (fresh listings usually pump on day one, so they are skipped)
 *   maxPriorRise    no earlier pump: in the base, price never rose this % within any 24 hours
 *   maxBaseRange    a flat base: the base's high is at most this % above its low
 *   minVolMult      breakout on volume: 24h volume at least this multiple of the base's average day
 * and price must be above the base's highest high: a first breakout to a new 40-day high, not a bounce
 * back into an old range.
 */
export const BREAKOUT = { lookbackDays: 40, minHistoryDays: 14, maxPriorRise: 27, maxBaseRange: 60, minVolMult: 2 };
const pct = (a, b) => ((a - b) / b) * 100;

/** % rise of `price` above `low`, or null when either is unusable. */
export function riseFromLow(price, low) {
  return price > 0 && low > 0 ? pct(price, low) : null;
}

/** The trigger price for a 24h low. */
export const triggerPrice = (low, threshold = THRESHOLD) => low * (1 + threshold / 100);

/**
 * Decide whether a ticker fires. `arm` is the pair's small state object ({} to start), kept by the caller.
 * `last` is the pair's most recent signal, if any.
 *
 * - Fires only on an upward crossing that was watched: the pair must have been seen below the line first.
 *   A pair already above the line when scanning starts has pumped before we looked, so it waits for the
 *   next crossing instead of producing a late alert.
 * - Re-arms for a fresh move: the same pair fires again only 24h after its last alert, or sooner if the
 *   24h low has dropped below the last signal's start price (a new low, so a new rebound).
 */
export function shouldFire(arm, tk, last = null, t = tk.t, threshold = THRESHOLD) {
  if (!(tk.price > 0) || !(tk.low24h > 0)) return false;
  if (tk.price < triggerPrice(tk.low24h, threshold)) {
    arm.below = true;
    return false;
  }
  if (!arm.below) return false;
  if (last && t - last.alertT < REARM_MS && !(tk.low24h < last.startPrice * 0.999)) return false;
  arm.below = false;
  return true;
}

export function createSignal({ symbol, price, low24h, t, volume24h = null, threshold = THRESHOLD, breakout = null }) {
  return {
    id: `${symbol}-${t}`,
    rules: 2, // 2 = with the first-breakout filter
    breakout, // { rangeHigh, rangeLow, priorRise, baseRange, volMult, days, checks }
    symbol,
    status: 'TRACKING',
    threshold,
    startPrice: low24h, // the rolling 24h low the move started from
    alertT: t,
    alertPrice: price,
    lastPrice: price,
    lastT: t,
    peakPrice: price,
    peakT: t,
    lowSinceAlert: price,
    dipLow: price, // lowest price between the alert and the peak
    volume24h,
    oiUsd: null,
    whale: null,
    closedT: null,
    closeReason: null,
  };
}

/** Feed one price into a tracking signal. Mutates and returns it. */
export function updateSignal(sig, price, t) {
  if (sig.status !== 'TRACKING' || !(price > 0) || t < sig.lastT) return sig;
  sig.lastPrice = price;
  sig.lastT = t;
  if (price < sig.lowSinceAlert) sig.lowSinceAlert = price;
  if (price > sig.peakPrice) {
    sig.peakPrice = price;
    sig.peakT = t;
    sig.dipLow = sig.lowSinceAlert; // frozen at each new high: drawdowns after the peak are not "before the peak"
  }
  if (price <= sig.startPrice) closeSignal(sig, t, 'Fell back to its 24h low: the whole move was given back');
  else if (t - sig.alertT >= KEEP_DAYS * DAY) closeSignal(sig, t, `Tracked for ${KEEP_DAYS} days`);
  return sig;
}

export function closeSignal(sig, t, reason) {
  if (sig.status !== 'TRACKING') return sig;
  sig.status = 'CLOSED';
  sig.closedT = t;
  sig.closeReason = reason;
  return sig;
}

/**
 * Catch a signal up from 1-minute candles after a restart or a dropped connection.
 * Within each candle the path is open → nearer extreme → farther extreme → close.
 */
export function replayCandles(sig, candles) {
  for (const k of candles) {
    if (sig.status !== 'TRACKING') break;
    if (k.t + 60_000 <= sig.lastT) continue;
    const path = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    path.forEach((p, i) => updateSignal(sig, p, Math.max(sig.lastT, k.t + i * 15_000)));
  }
  return sig;
}

/**
 * Checks a pair against the first-breakout rules.
 * candles: 1-hour candles [{ t, h, l, v }] (v = quote volume, USDT), oldest first, ending at the alert.
 * at: { price, t, volume24h } for the moment of the alert.
 * Returns { pass, checks: [{ id, label, value, ok }], rangeHigh, rangeLow, priorRise, baseRange, volMult, days }.
 */
export function firstBreakout(candles, { price, t, volume24h }, cfg = BREAKOUT) {
  const from = t - (cfg.lookbackDays + 1) * DAY;
  const to = t - DAY;
  const base = candles.filter((k) => k.t >= from && k.t + HOUR <= to && k.h > 0 && k.l > 0);
  const days = base.length / 24;
  let rangeHigh = null;
  let rangeLow = null;
  let priorRise = 0;
  let vol = 0;
  for (let i = 0; i < base.length; i++) {
    const k = base[i];
    rangeHigh = rangeHigh == null ? k.h : Math.max(rangeHigh, k.h);
    rangeLow = rangeLow == null ? k.l : Math.min(rangeLow, k.l);
    vol += k.v || 0;
    // Largest rise inside any 24-hour window: this hour's high against the lowest low of the 24 hours up to it.
    let low = k.l;
    for (let j = Math.max(0, i - 23); j < i; j++) if (base[j].l < low) low = base[j].l;
    priorRise = Math.max(priorRise, pct(k.h, low));
  }
  const baseRange = rangeHigh && rangeLow ? pct(rangeHigh, rangeLow) : null;
  const avgDay = days > 0 ? vol / days : null;
  const volMult = avgDay > 0 && volume24h > 0 ? volume24h / avgDay : null;
  const aboveHigh = rangeHigh ? pct(price, rangeHigh) : null;
  const checks = [
    { id: 'history', label: `At least ${cfg.minHistoryDays} days of history`, value: days, ok: days >= cfg.minHistoryDays },
    { id: 'fresh', label: `No earlier pump in ${cfg.lookbackDays} days`, value: base.length ? priorRise : null, ok: base.length > 0 && priorRise < cfg.maxPriorRise },
    { id: 'breakout', label: `First break above its ${cfg.lookbackDays}-day high`, value: aboveHigh, ok: aboveHigh != null && aboveHigh > 0 },
    { id: 'base', label: 'Out of a flat base', value: baseRange, ok: baseRange != null && baseRange <= cfg.maxBaseRange },
    { id: 'volume', label: `Volume at least ${cfg.minVolMult}× a normal day`, value: volMult, ok: volMult != null && volMult >= cfg.minVolMult },
  ];
  return { pass: checks.every((c) => c.ok), checks, rangeHigh, rangeLow, priorRise: base.length ? priorRise : null, baseRange, volMult, days };
}

/** Short reason text for a failed check, for lists and logs. */
export function checkText(c) {
  const f = (v, d = 0) => (v == null ? '–' : v.toFixed(d));
  switch (c.id) {
    case 'history': return c.ok ? `${f(c.value)} days of history` : `Only ${f(c.value, 1)} days of history`;
    case 'fresh': return c.ok ? `Biggest earlier 24h rise +${f(c.value)}%` : `Already pumped +${f(c.value)}% in 24h before`;
    case 'breakout': return c.value == null ? 'No range high' : c.ok ? `+${f(c.value, 1)}% above the range high` : `${f(c.value, 1)}% below its earlier high`;
    case 'base': return c.ok ? `Base range ${f(c.value)}%` : `Choppy base: ${f(c.value)}% range`;
    case 'volume': return c.value == null ? 'Volume unknown' : `Volume ${f(c.value, 1)}× a normal day`;
    default: return c.label;
  }
}

/** Every derived number the tables show. */
export function metrics(sig, now = Date.now()) {
  return {
    riseAtAlert: pct(sig.alertPrice, sig.startPrice), // ≈ threshold
    gain: pct(sig.lastPrice, sig.alertPrice), // now vs alert, can be negative
    peak: pct(sig.peakPrice, sig.alertPrice), // best rise after the alert
    offPeak: sig.peakPrice > 0 ? ((sig.peakPrice - sig.lastPrice) / sig.peakPrice) * 100 : 0,
    timeToPeak: sig.peakT - sig.alertT,
    dip: Math.min(0, pct(sig.dipLow ?? sig.alertPrice, sig.alertPrice)), // ≤ 0
    duration: (sig.closedT ?? now) - sig.alertT,
  };
}

export const atPeak = (sig, limit = AT_PEAK_PCT) => sig.status === 'TRACKING' && metrics(sig).offPeak <= limit;

const WINDOWS = { all: Infinity, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

/**
 * The rows for one view.
 *   view    'active' (tracking signals) or 'log' (every alert in the last 30 days, newest first)
 *   window  'all' | '24h' | '7d' | '30d', by alert time
 *   atPeak  active view only: keep pairs still within AT_PEAK_PCT of their peak
 *   sort    active view only: 'gain' (gain now, default) or 'volume' (24h volume)
 */
export function selectRows(signals, { view = 'active', window = 'all', atPeak: peakOnly = false, sort = 'gain' } = {}, now = Date.now()) {
  const span = WINDOWS[window] ?? Infinity;
  let rows = signals.filter((s) => now - s.alertT <= span && now - s.alertT <= KEEP_DAYS * DAY);
  if (view === 'active') {
    rows = rows.filter((s) => s.status === 'TRACKING');
    if (peakOnly) rows = rows.filter((s) => atPeak(s));
    const key = sort === 'volume' ? (s) => s.volume24h ?? -1 : (s) => metrics(s, now).gain;
    return rows.sort((a, b) => key(b) - key(a));
  }
  return rows.sort((a, b) => b.alertT - a.alertT);
}

/** Header numbers: pairs scanned, active now, alerts in 30 days, best gain of the last 24 hours' alerts. */
export function headerStats(signals, pairs, now = Date.now()) {
  const recent = signals.filter((s) => now - s.alertT <= KEEP_DAYS * DAY);
  const day = recent.filter((s) => now - s.alertT <= DAY);
  const best = day.length ? Math.max(...day.map((s) => metrics(s, now).peak)) : null;
  return {
    pairs,
    active: recent.filter((s) => s.status === 'TRACKING').length,
    alerts30d: recent.length,
    alerts24h: day.length,
    bestGain24h: best,
  };
}

/** Signals a pair has had, newest first. */
export const pairHistory = (signals, symbol) => signals.filter((s) => s.symbol === symbol).sort((a, b) => b.alertT - a.alertT);

/**
 * Whale positioning at the alert price, from a Binance Smart Money summary (smartmoney.summarize output).
 * Context only, as on PumpGlass, where an alert "shows how strong the move is and how whales are positioned".
 * It plays no part in firing.
 *   shortsUnderwater  price is above the whales' average short entry, so their shorts are losing
 *   nearLongEntry     price within 2% of the whales' average long entry
 *   agrees            whales lean long (at least half of whale size)
 */
export function whaleContext(sum, price, now = Date.now()) {
  if (!sum || !(price > 0) || sum.longShare == null) return null;
  const { longQty, shortQty, longEntry, shortEntry, longShare } = sum;
  const longUpnl = longQty > 0 && longEntry > 0 ? (price - longEntry) * longQty : null;
  const shortUpnl = shortQty > 0 && shortEntry > 0 ? (shortEntry - price) * shortQty : null;
  const distLong = longEntry > 0 ? ((price - longEntry) / longEntry) * 100 : null;
  const distShort = shortEntry > 0 ? ((price - shortEntry) / shortEntry) * 100 : null;
  return {
    cohort: sum.cohort,
    longShare,
    longEntry: longEntry ?? null,
    shortEntry: shortEntry ?? null,
    distLong,
    distShort,
    longUpnl,
    shortUpnl,
    shortsUnderwater: shortUpnl != null && shortUpnl < 0,
    nearLongEntry: distLong != null && Math.abs(distLong) <= 2,
    leaning: longShare >= 0.6 ? 'long' : longShare <= 0.4 ? 'short' : 'mixed',
    agrees: longShare >= 0.5,
    updatedAt: sum.t ?? null,
    ageH: sum.t ? (now - sum.t) / 3_600_000 : null,
  };
}

/** Shape check for a signal received from a server: everything the pages read must be a usable number. */
export function validSignal(s) {
  return !!s && typeof s.id === 'string' && /^[A-Z0-9一-鿿]{1,30}USDT$/.test(s.symbol) && (s.status === 'TRACKING' || s.status === 'CLOSED') &&
    ['startPrice', 'alertPrice', 'lastPrice', 'peakPrice', 'alertT', 'lastT', 'peakT'].every((k) => Number.isFinite(s[k]) && s[k] > 0) &&
    (s.breakout == null || (['rangeHigh', 'rangeLow', 'priorRise', 'baseRange', 'volMult', 'days'].every((k) => s.breakout[k] == null || Number.isFinite(s.breakout[k])) &&
      (s.breakout.checks == null || (Array.isArray(s.breakout.checks) && s.breakout.checks.every((c) => c && typeof c.id === 'string' && (c.value == null || Number.isFinite(c.value)))))));
}
