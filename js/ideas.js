// Live setups: turns the Setups lab engine into current trade plans with exact levels, an evidence
// checklist and the historical record of comparable trades. Pure functions, shared by browser and Node.
import { MODELS, LAB_DEFAULTS, COSTS, findSetups, whaleTag, superTrend, summarizeTrades } from './setups.js';

export const HIGHER = { '15m': '1h', '1h': '4h', '4h': '4h' };
const MARKET_VALID_BARS = 2; // a market setup is actionable on the candle after the signal, and one more at most

/**
 * Setups from the latest candles that are still actionable, with their state:
 *  enter   — signal on the last closed candle: enter at market now
 *  limit   — retest order waiting at the level (until `expiresT`)
 *  running — entered, neither the stop nor the final target reached yet (`tp1Taken`: stop now at entry)
 * Stopped and completed setups are dropped.
 */
export function activeIdeas(bars, cfg = LAB_DEFAULTS, ms = 3_600_000) {
  const last = bars.length - 1;
  const out = [];
  for (const s of findSetups(bars, cfg)) {
    const age = last - s.i;
    if (age >= (s.entryType === 'limit' ? cfg.retestBars : MARKET_VALID_BARS)) continue;
    const m = MODELS[s.model];
    const side = s.side;
    let entry;
    let stop;
    let filledAt = null;
    if (s.entryType === 'market') {
      entry = age === 0 ? bars[last].c : bars[s.i + 1].o;
      stop = s.stop;
      filledAt = age === 0 ? null : s.i + 1;
    } else {
      entry = s.level;
      stop = s.level - side * s.stopAtr;
      const through = s.level * (1 - side * cfg.costs.tradeThrough / 100);
      for (let k = s.i + 1; k <= last; k++) {
        if (side === 1 ? bars[k].l <= through : bars[k].h >= through) {
          filledAt = k;
          break;
        }
      }
    }
    const risk = (entry - stop) * side;
    if (!(risk > 0)) continue;
    const lv = (r) => entry + side * r * risk;
    const idea = {
      ...s,
      entry,
      stop,
      tp1: lv(m.tp1),
      tp2: lv(m.target),
      tp3: s.model === 'sweep' ? lv(2.5) : null,
      riskPct: (risk / entry) * 100,
      signalT: bars[s.i].t,
      tp1Taken: false,
    };
    if (filledAt == null) {
      idea.state = s.entryType === 'limit' ? 'limit' : 'enter';
      if (s.entryType === 'limit') idea.expiresT = bars[s.i].t + (cfg.retestBars + 1) * ms;
      out.push(idea);
      continue;
    }
    // Walk the candles since entry: drop it if stopped or done.
    let curStop = stop;
    let over = false;
    for (let k = filledAt; k <= last; k++) {
      const b = bars[k];
      if (side === 1 ? b.l <= curStop : b.h >= curStop) {
        over = true;
        break;
      }
      if (k === filledAt && s.entryType === 'limit') continue;
      if (side === 1 ? b.h >= idea.tp2 : b.l <= idea.tp2) {
        over = true;
        break;
      }
      if (!idea.tp1Taken && (side === 1 ? b.h >= idea.tp1 : b.l <= idea.tp1)) {
        idea.tp1Taken = true;
        curStop = entry;
      }
    }
    if (over) continue;
    idea.state = 'running';
    idea.enteredT = bars[filledAt].t;
    idea.curStop = curStop;
    out.push(idea);
  }
  return out;
}

/**
 * Evidence for one idea. Each check: { id, label, state: 'good' | 'bad' | 'neutral', detail }.
 * ctx: { bars, trades (this pair+timeframe, from runLab), pooled (same timeframe, all loaded pairs), higherBars, smart (Smart Money summary or null), funding }
 */
