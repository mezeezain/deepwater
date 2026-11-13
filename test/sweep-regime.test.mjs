import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SR, rsi, to4h, last4hIndex, unbrokenSwing, runTrade, simulate, tradeSummary, signals } from '../js/sweep-regime.js';

const H = 3_600_000;
const bar = (i, o, h, l, c) => ({ t: i * H, o, h, l, c });
const flat = (i, p) => bar(i, p, p + 0.1, p - 0.1, p);

test('rsi: all gains is 100, all losses is 0, alternating is near 50', () => {
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => 100 + i)).at(-1), 100);
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => 100 - i)).at(-1), 0);
  const mid = rsi(Array.from({ length: 60 }, (_, i) => 100 + (i % 2))).at(-1);
  assert.ok(mid > 40 && mid < 60);
  assert.equal(rsi([1, 2, 3])[2], null);
});

test('to4h builds complete 4h candles on the 0/4/8 grid and last4hIndex only uses closed ones', () => {
  const bars = Array.from({ length: 10 }, (_, k) => bar(k + 2, 10 + k, 11 + k, 9 + k, 10.5 + k)); // hours 2..11
  const b4 = to4h(bars);
  assert.deepEqual(b4.map((b) => b.t / H), [4, 8]); // 0-4 is incomplete (only hours 2,3)
  assert.deepEqual([b4[0].o, b4[0].h, b4[0].l, b4[0].c], [12, 16, 11, 15.5]);
  const map = last4hIndex(bars, b4);
  // hour 7 closes at 8:00, exactly when the 4:00 candle closes, so it may use it; hour 6 may not.
  assert.equal(map[bars.findIndex((b) => b.t === 7 * H)], 0);
  assert.equal(map[bars.findIndex((b) => b.t === 6 * H)], -1);
  assert.equal(map.at(-1), 1);
});

test('unbrokenSwing finds the latest swing high that price has not gone through', () => {
  const bars = Array.from({ length: 30 }, (_, i) => flat(i, 100));
  bars[10] = bar(10, 100, 105, 99.9, 100); // old, higher swing
  bars[20] = bar(20, 100, 103, 99.9, 100); // latest swing
  assert.deepEqual(unbrokenSwing(bars, 28, -1), { index: 20, price: 103 });
  bars[25] = bar(25, 100, 104, 99.9, 100); // went through 103 (and is itself a swing)
  assert.deepEqual(unbrokenSwing(bars, 28, -1), { index: 25, price: 104 });
  assert.deepEqual(unbrokenSwing(bars, 26, -1), { index: 10, price: 105 }); // 25 not confirmed yet, 20 is broken
  bars[5] = bar(5, 100, 100.1, 95, 100);
  assert.deepEqual(unbrokenSwing(bars, 28, 1), { index: 5, price: 95 });
});

const short = { side: -1, entry: 100, stop: 102, r: 2 };
const free = { ...SR, maker: 0, taker: 0, slip: 0 };

test('runTrade: stop, half at +2R then breakeven lock, and both targets', () => {
  const lose = [flat(0, 100), flat(1, 100), bar(2, 100, 102.5, 99, 101)];
  assert.deepEqual(runTrade(lose, 0, short, free), { exit: 'stop', gross: -1, cost: 0, r: -1, end: 2 });
  const partial = [flat(0, 100), bar(1, 100, 100.5, 95.9, 96.5), bar(2, 96.5, 99.9, 96, 99.5)]; // TP1 at 96, then back to the lock at 99.8
  const p = runTrade(partial, 0, short, free);
  assert.equal(p.exit, 'partial');
  assert.ok(Math.abs(p.r - 1.05) < 1e-9); // half at +2R, half at +0.1R
  const full = [flat(0, 100), bar(1, 100, 100.5, 95.9, 96.5), bar(2, 96.5, 97, 91.9, 92)];
  const f = runTrade(full, 0, short, free);
  assert.equal(f.exit, 'full');
  assert.equal(f.r, 3);
  // A candle that touches both the stop and the first target counts as the stop.
  assert.equal(runTrade([flat(0, 100), bar(1, 100, 102.1, 95, 99)], 0, short, free).exit, 'stop');
  assert.equal(runTrade([flat(0, 100), flat(1, 100)], 0, short, free).exit, 'open');
  // Long is the mirror.
  const long = { side: 1, entry: 100, stop: 98, r: 2 };
  assert.equal(runTrade([flat(0, 100), bar(1, 100, 104.1, 99.5, 104), bar(2, 104, 108.1, 103, 108)], 0, long, free).r, 3);
  assert.equal(runTrade([flat(0, 100), bar(1, 100, 100.5, 97.9, 98)], 0, long, free).exit, 'stop');
});

test('runTrade charges fees, slippage and funding in R', () => {
  const lose = [flat(0, 100), bar(1, 100, 102.5, 99, 101)];
  const r = runTrade(lose, 0, short, SR);
  // entry maker 0.02% of 100 = 0.02; stop taker+slip 0.1% of 102 = 0.102; over a 2-point stop = 0.061R
  assert.ok(Math.abs(r.cost - (0.02 + 0.102) / 2) < 1e-9);
  assert.ok(Math.abs(r.r - (-1 - 0.061)) < 1e-9);
  // A short receives positive funding: 0.01% of 100 over a 2-point stop = 0.005R back.
  const paid = runTrade(lose, 0, short, free, () => 0.0001);
  assert.ok(Math.abs(paid.r - (-1 + 0.005)) < 1e-9);
});

