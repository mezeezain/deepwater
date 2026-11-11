// Hyperliquid's public API for the tools in this folder: paced, retried, no key needed.
export const API = process.env.HL_API || 'https://api.hyperliquid.xyz/info';
export const BOARD = process.env.HL_LEADERBOARD || 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
export const GAP = +(process.env.HL_GAP_MS ?? 1300); // ms between calls: well inside the public rate limit
export const PAGE = 2000; // fills per call; only an account's latest 10,000 fills are served
const MAX_PAGES = 6;
const HOUR = 3_600_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
export async function info(body) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 429 && attempt < 5) {
      await sleep(+(process.env.HL_BACKOFF_MS ?? 15_000) * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${body.type}`);
    return res.json();
  }
}

export async function leaderboard() {
  const res = await fetch(BOARD);
  if (!res.ok) throw new Error(`HTTP ${res.status} for the leaderboard`);
  const rows = (await res.json())?.leaderboardRows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('The leaderboard came back empty or in a new shape.');
  return rows;
}

/** The account's most recent fills (one page, at most 2,000). */
export async function recentFills(user) {
  const list = await info({ type: 'userFills', user, aggregateByTime: true });
  return Array.isArray(list) ? list : [];
}

/** Fills since `since`, oldest first, following the API's paging rule (next page starts at the last fill's time). */
export async function fillsSince(user, since) {
  const seen = new Map();
  let start = since, capped = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await info({ type: 'userFillsByTime', user, startTime: start, aggregateByTime: true });
    if (!Array.isArray(batch) || !batch.length) break;
    const before = seen.size;
    for (const f of batch) seen.set(`${f.tid}:${f.oid}:${f.time}`, f);
    const last = Math.max(...batch.map((f) => f.time));
    if (batch.length < PAGE || seen.size === before) break;
    if (page === MAX_PAGES - 1) capped = true;
    start = last;
  }
  return { list: [...seen.values()].sort((a, b) => a.time - b.time), capped: capped || seen.size >= 10_000 };
}

/** The window's fills from one page when that page reaches back far enough, otherwise by paging. `recent` may be passed in. */
export async function windowFills(user, since, recent = null) {
  const list = recent ?? await recentFills(user);
  const oldest = list.length ? Math.min(...list.map((f) => f.time)) : Infinity;
  if (list.length < PAGE || oldest <= since) return { list: list.filter((x) => x.time >= since).sort((a, b) => a.time - b.time), capped: false };
  return fillsSince(user, since);
}

/** Funding payments since `since`. Returns the rows and whether the whole period was read. */
export async function funding(user, since) {
  const out = [];
  let start = since, complete = false;
  for (let page = 0; page < 10; page++) {
    const batch = await info({ type: 'userFunding', user, startTime: start });
    if (!Array.isArray(batch) || !batch.length) { complete = true; break; }
    out.push(...batch);
    const last = Math.max(...batch.map((x) => x.time));
    if (batch.length < 500 || last < start) { complete = true; break; }
    start = last + 1;
  }
  return { rows: out, complete };
}

/** Hourly candles for a coin between two times, oldest first: [{ t, o, h, l, c }]. Pages if the API cuts the range short. */
export async function hourly(coin, from, to) {
  const seen = new Map();
  let start = from;
  for (let page = 0; page < 12; page++) {
    const batch = await info({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: start, endTime: to } });
    if (!Array.isArray(batch) || !batch.length) break;
    const before = seen.size;
    for (const k of batch) seen.set(k.t, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c });
    const last = Math.max(...batch.map((k) => k.t));
    if (seen.size === before || last + 2 * HOUR >= to) break;
    start = last + 1;
  }
  return [...seen.values()].filter((b) => b.c > 0).sort((a, b) => a.t - b.t);
}
