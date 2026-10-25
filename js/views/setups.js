// Setups lab: three structure setups replayed with realistic fills and costs, split by whale positioning.
import { getLabData, getSmartOverview, isDemo } from '../api.js';
import { MODELS, LAB_DEFAULTS, runLab, breakdown } from '../setups.js';
import { normalizePair } from '../route.js';
import { h, ticker, pairLink, fmtPrice, fmtPct, signClass, csv, copyText, toast, store, fill, riskNote } from '../util.js';

const FRAMES = ['15m', '1h', '4h'];
const WHALE_LABEL = { with: 'Whales agree', neutral: 'No clear lean', against: 'Whales disagree', none: 'No whale data (older than 30 days)' };
const MIN_TRADES = 30;

const fmtR = (v) => (v == null || !isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
const fmtRate = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const fmtPf = (v) => (v == null ? '–' : v.toFixed(2));

export function setupsView(root, { go }) {
  let frame = store.get('lab-frame', '1h');
  let pairs = store.get('lab-pairs', 'BTC, ETH, SOL');
  let alive = true;
  let result = null;

  const status = h('p.note', 'Loading…');
  const modelsBox = h('div.table-wrap');
  const whalesBox = h('div');
  const liveBox = h('div');
  const tradesBox = h('div.table-wrap');
  const frameBtns = h('div.lenses', { role: 'group', 'aria-label': 'Timeframe' });
  const pairsInput = h('input#lab-pairs', { value: pairs, 'aria-label': 'Pairs, comma separated', spellcheck: false, autocomplete: 'off' });

  fill(root, 
    riskNote('Backtests overfit easily and ignore slippage; treat them as a sanity check. '),
    h('section.hero.compact',
      h('div.hero-text',
        h('p.eyebrow', 'Sweep reclaim · Breakout retest · Regime confluence'),
        h('h1', 'Setups lab'),
        h('p.lede', 'Popular signal setups replayed on Binance candles the way a real account would trade them: fees, stop slippage, limit orders that only fill when traded through, funding. Then split by whether Binance’s top traders agreed with the trade.'),
      ),
    ),
    h('section.panel',
      h('form.toolbar', { onsubmit: (e) => { e.preventDefault(); run(); } },
        h('label.field.inline', h('span', 'Pairs'), pairsInput),
        frameBtns,
        h('button.btn', { type: 'submit' }, 'Run'),
      ),
      status,
    ),
    h('section.panel', h('h2', 'Paper win rate vs what an account keeps'), modelsBox,
      h('p.note', 'Paper win: TP1 touched before the stop, no costs. This is how most signal dashboards count a “target hit”, even when the trade then reverses to the stop. Net win: the trade made money after fees, slippage and funding, managed as half off at TP1, stop to entry, rest at the final target. Net win can exceed paper win when trades hit the time limit in profit without reaching TP1.')),
    h('section.panel', h('h2', 'With or against the whales'), whalesBox),
    h('section.panel', h('h2', 'Setups on the latest candles'), liveBox),
    h('section.panel',
      h('div.toolbar', h('h2', 'Trades'), h('button.btn.ghost', { onclick: exportCsv }, 'Copy CSV')),
      tradesBox),
    h('section.panel', h('h2', 'How this is tested'),
      h('ul.method',
        h('li', `Costs: ${LAB_DEFAULTS.costs.taker}% taker and ${LAB_DEFAULTS.costs.maker}% maker per side (Binance regular tier), ${LAB_DEFAULTS.costs.stopSlip}% extra slippage on stops and time exits, and the funding actually charged while the trade was open.`),
        h('li', 'Market entries fill at the next candle’s open, never at the signal candle’s close. Retest limit orders count as filled only when price trades 0.02% through the level, so a bare touch that would often miss in a real queue does not count.'),
        h('li', 'When one candle reaches both the stop and a target, the stop is assumed to come first. Trades still open after 48 candles are closed at market.'),
        h('li', 'Whale context is read at the signal candle’s close: Binance’s top 20% accounts by margin (long share by position) against all accounts. “Agree” means top traders lean the trade’s way at least 5 points more than the crowd. Binance keeps this history for 30 days only, so older trades have no whale data.'),
        h('li', 'Regime confluence stops at the SuperTrend line, an assumption: the rules this lab follows give no stop for it.'),
        h('li', `With fewer than ${MIN_TRADES} trades in a row, results are mostly noise; the range shown next to expectancy is a rough 95% interval. Past results on a few pairs are not a forecast.`),
      )),
  );

  function paintFrames() {
    fill(frameBtns, ...FRAMES.map((f) => h('button.lens', { type: 'button', 'aria-pressed': String(f === frame), onclick: () => { frame = f; store.set('lab-frame', f); paintFrames(); run(); } }, f)));
  }
  paintFrames();

  async function run() {
    pairs = pairsInput.value;
    store.set('lab-pairs', pairs);
    const symbols = [...new Set(pairs.split(/[\s,]+/).map(normalizePair).filter(Boolean))].slice(0, 8);
    if (!symbols.length) {
      status.textContent = 'Type at least one pair, such as BTC ETH SOL.';
      return;
    }
    status.textContent = `Downloading ${symbols.length} pair${symbols.length > 1 ? 's' : ''} on ${frame}…`;
    const runFrame = frame;
    const per = [];
    const failed = [];
    for (const symbol of symbols) {
      try {
        const data = await getLabData(symbol, runFrame);
        if (!alive || runFrame !== frame) return;
        const lab = runLab(data.bars, LAB_DEFAULTS, data.funding);
        per.push({ symbol, data, lab });
        status.textContent = `Replayed ${per.length} of ${symbols.length}…`;
      } catch (e) {
        failed.push(`${ticker(symbol)} (${e.message})`);
      }
    }
    let smart = null;
    try {
      smart = await getSmartOverview();
    } catch {}
    if (!alive || runFrame !== frame) return;
    const trades = per.flatMap((p) => p.lab.trades.map((t) => ({ ...t, symbol: p.symbol })));
    const open = per.flatMap((p) => p.lab.open.map((s) => ({ ...s, symbol: p.symbol, bar: p.data.bars[s.i] })));
    result = { trades, open, smart, per, b: breakdown(trades), unfilled: per.reduce((s, p) => s + p.lab.unfilled, 0) };
    const span = per.length ? per[0].data.bars : [];
    const days = span.length ? Math.round((span.at(-1).t - span[0].t) / 86_400_000) : 0;
    status.textContent = (await isDemo() ? 'Simulated data (demo). ' : '') +
      `${trades.length} trades on ${per.length} pair${per.length === 1 ? '' : 's'}, ${frame} candles, about ${days} days.` +
      (result.unfilled ? ` ${result.unfilled} retest orders never filled.` : '') +
      (trades.length < 30 ? ' Fewer than 30 trades, so the percentages below are anecdotes, not evidence.' : '') +
      (failed.length ? ` Skipped: ${failed.join(', ')}.` : '');
    render();
  }

  function statCells(s) {
    if (!s || !s.n) return [h('td.num', '0'), h('td.num', '–'), h('td.num', '–'), h('td.num', '–'), h('td.num', '–'), h('td.num', '–')];
    return [
      h('td.num', s.n, s.n < 30 && h('span.sub', { title: 'Fewer than 30 trades: the percentages beside it are not reliable' }, ' low n')),
      h('td.num', fmtRate(s.paperWin)),
      h(`td.num.${s.netWin >= 0.5 ? 'up' : ''}`, fmtRate(s.netWin)),
      h('td.num', fmtPf(s.pf)),
      h(`td.num.${signClass(s.expR)}`, fmtR(s.expR), s.n >= 5 ? h('span.sub', ` ${fmtR(s.expLo)} to ${fmtR(s.expHi)}`) : null),
      h('td.num', fmtR(-s.feeR)),
    ];
  }

  function render() {
    const { b, trades, open, smart } = result;
    const head = h('thead', h('tr', h('th', { scope: 'col' }, 'Setup'), h('th', { scope: 'col' }, 'Trades'), h('th', { scope: 'col' }, 'Paper win'), h('th', { scope: 'col' }, 'Net win'), h('th', { scope: 'col' }, 'Profit factor'), h('th', { scope: 'col' }, 'Expectancy (95% range)'), h('th', { scope: 'col' }, 'Costs / trade')));
    fill(modelsBox, h('table.grid.lab',
      head,
      h('tbody',
        Object.entries(MODELS).map(([id, m]) => h('tr.static', h('th.pair', { scope: 'row', title: m.about }, m.name, h('span.sub', ` TP1 ${m.tp1}R · target ${m.target}R`)), ...statCells(b.models[id]))),
        h('tr.static.total', h('th.pair', { scope: 'row' }, 'All setups'), ...statCells(b.all)),
      )));

    // Whale split
    const rows = [];
    for (const [id, m] of Object.entries(MODELS)) {
      for (const w of ['with', 'neutral', 'against', 'none']) {
        const s = b.modelWhale[`${id}:${w}`];
        if (!s?.n) continue;
        rows.push(h('tr.static', h('th.pair', { scope: 'row' }, m.name, h('span.sub', ` ${WHALE_LABEL[w]}`)), ...statCells(s)));
      }
    }
    fill(whalesBox, 
      h('p.verdict', verdict(b.whales)),
      h('div.table-wrap', h('table.grid.lab',
        h('thead', h('tr', h('th', { scope: 'col' }, 'Setup · whales'), h('th', { scope: 'col' }, 'Trades'), h('th', { scope: 'col' }, 'Paper win'), h('th', { scope: 'col' }, 'Net win'), h('th', { scope: 'col' }, 'Profit factor'), h('th', { scope: 'col' }, 'Expectancy (95% range)'), h('th', { scope: 'col' }, 'Costs / trade'))),
        h('tbody',
          ['with', 'neutral', 'against', 'none'].filter((w) => b.whales[w]?.n).map((w) => h('tr.static.total', h('th.pair', { scope: 'row' }, `All · ${WHALE_LABEL[w]}`), ...statCells(b.whales[w]))),
          rows),
      )),
    );

    // Latest setups, with exact Smart Money context where the whale server has it
    fill(liveBox, open.length
      ? h('div.table-wrap', h('table.grid',
        h('thead', h('tr', h('th', { scope: 'col' }, 'Pair'), h('th', { scope: 'col' }, 'Setup'), h('th', { scope: 'col' }, 'Side'), h('th', { scope: 'col' }, 'Entry'), h('th', { scope: 'col' }, 'Stop'), h('th', { scope: 'col' }, 'Top 20% vs crowd'), h('th', { scope: 'col' }, 'Smart Money whales'), h('th', { scope: 'col' }, 'Candle'))),
        h('tbody', open.slice().reverse().map((s) => {
          const sm = smart?.rows?.get(s.symbol)?.shown;
          const entry = s.entryType === 'limit' ? s.level : s.bar.c;
          const stop = s.entryType === 'limit' ? s.level - s.side * s.stopAtr : s.stop;
          return h('tr', { onclick: () => go('token', s.symbol) },
            h('th.pair', { scope: 'row' }, pairLink(s.symbol)),
            h('td.txt', MODELS[s.model].name),
            h(`td.txt.${s.side > 0 ? 'up' : 'down'}`, s.side > 0 ? 'Long' : 'Short'),
            h('td.num', (s.entryType === 'limit' ? 'limit ' : '~') + fmtPrice(entry)),
            h('td.num', fmtPrice(stop)),
            h(`td.num.${signClass(s.gap)}`, s.gap == null ? '–' : `${s.gap > 0 ? '+' : ''}${Math.round(s.gap)} pts`),
            h('td.num', sm?.longShare == null ? '–' : `${Math.round(sm.longShare * 100)}% long`),
            h('td.num', new Date(s.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
          );
        }))))
      : h('p.note', 'No setup on the latest candles of these pairs.'));

    // Trades
    const recent = trades.slice().sort((a, c) => c.entryT - a.entryT).slice(0, 60);
    fill(tradesBox, h('table.grid',
      h('thead', h('tr', ...['Pair', 'Setup', 'Side', 'Entered', 'Stop dist.', 'Paper', 'Exit', 'Net', 'Net R', 'Whales'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', recent.map((t) => h('tr', { onclick: () => go('token', t.symbol) },
        h('th.pair', { scope: 'row' }, pairLink(t.symbol)),
        h('td.txt', MODELS[t.model].name),
        h(`td.txt.${t.side > 0 ? 'up' : 'down'}`, t.side > 0 ? 'Long' : 'Short'),
        h('td.num', new Date(t.entryT).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
        h('td.num', fmtPct(t.riskPct, 2, false)),
        h(`td.txt.${t.paper === 'win' ? 'up' : 'down'}`, t.paper === 'win' ? 'Win' : 'Loss'),
        h('td.txt', { timeout: 'Time limit', stop: 'Stop', breakeven: 'Stop at entry', target: 'Target' }[t.exitKind]),
        h(`td.num.${signClass(t.netPct)}`, fmtPct(t.netPct, 2)),
        h(`td.num.${signClass(t.netR)}`, fmtR(t.netR)),
        h('td.txt', WHALE_LABEL[t.whale].replace(' (older than 30 days)', '')),
      ))),
    ));
  }

  function verdict(w) {
    const a = w.with;
    const z = w.against;
    if (!a?.n || !z?.n) return 'Not enough trades on both sides of the whale split to compare yet. Add pairs or pick a shorter timeframe.';
    const small = a.n < MIN_TRADES || z.n < MIN_TRADES;
    const diff = a.expR - z.expR;
    const lead = `With the whales: ${fmtR(a.expR)} per trade over ${a.n} trades. Against them: ${fmtR(z.expR)} over ${z.n}.`;
    if (small) return `${lead} Too few trades on at least one side (under ${MIN_TRADES}) to call a difference.`;
    const overlap = a.expLo != null && z.expHi != null && a.expLo <= z.expHi && z.expLo <= a.expHi;
    if (overlap) return `${lead} The ranges overlap, so this sample does not show the whale filter making a real difference.`;
    return `${lead} ${diff > 0 ? 'Following the whales helped' : 'Trading against the whales did better'} in this sample, and the ranges don’t overlap. Check it holds on other pairs and timeframes before relying on it.`;
  }

  async function exportCsv() {
    if (!result?.trades.length) return toast('Nothing to export yet');
    const ok = await copyText(csv(result.trades, [
      { label: 'pair', get: (t) => t.symbol },
      { label: 'setup', get: (t) => t.model },
      { label: 'side', get: (t) => (t.side > 0 ? 'long' : 'short') },
      { label: 'entry_time', get: (t) => new Date(t.entryT).toISOString() },
      { label: 'exit_time', get: (t) => new Date(t.exitT).toISOString() },
      { label: 'entry', get: (t) => t.entry },
      { label: 'stop', get: (t) => t.stop },
      { label: 'stop_pct', get: (t) => t.riskPct.toFixed(3) },
      { label: 'paper', get: (t) => t.paper },
      { label: 'exit', get: (t) => t.exitKind },
      { label: 'net_pct', get: (t) => t.netPct.toFixed(3) },
      { label: 'net_r', get: (t) => t.netR.toFixed(3) },
      { label: 'fees_pct', get: (t) => t.feePct.toFixed(3) },
      { label: 'funding_pct', get: (t) => t.fundingPct.toFixed(4) },
      { label: 'whales', get: (t) => t.whale },
      { label: 'whale_gap_pts', get: (t) => (t.gap == null ? '' : t.gap.toFixed(1)) },
    ]));
    toast(ok ? `Copied ${result.trades.length} trades as CSV` : 'Copy failed');
  }

  run().catch((e) => (status.textContent = e.message));
  return () => {
    alive = false;
  };
}
