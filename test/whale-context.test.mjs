import test from 'node:test';
import assert from 'node:assert/strict';
import { whaleContext } from '../js/engine.js';
import { Catcher } from '../js/catcher.js';

// BTC whales from the live Smart Money check: 9,111 BTC long from 86,817.56, 29,054 BTC short from 76,300.79.
const btc = { cohort: 'whale', longShare: 9111 / (9111 + 29054), longQty: 9111, shortQty: 29054, longEntry: 86817.56, shortEntry: 76300.79, t: 1000 };

test('whaleContext: whale shorts under water above their entry', () => {
  const w = whaleContext(btc, 80855, 1000 + 3_600_000);
  assert.equal(w.shortsUnderwater, true);
  assert.equal(Math.round(w.shortUpnl), Math.round((76300.79 - 80855) * 29054));
  assert.equal(w.leaning, 'short');
  assert.equal(w.agrees, false, 'losing shorts are reported but do not count: after a pump nearly every short is under water');
  assert.equal(w.nearLongEntry, false);
  assert.equal(w.ageH, 1);
});

test('whaleContext: below the short entry with whales short, bias disagrees', () => {
  const w = whaleContext(btc, 75000);
  assert.equal(w.shortsUnderwater, false);
  assert.equal(w.agrees, false);
});

test('whaleContext: near the whale long entry', () => {
  const w = whaleContext({ ...btc, longShare: 0.7 }, 86000);
  assert.equal(w.nearLongEntry, true);
  assert.equal(w.leaning, 'long');
  assert.equal(w.agrees, true);
});

test('whaleContext: no summary, no context', () => {
  assert.equal(whaleContext(null, 100), null);
  assert.equal(whaleContext({ longShare: null }, 100), null);
});

// These tests are about whale context, not the trigger, so they use a small lift-off band
// that the BTC-sized prices below can pass (the default is +27% off the 24h low).
const SMALL_LIFT = { minRise: 4.5, maxRise: 18, minImpulse: 1.5 };

// A catcher with one pair that passes every gate, to check how whale context changes the outcome.
function rig({ whaleLookup, requireWhaleBias = false }) {
  const saved = [];
  const source = {
    async getContext() {
      const quiet = Array.from({ length: 30 }, () => ({ v: 100, takerBuy: 50 }));
      const burst = Array.from({ length: 5 }, () => ({ v: 400, takerBuy: 280 }));
      return { klines: [...quiet, ...burst], oiChange: 3, whaleLong: 0.7, crowdLong: 0.35 };
    },
  };
  const c = new Catcher({ source, store: { load: () => [], save: (s) => saved.push(s) }, cfg: { requireWhaleBias, ...SMALL_LIFT }, whaleLookup, now: () => 1_000_000 });
  c.tickers.set('TESTUSDT', { symbol: 'TESTUSDT', price: 80855, low24h: 76000 });
  c.seeded.set('TESTUSDT', 79000); // +2.3% in 5 minutes, +6.4% off the 24h low
  c.candidates.set('TESTUSDT', { symbol: 'TESTUSDT', t: 0, checks: null, pass: false });
  return c;
}

test('catcher: alerts carry whale context', async () => {
  const c = rig({ whaleLookup: async () => btc });
  await c.check('TESTUSDT');
  assert.equal(c.signals.length, 1);
  assert.equal(c.signals[0].whale.shortsUnderwater, true);
});

test('catcher: whale filter is off by default', async () => {
  const c = rig({ whaleLookup: async () => ({ ...btc, longShare: 0.2 }), requireWhaleBias: false });
  c.tickers.get('TESTUSDT').price = 75500; // below the whale short entry: bias disagrees
  c.tickers.get('TESTUSDT').low24h = 71000;
  c.seeded.set('TESTUSDT', 73800);
  await c.check('TESTUSDT');
  assert.equal(c.signals.length, 1);
  assert.equal(c.signals[0].whale.agrees, false);
});

test('catcher: whale filter holds back alerts when switched on and bias disagrees', async () => {
  const c = rig({ whaleLookup: async () => ({ ...btc, longShare: 0.2 }), requireWhaleBias: true });
  c.tickers.get('TESTUSDT').price = 75500;
  c.tickers.get('TESTUSDT').low24h = 71000;
  c.seeded.set('TESTUSDT', 73800);
  await c.check('TESTUSDT');
  assert.equal(c.signals.length, 0);
  const cand = c.candidates.get('TESTUSDT');
  assert.equal(cand.checks.at(-1).id, 'whale');
  assert.equal(cand.checks.at(-1).ok, false);
});

test('catcher: no whale data never blocks an alert, even with the filter on', async () => {
  const c = rig({ whaleLookup: async () => null, requireWhaleBias: true });
  await c.check('TESTUSDT');
  assert.equal(c.signals.length, 1);
  assert.equal(c.signals[0].whale, null);
});

test('catcher: a failing whale lookup never blocks an alert', async () => {
  const c = rig({ whaleLookup: async () => { throw new Error('server down'); } });
  await c.check('TESTUSDT');
  assert.equal(c.signals.length, 1);
});
