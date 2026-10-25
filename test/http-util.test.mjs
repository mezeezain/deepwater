import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrigins, corsOrigin, rateLimiter, clientKey, DEFAULT_ORIGINS } from '../worker/http-util.mjs';

test('origins', () => {
  const list = parseOrigins('https://a.io/, http://localhost:8000');
  assert.deepEqual(list, ['https://a.io', 'http://localhost:8000']);
  assert.equal(corsOrigin(list, 'https://a.io'), 'https://a.io');
  assert.equal(corsOrigin(list, 'https://evil.io'), null);
  assert.equal(corsOrigin(list, undefined), null);
  assert.equal(corsOrigin(['*'], 'https://x.io'), '*');
  assert.ok(parseOrigins('').length === DEFAULT_ORIGINS.split(',').length);
});

test('rate limiter resets each minute and is per key', () => {
  let t = 0;
  const l = rateLimiter(2, () => t);
  assert.ok(l.allow('a') && l.allow('a'));
  assert.equal(l.allow('a'), false);
  assert.ok(l.allow('b'));
  assert.ok(l.retryAfter() >= 1);
  t = 60_001;
  assert.ok(l.allow('a'));
});

test('client key only trusts forwarded header behind our proxy', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientKey(req, true), '1.2.3.4');
  assert.equal(clientKey(req, false), '127.0.0.1');
});
