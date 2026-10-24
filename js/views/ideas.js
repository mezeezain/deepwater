// Live setups: current trade plans for a few pairs on 15m/1h/4h, with exact levels, evidence and history.
import { getLabData, getSmartOverview, getPrices, isDemo, CHART_INTERVALS } from '../api.js';
import { MODELS, LAB_DEFAULTS, runLab } from '../setups.js';
import { activeIdeas, evidence, comparable, watchLevels, priceCheck, HIGHER } from '../ideas.js';
import { beep } from '../catcher-app.js';
import { h, ticker, fmtPrice, fmtPct, signClass, toast, store } from '../util.js';

const FRAMES = ['15m', '1h', '4h'];
const STATE_LABEL = {
  enter: 'Enter at market now',
  limit: 'Limit order waiting',
  running: 'In progress',
};
const MARK = { good: '✓', bad: '✗', neutral: '•' };

const fmtR = (v) => (v == null || !isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
const fmtTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const pctFrom = (p, entry) => ((p - entry) / entry) * 100;

export function ideasView(root, { go }) {
  let pairs = store.get('ideas-pairs', 'BTC, ETH, SOL');
  let filter = store.get('ideas-filter', 'strong'); // 'strong' (A and B) or 'all'
  let notifyOn = store.get('ideas-notify', false);
  let alive = true;
  let symbols = [];
  const data = new Map(); // `${symbol}|${tf}` → { bars, funding, trades }
  const loadedSlot = new Map(); // tf → candle open time the data was loaded for
  let smart = null;
  let prices = new Map();
  let demo = false;
  const seen = new Set();
  let firstPass = true;
  let updatedAt = null;
  const loading = new Set();

  const statusLine = h('p.note', 'Loading BTC, ETH and SOL on three timeframes…');
  const ideasBox = h('div.ideas');
  const watchBox = h('div.table-wrap');
  const filterBtns = h('div.lenses', { role: 'tablist', 'aria-label': 'Which setups' });
  const notifyBtn = h('button.btn.ghost', { type: 'button', onclick: toggleNotify });
  const pairsInput = h('input#ideas-pairs', { value: pairs, 'aria-label': 'Pairs, comma separated', spellcheck: false, autocomplete: 'off' });

  root.replaceChildren(
    h('section.hero.compact',
      h('div.hero-text',
        h('p.eyebrow', '15m · 1h · 4h · refreshed at every candle close'),
        h('h1', 'Live setups'),
        h('p.lede', 'Sweep reclaim, breakout retest and regime confluence setups that are live right now, with exact entry, stop and targets. Each is graded on whale positioning, the bigger timeframe, funding and costs, and shown with how comparable past trades actually did after fees.'),
      ),
    ),
    h('section.panel',
      h('form.toolbar', { onsubmit: (e) => { e.preventDefault(); restart(); } },
        h('label.field.inline', h('span', 'Pairs'), pairsInput),
        filterBtns,
        h('div.toolbar-right', notifyBtn, h('button.btn', { type: 'submit' }, 'Update')),
      ),
      statusLine,
    ),
    ideasBox,
    h('section.panel', h('h2', 'Where the next setups would trigger'), watchBox,
      h('p.note', 'Sweep levels are the 19-candle low and high: a wick through one that closes back inside, with takers and volume behind it, fires a sweep reclaim. A close through the SuperTrend line flips the regime.')),
    h('section.panel', h('h2', 'Read this first'),
      h('ul.method',
        h('li', 'Grades count evidence, not certainty: A means at least three more checks for the trade than against it and a setup record that isn’t negative. Even A setups lose often; the history line under each card shows how often comparable trades made money after costs.'),
        h('li', 'Plan used everywhere on this site: take half at TP1 and move the stop to entry, close the rest at TP2. TP3 is an optional runner for sweeps. Market entries assume the next candle’s open; if price has already run more than 0.3R, the card says not to chase.'),
        h('li', 'Levels come from closed candles. The live price only checks whether a plan is still valid; nothing is repainted.'),
        h('li', 'Top 20% data is Binance’s top accounts by margin, updated every 5 minutes. Smart Money whales come from your whale data server and update about once a day.'),
        h('li', 'This is a research tool, not financial advice. Size positions so a full stop is a loss you can take; leverage makes a stop-out bigger, not less likely.'),
      )),
  );

  function paintControls() {
    filterBtns.replaceChildren(
      ...[['strong', 'Grade A and B'], ['all', 'All setups']].map(([id, label]) => h('button.lens', { type: 'button', role: 'tab', 'aria-selected': String(filter === id), onclick: () => { filter = id; store.set('ideas-filter', id); paintControls(); render(); } }, label)),
    );
    notifyBtn.textContent = notifyOn ? 'Alerts on' : 'Alert me';
    notifyBtn.setAttribute('aria-pressed', String(notifyOn));
  }
  paintControls();

  async function toggleNotify() {
    notifyOn = !notifyOn;
    if (notifyOn && 'Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {}
    }
    store.set('ideas-notify', notifyOn);
    paintControls();
    toast(notifyOn ? 'You’ll get a sound and a notification for new grade A and B setups while this page is open' : 'Alerts off');
  }

  function parsePairs() {
    pairs = pairsInput.value;
    store.set('ideas-pairs', pairs);
    return [...new Set(pairs.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => (s.endsWith('USDT') ? s : s + 'USDT')))].slice(0, 5);
  }

  async function loadFrame(tf) {
    if (loading.has(tf)) return;
    loading.add(tf);
    const slot = Math.floor(Date.now() / CHART_INTERVALS[tf]) * CHART_INTERVALS[tf];
    try {
      for (const symbol of symbols) {
        try {
          const d = await getLabData(symbol, tf);
          if (!alive) return;
          data.set(`${symbol}|${tf}`, { ...d, trades: runLab(d.bars, LAB_DEFAULTS, d.funding).trades.map((t) => ({ ...t, symbol })) });
        } catch (e) {
          data.set(`${symbol}|${tf}`, { error: e.message });
        }
      }
      loadedSlot.set(tf, slot);
    } finally {
      loading.delete(tf);
    }
  }

  async function loadSmart() {
    try {
      smart = await getSmartOverview();
    } catch {
      smart = null;
    }
  }

  async function restart() {
    symbols = parsePairs();
    if (!symbols.length) return;
    data.clear();
    loadedSlot.clear();
    firstPass = true;
    statusLine.textContent = `Loading ${symbols.map(ticker).join(', ')} on 15m, 1h and 4h…`;
    demo = await isDemo();
    await loadSmart();
    for (const tf of FRAMES) {
      await loadFrame(tf);
      if (!alive) return;
      render();
    }
    await refreshPrices();
    firstPass = false;
  }

  async function refreshPrices() {
    try {
      prices = await getPrices(symbols);
      updatedAt = Date.now();
    } catch {}
    if (alive) render();
  }

  /** Reload a timeframe once its candle has closed (a few seconds late, so Binance has the final candle). */
  async function tick() {
    if (!symbols.length || firstPass) return;
    let changed = false;
    for (const tf of FRAMES) {
      const ms = CHART_INTERVALS[tf];
      const slot = Math.floor((Date.now() - 8_000) / ms) * ms;
      if (loadedSlot.has(tf) && loadedSlot.get(tf) !== slot) {
        await loadFrame(tf);
        changed = true;
      }
    }
    if (changed) {
      await loadSmart();
      render();
    }
  }

  function collect() {
    const all = [];
    for (const tf of FRAMES) {
      const pooled = symbols.flatMap((s) => data.get(`${s}|${tf}`)?.trades ?? []);
      for (const symbol of symbols) {
        const d = data.get(`${symbol}|${tf}`);
        if (!d?.bars?.length) continue;
        const higher = data.get(`${symbol}|${HIGHER[tf]}`);
        for (const idea of activeIdeas(d.bars, LAB_DEFAULTS, CHART_INTERVALS[tf])) {
          const ev = evidence(idea, {
            bars: d.bars,
            trades: d.trades,
            pooled,
            higherBars: higher?.bars ?? null,
            higherFrame: HIGHER[tf],
            smart: smart?.rows?.get(symbol)?.shown ?? null,
            funding: d.funding,
          });
          const check = priceCheck(idea, prices.get(symbol));
          all.push({ ...idea, symbol, tf, ev, hist: comparable(idea, ev.whale, pooled), check, invalid: check?.state === 'stop' || check?.state === 'target' });
        }
      }
    }
    const rank = { A: 0, B: 1, C: 2 };
    return all.sort((a, b) => a.invalid - b.invalid || rank[a.ev.grade] - rank[b.ev.grade] || b.ev.score - a.ev.score || b.signalT - a.signalT);
  }

  function announce(ideas) {
    for (const x of ideas) {
      const key = `${x.symbol}|${x.tf}|${x.model}|${x.side}|${x.signalT}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (firstPass || !notifyOn || x.ev.grade === 'C' || x.invalid || x.state === 'running') continue;
      const text = `${ticker(x.symbol)} ${x.tf} ${MODELS[x.model].name} ${x.side > 0 ? 'long' : 'short'} · entry ${fmtPrice(x.entry)} · stop ${fmtPrice(x.stop)} · TP1 ${fmtPrice(x.tp1)}`;
      toast(`New grade ${x.ev.grade} setup: ${text}`);
      beep();
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(`Grade ${x.ev.grade} setup: ${ticker(x.symbol)} ${x.tf}`, { body: text, tag: key });
        } catch {}
      }
    }
  }

  function render() {
    const ideas = collect();
    announce(ideas);
    const shown = filter === 'strong' ? ideas.filter((x) => x.ev.grade !== 'C' && !x.invalid) : ideas;
    const hidden = ideas.length - shown.length;
    const errors = [...data.entries()].filter(([, d]) => d.error).map(([k, d]) => `${k.replace('|', ' ')}: ${d.error}`);
    statusLine.textContent = (demo ? 'Simulated data (demo). ' : '') +
      `${ideas.length} live setup${ideas.length === 1 ? '' : 's'} on ${symbols.map(ticker).join(', ')}` +
      (hidden ? ` (${hidden} weaker or no longer valid hidden)` : '') +
      (updatedAt ? ` · prices ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '') +
      (loading.size ? ` · loading ${[...loading].join(', ')}…` : '') +
      (errors.length ? ` · failed: ${errors.join('; ')}` : '');

    ideasBox.replaceChildren(...(shown.length
      ? shown.map(card)
      : [h('section.panel', h('p.note', ideas.length
        ? `No valid grade A or B setup right now; ${hidden} other${hidden === 1 ? ' is' : 's are'} hidden. Switch to “All setups” to see ${hidden === 1 ? 'it' : 'them'}.`
        : loading.size ? 'Looking for setups…' : 'No live setup on these pairs right now. The table below shows where the next ones would trigger.'))]));

    // Watch levels
    const rows = [];
    for (const symbol of symbols) {
      for (const tf of FRAMES) {
        const d = data.get(`${symbol}|${tf}`);
        if (!d?.bars?.length) continue;
        const w = watchLevels(d.bars);
        if (!w) continue;
        const px = prices.get(symbol) ?? w.price;
        rows.push(h('tr.static',
          h('th.pair', { scope: 'row' }, h('span.pair-name', ticker(symbol)), h('span.sub', ` ${tf}`)),
          h('td.num', fmtPrice(px)),
          h('td.num', fmtPrice(w.low), h('span.sub', ` ${fmtPct(pctFrom(w.low, px))}`)),
          h('td.num', fmtPrice(w.high), h('span.sub', ` ${fmtPct(pctFrom(w.high, px))}`)),
          h(`td.txt.${w.stDir > 0 ? 'up' : 'down'}`, w.stDir > 0 ? 'Up' : 'Down'),
          h('td.num', fmtPrice(w.stLine), h('span.sub', ` ${fmtPct(pctFrom(w.stLine, px))}`)),
        ));
      }
    }
    watchBox.replaceChildren(h('table.grid',
      h('thead', h('tr', ...['Pair', 'Price', 'Sweep long below', 'Sweep short above', 'Regime', 'Flips at'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', rows),
    ));
  }

  function card(x) {
    const m = MODELS[x.model];
    const long = x.side > 0;
    const px = prices.get(x.symbol);
    const lvl = (label, p, r, cls = '') => h(`div.lvl${cls}`,
      h('span.lvl-label', label),
      h('span.lvl-price', fmtPrice(p)),
      h('span.lvl-sub', `${fmtPct(pctFrom(p, x.entry), 2)}${r != null ? ` · ${r}R` : ''}`));
    const stateText = x.state === 'limit'
      ? `${STATE_LABEL.limit} until ${fmtTime(x.expiresT)}`
      : x.state === 'running'
        ? `${STATE_LABEL.running} since ${fmtTime(x.enteredT)}${x.tp1Taken ? ' · TP1 hit, stop now at entry' : ''}`
        : STATE_LABEL.enter;
    const h1 = x.hist.all;
    const hw = x.hist.whale;
    const histLine = h1.n
      ? `Comparable past trades (${m.name.toLowerCase()} ${long ? 'longs' : 'shorts'}, ${x.tf}, ${symbols.map(ticker).join('+')}): ${Math.round(h1.netWin * 100)}% made money after costs, ${fmtR(h1.expR)} per trade over ${h1.n}` +
        (hw?.n ? `. With whales leaning the same way as now: ${Math.round(hw.netWin * 100)}% over ${hw.n}` : '') +
        (h1.n < 30 ? '. Small sample: treat as a rough guide.' : '.')
      : 'No comparable past trades in the loaded history.';
    return h(`section.panel.idea.grade-${x.invalid ? 'c' : x.ev.grade.toLowerCase()}`,
      h('div.idea-head',
        h('span.grade', { title: x.invalid ? 'No longer valid' : `${x.ev.good} checks for, ${x.ev.bad} against` }, x.invalid ? '–' : x.ev.grade),
        h('div.idea-title',
          h('h2', ticker(x.symbol), ' ', h(`span.badge.${long ? 'up' : 'down'}`, long ? 'Long' : 'Short'), h('span.sub', ` ${x.tf} · ${m.name}`)),
          h('p.note', stateText, ' · signal candle ', fmtTime(x.signalT)),
        ),
        h('button.btn.ghost', { type: 'button', onclick: () => go('token', x.symbol) }, 'Chart'),
      ),
      h('div.levels',
        lvl(x.state === 'limit' ? 'Entry (limit)' : 'Entry', x.entry, null),
        lvl('Stop', x.state === 'running' && x.tp1Taken ? x.entry : x.stop, x.state === 'running' && x.tp1Taken ? 0 : -1, '.stop'),
        lvl('TP1 · half', x.tp1, m.tp1, '.tp'),
        lvl('TP2', x.tp2, m.target, '.tp'),
        x.tp3 != null ? lvl('TP3 · runner', x.tp3, 2.5, '.tp') : null,
      ),
      px != null
        ? h('p.note', `Now ${fmtPrice(px)} (${fmtR(x.check?.moved)} from entry)`, x.check?.note ? h(`strong.${x.check.state === 'stop' || x.check.state === 'chasing' ? 'down' : 'up'}`, ` · ${x.check.note}`) : null)
        : null,
      h('ul.checks', x.ev.checks.map((c) => h(`li.${c.state}`, h('span.mark', { 'aria-hidden': 'true' }, MARK[c.state]), h('span.check-label', c.label), h('span.check-detail', c.detail)))),
      h('p.note.hist', histLine),
    );
  }

  restart().catch((e) => (statusLine.textContent = e.message));
  const priceTimer = setInterval(refreshPrices, 10_000);
  const frameTimer = setInterval(() => tick().catch(() => {}), 20_000);
  return () => {
    alive = false;
    clearInterval(priceTimer);
    clearInterval(frameTimer);
  };
}
