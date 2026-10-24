// Pump catcher: live alerts from every USDT perpetual, each tracked until the move ends.
import { getCatcher, saveConfig, alertPrefs, beep } from '../catcher-app.js';
import { DEFAULTS, stats } from '../engine.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, fmtAgo, signClass, csv, copyText, toast, store } from '../util.js';

export const fmtDip = (d) => (d > -0.05 ? '0.0%' : fmtPct(d));

export const fmtDuration = (ms) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

const TABS = [
  { id: 'tracking', label: 'Tracking', filter: (s) => s.status === 'TRACKING' },
  { id: 'closed', label: 'Closed', filter: (s) => s.status === 'CLOSED' },
  { id: 'all', label: 'Last 30 days', filter: () => true },
];

const SORTS = {
  alertT: (s) => s.alertT,
  symbol: (s) => s.symbol,
  rise: (s) => s.rise,
  dip: (s) => s.dip,
  now: (s) => (s.lastPrice - s.alertPrice) / s.alertPrice,
  gap: (s) => s.gap ?? -999,
};

const SETTINGS = [
  ['minRise', 'Min rise off 24h low', '%', 0.5],
  ['maxRise', 'Max rise off 24h low', '%', 1],
  ['minImpulse', 'Min 5-minute move', '%', 0.5],
  ['minRvol', 'Min volume spike', '×', 0.5],
  ['minTakerBuy', 'Min taker buy share', '0–1', 0.01],
  ['minOiChange', 'Min open interest rise (15m)', '%', 0.5],
  ['minGap', 'Min whale − crowd gap', 'pts', 1],
  ['stopPct', 'Close when below alert by', '%', 0.5],
  ['trailGiveBack', 'Close after giving back', 'share', 0.05],
];

