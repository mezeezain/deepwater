import test from 'node:test';
import assert from 'node:assert/strict';
import { adx, trendAt, indicators, pivots, levels, location, radarRow, trendEvents, TREND } from '../js/trend.js';

const H = 3_600_000;
// 120 candles ranging 98–102, then a steady move of `step` per candle for `run` candles.
function series({ range = 120, run = 30, step = 0.6, wobble = 2, from = null } = {}) {
  const bars = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < range; i++) {
    const c = 100 + wobble * (2 * rnd() - 1); // choppy random range: no trend inside it
    bars.push({ t: i * H, o: c, h: c + 0.6, l: c - 0.6, c, v: 1000 });
  }
  let c = from ?? bars.at(-1)?.c ?? 100;
  for (let i = 0; i < run; i++) {
    const o = c;
    c += step;
    bars.push({ t: (range + i) * H, o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 2000 });
  }
  return bars;
}

test('adx: high in a steady trend, low in a range', () => {
  const up = adx(series({ range: 60, run: 80 }));
  assert.ok(up.adx.at(-1) > 40);
  assert.ok(up.plus.at(-1) > up.minus.at(-1));
  const flat = adx(series({ range: 140, run: 0 }));
  assert.ok(flat.adx.at(-1) < 25);
});

test('trendAt: a breakout from a range is a fresh uptrend, and stops being fresh after maxAge candles', () => {
  const bars = series({ run: 10 });
  const t = trendAt(bars, bars.length - 1);
  assert.ok(t, 'trend found');
  assert.equal(t.side, 1);
  assert.equal(t.fresh, true);
  assert.ok(t.age <= TREND.maxAge);
  assert.ok(t.movePct > 0);
  const later = series({ run: 40 });
  const t2 = trendAt(later, later.length - 1);
  assert.equal(t2.side, 1);
  assert.equal(t2.fresh, false, `age ${t2.age} is past ${TREND.maxAge}`);
  assert.equal(radarRow(later), null, 'not on the radar once old');
  assert.ok(radarRow(bars), 'fresh one is on the radar');
});

test('trendAt: mirror image for a downtrend; nothing in a pure range', () => {
  const down = series({ run: 10, step: -0.6 });
  assert.equal(trendAt(down, down.length - 1).side, -1);
  const flat = series({ run: 0, range: 160 });
  assert.equal(radarRow(flat), null);
});

test('trendAt: a cross that never leaves the old range is not a trend', () => {
  // Small drift up that stays under the range high of 102.6
  const bars = series({ run: 6, step: 0.15, wobble: 2, from: 99 });
  assert.equal(radarRow(bars), null);
});

test('pivots and levels: swing highs/lows, merged when close', () => {
  const bars = series({ range: 120, run: 0 });
  const p = pivots(bars, 0, bars.length - 1, 3);
  assert.ok(p.some((x) => x.kind === 'high') && p.some((x) => x.kind === 'low'));
  const lv = levels(bars, bars.length - 1, TREND, 1);
  // The range has one ceiling near 102.6 and one floor near 97.4: a handful of merged levels, many touches.
  assert.ok(lv.length <= 6, `got ${lv.length}`);
  assert.ok(lv.some((l) => l.touches >= 5));
});

test('location: near resistance under the old ceiling, open air above it', () => {
  const bars = series({ range: 120, run: 0 });
  // Move the last close just under the ceiling
  const ceiling = Math.max(...bars.map((b) => b.h));
  bars.push({ t: 120 * H, o: ceiling - 0.4, h: ceiling - 0.2, l: ceiling - 0.6, c: ceiling - 0.3, v: 1000 });
  for (let k = 0; k < 3; k++) bars.push({ t: (121 + k) * H, o: ceiling - 0.3, h: ceiling - 0.2, l: ceiling - 0.5, c: ceiling - 0.3, v: 1000 });
  const i = bars.length - 1;
  assert.equal(location(bars, i, 1, TREND, 1).zone, 'resistance');
  const up = series({ run: 12 });
  const j = up.length - 1;
  assert.equal(location(up, j, 1, TREND, indicators(up).atr[j]).zone, 'open', 'above every swing high');
});

test('trendEvents: one event per trend, at the first candle that passes', () => {
  const bars = series({ run: 30 });
  const { events } = trendEvents(bars);
  assert.equal(events.length, 1);
  assert.equal(events[0].side, 1);
  assert.ok(events[0].age <= TREND.maxAge);
});
