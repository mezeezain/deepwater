// Scanner loop around engine.js. Environment-agnostic: the browser and the Node worker
// pass in a data source, a store for signals, and listen for events.
import { DEFAULTS, screen, orderFlow, confirm, createSignal, updateSignal, replayCandles, inCooldown, whaleContext } from './engine.js';

const EVAL_MS = 5000;
const SAMPLE_MS = 5000;
const HISTORY_MS = 7 * 60_000;
const RECHECK_MS = 60_000; // re-check a candidate's order flow at most once a minute
const MAX_CHECKS = 6; // confirmation lookups in flight at once
const KEEP_DAYS = 30;

export class Catcher {
  /**
   * whaleLookup (optional): async symbol -> Binance Smart Money summary or null. Its result is attached
   * to each alert as context and, if cfg.requireWhaleBias is on, can hold an alert back.
   */
  constructor({ source, store, cfg = {}, now = () => Date.now(), whaleLookup = null }) {
    this.source = source;
    this.whaleLookup = whaleLookup;
    this.store = store;
    this.cfg = { ...DEFAULTS, ...cfg };
    this.now = now;
    this.tickers = new Map();
    this.samples = new Map(); // symbol -> [{ t, price }]
    this.seeded = new Map(); // symbol -> price 5m ago from candles, used until our own history covers 5m
    this.candidates = new Map(); // symbol -> { t, screen, checks, gap, pass, error }
    this.inFlight = new Set();
    this.signals = (store.load() || []).filter((s) => this.now() - s.alertT < KEEP_DAYS * 86_400_000);
    this.listeners = new Map();
    this.state = 'starting';
    this.lastEval = null;
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

  setConfig(patch) {
    this.cfg = { ...this.cfg, ...patch };
    this.candidates.clear();
    this.evaluate();
  }

  async start() {
    const first = await this.source.getUniverse();
    this.ingest(first);
    await this.catchUp();
    this.stopStream = this.source.streamTickers(
      (batch) => this.ingest(batch),
      (s) => {
        this.state = s === 'open' ? 'live' : 'reconnecting';
        this.emit('change');
      },
    );
    this.state = 'live';
    this.timer = setInterval(() => this.evaluate(), EVAL_MS);
    this.evaluate();
  }

  stop() {
    clearInterval(this.timer);
    this.stopStream?.();
    this.save();
  }

  /** Signals that were tracking when we last stopped: replay the minutes we missed. */
  async catchUp() {
    const open = this.signals.filter((s) => s.status === 'TRACKING');
    await Promise.all(
      open.map(async (s) => {
        try {
          const candles = await this.source.getCandles1m(s.symbol, s.lastT - 60_000);
          replayCandles(s, candles, this.cfg);
        } catch {
          // Leave it tracking; live prices will continue it.
        }
      }),
    );
    if (open.length) this.save();
  }

  ingest(batch) {
    const t = this.now();
    let tracked = false;
    for (const tk of batch) {
      this.tickers.set(tk.symbol, tk);
      const hist = this.samples.get(tk.symbol) || [];
      if (!hist.length || t - hist[hist.length - 1].t >= SAMPLE_MS) {
        hist.push({ t, price: tk.price });
        while (hist.length && t - hist[0].t > HISTORY_MS) hist.shift();
        this.samples.set(tk.symbol, hist);
      }
      for (const s of this.signals) {
        if (s.symbol === tk.symbol && s.status === 'TRACKING') {
          const before = s.status;
          updateSignal(s, tk.price, t, this.cfg);
          tracked = true;
          if (s.status !== before) this.emit('closed', s);
        }
      }
    }
    if (tracked) this.saveSoon();
  }

  price5mAgo(symbol) {
    const hist = this.samples.get(symbol);
    const t = this.now();
    if (hist?.length && t - hist[0].t >= 4.5 * 60_000) {
      // Oldest sample at or before 5 minutes ago.
      let best = hist[0];
      for (const s of hist) {
        if (t - s.t >= 5 * 60_000) best = s;
        else break;
      }
      return best.price;
    }
    return this.seeded.get(symbol) ?? null;
  }

  evaluate() {
    const t = this.now();
    this.lastEval = t;
    // Expire signals that only time can close (pairs with no trades).
    for (const s of this.signals) if (s.status === 'TRACKING') updateSignal(s, s.lastPrice, Math.max(t, s.lastT), this.cfg);

    const queue = [];
    for (const tk of this.tickers.values()) {
      if (inCooldown(tk.symbol, this.signals, t, this.cfg)) {
        this.candidates.delete(tk.symbol);
        continue;
      }
      const ago = this.price5mAgo(tk.symbol);
      const sc = screen(tk, ago, this.cfg);
      if (!sc.inBand) {
        this.candidates.delete(tk.symbol);
        continue;
      }
      // In the band but no 5m reference yet: fetch one so we don't wait 5 minutes after start.
      if (ago == null && !this.seeded.has(tk.symbol)) queue.push({ symbol: tk.symbol, kind: 'seed' });
      const prev = this.candidates.get(tk.symbol);
      if (!sc.pass) {
        if (prev) prev.screen = sc;
        continue;
      }
      const c = prev || { symbol: tk.symbol, t: 0, checks: null, pass: false };
      c.screen = sc;
      this.candidates.set(tk.symbol, c);
      if (t - c.t >= RECHECK_MS) queue.push({ symbol: tk.symbol, kind: 'check', score: sc.impulse });
    }

    // Strongest impulses first, within the concurrency budget.
    queue.sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const job of queue) {
      if (this.inFlight.size >= MAX_CHECKS) break;
      if (this.inFlight.has(job.symbol)) continue;
      job.kind === 'seed' ? this.seed(job.symbol) : this.check(job.symbol);
    }
    this.emit('change');
  }

