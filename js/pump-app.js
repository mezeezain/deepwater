// The browser's Pump Catcher. Two modes:
//   shared – reads the signal log published by worker/catcher.mjs on your server, so every device shows
//            the same record, built from round-the-clock scanning;
//   local  – scans in this browser while the page is open and keeps its own 30-day log.
// Shared is used whenever the server answers; local is the fallback (and demo mode is always local).
// Alerts reach you the moment they fire: there is no delay tier.
import { get, isDemo, getSmartOverview, whaleServer } from './api.js';
import { createBinanceSource } from './binance.js';
import { createDemoMarket, demoHistory } from './demo-market.js';
import { PumpScanner } from './pump-scanner.js';
import { THRESHOLD, validSignal } from './pump.js';
import { store } from './util.js';

// The ticker fallback polls every 10 s, so it must not be served from the 30 s cache.
const binanceGet = (path, params) => get(path, params, path === '/fapi/v1/ticker/24hr' ? 5_000 : 30_000);
const API_VERSION = 2; // shape of /api/catcher served by worker/catcher.mjs
let instance;

export function getPumps() {
  if (!instance) instance = boot();
  return instance;
}

/** 'auto' (shared when the server answers) or 'local'. Changing it reloads the page. */
export const pumpMode = {
  get: () => store.get('pump-mode', 'auto'),
  set(mode) {
    store.set('pump-mode', mode);
    location.reload();
  },
};

// Data the previous pump scanner kept in this browser; its signals used different rules and fields.
function dropOldScannerData() {
  try {
    for (const k of ['signals', 'signals-demo', 'catcher-cfg', 'catcher-tab', 'catcher-scope', 'catcher-mode']) localStorage.removeItem('dw:' + k);
  } catch {}
}

async function boot() {
  dropOldScannerData();
  const demo = await isDemo();
  if (!demo && pumpMode.get() !== 'local') {
    const shared = await SharedPumps.connect(whaleServer.get());
    if (shared) {
      shared.on('alert', notify);
      return shared;
    }
  }
  return bootLocal(demo);
}

async function bootLocal(demo) {
  const source = demo ? createDemoMarket() : createBinanceSource({ get: binanceGet });
  // Demo and live signals are kept apart so invented numbers never mix with real ones.
  const key = demo ? 'pumps-demo' : 'pumps';
  const signalStore = {
    load: () => store.get(key, null) ?? (demo ? demoHistory(source) : []),
    save: (signals) => store.set(key, signals),
  };
  const whaleLookup = async (symbol) => {
    const sum = (await getSmartOverview())?.rows.get(symbol)?.shown ?? null;
    if (!demo || !sum?.mark) return sum;
    // The demo scanner runs its own simulated prices; rescale the simulated whale book to them.
    const price = scanner.tickers.get(symbol)?.price;
    if (!price) return sum;
    const k = price / sum.mark;
    return { ...sum, mark: price, longEntry: sum.longEntry * k, shortEntry: sum.shortEntry * k, longQty: sum.longQty / k, shortQty: sum.shortQty / k };
  };
  const scanner = new PumpScanner({ source, store: signalStore, whaleLookup });
  scanner.demo = demo;
  scanner.mode = 'local';
  scanner.on('alert', notify);
  await scanner.start();
  return scanner;
}

/**
 * Read-only view of the server's Pump Catcher, refreshed every 10 seconds.
 * Same surface the pages use from PumpScanner: signals, tickers.size, state, lastTick, threshold, on(), source.
 */
class SharedPumps {
  static async connect(base) {
    if (!base) return null;
    try {
      const body = await fetchJson(`${base}/api/catcher`);
      // A demo-mode server would show invented signals as if real; an older server speaks a different format.
      if (body.demo || body.version !== API_VERSION) return null;
      return new SharedPumps(base, body);
    } catch {
      return null;
    }
  }

  constructor(base, body) {
    this.base = base;
    this.mode = 'shared';
    this.demo = false;
    this.listeners = new Map();
    this.source = createBinanceSource({ get: binanceGet });
    this.error = null;
    this.apply(body, true);
    this.timer = setInterval(() => this.poll(), 10_000);
  }

  apply(body, first = false) {
    const known = new Set((this.signals || []).map((s) => s.id));
    this.signals = (Array.isArray(body.signals) ? body.signals : []).filter(validSignal);
    this.threshold = Number.isFinite(body.threshold) ? body.threshold : THRESHOLD;
    this.state = body.state;
    this.lastTick = body.lastTick;
    this.startedAt = body.startedAt;
    this.pairsCount = body.pairs;
    this.receivedAt = Date.now();
    // New alerts since the last poll (not the whole log on first load) go to the toast and sound.
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

export const alertPrefs = {
  get: () => store.get('pump-alerts', store.get('catcher-alerts', { sound: false, desktop: false })),
  set: (v) => store.set('pump-alerts', v),
};

function notify(sig) {
  const prefs = alertPrefs.get();
  const name = sig.symbol.replace(/USDT$/, '');
  const rise = ((sig.alertPrice - sig.startPrice) / sig.startPrice) * 100;
  const text = `${name} at ${+sig.alertPrice.toPrecision(6)} · +${rise.toFixed(1)}% off its 24h low`;
  document.dispatchEvent(new CustomEvent('pump-alert', { detail: { sig, text } }));
  if (prefs.sound) beep();
  if (prefs.desktop && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`Pump: ${name}`, { body: text, tag: sig.id });
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
