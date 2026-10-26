// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { THRESHOLD, BREAKOUT, firstBreakout, checkText, shouldFire, createSignal, updateSignal, replayCandles, metrics, selectRows, headerStats, atPeak, pairHistory, triggerPrice, validSignal } from '../js/pump.js';
import { PumpScanner } from '../js/pump-scanner.js';

const H = 3_600_000;
const tk = (price, low24h, t = 0, symbol = 'ARCUSDT') => ({ symbol, price, low24h, t, quoteVolume: 1e6 });

test('trigger: 27% above the rolling 24h low', () => {
  assert.equal(THRESHOLD, 27);
  assert.equal(triggerPrice(0.02223), 0.02223 * 1.27);
  // PumpGlass's ARC row: start 0.022230, alert 0.028260 (ratio 1.2713)
  const arm = {};
  assert.equal(shouldFire(arm, tk(0.0281, 0.02223)), false, 'below 1.27× the low');
  assert.equal(shouldFire(arm, tk(0.02826, 0.02223)), true, 'first tick at or past the line fires');
});

test('trigger: a pair already above the line when first seen does not fire until it crosses again', () => {
  const arm = {};
  assert.equal(shouldFire(arm, tk(1.4, 1)), false, 'pumped before we looked');
  assert.equal(shouldFire(arm, tk(1.5, 1)), false);
  assert.equal(shouldFire(arm, tk(1.2, 1, 25 * H)), false, 'dropped back below');
  assert.equal(shouldFire(arm, tk(1.28, 1, 25 * H)), true, 'fresh crossing');
});

test('trigger: no repeat for the same move; re-arms after 24h or from a lower 24h low', () => {
  const arm = {};
  shouldFire(arm, tk(1.1, 1, 0));
  assert.equal(shouldFire(arm, tk(1.27, 1, 1000)), true);
  const last = createSignal({ symbol: 'ARCUSDT', price: 1.27, low24h: 1, t: 1000 });
  shouldFire(arm, tk(1.2, 1, 2 * H), last); // fell back below the line
  assert.equal(shouldFire(arm, tk(1.3, 1, 3 * H), last), false, 'bobbing around the line is the same move');
  shouldFire(arm, tk(0.9, 0.85, 4 * H), last); // new, lower 24h low
  assert.equal(shouldFire(arm, tk(1.09, 0.85, 5 * H), last), true, 'rebound off a fresh low is a new signal');
  const arm2 = {};
  shouldFire(arm2, tk(1.1, 1, 0));
  assert.equal(shouldFire(arm2, tk(1.3, 1, 25 * H), last), true, '24 hours later the pair is re-armed');
});

test('trigger: bad data never fires', () => {
  const arm = { below: true };
  assert.equal(shouldFire(arm, tk(1.5, 0)), false);
  assert.equal(shouldFire(arm, tk(0, 1)), false);
});

test('tracking: peak, time to peak and dip before peak', () => {
  const s = createSignal({ symbol: 'ARCUSDT', price: 0.0283, low24h: 0.02223, t: 0 });
  updateSignal(s, 0.0270, 60_000); // dip before peak
  updateSignal(s, 0.0648, 9 * H);
  updateSignal(s, 0.0250, 10 * H); // drawdown after the peak does not count as dip
  updateSignal(s, 0.0631, 11 * H);
  const m = metrics(s, 11 * H);
  assert.equal(Math.round(m.peak), 129); // ARC: +129% from the alert price
  assert.equal(m.timeToPeak, 9 * H);
  assert.equal(m.dip.toFixed(2), (((0.027 - 0.0283) / 0.0283) * 100).toFixed(2));
  assert.equal(Math.round(m.gain), 123);
  assert.equal(m.offPeak.toFixed(1), '2.6');
  assert.equal(Math.round(m.riseAtAlert), 27);
  assert.equal(s.status, 'TRACKING');
  assert.equal(atPeak(s), true);
});

test('tracking: gain can go negative; closes only when the whole move is given back', () => {
  const s = createSignal({ symbol: 'XRPUSDT', price: 1.27, low24h: 1, t: 0 });
  updateSignal(s, 1.23, H);
  assert.equal(s.status, 'TRACKING');
  assert.ok(metrics(s).gain < 0);
  updateSignal(s, 0.99, 2 * H);
  assert.equal(s.status, 'CLOSED');
  assert.match(s.closeReason, /24h low/);
});

