import test from 'node:test';
import assert from 'node:assert/strict';
import { marketLayers, whaleLayers, whaleEntries, liqPrice, liquidationLevels, bucketLevels, findWalls, setupCheck } from '../js/indicators.js';

const bar = (o) => ({ t: 0, o: 100, h: 100.2, l: 99.8, c: 100, v: 1e6, takerBuy: 5e5, oi: 10000, ...o });

test('marketLayers: classifies all four quadrants and keeps running totals', () => {
  const bars = [
    bar({ t: 1, c: 100, oi: 10000 }),
    bar({ t: 2, c: 100.05, v: 2e6, takerBuy: 1.6e6, oi: 15000 }), // OI up, buyers → longs opened
    bar({ t: 3, c: 99, v: 1.5e6, takerBuy: 3e5, oi: 18000 }), // OI up, sellers → shorts opened
    bar({ t: 4, c: 102, v: 1e6, takerBuy: 8e5, oi: 14000 }), // OI down, buyers → shorts closed
    bar({ t: 5, c: 100.5, v: 1e6, takerBuy: 2e5, oi: 11000 }), // OI down, sellers → longs closed
  ];
  const m = marketLayers(bars);
  assert.deepEqual(m.map((x) => x.regime), [null, 'longs-opened', 'shorts-opened', 'shorts-closed', 'longs-closed']);
  assert.equal(m[1].oiDelta, 5000 * 100.05);
  assert.equal(m[1].netLongs, 5000 * 100.05);
  assert.equal(m[2].netShorts, 3000 * 99);
  assert.equal(m[3].netShorts, 3000 * 99 - 4000 * 102);
  assert.equal(m[4].netLongs, 5000 * 100.05 - 3000 * 100.5);
  // CVD: 0, +1.2M, -0.9M, +0.6M, -0.6M
  assert.deepEqual(m.map((x) => x.cvd), [0, 1.2e6, 3e5, 9e5, 3e5]);
});

test('marketLayers: absorption when one side dominates but price stays flat', () => {
  const m = marketLayers([bar({ c: 100 }), bar({ c: 100.05, v: 2e6, takerBuy: 1.6e6 }), bar({ c: 100.06, v: 1e6, takerBuy: 3e5 }), bar({ c: 101, v: 1e6, takerBuy: 9e5 })]);
  assert.deepEqual(m.map((x) => x.absorption), [null, 'buyers-absorbed', 'sellers-absorbed', null]);
});

test('marketLayers: flags a liquidation cascade', () => {
  const calm = Array.from({ length: 30 }, (_, i) => bar({ t: i, oi: 10000 + (i % 2 ? 20 : -20) }));
  const crash = bar({ t: 30, o: 100, h: 100.1, l: 95, c: 96, v: 5e6, takerBuy: 1e6, oi: 9000 });
  const m = marketLayers([...calm, crash]);
  assert.equal(m.at(-1).liq.side, 'long');
  assert.equal(Math.round(m.at(-1).liq.usd), Math.round(1020 * 96));
  assert.ok(m.slice(0, -1).every((x) => x.liq === null));
});

test('whaleLayers: closing shorts shows as a positive shift but not as long opens', () => {
  // OI falls from 10,000 to 9,000 contracts while whale long share rises from 50% to 55%.
  const bars = [bar({ oi: 10000, whaleLong: 0.5, crowdLong: 0.6 }), bar({ oi: 9000, whaleLong: 0.55, crowdLong: 0.6 })];
  const w = whaleLayers(bars);
  assert.ok(w[1].shift > 0);
  assert.equal(w[1].opensLong, 0, 'long exposure fell slightly, nothing opened');
  assert.equal(w[1].opensShort, 0);
  assert.equal(Math.round(w[1].gap), -5);
});

test('whaleLayers: a share jump with flat open interest is treated as a ranking change', () => {
  const bars = [bar({ oi: 10000, whaleLong: 0.4 }), bar({ oi: 10001, whaleLong: 0.55 })];
  const w = whaleLayers(bars);
  assert.equal(w[1].rosterChange, true);
  assert.equal(w[1].shift, 0);
  assert.equal(w[1].opensLong, 0);
});

test('whaleLayers: falls back to top-account share when position share is missing', () => {
  const w = whaleLayers([bar({ whaleLong: null, smartLong: 0.7, crowdLong: 0.5 })]);
  assert.equal(Math.round(w[0].gap), 20);
});

