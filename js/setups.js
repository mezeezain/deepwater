// Setups lab: three classic structure setups (Sweep Reclaim, Breakout Retest, Regime Confluence),
// replayed with realistic execution and split by what Binance's top traders were doing at the time.
// Pure functions, shared by the browser and Node.
//
// Bars: [{ t, o, h, l, c, v, takerBuy, whaleLong?, crowdLong?, oi? }] oldest first, closed candles only.
// v and takerBuy may be in coins or USD, as long as both use the same unit.

export const COSTS = {
  taker: 0.05, // % per side, Binance USDⓈ-M regular tier
  maker: 0.02,
  stopSlip: 0.03, // % extra on stop and timeout exits (market orders through a moving book)
  tradeThrough: 0.02, // % a limit entry must be traded through to count as filled (a bare touch often doesn't fill)
};

export const MODELS = {
  sweep: {
    name: 'Sweep reclaim',
    about: 'Wick through the 19-bar low (high), close back inside, buyers (sellers) in control on 1.2× volume.',
    tp1: 0.75, target: 1.5,
  },
  retest: {
    name: 'Breakout retest',
    about: 'Close beyond the 19-bar range and outside the Keltner channel on 1.5× volume; limit order back at the broken level for 8 bars.',
    tp1: 1, target: 2,
  },
  regime: {
    name: 'Regime confluence',
    about: 'SuperTrend (10, 3) flips, Kalman slope agrees, MFI on the right side of 50, takers agree.',
    tp1: 1, target: 2,
  },
};

export const LAB_DEFAULTS = {
  window: 19,
  rvolSweep: 1.2,
  rvolBreak: 1.5,
  takerSweep: 0.53,
  retestBars: 8,
  maxHoldBars: 48,
  whaleGap: 5, // points: whales at least this much more long (short) than the crowd counts as agreeing
  costs: COSTS,
};

// ---------------------------------------------------------------- indicators

export function atr(bars, n) {
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
    if (i < n - 1) {
      prev = (prev ?? 0) + tr;
    } else if (i === n - 1) {
      prev = (prev + tr) / n;
      out[i] = prev;
    } else {
      prev = (prev * (n - 1) + tr) / n; // Wilder
      out[i] = prev;
    }
  }
  return out;
}

export function ema(values, n) {
  const k = 2 / (n + 1);
  const out = [];
  let e = null;
  for (const v of values) {
    e = e == null ? v : e + k * (v - e);
    out.push(e);
  }
  return out;
}

/** SuperTrend on closed candles: { line, dir } with dir 1 (up) or -1 (down). */
export function superTrend(bars, n = 10, mult = 3) {
  const a = atr(bars, n);
  const line = new Array(bars.length).fill(null);
  const dir = new Array(bars.length).fill(null);
  let upper = null;
  let lower = null;
  let d = 1;
  for (let i = 0; i < bars.length; i++) {
    if (a[i] == null) continue;
    const b = bars[i];
    const mid = (b.h + b.l) / 2;
    const bu = mid + mult * a[i];
    const bl = mid - mult * a[i];
    const pc = bars[i - 1].c;
    upper = upper == null || bu < upper || pc > upper ? bu : upper;
    lower = lower == null || bl > lower || pc < lower ? bl : lower;
    if (d === 1 && b.c < lower) d = -1;
    else if (d === -1 && b.c > upper) d = 1;
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
  }
  return { line, dir };
}

/** One-dimensional Kalman filter on closes; returns the change in the filtered level per bar. */
export function kalmanSlope(bars, q = 0.01, r = 0.1) {
  let x = bars[0]?.c ?? 0;
  let p = 1;
  const out = [0];
  for (let i = 1; i < bars.length; i++) {
    const pm = p + q;
    const k = pm / (pm + r);
    const nx = x + k * (bars[i].c - x);
    p = (1 - k) * pm;
    out.push(nx - x);
    x = nx;
  }
  return out;
}

