// Offline backtest: replays the pump catcher's exact rules (engine.js) over historical Binance data.
// Pure functions; tools/backtest.mjs downloads the data and writes the report.
//
// Data per pair:
//   minutes: [{ t, o, h, l, c, v, takerBuy }]   1-minute candles (v and takerBuy in USDT), oldest first
//   pos:     Map(slot -> { oi, whaleLong, crowdLong })   5-minute positioning snapshots, keyed by the slot of Binance's timestamp
//   funding: [{ t, rate }]                      optional funding payments, charged to signals held across them
//
// Differences from live scanning, all stated in the report:
//   - positioning is read with a one-slot delay (a snapshot is usable once its 5-minute slot is over), which is safe
//     whether Binance stamps a snapshot with the start or the end of its period;
//   - the open interest gate compares 5-minute snapshots (live uses real-time OI against the same baseline);
//   - alerts fire at a minute's close, not mid-minute;
//   - no Smart Money whale filter (Binance keeps no history of it);
//   - exits are replayed from 1-minute candles, assuming green candles hit their low before their high, and a stop
//     fills at the stop price minus a slippage allowance.
import { DEFAULTS, screen, orderFlow, confirm, createSignal, replayCandles, inCooldown, stats, configId } from './engine.js';
import { bootstrapMean, quantile } from './stats.js';

const MIN = 60_000;
const SLOT = 5 * MIN;
const DAY = 1440;

/** Rolling 24h low and high for each minute (monotonic deques, O(n)). */
export function rolling24h(minutes) {
  const lows = new Array(minutes.length);
  const highs = new Array(minutes.length);
  const qLow = [];
  const qHigh = [];
  for (let i = 0; i < minutes.length; i++) {
    while (qLow.length && minutes[qLow.at(-1)].l >= minutes[i].l) qLow.pop();
    qLow.push(i);
    while (qHigh.length && minutes[qHigh.at(-1)].h <= minutes[i].h) qHigh.pop();
    qHigh.push(i);
    while (qLow[0] <= i - DAY) qLow.shift();
    while (qHigh[0] <= i - DAY) qHigh.shift();
    lows[i] = minutes[qLow[0]].l;
    highs[i] = minutes[qHigh[0]].h;
  }
  return { lows, highs };
}

/**
 * The positioning the live scanner could have seen at time t: the newest snapshot whose slot is already over
 * (one slot of delay, so a snapshot is never used while its own 5 minutes are still running), and the baseline
 * snapshot nearest to t − 15 minutes by timestamp, the same rule the live scanner uses.
 */
export function positioningAt(pos, t) {
  const newest = Math.floor(t / SLOT) * SLOT - SLOT;
  let now = null;
  let nowSlot = null;
  for (let back = 0; back < 3 && !now; back++) {
    nowSlot = newest - back * SLOT;
    now = pos.get(nowSlot) ?? null;
  }
  if (!now) return { now: null, before: null };
  const target = Math.round((t - 15 * MIN) / SLOT) * SLOT;
  let before = null;
  for (const d of [0, -1, 1]) {
    const slot = target + d * SLOT;
    if (slot < nowSlot && pos.has(slot)) {
      before = pos.get(slot);
      break;
    }
  }
  return { now, before };
}

/**
 * Candidate minutes for one pair: everything the gates need, computed once and reused for every rule set.
 * Only minutes that could pass for at least one rule set are kept. The floors must be the lowest values any rule set
 * (the defaults included) uses: a higher impulse floor would quietly test a stricter rule than the one running live.
 */
export function candidates(minutes, pos, { minRiseFloor = DEFAULTS.minRise, minImpulseFloor = DEFAULTS.minImpulse } = {}) {
  const { lows, highs } = rolling24h(minutes);
  const out = [];
  for (let i = DAY; i < minutes.length; i++) {
    const m = minutes[i];
    const ticker = { price: m.c, low24h: lows[i], high24h: highs[i] };
    const sc = screen(ticker, minutes[i - 5].c, { ...DEFAULTS, minRise: minRiseFloor, maxRise: 100, minImpulse: minImpulseFloor, maxBelowHigh: 100, requireCrossing: false });
    if (!sc.pass) continue;
    const flow = orderFlow(minutes.slice(i - 34, i + 1));
    const { now, before } = positioningAt(pos, m.t);
    out.push({
      i,
      t: m.t + MIN, // the minute's close
      ticker,
      impulse: sc.impulse,
      ctx: {
        ...flow,
        oiChange: now?.oi && before?.oi ? ((now.oi - before.oi) / before.oi) * 100 : null,
        whaleLong: now?.whaleLong ?? null,
        crowdLong: now?.crowdLong ?? null,
      },
    });
  }
  return out;
}