test('simulate: limit fills when price trades through it, is cancelled when price runs away, one trade at a time', () => {
  const bars = [flat(0, 100), flat(1, 100), bar(2, 100, 100.4, 99.5, 99.8), bar(3, 99.8, 100, 95.9, 96), bar(4, 96, 96.5, 91.9, 92), flat(5, 92), flat(6, 92)];
  const sig = { i: 1, t: H, side: -1, entry: 100, stop: 102, r: 2, wick: 101 };
  const a = simulate(bars, [sig, { ...sig, i: 2 }], free);
  assert.equal(a.trades.length, 1);
  assert.equal(a.skippedBusy, 1); // the second signal came while the first trade was on
  assert.equal(a.trades[0].exit, 'full');
  assert.equal(a.trades[0].stopPct, 2);
  // Price drops 0.5R (to 99) without ever trading above 100: the order is cancelled.
  const gone = [flat(0, 100), bar(1, 100, 100, 99.5, 100), bar(2, 100, 100, 98.9, 99), bar(3, 99, 101, 98, 100.5), flat(4, 100)];
  const b = simulate(gone, [{ ...sig, i: 1 }], free);
  assert.deepEqual([b.trades.length, b.unfilled], [0, 1]);
  // Market entry takes the next open instead.
  const c = simulate(bars, [sig], { ...free, marketEntry: true });
  assert.equal(c.trades.length, 1);
});

test('tradeSummary compounds 1.5% risk and reports shares, streak and drawdown', () => {
  const t = (exit, r) => ({ exit, r, cost: 0.05, stopPct: 2 });
  const s = tradeSummary([t('full', 3), t('stop', -1), t('stop', -1), t('partial', 1)]);
  assert.deepEqual([s.n, s.full, s.partial, s.stop, s.losingStreak], [4, 0.25, 0.25, 0.5, 2]);
  assert.equal(s.expR, 0.5);
  assert.equal(s.profitFactor, 2);
  assert.ok(Math.abs(s.equity - 150 * 1.045 * 0.985 * 0.985 * 1.015) < 1e-9);
  assert.ok(Math.abs(s.maxDrawdown - (1 - 0.985 * 0.985)) < 1e-9);
  assert.equal(tradeSummary([]).n, 0);
});

// An invented market: a random walk whose drift swings slowly between up and down, with bigger candles while it
// trends (the regime needs ATR(14) above ATR(50), which a falling price with constant % moves would never give).
function series(seed0, n = 9000) {
  let seed = seed0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const bars = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p, s = Math.sin(i / 400), vol = 1 + 1.5 * Math.abs(s);
    p *= 1 + s * 0.0006 + (rnd() - 0.5) * 0.012 * vol;
    bars.push(bar(i, o, Math.max(o, p) * (1 + rnd() * 0.005 * vol), Math.min(o, p) * (1 - rnd() * 0.005 * vol), p));
  }
  return bars;
}

test('signals: shorts sweep a swing high and longs a swing low, close back inside, stop beyond the wick', () => {
  const bars = series(5);
  const funnel = {};
  const sigs = signals(bars, SR, { funnel });
  const shorts = sigs.filter((s) => s.side < 0), longs = sigs.filter((s) => s.side > 0);
  assert.ok(shorts.length >= 2 && longs.length >= 2, `${shorts.length} shorts, ${longs.length} longs`);
  for (const sg of shorts) {
    const sw = unbrokenSwing(bars, sg.i - SR.sweepBars + 1, -1);
    assert.ok(sw && sg.wick > sw.price && sg.entry < sw.price && sg.stop > sg.wick && sg.entry === bars[sg.i].c);
  }
  for (const sg of longs) {
    const sw = unbrokenSwing(bars, sg.i - SR.sweepBars + 1, 1);
    assert.ok(sw && sg.wick < sw.price && sg.entry > sw.price && sg.stop < sg.wick && sg.r > 0);
  }
  // Each rule can only remove candles.
  assert.ok(funnel.regime >= funnel.swept && funnel.swept >= funnel.closedBack && funnel.closedBack >= funnel.ema && funnel.ema >= funnel.rsi && funnel.rsi >= funnel.zone && funnel.zone >= funnel.signal);
  assert.equal(funnel.signal, sigs.length);
  assert.ok(signals(bars, { ...SR, zone: false }).length >= sigs.length);
  // Funding gate: very negative funding removes the shorts only; very positive removes the longs only.
  assert.equal(signals(bars, SR, { funding: () => -0.001 }).length, longs.length);
  assert.equal(signals(bars, SR, { funding: () => 0.001 }).length, shorts.length);
  // BTC gate: BTC up 5% in 4 hours removes the shorts; down 5% removes the longs.
  assert.equal(signals(bars, SR, { btcMove: () => 5 }).length, longs.length);
  assert.equal(signals(bars, SR, { btcMove: () => -5 }).length, shorts.length);
});
