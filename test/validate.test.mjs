import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanServerUrl, num } from '../js/validate.js';

test('server URLs', () => {
  assert.equal(cleanServerUrl('https://whales.example.com/'), 'https://whales.example.com');
  assert.equal(cleanServerUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(cleanServerUrl('http://127.0.0.1:8788/'), 'http://127.0.0.1:8788');
  assert.equal(cleanServerUrl('http://example.com'), null);
  assert.equal(cleanServerUrl('javascript:alert(1)'), null);
  assert.equal(cleanServerUrl('https://user:pw@example.com'), null);
  assert.equal(cleanServerUrl('nonsense'), null);
  assert.equal(cleanServerUrl(''), null);
});

test('num', () => {
  assert.equal(num('1,5'), 1.5);
  assert.equal(num(' 2 '), 2);
  assert.equal(num('1e3'), 1000);
  assert.ok(Number.isNaN(num('')));
  assert.ok(Number.isNaN(num('abc')));
  assert.ok(Number.isNaN(num('1.2.3')));
  assert.ok(Number.isNaN(num(NaN)));
});

import { calc, problems } from '../js/views/calculator.js';
test('calculator problems', () => {
  const ok = { side: 'long', entry: 100, exit: 110, margin: 50, leverage: 10, feeRate: 0.0005, mmr: 0.004 };
  assert.deepEqual(problems(ok), []);
  assert.equal(problems({ ...ok, entry: 0 }).length, 1);
  assert.equal(problems({ ...ok, leverage: 200 }).length, 1);
  assert.ok(problems({ ...ok, leverage: 125, mmr: 0.01 })[0].includes('liquidated on entry'));
  assert.ok(problems({ ...ok, entry: NaN }).length >= 1);
  const r = calc(ok);
  assert.ok(r.liq < 100 && r.liq > 85);
});

import { liquidationPrice } from '../js/views/calculator.js';
test('cross margin liquidation', () => {
  const base = { side: 'long', entry: 100, exit: 110, margin: 100, leverage: 10, feeRate: 0.0005, mmr: 0.004 };
  const iso = calc({ ...base, marginMode: 'isolated' });
  assert.ok(Math.abs(iso.liq - (100 * 0.9) / 0.996) < 1e-9, 'isolated formula unchanged');
  const cross = calc({ ...base, marginMode: 'cross', balance: 400 });
  assert.ok(cross.liq < iso.liq, 'more balance, lower liquidation price for a long');
  // qty = 10. balance 400: (10*100 - 400)/(10*0.996)
  assert.ok(Math.abs(cross.liq - 600 / 9.96) < 1e-9);
  const same = calc({ ...base, marginMode: 'cross', balance: 100 });
  assert.ok(Math.abs(same.liq - iso.liq) < 1e-9, 'cross with balance equal to margin matches isolated');
  const short = calc({ ...base, side: 'short', marginMode: 'cross', balance: 400 });
  assert.ok(short.liq > 100 && short.liq > calc({ ...base, side: 'short' }).liq);
  assert.ok(calc({ ...base, marginMode: 'cross', balance: 5000 }).noLiq, 'a long backed by more than its notional cannot be liquidated');
  assert.equal(liquidationPrice({ side: 'long', entry: 100, qty: 1, backing: 500, mmr: 0.004 }), 0);
  assert.ok(problems({ ...base, marginMode: 'cross', balance: 50 }).some((m) => m.includes('balance must cover')));
  assert.deepEqual(problems({ ...base, marginMode: 'cross', balance: 400 }), []);
});
