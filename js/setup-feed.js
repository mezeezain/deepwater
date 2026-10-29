// Live setups, shared by the Live setups page (js/views/ideas.js) and the server's Telegram watcher
// (worker/setup-alerts.mjs): turning raw Binance responses into lab bars, and collecting the live setups
// with their evidence grade. Pure functions, no browser or Node globals.
import { LAB_DEFAULTS } from './setups.js';
import { activeIdeas, evidence, comparable, priceCheck, HIGHER } from './ideas.js';

export const FRAME_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
export const FRAMES = ['15m', '1h', '4h'];

/** Carry the last known value forward over short gaps (the newest candle often has no snapshot yet). */
export function fillGaps(bars, fields) {
  for (const f of fields) {
    let last = null;
    let run = 0;
    for (const b of bars) {
      if (b[f] != null) {
        last = b[f];
        run = 0;
      } else if (last != null && ++run <= 2) b[f] = last;
    }
  }
}

/**
 * Lab bars from raw Binance responses: klines (arrays), top-trader and all-account long/short ratio rows,
 * and funding rows. Closed candles only.
 */
export function labDataFrom({ klines, whales = [], crowd = [], funding = [] }, ms, now = Date.now()) {
  const slot = (ts) => Math.floor((+ts - 1) / ms) * ms;
  const wBy = new Map(whales.map((r) => [slot(r.timestamp), +r.longAccount]));
  const cBy = new Map(crowd.map((r) => [slot(r.timestamp), +r.longAccount]));
  const bars = klines
    .filter((k) => k[0] + ms <= now)
    .map((k) => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7], takerBuy: +k[10],
      whaleLong: wBy.get(k[0]) ?? null,
      crowdLong: cBy.get(k[0]) ?? null,
    }));
  fillGaps(bars, ['whaleLong', 'crowdLong']);
  const firstPos = bars.find((b) => b.whaleLong != null);
  return {
    bars,
    funding: funding.map((r) => ({ t: +r.fundingTime, rate: +r.fundingRate })),
    positioningFrom: firstPos?.t ?? null,
  };
}

/**
 * Every live setup across the loaded pairs and timeframes, best first.
 * data: Map(`${symbol}|${tf}` -> { bars, funding, trades }), smartFor(symbol) -> Smart Money summary or null,
 * priceFor(symbol) -> latest price or undefined.
 */
export function collectIdeas({ symbols, frames = FRAMES, data, smartFor = () => null, priceFor = () => undefined, cfg = LAB_DEFAULTS }) {
  const all = [];
  for (const tf of frames) {
    const pooled = symbols.flatMap((s) => data.get(`${s}|${tf}`)?.trades ?? []);
    for (const symbol of symbols) {
      const d = data.get(`${symbol}|${tf}`);
      if (!d?.bars?.length) continue;
      const higher = data.get(`${symbol}|${HIGHER[tf]}`);
      for (const idea of activeIdeas(d.bars, cfg, FRAME_MS[tf])) {
        const ev = evidence(idea, {
          bars: d.bars,
          trades: d.trades,
          pooled,
          higherBars: higher?.bars ?? null,
          higherFrame: HIGHER[tf],
          smart: smartFor(symbol),
          funding: d.funding,
        }, cfg);
        const check = priceCheck(idea, priceFor(symbol));
        all.push({ ...idea, symbol, tf, ev, hist: comparable(idea, ev.whale, pooled), check, invalid: check?.state === 'stop' || check?.state === 'target' });
      }
    }
  }
  const rank = { A: 0, B: 1, C: 2 };
  return all.sort((a, b) => a.invalid - b.invalid || rank[a.ev.grade] - rank[b.ev.grade] || b.ev.score - a.ev.score || b.signalT - a.signalT);
}

/** Stable identity of a setup: the same signal on later refreshes has the same key. */
export const ideaKey = (x) => `${x.symbol}|${x.tf}|${x.model}|${x.side}|${x.signalT}`;

/** Whether a setup is worth announcing: new (enter now or limit waiting), still valid, grade in `grades`. */
export const announceable = (x, grades = ['A', 'B']) => !x.invalid && x.state !== 'running' && grades.includes(x.ev.grade);
