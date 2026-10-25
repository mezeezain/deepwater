import test from 'node:test';
import assert from 'node:assert/strict';
import { activeIdeas, evidence, comparable, watchLevels, priceCheck, fundingHours } from '../js/ideas.js';

const H = 3_600_000;
const flat = (n, p = 100) => Array.from({ length: n }, (_, i) => ({ t: i * H, o: p, h: p + 0.5, l: p - 0.5, c: p, v: 1000, takerBuy: 500, whaleLong: 0.6, crowdLong: 0.45 }));
const sweepBar = (t) => ({ t, o: 100, h: 100.3, l: 98, c: 100.1, v: 2000, takerBuy: 1200, whaleLong: 0.6, crowdLong: 0.45 });

test('activeIdeas: a sweep on the last closed candle is an enter-now plan with exact levels', () => {
  const bars = [...flat(40), sweepBar(40 * H)];
  const ideas = activeIdeas(bars).filter((x) => x.model === 'sweep');
  assert.equal(ideas.length, 1);
  const x = ideas[0];
  assert.equal(x.state, 'enter');
  assert.equal(x.entry, 100.1);
  const risk = x.entry - x.stop;
  assert.ok(Math.abs(x.tp1 - (x.entry + 0.75 * risk)) < 1e-9);
  assert.ok(Math.abs(x.tp2 - (x.entry + 1.5 * risk)) < 1e-9);
  assert.ok(Math.abs(x.tp3 - (x.entry + 2.5 * risk)) < 1e-9);
});

test('activeIdeas: drops a setup once it is stopped, keeps it while running and moves the stop after TP1', () => {
  const bars = [...flat(40), sweepBar(40 * H)];
  const stopped = [...bars, { ...flat(1)[0], t: 41 * H, o: 100.1, l: 90 }];
  assert.equal(activeIdeas(stopped).filter((x) => x.model === 'sweep').length, 0);
  const x0 = activeIdeas(bars).find((x) => x.model === 'sweep');
  const running = [...bars, { ...flat(1)[0], t: 41 * H, o: 100.1, h: x0.tp1 + 0.01, l: 100, c: 100.2 }];
  const x = activeIdeas(running).find((y) => y.model === 'sweep');
  assert.equal(x.state, 'running');
  assert.equal(x.tp1Taken, true);
  assert.equal(x.curStop, x.entry);
});

test('activeIdeas: a market setup two candles old is no longer offered', () => {
  const bars = [...flat(40), sweepBar(40 * H), ...flat(2).map((b, k) => ({ ...b, t: (41 + k) * H }))];
  assert.equal(activeIdeas(bars).filter((x) => x.model === 'sweep').length, 0);
});

test('evidence: whale agreement, funding and costs feed the grade', () => {
  const bars = [...flat(40), sweepBar(40 * H)];
  const idea = activeIdeas(bars).find((x) => x.model === 'sweep');
  const good = (n) => Array.from({ length: n }, () => ({ model: 'sweep', side: 1, netR: 0.5, netPct: 0.6, paper: 'win', exitKind: 'target', feeR: 0.1, riskPct: 1.2 }));
  const ev = evidence(idea, { bars, trades: good(20), pooled: good(30), higherBars: null, smart: { longShare: 0.7, shortUpnl: -1000 }, funding: [{ t: 0, rate: -0.0001 }] });
  const by = Object.fromEntries(ev.checks.map((c) => [c.id, c.state]));
  assert.equal(by.whales, 'good');
  assert.equal(by.smart, 'good');
  assert.equal(by.funding, 'good');
  assert.equal(by.record, 'good');
  assert.ok(['A', 'B'].includes(ev.grade));
  const against = evidence({ ...idea, side: -1 }, { bars, trades: [], smart: { longShare: 0.7 }, funding: [{ t: 0, rate: -0.0005 }] });
  assert.equal(against.grade, 'C');
});

test('comparable: pools by setup and side, then by whale lean', () => {
  const t = (whale, netPct) => ({ model: 'sweep', side: 1, whale, netPct, netR: netPct, paper: 'win', exitKind: 'stop', feeR: 0.1, riskPct: 1 });
  const c = comparable({ model: 'sweep', side: 1 }, 'with', [t('with', 1), t('with', -1), t('against', -1), { ...t('with', 1), side: -1 }]);
  assert.equal(c.all.n, 3);
  assert.equal(c.whale.n, 2);
});

test('watchLevels and priceCheck', () => {
  const w = watchLevels(flat(40));
  assert.equal(w.low, 99.5);
  assert.equal(w.high, 100.5);
  const idea = { side: 1, entry: 100, stop: 98, tp2: 103, state: 'enter' };
  assert.equal(priceCheck(idea, 97.9).state, 'stop');
  assert.equal(priceCheck(idea, 100.8).state, 'chasing');
  assert.equal(priceCheck(idea, 100.2).state, 'ok');
});

test('fundingHours reads the payment interval from the spacing of payments', () => {
  const rows = (h, n = 6) => Array.from({ length: n }, (_, i) => ({ t: i * h * H, rate: 0.0001 }));
  assert.equal(fundingHours(rows(8)), 8);
  assert.equal(fundingHours(rows(4)), 4);
  assert.equal(fundingHours(rows(1)), 1);
  assert.equal(fundingHours([]), 8);
  assert.equal(fundingHours([{ t: 0, rate: 1 }]), 8);
});

test('evidence: the same funding rate is judged per 8 hours, so an hourly pair is not under-counted', () => {
  const bars = [...flat(40), sweepBar(40 * H)];
  const idea = activeIdeas(bars).find((x) => x.model === 'sweep');
  const hourly = (rate) => Array.from({ length: 6 }, (_, i) => ({ t: i * H, rate }));
  const eight = (rate) => Array.from({ length: 6 }, (_, i) => ({ t: i * 8 * H, rate }));
  const state = (funding) => evidence(idea, { bars, trades: [], funding }).checks.find((c) => c.id === 'funding').state;
  assert.equal(state(eight(0.0001)), 'neutral', '0.01% per 8h is mild');
  assert.equal(state(hourly(0.0001)), 'bad', '0.01% every hour is 0.08% per 8h: a real cost');
});

test('evidence: the three positioning checks count as one vote', () => {
  const bars = [...flat(40), sweepBar(40 * H)];
  const idea = activeIdeas(bars).find((x) => x.model === 'sweep');
  const ev = evidence(idea, { bars, trades: [], smart: { longShare: 0.8 }, funding: null });
  const pos = ev.checks.filter((c) => ['whales', 'trend', 'smart'].includes(c.id) && c.state === 'good').length;
  assert.ok(pos >= 2, 'several positioning checks are good');
  assert.ok(ev.good <= ev.checks.filter((c) => c.state === 'good').length - (pos - 1), 'but they add one vote');
});
