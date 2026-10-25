import test from 'node:test';
import assert from 'node:assert/strict';
import { rolling24h, candidates, replayPair, runBacktest, positioningAt, periodStats, fundingPaid } from '../js/backtest.js';
import { DEFAULTS } from '../js/engine.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1);

/**
 * Synthetic pair: flat around 100 with small noise, plus planted pumps. Each pump: a 10-minute climb of
 * ~0.9%/min on 4× volume and 70% taker buys while open interest rises, then a drift lower.
 */
function synthPair(days, pumpsAtMinute, { fadeTo = 0.97 } = {}) {
  const minutes = [];
  let p = 100;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pumpMinutes = new Map();
  for (const at of pumpsAtMinute) for (let k = 0; k < 10; k++) pumpMinutes.set(at + k, k);
  const fadeMinutes = new Set();
  for (const at of pumpsAtMinute) for (let k = 10; k < 130; k++) fadeMinutes.add(at + k);
  for (let i = 0; i < days * 1440; i++) {
    const o = p;
    if (pumpMinutes.has(i)) p *= 1.009;
    else if (fadeMinutes.has(i)) p *= Math.pow(fadeTo, 1 / 120);
    else p = p * (1 + (rnd() - 0.5) * 0.0008) + (100 - p) * 0.002; // mean-reverting noise around 100
    const busy = pumpMinutes.has(i);
    const v = busy ? 4000 : 1000;
    minutes.push({ t: T0 + i * MIN, o, h: Math.max(o, p) * 1.0005, l: Math.min(o, p) * 0.9995, c: p, v, takerBuy: v * (busy ? 0.7 : 0.5) });
  }
  // 5-minute positioning: OI rises 3% in each pump slot (read one slot late); top accounts lean long, crowd leans short.
  const pos = new Map();
  let oi = 1e6;
  for (let i = 0; i < minutes.length; i += 5) {
    if ([...pumpMinutes.keys()].some((m) => m >= i && m < i + 5)) oi *= 1.03;
    pos.set(minutes[i].t, { oi, whaleLong: 0.62, crowdLong: 0.45 });
  }
  return { minutes, pos };
}

test('rolling24h: window low and high', () => {
  const m = Array.from({ length: 3000 }, (_, i) => ({ l: i === 100 ? 1 : 10, h: i === 2000 ? 99 : 20 }));
  const { lows, highs } = rolling24h(m);
  assert.equal(lows[150], 1);
  assert.equal(lows[100 + 1440], 10, 'the low drops out after 24 hours');
  assert.equal(highs[2000], 99);
  assert.equal(highs[1999], 20);
});

test('replay catches a planted pump and tracks it to an exit', () => {
  // 1 day of warm-up, pump at minute 1440 + 600 (dropping 5% off a ~100 base first, so it lifts off the 24h low).
  const { minutes, pos } = synthPair(3, [2040]);
  const cands = candidates(minutes, pos, { minRiseFloor: 3, minImpulseFloor: 1.5 }); // small synthetic pump, so low floors
  assert.ok(cands.length > 0, 'pump minutes become candidates');
  const sigs = replayPair('TESTUSDT', minutes, cands, { ...DEFAULTS, minRise: 3, maxRise: 18, minImpulse: 1.5, stopPct: 5 }); // small synthetic pump, so the old small band
  assert.equal(sigs.length, 1, 'one alert, then cooldown');
  const s = sigs[0];
  assert.ok(s.alertT > minutes[2040].t && s.alertT <= minutes[2050].t, 'fires during the climb');
  assert.ok(s.rvol > 2.5 && s.takerBuy > 0.6 && s.oiChange > 1.5);
  assert.equal(s.status, 'CLOSED', 'tracked to an exit within the data');
  assert.ok(s.exitPrice > 0);
});

