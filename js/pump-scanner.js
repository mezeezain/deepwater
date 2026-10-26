// Pump Catcher scanner loop around pump.js. Environment-agnostic: the browser and the Node server
// pass in a data source (js/binance.js or the demo market), a store for signals, and listen for events.
//   events: 'alert' (new signal), 'closed' (signal stopped tracking), 'skipped' (crossed the trigger but failed
//   the first-breakout rules), 'change' (anything else)
import { shouldFire, createSignal, updateSignal, closeSignal, replayCandles, whaleContext, firstBreakout, BREAKOUT, KEEP_DAYS, THRESHOLD } from './pump.js';

const OI_EVERY_MS = 5 * 60_000; // open interest for tracked pairs
const STALE_MS = 20_000; // no stream data for this long: poll REST until the stream is back
const POLL_MS = 10_000;
const OI_CONCURRENCY = 4;
const MAX_SIGNALS = 3000;
const SKIP_KEEP_MS = 24 * 3_600_000; // filtered-out crossings are listed for a day
const SKIP_MEMO_MS = 60 * 60_000; // don't re-check a filtered-out pair for an hour

export class PumpScanner {
  /**
   * source: getUniverse(), getTickers(), streamTickers(onBatch, onState), getCandles(symbol, interval, startTime, limit),
   *         getCandles1m(symbol, startTime), getOpenInterest(symbol)
   * store: { load() -> signals[], save(signals) }
   * whaleLookup (optional): async symbol -> Binance Smart Money summary, attached to alerts as context.
   */
  constructor({ source, store, now = () => Date.now(), whaleLookup = null, threshold = THRESHOLD, breakout = BREAKOUT }) {
    this.source = source;
    this.store = store;
    this.now = now;
    this.whaleLookup = whaleLookup;
    this.threshold = threshold;
    this.breakout = breakout; // null switches the first-breakout filter off
    this.tickers = new Map();
    this.arms = new Map(); // symbol -> { below }
    this.checking = new Set(); // pairs whose history is being fetched
    this.skipped = []; // recent crossings that failed the filter, newest first
    // Alerts recorded before the first-breakout filter existed (no rules: 2) are dropped: they are the
    // pump-dump-and-bounce alerts the filter is there to remove.
    this.signals = (store.load() || []).filter((s) => s && s.startPrice > 0 && (s.rules === 2 || !breakout) && this.now() - s.alertT < KEEP_DAYS * 86_400_000);
    this.index();
    this.listeners = new Map();
    this.state = 'starting';
    this.lastTick = null;
    this.startedAt = this.now();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  async start() {
    this.ingest(await this.source.getUniverse());
    await this.catchUp();
    this.stopStream = this.source.streamTickers(
      (batch) => {
        this.lastStream = this.now();
        this.state = 'live';
        this.ingest(batch);
      },
      (s) => {
        if (s !== 'open' && this.state === 'live') this.state = 'reconnecting';
        this.emit('change');
      },
    );
    this.state = 'connecting';
    this.lastStream = this.now();
    // If the WebSocket goes quiet (blocked, or Binance moves the stream), keep scanning over REST.
    this.pollTimer = setInterval(() => this.pollIfStale(), POLL_MS);
    this.refreshOi();
    this.oiTimer = setInterval(() => this.refreshOi(), OI_EVERY_MS);
    this.emit('change');
  }

  stop() {
    clearInterval(this.oiTimer);
    clearInterval(this.pollTimer);
    clearTimeout(this.saveTimer);
    this.stopStream?.();
    this.save();
  }

  async pollIfStale() {
    if (!this.source.getTickers || this.polling) return;
    if (this.now() - this.lastStream < STALE_MS) return;
    this.polling = true;
    try {
      this.ingest(await this.source.getTickers());
      this.state = 'polling';
      this.emit('change');
    } catch {
      // Binance unreachable; try again next interval.
    } finally {
      this.polling = false;
    }
  }

  /** Signals that were tracking when we last stopped: replay the minutes we missed from 1m candles. */
  async catchUp() {
    const open = this.signals.filter((s) => s.status === 'TRACKING');
    for (let i = 0; i < open.length; i += 6) {
      await Promise.all(open.slice(i, i + 6).map(async (s) => {
        try {
          replayCandles(s, await this.source.getCandles1m(s.symbol, s.lastT - 60_000));
        } catch {
          // Leave it tracking; live prices continue it.
        }
      }));
    }
    if (open.length) this.save();
  }

  /** symbol -> that pair's signals, newest first. Rebuilt whenever the list changes. */
  index() {
    this.bySymbol = new Map();
    for (const s of this.signals) {
      if (!this.bySymbol.has(s.symbol)) this.bySymbol.set(s.symbol, []);
      this.bySymbol.get(s.symbol).push(s);
    }
    for (const list of this.bySymbol.values()) list.sort((a, b) => b.alertT - a.alertT);
  }

  lastSignal(symbol) {
    return this.bySymbol.get(symbol)?.[0] ?? null;
  }

  ingest(batch) {
    const t = this.now();
    this.lastTick = t;
    let touched = false;
    for (const tk of batch) {
      this.tickers.set(tk.symbol, tk);
      for (const s of this.bySymbol.get(tk.symbol) ?? []) {
        if (s.status !== 'TRACKING') continue;
        updateSignal(s, tk.price, t);
        s.volume24h = tk.quoteVolume ?? s.volume24h;
        touched = true;
        if (s.status === 'CLOSED') this.emit('closed', s);
      }
      let arm = this.arms.get(tk.symbol);
      if (!arm) this.arms.set(tk.symbol, (arm = {}));
      if (shouldFire(arm, tk, this.lastSignal(tk.symbol), t, this.threshold)) {
        if (this.breakout) this.consider(tk, t);
        else this.fire(tk, t);
      }
    }
    if (touched) this.saveSoon();
    this.emit('change');
  }

  /** A pair crossed the trigger: fetch its history and alert only if it is a first breakout. */
  async consider(tk, t) {
    const { symbol } = tk;
    if (this.checking.has(symbol)) return;
    const memo = this.skipped.find((x) => x.symbol === symbol);
    if (memo && t - memo.t < SKIP_MEMO_MS) return;
    this.checking.add(symbol);
    try {
      let candles = null;
      for (let attempt = 0; attempt < 3 && !candles; attempt++) {
        try {
          candles = await this.source.getCandles(symbol, '1h', t - (this.breakout.lookbackDays + 2) * 86_400_000, 1000);
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
        }
      }
      const at = { price: tk.price, t, volume24h: tk.quoteVolume ?? null };
      const res = candles ? firstBreakout(candles, at, this.breakout) : null;
      if (res?.pass) {
        this.fire(tk, t, { rangeHigh: res.rangeHigh, rangeLow: res.rangeLow, priorRise: res.priorRise, baseRange: res.baseRange, volMult: res.volMult, days: res.days, checks: res.checks });
        return;
      }
      const skip = {
        symbol,
        t,
        price: tk.price,
        low24h: tk.low24h,
        checks: res?.checks ?? [{ id: 'error', label: 'Could not load price history', value: null, ok: false }],
      };
      this.skipped = [skip, ...this.skipped.filter((x) => x.symbol !== symbol && t - x.t < SKIP_KEEP_MS)].slice(0, 300);
      this.emit('skipped', skip);
      this.emit('change');
    } finally {
      this.checking.delete(symbol);
    }
  }

  fire(tk, t, breakout = null) {
    // A new move on the pair takes over from any earlier one still being tracked.
    for (const s of this.bySymbol.get(tk.symbol) ?? []) {
      if (s.status === 'TRACKING') {
        closeSignal(s, t, 'A new signal fired on this pair');
        this.emit('closed', s);
      }
    }
    const sig = createSignal({ symbol: tk.symbol, price: tk.price, low24h: tk.low24h, t, volume24h: tk.quoteVolume ?? null, threshold: this.threshold, breakout });
    this.signals.unshift(sig);
    this.index();
    this.save();
    this.enrich(sig).finally(() => this.emit('alert', sig));
  }

  /** Whale positioning and open interest for a fresh alert; never holds an alert back for more than 3 seconds. */
  async enrich(sig) {
    const timeout = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 3000))]);
    const [whale, oi] = await Promise.all([
      this.whaleLookup ? timeout(this.whaleLookup(sig.symbol)).catch(() => null) : null,
      timeout(this.source.getOpenInterest?.(sig.symbol)).catch(() => null),
    ]);
    sig.whale = whaleContext(whale, sig.alertPrice, this.now());
    if (oi > 0) sig.oiUsd = oi * sig.alertPrice;
    this.save();
  }

  /** Open interest (USD) for every tracked pair, a few requests at a time. */
  async refreshOi() {
    if (!this.source.getOpenInterest || this.oiBusy) return;
    this.oiBusy = true;
    try {
      const symbols = [...new Set(this.signals.filter((s) => s.status === 'TRACKING').map((s) => s.symbol))];
      const out = new Map();
      for (let i = 0; i < symbols.length; i += OI_CONCURRENCY) {
        await Promise.all(symbols.slice(i, i + OI_CONCURRENCY).map(async (sym) => {
          try {
            const oi = await this.source.getOpenInterest(sym);
            const price = this.tickers.get(sym)?.price;
            if (oi > 0 && price > 0) out.set(sym, oi * price);
          } catch {}
        }));
      }
      for (const s of this.signals) if (s.status === 'TRACKING' && out.has(s.symbol)) s.oiUsd = out.get(s.symbol);
      if (out.size) this.saveSoon();
      this.emit('change');
    } finally {
      this.oiBusy = false;
    }
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 5000);
  }

  save() {
    const cutoff = this.now() - KEEP_DAYS * 86_400_000;
    const before = this.signals.length;
    this.signals = this.signals.filter((s) => s.alertT >= cutoff).slice(0, MAX_SIGNALS);
    if (this.signals.length !== before) this.index();
    this.store.save(this.signals);
  }
}
