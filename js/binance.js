// Binance data source for the Pump Catcher. Uses only fetch and WebSocket,
// so it runs unchanged in the browser and in Node 22+ (worker/catcher.mjs).
// `get(path, params)` is injected so each side can add its own caching and rate limiting.

export const REST = 'https://fapi.binance.com';
// Market streams (tickers, liquidations) moved to the /market path; the old /ws path stopped sending them in 2026.
export const WS = 'wss://fstream.binance.com/market/ws';

export function createBinanceSource({ get }) {
  let universe = new Set();

  return {
    name: 'binance',

    /** Trading USDT perpetuals, plus a first ticker snapshot for each. */
    async getUniverse() {
      const [info, tickers] = await Promise.all([get('/fapi/v1/exchangeInfo'), get('/fapi/v1/ticker/24hr')]);
      universe = new Set(
        info.symbols
          .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
          .map((s) => s.symbol),
      );
      return tickers.filter((t) => universe.has(t.symbol)).map(fromRest);
    },

    /** Latest ticker for every pair in the universe, over REST (fallback when the stream is silent). */
    async getTickers() {
      const tickers = await get('/fapi/v1/ticker/24hr');
      return tickers.filter((t) => universe.has(t.symbol)).map(fromRest);
    },

    /** All-market ticker stream, about once a second. Returns a stop function. */
    streamTickers(onBatch, onState = () => {}) {
      let ws;
      let stopped = false;
      let retry;
      let delay = 3000; // doubles on each failed attempt, up to 60 s, so a Binance outage isn't hammered
      let watchdog;
      let lastMsg = Date.now();
      const connect = () => {
        ws = new WebSocket(`${WS}/!ticker@arr`);
        ws.onopen = () => onState('open');
        ws.onmessage = (msg) => {
          lastMsg = Date.now();
          delay = 3000;
          let rows;
          try {
            rows = JSON.parse(typeof msg.data === 'string' ? msg.data : msg.data.toString());
          } catch {
            return;
          }
          onBatch(rows.filter((r) => universe.has(r.s)).map(fromStream));
        };
        ws.onclose = () => {
          onState('closed');
          if (!stopped) {
            retry = setTimeout(connect, delay);
            delay = Math.min(delay * 2, 60_000);
          }
        };
        ws.onerror = () => ws.close();
      };
      connect();
      // The all-market stream ticks about once a second; silence for 30 s means a dead socket that never closed.
      watchdog = setInterval(() => {
        if (!stopped && Date.now() - lastMsg > 30_000 && ws?.readyState === 1) {
          lastMsg = Date.now();
          ws.close();
        }
      }, 10_000);
      return () => {
        stopped = true;
        clearTimeout(retry);
        clearInterval(watchdog);
        ws?.close();
      };
    },

    /** Open interest in contracts (multiply by price for USD). */
    async getOpenInterest(symbol) {
      const r = await get('/fapi/v1/openInterest', { symbol });
      return r?.openInterest != null ? +r.openInterest : null;
    },

    /** 1m candles from a start time, to catch up tracking after a gap. */
    async getCandles1m(symbol, startTime, limit = 1000) {
      const k = await get('/fapi/v1/klines', { symbol, interval: '1m', startTime, limit });
      return k.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
    },

    async getCandles(symbol, interval, startTime, limit = 500) {
      const k = await get('/fapi/v1/klines', { symbol, interval, startTime, limit });
      return k.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] }));
    },
  };
}

const fromRest = (t) => ({
  symbol: t.symbol,
  price: +t.lastPrice,
  low24h: +t.lowPrice,
  high24h: +t.highPrice,
  change24h: +t.priceChangePercent,
  quoteVolume: +t.quoteVolume,
  t: +t.closeTime,
});

const fromStream = (t) => ({
  symbol: t.s,
  price: +t.c,
  low24h: +t.l,
  high24h: +t.h,
  change24h: +t.P,
  quoteVolume: +t.q,
  t: +t.E,
});
