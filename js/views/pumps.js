// Pump catcher: alerts from every USDT perpetual, each tracked to a realised result.
import { getCatcher, saveConfig, alertPrefs, beep, catcherMode, getBacktest } from '../catcher-app.js';
import { DEFAULTS, stats, realised, configId } from '../engine.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, fmtAgo, signClass, csv, copyText, toast, store, fill, riskNote } from '../util.js';

export const fmtDip = (d) => (d > -0.05 ? '0.0%' : fmtPct(d));

export const fmtDuration = (ms) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

const TABS = [
  { id: 'tracking', label: 'Open', filter: (s) => s.status === 'TRACKING' },
  { id: 'closed', label: 'Closed', filter: (s) => s.status === 'CLOSED' },
  { id: 'all', label: 'Last 30 days', filter: () => true },
];

const SORTS = {
  alertT: (s) => s.alertT,
  symbol: (s) => s.symbol,
  rise: (s) => s.rise,
  dip: (s) => s.dip,
  result: (s) => realised(s) ?? -999,
  now: (s) => (s.lastPrice - s.alertPrice) / s.alertPrice,
  gap: (s) => s.gap ?? -999,
};

const SETTINGS = [
  ['minRise', 'Min rise off 24h low', '%', 0.5],
  ['maxRise', 'Max rise off 24h low', '%', 1],
  ['maxBelowHigh', 'Max distance below 24h high', '%', 1],
  ['minImpulse', 'Min 5-minute move', '%', 0.5],
  ['minRvol', 'Min volume spike', '×', 0.5],
  ['minTakerBuy', 'Min taker buy share', '0–1', 0.01],
  ['minOiChange', 'Min open interest rise (15m)', '%', 0.5],
  ['minGap', 'Min top-20% − crowd gap', 'pts', 1],
  ['stopPct', 'Fixed stop below alert', '%', 0.5],
  ['volStopMult', 'Volatility stop: × 5-min range', '×', 0.5],
  ['trailGiveBack', 'Close after giving back', 'share', 0.05],
  ['costPct', 'Assumed round-trip cost', '%', 0.05],
];

