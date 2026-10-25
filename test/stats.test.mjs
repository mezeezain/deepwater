import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilson, bootstrapMean, quantile, rng } from '../js/stats.js';

test('wilson interval', () => {
  assert.equal(wilson(0, 0), null);
  const [lo, hi] = wilson(5, 10);
  assert.ok(lo > 0.23 && lo < 0.25 && hi > 0.75 && hi < 0.77, `${lo} ${hi}`);
  const [l2, h2] = wilson(10, 10);
  assert.ok(h2 === 1 && l2 > 0.6);
  const [l3, h3] = wilson(0, 10);
  assert.ok(l3 === 0 && h3 < 0.4);
});

test('bootstrap interval is deterministic, brackets the mean, and refuses tiny samples', () => {
  assert.equal(bootstrapMean([1, 2, 3]), null);
  const v = [1, -2, 3, 0.5, -1, 2, 4, -3, 1.5, 0];
  const a = bootstrapMean(v);
  const b = bootstrapMean(v);
  assert.deepEqual(a, b);
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  assert.ok(a[0] < mean && mean < a[1]);
  assert.ok(a[1] - a[0] > 0.5);
});

test('rng and quantile', () => {
  const r = rng(1);
  const xs = Array.from({ length: 100 }, r);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([], 0.5), null);
});
