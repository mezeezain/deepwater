// "4H regime + 1H liquidity sweep" (the SOL-150 plan), written out as exact rules so it can be replayed on
// real candles by tools/sol150.mjs. Pure functions on closed 1h candles [{ t, o, h, l, c }].
//
// Regime (4h, built from the 1h candles): close and EMA 20 on the same side of EMA 50, ADX(14) over 20 with
// the matching DI on top, and ATR(14) above ATR(50).
// Trigger (1h, short; long is the mirror): within the last 3 candles price wicked above the latest unbroken
// swing high, near the 4h EMA 20; this candle closed back below that high and below the 1h EMA 20; RSI(14) was
// above 55 and is now falling.
// Order: limit at that close, cancelled if price moves 0.5R away first. Stop 1.2 × ATR(1h) beyond the wick.
// Exit: half at +2R, stop to entry + 0.1R of profit, the rest at +4R.
// Gates: funding (skip longs above +0.03% per 8h, shorts below −0.03%), and BTC moving over 3.5% against the
// trade in the last 4 hours. The plan's "no trading near CPI / FOMC / NFP" rule is not modelled.
import { atr, ema } from './setups.js';
import { adx } from './trend.js';

const HOUR = 3_600_000;

export const SR = {
  emaFast: 20, emaSlow: 50, adxMin: 20, atrFast: 14, atrSlow: 50,
  pivot: 2, swingLookback: 48, sweepBars: 3,
  zone: true, zoneBelow: 0.5, zoneAbove: 1, // the wick must reach within this many 4h ATRs of the 4h EMA 20
  rsiShort: 55, rsiLong: 45,
  stopAtr: 1.2, cancelR: 0.5, fillBars: 3, marketEntry: false,
  tp1: 2, tp2: 4, lockR: 0.1,
  fundingMax: 0.0003, btcMovePct: 3.5,
  maker: 0.0002, taker: 0.0005, slip: 0.0005,
  risk: 0.015,
};

/** Wilder's RSI. */
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i < n) continue;
      gain /= n; loss /= n;
    } else {
      gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n;
    }
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** 4h candles from 1h candles, on the exchange's 0/4/8… UTC grid. Only complete ones (4 hourly candles). */
export function to4h(bars) {
  const out = [];
  let cur = null, n = 0;
  for (const b of bars) {
    const t = Math.floor(b.t / (4 * HOUR)) * 4 * HOUR;
    if (!cur || cur.t !== t) {
      if (cur && n === 4) out.push(cur);
      cur = { t, o: b.o, h: b.h, l: b.l, c: b.c };
      n = 1;
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c;
      n++;
    }
  }
  if (cur && n === 4) out.push(cur);
  return out;
}

/** Per 4h candle: side (1 long regime, -1 short regime, 0 sit out), EMA 20 and ATR. */
export function regime4h(bars4, cfg = SR) {
  const closes = bars4.map((b) => b.c);
  const fast = ema(closes, cfg.emaFast), slow = ema(closes, cfg.emaSlow);
  const a14 = atr(bars4, cfg.atrFast), a50 = atr(bars4, cfg.atrSlow), d = adx(bars4, 14);
  return bars4.map((b, i) => {
    let side = 0;
    if (i >= cfg.emaSlow && a50[i] != null && d.adx[i] != null && d.adx[i] > cfg.adxMin && a14[i] > a50[i]) {
      if (b.c > slow[i] && fast[i] > slow[i] && d.plus[i] > d.minus[i]) side = 1;
      else if (b.c < slow[i] && fast[i] < slow[i] && d.minus[i] > d.plus[i]) side = -1;
    }
    return { t: b.t, side, ema20: fast[i], atr: a14[i] };
  });
}

/** For each 1h candle, the index of the last 4h candle that had closed by that candle's close (or -1). */
export function last4hIndex(bars, bars4) {
  const out = new Array(bars.length).fill(-1);
  let j = -1;
  for (let i = 0; i < bars.length; i++) {
    while (j + 1 < bars4.length && bars4[j + 1].t + 4 * HOUR <= bars[i].t + HOUR) j++;
    out[i] = j;
  }
  return out;
}

/**
 * The latest swing extreme before candle `from` that price has not gone through since. side 1 looks for swing
 * lows (to be swept by a long setup), -1 for swing highs. A swing has `k` lower highs (higher lows) each side.
 */
export function unbrokenSwing(bars, from, side, cfg = SR) {
  const k = cfg.pivot;
  let extreme = side < 0 ? -Infinity : Infinity; // the most extreme price seen between the candidate and `from`
  for (let j = from - 1; j >= Math.max(k, from - cfg.swingLookback); j--) {
    const v = side < 0 ? bars[j].h : bars[j].l;
    if (j + k < from) {
      let pivot = true;
      for (let m = 1; m <= k && pivot; m++) {
        if (side < 0 ? bars[j - m].h >= v || bars[j + m].h >= v : bars[j - m].l <= v || bars[j + m].l <= v) pivot = false;
      }
      if (pivot && (side < 0 ? v > extreme : v < extreme)) return { index: j, price: v };
    }
    extreme = side < 0 ? Math.max(extreme, v) : Math.min(extreme, v);
  }
  return null;
}