test('whaleEntries: weights entry price by estimated opens', () => {
  const bars = [bar({ h: 100, l: 100, c: 100 }), bar({ h: 110, l: 110, c: 110 }), bar({ h: 120, l: 120, c: 120 })];
  const whales = [{ opensLong: 0, opensShort: 0 }, { opensLong: 1, opensShort: 0 }, { opensLong: 3, opensShort: 2 }];
  const e = whaleEntries(bars, whales);
  assert.equal(e.long, (110 + 360) / 4);
  assert.equal(e.short, 120);
});

test('liqPrice: standard isolated-margin approximation', () => {
  assert.equal(liqPrice(100, 10, 'long'), 100 * (1 - 0.1 + 0.005));
  assert.equal(liqPrice(100, 10, 'short'), 100 * (1 + 0.1 - 0.005));
});

test('liquidationLevels: both sides of each new contract get levels; wicks erase them', () => {
  const bars = [
    bar({ t: 1, h: 100, l: 100, c: 100, oi: 10000 }),
    bar({ t: 2, h: 100, l: 100, c: 100, v: 1e6, takerBuy: 8e5, oi: 11000 }), // 1,000 new contracts at 100
    bar({ t: 3, h: 100.4, l: 99.6, c: 100, oi: 11000 }),
    bar({ t: 4, h: 100, l: 97.5, c: 99, oi: 11000 }), // wick to 97.5 clears long levels at 99.5 and 98.5
  ];
  const { columns, active } = liquidationLevels(bars, marketLayers(bars));
  assert.equal(columns[0].length, 0);
  assert.equal(columns[1].length, 8, '4 leverage tiers × long and short');
  assert.equal(columns[1].filter((l) => l.side === 'short').length, 4);
  // Each side carries the full increase, split across tiers.
  assert.equal(Math.round(columns[1].filter((l) => l.side === 'long').reduce((s, l) => s + l.usd, 0)), 1000 * 100);
  assert.equal(columns[2].length, 8, 'a 99.6–100.4 candle reaches neither the 100× long (99.5) nor the 100× short (100.5)');
  const longs = active.filter((l) => l.side === 'long').map((l) => l.lev).sort((a, b) => a - b);
  assert.deepEqual(longs, [10, 25]);
});

test('liquidationLevels: maxLev drops tiers a pair does not offer and reweights the rest', () => {
  const bars = [bar({ t: 1, oi: 10000 }), bar({ t: 2, v: 1e6, takerBuy: 8e5, oi: 11000 })];
  const { columns } = liquidationLevels(bars, marketLayers(bars), { maxLev: 25 });
  assert.deepEqual([...new Set(columns[1].map((l) => l.lev))].sort((a, b) => a - b), [10, 25]);
  assert.equal(Math.round(columns[1].filter((l) => l.side === 'short').reduce((s, l) => s + l.usd, 0)), 1000 * 100);
});

test('bucketLevels: groups nearby levels', () => {
  const b = bucketLevels([{ price: 100, usd: 1, side: 'long' }, { price: 100.1, usd: 2, side: 'long' }, { price: 105, usd: 3, side: 'short' }], 100, 0.25);
  assert.equal(b.length, 2);
  assert.equal(b[0].long, 3);
  assert.equal(b[1].short, 3);
});

test('findWalls: tags levels far larger than typical depth', () => {
  const bids = Array.from({ length: 40 }, (_, i) => [String(100 - i * 0.3), '10']);
  const asks = Array.from({ length: 40 }, (_, i) => [String(100.1 + i * 0.3), '10']);
  asks[5] = [asks[5][0], '200'];
  const walls = findWalls({ bids, asks });
  assert.equal(walls.length, 1);
  assert.equal(walls[0].side, 'ask');
  assert.ok(walls[0].multiple > 10);
});

test('setupCheck: recognises new longs with long whales and a short crowd', () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar({
    t: i, c: 100 + i, h: 100.5 + i, l: 99.5 + i, v: 1e6, takerBuy: 7e5, oi: 10000 + i * 200,
    whaleLong: 0.6 + i * 0.005, crowdLong: 0.35,
  }));
  const m = marketLayers(bars);
  const w = whaleLayers(bars);
  const items = setupCheck(bars, m, w);
  const byId = Object.fromEntries(items.map((x) => [x.id, x]));
  assert.equal(byId.fuel.state, 'good');
  assert.equal(byId.whales.state, 'good');
  assert.equal(byId.gap.state, 'good');
  assert.equal(items.length, 4);
});

test('setupCheck: flags a short-covering rise', () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar({ t: i, c: 100 + i, h: 100.5 + i, l: 99.5 + i, v: 1e6, takerBuy: 7e5, oi: 20000 - i * 300, whaleLong: 0.5, crowdLong: 0.5 }));
  const items = setupCheck(bars, marketLayers(bars), whaleLayers(bars));
  assert.equal(items.find((x) => x.id === 'fuel').state, 'warn');
});
