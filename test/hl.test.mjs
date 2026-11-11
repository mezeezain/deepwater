import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRow, pickTraders, pickControl, tooActive, roundTrips, traderStats, styleOf, curveStats } from '../js/hl.js';

const addr = (n) => `0x${String(n).padStart(40, '0')}`;
const row = (n, equity, week, month, allTime, vlm = 1e6) => ({
  ethAddress: addr(n), accountValue: String(equity),
  windowPerformances: [
    ['day', { pnl: '0', roi: '0', vlm: '0' }],
    ['week', { pnl: String(week), roi: '0.01', vlm: String(vlm) }],
    ['month', { pnl: String(month), roi: String(month / equity), vlm: String(vlm) }],
    ['allTime', { pnl: String(allTime), roi: '1', vlm: String(vlm) }],
  ],
});

let tid = 1;
const fill = (coin, side, px, sz, startPosition, time, { closedPnl = 0, fee = 0, crossed = true } = {}) => ({
  coin, side, px: String(px), sz: String(sz), startPosition: String(startPosition), time, closedPnl: String(closedPnl), fee: String(fee), crossed, tid: tid++, oid: tid,
});
const H = 3_600_000;

test('parseRow turns the leaderboard strings into numbers', () => {
  const r = parseRow(row(1, 250000, 10, 20, 30));
  assert.equal(r.address, addr(1));
  assert.equal(r.equity, 250000);
  assert.equal(r.month.pnl, 20);
  assert.equal(r.allTime.pnl, 30);
});

test('pickTraders wants a hand-sized account that was already a winner before this month', () => {
  const rows = [
    row(1, 500_000, 10_000, 80_000, 2_000_000), // passes
    row(2, 5_000, 10_000, 90_000, 2_000_000), // account too small
    row(3, 500_000, 10_000, 99_000, 150_000), // all-time profit too small
    row(4, 500_000, -5_000, 99_000, 2_000_000), // losing week
    row(5, 500_000, 10_000, -1, 2_000_000), // losing month
    row(6, 900_000, 10_000, 120_000, 3_000_000), // passes, bigger record
    row(8, 50_000_000, 10_000, 120_000, 9_000_000), // a fund, not a person
    row(9, 500_000, 10_000, 400_000, 450_000), // nearly all of it made this month
    { ethAddress: 'not-an-address', accountValue: '500000', windowPerformances: row(7, 1, 1, 1, 1).windowPerformances },
  ];
  assert.deepEqual(pickTraders(rows).map((r) => r.address), [addr(6), addr(1)]);
  assert.deepEqual(pickTraders(rows, { sort: 'roi' }).map((r) => r.address), [addr(1), addr(6)]);
  assert.deepEqual(pickTraders(rows, { sort: 'pnl' }).map((r) => r.address), [addr(6), addr(1)]);
  assert.equal(pickTraders(rows, { top: 1 }).length, 1);
  assert.equal(pickTraders(rows, { maxEquity: 1e9 }).length, 3);
});

test('pickControl samples same-size accounts and leaves the picks out', () => {
  const rows = [row(1, 500_000, 1, 1, 1), row(2, 500_000, -1, -1, -1), row(3, 10, 1, 1, 1), row(4, 200_000, 0, 0, 0), row(5, 9e7, 0, 0, 0)];
  const c = pickControl(rows, [addr(1)], 10, undefined, () => 0.5);
  assert.deepEqual(c.map((r) => r.address).sort(), [addr(2), addr(4)]);
});

test('tooActive spots a bot from one full page of fills', () => {
  const page = (n, spanDays) => Array.from({ length: n }, (_, i) => ({ time: (i / (n - 1)) * spanDays * 24 * H }));
  assert.equal(tooActive(page(2000, 2)), true); // 1,000 fills a day
  assert.equal(tooActive(page(2000, 40)), false); // 50 a day
  assert.equal(tooActive(page(300, 0.1)), false); // a short burst, not a full page
});

test('roundTrips: entry, an add, a partial exit and the close make one trade', () => {
  const trips = roundTrips([
    fill('BTC', 'B', 100, 1, 0, 0, { fee: 0.1 }),
    fill('BTC', 'B', 110, 1, 1, 1 * H, { fee: 0.1 }), // added higher: adding to a winner
    fill('BTC', 'A', 120, 1, 2, 2 * H, { closedPnl: 15, fee: 0.1 }),
    fill('BTC', 'A', 130, 1, 1, 3 * H, { closedPnl: 25, fee: 0.1 }),
  ]);
  assert.equal(trips.length, 1);
  const t = trips[0];
  assert.equal(t.side, 1);
  assert.equal(t.holdMs, 3 * H);
  assert.equal(t.entryNotional, 210);
  assert.ok(Math.abs(t.pnl - 39.6) < 1e-9);
  assert.deepEqual([t.adds, t.addWith, t.addAgainst], [1, 1, 0]);
});

