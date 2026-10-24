// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, screen, orderFlow, confirm, createSignal, updateSignal, replayCandles, inCooldown, stats, realised, stopFor, configId } from '../js/engine.js';

const round1 = (x) => Math.round(x * 10) / 10;

test('screen: fires on the first crossing of +27% off the 24h low', () => {
  assert.equal(screen({ price: 1.27, low24h: 1 }, 1.26).pass, true);
  assert.equal(screen({ price: 1.2734, low24h: 1 }, 1.27).pass, true, 'one 5-second tick past the line');
  assert.equal(screen({ price: 1.269, low24h: 1 }, 1.2).pass, false, 'not yet +27%');
  assert.equal(screen({ price: 1.35, low24h: 1 }, 1.3).pass, false, 'crossed long ago');
  assert.equal(screen({ price: 1.28, low24h: 0 }, 1).pass, false, 'bad data');
  // The optional impulse setting still works when switched on.
  assert.equal(screen({ price: 1.28, low24h: 1 }, 1.279, { ...DEFAULTS, minImpulse: 1.5 }).pass, false, 'no impulse');
});

test('orderFlow: relative volume and taker buy share from 1m klines', () => {
  const quiet = Array.from({ length: 30 }, () => ({ v: 100, takerBuy: 50 }));
  const burst = Array.from({ length: 5 }, () => ({ v: 300, takerBuy: 210 }));
  const f = orderFlow([...quiet, ...burst]);
  assert.equal(round1(f.rvol), 3);
  assert.equal(round1(f.takerBuy), 0.7);
  assert.equal(f.cvd5m, 600);
  // Binance array format: quote volume at [7], taker buy quote volume at [10]
  const arr = [...quiet, ...burst].map((r) => [0, 0, 0, 0, 0, 0, 0, r.v, 0, 0, r.takerBuy, 0]);
  assert.deepEqual(orderFlow(arr), f);
});

test('confirm: rejects a bounce with selling and falling open interest', () => {
  const r = confirm({ rvol: 3, takerBuy: 0.48, oiChange: -2.1, whaleLong: 0.45, crowdLong: 0.65 });
  assert.equal(r.pass, false);
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), ['cvd', 'oi', 'edge']);
});

test('confirm: accepts a whale-backed breakout and reports the gap', () => {
  const r = confirm({ rvol: 3.75, takerBuy: 0.64, oiChange: 4.2, whaleLong: 0.68, crowdLong: 0.36 });
  assert.equal(r.pass, true);
  assert.equal(Math.round(r.gap), 32);
});

test('confirm: a heavily short crowd counts as an edge even without a whale gap', () => {
  const r = confirm({ rvol: 3, takerBuy: 0.6, oiChange: 2, whaleLong: 0.36, crowdLong: 0.35 });
  assert.equal(r.pass, true);
  assert.equal(r.checks.find((c) => c.id === 'edge').label, 'Crowd heavily short');
});

test('confirm: edge check can be switched off', () => {
  const ctx = { rvol: 3, takerBuy: 0.6, oiChange: 2, whaleLong: 0.4, crowdLong: 0.6 };
  assert.equal(confirm(ctx).pass, false);
  assert.equal(confirm(ctx, { ...DEFAULTS, requireEdge: false }).pass, true);
});

test('tracking: rise after alert and dip before peak', () => {
  const s = createSignal({ symbol: 'TESTUSDT', price: 0.0587, t: 0, rise: 6.7, impulse: 2 });
  updateSignal(s, 0.057761, 60_000);
  updateSignal(s, 0.067035, 7_380_000);
  assert.equal(round1(s.rise), 14.2);
  assert.equal(round1(s.dip), -1.6);
  assert.equal(s.status, 'TRACKING');
});

test('tracking: a drawdown after the peak does not change dip before peak', () => {
  const s = createSignal({ symbol: 'TESTUSDT', price: 0.0587, t: 0, rise: 6.7, impulse: 2 });
  updateSignal(s, 0.057761, 60_000);
  updateSignal(s, 0.067035, 7_380_000);
  updateSignal(s, 0.056, 9_000_000);
  assert.equal(round1(s.dip), -1.6);
  assert.equal(round1(s.rise), 14.2);
  assert.equal(s.status, 'CLOSED');
  assert.equal(s.closeReason, 'Gave back most of the gain');
});

test('tracking: closes on a stop below the alert price', () => {
  const s = createSignal({ symbol: 'X', price: 100, t: 0 });
  updateSignal(s, 94, 1000);
  assert.equal(s.status, 'TRACKING');
  updateSignal(s, 92.9, 2000);
  assert.equal(s.status, 'CLOSED');
  assert.equal(s.rise, 0);
});

test('tracking: small gains do not arm the trailing close', () => {
  const s = createSignal({ symbol: 'X', price: 100, t: 0 });
  updateSignal(s, 106, 1000);
  updateSignal(s, 100.5, 2000);
  assert.equal(s.status, 'TRACKING');
});

test('tracking: closes when the tracking window ends', () => {
  const s = createSignal({ symbol: 'X', price: 100, t: 0 });
  updateSignal(s, 101, (DEFAULTS.maxTrackHours + 1) * 3_600_000);
  assert.equal(s.status, 'CLOSED');
});

test('tracking: ignores updates after closing and out-of-order prices', () => {
  const s = createSignal({ symbol: 'X', price: 100, t: 5000 });
  updateSignal(s, 150, 1000);
  assert.equal(s.rise, 0, 'older timestamp ignored');
  updateSignal(s, 90, 6000);
  updateSignal(s, 200, 7000);
  assert.equal(s.rise, 0, 'closed signal ignored');
});

