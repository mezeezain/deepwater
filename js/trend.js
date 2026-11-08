// Trend radar: which coins started a trend recently, and where price sits against support and resistance.
// Pure functions on closed candles [{ t, o, h, l, c, v }], shared by the page, the server and tools/trends.mjs.
//
// A fresh trend (long; short is the mirror image), all on the same timeframe:
//   1. Direction   EMA 20 above EMA 50, and the close above EMA 50.
//   2. Structure   a candle has closed above the highest high of the 20 candles before it (a breakout out
//                  of the old range), no earlier than 5 candles before EMA 20 crossed EMA 50.
//   3. Recent      the trend started at most `maxAge` candles ago. Start = the later of the EMA cross and
//                  that breakout close, i.e. the candle by which both had happened.
//   4. Strength    ADX(14) rising over the last 3 candles, with +DI above -DI (and at least `adxMin`; 0 = no
//                  floor, because ADX lags: by the time it passes 20 a trend is usually no longer fresh).
// Support and resistance are swing highs and lows (3 candles either side) from the last 200 candles,
// merged when closer than 0.6 ATR; price within 1 ATR of a level counts as "near" it.
import { atr, ema } from './setups.js';

export const TREND = {
  fast: 20,
  slow: 50,
  adxN: 14,
  adxMin: 0,
  maxAge: 12, // candles since the EMA cross
  breakoutN: 20, // range the trend has to break out of
  extendedAtr: 2.5, // close this many ATRs past EMA 20 = stretched
  pivot: 3,
  levelsLookback: 200,
  mergeAtr: 0.6,
  nearAtr: 1,
};

/** Wilder's ADX with +DI / -DI. */
export function adx(bars, n = 14) {
  const len = bars.length;
  const out = { adx: new Array(len).fill(null), plus: new Array(len).fill(null), minus: new Array(len).fill(null) };
  let tr = 0, pdm = 0, mdm = 0, dxSum = 0, adxPrev = null;
  for (let i = 1; i < len; i++) {
    const b = bars[i], p = bars[i - 1];
    const up = b.h - p.h, down = p.l - b.l;
    const t = Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
    const pd = up > down && up > 0 ? up : 0;
    const md = down > up && down > 0 ? down : 0;
    if (i <= n) {
      tr += t; pdm += pd; mdm += md;
      if (i < n) continue;
    } else {
      tr = tr - tr / n + t; pdm = pdm - pdm / n + pd; mdm = mdm - mdm / n + md;
    }
    const plus = tr > 0 ? (100 * pdm) / tr : 0;
    const minus = tr > 0 ? (100 * mdm) / tr : 0;
    out.plus[i] = plus;
    out.minus[i] = minus;
    const dx = plus + minus > 0 ? (100 * Math.abs(plus - minus)) / (plus + minus) : 0;
    if (i < 2 * n - 1) dxSum += dx;
    else if (i === 2 * n - 1) adxPrev = (dxSum + dx) / n;
    else adxPrev = (adxPrev * (n - 1) + dx) / n;
    if (i >= 2 * n - 1) out.adx[i] = adxPrev;
  }
  return out;
}

/** Everything the rules need, computed once per series. */
export function indicators(bars, cfg = TREND) {
  const closes = bars.map((b) => b.c);
  return { fast: ema(closes, cfg.fast), slow: ema(closes, cfg.slow), atr: atr(bars, 14), dmi: adx(bars, cfg.adxN) };
}

/** Index of the candle where EMA fast last crossed EMA slow, at or before i (or -1). */
function crossIndex(ind, i) {
  const side = Math.sign(ind.fast[i] - ind.slow[i]);
  for (let k = i; k > 0; k--) if (Math.sign(ind.fast[k - 1] - ind.slow[k - 1]) !== side) return k;
  return -1;
}

/**
 * Trend state at candle i, or null when there is no trend that passes the rules (any age).
 * { side, start, age, fresh, startT, startPrice, movePct, adx, extension (ATRs past EMA 20), stretched, volRatio }
 */
export function trendAt(bars, i, cfg = TREND, ind = indicators(bars, cfg)) {
  if (i < cfg.slow + cfg.breakoutN || ind.atr[i] == null || ind.dmi.adx[i] == null || ind.dmi.adx[i - 3] == null) return null;
  const side = Math.sign(ind.fast[i] - ind.slow[i]);
  if (!side) return null;
  const b = bars[i];
  if (side * (b.c - ind.slow[i]) <= 0) return null;
  const a = ind.dmi.adx[i];
  if (!(a >= cfg.adxMin && a > ind.dmi.adx[i - 3])) return null;
  if (side * (ind.dmi.plus[i] - ind.dmi.minus[i]) <= 0) return null;
  const cross = crossIndex(ind, i);
  if (cross < cfg.breakoutN + 5) return null;
  // Structure: the first close beyond the range of the 20 candles before it, from 5 candles before the cross.
  let breakout = -1;
  for (let j = cross - 5; j <= i && breakout < 0; j++) {
    let hi = -Infinity, lo = Infinity;
    for (let k = j - cfg.breakoutN; k < j; k++) {
      hi = Math.max(hi, bars[k].h);
      lo = Math.min(lo, bars[k].l);
    }
    if (side > 0 ? bars[j].c > hi : bars[j].c < lo) breakout = j;
  }
  if (breakout < 0) return null;
  const start = Math.max(cross, breakout);
  const age = i - start;
  let volSince = 0, volBefore = 0;
  for (let k = start; k <= i; k++) volSince += bars[k].v || 0;
  for (let k = Math.max(0, start - 30); k < start; k++) volBefore += bars[k].v || 0;
  const avgBefore = volBefore / Math.min(30, start);
  const extension = (side * (b.c - ind.fast[i])) / ind.atr[i];
  return {
    side,
    start,
    cross,
    breakout,
    age,
    fresh: age <= cfg.maxAge,
    startT: bars[start].t,
    startPrice: bars[start - 1].c, // the close just before the start candle: the move includes it
    movePct: ((b.c - bars[start - 1].c) / bars[start - 1].c) * 100,
    adx: a,
    extension,
    stretched: extension > cfg.extendedAtr,
    volRatio: avgBefore > 0 ? volSince / (age + 1) / avgBefore : null,
  };
}