test('roundTrips: a short averaged into a loser, and a flip opens a new trade', () => {
  const trips = roundTrips([
    fill('ETH', 'A', 100, 1, 0, 0),
    fill('ETH', 'A', 110, 1, -1, H), // price rose against the short, sold more
    fill('ETH', 'B', 105, 3, -2, 2 * H, { closedPnl: 0 }), // closes 2, flips to long 1
    fill('ETH', 'A', 115, 1, 1, 5 * H, { closedPnl: 10 }),
  ]);
  assert.equal(trips.length, 2);
  assert.deepEqual([trips[0].side, trips[0].addAgainst, trips[0].addWith], [-1, 1, 0]);
  assert.deepEqual([trips[1].side, trips[1].entryNotional, trips[1].holdMs, trips[1].pnl], [1, 105, 3 * H, 10]);
});

test('roundTrips skips positions opened before the window and ignores spot', () => {
  const trips = roundTrips([
    fill('SOL', 'A', 50, 5, 5, 0, { closedPnl: 100 }), // closing something we never saw open
    fill('@107', 'B', 1, 100, 0, 1),
    fill('PURR/USDC', 'A', 1, 100, 100, 2),
    fill('SOL', 'B', 40, 1, 0, H),
    fill('SOL', 'A', 44, 1, 1, 2 * H, { closedPnl: 4 }),
  ]);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].pnl, 4);
});

test('traderStats measures win rate, payoff, maker share, funding and leverage', () => {
  const fills = [];
  // 30 day trades on BTC: 12 winners of +6, 18 losers of -2, each held 4 hours, entered with resting orders.
  for (let i = 0; i < 30; i++) {
    const t = i * 24 * H, win = i % 5 < 2;
    fills.push(fill('BTC', 'B', 100, 1, 0, t, { crossed: false }));
    fills.push(fill('BTC', 'A', win ? 106 : 98, 1, 1, t + 4 * H, { closedPnl: win ? 6 : -2, crossed: true }));
  }
  const s = traderStats({
    fills,
    funding: [{ time: 1, delta: { usdc: '-3' } }, { time: 2, delta: { usdc: '1' } }],
    weekPnl: 10,
    state: { marginSummary: { accountValue: '1000' }, assetPositions: [{ position: { szi: '2', positionValue: '2000' } }, { position: { szi: '-1', positionValue: '500' } }, { position: { szi: '0', positionValue: '0' } }] },
  });
  assert.equal(s.trips, 30);
  assert.equal(s.winRate, 0.4);
  assert.equal(s.payoff, 3);
  assert.equal(s.medianHoldMs, 4 * H);
  assert.equal(s.longShare, 1);
  assert.equal(s.realized, 36);
  assert.equal(s.funding, -2);
  assert.equal(s.leverage, 2.5);
  assert.equal(s.openPositions, 2);
  assert.equal(s.openLongShare, 0.8);
  assert.equal(s.fundingShare, -0.2);
  assert.ok(Math.abs(s.makerShare - 0.4975) < 0.01);
  assert.equal(s.topCoin.coin, 'BTC');
  assert.equal(s.style, 'Day trader');
  assert.equal(s.testable, true);
});

test('styleOf separates the kinds of account', () => {
  const base = { fills: 500, makerShare: 0.2, fillsPerDay: 10, medianHoldMs: 6 * H, tripsPerDay: 2, spotShare: 0, funding: 0, realized: 1000, trips: 60, top3Share: 0.2, addAgainstShare: null, addsPerTrip: 0, winRate: 0.5, payoff: 1.2 };
  const style = (patch) => styleOf({ ...base, ...patch });
  assert.equal(style({ makerShare: 0.9, fillsPerDay: 2000 }).style, 'Market maker');
  assert.equal(style({ medianHoldMs: 60_000, tripsPerDay: 200 }).style, 'High-frequency');
  assert.equal(style({ fills: 0 }).style, 'No trades in the period');
  assert.equal(style({ funding: 900, fundingShare: 0.6 }).style, 'Hedged / funding income');
  assert.equal(style({ funding: 900, fundingShare: 0.05 }).style, 'Day trader'); // funding small next to the week's profit
  assert.equal(style({ funding: -900, fundingShare: -0.6 }).style, 'Day trader');
  assert.equal(style({ spotShare: 0.5 }).style, 'Hedged / funding income');
  assert.equal(style({ trips: 4 }).style, 'A few big bets');
  assert.equal(style({ top3Share: 0.9 }).style, 'A few big bets');
  const grid = style({ addAgainstShare: 0.9, addsPerTrip: 3, winRate: 0.9, payoff: 0.3 });
  assert.equal(grid.style, 'Averages into losers');
  assert.equal(grid.testable, false);
  assert.equal(style({ addAgainstShare: 0.1, addsPerTrip: 2, winRate: 0.4, payoff: 2.5 }).style, 'Adds to winners');
  assert.equal(style({ medianHoldMs: 20 * 60_000 }).style, 'Scalper');
  assert.equal(style({ medianHoldMs: 20 * 60_000 }).testable, false);
  assert.equal(style({ medianHoldMs: 3 * 24 * H }).style, 'Swing trader');
  assert.equal(style({ trips: 12 }).testable, false);
});

test('curveStats reads the share of rising steps and the worst drop', () => {
  const c = curveStats([[1, '0'], [2, '100'], [3, '60'], [4, '160'], [5, '160']]);
  assert.equal(c.upShare, 2 / 3);
  assert.equal(c.drawdown, 40);
  assert.equal(c.drawdownShare, 0.25);
  assert.equal(curveStats([[1, '0']]), null);
});