test('replayCandles: catches up from candles with the right ordering', () => {
  const s = createSignal({ symbol: 'X', price: 100, t: 0 });
  // Green candle: dips to 98 first, then runs to 112.
  replayCandles(s, [{ t: 0, o: 100, h: 112, l: 98, c: 110 }]);
  assert.equal(round1(s.rise), 12);
  assert.equal(round1(s.dip), -2);
  // Red candle afterwards: high 113 first, then low 99 — the dip before the new peak stays -2%.
  replayCandles(s, [{ t: 60_000, o: 110, h: 113, l: 99, c: 101 }]);
  assert.equal(round1(s.rise), 13);
  assert.equal(round1(s.dip), -2);
});

test('inCooldown: blocks repeats while tracking and shortly after closing', () => {
  const tracking = createSignal({ symbol: 'A', price: 1, t: 0 });
  const closed = { ...createSignal({ symbol: 'B', price: 1, t: 0 }), status: 'CLOSED', closedT: 1000 };
  assert.equal(inCooldown('A', [tracking], 10_000), true);
  assert.equal(inCooldown('B', [closed], 10_000), true);
  assert.equal(inCooldown('B', [closed], 1000 + DEFAULTS.cooldownMin * 60_000 + 1), false);
  assert.equal(inCooldown('C', [tracking, closed], 10_000), false);
});

test('stats: performance counts closed signals only, from realised exits after costs', () => {
  const closedAt = (alert, exit, rise, reason = 'Gave back most of the gain') => ({
    ...createSignal({ symbol: 'X', price: alert, t: 0 }), status: 'CLOSED', exitPrice: exit, rise, dip: -1, closeReason: reason,
  });
  const open = { ...createSignal({ symbol: 'Y', price: 1, t: 0 }), rise: 40 };
  const s = stats([closedAt(100, 106, 12), closedAt(100, 95, 0, 'Hit the stop'), closedAt(100, 102, 4), open], { costPct: 0.2 });
  assert.equal(s.count, 4);
  assert.equal(s.tracking, 1, 'the open signal is reported separately');
  assert.equal(s.closed, 3);
  assert.equal(Math.round(s.winRate * 100), 67);
  assert.equal(round1(s.avgWin), round1((5.8 + 1.8) / 2));
  assert.equal(round1(s.avgLoss), -5.2);
  assert.equal(round1(s.expectancy), round1((5.8 - 5.2 + 1.8) / 3));
  assert.equal(round1(s.stopped * 3), 1);
  assert.equal(round1(s.hit10 * 3), 1, 'best case: one closed signal touched +10%; the open +40% is not counted');
  assert.equal(s.medianPeak, 4);
});

test('realised: older signals without exitPrice use the last tracked price', () => {
  const s = { ...createSignal({ symbol: 'X', price: 100, t: 0 }), status: 'CLOSED', lastPrice: 103 };
  assert.equal(round1(realised(s, 0.15)), 2.9);
  assert.equal(realised({ ...s, status: 'TRACKING' }), null);
});

test('updateSignal: stores the exit price when it closes', () => {
  const s = createSignal({ symbol: 'X', price: 100, t: 0 });
  updateSignal(s, 92.5, 1000);
  assert.equal(s.exitPrice, 92.5);
  assert.equal(s.closeReason, 'Hit the stop');
});

test('orderFlow: volume baseline is a per-minute average, whatever the window length', () => {
  // 29 quiet minutes then 5 busy ones: the old floor(29/5) windows overstated the baseline by 16%.
  const quiet = Array.from({ length: 29 }, () => ({ v: 100, takerBuy: 50 }));
  const burst = Array.from({ length: 5 }, () => ({ v: 250, takerBuy: 150 }));
  assert.equal(round1(orderFlow([...quiet, ...burst]).rvol), 2.5);
});

test('orderFlow: typical 5-minute range for the volatility stop', () => {
  const rows = Array.from({ length: 35 }, (_, i) => ({ v: 100, takerBuy: 50, h: 101, l: 99, c: 100 }));
  assert.equal(orderFlow(rows).range5m, 2);
  assert.equal(stopFor({ ...DEFAULTS, stopMode: 'vol', volStopMult: 3 }, 2), 6);
  assert.equal(stopFor({ ...DEFAULTS, stopMode: 'vol', volStopMult: 3 }, 10), 12, 'capped at 12%');
  assert.equal(stopFor({ ...DEFAULTS, stopMode: 'vol', volStopMult: 3 }, 0.5), 3, 'at least 3%');
  assert.equal(stopFor(DEFAULTS, 2), DEFAULTS.stopPct);
});

test('screen: a bounce far below the 24h high is not a breakout', () => {
  // Crashed from 200 to 70, bounced 27% to 89: 55.5% below the high.
  assert.equal(screen({ price: 89, low24h: 70, high24h: 200 }, 85).pass, false);
  // Same lift off the low near the top of the range: passes.
  assert.equal(screen({ price: 89, low24h: 70, high24h: 95 }, 85).pass, true);
  assert.equal(screen({ price: 89, low24h: 70, high24h: 200 }, 85, { ...DEFAULTS, maxBelowHigh: 60 }).pass, true);
});

test('signals keep the rules they fired with', () => {
  const cfg = { ...DEFAULTS, stopPct: 10 };
  const s = createSignal({ symbol: 'X', price: 100, t: 0, cfg });
  assert.equal(s.cfgId, configId(cfg));
  assert.notEqual(s.cfgId, configId(DEFAULTS));
  assert.equal(s.stopPct, 10);
  updateSignal(s, 92, 1000, DEFAULTS); // the 7% default stop would close this; the signal's own 10% does not
  assert.equal(s.status, 'TRACKING');
  updateSignal(s, 89.9, 2000, DEFAULTS);
  assert.equal(s.status, 'CLOSED');
});
