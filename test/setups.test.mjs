import test from 'node:test';
import assert from 'node:assert/strict';
import { atr, superTrend, mfi, findSetups, simulate, whaleTag, summarizeTrades, runLab, LAB_DEFAULTS, COSTS } from '../js/setups.js';

const H = 3_600_000;
const flat = (n, p = 100) => Array.from({ length: n }, (_, i) => ({ t: i * H, o: p, h: p + 0.5, l: p - 0.5, c: p, v: 1000, takerBuy: 500 }));
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

test('atr: Wilder average of true range', () => {
  const a = atr(flat(30), 14);
  assert.equal(a[12], null);
  assert.equal(a[13], 1);
  assert.equal(a[29], 1);
});

test('superTrend flips when price breaks the band', () => {
  const bars = flat(30);
  for (let i = 30; i < 45; i++) bars.push({ t: i * H, o: 100 - (i - 29), h: 100.5 - (i - 29), l: 99.5 - (i - 29) * 1.2, c: 100 - (i - 29) * 1.1, v: 1000, takerBuy: 300 });
  const st = superTrend(bars);
  assert.equal(st.dir.at(-1), -1);
  assert.ok(st.dir.slice(0, 30).every((d) => d == null || d === 1));
});

test('mfi: all rising flow gives 100', () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ h: 101 + i, l: 99 + i, c: 100 + i, v: 10 }));
  assert.equal(mfi(bars)[19], 100);
});

test('sweep reclaim: wick under the 19-bar low, close back inside, buyers, volume', () => {
  const bars = flat(40);
  bars.push({ t: 40 * H, o: 100, h: 100.3, l: 98, c: 100.1, v: 2000, takerBuy: 1200 });
  const s = findSetups(bars).filter((x) => x.model === 'sweep');
  assert.equal(s.length, 1);
  assert.equal(s[0].side, 1);
  assert.equal(round(s[0].stop), round(98 - 0.5 * atr(bars, 14)[40]));
  // Sellers in control: no long sweep.
  bars[40] = { ...bars[40], takerBuy: 900 };
  assert.equal(findSetups(bars).filter((x) => x.model === 'sweep').length, 0);
});

test('simulate: paper counts TP1 as a win even when the rest is stopped at entry', () => {
  const bars = flat(3);
  const setup = { model: 'sweep', side: 1, i: 0, entryType: 'market', stop: 98 };
  // Entry at 100 (next open), risk 2: TP1 = 101.5, target = 103.
  bars[1] = { t: H, o: 100, h: 101.6, l: 99.9, c: 101, v: 1, takerBuy: 0.5 };
  bars[2] = { t: 2 * H, o: 101, h: 101.2, l: 99.8, c: 99.9, v: 1, takerBuy: 0.5 };
  const tr = simulate(bars, setup);
  assert.equal(tr.paper, 'win');
  assert.equal(tr.exitKind, 'breakeven');
  const gross = 0.5 * 1.5; // half at +1.5%, half at 0
  const fees = COSTS.taker + 0.5 * COSTS.maker + 0.5 * (COSTS.taker + COSTS.stopSlip);
  assert.equal(round(tr.netPct), round(gross - fees));
  assert.equal(round(tr.netR), round((gross - fees) / 2));
});

test('simulate: a candle touching stop and target counts as stopped', () => {
  const bars = flat(3);
  bars[1] = { t: H, o: 100, h: 104, l: 97, c: 100, v: 1, takerBuy: 0.5 };
  const tr = simulate(bars, { model: 'sweep', side: 1, i: 0, entryType: 'market', stop: 98 });
  assert.equal(tr.paper, 'loss');
  assert.equal(tr.exitKind, 'stop');
  assert.ok(tr.netR < -1, 'costs make a full stop worse than -1R');
});

