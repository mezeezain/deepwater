// Pump scanner: pairs whose last candles moved and traded far above their usual pace.
import { getMarket, getCandles } from '../api.js';
import { sparkline } from '../chart.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, signClass, store } from '../util.js';

const SCAN = 80;

export function pumpsView(root, { go }) {
  let settings = store.get('pump', { interval: '5m', minMove: 2, minVol: 3, sound: false });
  let hits = [];
  let scannedAt = null;
  let alive = true;
  let seen = new Set();

  const controls = h('form.controls', { onsubmit: (e) => e.preventDefault() },
    field('Candle', h('select#pump-interval', { onchange: (e) => update({ interval: e.target.value }) },
      ...['1m', '5m', '15m'].map((v) => h('option', { value: v, selected: v === settings.interval }, v)))),
    field('Min move %', h('input#pump-move', { type: 'number', min: 0.5, step: 0.5, value: settings.minMove, onchange: (e) => update({ minMove: +e.target.value }) })),
    field('Min volume ×', h('input#pump-vol', { type: 'number', min: 1, step: 0.5, value: settings.minVol, onchange: (e) => update({ minVol: +e.target.value }) })),
    h('label.check', h('input#pump-sound', { type: 'checkbox', checked: settings.sound, onchange: (e) => update({ sound: e.target.checked }) }), 'Beep on new signal'),
  );
  const stamp = h('p.note');
  const list = h('div.cards');

  root.replaceChildren(
    h('section.hero.compact',
      h('div.hero-text',
        h('p.eyebrow', `Scans the ${SCAN} most traded pairs every 30 seconds`),
        h('h1', 'Pump scanner'),
        h('p.lede', 'Flags pairs whose latest candle moved sharply on volume well above the recent average. Both directions count: dumps show up too.'),
      ),
    ),
    h('section.panel', controls, stamp, list),
  );

  function field(label, input) {
    return h('label.field', h('span', label), input);
  }

  function update(patch) {
    settings = { ...settings, ...patch };
    store.set('pump', settings);
    scan();
  }

  function beep() {
    try {
      const ac = new AudioContext();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.08, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.25);
    } catch {}
  }

  async function scan() {
    const market = (await getMarket()).slice(0, SCAN);
    const results = await Promise.all(market.map(async (m) => {
      try {
        const k = await getCandles(m.symbol, settings.interval, 31);
        const last = k.at(-1);
        const prev = k.slice(0, -1);
        const avgVol = prev.reduce((s, x) => s + x.v, 0) / prev.length;
        const move = ((last.c - last.o) / last.o) * 100;
        const volX = avgVol ? last.v / avgVol : 0;
        return { ...m, move, volX, lastVol: last.v, closes: k.map((x) => x.c), t: last.t };
      } catch {
        return null;
      }
    }));
    if (!alive) return;
    hits = results
      .filter((r) => r && Math.abs(r.move) >= settings.minMove && r.volX >= settings.minVol)
      .sort((a, b) => Math.abs(b.move) * Math.log1p(b.volX) - Math.abs(a.move) * Math.log1p(a.volX));
    const fresh = hits.filter((x) => !seen.has(x.symbol + x.t));
    if (settings.sound && fresh.length && seen.size) beep();
    hits.forEach((x) => seen.add(x.symbol + x.t));
    scannedAt = Date.now();
    render(new Set(fresh.map((x) => x.symbol)));
  }

  function render(fresh = new Set()) {
    stamp.textContent = scannedAt
      ? `${hits.length} signal${hits.length === 1 ? '' : 's'} · scanned at ${new Date(scannedAt).toLocaleTimeString()}`
      : 'Scanning…';
    if (!hits.length) {
      list.replaceChildren(h('p.empty', scannedAt ? 'Nothing meets your thresholds right now. Lower the minimum move or volume to see more.' : ''));
      return;
    }
    list.replaceChildren(...hits.map((x) =>
      h(`button.card.pump${fresh.has(x.symbol) ? '.fresh' : ''}`, { onclick: () => go('token', x.symbol) },
        h('div.card-top',
          h('span.pair-name', ticker(x.symbol)),
          h(`span.badge.${x.move > 0 ? 'up' : 'down'}`, x.move > 0 ? 'Pump' : 'Dump'),
        ),
        h(`div.big.${signClass(x.move)}`, fmtPct(x.move, 2)),
        h('div.card-meta', h('span', `Volume ${x.volX.toFixed(1)}× normal`), h('span', `24h ${fmtPct(x.change24h)}`)),
        sparkline(x.closes, { width: 220, height: 36, colorVar: x.move > 0 ? '--long' : '--short' }),
        h('div.card-meta', h('span', fmtPrice(x.price)), h('span', `${fmtUsd(x.quoteVolume)} 24h vol`)),
      )));
  }

  render();
  scan().catch((e) => list.replaceChildren(h('p.error', `Scan failed. ${e.message}`)));
  const timer = setInterval(() => scan().catch(() => {}), 30_000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