test('tracking: closes after 30 days', () => {
  const s = createSignal({ symbol: 'ARCUSDT', price: 1.27, low24h: 1, t: 0 });
  updateSignal(s, 1.5, 30 * 24 * H);
  assert.equal(s.status, 'CLOSED');
});

test('replayCandles: catches up a signal from 1m candles', () => {
  const s = createSignal({ symbol: 'ARCUSDT', price: 1.27, low24h: 1, t: 0 });
  replayCandles(s, [{ t: 0, o: 1.27, h: 1.4, l: 1.25, c: 1.38 }, { t: 60_000, o: 1.38, h: 1.39, l: 1.3, c: 1.31 }]);
  assert.equal(s.peakPrice, 1.4);
  assert.equal(s.dipLow, 1.25);
  assert.equal(s.lastPrice, 1.31);
});

test('views: active sorted by gain or volume, at-peak filter, log newest first, windows', () => {
  const now = 10 * 24 * H;
  const a = createSignal({ symbol: 'AAAUSDT', price: 1.27, low24h: 1, t: now - 2 * H, volume24h: 5e6 });
  updateSignal(a, 1.6, now - H);
  updateSignal(a, 1.3, now); // +2.4%, 18.8% off peak
  const b = createSignal({ symbol: 'BBBUSDT', price: 1.27, low24h: 1, t: now - 3 * 24 * H, volume24h: 9e6 });
  updateSignal(b, 2, now); // +57%, at peak
  const c = createSignal({ symbol: 'CCCUSDT', price: 1.27, low24h: 1, t: now - 5 * H });
  updateSignal(c, 0.9, now); // closed
  const all = [a, b, c];
  assert.deepEqual(selectRows(all, { view: 'active' }, now).map((s) => s.symbol), ['BBBUSDT', 'AAAUSDT']);
  assert.deepEqual(selectRows(all, { view: 'active', sort: 'volume' }, now).map((s) => s.symbol), ['BBBUSDT', 'AAAUSDT']);
  assert.deepEqual(selectRows(all, { view: 'active', atPeak: true }, now).map((s) => s.symbol), ['BBBUSDT']);
  assert.deepEqual(selectRows(all, { view: 'active', window: '24h' }, now).map((s) => s.symbol), ['AAAUSDT']);
  assert.deepEqual(selectRows(all, { view: 'log' }, now).map((s) => s.symbol), ['AAAUSDT', 'CCCUSDT', 'BBBUSDT']);
  const st = headerStats(all, 406, now);
  assert.deepEqual([st.pairs, st.active, st.alerts30d, st.alerts24h], [406, 2, 3, 2]);
  assert.equal(Math.round(st.bestGain24h), 26); // AAA's peak, +26%
  assert.deepEqual(pairHistory(all, 'AAAUSDT'), [a]);
});

test('validSignal: rejects malformed server rows', () => {
  const s = createSignal({ symbol: 'ARCUSDT', price: 1.27, low24h: 1, t: 1 });
  assert.equal(validSignal(s), true);
  assert.equal(validSignal({ ...s, symbol: '<img>' }), false);
  assert.equal(validSignal({ ...s, alertPrice: 'x' }), false);
  assert.equal(validSignal({ ...s, status: 'OPEN' }), false);
});

// ---- scanner

function rig({ signals = [], whaleLookup = null } = {}) {
  let t = 1_000_000;
  const saved = [];
  const source = {
    async getUniverse() { return []; },
    streamTickers() { return () => {}; },
    async getCandles1m() { return []; },
    async getOpenInterest() { return 1000; },
  };
  const sc = new PumpScanner({ source, store: { load: () => signals, save: (s) => saved.push(s.length) }, now: () => t, whaleLookup, breakout: null });
  return { sc, tick: (batch, dt = 1000) => { t += dt; sc.ingest(batch); }, saved };
}

