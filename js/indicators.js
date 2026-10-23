// Order-flow and positioning indicators built from Binance's public futures data.
// Pure functions: no DOM, no network. Shared by the chart, the liquidation map and the setup check.
//
// Input bar (one per candle, already aligned by time):
//   { t, o, h, l, c, v, takerBuy, oi, whaleLong, crowdLong, smartLong }
//   v / takerBuy in quote currency (USDT); oi in contracts; *Long are 0..1 shares.

export const LEVERAGE_TIERS = [
  { lev: 10, weight: 0.35 },
  { lev: 25, weight: 0.3 },
  { lev: 50, weight: 0.2 },
  { lev: 100, weight: 0.15 },
];

const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

/**
 * Market layers per bar:
 *  delta        taker buy − taker sell volume (USDT)
 *  cvd          running sum of delta
 *  oiDelta      change in open interest, in USDT at the bar's close
 *  regime       which side opened or closed positions, from the sign of oiDelta and delta
 *  netLongs     running estimate of long exposure added (USDT)
 *  netShorts    running estimate of short exposure added (USDT)
 *  absorption   'buyers-absorbed' | 'sellers-absorbed' | null: one-sided aggression that didn't move price
 *  liq          { side: 'long' | 'short', usd } estimated forced closes, or null
 */
export function marketLayers(bars, { flatPct = 0.15, absorbRatio = 0.2 } = {}) {
  const out = [];
  let cvd = 0;
  let netLongs = 0;
  let netShorts = 0;
  const ranges = bars.map((b) => (b.o > 0 ? (b.h - b.l) / b.o : 0));
  const oiMoves = [];

  bars.forEach((b, i) => {
    const prev = bars[i - 1];
    const delta = b.takerBuy != null && b.v != null ? 2 * b.takerBuy - b.v : 0;
    cvd += delta;
    const oiDelta = prev && b.oi != null && prev.oi != null ? (b.oi - prev.oi) * b.c : 0;
    if (prev) oiMoves.push(Math.abs(oiDelta));

    let regime = null;
    if (oiDelta > 0 && delta >= 0) {
      regime = 'longs-opened';
      netLongs += oiDelta;
    } else if (oiDelta > 0) {
      regime = 'shorts-opened';
      netShorts += oiDelta;
    } else if (oiDelta < 0 && delta >= 0) {
      regime = 'shorts-closed';
      netShorts += oiDelta;
    } else if (oiDelta < 0) {
      regime = 'longs-closed';
      netLongs += oiDelta;
    }

    const move = prev ? ((b.c - prev.c) / prev.c) * 100 : 0;
    let absorption = null;
    if (prev && Math.abs(move) < flatPct && b.v > 0) {
      const ratio = delta / b.v;
      if (ratio > absorbRatio) absorption = 'buyers-absorbed';
      else if (ratio < -absorbRatio) absorption = 'sellers-absorbed';
    }

    // Forced closes leave a footprint: open interest drops sharply, the candle is wide,
    // and one side's market orders dominate (liquidation engines send market orders).
    let liq = null;
    const typicalOi = avg(oiMoves.slice(-48));
    const typicalRange = avg(ranges.slice(Math.max(0, i - 48), i));
    if (prev && oiDelta < 0 && typicalOi > 0 && -oiDelta > 2 * typicalOi && ranges[i] > 1.5 * typicalRange && b.v > 0 && Math.abs(delta / b.v) > 0.15) {
      liq = { side: delta < 0 ? 'long' : 'short', usd: -oiDelta };
    }

    out.push({ t: b.t, delta, cvd, oiDelta, regime, netLongs, netShorts, absorption, liq });
  });
  return out;
}

/**
 * Whale layers per bar, estimated by applying the top-trader long share to total open interest.
 * Binance doesn't publish whale dollar positions, so every value here is an estimate:
 *  longUsd / shortUsd   estimated whale long / short exposure
 *  net                  longUsd − shortUsd
 *  shift                change in net since the previous bar (positive = added longs or closed shorts)
 *  opensLong / opensShort  newly added exposure only, closures excluded
 *  rosterChange         share jumped while open interest barely moved: likely a change in who ranks as a
 *                       top trader rather than a trade, so it is excluded from shift and opens
 *  gap                  whale long % − crowd long %, in points
 */
