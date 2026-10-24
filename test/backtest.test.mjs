import test from 'node:test';
import assert from 'node:assert/strict';
import { rolling24h, candidates, replayPair, runBacktest } from '../js/backtest.js';
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
  // 5-minute positioning: OI rises 3% during each pump; top accounts lean long, crowd leans short.
  const pos = new Map();
  let oi = 1e6;
  for (let i = 0; i < minutes.length; i += 5) {
    if ([...pumpMinutes.keys()].some((m) => m >= i && m < i + 5)) oi *= 1.015;
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
  const cands = candidates(minutes, pos);
  assert.ok(cands.length > 0, 'pump minutes become candidates');
  const sigs = replayPair('TESTUSDT', minutes, cands, { ...DEFAULTS, minRise: 3 });
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
  const pair = synthPair(4, [1440 + 300, 1440 + 900, 2880 + 300, 2880 + 900], { fadeTo: 0.88 });
  const report = runBacktest([{ symbol: 'TESTUSDT', ...pair }], {
    trainDays: 1,
    grid: [{ ...DEFAULTS, minRise: 3 }, { ...DEFAULTS, minRise: 3, minRvol: 10 }],
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
});