test('scanner: fires once per crossing, closes the earlier signal on a new move, attaches whale context', async () => {
  const btc = { cohort: 'whale', longShare: 0.7, longQty: 10, shortQty: 5, longEntry: 1.2, shortEntry: 1.1, t: 1_000_000 };
  const { sc, tick } = rig({ whaleLookup: async () => btc });
  const alerts = [];
  sc.on('alert', (s) => alerts.push(s));
  tick([tk(1.1, 1, 0, 'ZECUSDT'), tk(1.5, 1, 0, 'OLDUSDT')]);
  tick([tk(1.2705, 1, 0, 'ZECUSDT'), tk(1.6, 1, 0, 'OLDUSDT')]);
  tick([tk(1.30, 1, 0, 'ZECUSDT')]);
  assert.equal(sc.signals.length, 1, 'OLD was above the line before scanning began');
  const z = sc.signals[0];
  assert.equal(z.symbol, 'ZECUSDT');
  assert.equal(z.startPrice, 1);
  assert.equal(z.alertPrice, 1.2705);
  assert.equal(z.lastPrice, 1.3);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(alerts.length, 1);
  assert.equal(z.whale.leaning, 'long');
  assert.equal(z.oiUsd, 1000 * 1.2705);
  // Crash to a fresh low, then a new +27% rebound off it within 24h.
  tick([tk(0.8, 0.8, 0, 'ZECUSDT')]);
  assert.equal(z.status, 'CLOSED');
  tick([tk(1.02, 0.8, 0, 'ZECUSDT')]);
  assert.equal(sc.signals.length, 2);
  assert.equal(sc.signals[0].startPrice, 0.8);
});

test('scanner: a new signal on a pair still tracking closes the old one', () => {
  const old = createSignal({ symbol: 'LYNUSDT', price: 1.27, low24h: 1, t: 0 });
  const { sc, tick } = rig({ signals: [old] });
  tick([tk(1.1, 1, 0, 'LYNUSDT')], 25 * H); // re-armed after 24h, below the line
  tick([tk(1.28, 1, 0, 'LYNUSDT')]);
  assert.equal(sc.signals.length, 2);
  assert.equal(old.status, 'CLOSED');
  assert.match(old.closeReason, /new signal/);
  assert.equal(sc.signals[0].status, 'TRACKING');
});

test('scanner: old-format signals from the previous scanner are ignored', () => {
  const { sc } = rig({ signals: [{ id: 'X-1', symbol: 'XUSDT', status: 'TRACKING', alertT: 1_000_000, alertPrice: 1 }] });
  assert.equal(sc.signals.length, 0);
});

test('scanner: with the filter on, alerts recorded before it existed are dropped', () => {
  const old = createSignal({ symbol: 'LYNUSDT', price: 1.27, low24h: 1, t: 1_000_000 });
  delete old.rules;
  const kept = createSignal({ symbol: 'ZECUSDT', price: 1.27, low24h: 1, t: 1_000_000 });
  const sc = new PumpScanner({ source: {}, store: { load: () => [old, kept], save() {} }, now: () => 1_000_000 });
  assert.deepEqual(sc.signals.map((s) => s.symbol), ['ZECUSDT']);
});

test('scanner: keeps scanning over REST when the ticker stream is silent', async () => {
  let t = 1_000_000;
  let polls = 0;
  const source = {
    async getUniverse() { return [tk(1.1, 1, 0, 'ZECUSDT')]; },
    streamTickers() { return () => {}; }, // connects, never sends
    async getTickers() { polls++; return [tk(1.3, 1, 0, 'ZECUSDT')]; },
    async getCandles1m() { return []; },
  };
  const sc = new PumpScanner({ source, store: { load: () => [], save() {} }, now: () => t, breakout: null });
  await sc.start();
  await sc.pollIfStale();
  assert.equal(polls, 0, 'stream only just opened');
  t += 25_000;
  await sc.pollIfStale();
  assert.equal(polls, 1);
  assert.equal(sc.state, 'polling');
  assert.equal(sc.signals.length, 1, 'the crossing is caught from the REST poll');
  sc.stop();
});

// ---- first-breakout filter

const NOW = 100 * 24 * H;
/** Hourly candles for `days` days up to NOW: a flat range around 1.0 (±5%), optional earlier spike, today's pump. */
function history({ days = 45, spikeDaysAgo = null, spike = 1.6, drift = 0, vol = 1000 } = {}) {
  const out = [];
  const start = NOW - days * 24 * H;
  for (let t = start, i = 0; t < NOW; t += H, i++) {
    const daysAgo = (NOW - t) / (24 * H);
    let c = 1 + 0.05 * Math.sin(i / 7) + drift * (1 - daysAgo / days);
    if (spikeDaysAgo != null && Math.abs(daysAgo - spikeDaysAgo) < 0.5) c *= spike;
    out.push({ t, o: c, h: c * 1.005, l: c * 0.995, c, v: vol });
  }
  return out;
}
const at = (price, volume24h = 24 * 1000 * 3) => ({ price, t: NOW, volume24h });

