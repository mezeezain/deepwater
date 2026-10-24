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
  assert.deepEqual(s.whale.long, { count: 42, qty: null, usd: 120e6, entry: 64000.5, upnl: 3.5e6, profitCount: null, winRate: 0.715 });
  assert.equal(s.whale.short.winRate, 0.33);
  assert.equal(s.smart.short.usd, 11e6);
  assert.equal(s.smart.long.upnl, null);
  assert.equal(s.sourceT, 1730000000000);
  assert.equal(s.t, 1730000000000, 'snapshot time is when Binance measured it');
  assert.equal(s.format, 'generic');
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

test('diffSnapshots: gaps longer than 36 hours are not attributed', () => {
  const d = diffSnapshots(snap(0, 100, 10000, 5000), snap(48 * 3_600_000, 100, 20000, 5000, 100));
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

// Live response from Binance's Smart Money overview (BTCUSDT, October 2026), as returned to the worker's probe.
const live = {
  code: '000000', message: null, messageDetail: null, success: true,
  data: {
    symbol: 'BTCUSDT', totalPositions: 3217896093.5099983, totalTraders: 2125, longShortRatio: 0.3283,
    longTraders: 860, longTradersQty: 9831.366, longTradersAvgEntryPrice: 86413.85249048,
    longWhales: 243, longWhalesQty: 9083.041, longWhalesAvgEntryPrice: 86835.86094697,
    shortTraders: 1265, shortTradersQty: 29948.934, shortTradersAvgEntryPrice: 76447.09686165,
    shortWhales: 501, shortWhalesQty: 29116.53, shortWhalesAvgEntryPrice: 76310.96633239,
    longProfitTraders: 172, shortProfitTraders: 806, longProfitWhales: 45, shortProfitWhales: 315,
    updateTime: 1792737409498,
  },
};

test('parseOverview: live Binance format', () => {
  const s = parseOverview(live);
  assert.equal(s.format, 'known');
  assert.equal(s.symbol, 'BTCUSDT');
  assert.equal(s.t, 1792737409498);
  assert.deepEqual(s.whale.long, { count: 243, qty: 9083.041, usd: null, entry: 86835.86094697, upnl: null, profitCount: 45, winRate: 45 / 243 });
  assert.deepEqual(s.smart.short, { count: 1265, qty: 29948.934, usd: null, entry: 76447.09686165, upnl: null, profitCount: 806, winRate: 806 / 1265 });
  assert.deepEqual(s.unmatched.sort(), ['longShortRatio', 'totalTraders']);
  assert.equal(pickCohort(s), 'whale');
});

test('summarize: prices the live format at the mark price', () => {
  const s = { ...parseOverview(live), mark: 80000 };
  const m = summarize(s);
  assert.equal(m.longUsd, 9083.041 * 80000);
  assert.equal(m.shortUsd, 29116.53 * 80000);
  assert.equal(Math.round(m.longShare * 1000), Math.round((9083.041 / (9083.041 + 29116.53)) * 1000));
  // Longs entered at 86,836 are under water at 80,000; shorts from 76,311 too.
  assert.equal(Math.round(m.longUpnl), Math.round((80000 - 86835.86094697) * 9083.041));
  assert.equal(Math.round(m.shortUpnl), Math.round(-(80000 - 76310.96633239) * 29116.53));
  assert.ok(m.longUpnl < 0 && m.shortUpnl < 0);
  // longShortRatio in the payload is the all-traders size ratio, which the parsed numbers reproduce.
  const all = summarize(s, 'smart');
  assert.equal(Math.round((all.longQty / all.shortQty) * 1e4) / 1e4, 0.3283);
});

test('diffSnapshots: live format, whales add longs at market over a day', () => {
  const a = { ...parseOverview(live), mark: 80000 };
  const b = structuredClone(a);
  b.t = a.t + 23 * 3_600_000;
  b.mark = 82000;
  // 500 BTC more long, bought around 82,000: the entry moves exactly as averaging predicts.
  const L = a.whale.long;
  b.whale.long.qty = L.qty + 500;
  b.whale.long.entry = (L.entry * L.qty + 82000 * 500) / (L.qty + 500);
  const d = diffSnapshots(a, b);
  assert.equal(d.roster, false);
  assert.equal(Math.round(d.opensLong), 500 * 82000);
  assert.equal(d.opensShort, 0);
  assert.equal(Math.round(d.move), 500 * 82000);
});

test('diffSnapshots: identical Binance updates are not counted twice', () => {
  const a = { ...parseOverview(live), mark: 80000 };
  const d = diffSnapshots(a, { ...a, mark: 81000 });
  assert.equal(d.reason, 'same update');
  assert.equal(d.move, 0);
});

test('alignToBars: positions carry forward until the next update; moves do not', () => {
  const ms = 300_000;
  const bars = [0, 1, 2, 3].map((i) => ({ t: i * ms }));
  const snaps = [snap(400_000, 100, 10000, 5000, 100)]; // one update, inside the second candle
  const rows = alignToBars(snaps, bars, ms);
  assert.equal(rows[0].net, null, 'nothing before the first snapshot');
  assert.equal(rows[1].net, 5000);
  assert.equal(rows[2].net, 5000, 'held until the next update');
  assert.equal(rows[3].longEntry, 100);
  assert.equal(rows[3].move, null, 'no move without a new update');
});