export function evidence(idea, ctx, cfg = LAB_DEFAULTS) {
  const side = idea.side;
  const way = side > 0 ? 'long' : 'short';
  const checks = [];

  // 1. Track record of this setup and side on this timeframe after costs, pooled across the loaded pairs
  // (one pair alone rarely has enough trades), with this pair's own figure alongside.
  const mine = (list) => (list ?? []).filter((t) => t.model === idea.model && t.side === side);
  const rec = summarizeTrades(mine(ctx.pooled ?? ctx.trades));
  const here = summarizeTrades(mine(ctx.trades));
  checks.push({
    id: 'record',
    label: 'Setup record after costs',
    state: !rec.n || rec.n < 8 ? 'neutral' : rec.expR > 0 && rec.expLo > -0.05 ? 'good' : rec.expR > 0 ? 'neutral' : 'bad',
    detail: rec.n
      ? `${way}s: ${Math.round(rec.netWin * 100)}% made money, ${fmtR(rec.expR)} per trade over ${rec.n}` + (ctx.pooled && here.n ? ` (this pair: ${fmtR(here.expR)} over ${here.n})` : '')
      : 'no past trades in the loaded history',
    stats: rec,
  });

  // 2. Top 20% accounts vs the crowd at the signal candle
  const w = whaleTag(ctx.bars, idea.i, side, cfg);
  checks.push({
    id: 'whales',
    label: 'Top 20% vs crowd',
    state: w.whale === 'with' ? 'good' : w.whale === 'against' ? 'bad' : 'neutral',
    detail: w.gap == null ? 'no data' : `top traders ${w.gap >= 0 ? 'more' : 'less'} ${way} than the crowd by ${Math.abs(Math.round(w.gap))} pts`,
  });
  checks.push({
    id: 'trend',
    label: 'Top 20% last 6 candles',
    state: w.trend == null || Math.abs(w.trend) < 1 ? 'neutral' : w.trend > 0 ? 'good' : 'bad',
    detail: w.trend == null ? 'no data' : `${w.trend > 0 ? 'adding' : 'cutting'} ${way} exposure (${w.trend > 0 ? '+' : ''}${w.trend.toFixed(1)} pts)`,
  });

  // 3. Exact Smart Money whales (whale data server), when available
  const sm = ctx.smart;
  if (sm?.longShare != null) {
    const share = side > 0 ? sm.longShare : 1 - sm.longShare;
    const otherUpnl = side > 0 ? sm.shortUpnl : sm.longUpnl;
    checks.push({
      id: 'smart',
      label: 'Smart Money whales',
      state: share >= 0.55 ? 'good' : share <= 0.45 ? 'bad' : 'neutral',
      detail: `${Math.round(share * 100)}% of whale size is ${way}` + (otherUpnl != null && otherUpnl < 0 ? `; ${side > 0 ? 'short' : 'long'} whales are losing (squeeze fuel)` : ''),
    });
  } else {
    checks.push({ id: 'smart', label: 'Smart Money whales', state: 'neutral', detail: 'not available for this pair right now' });
  }

  // 4. Higher timeframe trend (SuperTrend on the next timeframe up)
  if (ctx.higherBars?.length) {
    const st = superTrend(ctx.higherBars);
    const d = st.dir.at(-1);
    checks.push({
      id: 'htf',
      label: `${ctx.higherFrame} trend`,
      state: d == null ? 'neutral' : d === side ? 'good' : 'bad',
      detail: d == null ? 'not enough candles' : `SuperTrend ${d > 0 ? 'up' : 'down'}`,
    });
  }

  // 5. Funding: paying to hold a crowded side is a headwind
  const f = ctx.funding?.at(-1)?.rate;
  if (f != null) {
    const paying = f * side; // > 0 when this side pays
    checks.push({
      id: 'funding',
      label: 'Funding',
      state: paying > 0.0003 ? 'bad' : paying < 0 ? 'good' : 'neutral',
      detail: `${(f * 100).toFixed(4)}% per 8h; ${paying > 0 ? `${way}s pay` : `${way}s get paid`}`,
    });
  }

  // 6. Costs relative to the stop: tight stops lose a big slice of each R to fees
  const costR = (COSTS.taker * 2 + COSTS.stopSlip) / idea.riskPct;
  checks.push({
    id: 'costs',
    label: 'Costs vs stop',
    state: costR > 0.15 ? 'bad' : costR < 0.07 ? 'good' : 'neutral',
    detail: `stop ${idea.riskPct.toFixed(2)}% away; a round trip costs about ${costR.toFixed(2)}R`,
  });

  const good = checks.filter((c) => c.state === 'good').length;
  const bad = checks.filter((c) => c.state === 'bad').length;
  const score = good - bad;
  const recordBad = checks[0].state === 'bad';
  const grade = score >= 3 && !recordBad ? 'A' : score >= 1 && !recordBad ? 'B' : 'C';
  return { checks, good, bad, score, grade, whale: w.whale };
}

/** Pooled history of comparable trades: same setup, side and timeframe, same whale lean, across the pairs given. */
export function comparable(idea, whale, tradesAllPairs) {
  const same = tradesAllPairs.filter((t) => t.model === idea.model && t.side === idea.side);
  return {
    all: summarizeTrades(same),
    whale: whale && whale !== 'none' ? summarizeTrades(same.filter((t) => t.whale === whale)) : null,
  };
}

/** Where the next setups would trigger, for pairs with nothing active. */
export function watchLevels(bars, cfg = LAB_DEFAULTS) {
  const W = cfg.window;
  const n = bars.length;
  if (n < W + 1) return null;
  let lo = Infinity;
  let hi = -Infinity;
  // Levels for the next candle: the last W closed candles.
  for (let j = n - W; j < n; j++) {
    lo = Math.min(lo, bars[j].l);
    hi = Math.max(hi, bars[j].h);
  }
  const st = superTrend(bars);
  return { low: lo, high: hi, stLine: st.line.at(-1), stDir: st.dir.at(-1), price: bars.at(-1).c };
}

/** Live check of an idea against the current price: invalid, chasing, or fine. */
export function priceCheck(idea, price) {
  if (price == null) return null;
  const side = idea.side;
  const risk = Math.abs(idea.entry - idea.stop);
  const moved = ((price - idea.entry) * side) / risk; // in R, positive = toward the targets
  const stopNow = idea.curStop ?? idea.stop;
  if ((price - stopNow) * side <= 0) return { moved, state: 'stop', note: 'Price is through the stop' };
  if (idea.state === 'enter' && moved > 0.3) return { moved, state: 'chasing', note: `Already ${moved.toFixed(1)}R past entry: don’t chase` };
  if ((price - idea.tp2) * side >= 0) return { moved, state: 'target', note: 'Final target reached' };
  return { moved, state: 'ok', note: null };
}

function fmtR(v) {
  return v == null || !isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`;
}