test('firstBreakout: a quiet coin breaking its 40-day high on 3x volume passes', () => {
  const r = firstBreakout(history(), at(1.35));
  assert.equal(r.pass, true, JSON.stringify(r.checks));
  assert.ok(r.priorRise < 15);
  assert.ok(r.baseRange < 15);
  assert.equal(Math.round(r.volMult), 3);
  assert.ok(r.rangeHigh > 1.04 && r.rangeHigh < 1.06);
});

test('firstBreakout: a coin that pumped before is filtered out', () => {
  const r = firstBreakout(history({ spikeDaysAgo: 12 }), at(1.35));
  assert.equal(r.pass, false);
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.ok(failed.includes('fresh'), 'earlier pump');
  assert.ok(failed.includes('breakout'), 'still below the earlier pump high');
  assert.match(checkText(r.checks.find((c) => c.id === 'fresh')), /Already pumped/);
});

test('firstBreakout: pumped, dumped and bouncing back into the old range is filtered out', () => {
  // Spike to 1.6 twenty days ago, back to ~1.0, now 1.27 off a 24h low near 1.0: below the old high.
  const r = firstBreakout(history({ spikeDaysAgo: 20 }), at(1.28));
  assert.equal(r.pass, false);
  assert.equal(r.checks.find((c) => c.id === 'breakout').ok, false);
});

test('firstBreakout: weak volume, a steady uptrend and a fresh listing each fail', () => {
  assert.equal(firstBreakout(history(), at(1.35, 24 * 1000 * 1.2)).checks.find((c) => c.id === 'volume').ok, false);
  const trend = firstBreakout(history({ drift: 0.9 }), at(2.4));
  assert.equal(trend.checks.find((c) => c.id === 'base').ok, false, 'already ran 90%: not a flat base');
  const fresh = firstBreakout(history({ days: 8 }), at(1.35));
  assert.equal(fresh.checks.find((c) => c.id === 'history').ok, false);
  assert.equal(fresh.pass, false);
});

test('firstBreakout: the last 24 hours (the move itself) are not part of the base', () => {
  const k = history();
  k[k.length - 3].h = 1.3; // today's move already touched 1.3 an hour ago
  const r = firstBreakout(k, at(1.35));
  assert.equal(r.pass, true);
  assert.ok(r.rangeHigh < 1.1);
  assert.equal(BREAKOUT.lookbackDays, 40);
});

function filterRig(candles) {
  let t = NOW;
  const source = {
    async getUniverse() { return []; },
    streamTickers() { return () => {}; },
    async getCandles() { return candles; },
    async getCandles1m() { return []; },
  };
  const sc = new PumpScanner({ source, store: { load: () => [], save() {} }, now: () => t });
  return { sc, tick: (batch) => { t += 1000; sc.ingest(batch); } };
}

test('scanner: alerts a first breakout and records the checks', async () => {
  const { sc, tick } = filterRig(history());
  tick([{ ...tk(1.0, 1.0, 0, 'NEWUSDT'), quoteVolume: 72000 }]);
  tick([{ ...tk(1.28, 1.0, 0, 'NEWUSDT'), quoteVolume: 72000 }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sc.signals.length, 1);
  assert.equal(sc.signals[0].rules, 2);
  assert.equal(sc.signals[0].breakout.checks.every((c) => c.ok), true);
});

test('scanner: a repeat pumper is skipped, listed with its reasons, and not re-checked for an hour', async () => {
  let fetches = 0;
  const { sc, tick } = filterRig(history({ spikeDaysAgo: 12 }));
  const get = sc.source.getCandles;
  sc.source.getCandles = (...a) => { fetches++; return get(...a); };
  const skips = [];
  sc.on('skipped', (s) => skips.push(s));
  tick([{ ...tk(1.0, 1.0, 0, 'OLDUSDT'), quoteVolume: 72000 }]);
  tick([{ ...tk(1.28, 1.0, 0, 'OLDUSDT'), quoteVolume: 72000 }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sc.signals.length, 0);
  assert.equal(skips.length, 1);
  assert.equal(sc.skipped[0].symbol, 'OLDUSDT');
  tick([{ ...tk(1.2, 1.0, 0, 'OLDUSDT'), quoteVolume: 72000 }]);
  tick([{ ...tk(1.3, 1.0, 0, 'OLDUSDT'), quoteVolume: 72000 }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetches, 1, 'memo: no second history fetch within the hour');
});
