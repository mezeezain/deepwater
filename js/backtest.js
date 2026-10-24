// Offline backtest: replays the pump catcher's exact rules (engine.js) over historical Binance data.
// Pure functions; tools/backtest.mjs downloads the data and writes the report.
//
// Data per pair:
//   minutes: [{ t, o, h, l, c, v, takerBuy }]   1-minute candles (v and takerBuy in USDT), oldest first
//   pos:     Map(slot -> { oi, whaleLong, crowdLong })   5-minute positioning snapshots, keyed by slot start
//
// Differences from live scanning, all stated in the report:
//   - the open interest gate compares 5-minute snapshots (live uses real-time OI against the same baseline);
//   - alerts fire at a minute's close, not mid-minute;
//   - no Smart Money whale filter (Binance keeps no history of it);
//   - exits are replayed from 1-minute candles, assuming green candles hit their low before their high.
import { DEFAULTS, screen, orderFlow, confirm, createSignal, replayCandles, inCooldown, stats, configId } from './engine.js';

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

/** Latest positioning snapshot at or before time t, and the one 15 minutes earlier. */
function positioningAt(pos, t) {
  const slot = Math.floor(t / SLOT) * SLOT;
  for (let back = 0; back < 3; back++) {
    const now = pos.get(slot - back * SLOT);
    if (now) return { now, before: pos.get(slot - (back + 3) * SLOT) ?? null };
  }
  return { now: null, before: null };
}

/**
 * Candidate minutes for one pair: everything the gates need, computed once and reused for every rule set.
 * Only minutes with a meaningful lift off the low and a 5-minute move are kept, which is all any grid point can use.
 */
export function candidates(minutes, pos, { minRiseFloor = 2, minImpulseFloor = 0.8 } = {}) {
  const { lows, highs } = rolling24h(minutes);
  const out = [];
  for (let i = DAY; i < minutes.length; i++) {
    const m = minutes[i];
    const ticker = { price: m.c, low24h: lows[i], high24h: highs[i] };
    const sc = screen(ticker, minutes[i - 5].c, { ...DEFAULTS, minRise: minRiseFloor, maxRise: 100, minImpulse: minImpulseFloor, maxBelowHigh: 100 });
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
export function replayPair(symbol, minutes, cands, cfg) {
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
    signals.push(sig);
  }
  return signals;
}

/** Stats for signals alerted inside [from, to). Signals still open when the data ends aren't counted as results. */
export function periodStats(signals, from, to, costPct) {
  const inPeriod = signals.filter((s) => s.alertT >= from && s.alertT < to);
  const st = stats(inPeriod, { costPct });
  return {
    signals: inPeriod.length,
    closed: st.closed,
    winRate: st.winRate,
    avgWin: st.avgWin,
    avgLoss: st.avgLoss,
    expectancy: st.expectancy,
    stopped: st.stopped,
    medianPeak: st.medianPeak,
  };
}

/** Default search grid: a few values for the settings that matter most. */
export function defaultGrid(base = DEFAULTS) {
  const grid = [];
  for (const minRise of [3, 4.5, 6])
    for (const minRvol of [2, 2.5, 3.5])
      for (const minTakerBuy of [0.53, 0.56, 0.6])
        for (const stopMode of ['fixed', 'vol']) grid.push({ ...base, minRise, minRvol, minTakerBuy, stopMode });
  return grid;
}

/**
 * Tune on the first trainDays, test the chosen rules on the rest.
 * data: [{ symbol, minutes, pos }]. Picks the rule set with the best in-sample expectancy among those with
 * at least minSignals closed signals; reports its out-of-sample result and the defaults' result for comparison.
 */
export function runBacktest(data, { trainDays = 20, costPct = DEFAULTS.costPct, grid = defaultGrid(), minSignals = 30, onProgress = () => {} } = {}) {
  const prepared = data.map((d) => ({ ...d, cands: candidates(d.minutes, d.pos) }));
  const start = Math.min(...prepared.map((d) => d.minutes[DAY]?.t ?? Infinity));
  const end = Math.max(...prepared.map((d) => d.minutes.at(-1)?.t ?? 0)) + MIN;
  const split = start + trainDays * DAY * MIN;
  const evaluate = (cfg) => {
    const signals = prepared.flatMap((d) => replayPair(d.symbol, d.minutes, d.cands, cfg));
    return { cfg, signals, train: periodStats(signals, start, split, costPct), test: periodStats(signals, split, end, costPct) };
  };
  const results = grid.map((cfg, k) => {
    onProgress(k + 1, grid.length);
    return evaluate(cfg);
  });
  const eligible = results.filter((r) => r.train.closed >= minSignals && r.train.expectancy != null);
  const best = (eligible.length ? eligible : results).slice().sort((a, b) => (b.train.expectancy ?? -Infinity) - (a.train.expectancy ?? -Infinity))[0];
  const defaults = evaluate({ ...DEFAULTS });
  const days = (end - start) / (DAY * MIN);
  const pick = (cfg) => Object.fromEntries(['minRise', 'minRvol', 'minTakerBuy', 'stopMode', 'stopPct', 'maxBelowHigh', 'minOiChange'].map((k) => [k, cfg[k]]));
  return {
    ranAt: Date.now(),
    pairs: data.length,
    days: Math.round(days * 10) / 10,
    trainDays,
    testDays: Math.round((days - trainDays) * 10) / 10,
    costPct,
    gridSize: grid.length,
    bestRuleId: configId(best.cfg),
    bestRules: pick(best.cfg),
    enoughSignals: eligible.length > 0,
    train: best.train,
    test: best.test,
    defaults: { ruleId: configId(DEFAULTS), train: defaults.train, test: defaults.test },
    top: results
      .slice()
      .sort((a, b) => (b.train.expectancy ?? -Infinity) - (a.train.expectancy ?? -Infinity))
      .slice(0, 10)
      .map((r) => ({ ruleId: configId(r.cfg), rules: pick(r.cfg), train: r.train, test: r.test })),
    notes: [
      'Open interest gate uses 5-minute snapshots; live scanning uses real-time open interest.',
      'Alerts fire at a minute close. Exits are replayed from 1-minute candles assuming green candles hit their low first.',
      'No Smart Money whale filter: Binance keeps no history of that data.',
      'Results ignore real fills, slippage beyond the assumed cost, and funding payments.',
    ],
  };
}
