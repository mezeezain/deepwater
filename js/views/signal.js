// One pump signal: chart around the alert, how the move played out, and why it fired.
import { getCatcher } from '../catcher-app.js';
import { demoSignalCandles } from '../demo-market.js';
import { priceChart } from '../chart.js';
import { getChartData } from '../api.js';
import { marketLayers, whaleLayers, liquidationLevels, setupCheck } from '../indicators.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, signClass } from '../util.js';
import { fmtDuration, fmtDip } from './pumps.js';

export function signalView(root, { id, go }) {
  let alive = true;
  let disposeChart = () => {};
  let off = () => {};
  const head = h('div.token-top');
  const tiles = h('div.summary');
  const chartBox = h('div.chart');
  const why = h('div.facts');
  const life = h('div.facts');
  const checks = h('div.checks-list', h('p.loading', 'Checking order flow…'));

  root.replaceChildren(
    h('button.back', { onclick: () => go('pumps') }, '← Pump catcher'),
    h('section.panel', head),
    tiles,
    h('div.split',
      h('section.panel.grow', h('h2', 'Price around the alert'), chartBox,
        h('div.legend', h('span.key.alert', 'Alert price'), h('span.key.peak', 'Peak'), h('span.key.dip', 'Dip before peak'))),
      h('aside.panel.side', h('h2', 'Why it fired'), why, h('h2', 'Lifecycle'), life),
    ),
    h('section.panel', h('h2', 'Setup check now'), h('p.note', 'Order flow and positioning over the last hour (12 five-minute candles).'), checks),
  );

  async function loadChecks(symbol) {
    try {
      const raw = await getChartData(symbol, '5m', 150);
      if (!alive) return;
      const market = marketLayers(raw.bars);
      const items = setupCheck(raw.bars, market, whaleLayers(raw.bars), { levels: liquidationLevels(raw.bars, market).active });
      const icon = { good: '✓', warn: '!', bad: '✕', na: '–' };
      checks.replaceChildren(...(items.length
        ? items.map((it) => h(`div.check-item.${it.state}`, h('span.check-icon', { 'aria-hidden': 'true' }, icon[it.state]), h('div', h('strong', it.label), h('p', it.detail))))
        : [h('p.empty', 'Not enough data for a setup check.')]));
    } catch (e) {
      checks.replaceChildren(h('p.empty', `Setup check unavailable: ${e.message}`));
    }
  }

  getCatcher().then(async (catcher) => {
    if (!alive) return;
    const sig = catcher.signals.find((s) => s.id === id);
    if (!sig) {
      head.replaceChildren(h('p.error', 'This signal is no longer in your 30-day log. It may have been recorded in another browser.'));
      return;
    }
    loadChecks(sig.symbol);
    const paint = () => {
      const nowChg = ((sig.lastPrice - sig.alertPrice) / sig.alertPrice) * 100;
      head.replaceChildren(
        h('div',
          h('p.eyebrow', `Alert · ${new Date(sig.alertT).toLocaleString()}`),
          h('h1.token-title', ticker(sig.symbol), h(`span.status.${sig.status.toLowerCase()}`, sig.status === 'TRACKING' ? 'Tracking' : 'Closed'), sig.demo && h('span.chip.aligned', 'Example')),
        ),
        h('button.btn.ghost', { onclick: () => go('token', sig.symbol) }, `${ticker(sig.symbol)} positioning →`),
      );
      tiles.replaceChildren(
        tile('Alert price', fmtPrice(sig.alertPrice)),
        tile('Rise after alert', fmtPct(sig.rise), `peak ${fmtPrice(sig.peakPrice)} after ${fmtDuration(sig.peakT - sig.alertT)}`, signClass(sig.rise)),
        tile('Dip before peak', fmtDip(sig.dip), 'lowest point before the peak', sig.dip <= -0.05 ? 'down' : ''),
        tile(sig.status === 'TRACKING' ? 'Now' : 'At close', fmtPct(nowChg), fmtPrice(sig.lastPrice), signClass(nowChg)),
      );
      const cfg = catcher.cfg;
      const row = (label, value, ok) => h('div.fact-row', h('span', label), h(`strong.${ok == null ? '' : ok ? 'up' : 'down'}`, value));
      why.replaceChildren(
        row('Above 24h low', fmtPct(sig.riseFromLow), true),
        row('5-minute move', fmtPct(sig.impulse), true),
        row('Volume spike', sig.rvol == null ? '–' : `${sig.rvol.toFixed(1)}×`, sig.rvol >= cfg.minRvol),
        row('Taker buy share', sig.takerBuy == null ? '–' : `${Math.round(sig.takerBuy * 100)}%`, sig.takerBuy >= cfg.minTakerBuy),
        row('Open interest, 15m', fmtPct(sig.oiChange), sig.oiChange >= cfg.minOiChange),
        row('Whales long', sig.whaleLong == null ? '–' : `${Math.round(sig.whaleLong * 100)}%`),
        row('Crowd long', sig.crowdLong == null ? '–' : `${Math.round(sig.crowdLong * 100)}%`),
        row('Gap', sig.gap == null ? '–' : `${sig.gap > 0 ? '+' : ''}${Math.round(sig.gap)} pts`, sig.gap > cfg.minGap || sig.crowdLong < cfg.squeezeCrowdLong),
        ...(sig.whale
          ? [
              h('h3.why-sub', 'Binance Smart Money at the alert'),
              row(sig.whale.cohort === 'smart' ? 'Smart money long, by size' : 'Whales long, by size', `${Math.round(sig.whale.longShare * 100)}%`, sig.whale.agrees),
              row('Whale long entry', sig.whale.longEntry ? `${fmtPrice(sig.whale.longEntry)} (${fmtPct(sig.whale.distLong)})` : '–', sig.whale.nearLongEntry ? true : null),
              row('Whale short entry', sig.whale.shortEntry ? `${fmtPrice(sig.whale.shortEntry)} (${fmtPct(sig.whale.distShort)})` : '–'),
              row('Whale shorts', sig.whale.shortUpnl == null ? '–' : sig.whale.shortsUnderwater ? `losing ${fmtUsd(-sig.whale.shortUpnl)}` : `up ${fmtUsd(sig.whale.shortUpnl)}`, sig.whale.shortsUnderwater),
              sig.whale.ageH != null && h('p.note', `Binance data was ${sig.whale.ageH.toFixed(1)} hours old when this fired.`),
            ]
          : [h('p.note', 'No Binance Smart Money data for this alert (connect a whale data server on the Whales page).')]),
      );
      life.replaceChildren(
        row('Time to peak', fmtDuration(sig.peakT - sig.alertT)),
        row('Tracked for', fmtDuration((sig.closedT || Date.now()) - sig.alertT)),
        sig.status === 'CLOSED'
          ? h('p.read', `Closed: ${sig.closeReason}.`)
          : h('p.read', `Still tracking. Closes if price drops ${cfg.stopPct}% below the alert, or gives back ${Math.round(cfg.trailGiveBack * 100)}% of a gain over ${cfg.trailFrom}%.`),
      );
    };
    paint();

    // 5m candles from an hour before the alert (1m for young signals).
    const young = Date.now() - sig.alertT < 3 * 3_600_000;
    const interval = young ? '1m' : '5m';
    const start = sig.alertT - (young ? 20 : 12) * (young ? 60_000 : 300_000);
    let candles;
    try {
      candles = sig.demo ? demoSignalCandles(sig) : await catcher.source.getCandles(sig.symbol, interval, start);
    } catch (e) {
      chartBox.replaceChildren(h('p.error', `Couldn't load candles. ${e.message}`));
    }
    if (!alive || !candles) return;
    if (!candles.length) {
      chartBox.replaceChildren(h('p.empty', 'No candles yet for this signal. The chart fills in as the demo market runs.'));
    } else {
      disposeChart = priceChart(chartBox, {
        candles,
        label: `${ticker(sig.symbol)} price around the alert`,
        markers: [{ t: sig.alertT, dir: 1 }],
        levels: [
          { price: sig.alertPrice, label: 'Alert', color: '--accent' },
          ...(sig.rise >= 0.5 ? [{ price: sig.peakPrice, label: 'Peak', color: '--long' }] : []),
          ...(sig.dip <= -0.5 ? [{ price: sig.alertPrice * (1 + sig.dip / 100), label: 'Dip', color: '--short' }] : []),
        ],
      });
    }
    if (sig.status === 'TRACKING') off = catcher.on('change', paint);
  });

  const tile = (label, value, sub, cls = '') => h('div.stat', h('span.stat-label', label), h(`span.stat-value.${cls || 'plain'}`, value), sub && h('span.stat-sub', sub));

  return () => {
    alive = false;
    disposeChart();
    off();
  };
}