test('simulate: a limit touched but not traded through does not fill', () => {
  const bars = flat(12, 105);
  for (const b of bars) b.l = 100.01; // touches 100.01, never 100 - 0.02%
  const s = { model: 'retest', side: 1, i: 0, entryType: 'limit', level: 100, stopAtr: 1.5 };
  assert.equal(simulate(bars, s).filled, false);
  bars[3] = { ...bars[3], l: 99.9 };
  const tr = simulate(bars, s);
  assert.equal(tr.filled, true);
  assert.equal(tr.entry, 100);
});

test('simulate: funding is charged to longs when positive', () => {
  const bars = flat(60);
  const tr = simulate(bars, { model: 'sweep', side: 1, i: 0, entryType: 'market', stop: 95 }, LAB_DEFAULTS, [{ t: 5 * H, rate: 0.001 }]);
  assert.equal(tr.exitKind, 'timeout');
  assert.equal(round(tr.fundingPct), -0.1);
});

test('whaleTag: gap is signed for the trade side; no data before positioning history', () => {
  const bars = [{ whaleLong: 0.6, crowdLong: 0.45 }];
  assert.equal(whaleTag(bars, 0, 1).whale, 'with');
  assert.equal(whaleTag(bars, 0, -1).whale, 'against');
  assert.equal(whaleTag([{ whaleLong: null, crowdLong: null }], 0, 1).whale, 'none');
});

test('summarizeTrades: paper vs net win, profit factor, expectancy', () => {
  const t = (netR, paper) => ({ netR, netPct: netR, paper, exitKind: 'stop', feeR: 0.1, riskPct: 1 });
  const s = summarizeTrades([t(1.4, 'win'), t(0.2, 'win'), t(-0.05, 'win'), t(-1.1, 'loss')]);
  assert.equal(s.paperWin, 0.75);
  assert.equal(s.netWin, 0.5);
  assert.equal(round(s.pf), round(1.6 / 1.15));
  assert.ok(Math.abs(s.expR - 0.45 / 4) < 1e-9);
});

test('runLab: one position per setup type at a time, unfilled retests counted', () => {
  const bars = flat(200);
  for (let i = 60; i < 200; i += 20) bars[i] = { ...bars[i], l: 98, c: 100.1, v: 3000, takerBuy: 2000 };
  const { trades } = runLab(bars);
  const sweeps = trades.filter((x) => x.model === 'sweep');
  assert.ok(sweeps.length >= 2);
  for (let k = 1; k < sweeps.length; k++) assert.ok(sweeps[k].entryT > sweeps[k - 1].exitT);
});

// ---- candidate quality filters

import { choppiness, FILTERS } from '../js/setups.js';

const withFilters = (filters) => ({ ...LAB_DEFAULTS, filters });
const sweepAt = (t, p = 100) => ({ t, o: p, h: p + 0.3, l: p - 2, c: p + 0.1, v: 2000, takerBuy: 1200 });

test('filters: only the costs filter is on by default', () => {
  assert.deepEqual(LAB_DEFAULTS.filters, { costs: true });
  const bars = [...flat(40), sweepAt(40 * H)]; // a wide stop: costs don't matter, so the result is unchanged
  assert.deepEqual(findSetups(bars), findSetups(bars, withFilters({})));
  assert.deepEqual(Object.keys(FILTERS).sort(), ['chop', 'costs', 'sweepCandle', 'trend', 'whales']);
});