/**
 * Every candle on which the trigger fires. ctx: { funding: (t) => rate or null, btcMove: (t) => % over the last
 * 4 hours or null, funnel: optional object that receives how many candles passed each step }.
 * Returns [{ i, t, side, entry, stop, r (stop distance), wick }].
 */
export function signals(bars, cfg = SR, ctx = {}) {
  const closes = bars.map((b) => b.c);
  const e20 = ema(closes, cfg.emaFast), a1 = atr(bars, 14), rs = rsi(closes, 14);
  const bars4 = to4h(bars), reg = regime4h(bars4, cfg), map = last4hIndex(bars, bars4);
  const out = [];
  const step = (name) => { if (ctx.funnel) ctx.funnel[name] = (ctx.funnel[name] ?? 0) + 1; };
  for (let i = Math.max(cfg.swingLookback, 60); i < bars.length; i++) {
    const g = map[i] >= 0 ? reg[map[i]] : null;
    if (!g || !g.side || a1[i] == null || rs[i] == null || rs[i - 1] == null || rs[i - 2] == null) continue;
    step('regime');
    const side = g.side, b = bars[i];
    const first = i - cfg.sweepBars + 1;
    const swing = unbrokenSwing(bars, first, side, cfg); // shorts sweep a swing high, longs a swing low
    if (!swing) continue;
    let wick = side < 0 ? -Infinity : Infinity;
    for (let m = first; m <= i; m++) wick = side < 0 ? Math.max(wick, bars[m].h) : Math.min(wick, bars[m].l);
    if (side < 0 ? !(wick > swing.price) : !(wick < swing.price)) continue;
    step('swept');
    if (side < 0 ? !(b.c < swing.price) : !(b.c > swing.price)) continue;
    step('closedBack');
    if (side < 0 ? !(b.c < e20[i]) : !(b.c > e20[i])) continue;
    step('ema');
    if (side < 0 ? !(Math.max(rs[i - 1], rs[i - 2]) > cfg.rsiShort && rs[i] < rs[i - 1]) : !(Math.min(rs[i - 1], rs[i - 2]) < cfg.rsiLong && rs[i] > rs[i - 1])) continue;
    step('rsi');
    if (cfg.zone && (side < 0
      ? !(wick >= g.ema20 - cfg.zoneBelow * g.atr && wick <= g.ema20 + cfg.zoneAbove * g.atr)
      : !(wick <= g.ema20 + cfg.zoneBelow * g.atr && wick >= g.ema20 - cfg.zoneAbove * g.atr))) continue;
    step('zone');
    const f = ctx.funding?.(b.t + HOUR);
    if (f != null && (side > 0 ? f > cfg.fundingMax : f < -cfg.fundingMax)) continue;
    const m = ctx.btcMove?.(b.t + HOUR);
    if (m != null && m * side < -cfg.btcMovePct) continue;
    const stop = wick - side * cfg.stopAtr * a1[i];
    const r = (b.c - stop) * side;
    if (!(r > 0)) continue;
    step('signal');
    out.push({ i, t: b.t, side, entry: b.c, stop, r, wick });
  }
  return out;
}

/**
 * Walk one trade from the candle after `from` (the fill candle). Stop first when a candle touches both stop and
 * target. Returns { exit: 'full' | 'partial' | 'stop' | 'open', gross (R), cost (R), r (net R), end (index) }.
 * fundingBetween(t0, t1) returns the summed funding rate paid by a long over that time (optional).
 */
