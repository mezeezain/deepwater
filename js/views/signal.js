// One Pump Catcher signal: chart with ALERT and PEAK markers, the move's numbers, and the pair's signal history.
import { getPumps } from '../pump-app.js';
import { demoSignalCandles } from '../demo-market.js';
import { priceChart } from '../chart.js';
import { metrics, pairHistory, checkText } from '../pump.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, signClass, fill, riskNote, store } from '../util.js';
import { fmtDuration, fmtDip } from './pumps.js';

const FRAMES = [['15m', '15M', 900_000], ['1h', '1H', 3_600_000], ['4h', '4H', 14_400_000], ['1d', '1D', 86_400_000]];
const MAX_BARS = 500;

/** Smallest timeframe that fits the run-up, the alert and everything since in one request. */
export function pickFrame(sig, now = Date.now()) {
  const end = sig.closedT ?? now;
  for (const [id, , ms] of FRAMES) if ((end - sig.alertT) / ms + 40 <= MAX_BARS) return id;
  return '1d';
}

export function signalView(root, { id, go }) {
  let alive = true;
  let disposeChart = () => {};
  let off = () => {};
  let frame = null;
  let chartTimer = null;
  const head = h('div.token-top');
  const tiles = h('div.summary');
  const frames = h('div.lenses', { role: 'group', 'aria-label': 'Timeframe' });
  const chartBox = h('div.chart');
  const life = h('div.facts');
  const whales = h('div.facts');
  const why = h('ul.checks');
  const history = h('div');

  fill(root,
    h('button.back', { onclick: () => go('pumps') }, '← Pump catcher'),
    h('section.panel', head),
    riskNote('An alert records what the scanner saw, not a recommendation. '),
    tiles,
    h('div.split',
      h('section.panel.grow',
        h('div.toolbar', h('h2', 'Price around the alert'), frames),
        chartBox,
        h('div.legend', h('span.key.alert', 'Alert'), h('span.key.peak', 'Peak'), h('span.key.start', 'Start price (24h low)'), h('span.key.range', 'Earlier 40-day high')),
        h('p.note', 'Growth is measured from the alert price, the moment the scanner flagged the move. It is the move after detection, not a trade result.')),
      h('aside.panel.side', h('h2', 'Why it qualified'), why, h('h2', 'Signal'), life, h('h2', 'Whales at the alert'), whales),
    ),
    h('section.panel', h('h2', 'Signal history for this pair'), history),
  );

  getPumps().then((scanner) => {
    if (!alive) return;
    const sig = scanner.signals.find((s) => s.id === id);
    if (!sig) {
      fill(head, h('p.error', `This signal is no longer in the ${scanner.mode === 'shared' ? 'shared' : 'browser'} 30-day log.`));
      return;
    }
    frame = store.get('pump-frame', null);
    if (!FRAMES.some(([f]) => f === frame)) frame = pickFrame(sig);

    const paint = () => {
      const m = metrics(sig);
      const name = ticker(sig.symbol);
      fill(head,
        h('div',
          h('p.eyebrow', `Alert · ${new Date(sig.alertT).toLocaleString()}`),
          h('h1.token-title', name, h('span.muted.perp', 'USDT · PERP'), h(`span.status.${sig.status.toLowerCase()}`, sig.status === 'TRACKING' ? 'Active' : 'Closed'), sig.demo && h('span.chip.aligned', 'Example')),
        ),
        h('div.toolbar-right',
          h('button.btn.ghost', { onclick: () => go('token', sig.symbol) }, `${name} chart & positioning →`),
          h('button.btn.ghost', { onclick: () => go('liqmap', sig.symbol) }, 'Liquidation map →')),
      );
      fill(tiles,
        tile('Alert price', fmtPrice(sig.alertPrice), `${fmtPct(m.riseAtAlert)} off 24h low ${fmtPrice(sig.startPrice)}`),
        tile('Peak', fmtPrice(sig.peakPrice), `${fmtPct(m.peak)} from the alert`, signClass(m.peak)),
        tile('Time to peak', fmtDuration(m.timeToPeak), new Date(sig.peakT).toLocaleString()),
        tile('Dip before peak', fmtDip(m.dip), 'lowest point before the peak', m.dip <= -0.05 ? 'down' : ''),
        tile(sig.status === 'TRACKING' ? 'Gain now' : 'Gain at close', fmtPct(m.gain), fmtPrice(sig.lastPrice), signClass(m.gain)),
      );
      const row = (label, value) => h('div.fact-row', h('span', label), h('strong', value));
      fill(life,
        row('Status', sig.status === 'TRACKING' ? 'Active' : 'Closed'),
        row('Trigger', `+${sig.threshold ?? 27}% off the 24h low`),
        row(sig.status === 'TRACKING' ? 'Duration' : 'Tracked for', fmtDuration(m.duration)),
        row('Off peak', fmtPct(-m.offPeak)),
        row('Volume 24h', sig.volume24h == null ? '–' : fmtUsd(sig.volume24h)),
        row('Open interest', sig.oiUsd == null ? '–' : fmtUsd(sig.oiUsd)),
        sig.status === 'CLOSED' && h('p.read', `Closed: ${sig.closeReason}.`),
      );
      const b = sig.breakout;
      fill(why, b?.checks?.length
        ? b.checks.map((c) => h(`li.${c.ok ? 'good' : 'bad'}`, h('span.mark', { 'aria-hidden': 'true' }, c.ok ? '✓' : '✕'), h('span', c.label), h('span.muted', checkText(c))))
        : h('li.neutral', h('span.mark', '–'), h('span', 'Recorded before the first-breakout filter'), h('span')));
      if (b?.rangeHigh) why.append(h('li.neutral', h('span.mark', '·'), h('span', '40-day range'), h('span.muted', `${fmtPrice(b.rangeLow)} – ${fmtPrice(b.rangeHigh)}`)));
      const w = sig.whale;
      fill(whales, w
        ? [
            row(w.cohort === 'smart' ? 'Smart money long, by size' : 'Whales long, by size', `${Math.round(w.longShare * 100)}%`),
            row('Whale long entry', w.longEntry ? `${fmtPrice(w.longEntry)} (${fmtPct(w.distLong)})` : '–'),
            row('Whale short entry', w.shortEntry ? `${fmtPrice(w.shortEntry)} (${fmtPct(w.distShort)})` : '–'),
            row('Whale shorts', w.shortUpnl == null ? '–' : w.shortsUnderwater ? `losing ${fmtUsd(-w.shortUpnl)}` : `up ${fmtUsd(w.shortUpnl)}`),
            w.ageH != null && h('p.note', `Binance data was ${w.ageH.toFixed(1)} hours old when this fired. Context only: it plays no part in firing.`),
          ]
        : h('p.note', 'No Binance Smart Money data was available for this pair when the alert fired.'));
      const list = pairHistory(scanner.signals, sig.symbol);
      fill(history, h('ul.sig-history', ...list.map((s) => {
        const mm = metrics(s);
        return h('li', { class: s.id === sig.id ? 'current' : '' },
          h('button.link', { onclick: () => s.id !== sig.id && go('signal', s.id), 'aria-current': s.id === sig.id ? 'page' : null },
            new Date(s.alertT).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })),
          h('span.num', `alert ${fmtPrice(s.alertPrice)}`),
          h('span.num', `peak ${fmtPrice(s.peakPrice)}`),
          h(`strong.num.${signClass(mm.peak)}`, fmtPct(mm.peak)),
          h(`span.status.${s.status.toLowerCase()}`, s.status === 'TRACKING' ? 'Active' : 'Closed'));
      })), h('p.note', 'A signal is a price event, so the same pair can be caught again on a later move.'));
    };

    const drawChart = async () => {
      fill(frames, ...FRAMES.map(([f, label]) => h('button.lens', { type: 'button', 'aria-pressed': String(f === frame), onclick: () => { frame = f; store.set('pump-frame', f); drawChart(); } }, label)));
      const ms = FRAMES.find(([f]) => f === frame)[2];
      const start = sig.alertT - 40 * ms;
      let candles;
      try {
        candles = sig.demo ? demoSignalCandles(sig, ms) : await scanner.source.getCandles(sig.symbol, frame, start, MAX_BARS);
      } catch (e) {
        fill(chartBox, h('p.error', `Couldn't load candles. ${e.message}`));
        return;
      }
      if (!alive) return;
      disposeChart();
      if (!candles?.length) {
        fill(chartBox, h('p.empty', 'No candles yet for this signal.'));
        return;
      }
      disposeChart = priceChart(chartBox, {
        candles,
        label: `${ticker(sig.symbol)} price with the alert and the peak`,
        markers: [
          { t: sig.alertT, dir: 1, label: 'ALERT', color: '--accent' },
          ...(sig.peakT > sig.alertT ? [{ t: sig.peakT, dir: -1, label: `PEAK ${fmtPct(metrics(sig).peak)}`, color: '--long' }] : []),
        ],
        levels: [
          { price: sig.alertPrice, label: 'Alert', color: '--accent' },
          { price: sig.startPrice, label: '24h low', color: '--muted' },
          ...(sig.breakout?.rangeHigh ? [{ price: sig.breakout.rangeHigh, label: '40-day high', color: '--whale' }] : []),
          ...(sig.peakPrice > sig.alertPrice * 1.005 ? [{ price: sig.peakPrice, label: 'Peak', color: '--long' }] : []),
        ],
      });
    };

    paint();
    drawChart();
    if (sig.status === 'TRACKING') {
      // Keep the candles, peak marker and levels in step with the live numbers above.
      chartTimer = setInterval(() => { if (!document.hidden) drawChart(); }, 60_000);
      let pending = false;
      off = scanner.on('change', () => {
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; if (alive) paint(); }, 1000);
      });
    }
  });

  const tile = (label, value, sub, cls = '') => h('div.stat', h('span.stat-label', label), h(`span.stat-value.${cls || 'plain'}`, value), sub && h('span.stat-sub', sub));

  return () => {
    alive = false;
    clearInterval(chartTimer);
    disposeChart();
    off();
  };
}
