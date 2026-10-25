// Pump Catcher: every Binance USDT perpetual, flagged the moment it rises 27% off its rolling 24h low,
// then followed: gain now, peak, time to peak and the dip before the peak.
import { getPumps, alertPrefs, beep, pumpMode } from '../pump-app.js';
import { metrics, selectRows, headerStats, AT_PEAK_PCT, KEEP_DAYS } from '../pump.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, fmtAgo, signClass, csv, copyText, toast, store, fill, riskNote } from '../util.js';

const PAGE = 15;

export const fmtDip = (d) => (d > -0.05 ? '0.0%' : fmtPct(d));

export const fmtDuration = (ms) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

const fmtVol = (v) => (v == null ? '–' : fmtUsd(v));

const WINDOWS = [['all', 'All'], ['24h', '24H'], ['7d', '7D'], ['30d', '30D']];

export function pumpsView(root, { go }) {
  const saved = store.get('pump-view', {});
  const opts = {
    view: saved.view === 'log' ? 'log' : 'active',
    window: WINDOWS.some(([id]) => id === saved.window) ? saved.window : 'all',
    atPeak: !!saved.atPeak,
    sort: saved.sort === 'volume' ? 'volume' : 'gain',
  };
  let shown = PAGE;
  let scanner;
  let alive = true;
  const off = [];

  const pulse = h('span.pulse', 'Starting…');
  const sourceLine = h('div.source-banner');
  const header = h('div.summary.pump-stats');
  const views = h('div.lenses', { role: 'group', 'aria-label': 'View' });
  const windows = h('div.lenses', { role: 'group', 'aria-label': 'Time window' });
  const filters = h('div.toolbar-right');
  const tableWrap = h('div.table-wrap');
  const more = h('button.btn.ghost', { type: 'button', onclick: () => { shown += PAGE; render(); } });
  const foot = h('p.note');
  const alerts = h('div.controls.alert-prefs');

  const persist = () => store.set('pump-view', opts);
  const set = (patch) => { Object.assign(opts, patch); shown = PAGE; persist(); render(); };

  fill(root,
    riskNote('An alert means a strong move has already happened; chasing it often means buying near the top. '),
    h('section.hero',
      h('div.hero-text',
        h('p.eyebrow', 'Every Binance USDT perpetual · live prices'),
        h('h1', 'Pump catcher'),
        h('p.lede', 'Flags the moment a pair rises 27% off its rolling 24-hour low, then follows the move: gain now, peak, time to peak and the dip before the peak.'),
      ),
      pulse,
    ),
    sourceLine,
    header,
    h('section.panel',
      h('div.toolbar', h('div.toolbar-left', views, windows), filters),
      tableWrap,
      h('div.table-foot', more, foot),
      h('p.note', 'Percentages track price movement after detection. They are not trading results, and not every caught pump keeps rising: some reverse soon after the alert.'),
    ),
    h('div.split',
      h('section.panel.grow', h('h2', 'How a signal fires'), explainer()),
      h('section.panel.side', h('h2', 'Alerts'),
        h('p.note', 'Once this page has been opened, new alerts pop up on every page of the site the moment they fire. Optional extras:'),
        alerts,
        h('button.btn.ghost', { type: 'button', onclick: exportCsv }, 'Copy table as CSV')),
    ),
  );

  function explainer() {
    return h('ol.steps',
      h('li', h('strong', 'Watch every pair. '), 'All Binance USDT-margined perpetual futures, from the live all-market ticker stream.'),
      h('li', h('strong', 'Track the rolling 24h low. '), 'Each pair’s lowest price of the last 24 hours is the baseline, shown as the start price.'),
      h('li', h('strong', 'Fire on the rebound. '), 'When price climbs 27% above that low (1.27× the start price), an alert fires. The first price seen at or past the line is the alert price. A pair already above the line when scanning starts waits for its next crossing.'),
      h('li', h('strong', 'Follow the move. '), 'Gain now, the peak since the alert, time to peak, and the deepest dip before the peak. A pair can fire again after 24 hours, or sooner off a fresh, lower 24h low.'),
      h('li', h('strong', 'Close. '), `A signal stays active until price falls back to the 24h low it started from, a new signal fires on the same pair, or ${KEEP_DAYS} days pass. The log keeps ${KEEP_DAYS} days.`),
    );
  }

  function renderAlerts() {
    const prefs = alertPrefs.get();
    fill(alerts,
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
    );
  }

  function renderSource() {
    if (scanner.mode === 'shared') {
      const stale = scanner.error ? ` Server not answering (${scanner.error}); showing data from ${fmtAgo(scanner.receivedAt)}.` : '';
      sourceLine.dataset.state = scanner.error ? 'warn' : 'shared';
      fill(sourceLine,
        h('span', h('strong', 'Shared log. '), `Every device shows the same alerts, scanned around the clock on your server.${stale} `),
        h('button.link', { onclick: () => pumpMode.set('local') }, 'Scan in this browser instead'),
      );
    } else {
      sourceLine.dataset.state = scanner.demo ? 'demo' : 'local';
      fill(sourceLine,
        h('span', h('strong', scanner.demo ? 'Demo. ' : 'This browser only. '), scanner.demo
          ? 'Simulated market and invented history.'
          : 'Scanning runs only while this page is open, and the log is kept in this browser, so other devices show different alerts.'),
        !scanner.demo && pumpMode.get() === 'local'
          ? h('button.link', { onclick: () => pumpMode.set('auto') }, 'Use the shared log')
          : !scanner.demo && h('span.muted', 'The shared log server isn’t reachable.'),
      );
    }
  }

  function renderHeader(now) {
    const st = headerStats(scanner.signals, scanner.tickers.size || null, now);
    const tile = (label, value, sub, cls = 'plain') => h('div.stat', h('span.stat-label', label), h(`span.stat-value.${cls}`, value), sub && h('span.stat-sub', sub));
    fill(header,
      tile('Pairs scanned', st.pairs ?? '–', 'Binance USDT perpetuals'),
      tile('Active now', st.active, 'moves still tracked'),
      tile(`Alerts, ${KEEP_DAYS} days`, st.alerts30d, `${st.alerts24h} in the last 24h`),
      tile('Best gain 24h', st.bestGain24h == null ? '–' : fmtPct(st.bestGain24h), 'peak of the last 24h’s alerts', st.bestGain24h == null ? 'plain' : signClass(st.bestGain24h)),
    );
  }

  function render() {
    if (!alive || !scanner) return;
    const now = Date.now();
    renderSource();
    renderHeader(now);
    pulse.textContent = scanner.mode === 'shared'
      ? (scanner.error ? 'Server unreachable · retrying' : `Shared · ${scanner.pairsCount ?? '–'} pairs · updated ${scanner.lastTick ? fmtAgo(scanner.lastTick) : 'just now'}`)
      : scanner.state === 'live' ? `${scanner.demo ? 'Demo market' : 'This browser'} · ${scanner.tickers.size} pairs · live`
      : scanner.state === 'polling' ? `This browser · ${scanner.tickers.size} pairs · every 10s (live stream unavailable)`
      : scanner.state === 'reconnecting' ? 'Reconnecting to Binance…' : 'Starting…';
    pulse.dataset.state = scanner.mode === 'shared' ? (scanner.error ? 'reconnecting' : 'live') : scanner.state === 'polling' ? 'reconnecting' : scanner.state;

    const count = (view) => selectRows(scanner.signals, { ...opts, view }, now).length;
    const lens = (pressed, label, onclick) => h('button.lens', { type: 'button', 'aria-pressed': String(pressed), onclick }, label);
    fill(views,
      lens(opts.view === 'active', `Active now · ${count('active')}`, () => set({ view: 'active' })),
      lens(opts.view === 'log', `Alert log · ${count('log')}`, () => set({ view: 'log' })));
    fill(windows, ...WINDOWS.map(([id, label]) => lens(opts.window === id, label, () => set({ window: id }))));
    fill(filters, opts.view === 'active' && [
      h('label.check', { title: `Only pairs still within ${AT_PEAK_PCT}% of their post-alert peak` },
        h('input#pump-atpeak', { type: 'checkbox', checked: opts.atPeak, onchange: (e) => set({ atPeak: e.target.checked }) }), 'At peak'),
      h('label.field.inline', h('span', 'Sort'),
        h('select#pump-sort', { onchange: (e) => set({ sort: e.target.value }) },
          h('option', { value: 'gain', selected: opts.sort === 'gain' }, 'Gain %'),
          h('option', { value: 'volume', selected: opts.sort === 'volume' }, 'Volume 24h'))),
    ]);

    const rows = selectRows(scanner.signals, opts, now);
    const visible = rows.slice(0, shown);
    more.hidden = rows.length <= shown;
    more.textContent = `Show ${Math.min(PAGE, rows.length - shown)} more`;
    foot.textContent = rows.length ? `Showing ${visible.length} of ${rows.length}.` : '';

    const th = (label, title) => h('th', { scope: 'col', title: title || null }, label);
    if (opts.view === 'active') {
      fill(tableWrap, h('table.grid.pumps',
        h('thead', h('tr',
          th('Token'),
          th('Start price', 'The rolling 24h low when the alert fired'),
          th('Alert price', 'First price seen at or past 1.27× the start price'),
          th('Price now'),
          th('Gain %', 'Price now vs the alert price'),
          opts.atPeak ? th('Off peak', 'How far price is below the post-alert peak') : th('Peak %', 'Highest price since the alert, vs the alert price'),
          th('Time to peak'),
          th('Dip before peak', 'Lowest price between the alert and the peak, vs the alert price'),
          th('Volume 24h'),
          th('OI', 'Open interest in USD'),
          th('Duration', 'Time since the alert'),
        )),
        h('tbody', visible.length ? visible.map((s) => activeRow(s, now)) : h('tr', h('td.empty', { colSpan: 11 }, emptyText()))),
      ));
    } else {
      fill(tableWrap, h('table.grid.pumps',
        h('thead', h('tr',
          th('Alert'),
          th('Token'),
          th('Alert price'),
          th('Rise after alert', 'Highest price reached after the alert, and how long it took'),
          th('Dip before peak', 'Lowest price before that peak'),
          th('Status'),
        )),
        h('tbody', visible.length ? visible.map((s) => logRow(s, now)) : h('tr', h('td.empty', { colSpan: 6 }, emptyText()))),
      ));
    }
  }

  function emptyText() {
    if (opts.view === 'active') {
      if (opts.atPeak) return `No active pair is within ${AT_PEAK_PCT}% of its peak right now.`;
      return opts.window === 'all' ? 'No active pumps. New ones appear here the moment they fire.' : 'No active pumps that fired in this window.';
    }
    return 'No alerts in this window yet.';
  }

  const pairCell = (s) => h('th.pair', { scope: 'row' }, h('span.pair-name', ticker(s.symbol)), s.demo && h('span.chip.aligned', { title: 'Invented example' }, 'Example'));

  function rowProps(s, now) {
    const open = () => go('signal', s.id);
    return { tabIndex: 0, onclick: open, onkeydown: (e) => e.key === 'Enter' && open(), class: now - s.alertT < 60_000 ? 'fresh-row' : '' };
  }

  function activeRow(s, now) {
    const m = metrics(s, now);
    return h('tr', rowProps(s, now),
      pairCell(s),
      h('td.num.muted', fmtPrice(s.startPrice)),
      h('td.num', { title: `${fmtPct(m.riseAtAlert)} off the 24h low · ${new Date(s.alertT).toLocaleString()}` }, fmtPrice(s.alertPrice)),
      h('td.num', fmtPrice(s.lastPrice)),
      h(`td.num.${signClass(m.gain)}`, h('strong', fmtPct(m.gain))),
      opts.atPeak ? h('td.num', fmtPct(-m.offPeak)) : h(`td.num.${signClass(m.peak)}`, fmtPct(m.peak)),
      h('td.num', fmtDuration(m.timeToPeak)),
      h(`td.num.${m.dip <= -0.05 ? 'down' : ''}`, fmtDip(m.dip)),
      h('td.num', fmtVol(s.volume24h)),
      h('td.num', fmtVol(s.oiUsd)),
      h('td.num.muted', fmtDuration(m.duration)),
    );
  }

  function logRow(s, now) {
    const m = metrics(s, now);
    const when = new Date(s.alertT);
    return h('tr', rowProps(s, now),
      h('td.num.muted', { title: when.toLocaleString() }, when.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
      pairCell(s),
      h('td.num', fmtPrice(s.alertPrice)),
      h('td.num', h(`span.${signClass(m.peak)}`, fmtPct(m.peak)), h('span.muted', ` in ${fmtDuration(m.timeToPeak)}`)),
      h(`td.num.${m.dip <= -0.05 ? 'down' : ''}`, fmtDip(m.dip)),
      h('td', h(`span.status.${s.status.toLowerCase()}`, { title: s.closeReason || 'Still following this move' }, s.status === 'TRACKING' ? 'Tracking' : 'Closed')),
    );
  }

  async function exportCsv() {
    if (!scanner) return;
    const now = Date.now();
    const rows = selectRows(scanner.signals, opts, now);
    const text = csv(rows, [
      { label: 'alert_time', get: (s) => new Date(s.alertT).toISOString() },
      { label: 'pair', get: (s) => s.symbol },
      { label: 'status', get: (s) => s.status },
      { label: 'start_price_24h_low', get: (s) => s.startPrice },
      { label: 'alert_price', get: (s) => s.alertPrice },
      { label: 'rise_at_alert_pct', get: (s) => metrics(s, now).riseAtAlert.toFixed(2) },
      { label: 'price_now', get: (s) => s.lastPrice },
      { label: 'gain_pct', get: (s) => metrics(s, now).gain.toFixed(2) },
      { label: 'peak_price', get: (s) => s.peakPrice },
      { label: 'peak_pct', get: (s) => metrics(s, now).peak.toFixed(2) },
      { label: 'minutes_to_peak', get: (s) => Math.round(metrics(s, now).timeToPeak / 60_000) },
      { label: 'dip_before_peak_pct', get: (s) => metrics(s, now).dip.toFixed(2) },
      { label: 'volume_24h_usd', get: (s) => (s.volume24h == null ? '' : Math.round(s.volume24h)) },
      { label: 'oi_usd', get: (s) => (s.oiUsd == null ? '' : Math.round(s.oiUsd)) },
      { label: 'close_reason', get: (s) => s.closeReason || '' },
      { label: 'whale_long_share', get: (s) => s.whale?.longShare?.toFixed(3) ?? '' },
    ]);
    if (await copyText(text)) toast(`Copied ${rows.length} rows as CSV`);
    else toast('Your browser blocked the clipboard.');
  }

  renderAlerts();
  getPumps().then((s) => {
    if (!alive) return;
    scanner = s;
    let pending = false;
    off.push(s.on('change', () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; render(); }, 1000);
    }));
    render();
  }).catch((e) => fill(tableWrap, h('p.error', `The scanner couldn't start. ${e.message}`)));

  return () => {
    alive = false;
    off.forEach((f) => f());
  };
}
