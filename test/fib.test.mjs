import test from 'node:test';
import assert from 'node:assert/strict';
import { pullbackAt, fibRow, fibTouches, levelPrice, FIB } from '../js/fib.js';

const H = 3_600_000;
const bar = (i, c, spread = 0.3) => ({ t: i * H, o: c, h: c + spread, l: c - spread, c, v: 1000 });
/** flat at 100, a clean pump to `top`, then a pullback path. */
function series({ flat = 60, pumpLen = 15, top = 130, path = [] } = {}) {
  const bars = [];
  for (let i = 0; i < flat; i++) bars.push(bar(i, 100));
  for (let k = 1; k <= pumpLen; k++) bars.push(bar(bars.length, 100 + ((top - 100) * k) / pumpLen));
  for (const c of path) bars.push(bar(bars.length, c));
  return bars;
}
const down = (from, to, n) => Array.from({ length: n }, (_, k) => from + ((to - from) * (k + 1)) / n);

test('fibRow: a clean pump in its first pullback, at the 0.5 level', () => {
  const bars = series({ path: down(130, 115, 6) });
  const r = fibRow(bars);
  assert.ok(r, 'found');
  assert.ok(Math.abs(r.pumpPct - 30.6) < 1, `pump ${r.pumpPct}`);
  assert.equal(r.atLevel, 0.5);
  assert.ok(Math.abs(levelPrice(r, 0.618) - (r.high - 0.618 * (r.high - r.low))) < 1e-9);
  assert.equal(r.next.ratio, 0.618);
});

test('fibRow: not shown before a real correction, after a new high, or when too deep', () => {
  assert.equal(fibRow(series({ path: [129] })), null, 'barely off the high');
  assert.equal(fibRow(series({ path: [...down(130, 118, 4), 131] })), null, 'new high: the correction ended');
  assert.equal(fibRow(series({ path: down(130, 102, 8) })), null, 'deeper than 88.6%: pump undone');
});

test('fibRow: small moves are not pumps', () => {
  assert.equal(fibRow(series({ top: 108, path: down(108, 104, 4) })), null);
});

test('fibRow: a pump that already had a correction is not shown (only first corrections)', () => {
  // up to 120, back to 108 (60% of the 20-point move so far), then on to 130, now pulling back
  const bars = [];
  for (let i = 0; i < 60; i++) bars.push(bar(i, 100));
  for (const c of [...down(100, 120, 8), ...down(120, 108, 4), ...down(108, 130, 8), ...down(130, 116, 5)]) bars.push(bar(bars.length, c));
  assert.equal(fibRow(bars), null);
});

test('fibRow: zigzag inside the first correction is still the first correction', () => {
  const bars = series({ path: [...down(130, 120, 4), ...down(120, 126, 3), ...down(126, 118, 3)] });
  const r = fibRow(bars);
  assert.ok(r);
  assert.ok(r.deepest > 0.35);
});

test('fibTouches: one touch per level per pump, entry at the level', () => {
  const bars = series({ path: [...down(130, 112, 10), ...down(112, 125, 6), ...down(125, 111, 6), ...Array(30).fill(111)] });
  const t = fibTouches(bars, [0.382, 0.5, 0.618]);
  const byRatio = Object.groupBy(t, (x) => x.ratio);
  assert.equal(byRatio['0.382'].length, 1);
  assert.equal(byRatio['0.5'].length, 1);
  assert.equal(byRatio['0.618'].length, 1);
  const lvl = levelPrice({ high: t[0].high, low: t[0].low }, 0.5);
  const e = byRatio['0.5'][0];
  assert.equal(e.entry, Math.min(lvl, bars[e.i].o), 'entry at the level, or the open if the candle gapped below it');
  assert.ok(byRatio['0.5'][0].i < byRatio['0.618'][0].i);
  assert.equal(FIB.levels.length, 4);
});
