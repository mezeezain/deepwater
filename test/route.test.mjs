import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, buildHash, normalizePair, safeDecode } from '../js/route.js';

test('plain routes', () => {
  assert.equal(parseHash('#pumps').route, 'pumps');
  assert.equal(parseHash('#guide').route, 'guide');
  assert.equal(parseHash('').route, 'whales');
});

test('inherited Object properties are not routes', () => {
  for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = parseHash('#' + t);
    assert.equal(r.route, 'whales', t);
    assert.equal(r.unknown, true);
  }
});

test('malformed percent escapes do not throw', () => {
  assert.equal(safeDecode('%E0%A4%A'), null);
  assert.deepEqual(parseHash('#%E0%A4%A'), { route: 'whales', params: {}, unknown: true });
});

test('pairs, signals, liq maps', () => {
  assert.deepEqual(parseHash('#SOLUSDT'), { route: 'token', symbol: 'SOLUSDT', params: {} });
  assert.equal(parseHash('#sig-SOLUSDT-1730000000000').id, 'SOLUSDT-1730000000000');
  assert.equal(parseHash('#liqmap-BTCUSDT').symbol, 'BTCUSDT');
  assert.equal(parseHash('#liqmap-nope').route, 'whales');
  assert.equal(parseHash('#' + encodeURIComponent('币安人生USDT')).symbol, '币安人生USDT');
  assert.equal(parseHash('#sig-').route, 'whales');
});

test('lowercase and junk are unknown', () => {
  assert.equal(parseHash('#solusdt').unknown, true);
  assert.equal(parseHash('#<script>').route, 'whales');
});

test('query params', () => {
  const r = parseHash('#SOLUSDT?i=4h&i=1d');
  assert.equal(r.symbol, 'SOLUSDT');
  assert.deepEqual(r.params, { i: '4h' });
});

test('buildHash round-trips', () => {
  for (const [route, arg] of [['whales'], ['token', 'ETHUSDT'], ['signal', 'SOLUSDT-1'], ['liqmap', 'BTCUSDT']]) {
    const p = parseHash(buildHash(route, arg));
    assert.equal(p.route === 'signal' ? p.id : p.symbol ?? p.route, arg ?? route);
  }
  assert.equal(buildHash('token', 'SOLUSDT', { i: '4h' }), 'SOLUSDT?i=4h');
});

test('normalizePair', () => {
  assert.equal(normalizePair(' sol '), 'SOLUSDT');
  assert.equal(normalizePair('btc/usdt'), 'BTCUSDT');
  assert.equal(normalizePair('1000pepe'), '1000PEPEUSDT');
  assert.equal(normalizePair(''), null);
  assert.equal(normalizePair('a$b'), null);
});

import { validOverviewRow, validPositioningRow } from '../js/api.js';
test('server rows are range-checked before use', () => {
  assert.ok(validOverviewRow({ symbol: 'BTCUSDT', shown: { longShare: 0.4 } }));
  assert.ok(validOverviewRow({ symbol: 'BTCUSDT', shown: {} }));
  assert.equal(validOverviewRow({ symbol: 'BTCUSDT', shown: { longShare: 7 } }), false);
  assert.equal(validOverviewRow({ symbol: 'btc', shown: {} }), false);
  assert.equal(validOverviewRow(null), false);
  const s = [{ t: 1, long: 0.5 }];
  assert.ok(validPositioningRow({ symbol: 'ETHUSDT', whales: s, smart: s, crowd: s, oi: [{ t: 1, value: 5 }] }));
  assert.equal(validPositioningRow({ symbol: 'ETHUSDT', whales: [{ t: 1, long: 9 }], smart: s, crowd: s, oi: [] }), false);
  assert.equal(validPositioningRow({ symbol: 'ETHUSDT', whales: [], smart: s, crowd: s, oi: [] }), false);
});
