// Live setups on Telegram: the same setups, grades and history as the site's Live setups page, checked on
// the server at every candle close and posted when a new one appears. Runs inside worker/catcher.mjs.
//
//   SETUP_ALERTS=off              turn it off (on by default when Telegram is configured)
//   SETUP_PAIRS=BTC,ETH,SOL       up to 5 pairs, as on the page
//   SETUP_FRAMES=15m,1h,4h        timeframes to watch
//   SETUP_GRADES=A,B              which grades to send (A,B,C for everything)
//   SETUP_SENT_FILE               where sent setups are remembered (default worker/setups-sent.json)
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { MODELS, LAB_DEFAULTS, runLab } from '../js/setups.js';
import { labDataFrom, collectIdeas, ideaKey, announceable, FRAME_MS, FRAMES } from '../js/setup-feed.js';

const CHECK_MS = 20_000;
const CLOSE_DELAY_MS = 8_000; // give Binance a few seconds to publish the closed candle
const KEEP_SENT_MS = 7 * 86_400_000;

export function parseSetupConfig(env = process.env) {
  const list = (v, fallback) => (v ? v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) : fallback);
  const pairs = [...new Set(list(env.SETUP_PAIRS, ['BTC', 'ETH', 'SOL']).map((s) => s.toUpperCase()).map((s) => (s.endsWith('USDT') ? s : s + 'USDT')))].slice(0, 5);
  const frames = list(env.SETUP_FRAMES, FRAMES).filter((f) => FRAME_MS[f]);
  const grades = list(env.SETUP_GRADES, ['A', 'B']).map((g) => g.toUpperCase()).filter((g) => ['A', 'B', 'C'].includes(g));
  return { on: env.SETUP_ALERTS !== 'off', pairs, frames: frames.length ? frames : FRAMES, grades: grades.length ? grades : ['A', 'B'] };
}

/**
 * get(path, params): Binance REST. priceFor(symbol): latest price. smartFor(symbol): async Smart Money summary.
 * send(text): post to Telegram. log(...). sentFile: JSON file of keys already sent.
 */
