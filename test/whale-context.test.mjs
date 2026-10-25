import test from 'node:test';
import assert from 'node:assert/strict';
import { whaleContext } from '../js/pump.js';

// BTC whales from the live Smart Money check: 9,111 BTC long from 86,817.56, 29,054 BTC short from 76,300.79.
const btc = { cohort: 'whale', longShare: 9111 / (9111 + 29054), longQty: 9111, shortQty: 29054, longEntry: 86817.56, shortEntry: 76300.79, t: 1000 };

test('whaleContext: whale shorts under water above their entry', () => {
  const w = whaleContext(btc, 80855, 1000 + 3_600_000);
  assert.equal(w.shortsUnderwater, true);
  assert.equal(Math.round(w.shortUpnl), Math.round((76300.79 - 80855) * 29054));
  assert.equal(w.leaning, 'short');
  assert.equal(w.agrees, false, 'losing shorts are reported but do not count as agreement');
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
