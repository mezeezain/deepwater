// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, screen, orderFlow, confirm, createSignal, updateSignal, replayCandles, inCooldown, stats } from '../js/engine.js';

const round1 = (x) => Math.round(x * 10) / 10;

test('screen: needs a moderate rise off the 24h low and a fresh 5m impulse', () => {
  assert.equal(screen({ price: 1.06, low24h: 1 }, 1.03).pass, true);
  assert.equal(screen({ price: 1.06, low24h: 1 }, 1.059).pass, false, 'no impulse');
  assert.equal(screen({ price: 1.02, low24h: 1 }, 0.98).pass, false, 'too close to the low');
  assert.equal(screen({ price: 1.3, low24h: 1 }, 1.2).pass, false, 'move already spent');
  assert.equal(screen({ price: 1.06, low24h: 0 }, 1).pass, false, 'bad data');
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
  updateSignal(s, 97, 1000);
  assert.equal(s.status, 'TRACKING');
  updateSignal(s, 94.9, 2000);
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

test('stats: hit rates and medians', () => {
  const mk = (rise, dip) => ({ ...createSignal({ symbol: 'X', price: 1, t: 0 }), rise, dip });
  const s = stats([mk(2, -1), mk(6, -3), mk(12, -0.5), mk(30, -2)]);
  assert.equal(s.count, 4);
  assert.equal(s.hit5, 0.75);
  assert.equal(s.hit10, 0.5);
  assert.equal(s.medianRise, 9);
  assert.equal(s.medianDip, -1.5);
});
