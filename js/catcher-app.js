// The browser's single pump catcher instance. Starts on first use and keeps
// scanning while you move between screens.
import { get, isDemo, getSmartOverview } from './api.js';
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

async function boot() {
  const demo = await isDemo();
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
  catcher.on('alert', notify);
  await catcher.start();
  return catcher;
}

export function saveConfig(catcher, patch) {
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