export function pumpsView(root, { go }) {
  let tab = store.get('catcher-tab', 'tracking');
  let scope = store.get('catcher-scope', 'current'); // stats for the current rule set, or all
  let sort = { key: 'alertT', dir: -1 };
  let showAll = false;
  let catcher;
  let alive = true;
  const off = [];

  const sourceLine = h('div.source-banner');
  const record = h('section.panel.record');
  const tabs = h('div.lenses', { role: 'group', 'aria-label': 'Signals' });
  const tableWrap = h('div.table-wrap');
  const more = h('button.btn.ghost', { onclick: () => ((showAll = !showAll), render()) });
  const near = h('div.near');
  const pulse = h('span.pulse', 'Starting…');
  const backtestBox = h('div', h('p.loading', 'Checking for a backtest…'));
  const settings = h('div.settings');
  settings.hidden = true;
  const settingsBtn = h('button.btn.ghost', { 'aria-expanded': 'false', onclick: () => {
    settings.hidden = !settings.hidden;
    settingsBtn.setAttribute('aria-expanded', String(!settings.hidden));
  } }, 'Settings');

  fill(root, 
    riskNote('Alerts are momentum scans, not recommendations; chasing a pump often means buying the top. '),
    h('section.hero',
      h('div.hero-text',
        h('p.eyebrow', 'Every USDT perpetual · checked every 5 seconds'),
        h('h1', 'Pump catcher'),
        h('p.lede', 'Flags pairs lifting off their 24-hour low on strong order flow, then follows each one to an exit so you can see what the alerts actually returned.'),
      ),
      pulse,
    ),
    sourceLine,
    record,
    h('section.panel',
      h('div.toolbar', tabs, h('div.toolbar-right', settingsBtn, h('button.btn.ghost', { onclick: exportCsv }, 'Copy as CSV'))),
      settings,
      h('p.risk', 'These are scanner alerts, not trade advice. Results below are past alerts on Binance futures prices, after an assumed cost; your fills, fees and timing will differ. Futures positioning doesn’t carry over one-to-one to spot markets.'),
      tableWrap,
      h('div.table-foot', more, h('p.note', 'Result: realised % after costs when the signal closed. Peak: best price reached after the alert (best case, not a realistic exit). Dip: the lowest point before that peak.')),
    ),
    h('div.split',
      h('section.panel.grow',
        h('h2', 'Close to firing'),
        h('p.note', 'Pairs moving off their low right now, and which checks they pass.'),
        near),
      h('section.panel.side', h('h2', 'How a signal fires'), explainer()),
    ),
    h('section.panel', h('h2', 'Backtest'), backtestBox),
  );

  function explainer() {
    return h('ol.steps',
      h('li', h('strong', 'Lift-off. '), 'Price has just crossed 27% above its rolling 24h low (1.27× the low) and isn’t far below its 24h high (which would make it a bounce after a drop rather than a breakout).'),
      h('li', h('strong', 'Order flow. '), 'Volume is spiking, market buyers outweigh sellers, and real-time open interest is up over 15 minutes, so new positions are opening.'),
      h('li', h('strong', 'Positioning. '), 'Binance’s top 20% of accounts are longer than the crowd, or the crowd is heavily short.'),
      h('li', h('strong', 'Exit. '), 'Each signal closes at its stop, after giving back most of a gain, or after 72 hours. The exit price is stored, and the record shows the realised result after costs.'),
    );
  }

  function renderSource() {
    if (catcher.mode === 'shared') {
      const stale = catcher.error ? ` Server not answering (${catcher.error}); showing data from ${fmtAgo(catcher.receivedAt)}.` : '';
      sourceLine.dataset.state = catcher.error ? 'warn' : 'shared';
      fill(sourceLine, 
        h('span', h('strong', 'Shared log. '), `Every device shows the same alerts, scanned around the clock on your server.${stale} `),
        h('button.link', { onclick: () => catcherMode.set('local') }, 'Scan in this browser instead'),
      );
    } else {
      sourceLine.dataset.state = catcher.demo ? 'demo' : 'local';
      fill(sourceLine, 
        h('span', h('strong', 'This browser only. '), catcher.demo
          ? 'Demo mode: simulated market and invented history.'
          : 'Scanning runs only while this page is open, and the log is kept in this browser, so other devices show different alerts.'),
        !catcher.demo && catcherMode.get() === 'local'
          ? h('button.link', { onclick: () => catcherMode.set('auto') }, 'Use the shared log')
          : !catcher.demo && h('span.muted', 'The shared log server isn’t reachable.'),
      );
    }
  }

  function renderSettings() {
    const cfg = catcher.cfg;
    const prefs = alertPrefs.get();
    const editable = catcher.mode === 'local';
    const alertsRow = h('div.controls',
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
      editable && h('button.btn.ghost', { type: 'button', onclick: () => { saveConfig(catcher, DEFAULTS); renderSettings(); render(); toast('Settings reset to defaults'); } }, 'Reset to defaults'),
    );
    if (!editable) {
      fill(settings, 
        h('p.note', `The shared log uses your server’s settings (rule set ${catcher.cfgId}). Change them on the server with CATCHER_CONFIG; see the README.`),
        h('dl.kv.cfg-list', ...SETTINGS.map(([key, label, unit]) => h('div', h('dt', label), h('dd', `${cfg[key]} ${unit}`))),
          h('div', h('dt', 'Stop type'), h('dd', cfg.stopMode === 'vol' ? 'Volatility-based' : 'Fixed'))),
        alertsRow,
      );
      return;
    }
    fill(settings, 
      h('form.controls', { onsubmit: (e) => e.preventDefault() },
        ...SETTINGS.map(([key, label, unit, step]) =>
          h('label.field', h('span', `${label} (${unit})`),
            h('input', { id: 'cfg-' + key, type: 'number', step, value: cfg[key], onchange: (e) => {
              const v = +e.target.value;
              if (Number.isFinite(v)) {
                saveConfig(catcher, { [key]: v });
                render();
              }
            } }))),
        h('label.field', h('span', 'Stop type'),
          h('select#cfg-stopMode', { onchange: (e) => { saveConfig(catcher, { stopMode: e.target.value }); render(); } },
            h('option', { value: 'fixed', selected: cfg.stopMode !== 'vol' }, 'Fixed %'),
            h('option', { value: 'vol', selected: cfg.stopMode === 'vol' }, 'Volatility-based'))),
        h('label.check', h('input#cfg-edge', { type: 'checkbox', checked: cfg.requireEdge, onchange: (e) => { saveConfig(catcher, { requireEdge: e.target.checked }); render(); } }), 'Require positioning edge'),
        h('label.check', { title: 'Needs exact whale data. Skips alerts where Binance Smart Money whales lean short and their shorts are not losing. Pairs without whale data are never blocked.' },
          h('input#cfg-whale', { type: 'checkbox', checked: cfg.requireWhaleBias, onchange: (e) => { saveConfig(catcher, { requireWhaleBias: e.target.checked }); render(); } }), 'Only alert when whale bias agrees'),
      ),
      alertsRow,
      h('p.note', 'Each alert stores the rules it fired with. Changing a setting starts a new rule set, and the record above can show it on its own. Defaults are a starting point, not tuned values.'),
    );
  }

  function currentRuleId() {
    return catcher.mode === 'shared' ? catcher.cfgId : configId(catcher.cfg);
  }

  function renderRecord() {
    const all = catcher.signals;
    const rid = currentRuleId();
    const mine = all.filter((s) => s.cfgId === rid);
    const pool = scope === 'current' ? mine : all;
    const cost = catcher.cfg.costPct ?? DEFAULTS.costPct;
    const st = stats(pool, { costPct: cost });
    const pctOr = (v, digits = 0) => (v == null ? '–' : `${(v * 100).toFixed(digits)}%`);
    const tile = (label, value, sub, cls = '') => h('div.stat', h('span.stat-label', label), h(`span.stat-value${cls ? '.' + cls : ''}`, value), sub && h('span.stat-sub', sub));
    const small = st.closed < 20;
    fill(record, 
      h('div.toolbar',
        h('h2', 'Track record'),
        h('div.lenses', { role: 'group', 'aria-label': 'Which alerts' },
          h('button.lens', { type: 'button', 'aria-pressed': String(scope === 'current'), onclick: () => { scope = 'current'; store.set('catcher-scope', scope); render(); } }, `Current rules · ${mine.length}`),
          h('button.lens', { type: 'button', 'aria-pressed': String(scope === 'all'), onclick: () => { scope = 'all'; store.set('catcher-scope', scope); render(); } }, `All rules · ${all.length}`))),
      h('div.summary',
        tile('Closed signals', st.closed, `${st.tracking} still open`),
        tile('Win rate', pctOr(st.winRate), 'closed, after costs'),
        tile('Average win / loss', st.avgWin == null && st.avgLoss == null ? '–' : `${st.avgWin == null ? '–' : fmtPct(st.avgWin)} / ${st.avgLoss == null ? '–' : fmtPct(st.avgLoss)}`),
        tile('Expectancy', st.expectancy == null ? '–' : fmtPct(st.expectancy, 2), `per signal, after ${cost}% costs`, signClass(st.expectancy)),
        tile('Hit the stop', pctOr(st.stopped), 'of closed signals'),
        tile('Best case', st.medianPeak == null ? '–' : fmtPct(st.medianPeak), `median peak · ${pctOr(st.hit10)} touched +10%`),
      ),
      scope === 'current' && !mine.length && all.length
        ? h('p.note', `None of the ${all.length} alerts in the log were made with the current rules${all.some((s) => !s.cfgId) ? ' (alerts from before rule sets were recorded have none)' : ''}. Choose “All rules” to see them.`)
        : null,
      h('p.note', small
        ? `Only ${st.closed} closed signal${st.closed === 1 ? '' : 's'} so far${scope === 'current' ? ` with rule set ${rid}` : ''}: too few to judge the scanner. Treat these numbers as anecdotes until there are at least a few dozen.`
        : `Rule set ${rid}. Expectancy is the average realised result per closed signal after ${cost}% round-trip costs. Positive expectancy on past alerts doesn't guarantee future results.`),
    );
  }

  function render() {
    if (!alive || !catcher) return;
    const all = catcher.signals;
    renderSource();
    renderRecord();
    const checked = catcher.lastEval ? fmtAgo(catcher.lastEval) : 'just now';
    pulse.textContent = catcher.mode === 'shared'
      ? (catcher.error ? 'Server unreachable · retrying' : `Shared · ${catcher.pairsCount ?? '–'} pairs · checked ${checked}`)
      : catcher.state === 'live' ? `${catcher.demo ? 'Demo market' : 'This browser'} · ${catcher.tickers.size} pairs · checked ${checked}`
      : catcher.state === 'reconnecting' ? 'Reconnecting to Binance…' : 'Starting…';
    pulse.dataset.state = catcher.mode === 'shared' ? (catcher.error ? 'reconnecting' : 'live') : catcher.state;

    fill(tabs, ...TABS.map((t) => h('button.lens', {
      type: 'button',
      'aria-pressed': String(t.id === tab),
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

    fill(tableWrap, h('table.grid.signals',
      h('thead', h('tr',
        th('alertT', 'Alerted'),
        th('symbol', 'Pair'),
        th(null, 'Alert price'),
        th('result', 'Result', 'Realised % after costs for closed signals; change since the alert for open ones'),
        th('rise', 'Peak', 'Best gain after the alert and how long it took (best case)'),
        th('dip', 'Dip', 'Lowest point between the alert and the peak'),
        th(null, 'Order flow at alert', 'Volume spike, taker buy share and open interest change when it fired'),
        th('gap', 'Gap', 'Top 20% accounts long % minus all accounts long %, at the alert'),
        th(null, 'Whales', 'Binance Smart Money whales at the alert price (needs the whale data server)'),
        th(null, 'Status'),
      )),
      h('tbody', visible.length ? visible.map(row) : h('tr', h('td.empty', { colSpan: 10 }, emptyText()))),
    ));

    renderNear();
  }

  function emptyText() {
    if (tab === 'tracking') return 'No open signals. New alerts appear here as soon as they fire.';
    if (tab === 'closed') return 'No closed signals yet.';
    return 'No alerts in the last 30 days.';
  }

  function row(s) {
    const cost = catcher.cfg.costPct ?? DEFAULTS.costPct;
    const result = realised(s, cost);
    const nowChg = ((s.lastPrice - s.alertPrice) / s.alertPrice) * 100;
    const open = () => go('signal', s.id);
    return h('tr', { tabIndex: 0, onclick: open, onkeydown: (e) => e.key === 'Enter' && open(), class: Date.now() - s.alertT < 60_000 ? 'fresh-row' : '' },
      h('td.num.muted', { title: new Date(s.alertT).toLocaleString() }, fmtAgo(s.alertT)),
      h('th.pair', { scope: 'row' }, h('span.pair-name', ticker(s.symbol)), s.demo && h('span.chip.aligned', { title: 'Invented example' }, 'Example')),
      h('td.num', fmtPrice(s.alertPrice)),
      result != null
        ? h(`td.num.${signClass(result)}`, { title: `Exit ${fmtPrice(s.exitPrice ?? s.lastPrice)} · ${s.closeReason}` }, h('strong', fmtPct(result)))
        : h(`td.num.${signClass(nowChg)}`, { title: 'Open: change since the alert, before costs' }, fmtPct(nowChg), h('span.muted', ' open')),
      h('td.num', h(`span.${signClass(s.rise)}`, fmtPct(s.rise)), h('span.muted', ` in ${fmtDuration(s.peakT - s.alertT)}`)),
      h(`td.num.${s.dip <= -0.05 ? 'down' : ''}`, fmtDip(s.dip)),
      h('td.num.muted', flow(s)),
      h('td.num', s.gap == null ? '–' : `${s.gap > 0 ? '+' : ''}${Math.round(s.gap)}`),
      h('td', whaleChip(s.whale)),
      h('td', h(`span.status.${s.status.toLowerCase()}`, { title: s.closeReason || 'Still following this move' }, s.status === 'TRACKING' ? 'Open' : s.closeReason === 'Hit the stop' || /Fell below/.test(s.closeReason || '') ? 'Stopped' : 'Closed')),
    );
  }

  const flow = (s) => [
    s.rvol != null && `${s.rvol.toFixed(1)}× vol`,
    s.takerBuy != null && `${Math.round(s.takerBuy * 100)}% buys`,
    s.oiChange != null && `OI ${fmtPct(s.oiChange)}`,
  ].filter(Boolean).join(' · ');

  function renderNear() {
    const list = catcher.nearMisses().slice(0, 12);
    if (!list.length) {
      fill(near, h('p.empty', 'Nothing is lifting off its low right now.'));
      return;
    }
    fill(near, h('ul.near-list', ...list.map((c) =>
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
    if (w.shortsUnderwater) return h('span.wchip.pos', { title }, `Shorts −${fmtUsd(-w.shortUpnl)}`);
    if (w.nearLongEntry) return h('span.wchip.pos', { title }, 'At long entry');
    return h(`span.wchip.${w.agrees ? 'pos' : 'neg'}`, { title }, `${Math.round(w.longShare * 100)}% long`);
  }

  const shortLabel = (x) => ({
    rvol: `Vol ${x.value?.toFixed(1)}×`,
    cvd: `Buys ${Math.round((x.value ?? 0) * 100)}%`,
    oi: `OI ${x.value == null ? '–' : fmtPct(x.value)}`,
    edge: x.value == null ? 'Gap –' : `Gap ${x.value > 0 ? '+' : ''}${Math.round(x.value)}`,
    whale: `Whales ${Math.round((x.value ?? 0) * 100)}% long`,
  })[x.id];

  async function renderBacktest() {
    const bt = await getBacktest();
    if (!alive) return;
    if (!bt?.test) {
      fill(backtestBox, h('p.note', 'No backtest has been run yet. Until one shows a positive result after costs on data it wasn’t tuned on, treat this page as a positioning dashboard, not a signal service. Run tools/backtest.mjs on your server to replay the engine over Binance’s last 30 days.'));
      return;
    }
    const line = (label, r) => h('tr.static',
      h('th', { scope: 'row' }, label),
      h('td.num', r.signals),
      h('td.num', r.winRate == null ? '–' : `${Math.round(r.winRate * 100)}%`),
      h(`td.num.${signClass(r.expectancy)}`, r.expectancy == null ? '–' : fmtPct(r.expectancy, 2)),
      h('td.num', r.stopped == null ? '–' : `${Math.round(r.stopped * 100)}%`));
    fill(backtestBox, 
      h('p.note', `Run ${new Date(bt.ranAt).toLocaleString()} on ${bt.pairs} pairs, ${bt.days} days of Binance data, ${bt.costPct}% costs. Tuned on the first ${bt.trainDays} days, then tested on the last ${bt.testDays} days, which the tuning never saw.`),
      h('div.table-wrap', h('table.grid',
        h('thead', h('tr', ...['Period', 'Signals', 'Win rate', 'Expectancy', 'Hit stop'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', line('Tuning period (in-sample)', bt.train), line('Test period (unseen)', bt.test)))),
      h('p.note', bt.test.expectancy == null
        ? `No closed signals in the unseen test period, so there is nothing to judge yet. Treat alerts as a watchlist, not trade signals.`
        : bt.test.expectancy <= 0
          ? `On unseen data the chosen rules (${bt.bestRuleId}) lost ${fmtPct(bt.test.expectancy, 2)} per signal after costs over ${bt.test.signals} signals. Treat alerts as a watchlist, not trade signals.`
          : bt.test.closed < 30
            ? `On unseen data the chosen rules (${bt.bestRuleId}) made ${fmtPct(bt.test.expectancy, 2)} per signal after costs, but over only ${bt.test.closed} closed signals: too few to rely on. A replay also ignores real fills and timing.`
            : `On unseen data the chosen rules (${bt.bestRuleId}) made ${fmtPct(bt.test.expectancy, 2)} per signal after costs over ${bt.test.closed} closed signals. A replay ignores real fills and timing, so treat it as an upper bound.`),
      bt.demo && h('p.warn', 'This report was made from synthetic data (--demo), not Binance history.'),
    );
  }

  async function exportCsv() {
    const cost = catcher.cfg.costPct ?? DEFAULTS.costPct;
    const rows = catcher.signals.filter(TABS.find((t) => t.id === tab).filter);
    const text = csv(rows, [
      { label: 'alert_time', get: (s) => new Date(s.alertT).toISOString() },
      { label: 'pair', get: (s) => s.symbol },
      { label: 'rule_set', get: (s) => s.cfgId || '' },
      { label: 'alert_price', get: (s) => s.alertPrice },
      { label: 'status', get: (s) => s.status },
      { label: 'close_reason', get: (s) => s.closeReason || '' },
      { label: 'exit_price', get: (s) => (s.status === 'CLOSED' ? s.exitPrice ?? s.lastPrice : '') },
      { label: 'realised_pct_after_costs', get: (s) => realised(s, cost)?.toFixed(2) ?? '' },
      { label: 'cost_pct', get: () => cost },
      { label: 'stop_pct', get: (s) => s.stopPct ?? '' },
      { label: 'peak_pct', get: (s) => s.rise.toFixed(2) },
      { label: 'minutes_to_peak', get: (s) => Math.round((s.peakT - s.alertT) / 60_000) },
      { label: 'dip_before_peak_pct', get: (s) => s.dip.toFixed(2) },
      { label: 'rise_off_24h_low_pct', get: (s) => s.riseFromLow?.toFixed(2) },
      { label: 'below_24h_high_pct', get: (s) => s.belowHigh?.toFixed(2) ?? '' },
      { label: 'rvol', get: (s) => s.rvol?.toFixed(2) },
      { label: 'taker_buy_share', get: (s) => s.takerBuy?.toFixed(3) },
      { label: 'oi_change_pct', get: (s) => s.oiChange?.toFixed(2) },
      { label: 'top20_crowd_gap', get: (s) => s.gap?.toFixed(1) },
      { label: 'sm_whale_long_share', get: (s) => s.whale?.longShare?.toFixed(3) },
      { label: 'sm_whale_shorts_underwater', get: (s) => (s.whale ? String(s.whale.shortsUnderwater) : '') },
      { label: 'sm_whale_short_upnl_usd', get: (s) => (s.whale?.shortUpnl != null ? Math.round(s.whale.shortUpnl) : '') },
      { label: 'sm_whale_long_entry_dist_pct', get: (s) => s.whale?.distLong?.toFixed(2) },
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
    renderBacktest();
  }).catch((e) => fill(tableWrap, h('p.error', `The scanner couldn't start. ${e.message}`)));

  return () => {
    alive = false;
    off.forEach((f) => f());
  };
}