export function pumpsView(root, { go }) {
  let tab = store.get('catcher-tab', 'tracking');
  let sort = { key: 'alertT', dir: -1 };
  let showAll = false;
  let catcher;
  let alive = true;
  let off = [];

  const statsRow = h('div.summary');
  const tabs = h('div.lenses', { role: 'tablist', 'aria-label': 'Signals' });
  const tableWrap = h('div.table-wrap');
  const more = h('button.btn.ghost', { onclick: () => ((showAll = !showAll), render()) });
  const near = h('div.near');
  const pulse = h('span.pulse', 'Starting…');
  const settings = h('div.settings');
  settings.hidden = true;
  const settingsBtn = h('button.btn.ghost', { 'aria-expanded': 'false', onclick: () => {
    settings.hidden = !settings.hidden;
    settingsBtn.setAttribute('aria-expanded', String(!settings.hidden));
  } }, 'Settings');

  root.replaceChildren(
    h('section.hero',
      h('div.hero-text',
        h('p.eyebrow', 'Every USDT perpetual · checked every 5 seconds'),
        h('h1', 'Pump catcher'),
        h('p.lede', 'Fires when a pair lifts off its 24-hour low with real buying behind it, then follows the move until it ends.'),
      ),
      pulse,
    ),
    statsRow,
    h('section.panel',
      h('div.toolbar', tabs, h('div.toolbar-right', settingsBtn, h('button.btn.ghost', { onclick: exportCsv }, 'Copy as CSV'))),
      settings,
      tableWrap,
      h('div.table-foot', more, h('p.note', 'Rise after alert: best gain since the alert. Dip before peak: the lowest point between the alert and that best gain.')),
    ),
    h('div.split',
      h('section.panel.grow',
        h('h2', 'Close to firing'),
        h('p.note', 'Pairs moving off their low right now, and which checks they pass.'),
        near),
      h('section.panel.side', h('h2', 'How a signal fires'), explainer()),
    ),
  );

  function explainer() {
    return h('ol.steps',
      h('li', h('strong', 'Lift-off. '), 'Price is a moderate distance above its rolling 24h low and moved fast in the last 5 minutes. Too far above the low and the move is already spent.'),
      h('li', h('strong', 'Fuel. '), 'Volume is spiking, market buyers outweigh sellers (positive CVD), and open interest is growing, so new positions are opening, not just shorts closing.'),
      h('li', h('strong', 'Positioning. '), 'Whales are longer than the crowd, or the crowd is heavily short and can be squeezed.'),
      h('li', h('strong', 'Tracking. '), 'After the alert, the best gain and the dip before it are recorded. Tracking stops if price falls well below the alert or gives back most of its gain.'),
    );
  }

  function renderSettings() {
    const cfg = catcher.cfg;
    const prefs = alertPrefs.get();
    settings.replaceChildren(
      h('form.controls', { onsubmit: (e) => e.preventDefault() },
        ...SETTINGS.map(([key, label, unit, step]) =>
          h('label.field', h('span', `${label} (${unit})`),
            h('input', { id: 'cfg-' + key, type: 'number', step, value: cfg[key], onchange: (e) => {
              const v = +e.target.value;
              if (Number.isFinite(v)) saveConfig(catcher, { [key]: v });
            } }))),
        h('label.check', h('input#cfg-edge', { type: 'checkbox', checked: cfg.requireEdge, onchange: (e) => saveConfig(catcher, { requireEdge: e.target.checked }) }), 'Require positioning edge'),
        h('label.check', { title: 'Needs exact whale data (whale data server). Skips alerts where Binance Smart Money whales lean short and their shorts are not losing. Pairs without whale data are never blocked.' },
          h('input#cfg-whale', { type: 'checkbox', checked: cfg.requireWhaleBias, onchange: (e) => saveConfig(catcher, { requireWhaleBias: e.target.checked }) }), 'Only alert when whale bias agrees'),
      ),
      h('div.controls',
        h('label.check', h('input#alert-sound', { type: 'checkbox', checked: prefs.sound, onchange: (e) => {
          alertPrefs.set({ ...alertPrefs.get(), sound: e.target.checked });
          if (e.target.checked) beep();
        } }), 'Sound on new alert'),
        h('label.check', h('input#alert-desktop', { type: 'checkbox', checked: prefs.desktop, onchange: async (e) => {
          let on = e.target.checked;
          if (on && 'Notification' in window && Notification.permission !== 'granted') {
            on = (await Notification.requestPermission().catch(() => 'denied')) === 'granted';
            if (!on) toast('Your browser blocked notifications. Allow them in site settings to use desktop alerts.');
          }
          e.target.checked = on;
          alertPrefs.set({ ...alertPrefs.get(), desktop: on });
        } }), 'Desktop notification'),
        h('button.btn.ghost', { type: 'button', onclick: () => { saveConfig(catcher, DEFAULTS); renderSettings(); toast('Settings reset to defaults'); } }, 'Reset to defaults'),
      ),
      h('p.note', 'Changes apply to new alerts. These defaults are a starting point, not tuned values: adjust them and watch how the hit rate below changes.'),
    );
  }

  function render() {
    if (!alive || !catcher) return;
    const all = catcher.signals;
    const st = stats(all);
    const last24 = all.filter((s) => Date.now() - s.alertT < 86_400_000).length;
    statsRow.replaceChildren(
      stat('Pairs scanned', catcher.tickers.size),
      stat('Tracking now', st.tracking),
      stat('Alerts, last 24h', last24),
      stat('Reached +10%', st.hit10 == null ? '–' : `${Math.round(st.hit10 * 100)}%`, `of ${st.count} alerts, 30 days`),
      stat('Median rise', st.medianRise == null ? '–' : fmtPct(st.medianRise), 'after alert'),
      stat('Median dip before peak', st.medianDip == null ? '–' : fmtDip(st.medianDip)),
    );
    pulse.textContent = catcher.state === 'live'
      ? `${catcher.demo ? 'Demo market' : 'Live'} · checked ${catcher.lastEval ? fmtAgo(catcher.lastEval) : 'just now'}`
      : catcher.state === 'reconnecting' ? 'Reconnecting to Binance…' : 'Starting…';
    pulse.dataset.state = catcher.state;

    tabs.replaceChildren(...TABS.map((t) => h('button.lens', {
      role: 'tab',
      'aria-selected': String(t.id === tab),
      onclick: () => { tab = t.id; store.set('catcher-tab', tab); render(); },
    }, `${t.label} ${all.filter(t.filter).length}`)));

    const rows = all.filter(TABS.find((t) => t.id === tab).filter);
    const f = SORTS[sort.key];
    rows.sort((a, b) => {
      const x = f(a), y = f(b);
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir;
    });
    const visible = showAll ? rows : rows.slice(0, 50);
    more.hidden = rows.length <= 50;
    more.textContent = showAll ? 'Show 50' : `Show all ${rows.length}`;

    const th = (key, label, title) => h('th', { scope: 'col', title: title || '', 'aria-sort': sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
      key ? h('button.th-btn', { onclick: () => { sort = { key, dir: sort.key === key ? -sort.dir : -1 }; render(); } }, label, sort.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : '') : label);

    tableWrap.replaceChildren(h('table.grid.signals',
      h('thead', h('tr',
        th('alertT', 'Alerted'),
        th('symbol', 'Pair'),
        th(null, 'Alert price'),
        th('now', 'Now', 'Change since the alert'),
        th('rise', 'Rise after alert', 'Best gain after the alert, and how long it took'),
        th('dip', 'Dip before peak', 'Lowest point between the alert and the best gain'),
        th(null, 'Fuel at alert', 'Volume spike, taker buy share and open interest change when it fired'),
        th('gap', 'Gap', 'Whale long % minus crowd long % at the alert'),
        th(null, 'Whales', 'Binance Smart Money whales at the alert price (needs the whale data server)'),
        th(null, 'Status'),
      )),
      h('tbody', visible.length ? visible.map(row) : h('tr', h('td.empty', { colSpan: 10 }, emptyText()))),
    ));

    renderNear();
  }

  function emptyText() {
    if (tab === 'tracking') return 'No signals are being tracked. New alerts appear here as soon as they fire.';
    if (tab === 'closed') return 'No closed signals yet.';
    return 'No alerts in the last 30 days.';
  }

  const stat = (label, value, sub) => h('div.stat', h('span.stat-label', label), h('span.stat-value', value), sub && h('span.stat-sub', sub));

  function row(s) {
    const nowChg = ((s.lastPrice - s.alertPrice) / s.alertPrice) * 100;
    const open = () => go('signal', s.id);
    return h('tr', { tabIndex: 0, onclick: open, onkeydown: (e) => e.key === 'Enter' && open(), class: Date.now() - s.alertT < 60_000 ? 'fresh-row' : '' },
      h('td.num.muted', { title: new Date(s.alertT).toLocaleString() }, fmtAgo(s.alertT)),
      h('th.pair', { scope: 'row' }, h('span.pair-name', ticker(s.symbol)), s.demo && h('span.chip.aligned', { title: 'Invented example' }, 'Example')),
      h('td.num', fmtPrice(s.alertPrice)),
      h(`td.num.${signClass(nowChg)}`, fmtPct(nowChg)),
      h('td.num', h(`span.${signClass(s.rise)}`, fmtPct(s.rise)), h('span.muted', ` in ${fmtDuration(s.peakT - s.alertT)}`)),
      h(`td.num.${s.dip <= -0.05 ? 'down' : ''}`, fmtDip(s.dip)),
      h('td.num.muted', fuel(s)),
      h('td.num', s.gap == null ? '–' : `${s.gap > 0 ? '+' : ''}${Math.round(s.gap)}`),
      h('td', whaleChip(s.whale)),
      h('td', h(`span.status.${s.status.toLowerCase()}`, { title: s.closeReason || 'Still following this move' }, s.status === 'TRACKING' ? 'Tracking' : 'Closed')),
    );
  }

  const fuel = (s) => [
    s.rvol != null && `${s.rvol.toFixed(1)}× vol`,
    s.takerBuy != null && `${Math.round(s.takerBuy * 100)}% buys`,
    s.oiChange != null && `OI ${fmtPct(s.oiChange)}`,
  ].filter(Boolean).join(' · ');

  function renderNear() {
    const list = catcher.nearMisses().slice(0, 12);
    if (!list.length) {
      near.replaceChildren(h('p.empty', 'Nothing is lifting off its low right now.'));
      return;
    }
    near.replaceChildren(h('ul.near-list', ...list.map((c) =>
      h('li',
        h('button.near-pair', { onclick: () => go('token', c.symbol) }, h('span.pair-name', ticker(c.symbol))),
        h('span.num', `${fmtPct(c.screen.rise)} off low`),
        h(`span.num.${signClass(c.screen.impulse)}`, `${fmtPct(c.screen.impulse)} 5m`),
        h('span.checks', ...(c.checks
          ? c.checks.map((x) => h(`span.check-chip.${x.ok ? 'ok' : 'no'}`, { title: x.label }, `${x.ok ? '✓' : '✕'} ${shortLabel(x)}`))
          : [h('span.muted', c.error ? 'Lookup failed' : 'Checking…')])),
      ))));
  }

  function whaleChip(w) {
    if (!w) return h('span.muted', '–');
    const title = [
      `Whales ${Math.round(w.longShare * 100)}% long by size`,
      w.longEntry && `long entry ${fmtPrice(w.longEntry)} (${fmtPct(w.distLong)} away)`,
      w.shortEntry && `short entry ${fmtPrice(w.shortEntry)}${w.shortsUnderwater ? `, shorts losing ${fmtUsd(-w.shortUpnl)}` : ''}`,
      w.ageH != null && `Binance data ${w.ageH.toFixed(1)} h old`,
    ].filter(Boolean).join(' · ');
    if (w.shortsUnderwater) return h('span.wchip.good', { title }, `Shorts −${fmtUsd(-w.shortUpnl)}`);
    if (w.nearLongEntry) return h('span.wchip.good', { title }, 'At long entry');
    return h(`span.wchip.${w.agrees ? 'good' : 'bad'}`, { title }, `${Math.round(w.longShare * 100)}% long`);
  }

  const shortLabel = (x) => ({
    rvol: `Vol ${x.value?.toFixed(1)}×`,
    cvd: `Buys ${Math.round((x.value ?? 0) * 100)}%`,
    oi: `OI ${x.value == null ? '–' : fmtPct(x.value)}`,
    edge: x.value == null ? 'Gap –' : `Gap ${x.value > 0 ? '+' : ''}${Math.round(x.value)}`,
    whale: `Whales ${Math.round((x.value ?? 0) * 100)}% long`,
  })[x.id];

  async function exportCsv() {
    const rows = catcher.signals.filter(TABS.find((t) => t.id === tab).filter);
    const text = csv(rows, [
      { label: 'alert_time', get: (s) => new Date(s.alertT).toISOString() },
      { label: 'pair', get: (s) => s.symbol },
      { label: 'alert_price', get: (s) => s.alertPrice },
      { label: 'rise_after_alert_pct', get: (s) => s.rise.toFixed(2) },
      { label: 'minutes_to_peak', get: (s) => Math.round((s.peakT - s.alertT) / 60_000) },
      { label: 'dip_before_peak_pct', get: (s) => s.dip.toFixed(2) },
      { label: 'rise_off_24h_low_pct', get: (s) => s.riseFromLow?.toFixed(2) },
      { label: 'rvol', get: (s) => s.rvol?.toFixed(2) },
      { label: 'taker_buy_share', get: (s) => s.takerBuy?.toFixed(3) },
      { label: 'oi_change_pct', get: (s) => s.oiChange?.toFixed(2) },
      { label: 'whale_crowd_gap', get: (s) => s.gap?.toFixed(1) },
      { label: 'sm_whale_long_share', get: (s) => s.whale?.longShare?.toFixed(3) },
      { label: 'sm_whale_shorts_underwater', get: (s) => (s.whale ? String(s.whale.shortsUnderwater) : '') },
      { label: 'sm_whale_short_upnl_usd', get: (s) => (s.whale?.shortUpnl != null ? Math.round(s.whale.shortUpnl) : '') },
      { label: 'sm_whale_long_entry_dist_pct', get: (s) => s.whale?.distLong?.toFixed(2) },
      { label: 'status', get: (s) => s.status },
      { label: 'close_reason', get: (s) => s.closeReason || '' },
    ]);
    if (await copyText(text)) toast(`Copied ${rows.length} signals as CSV`);
    else toast('Your browser blocked the clipboard.');
  }

  getCatcher().then((c) => {
    if (!alive) return;
    catcher = c;
    renderSettings();
    let pending = false;
    off.push(c.on('change', () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; render(); }, 1000);
    }));
    render();
  }).catch((e) => tableWrap.replaceChildren(h('p.error', `The scanner couldn't start. ${e.message}`)));

  return () => {
    alive = false;
    off.forEach((f) => f());
  };
}
