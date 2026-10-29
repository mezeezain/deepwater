import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSetupAlerts, parseSetupConfig, message } from '../worker/setup-alerts.mjs';

const H = 3_600_000;
const NOW = 1000 * H + 30_000; // 30 s after an hourly close
// 40 flat hourly candles, then a sweep reclaim on the last closed one (Binance kline arrays).
function klines() {
  const start = NOW - 30_000 - 41 * H;
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push([start + i * H, '100', '100.5', '99.5', '100', '0', 0, '1000', 0, '0', '500', '0']);
  rows.push([start + 40 * H, '100', '100.3', '98', '100.1', '0', 0, '2000', 0, '0', '1200', '0']);
  return rows;
}
const get = async (path) => (path === '/fapi/v1/klines' ? klines() : []);

function run(sentFile) {
  const sent = [];
  const stop = startSetupAlerts({
    get,
    priceFor: () => 100.1,
    smartFor: async () => null,
    send: async (text) => sent.push(text),
    log: () => {},
    sentFile,
    cfg: { pairs: ['BTCUSDT'], frames: ['1h'], grades: ['A', 'B', 'C'] },
    site: 'https://example.org/',
    now: () => NOW,
  });
  return { sent, stop };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test('setup alerts: first run notes live setups silently, later runs send only new ones, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-'));
  const file = join(dir, 'sent.json');
  const a = run(file);
  await settle();
  a.stop();
  assert.equal(a.sent.length, 0, 'nothing remembered yet: seed without sending');
  const seeded = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(Object.keys(seeded).some((k) => k.startsWith('BTCUSDT|1h|sweep|1|')));

  writeFileSync(file, JSON.stringify({ 'OTHER|1h|sweep|1|1': NOW }));
  const b = run(file);
  await settle();
  b.stop();
  assert.ok(b.sent.length >= 1, 'a setup not sent before goes out');
  assert.match(b.sent[0], /BTC LONG/);
  assert.match(b.sent[0], /Entry <code>100\.1<\/code>/);
  assert.match(b.sent[0], /#ideas/);

  const c = run(file);
  await settle();
  c.stop();
  assert.equal(c.sent.length, 0, 'never sent twice, also across restarts');
});

test('setup alerts: config from the environment', () => {
  const d = parseSetupConfig({});
  assert.deepEqual(d, { on: true, pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], frames: ['15m', '1h', '4h'], grades: ['A', 'B'] });
  const c = parseSetupConfig({ SETUP_PAIRS: 'doge, pepeusdt,a,b,c,d', SETUP_FRAMES: '1h,1w', SETUP_GRADES: 'a', SETUP_ALERTS: 'off' });
  assert.equal(c.on, false);
  assert.deepEqual(c.pairs, ['DOGEUSDT', 'PEPEUSDT', 'AUSDT', 'BUSDT', 'CUSDT']);
  assert.deepEqual(c.frames, ['1h']);
  assert.deepEqual(c.grades, ['A']);
});

test('setup alerts: message escapes text and shows a limit order expiry', () => {
  const x = {
    model: 'retest', side: -1, symbol: 'ETHUSDT', tf: '4h', state: 'limit', expiresT: Date.UTC(2026, 9, 29, 12, 0),
    entry: 2000, stop: 2040, tp1: 1970, tp2: 1940, tp3: null,
    ev: { grade: 'B', checks: [{ state: 'good', label: 'Funding <x>', detail: 'shorts get paid' }] },
    hist: { all: { n: 12, netWin: 0.5, expR: 0.1 } },
  };
  const text = message(x, ['ETHUSDT']);
  assert.match(text, /ETH SHORT/);
  assert.match(text, /valid until 12:00 UTC/);
  assert.match(text, /Funding &lt;x&gt;/);
  assert.match(text, /small sample/);
});
