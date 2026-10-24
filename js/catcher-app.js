// The browser's pump catcher. Two modes:
//   shared – reads the signal log published by worker/catcher.mjs on your server, so every device
//            shows the same record, built from round-the-clock scanning;
//   local  – scans in this browser while the page is open and keeps its own 30-day log.
// Shared is used whenever the server answers; local is the fallback (and demo mode is always local).
import { get, isDemo, getSmartOverview, whaleServer } from './api.js';
import { createBinanceSource } from './binance.js';
import { createDemoMarket, demoHistory } from './demo-market.js';
import { Catcher } from './catcher.js';
import { DEFAULTS } from './engine.js';
import { store } from './util.js';

let instance;

export function getCatcher() {
  if (!instance) instance = boot();
  return instance;
}

/** 'auto' (shared when the server answers) or 'local'. Changing it reloads the page. */
export const catcherMode = {
  get: () => store.get('catcher-mode', 'auto'),
  set(mode) {
    store.set('catcher-mode', mode);
    location.reload();
  },
};

async function boot() {
  const demo = await isDemo();
  if (!demo && catcherMode.get() !== 'local') {
    const shared = await SharedCatcher.connect(whaleServer.get());
    if (shared) {
      shared.on('alert', notify);
      return shared;
    }
  }
  return bootLocal(demo);
}

async function bootLocal(demo) {
  const source = demo ? createDemoMarket() : createBinanceSource({ get: (path, params) => get(path, params, 30_000) });
  // Demo and live signals are kept apart so invented numbers never mix with real ones.
  const key = demo ? 'signals-demo' : 'signals';
  const signalStore = {
    load: () => {
      const saved = store.get(key, null);
      return saved ?? (demo ? demoHistory(source) : []);
    },
    save: (signals) => store.set(key, signals),
  };
  // Whale context from Binance Smart Money (your whale data server, or simulated in demo mode).
  const whaleLookup = async (symbol) => {
    const sum = (await getSmartOverview())?.rows.get(symbol)?.shown ?? null;
    if (!demo || !sum?.mark) return sum;
    // The demo scanner runs its own simulated prices; rescale the simulated whale book to them
    // so entries sit at sensible distances. Live data never needs this.
    const price = catcher.tickers.get(symbol)?.price;
    if (!price) return sum;
    const k = price / sum.mark;
    return { ...sum, mark: price, longEntry: sum.longEntry * k, shortEntry: sum.shortEntry * k, longQty: sum.longQty / k, shortQty: sum.shortQty / k };
  };
  const catcher = new Catcher({ source, store: signalStore, cfg: store.get('catcher-cfg', {}), whaleLookup });
  catcher.demo = demo;
  catcher.mode = 'local';
  catcher.pairsCount = null;
  catcher.on('alert', notify);
  await catcher.start();
  return catcher;
}

/**
 * Read-only view of the server's pump catcher, refreshed every 10 seconds.
 * Same surface the pages use from Catcher: signals, cfg, state, lastEval, nearMisses(), on(), source.
 */
class SharedCatcher {
  static async connect(base) {
    if (!base) return null;
    try {
      const body = await fetchJson(`${base}/api/catcher`);
      if (body.demo) return null; // a demo-mode server would show invented signals as if real
      return new SharedCatcher(base, body);
    } catch {
      return null;
    }
  }

  constructor(base, body) {
    this.base = base;
    this.mode = 'shared';
    this.demo = false;
    this.listeners = new Map();
    this.source = createBinanceSource({ get: (path, params) => get(path, params, 30_000) });
    this.error = null;
    this.apply(body, true);
    this.timer = setInterval(() => this.poll(), 10_000);
  }

  apply(body, first = false) {
    const known = new Set((this.signals || []).map((s) => s.id));
    this.signals = body.signals || [];
    this.cfg = { ...DEFAULTS, ...body.cfg };
    this.cfgId = body.cfgId;
    this.state = body.state;
    this.lastEval = body.lastEval;
    this.startedAt = body.startedAt;
    this.pairsCount = body.pairs;
    this.near = body.near || [];
    this.receivedAt = Date.now();
    // New alerts since the last poll (not the whole log on first load) go to the alert toast and sound.
    if (!first) for (const s of this.signals) if (!known.has(s.id) && Date.now() - s.alertT < 10 * 60_000) this.emit('alert', s);
  }

  async poll() {
    try {
      this.apply(await fetchJson(`${this.base}/api/catcher`));
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
    this.emit('change');
  }

  nearMisses() {
    return this.near;
  }

  get tickers() {
    return { size: this.pairsCount ?? 0, get: () => null };
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`server answered HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Latest backtest published by the server, or null. */
export async function getBacktest() {
  const base = whaleServer.get();
  if (!base || (await isDemo())) return null;
  try {
    return await fetchJson(`${base}/api/backtest`);
  } catch {
    return null;
  }
}

export function saveConfig(catcher, patch) {
  if (catcher.mode !== 'local') return;
  catcher.setConfig(patch);
  const diff = Object.fromEntries(Object.entries(catcher.cfg).filter(([k, v]) => DEFAULTS[k] !== v));
  store.set('catcher-cfg', diff);
}

export const alertPrefs = {
  get: () => store.get('catcher-alerts', { sound: false, desktop: false }),
  set: (v) => store.set('catcher-alerts', v),
};

function notify(sig) {
  const prefs = alertPrefs.get();
  const name = sig.symbol.replace(/USDT$/, '');
  const text = `${name} alert at ${+sig.alertPrice.toPrecision(6)} · +${sig.riseFromLow.toFixed(1)}% off 24h low`;
  document.dispatchEvent(new CustomEvent('catcher-alert', { detail: { sig, text } }));
  if (prefs.sound) beep();
  if (prefs.desktop && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`Pump alert: ${name}`, { body: text, tag: sig.id });
    } catch {}
  }
}

let audio;
export function beep() {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.setValueAtTime(660, audio.currentTime);
    o.frequency.setValueAtTime(990, audio.currentTime + 0.12);
    g.gain.setValueAtTime(0.08, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.35);
  } catch {}
}
