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