test('runBacktest: tunes on the first period, reports the unseen period separately', () => {
  // Pumps in both halves after warm-up: day 2 (train) and day 3 (test). A sharp fade closes each signal
  // before the next pump; otherwise the open signal would (correctly) block later alerts on the same pair.
  const pair = synthPair(9, [1440 + 300, 1440 + 900, 2880 + 300, 2880 + 900], { fadeTo: 0.88 });
  const report = runBacktest([{ symbol: 'TESTUSDT', ...pair }], {
    trainDays: 1,
    grid: [{ ...DEFAULTS, minRise: 6, maxBelowHigh: 20 }, { ...DEFAULTS, minRise: 6, maxBelowHigh: 20, minRvol: 10 }],
    minSignals: 1,
  });
  assert.equal(report.pairs, 1);
  assert.equal(report.trainDays, 1);
  assert.ok(report.train.signals >= 1, 'signals in the tuning period');
  assert.ok(report.test.signals >= 1, 'signals in the test period');
  assert.equal(report.bestRules.minRvol, DEFAULTS.minRvol, 'the rule set that never fires is not chosen');
  assert.ok(report.defaults.ruleId);
  assert.equal(report.top.length, 2);
  assert.ok(report.notes.length >= 3);
  assert.equal(report.gridSpread.ruleSets, 2);
  assert.ok(report.test.unresolved === 0);
});

test('candidates: floors come from the rule sets, so the defaults are tested as they run live', () => {
  const { minutes, pos } = synthPair(3, [2040]);
  // With a 0.8% impulse floor the early, slow minutes of a climb would be skipped; with 0 they are all kept.
  const strict = candidates(minutes, pos, { minRiseFloor: 3, minImpulseFloor: 0.8 });
  const loose = candidates(minutes, pos, { minRiseFloor: 3, minImpulseFloor: 0 });
  assert.ok(loose.length >= strict.length);
  const rb = runBacktest([{ symbol: 'T', minutes, pos }], { trainDays: 1, grid: [{ ...DEFAULTS, minRise: 6, maxBelowHigh: 20 }], minSignals: 1 });
  assert.equal(rb.gridSize, 1);
});

test('positioningAt: one slot of delay and a baseline nearest to 15 minutes back', () => {
  const SLOT = 5 * MIN;
  const pos = new Map();
  for (let k = 0; k < 20; k++) pos.set(T0 + k * SLOT, { oi: 100 + k, whaleLong: 0.5, crowdLong: 0.5 });
  const t = T0 + 10 * SLOT + 2 * MIN; // inside slot 10
  const { now, before } = positioningAt(pos, t);
  assert.equal(now.oi, 109, 'slot 10 is still running, so slot 9 is the newest usable');
  assert.equal(before.oi, 107, 'nearest slot to t - 15 minutes (slot 7)');
  assert.deepEqual(positioningAt(new Map(), t), { now: null, before: null });
});

test('periodStats leaves out signals without a full tracking window', () => {
  const H = 3_600_000;
  const mk = (alertT, closed = true) => ({ status: closed ? 'CLOSED' : 'TRACKING', alertT, alertPrice: 100, exitPrice: 105, rise: 5, dip: 0, closeReason: 'x', closedT: alertT + H });
  const sigs = [mk(0), mk(10 * H), mk(95 * H, false)];
  const st = periodStats(sigs, 0, 100 * H, 0.3, 100 * H);
  assert.equal(st.signals, 2);
  assert.equal(st.unresolved, 1);
});

test('fundingPaid sums payments made while a signal was open', () => {
  const sig = { alertT: 100, closedT: 300 };
  const rows = [{ t: 50, rate: 0.01 }, { t: 150, rate: 0.0002 }, { t: 250, rate: 0.0004 }, { t: 350, rate: 0.01 }];
  assert.ok(Math.abs(fundingPaid(sig, rows) - 0.06) < 1e-9);
});

test('walkForward tunes before each split and tests after it', () => {
  const { minutes, pos } = synthPair(12, [1440 + 300, 1440 + 900, 2880 + 300, 2880 + 900, 4320 + 300, 4320 + 900, 5760 + 300, 5760 + 900], { fadeTo: 0.88 });
  const rb = runBacktest([{ symbol: 'T', minutes, pos }], { trainDays: 2, stepDays: 3, grid: [{ ...DEFAULTS, minRise: 6, maxBelowHigh: 20 }, { ...DEFAULTS, minRise: 6, maxBelowHigh: 20, minRvol: 10 }], minSignals: 1 });
  assert.ok(rb.walkForward, 'enough days for walk-forward');
  assert.ok(rb.walkForward.folds.length >= 2);
  assert.ok(rb.walkForward.pooled.signals >= 1);
});
