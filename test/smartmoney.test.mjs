import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOverview, pickCohort, summarize, diffSnapshots, alignToBars } from '../js/smartmoney.js';

// Flat field names, as described for the overview endpoint.
const flat = {
  success: true,
  data: {
    symbol: 'BTCUSDT',
    whaleLongTraderCount: 42, whaleShortTraderCount: 18,
    whaleLongPositionValue: '120000000', whaleShortPositionValue: '40000000',
    whaleLongAvgEntryPrice: '64000.5', whaleShortAvgEntryPrice: '68000',
    whaleLongUnrealizedPnl: '3500000', whaleShortUnrealizedPnl: '-800000',
    whaleLongProfitableRate: '71.5', whaleShortProfitableRate: '0.33',
    smartMoneyLongTraderCount: 300, smartMoneyShortTraderCount: 280,
    smartMoneyLongPositionValue: 9000000, smartMoneyShortPositionValue: 11000000,
    smartMoneyLongAvgEntryPrice: 65000, smartMoneyShortAvgEntryPrice: 66000,
    updateTime: 1730000000000,
  },
};

test('parseOverview: flat field names', () => {
  const s = parseOverview(flat, { t: 1 });
  assert.equal(s.symbol, 'BTCUSDT');
  assert.deepEqual(s.whale.long, { count: 42, usd: 120e6, entry: 64000.5, upnl: 3.5e6, winRate: 0.715 });
  assert.equal(s.whale.short.winRate, 0.33);
  assert.equal(s.smart.short.usd, 11e6);
  assert.equal(s.smart.long.upnl, null);
  assert.ok(s.unmatched.includes('updateTime'));
});

test('parseOverview: nested shape with different names', () => {
  const nested = { data: { whale: { long: { traders: 12, notional: 5e6, avgPrice: 2.5, unrealizedPnl: 1e5 }, short: { traders: 3, notional: 1e6, avgPrice: 2.8 } }, smartMoney: { long: { userCount: 50, positionValue: 2e6 }, short: { userCount: 40, positionValue: 3e6 } } } };
  const s = parseOverview(nested);
  assert.equal(s.whale.long.count, 12);
  assert.equal(s.whale.long.usd, 5e6);
  assert.equal(s.whale.long.entry, 2.5);
  assert.equal(s.whale.short.entry, 2.8);
  assert.equal(s.smart.short.count, 40);
  assert.equal(s.smart.long.usd, 2e6);
});

test('parseOverview: unrelated payload matches nothing', () => {
  const s = parseOverview({ code: '000000', data: null, success: false });
  assert.equal(pickCohort(s), null);
});

test('pickCohort: falls back to smart traders when fewer than 10 whales', () => {
  const s = parseOverview(flat);
  assert.equal(pickCohort(s), 'whale');
  s.whale.long.count = 5;
  s.whale.short.count = 4;
  assert.equal(pickCohort(s), 'smart');
});

test('summarize: long share and crowd from open interest', () => {
  const s = parseOverview(flat);
  const m = summarize(s, 'whale', 1e9);
  assert.equal(m.longShare, 0.75);
  assert.equal(m.net, 80e6);
  // Crowd longs = 1e9 − 120M, crowd shorts = 1e9 − 40M
  assert.equal(Math.round(m.crowdLongShare * 1e4), Math.round((880 / (880 + 960)) * 1e4));
});

const snap = (t, mark, L, S, EL = 100, ES = 110) => ({
  t, mark,
  whale: { long: { count: 20, usd: L, entry: EL, upnl: null, winRate: null }, short: { count: 20, usd: S, entry: ES, upnl: null, winRate: null } },
  smart: { long: { count: null, usd: null, entry: null, upnl: null, winRate: null }, short: { count: null, usd: null, entry: null, upnl: null, winRate: null } },
});

test('diffSnapshots: a price rise alone is not buying', () => {
  // Same contracts (100 long, 50 short); price 100 → 102 raises USD values.
  const d = diffSnapshots(snap(0, 100, 10000, 5000), snap(60_000, 102, 10200, 5100));
  assert.ok(Math.abs(d.move) < 1e-9);
  assert.equal(d.opensLong, 0);
  assert.equal(d.opensShort, 0);
  assert.equal(d.roster, false);
});

test('diffSnapshots: adding longs at market moves the entry as expected', () => {
  // 100 contracts at 100, add 50 at 110 → 150 contracts, entry (100·100 + 110·50)/150 = 103.33
  const d = diffSnapshots(snap(0, 100, 10000, 5000, 100), snap(60_000, 110, 16500, 5500, 103.3333));
  assert.equal(d.roster, false);
  assert.equal(Math.round(d.opensLong), 5500);
  assert.equal(d.opensShort, 0);
  assert.equal(Math.round(d.move), 5500);
});

test('diffSnapshots: closing shorts counts as a move but not as an open', () => {
  // Shorts 50 → 20 contracts at the same entry; longs unchanged.
  const d = diffSnapshots(snap(0, 100, 10000, 5000), snap(60_000, 100, 10000, 2000));
  assert.equal(d.roster, false);
  assert.equal(d.opensLong, 0);
  assert.equal(d.opensShort, 0);
  assert.equal(d.move, 3000);
});

test('diffSnapshots: entry jumping without matching trades is a roster change', () => {
  // Contracts barely change but long entry jumps from 100 to 92: a trader with a low cost basis joined.
  const d = diffSnapshots(snap(0, 100, 10000, 5000, 100), snap(60_000, 100, 10100, 5000, 92));
  assert.equal(d.roster, true);
  assert.equal(d.move, 0);
  assert.equal(d.opensLong, 0);
});

test('diffSnapshots: long gaps are not attributed', () => {
  const d = diffSnapshots(snap(0, 100, 10000, 5000), snap(60 * 60_000, 100, 20000, 5000, 100));
  assert.equal(d.reason, 'gap');
  assert.equal(d.opensLong, 0);
});

test('alignToBars: sums diffs per candle and leaves gaps empty', () => {
  const ms = 300_000;
  const bars = [0, 1, 2].map((i) => ({ t: i * ms }));
  const snaps = [snap(10_000, 100, 10000, 5000), snap(100_000, 100, 10000, 2000), snap(400_000, 100, 13000, 2000, 100)];
  const rows = alignToBars(snaps, bars, ms);
  assert.equal(rows[0].move, 3000);
  assert.equal(rows[1].move, 3000);
  assert.equal(rows[1].opensLong, 3000);
  assert.equal(rows[2].move, null, 'no snapshot in the third candle');
  assert.equal(rows[1].longShare, 13000 / 15000);
});