/** Money Flow Index. v is used as the flow weight, so quote or base volume both work. */
export function mfi(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  const tp = bars.map((b) => (b.h + b.l + b.c) / 3);
  for (let i = n; i < bars.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const f = tp[j] * bars[j].v;
      if (tp[j] > tp[j - 1]) pos += f;
      else if (tp[j] < tp[j - 1]) neg += f;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

// ---------------------------------------------------------------- setups

const rvolAt = (bars, i, n = 20) => {
  if (i < n) return null;
  let s = 0;
  for (let j = i - n; j < i; j++) s += bars[j].v;
  return s > 0 ? bars[i].v / (s / n) : null;
};
const buyShare = (b) => (b.v > 0 && b.takerBuy != null ? b.takerBuy / b.v : null);

/**
 * Setups that complete on bar i's close. Each: { model, side, i, t, entryType, level?, stop?, stopAtr? }.
 * Market entries fill at the next bar's open; the retest waits for a limit fill at `level`.
 */
export function findSetups(bars, cfg = LAB_DEFAULTS) {
  const W = cfg.window;
  const a14 = atr(bars, 14);
  const a10 = atr(bars, 10);
  const e20 = ema(bars.map((b) => b.c), 20);
  const st = superTrend(bars, 10, 3);
  const ks = kalmanSlope(bars);
  const mf = mfi(bars, 14);
  const out = [];
  for (let i = Math.max(W, 20); i < bars.length; i++) {
    const b = bars[i];
    if (a14[i] == null) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i - W; j < i; j++) {
      if (bars[j].l < lo) lo = bars[j].l;
      if (bars[j].h > hi) hi = bars[j].h;
    }
    const rv = rvolAt(bars, i);
    const tb = buyShare(b);
    const base = { i, t: b.t, rvol: rv, takerBuy: tb };

    // Sweep reclaim
    if (rv != null && tb != null && rv >= cfg.rvolSweep) {
      if (b.l < lo && b.c > lo && tb >= cfg.takerSweep) out.push({ ...base, model: 'sweep', side: 1, entryType: 'market', stop: b.l - 0.5 * a14[i] });
      else if (b.h > hi && b.c < hi && tb <= 1 - cfg.takerSweep) out.push({ ...base, model: 'sweep', side: -1, entryType: 'market', stop: b.h + 0.5 * a14[i] });
    }

    // Breakout retest
    if (rv != null && rv >= cfg.rvolBreak && a10[i] != null) {
      if (b.c > hi && b.c > e20[i] + 2 * a10[i]) out.push({ ...base, model: 'retest', side: 1, entryType: 'limit', level: hi, stopAtr: 1.5 * a14[i] });
      else if (b.c < lo && b.c < e20[i] - 2 * a10[i]) out.push({ ...base, model: 'retest', side: -1, entryType: 'limit', level: lo, stopAtr: 1.5 * a14[i] });
    }

    // Regime confluence: on the SuperTrend flip only, so one trend gives one setup.
    if (st.dir[i] != null && st.dir[i - 1] != null && st.dir[i] !== st.dir[i - 1] && mf[i] != null && tb != null) {
      const d = st.dir[i];
      if (d === 1 && ks[i] > 0 && mf[i] > 50 && tb > 0.5) out.push({ ...base, model: 'regime', side: 1, entryType: 'market', stop: st.line[i] });
      else if (d === -1 && ks[i] < 0 && mf[i] < 50 && tb < 0.5) out.push({ ...base, model: 'regime', side: -1, entryType: 'market', stop: st.line[i] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- execution

/**
 * Plays one setup forward. Two ledgers:
 *  paper     — what a signal dashboard badges: "win" if TP1 is touched before the stop, no costs.
 *  realistic — half off at TP1 (limit, maker), stop to entry on the rest, rest at the final target
 *              (maker) or stop/timeout (taker + slippage). Entry: market = next open + taker;
 *              retest limit = maker, only when price trades through the level. A candle that touches
 *              both the stop and a target counts as stopped. Funding paid or received while open.
 * Returns null when the setup never became a trade (limit not filled, no room, end of data).
 */
export function simulate(bars, setup, cfg = LAB_DEFAULTS, funding = []) {
  const m = MODELS[setup.model];
  const C = cfg.costs;
  const side = setup.side;
  let k = setup.i + 1;
  if (k >= bars.length) return null;
  let entry;
  let stop;
  let entryFee;
  if (setup.entryType === 'market') {
    entry = bars[k].o;
    stop = setup.stop;
    entryFee = C.taker;
  } else {
    const through = setup.level * (1 - side * C.tradeThrough / 100);
    const last = Math.min(bars.length - 1, setup.i + cfg.retestBars);
    for (; k <= last; k++) if (side === 1 ? bars[k].l <= through : bars[k].h >= through) break;
    if (k > last) return setup.i + cfg.retestBars > bars.length - 1 ? null : { ...setup, filled: false };
    entry = setup.level;
    stop = entry - side * setup.stopAtr;
    entryFee = C.maker;
  }
  const risk = (entry - stop) * side;
  if (!(risk > 0)) return null; // gapped past the stop before entry
  const riskPct = (risk / entry) * 100;
  const tp1 = entry + side * m.tp1 * risk;
  const tgt = entry + side * m.target * risk;
  const hitUp = (b, p) => (side === 1 ? b.h >= p : b.l <= p);
  const hitDown = (b, p) => (side === 1 ? b.l <= p : b.h >= p);

  let paper = null; // 'win' | 'loss'
  let half = false; // TP1 taken
  let curStop = stop;
  let exitPx = null;
  let exitKind = null;
  let j = k;
  const lastBar = Math.min(bars.length - 1, k + cfg.maxHoldBars);
  // On a limit fill, the fill candle may already have reached the stop: count it as stopped.
  for (; j <= lastBar; j++) {
    const b = bars[j];
    if (hitDown(b, curStop)) {
      if (paper == null) paper = 'loss';
      exitPx = curStop;
      exitKind = half ? 'breakeven' : 'stop';
      break;
    }
    if (j === k && setup.entryType === 'limit') {
      // Price came back to the level on this candle; only count targets from the next one.
      continue;
    }
    if (!half && hitUp(b, tp1)) {
      paper = 'win';
      half = true;
      if (hitUp(b, tgt)) {
        exitPx = tgt;
        exitKind = 'target';
        break;
      }
      curStop = entry; // breakeven from the next candle
      continue;
    }
    if (half && hitUp(b, tgt)) {
      exitPx = tgt;
      exitKind = 'target';
      break;
    }
  }
  if (exitPx == null) {
    if (j > lastBar && lastBar === k + cfg.maxHoldBars) {
      exitPx = bars[lastBar].c;
      exitKind = 'timeout';
      j = lastBar;
    } else return null; // still open at the end of the data
  }
  if (paper == null) paper = 'loss'; // timed out without touching TP1

  // Realised % move on the position, per leg.
  const move = (px) => ((px - entry) / entry) * 100 * side;
  const exitCost = (kind) => (kind === 'target' ? C.maker : C.taker + C.stopSlip);
  let gross;
  let fees;
  if (half) {
    const restKind = exitKind;
    gross = 0.5 * move(tp1) + 0.5 * move(exitPx);
    fees = entryFee + 0.5 * C.maker + 0.5 * exitCost(restKind);
  } else {
    gross = move(exitPx);
    fees = entryFee + exitCost(exitKind);
  }
  const t0 = bars[k].t;
  const t1 = bars[j].t;
  let fund = 0;
  for (const f of funding) if (f.t > t0 && f.t <= t1) fund -= side * f.rate * 100; // longs pay positive funding
  const net = gross - fees + fund;
  return {
    ...setup,
    filled: true,
    entryT: t0,
    exitT: t1,
    entry,
    stop,
    riskPct,
    paper,
    exitKind,
    tookTp1: half,
    grossPct: gross,
    feePct: fees,
    fundingPct: fund,
    netPct: net,
    netR: net / riskPct,
    feeR: fees / riskPct,
  };
}

// ---------------------------------------------------------------- whale context

/**
 * What Binance's top traders were doing when the setup completed (no look-ahead: bar i's snapshot is
 * taken at its close). gap = top-trader long share minus all-accounts long share, in points, signed
 * for the trade's side: positive means whales lean the trade's way more than the crowd does.
 */
export function whaleTag(bars, i, side, cfg = LAB_DEFAULTS) {
  const b = bars[i];
  if (b.whaleLong == null || b.crowdLong == null) return { whale: 'none', gap: null, trend: null };
  const gap = (b.whaleLong - b.crowdLong) * 100 * side;
  const back = bars[Math.max(0, i - 6)];
  const trend = back.whaleLong != null ? (b.whaleLong - back.whaleLong) * 100 * side : null;
  const whale = gap >= cfg.whaleGap ? 'with' : gap <= -cfg.whaleGap ? 'against' : 'neutral';
  return { whale, gap, trend };
}

// ---------------------------------------------------------------- stats

export function summarizeTrades(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter((x) => x.netPct > 0);
  const gp = wins.reduce((s, x) => s + x.netR, 0);
  const gl = -trades.filter((x) => x.netPct <= 0).reduce((s, x) => s + x.netR, 0);
  const rs = trades.map((x) => x.netR);
  const mean = rs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  return {
    n,
    paperWin: trades.filter((x) => x.paper === 'win').length / n,
    netWin: wins.length / n,
    fullTarget: trades.filter((x) => x.exitKind === 'target').length / n,
    pf: gl > 0 ? gp / gl : null,
    expR: mean,
    // Rough 95% range for the average: with few trades it is wide, and that is the point.
    expLo: sd != null ? mean - 1.96 * sd / Math.sqrt(n) : null,
    expHi: sd != null ? mean + 1.96 * sd / Math.sqrt(n) : null,
    feeR: trades.reduce((s, x) => s + x.feeR, 0) / n,
    avgRiskPct: trades.reduce((s, x) => s + x.riskPct, 0) / n,
  };
}

/** Full run over one pair: setups → trades (with whale tags) → stats by model and by whale context. */
export function runLab(bars, cfg = LAB_DEFAULTS, funding = []) {
  const setups = findSetups(bars, cfg);
  const trades = [];
  let unfilled = 0;
  const busyUntil = { sweep: -1, retest: -1, regime: -1 };
  for (const s of setups) {
    if (s.i <= busyUntil[s.model]) continue; // one position per model at a time
    const tr = simulate(bars, s, cfg, funding);
    if (!tr) continue;
    if (!tr.filled) {
      unfilled++;
      continue;
    }
    busyUntil[s.model] = bars.findIndex((b) => b.t === tr.exitT);
    trades.push({ ...tr, ...whaleTag(bars, s.i, s.side, cfg) });
  }
  return { trades, unfilled, open: openSetups(bars, setups, cfg) };
}

/** Setups from the last few candles that may still be actionable. */
function openSetups(bars, setups, cfg) {
  const last = bars.length - 1;
  return setups
    .filter((s) => last - s.i < (s.entryType === 'limit' ? cfg.retestBars : 2))
    .map((s) => ({ ...s, ...whaleTag(bars, s.i, s.side, cfg) }));
}

export function breakdown(trades) {
  const by = (fn) => {
    const groups = new Map();
    for (const t of trades) {
      const k = fn(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    return groups;
  };
  const models = {};
  for (const [k, list] of by((t) => t.model)) models[k] = summarizeTrades(list);
  const whales = {};
  for (const [k, list] of by((t) => t.whale)) whales[k] = summarizeTrades(list);
  const modelWhale = {};
  for (const [k, list] of by((t) => `${t.model}:${t.whale}`)) modelWhale[k] = summarizeTrades(list);
  return { all: summarizeTrades(trades), models, whales, modelWhale };
}
