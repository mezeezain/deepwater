// Futures calculator: profit, return on margin, fees and an estimated liquidation price.
import { h, fmtPrice, fmtUsd, fmtPct, signClass, store, fill } from '../util.js';

/**
 * Liquidation price estimate for one position.
 * Isolated: only the position's own margin backs it. Cross: the whole account balance backs it, so price has to
 * move much further. Single position, no other positions or unrealized PnL: the account is liquidated when
 * balance + unrealized PnL falls to the maintenance margin (qty × price × mmr).
 * Exchange liquidation uses tiered maintenance rates, so this is an approximation; mmr is the maintenance margin
 * rate (0.004 = 0.4%).
 */
export function liquidationPrice({ side, entry, qty, backing, mmr }) {
  const liq = side === 'long'
    ? (qty * entry - backing) / (qty * (1 - mmr))
    : (backing + qty * entry) / (qty * (1 + mmr));
  return side === 'long' ? Math.max(0, liq) : liq;
}

export function calc({ side, entry, exit, margin, leverage, feeRate, mmr, marginMode = 'isolated', balance = 0 }) {
  const dir = side === 'long' ? 1 : -1;
  const notional = margin * leverage;
  const qty = notional / entry;
  const gross = (exit - entry) * qty * dir;
  const fees = (entry * qty + exit * qty) * feeRate;
  const net = gross - fees;
  const cross = marginMode === 'cross';
  const liq = liquidationPrice({ side, entry, qty, backing: cross ? balance : margin, mmr });
  const breakeven = entry * (side === 'long' ? (1 + feeRate) / (1 - feeRate) : (1 - feeRate) / (1 + feeRate));
  return { notional, qty, gross, fees, net, roe: (net / margin) * 100, liq, breakeven, liqDistance: ((liq - entry) / entry) * 100, cross, noLiq: side === 'long' && liq <= 0 };
}

const DEFAULTS = { side: 'long', entry: 65000, exit: 68000, margin: 500, leverage: 10, feeRate: 0.0005, mmr: 0.004, marginMode: 'isolated', balance: 2000 };

/** Reasons the inputs can't be calculated, or [] when they are fine. */
export function problems(s) {
  const out = [];
  if (!(s.entry > 0)) out.push('Entry price must be above zero.');
  if (!(s.exit > 0)) out.push('Exit price must be above zero.');
  if (!(s.margin > 0)) out.push('Margin must be above zero.');
  if (s.marginMode === 'cross' && !(s.balance >= s.margin)) out.push('In cross margin the account balance must cover the position margin.');
  if (!(s.leverage >= 1 && s.leverage <= 125)) out.push('Leverage must be between 1 and 125.');
  if (!(s.mmr >= 0 && s.mmr < 0.1)) out.push('Maintenance margin rate must be between 0 and 0.1 (10%).');
  else if (s.leverage >= 1 && s.leverage <= 125 && s.mmr >= 1 / s.leverage) out.push(`At ${s.leverage}x the maintenance margin rate must be below ${(100 / s.leverage).toFixed(2)}%, otherwise the position would be liquidated on entry.`);
  if (!(s.feeRate >= 0 && s.feeRate < 0.01)) out.push('Fee per side must be between 0% and 1%.');
  return out;
}