test('filters: trend keeps a long sweep above a rising 200 EMA and drops it below a falling one', () => {
  const up = Array.from({ length: 260 }, (_, i) => { const p = 50 + i * 0.2; return { t: i * H, o: p, h: p + 0.5, l: p - 0.5, c: p, v: 1000, takerBuy: 500 }; });
  const pUp = up.at(-1).c;
  // Flatten the last 20 candles so the 19-bar low sits just below price.
  const tail = Array.from({ length: 20 }, (_, k) => ({ t: (260 + k) * H, o: pUp, h: pUp + 0.5, l: pUp - 0.5, c: pUp, v: 1000, takerBuy: 500 }));
  const barsUp = [...up, ...tail, sweepAt(280 * H, pUp)];
  assert.equal(findSetups(barsUp, withFilters({ trend: true })).filter((s) => s.model === 'sweep' && s.side === 1).length, 1);
  const down = Array.from({ length: 260 }, (_, i) => { const p = 150 - i * 0.2; return { t: i * H, o: p, h: p + 0.5, l: p - 0.5, c: p, v: 1000, takerBuy: 500 }; });
  const pDn = down.at(-1).c;
  const tail2 = Array.from({ length: 20 }, (_, k) => ({ t: (260 + k) * H, o: pDn, h: pDn + 0.5, l: pDn - 0.5, c: pDn, v: 1000, takerBuy: 500 }));
  const barsDn = [...down, ...tail2, sweepAt(280 * H, pDn)];
  assert.equal(findSetups(barsDn).filter((s) => s.model === 'sweep' && s.side === 1).length, 1, 'found without the filter');
  assert.equal(findSetups(barsDn, withFilters({ trend: true })).filter((s) => s.model === 'sweep' && s.side === 1).length, 0);
});

test('filters: clean sweep candle rejects a deep wick or a weak close', () => {
  const ok = [...flat(40), { ...sweepAt(40 * H), l: 98.8 }]; // wick 0.7 below the low: under 1 ATR
  assert.equal(findSetups(ok, withFilters({ sweepCandle: true })).filter((s) => s.model === 'sweep').length, 1);
  const deep = [...flat(40), { ...sweepAt(40 * H), l: 95 }]; // wick 4.5 below the low, ATR about 1
  assert.equal(findSetups(deep, withFilters({ sweepCandle: true })).filter((s) => s.model === 'sweep').length, 0);
  const weak = [...flat(40), { ...sweepAt(40 * H), h: 103, c: 99.6 }]; // closes in the lower part of its range
  assert.equal(findSetups(weak, withFilters({ sweepCandle: true })).filter((s) => s.model === 'sweep').length, 0);
});

test('filters: costs drops setups with a stop too tight for fees', () => {
  // Tiny ranges: ATR 0.02 on a 100 price, so the stop is about 0.03% away and fees eat most of 1R.
  const tight = Array.from({ length: 40 }, (_, i) => ({ t: i * H, o: 100, h: 100.01, l: 99.99, c: 100, v: 1000, takerBuy: 500 }));
  tight.push({ t: 40 * H, o: 100, h: 100.005, l: 99.98, c: 100.002, v: 2000, takerBuy: 1200 });
  assert.equal(findSetups(tight, withFilters({})).filter((s) => s.model === 'sweep').length, 1);
  assert.equal(findSetups(tight, withFilters({ costs: true })).filter((s) => s.model === 'sweep').length, 0);
});

test('filters: whales drops a setup when top traders lean against it', () => {
  const bars = [...flat(40), sweepAt(40 * H)].map((b) => ({ ...b, whaleLong: 0.4, crowdLong: 0.6 }));
  assert.equal(findSetups(bars, withFilters({ whales: true })).filter((s) => s.model === 'sweep').length, 0);
  const agree = bars.map((b) => ({ ...b, whaleLong: 0.7, crowdLong: 0.5 }));
  assert.equal(findSetups(agree, withFilters({ whales: true })).filter((s) => s.model === 'sweep').length, 1);
});

test('choppiness: sideways is high, a steady trend is low', () => {
  const side = Array.from({ length: 30 }, (_, i) => ({ h: 101 + (i % 2), l: 99 - (i % 2), c: 100 + (i % 2 ? 1 : -1) }));
  const trend = Array.from({ length: 30 }, (_, i) => ({ h: 100 + i + 0.6, l: 100 + i - 0.6, c: 100 + i + 0.5 }));
  assert.ok(choppiness(side).at(-1) > 61);
  assert.ok(choppiness(trend).at(-1) < 40);
});