/** Replay one rule set over one pair's candidates; returns its signals (each tracked to an exit or to the data's end). */
export function replayPair(symbol, minutes, cands, cfg, funding = null) {
  const signals = [];
  const candles = minutes.map((m) => ({ t: m.t, o: m.o, h: m.h, l: m.l, c: m.c }));
  for (const c of cands) {
    const sc = screen(c.ticker, minutes[c.i - 5].c, cfg);
    if (!sc.pass) continue;
    if (inCooldown(symbol, signals, c.t, cfg)) continue;
    const res = confirm(c.ctx, cfg);
    if (!res.pass) continue;
    const sig = createSignal({ symbol, price: c.ticker.price, t: c.t, rise: sc.rise, impulse: sc.impulse, ctx: c.ctx, gap: res.gap, cfg, belowHigh: sc.belowHigh });
    replayCandles(sig, candles.slice(c.i + 1), cfg);
    if (funding?.length) sig.fundingPct = fundingPaid(sig, funding);
    signals.push(sig);
  }
  return signals;
}

/**
 * Funding paid by a long held from alertT to closedT, % of position (negative when longs were paid).
 * rows: [{ t, rate }]. A signal still open is charged up to its last tracked time.
 */
export function fundingPaid(sig, rows) {
  const end = sig.closedT ?? sig.lastT;
  let sum = 0;
  for (const r of rows) if (r.t > sig.alertT && r.t <= end) sum += r.rate;
  return sum * 100;
}

/**
 * Stats for signals alerted inside [from, to). Signals alerted too close to `dataEnd` to have had their full tracking
 * window (maxTrackHours) are left out and counted as `unresolved`: counting only those that happened to close early
 * would favour fast exits (stops and quick trails) over the slower winners.
 */
export function periodStats(signals, from, to, costPct, dataEnd = Infinity, holdMs = 72 * 3_600_000) {
  const cutoff = dataEnd - holdMs;
  const inPeriod = signals.filter((s) => s.alertT >= from && s.alertT < to);
  const resolved = inPeriod.filter((s) => s.alertT <= cutoff);
  const st = stats(resolved, { costPct });
  return {
    signals: resolved.length,
    unresolved: inPeriod.length - resolved.length,
    closed: st.closed,
    winRate: st.winRate,
    winRateCI: st.winRateCI,
    avgWin: st.avgWin,
    avgLoss: st.avgLoss,
    expectancy: st.expectancy,
    expectancyCI: st.expectancyCI,
    stopped: st.stopped,
    medianPeak: st.medianPeak,
  };
}

/** Default search grid: a few values for the settings that matter most. The band keeps the defaults' width. */
export function defaultGrid(base = DEFAULTS) {
  const width = base.maxRise - base.minRise;
  const grid = [];
  for (const minRise of [24, 27, 30])
    for (const minRvol of [2, 2.5, 3.5])
      for (const minTakerBuy of [0.53, 0.56, 0.6])
        for (const stopMode of ['fixed', 'vol']) grid.push({ ...base, minRise, maxRise: minRise + width, minRvol, minTakerBuy, stopMode });
  return grid;
}

/** Best rule set by in-sample expectancy among those with at least minSignals closed signals (all, if none qualify). */
function chooseBest(results, minSignals) {
  const eligible = results.filter((r) => r.train.closed >= minSignals && r.train.expectancy != null);
  const best = (eligible.length ? eligible : results).slice().sort((a, b) => (b.train.expectancy ?? -Infinity) - (a.train.expectancy ?? -Infinity))[0];
  return { best, enough: eligible.length > 0 };
}

/**
 * Walk-forward: repeatedly tune on everything before a split and test on the next stepDays, so the result does not
 * hang on one lucky split. `evaluateWindow(result, from, to)` gives stats for one rule set over a window.
 * Returns the folds and the test results of all folds pooled.
 */
export function walkForward(results, { start, end, trainDays, stepDays, minSignals, costPct, dataEnd }) {
  const folds = [];
  const pooled = [];
  for (let splitAt = start + trainDays * DAY * MIN; splitAt + stepDays * DAY * MIN <= end + MIN; splitAt += stepDays * DAY * MIN) {
    const testTo = splitAt + stepDays * DAY * MIN;
    const withTrain = results.map((r) => ({ ...r, train: periodStats(r.signals, start, splitAt, costPct, dataEnd) }));
    const { best } = chooseBest(withTrain, minSignals);
    const sigs = best.signals.filter((s) => s.alertT >= splitAt && s.alertT < testTo && s.alertT <= dataEnd - 72 * 3_600_000);
    folds.push({ from: splitAt, to: testTo, ruleId: configId(best.cfg), train: best.train, test: periodStats(best.signals, splitAt, testTo, costPct, dataEnd) });
    pooled.push(...sigs);
  }
  const st = stats(pooled, { costPct });
  return { folds, pooled: { signals: pooled.length, closed: st.closed, winRate: st.winRate, winRateCI: st.winRateCI, expectancy: st.expectancy, expectancyCI: st.expectancyCI } };
}

