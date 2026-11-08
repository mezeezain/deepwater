// Fib pullbacks: coins that pumped recently and are in the FIRST correction of that pump, with the Fibonacci
// retracement levels of the move. Pure functions on closed candles [{ t, o, h, l, c, v }]; shared by the page,
// the server and tools/fib.mjs.
//
// At candle i, looking back `window` candles:
//   High   the highest high of the window, made at least 1 and at most `maxSinceHigh` candles ago.
//   Low    the lowest low in the `maxLeg` candles before that high. Low → high is the pump.
//   Pump   at least `minPump` % from low to high.
//   Clean  on the way up, price never gave back more than `cleanMax` (38.2%) of the move so far, so the pump
//          had no correction of its own: the current pullback is the first one.
//   Now    price has come back at least `minRetrace` (23.6%) of the move, has made no new high since (it is
//          still the first correction, however it zigzags), and has not gone deeper than `maxRetrace` (88.6%):
//          beyond that the pump is considered undone.
// Retracement r = (high − price) / (high − low): 0 at the high, 1 back at the low.

export const FIB = {
  window: 60,
  maxSinceHigh: 30,
  maxLeg: 40,
  minPump: 15,
  cleanMax: 0.382,
  minRetrace: 0.236,
  maxRetrace: 0.886,
  tol: 0.03, // "at a level": within 3% of the move from it
  levels: [0.382, 0.5, 0.618, 0.786],
};

/**
 * The pump and its first correction as seen at the close of candle i (only candles up to i are used), or null.
 * { iL, iH, low, high, pumpPct, legCandles, sinceHigh, r (now), deepest (deepest retracement since the high) }
 */
export function pullbackAt(bars, i, cfg = FIB) {
  if (i < cfg.window) return null;
  let iH = -1;
  for (let k = i - cfg.window + 1; k <= i; k++) if (iH < 0 || bars[k].h > bars[iH].h) iH = k;
  const sinceHigh = i - iH;
  if (sinceHigh < 1 || sinceHigh > cfg.maxSinceHigh) return null;
  let iL = -1;
  for (let k = Math.max(0, iH - cfg.maxLeg); k < iH; k++) if (iL < 0 || bars[k].l < bars[iL].l) iL = k;
  if (iL < 0) return null;
  const low = bars[iL].l, high = bars[iH].h, leg = high - low;
  const pumpPct = (leg / low) * 100;
  if (!(pumpPct >= cfg.minPump)) return null;
  // Clean pump: no pullback deeper than cleanMax of the move so far (ignoring the first 30% of the move,
  // where small wiggles are large fractions of a small leg).
  let run = low;
  for (let k = iL + 1; k < iH; k++) {
    run = Math.max(run, bars[k].h);
    const sofar = run - low;
    if (sofar >= 0.3 * leg && (run - bars[k].l) / sofar > cfg.cleanMax) return null;
  }
  let deepLow = Infinity;
  for (let k = iH + 1; k <= i; k++) deepLow = Math.min(deepLow, bars[k].l);
  const deepest = (high - deepLow) / leg;
  const r = (high - bars[i].c) / leg;
  if (deepest > cfg.maxRetrace) return null;
  return { iL, iH, low, high, pumpPct, legCandles: iH - iL, sinceHigh, r, deepest };
}

export const levelPrice = (p, ratio) => p.high - ratio * (p.high - p.low);

/** The page row for the latest closed candle, or null if the coin is not in a qualifying first pullback. */
export function fibRow(bars, cfg = FIB) {
  const i = bars.length - 1;
  const p = pullbackAt(bars, i, cfg);
  if (!p || p.r < cfg.minRetrace) return null;
  const price = bars[i].c;
  const levels = cfg.levels.map((ratio) => ({ ratio, price: levelPrice(p, ratio), pct: ((levelPrice(p, ratio) - price) / price) * 100 }));
  const nearest = levels.reduce((a, b) => (Math.abs(b.ratio - p.r) < Math.abs(a.ratio - p.r) ? b : a));
  const below = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0] ?? null;
  return {
    ...p,
    price,
    t: bars[i].t,
    highT: bars[p.iH].t,
    lowT: bars[p.iL].t,
    levels,
    atLevel: Math.abs(nearest.ratio - p.r) <= cfg.tol ? nearest.ratio : null,
    nearest: nearest.ratio,
    next: below, // the next level down if the pullback continues
  };
}

/**
 * For testing: each pump's first touch of each retracement ratio in `ratios` during its first correction.
 * The pullback state is taken from the candle before the touch, so nothing from the touching candle is used to
 * decide; entry is at the level price (or the open, if the candle opened below it).
 */
export function fibTouches(bars, ratios, cfg = FIB) {
  const out = [];
  const touched = new Map(); // iH -> Set(ratio)
  for (let i = cfg.window + 1; i < bars.length; i++) {
    const p = pullbackAt(bars, i - 1, cfg);
    if (!p) continue;
    if (bars[i].h > p.high) continue; // new high on this candle: the correction is over
    let done = touched.get(p.iH);
    if (!done) touched.set(p.iH, (done = new Set()));
    for (const ratio of ratios) {
      if (done.has(ratio) || ratio <= p.deepest) continue; // already reached earlier in this correction
      const level = levelPrice(p, ratio);
      if (bars[i].l > level) continue;
      done.add(ratio);
      out.push({ i, ratio, entry: Math.min(level, bars[i].o), iH: p.iH, high: p.high, low: p.low, pumpPct: p.pumpPct });
    }
  }
  return out;
}