export function startSetupAlerts({ get, priceFor, smartFor, send, log, sentFile, cfg, site, now = () => Date.now() }) {
  const data = new Map();
  const loadedSlot = new Map();
  let sent = loadSent();
  let first = !Object.keys(sent).length; // nothing remembered: note what's live now, send only what appears later
  let busy = false;

  function loadSent() {
    try {
      return JSON.parse(readFileSync(sentFile, 'utf8'));
    } catch {
      return {};
    }
  }
  function saveSent() {
    const cutoff = now() - KEEP_SENT_MS;
    for (const [k, t] of Object.entries(sent)) if (t < cutoff) delete sent[k];
    writeFileSync(sentFile + '.tmp', JSON.stringify(sent));
    renameSync(sentFile + '.tmp', sentFile);
  }

  async function positioning(path, symbol, tf) {
    const from = now() - 30 * 86_400_000 + 60_000;
    const out = [];
    let end = now();
    for (let page = 0; page < 10 && end > from; page++) {
      let rows;
      try {
        rows = await get(path, { symbol, period: tf, limit: 500, endTime: end });
      } catch {
        break;
      }
      if (!rows.length) break;
      out.push(...rows);
      const earliest = Math.min(...rows.map((r) => +r.timestamp));
      if (rows.length < 500 || earliest >= end) break;
      end = earliest - 1;
    }
    return out;
  }

  async function loadFrame(tf) {
    for (const symbol of cfg.pairs) {
      try {
        const [klines, whales, crowd, funding] = await Promise.all([
          get('/fapi/v1/klines', { symbol, interval: tf, limit: 1500 }),
          positioning('/futures/data/topLongShortPositionRatio', symbol, tf),
          positioning('/futures/data/globalLongShortAccountRatio', symbol, tf),
          get('/fapi/v1/fundingRate', { symbol, limit: 1000 }).catch(() => []),
        ]);
        const d = labDataFrom({ klines, whales, crowd, funding }, FRAME_MS[tf], now());
        data.set(`${symbol}|${tf}`, { ...d, trades: runLab(d.bars, LAB_DEFAULTS, d.funding).trades.map((t) => ({ ...t, symbol })) });
      } catch (e) {
        log(`Setups: ${symbol} ${tf} failed: ${e.message}`);
      }
    }
  }

  async function check() {
    if (busy) return;
    busy = true;
    try {
      // The higher timeframe feeds each card's trend check, so load it even when it isn't watched itself.
      const frames = [...new Set([...cfg.frames, ...cfg.frames.map((f) => ({ '15m': '1h', '1h': '4h', '4h': '4h' })[f])])];
      let changed = false;
      for (const tf of frames) {
        const slot = Math.floor((now() - CLOSE_DELAY_MS) / FRAME_MS[tf]) * FRAME_MS[tf];
        if (loadedSlot.get(tf) === slot) continue;
        await loadFrame(tf);
        loadedSlot.set(tf, slot);
        changed = true;
      }
      if (!changed) return;
      const smart = new Map();
      for (const s of cfg.pairs) smart.set(s, await smartFor(s).catch(() => null));
      const ideas = collectIdeas({ symbols: cfg.pairs, frames: cfg.frames, data, smartFor: (s) => smart.get(s), priceFor });
      let newOnes = 0;
      for (const x of ideas) {
        const key = ideaKey(x);
        if (sent[key] || !announceable(x, cfg.grades)) continue;
        sent[key] = now();
        newOnes++;
        if (!first) await send(message(x, cfg.pairs, site));
      }
      if (newOnes || first) saveSent();
      if (first) log(`Setups: watching ${cfg.pairs.join(', ')} on ${cfg.frames.join(', ')}; ${newOnes} already live (not sent), new grade ${cfg.grades.join('/')} setups go to Telegram`);
      else if (newOnes) log(`Setups: sent ${newOnes} new setup${newOnes === 1 ? '' : 's'}`);
      first = false;
    } catch (e) {
      log(`Setups: check failed: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  check();
  const timer = setInterval(check, CHECK_MS);
  return () => clearInterval(timer);
}

const px = (v) => (v == null ? '–' : (+v).toPrecision(6).replace(/\.?0+$/, ''));
const pctFrom = (p, entry) => `${p >= entry ? '+' : ''}${(((p - entry) / entry) * 100).toFixed(2)}%`;
const fmtR = (v) => (v == null || !isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MARK = { good: '✅', bad: '❌', neutral: '▫️' };

/** Telegram message (HTML) for one setup. */
export function message(x, pairs, site = '') {
  const m = MODELS[x.model];
  const long = x.side > 0;
  const name = x.symbol.replace(/USDT$/, '');
  const when = x.state === 'limit'
    ? `limit order, valid until ${new Date(x.expiresT).toISOString().slice(11, 16)} UTC`
    : 'market, on this candle';
  const lines = [
    `${long ? '🟢' : '🔴'} <b>${esc(name)} ${long ? 'LONG' : 'SHORT'}</b> · ${x.tf} · ${esc(m.name)} · <b>Grade ${x.ev.grade}</b>`,
    `Entry <code>${px(x.entry)}</code> (${when})`,
    `Stop <code>${px(x.stop)}</code> (${pctFrom(x.stop, x.entry)})`,
    `TP1 <code>${px(x.tp1)}</code> (${pctFrom(x.tp1, x.entry)}, take half, stop to entry)`,
    `TP2 <code>${px(x.tp2)}</code> (${pctFrom(x.tp2, x.entry)})` + (x.tp3 != null ? `\nTP3 <code>${px(x.tp3)}</code> runner` : ''),
  ];
  if (x.check?.state === 'chasing') lines.push(`⚠️ ${esc(x.check.note)}`);
  lines.push('', ...x.ev.checks.map((c) => `${MARK[c.state]} ${esc(c.label)}: ${esc(c.detail)}`));
  const h = x.hist?.all;
  if (h?.n) {
    lines.push('', `Past comparable trades (${pairs.map((p) => p.replace(/USDT$/, '')).join('+')}): ${Math.round(h.netWin * 100)}% made money after costs, ${fmtR(h.expR)} per trade over ${h.n}${h.n < 30 ? ' (small sample)' : ''}`);
  }
  lines.push('', '<i>A mechanical setup, not financial advice.</i>');
  if (site) lines.push(`<a href="${site}#ideas">Live setups page</a>`);
  return lines.join('\n');
}