export function whaleLayers(bars, { rosterJump = 0.08, rosterOiMax = 0.002 } = {}) {
  const out = [];
  bars.forEach((b, i) => {
    const share = b.whaleLong ?? b.smartLong;
    const oiUsd = b.oi != null ? b.oi * b.c : null;
    const longUsd = share != null && oiUsd != null ? share * oiUsd : null;
    const shortUsd = share != null && oiUsd != null ? (1 - share) * oiUsd : null;
    const row = {
      t: b.t,
      longUsd,
      shortUsd,
      net: longUsd != null ? longUsd - shortUsd : null,
      shift: 0,
      opensLong: 0,
      opensShort: 0,
      rosterChange: false,
      gap: share != null && b.crowdLong != null ? (share - b.crowdLong) * 100 : null,
    };
    const p = out[i - 1];
    const prevBar = bars[i - 1];
    if (p && p.longUsd != null && longUsd != null) {
      const prevShare = prevBar.whaleLong ?? prevBar.smartLong;
      const oiChange = prevBar.oi ? Math.abs(b.oi - prevBar.oi) / prevBar.oi : 0;
      if (Math.abs(share - prevShare) >= rosterJump && oiChange <= rosterOiMax) {
        row.rosterChange = true;
      } else {
        const dLong = longUsd - p.longUsd;
        const dShort = shortUsd - p.shortUsd;
        row.shift = dLong - dShort;
        row.opensLong = Math.max(0, dLong);
        row.opensShort = Math.max(0, dShort);
      }
    }
    out.push(row);
  });
  return out;
}

/** Volume-weighted price of estimated whale opens: a rough cost basis for each side. */
export function whaleEntries(bars, whales) {
  let pl = 0, ql = 0, ps = 0, qs = 0;
  whales.forEach((w, i) => {
    const price = (bars[i].h + bars[i].l + bars[i].c) / 3;
    pl += price * w.opensLong;
    ql += w.opensLong;
    ps += price * w.opensShort;
    qs += w.opensShort;
  });
  return { long: ql > 0 ? pl / ql : null, short: qs > 0 ? ps / qs : null, longUsd: ql, shortUsd: qs };
}

export function liqPrice(entry, lev, side, mmr = 0.005) {
  return side === 'long' ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
}

/**
 * Estimated liquidation levels over time.
 * Each bar's newly opened longs (or shorts) are spread across leverage tiers, giving levels below
 * (or above) the entry. A level is removed once a later candle trades through it.
 * Returns { columns: [[{ price, usd, side }...] per bar], active: levels still standing at the end }.
 */
export function liquidationLevels(bars, market, { tiers = LEVERAGE_TIERS, mmr = 0.005 } = {}) {
  let active = [];
  const columns = [];
  bars.forEach((b, i) => {
    // Wick erasure: anything this candle traded through is gone.
    active = active.filter((lv) => (lv.side === 'long' ? b.l > lv.price : b.h < lv.price));
    const m = market[i];
    const side = m.regime === 'longs-opened' ? 'long' : m.regime === 'shorts-opened' ? 'short' : null;
    if (side && m.oiDelta > 0) {
      const entry = (b.h + b.l + b.c) / 3;
      for (const { lev, weight } of tiers) {
        active.push({ price: liqPrice(entry, lev, side, mmr), usd: m.oiDelta * weight, side, lev, bornT: b.t });
      }
    }
    columns.push(active.slice());
  });
  return { columns, active };
}

/** Group levels into price buckets of `pct` percent around a reference price. */
export function bucketLevels(levels, ref, pct = 0.25) {
  const step = Math.log(1 + pct / 100);
  const map = new Map();
  for (const lv of levels) {
    const k = Math.round(Math.log(lv.price / ref) / step);
    const cur = map.get(k) || { k, price: ref * Math.exp(k * step), long: 0, short: 0 };
    cur[lv.side] += lv.usd;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => a.price - b.price);
}

/**
 * Order book walls: price levels holding far more than the typical level nearby.
 * book: { bids: [[price, qty]...], asks: [[price, qty]...] }. Returns walls sorted by size.
 */
export function findWalls(book, { minMultiple = 4, pct = 0.25, ref } = {}) {
  const mid = ref ?? (book.bids.length && book.asks.length ? (+book.bids[0][0] + +book.asks[0][0]) / 2 : 0);
  if (!mid) return [];
  const rows = [
    ...book.bids.map(([p, q]) => ({ side: 'bid', price: +p, usd: +p * +q })),
    ...book.asks.map(([p, q]) => ({ side: 'ask', price: +p, usd: +p * +q })),
  ];
  // Bucket so a wall split across neighbouring ticks still counts as one.
  const step = mid * (pct / 100);
  const buckets = new Map();
  for (const r of rows) {
    const k = `${r.side}:${Math.round(r.price / step)}`;
    const cur = buckets.get(k) || { side: r.side, price: Math.round(r.price / step) * step, usd: 0 };
    cur.usd += r.usd;
    buckets.set(k, cur);
  }
  const list = [...buckets.values()];
  const typical = median(list.map((b) => b.usd));
  return list
    .map((b) => ({ ...b, multiple: typical ? b.usd / typical : 0, distPct: ((b.price - mid) / mid) * 100 }))
    .filter((b) => b.multiple >= minMultiple)
    .sort((a, b) => b.usd - a.usd);
}

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Setup check: four questions to ask before trusting a move, answered from the last `lookback` bars.
 * Each item: { id, label, state: 'good' | 'warn' | 'bad' | 'na', detail }
 */