export function runTrade(bars, from, sig, cfg = SR, fundingBetween = null) {
  const { side, entry, stop, r: dist } = sig;
  const feeR = (rate, px, part) => (rate * px * part) / dist;
  const tp1 = entry + side * cfg.tp1 * dist, tp2 = entry + side * cfg.tp2 * dist, lock = entry + side * cfg.lockR * dist;
  // beyond = 1: a level in the trade's favour (targets); -1: a level against it (stops).
  const hit = (b, px, beyond) => (beyond * side > 0 ? b.h >= px : b.l <= px);
  let cost = feeR(cfg.marketEntry ? cfg.taker + cfg.slip : cfg.maker, entry, 1);
  let gross = 0, half = false;
  const fund = (i0, i1, part) => (fundingBetween ? (side * fundingBetween(bars[i0].t, bars[i1].t + HOUR) * entry * part) / dist : 0);
  let seg = from; // start of the current funding segment
  // The fill candle itself can only hurt: if it also reached the stop, count the stop.
  if (hit(bars[from], stop, -1)) return { exit: 'stop', gross: -1, cost: cost + feeR(cfg.taker + cfg.slip, stop, 1), r: -1 - cost - feeR(cfg.taker + cfg.slip, stop, 1), end: from };
  for (let k = from + 1; k < bars.length; k++) {
    const b = bars[k];
    if (!half) {
      if (hit(b, stop, -1)) {
        cost += feeR(cfg.taker + cfg.slip, stop, 1) + fund(seg, k, 1);
        return { exit: 'stop', gross: -1, cost, r: -1 - cost, end: k };
      }
      if (hit(b, tp1, 1)) {
        half = true;
        gross += 0.5 * cfg.tp1;
        cost += feeR(cfg.maker, tp1, 0.5) + fund(seg, k, 1);
        seg = k;
        if (hit(b, tp2, 1)) {
          gross += 0.5 * cfg.tp2;
          cost += feeR(cfg.maker, tp2, 0.5);
          return { exit: 'full', gross, cost, r: gross - cost, end: k };
        }
      }
      continue;
    }
    if (hit(b, lock, -1)) {
      gross += 0.5 * cfg.lockR;
      cost += feeR(cfg.taker + cfg.slip, lock, 0.5) + fund(seg, k, 0.5);
      return { exit: 'partial', gross, cost, r: gross - cost, end: k };
    }
    if (hit(b, tp2, 1)) {
      gross += 0.5 * cfg.tp2;
      cost += feeR(cfg.maker, tp2, 0.5) + fund(seg, k, 0.5);
      return { exit: 'full', gross, cost, r: gross - cost, end: k };
    }
  }
  return { exit: 'open', gross, cost, r: gross - cost, end: bars.length - 1 };
}

/**
 * Trade the signals one position at a time. A limit order rests at the signal's close for up to `fillBars`
 * candles: it fills when price trades through it, and is cancelled if price moves `cancelR` away without doing
 * so. With cfg.marketEntry the order fills at the next open instead.
 * Returns { trades, signals, unfilled, skippedBusy }.
 */
export function simulate(bars, sigs, cfg = SR, fundingBetween = null) {
  const trades = [];
  let busyUntil = -1, unfilled = 0, skippedBusy = 0;
  for (const s of sigs) {
    if (s.i <= busyUntil) { skippedBusy++; continue; }
    let fill = -1, sig = s;
    if (cfg.marketEntry) {
      if (s.i + 1 >= bars.length) continue;
      const entry = bars[s.i + 1].o, r = (entry - s.stop) * s.side;
      if (!(r > 0)) { unfilled++; continue; }
      sig = { ...s, entry, r };
      fill = s.i + 1;
    } else {
      const away = s.entry + s.side * cfg.cancelR * s.r;
      for (let k = s.i + 1; k <= Math.min(s.i + cfg.fillBars, bars.length - 1); k++) {
        const b = bars[k];
        const ranAway = s.side > 0 ? b.h >= away : b.l <= away;
        const traded = s.side > 0 ? b.l < s.entry : b.h > s.entry; // price went through the resting order
        if (traded) { fill = k; break; }
        if (ranAway) break;
      }
    }
    if (fill < 0) { unfilled++; continue; }
    const res = runTrade(bars, fill, sig, cfg, fundingBetween);
    if (res.exit === 'open') { busyUntil = bars.length; continue; }
    trades.push({ t: bars[fill].t, side: sig.side, entry: sig.entry, stop: sig.stop, stopPct: (sig.r / sig.entry) * 100, bars: res.end - fill, exit: res.exit, gross: res.gross, cost: res.cost, r: res.r });
    busyUntil = res.end;
  }
  return { trades, signals: sigs.length, unfilled, skippedBusy };
}

/** Summary of a list of trades: shares by outcome, net R per trade with its noise range, streaks, and $ growth. */
export function tradeSummary(trades, cfg = SR, start = 150) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const share = (x) => trades.filter((t) => t.exit === x).length / n;
  const rs = trades.map((t) => t.r);
  const mean = rs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const wins = rs.filter((x) => x > 0).reduce((s, x) => s + x, 0), losses = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  let eq = start, peak = start, dd = 0, streak = 0, worst = 0;
  for (const t of trades) {
    eq *= 1 + cfg.risk * t.r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, 1 - eq / peak);
    streak = t.r <= 0 ? streak + 1 : 0;
    worst = Math.max(worst, streak);
  }
  return {
    n, full: share('full'), partial: share('partial'), stop: share('stop'),
    expR: mean, noise: (2 * sd) / Math.sqrt(n), totalR: mean * n, costR: trades.reduce((s, t) => s + t.cost, 0) / n,
    profitFactor: losses > 0 ? wins / losses : null, equity: eq, maxDrawdown: dd, losingStreak: worst,
    avgStopPct: trades.reduce((s, t) => s + t.stopPct, 0) / n,
  };
}