  async seed(symbol) {
    this.inFlight.add(symbol);
    try {
      this.seeded.set(symbol, await this.source.getPrice5mAgo(symbol));
    } catch {
      this.seeded.set(symbol, null);
    } finally {
      this.inFlight.delete(symbol);
    }
  }

  async check(symbol) {
    this.inFlight.add(symbol);
    const c = this.candidates.get(symbol);
    try {
      const raw = await this.source.getContext(symbol);
      const flow = orderFlow(raw.klines);
      const ctx = { ...flow, oiChange: raw.oiChange, whaleLong: raw.whaleLong, crowdLong: raw.crowdLong };
      const res = confirm(ctx, this.cfg);
      Object.assign(c, { t: this.now(), checks: res.checks, gap: res.gap, pass: res.pass, ctx, error: null });

      // Re-screen with the latest price: the move may have faded while we were fetching.
      const tk = this.tickers.get(symbol);
      const sc = screen(tk, this.price5mAgo(symbol), this.cfg);
      if (res.pass && sc.pass && !inCooldown(symbol, this.signals, this.now(), this.cfg)) {
        const whale = await this.whaleAt(symbol, tk.price);
        if (this.cfg.requireWhaleBias && whale && !whale.agrees) {
          // Held back by the optional whale filter; show why in "close to firing".
          Object.assign(c, { checks: [...res.checks, { id: 'whale', label: 'Whale bias', value: whale.longShare, ok: false }], pass: false });
          return;
        }
        if (inCooldown(symbol, this.signals, this.now(), this.cfg)) return;
        const sig = createSignal({ symbol, price: tk.price, t: this.now(), rise: sc.rise, impulse: sc.impulse, ctx, gap: res.gap, cfg: this.cfg, belowHigh: sc.belowHigh });
        sig.whale = whale;
        this.signals.unshift(sig);
        this.candidates.delete(symbol);
        this.save();
        this.emit('alert', sig);
      }
    } catch (err) {
      if (c) Object.assign(c, { t: this.now(), error: err.message });
    } finally {
      this.inFlight.delete(symbol);
      this.emit('change');
    }
  }

  /** Whale context at `price`, or null when no lookup is set, it fails, or it takes over 3 seconds. */
  async whaleAt(symbol, price) {
    if (!this.whaleLookup) return null;
    try {
      const sum = await Promise.race([this.whaleLookup(symbol), new Promise((r) => setTimeout(() => r(null), 3000))]);
      return whaleContext(sum, price, this.now());
    } catch {
      return null;
    }
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 3000);
  }

  save() {
    const cutoff = this.now() - KEEP_DAYS * 86_400_000;
    this.signals = this.signals.filter((s) => s.alertT >= cutoff).slice(0, 1000);
    this.store.save(this.signals);
  }

  /** Pairs in the price band, closest to firing first. */
  nearMisses() {
    return [...this.candidates.values()]
      .filter((c) => c.screen?.pass)
      .sort((a, b) => (b.checks?.filter((x) => x.ok).length ?? -1) - (a.checks?.filter((x) => x.ok).length ?? -1) || b.screen.impulse - a.screen.impulse);
  }
}