/** Test-period results across the whole grid: what a randomly chosen rule set did, not just the winner. */
export function gridSpread(results) {
  const ex = results.map((r) => r.test.expectancy).filter((v) => v != null).sort((a, b) => a - b);
  return {
    ruleSets: results.length,
    withResults: ex.length,
    median: quantile(ex, 0.5),
    p25: quantile(ex, 0.25),
    p75: quantile(ex, 0.75),
    worst: ex[0] ?? null,
    best: ex.at(-1) ?? null,
    positiveShare: ex.length ? ex.filter((v) => v > 0).length / ex.length : null,
  };
}

/**
 * Tune on the first trainDays, test the chosen rules on the rest.
 * data: [{ symbol, minutes, pos }]. Picks the rule set with the best in-sample expectancy among those with
 * at least minSignals closed signals; reports its out-of-sample result and the defaults' result for comparison.
 */
export function runBacktest(data, { trainDays = 20, costPct = DEFAULTS.costPct, grid = defaultGrid(), minSignals = 30, stepDays = 5, onProgress = () => {} } = {}) {
  // Floors: the lowest trigger values in play, defaults included, so nothing any rule set could fire on is skipped.
  const minRiseFloor = Math.min(DEFAULTS.minRise, ...grid.map((g) => g.minRise));
  const minImpulseFloor = Math.min(DEFAULTS.minImpulse, ...grid.map((g) => g.minImpulse ?? DEFAULTS.minImpulse));
  const prepared = data.map((d) => ({ ...d, cands: candidates(d.minutes, d.pos, { minRiseFloor, minImpulseFloor }) }));
  const start = Math.min(...prepared.map((d) => d.minutes[DAY]?.t ?? Infinity));
  const end = Math.max(...prepared.map((d) => d.minutes.at(-1)?.t ?? 0)) + MIN;
  const split = start + trainDays * DAY * MIN;
  const evaluate = (cfg) => {
    const signals = prepared.flatMap((d) => replayPair(d.symbol, d.minutes, d.cands, cfg, d.funding));
    return { cfg, signals, train: periodStats(signals, start, split, costPct, end, cfg.maxTrackHours * 3_600_000), test: periodStats(signals, split, end, costPct, end, cfg.maxTrackHours * 3_600_000) };
  };
  const results = grid.map((cfg, k) => {
    onProgress(k + 1, grid.length);
    return evaluate(cfg);
  });
  const { best, enough } = chooseBest(results, minSignals);
  const defaults = evaluate({ ...DEFAULTS });
  const days = (end - start) / (DAY * MIN);
  const pick = (cfg) => Object.fromEntries(['minRise', 'maxRise', 'requireCrossing', 'minRvol', 'minTakerBuy', 'stopMode', 'stopPct', 'maxBelowHigh', 'minOiChange'].map((k) => [k, cfg[k]]));
  const wf = days - trainDays >= 2 * stepDays ? walkForward(results, { start, end, trainDays, stepDays, minSignals, costPct, dataEnd: end }) : null;
  return {
    ranAt: Date.now(),
    pairs: data.length,
    days: Math.round(days * 10) / 10,
    trainDays,
    testDays: Math.round((days - trainDays) * 10) / 10,
    costPct,
    fundingIncluded: data.some((d) => d.funding?.length),
    gridSize: grid.length,
    bestRuleId: configId(best.cfg),
    bestRules: pick(best.cfg),
    enoughSignals: enough,
    train: best.train,
    test: best.test,
    defaults: { ruleId: configId(DEFAULTS), train: defaults.train, test: defaults.test },
    gridSpread: gridSpread(results),
    walkForward: wf,
    top: results
      .slice()
      .sort((a, b) => (b.train.expectancy ?? -Infinity) - (a.train.expectancy ?? -Infinity))
      .slice(0, 10)
      .map((r) => ({ ruleId: configId(r.cfg), rules: pick(r.cfg), train: r.train, test: r.test })),
    notes: [
      'Open interest gate uses 5-minute snapshots read one slot late; live scanning uses real-time open interest against a baseline picked the same way (nearest to 15 minutes back).',
      'Alerts fire at a minute close. Exits are replayed from 1-minute candles assuming green candles hit their low first; a stop fills at the stop price minus a slippage allowance.',
      'Signals alerted in the last 72 hours of data are left out (unresolved): they never had their full tracking window.',
      'No Smart Money whale filter: Binance keeps no history of that data.',
      costPct < 0.3 ? 'Costs are below 0.3%, which is optimistic for a coin that has just run 27%.' : `Costs of ${costPct}% per round trip${data.some((d) => d.funding?.length) ? ', plus funding paid while a signal was open' : ' (funding not included)'}.`,
      'The winner is the best of the whole grid on the tuning period, so its test result still flatters it. Compare it with the grid median and the walk-forward result.',
      'Pairs are those trading at the start of the window; coins delisted since are not in Binance\'s list and cannot be included.',
    ],
  };
}