export function setupCheck(bars, market, whales, { lookback = 12, levels = [] } = {}) {
  const n = bars.length;
  if (n < lookback + 1) return [];
  const from = n - 1 - lookback;
  const last = bars[n - 1];
  const priceChg = ((last.c - bars[from].c) / bars[from].c) * 100;
  const dLongs = market[n - 1].netLongs - market[from].netLongs;
  const dShorts = market[n - 1].netShorts - market[from].netShorts;
  const usd = (v) => `${v < 0 ? '-' : '+'}$${fmtCompact(Math.abs(v))}`;
  const items = [];

  // 1. What is driving price?
  if (priceChg > 0.5) {
    if (dLongs > 0 && dLongs > -dShorts) items.push({ id: 'fuel', label: 'New longs are driving the rise', state: 'good', detail: `Net longs ${usd(dLongs)}, net shorts ${usd(dShorts)} while price rose ${priceChg.toFixed(1)}%.` });
    else if (dShorts < 0) items.push({ id: 'fuel', label: 'Rise is mostly short covering', state: 'warn', detail: `Net shorts ${usd(dShorts)} with little new long money (${usd(dLongs)}). These moves often stall.` });
    else items.push({ id: 'fuel', label: 'Rise without clear position flow', state: 'warn', detail: `Net longs ${usd(dLongs)}, net shorts ${usd(dShorts)}.` });
  } else if (priceChg < -0.5) {
    items.push({ id: 'fuel', label: dShorts > 0 ? 'New shorts are pushing price down' : 'Longs are exiting', state: 'bad', detail: `Price ${priceChg.toFixed(1)}%. Net longs ${usd(dLongs)}, net shorts ${usd(dShorts)}.` });
  } else {
    const absorb = market.slice(from).filter((m) => m.absorption === 'sellers-absorbed').length;
    items.push({ id: 'fuel', label: absorb >= 2 ? 'Flat price, sellers being absorbed' : 'Price is flat', state: absorb >= 2 ? 'good' : 'na', detail: absorb >= 2 ? `${absorb} bars where heavy selling didn't move price: limit buyers are soaking it up.` : `Net longs ${usd(dLongs)}, net shorts ${usd(dShorts)}.` });
  }

  // 2. Are whales adding, or just closing?
  const recent = whales.slice(from + 1);
  if (recent.some((w) => w.longUsd != null)) {
    const opensL = recent.reduce((s, w) => s + w.opensLong, 0);
    const opensS = recent.reduce((s, w) => s + w.opensShort, 0);
    const state = opensL > opensS * 1.2 ? 'good' : opensS > opensL * 1.2 ? 'bad' : 'warn';
    items.push({ id: 'whales', label: state === 'good' ? 'Whales are opening longs' : state === 'bad' ? 'Whales are opening shorts' : 'Whale opens are balanced', state, detail: `Estimated whale opens: longs ${usd(opensL)}, shorts ${usd(opensS)}.` });
  } else {
    items.push({ id: 'whales', label: 'Whale data unavailable', state: 'na', detail: 'Binance has no top-trader data for this pair.' });
  }

  // 3. Is the crowd on the wrong side?
  const w = whales[n - 1];
  const crowd = last.crowdLong;
  const share = last.whaleLong ?? last.smartLong;
  if (share != null && crowd != null) {
    const strong = share > 0.6 && crowd < 0.4;
    const state = strong ? 'good' : w.gap > 5 ? 'warn' : w.gap < -5 ? 'bad' : 'na';
    items.push({ id: 'gap', label: strong ? 'Crowd is short against long whales' : w.gap > 5 ? 'Whales longer than the crowd' : w.gap < -5 ? 'Whales shorter than the crowd' : 'Whales and crowd agree', state, detail: `Whales ${Math.round(share * 100)}% long, crowd ${Math.round(crowd * 100)}% long (gap ${w.gap > 0 ? '+' : ''}${Math.round(w.gap)}).` });
  }

  // 4. Where is price against whale cost basis and liquidation clusters?
  const entries = whaleEntries(bars, whales);
  const above = bucketLevels(levels.filter((lv) => lv.side === 'short' && lv.price > last.c), last.c, 0.5);
  const total = above.reduce((s, b) => s + b.short, 0);
  const near = above.filter((b) => b.price < last.c * 1.05).reduce((s, b) => s + b.short, 0);
  const dist = entries.long ? ((last.c - entries.long) / entries.long) * 100 : null;
  const parts = [];
  if (dist != null) parts.push(`Price is ${Math.abs(dist).toFixed(1)}% ${dist >= 0 ? 'above' : 'below'} the estimated whale long entry.`);
  if (total > 0) parts.push(`${usd(near).slice(1)} of estimated short liquidations sit within 5% above.`);
  const nearBase = dist != null && dist >= -1 && dist <= 3;
  const magnet = total > 0 && near / total > 0.4;
  items.push({
    id: 'levels',
    label: nearBase && magnet ? 'Near whale entry, liquidations overhead' : nearBase ? 'Near whale entry' : magnet ? 'Liquidations stacked overhead' : 'No nearby edge',
    state: nearBase && magnet ? 'good' : nearBase || magnet ? 'warn' : 'na',
    detail: parts.join(' ') || 'Not enough data.',
  });
  return items;
}

export function fmtCompact(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}
