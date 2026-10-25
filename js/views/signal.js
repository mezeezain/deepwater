// One pump signal: chart around the alert, how the move played out, and why it fired.
import { getCatcher } from '../catcher-app.js';
import { demoSignalCandles } from '../demo-market.js';
import { priceChart } from '../chart.js';
import { getChartData } from '../api.js';
import { marketLayers, whaleLayers, liquidationLevels, setupCheck } from '../indicators.js';
import { h, ticker, fmtPrice, fmtPct, fmtUsd, signClass, fill, riskNote } from '../util.js';
import { realised, DEFAULTS } from '../engine.js';
import { spotListed } from '../api.js';
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
  const spotNote = h('p.note');

  fill(root, 
    h('button.back', { onclick: () => go('pumps') }, '← Pump catcher'),
    h('section.panel', head),
    riskNote('An alert is a record of what the scanner saw, not a recommendation. '),
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
      fill(checks, ...(items.length
        ? items.map((it) => h(`div.check-item.${it.state}`, h('span.check-icon', { 'aria-hidden': 'true' }, icon[it.state]), h('div', h('strong', it.label), h('p', it.detail))))
        : [h('p.empty', 'Not enough data for a setup check.')]));
    } catch (e) {
      fill(checks, h('p.empty', `Setup check unavailable: ${e.message}`));
    }
  }

  getCatcher().then(async (catcher) => {
    if (!alive) return;
    const sig = catcher.signals.find((s) => s.id === id);
    if (!sig) {
      fill(head, h('p.error', 'This signal is no longer in your 30-day log. It may have been recorded in another browser.'));
      return;
    }
    loadChecks(sig.symbol);
    spotListed(sig.symbol).then((listed) => {
      spotNote.textContent = listed === false
        ? `${ticker(sig.symbol)} has no USDT market on Binance spot: this alert is about futures only.`
        : listed === true
          ? `This alert is based on futures prices and positioning. ${ticker(sig.symbol)} also trades on Binance spot, where prices, volume and positioning can differ.`
          : 'This alert is based on futures prices and positioning; spot markets can differ.';
    });
    const paint = () => {
      const nowChg = ((sig.lastPrice - sig.alertPrice) / sig.alertPrice) * 100;
      fill(head, 
        h('div',
          h('p.eyebrow', `Alert · ${new Date(sig.alertT).toLocaleString()}`),
          h('h1.token-title', ticker(sig.symbol), h(`span.status.${sig.status.toLowerCase()}`, sig.status === 'TRACKING' ? 'Tracking' : 'Closed'), sig.demo && h('span.chip.aligned', 'Example')),
        ),
        h('button.btn.ghost', { onclick: () => go('token', sig.symbol) }, `${ticker(sig.symbol)} positioning →`),
      );
      fill(tiles, 
        tile('Alert price', fmtPrice(sig.alertPrice)),
        tile('Rise after alert', fmtPct(sig.rise), `peak ${fmtPrice(sig.peakPrice)} after ${fmtDuration(sig.peakT - sig.alertT)}`, signClass(sig.rise)),
        tile('Dip before peak', fmtDip(sig.dip), 'lowest point before the peak', sig.dip <= -0.05 ? 'down' : ''),
        sig.status === 'CLOSED'
          ? tile('Result', fmtPct(realised(sig, catcher.cfg.costPct ?? DEFAULTS.costPct)), `exit ${fmtPrice(sig.exitPrice ?? sig.lastPrice)}, after ${catcher.cfg.costPct ?? DEFAULTS.costPct}% costs`, signClass(realised(sig, catcher.cfg.costPct ?? DEFAULTS.costPct)))
          : tile('Now', fmtPct(nowChg), `${fmtPrice(sig.lastPrice)} · open, before costs`, signClass(nowChg)),
      );
      const cfg = catcher.cfg;
      const row = (label, value, ok) => h('div.fact-row', h('span', label), h(`strong.${ok == null ? '' : ok ? 'up' : 'down'}`, value));
      fill(why, 
        row('Above 24h low', fmtPct(sig.riseFromLow), true),
        row('5-minute move', fmtPct(sig.impulse), true),
        row('Volume spike', sig.rvol == null ? '–' : `${sig.rvol.toFixed(1)}×`, sig.rvol >= cfg.minRvol),
        row('Taker buy share', sig.takerBuy == null ? '–' : `${Math.round(sig.takerBuy * 100)}%`, sig.takerBuy >= cfg.minTakerBuy),
        row('Open interest, 15m', fmtPct(sig.oiChange), sig.oiChange >= cfg.minOiChange),
        row('Top 20% accounts long', sig.whaleLong == null ? '–' : `${Math.round(sig.whaleLong * 100)}%`),
        row('All accounts long', sig.crowdLong == null ? '–' : `${Math.round(sig.crowdLong * 100)}%`),
        row('Top 20% − crowd gap', sig.gap == null ? '–' : `${sig.gap > 0 ? '+' : ''}${Math.round(sig.gap)} pts`, sig.gap > cfg.minGap || sig.crowdLong < cfg.squeezeCrowdLong),
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
      const rules = sig.rules ?? cfg;
      const stop = sig.stopPct ?? rules.stopPct;
      fill(life, 
        row('Stop', `${stop.toFixed(1)}% below alert (${fmtPrice(sig.alertPrice * (1 - stop / 100))})`),
        sig.range5m != null && row('Typical 5-minute range', `${sig.range5m.toFixed(2)}%`),
        row('Time to peak', fmtDuration(sig.peakT - sig.alertT)),
        row('Tracked for', fmtDuration((sig.closedT || Date.now()) - sig.alertT)),
        sig.cfgId && row('Rule set', sig.cfgId),
        sig.status === 'CLOSED'
          ? h('p.read', `Closed: ${sig.closeReason} at ${fmtPrice(sig.exitPrice ?? sig.lastPrice)}.`)
          : h('p.read', `Open. Closes at the stop, after giving back ${Math.round(rules.trailGiveBack * 100)}% of a gain over ${rules.trailFrom}%, or after ${rules.maxTrackHours} hours.`),
        spotNote,
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
      fill(chartBox, h('p.error', `Couldn't load candles. ${e.message}`));
    }
    if (!alive || !candles) return;
    if (!candles.length) {
      fill(chartBox, h('p.empty', 'No candles yet for this signal. The chart fills in as the demo market runs.'));
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