/** Swing highs and lows with `k` candles either side, between from and to (inclusive; the last k can't confirm). */
export function pivots(bars, from, to, k = 3) {
  const out = [];
  for (let i = Math.max(from, k); i <= to - k; i++) {
    let hi = true, lo = true;
    for (let j = i - k; j <= i + k && (hi || lo); j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) hi = false;
      if (bars[j].l <= bars[i].l) lo = false;
    }
    if (hi) out.push({ i, price: bars[i].h, kind: 'high' });
    if (lo) out.push({ i, price: bars[i].l, kind: 'low' });
  }
  return out;
}

/** Swing levels merged into zones: [{ price, lo, hi, touches, highs, lows, lastI }], price ascending. */
export function levels(bars, i, cfg = TREND, atrNow) {
  const piv = pivots(bars, Math.max(0, i - cfg.levelsLookback), i, cfg.pivot).sort((a, b) => a.price - b.price);
  const gap = cfg.mergeAtr * atrNow;
  const out = [];
  for (const p of piv) {
    const last = out.at(-1);
    if (last && p.price - last.hi <= gap) {
      last.sum += p.price;
      last.touches++;
      last.hi = p.price;
      last.lastI = Math.max(last.lastI, p.i);
      last[p.kind === 'high' ? 'highs' : 'lows']++;
      last.price = last.sum / last.touches;
    } else out.push({ price: p.price, sum: p.price, lo: p.price, hi: p.price, touches: 1, highs: +(p.kind === 'high'), lows: +(p.kind === 'low'), lastI: p.i });
  }
  return out.map(({ sum, ...l }) => l);
}

/**
 * Where price sits at candle i: the nearest support below and resistance above, their distance in % and ATR,
 * and a zone: 'support' or 'resistance' (inside a level's zone, or within nearAtr of the nearest level),
 * 'clear' (room both ways), 'open' (no level ahead in the trend's direction, e.g. above every swing high).
 * A zone made mostly of swing highs is resistance, mostly of swing lows support.
 */
export function location(bars, i, side, cfg = TREND, atrNow) {
  const c = bars[i].c;
  const lv = levels(bars, i, cfg, atrNow);
  const pad = 0.25 * atrNow;
  const inside = lv.find((l) => c >= l.lo - pad && c <= l.hi + pad) ?? null;
  const support = [...lv].reverse().find((l) => l !== inside && l.price < c) ?? null;
  const resistance = lv.find((l) => l !== inside && l.price > c) ?? null;
  const dist = (l) => (l ? { pct: ((l.price - c) / c) * 100, atr: Math.abs(l.price - c) / atrNow } : null);
  const ds = dist(support), dr = dist(resistance);
  let zone;
  // Just above a band = standing on it (support); just below = under it (resistance); within it, by what it is made of.
  if (inside) zone = c > inside.hi ? 'support' : c < inside.lo ? 'resistance' : inside.highs >= inside.lows ? 'resistance' : 'support';
  else if (side > 0 && dr && dr.atr <= cfg.nearAtr) zone = 'resistance';
  else if (side < 0 && ds && ds.atr <= cfg.nearAtr) zone = 'support';
  else if (side > 0 && ds && ds.atr <= cfg.nearAtr) zone = 'support';
  else if (side < 0 && dr && dr.atr <= cfg.nearAtr) zone = 'resistance';
  else zone = (side > 0 ? resistance : support) ? 'clear' : 'open';
  const at = inside && { ...inside, pct: ((inside.price - c) / c) * 100, atr: Math.abs(inside.price - c) / atrNow };
  return {
    support: zone === 'support' && at ? at : support && { ...support, ...ds },
    resistance: zone === 'resistance' && at ? at : resistance && { ...resistance, ...dr },
    zone,
  };
}

/**
 * The radar row for the latest closed candle of one coin, or null if it is not in a fresh trend.
 * `zone` relative to the trend: for an uptrend 'support' means pulled back to a floor (room to run),
 * 'resistance' means pressing into a ceiling.
 */
export function radarRow(bars, cfg = TREND) {
  if (bars.length < cfg.slow + cfg.breakoutN + 5) return null;
  const ind = indicators(bars, cfg);
  const i = bars.length - 1;
  const tr = trendAt(bars, i, cfg, ind);
  if (!tr || !tr.fresh) return null;
  return { ...tr, price: bars[i].c, t: bars[i].t, atr: ind.atr[i], ...location(bars, i, tr.side, cfg, ind.atr[i]) };
}

/**
 * For testing: the first candle of each trend at which all the rules pass and the trend is still fresh,
 * plus its location. One event per trend.
 */
export function trendEvents(bars, cfg = TREND) {
  const ind = indicators(bars, cfg);
  const out = [];
  let lastStart = -1;
  for (let i = cfg.slow + cfg.breakoutN; i < bars.length; i++) {
    const tr = trendAt(bars, i, cfg, ind);
    if (!tr || !tr.fresh || tr.cross === lastStart) continue;
    lastStart = tr.cross;
    out.push({ i, ...tr, atr: ind.atr[i], zone: location(bars, i, tr.side, cfg, ind.atr[i]).zone });
  }
  return { events: out, ind };
}