export function calculatorView(root) {
  const saved = store.get('calc', DEFAULTS);
  // Saved settings from an older version or a hand-edited store must not poison the page with NaN.
  let s = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, typeof v === typeof saved?.[k] && (typeof v !== 'number' || Number.isFinite(saved[k])) ? saved[k] : v]));
  if (s.side !== 'long' && s.side !== 'short') s.side = 'long';
  if (s.marginMode !== 'isolated' && s.marginMode !== 'cross') s.marginMode = 'isolated';
  const out = h('div.calc-out', { 'aria-live': 'polite' });
  let levNum;

  const num = (id, label, key, attrs = {}) => h('label.field', h('span', label),
    h('input', { id: 'calc-' + id, type: 'number', inputMode: 'decimal', value: s[key], ...attrs, oninput: (e) => { s[key] = e.target.value === '' ? NaN : +e.target.value; update(); } }));

  const sideBtns = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Side' },
    ...['long', 'short'].map((v) => h(`button.seg.${v}`, { type: 'button', role: 'radio', 'aria-checked': String(s.side === v), onclick: (e) => {
      s.side = v;
      sideBtns.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget)));
      update();
    } }, v === 'long' ? 'Long' : 'Short')));

  const modeBtns = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Margin mode' },
    ...[['isolated', 'Isolated'], ['cross', 'Cross']].map(([v, label]) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(s.marginMode === v), onclick: (e) => {
      s.marginMode = v;
      modeBtns.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget)));
      update();
    } }, label)));
  const balanceField = num('balance', 'Account balance backing the position (USDT)', 'balance', { min: 0, step: 'any' });

  fill(root, 
    h('section.hero.compact', h('div.hero-text',
      h('p.eyebrow', 'Isolated or cross margin, USDT-margined'),
      h('h1', 'Futures calculator'),
      h('p.lede', 'Work out profit, fees and roughly where a position gets liquidated before you open it.'))),
    h('div.split',
      h('section.panel.grow',
        h('form.calc-form', { onsubmit: (e) => e.preventDefault() },
          sideBtns,
          modeBtns,
          num('entry', 'Entry price', 'entry', { min: 0, step: 'any' }),
          num('exit', 'Exit price', 'exit', { min: 0, step: 'any' }),
          num('margin', 'Margin (USDT)', 'margin', { min: 0, step: 'any' }),
          h('label.field', h('span', 'Leverage'),
            h('div.range-row',
              h('input#calc-lev-range', { 'aria-label': 'Leverage slider', type: 'range', min: 1, max: 125, value: s.leverage, oninput: (e) => { s.leverage = +e.target.value; levNum.value = s.leverage; update(); } }),
              (levNum = h('input#calc-leverage', { type: 'number', min: 1, max: 125, value: s.leverage, 'aria-label': 'Leverage', oninput: (e) => { s.leverage = +e.target.value; update(); } })))),
          h('label.field', h('span', 'Fee per side'),
            h('select#calc-fee', { onchange: (e) => { s.feeRate = +e.target.value; update(); } },
              ...[[0.0002, 'Maker 0.02%'], [0.0005, 'Taker 0.05%'], [0.00045, 'Taker with BNB 0.045%']].map(([v, l]) => h('option', { value: v, selected: v === s.feeRate }, l)))),
          num('mmr', 'Maintenance margin rate', 'mmr', { min: 0, step: 0.001 }),
          balanceField,
        )),
      h('aside.panel.side', h('h2', 'Result'), out),
    ),
  );

  function update() {
    store.set('calc', s);
    balanceField.hidden = s.marginMode !== 'cross';
    const bad = problems(s);
    if (bad.length) {
      fill(out, ...bad.map((m) => h('p.error', m)));
      return;
    }
    const r = calc(s);
    const exitBeyondLiq = s.side === 'long' ? s.exit <= r.liq : s.exit >= r.liq;
    fill(out, ...[
      h(`div.big.${signClass(r.net)}`, fmtUsd(r.net, true)),
      h(`p.${signClass(r.roe)}`, `${fmtPct(r.roe)} on margin`),
      exitBeyondLiq && h('p.warn', 'Your exit price is past the liquidation price. The position would be closed before reaching it.'),
      h('dl.kv',
        h('div', h('dt', 'Position size'), h('dd', fmtUsd(r.notional))),
        h('div', h('dt', 'Quantity'), h('dd', r.qty.toPrecision(5))),
        h('div', h('dt', 'Profit before fees'), h(`dd.${signClass(r.gross)}`, fmtUsd(r.gross, true))),
        h('div', h('dt', 'Fees, open and close'), h('dd', fmtUsd(-r.fees))),
        h('div', h('dt', 'Break-even price'), h('dd', fmtPrice(r.breakeven))),
        h('div', h('dt', r.cross ? 'Liquidation price, cross, estimate' : 'Liquidation price, estimate'), h('dd.down', r.noLiq ? 'none above 0' : fmtPrice(r.liq))),
        h('div', h('dt', 'Distance to liquidation'), h('dd', r.noLiq ? '–' : fmtPct(r.liqDistance, 2))),
        r.cross && h('div', h('dt', 'Isolated, for comparison'), h('dd', fmtPrice(calc({ ...s, marginMode: 'isolated' }).liq))),
      ),
      r.cross
        ? h('p.note', 'Cross margin: the whole balance backs this one position, so it survives a much bigger move, but a loss can take the entire balance, not just the position margin. This assumes it is your only open position. Other positions and their unrealized PnL change the real figure, and a crash that liquidates one can take the others with it.')
        : null,
      h('p.note', 'Binance uses tiered maintenance rates and adds funding payments, so the real liquidation price can differ slightly.'),
    ].filter(Boolean));
  }
  update();
  return () => {};
}
