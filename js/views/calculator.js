// Futures calculator: profit, return on margin, fees and an estimated liquidation price.
import { h, fmtPrice, fmtUsd, fmtPct, signClass, store } from '../util.js';

/**
 * Isolated-margin estimate. Exchange liquidation uses tiered maintenance rates,
 * so this is an approximation; mmr is the maintenance margin rate (0.004 = 0.4%).
 */
export function calc({ side, entry, exit, margin, leverage, feeRate, mmr }) {
  const dir = side === 'long' ? 1 : -1;
  const notional = margin * leverage;
  const qty = notional / entry;
  const gross = (exit - entry) * qty * dir;
  const fees = (entry * qty + exit * qty) * feeRate;
  const net = gross - fees;
  const liq = side === 'long'
    ? (entry * (1 - 1 / leverage)) / (1 - mmr)
    : (entry * (1 + 1 / leverage)) / (1 + mmr);
  const breakeven = entry * (side === 'long' ? (1 + feeRate) / (1 - feeRate) : (1 - feeRate) / (1 + feeRate));
  return { notional, qty, gross, fees, net, roe: (net / margin) * 100, liq: Math.max(0, liq), breakeven, liqDistance: ((liq - entry) / entry) * 100 };
}

export function calculatorView(root) {
  let s = store.get('calc', { side: 'long', entry: 65000, exit: 68000, margin: 500, leverage: 10, feeRate: 0.0005, mmr: 0.004 });
  const out = h('div.calc-out');
  let levNum;

  const num = (id, label, key, attrs = {}) => h('label.field', h('span', label),
    h('input', { id: 'calc-' + id, type: 'number', inputMode: 'decimal', value: s[key], ...attrs, oninput: (e) => { s[key] = +e.target.value; update(); } }));

  const sideBtns = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Side' },
    ...['long', 'short'].map((v) => h(`button.seg.${v}`, { type: 'button', role: 'radio', 'aria-checked': String(s.side === v), onclick: (e) => {
      s.side = v;
      sideBtns.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget)));
      update();
    } }, v === 'long' ? 'Long' : 'Short')));

  root.replaceChildren(
    h('section.hero.compact', h('div.hero-text',
      h('p.eyebrow', 'Isolated margin, USDT-margined'),
      h('h1', 'Futures calculator'),
      h('p.lede', 'Work out profit, fees and roughly where a position gets liquidated before you open it.'))),
    h('div.split',
      h('section.panel.grow',
        h('form.calc-form', { onsubmit: (e) => e.preventDefault() },
          sideBtns,
          num('entry', 'Entry price', 'entry', { min: 0, step: 'any' }),
          num('exit', 'Exit price', 'exit', { min: 0, step: 'any' }),
          num('margin', 'Margin (USDT)', 'margin', { min: 0, step: 'any' }),
          h('label.field', h('span', 'Leverage'),
            h('div.range-row',
              h('input#calc-lev-range', { type: 'range', min: 1, max: 125, value: s.leverage, oninput: (e) => { s.leverage = +e.target.value; levNum.value = s.leverage; update(); } }),
              (levNum = h('input#calc-leverage', { type: 'number', min: 1, max: 125, value: s.leverage, 'aria-label': 'Leverage', oninput: (e) => { s.leverage = +e.target.value; update(); } })))),
          h('label.field', h('span', 'Fee per side'),
            h('select#calc-fee', { onchange: (e) => { s.feeRate = +e.target.value; update(); } },
              ...[[0.0002, 'Maker 0.02%'], [0.0005, 'Taker 0.05%'], [0.00045, 'Taker with BNB 0.045%']].map(([v, l]) => h('option', { value: v, selected: v === s.feeRate }, l)))),
          num('mmr', 'Maintenance margin rate', 'mmr', { min: 0, step: 0.001 }),
        )),
      h('aside.panel.side', h('h2', 'Result'), out),
    ),
  );

  function update() {
    store.set('calc', s);
    if (!(s.entry > 0 && s.exit > 0 && s.margin > 0 && s.leverage >= 1)) {
      out.replaceChildren(h('p.error', 'Enter an entry price, exit price and margin above zero, and leverage of at least 1.'));
      return;
    }
    const r = calc(s);
    const exitBeyondLiq = s.side === 'long' ? s.exit <= r.liq : s.exit >= r.liq;
    out.replaceChildren(...[
      h(`div.big.${signClass(r.net)}`, fmtUsd(r.net, true)),
      h(`p.${signClass(r.roe)}`, `${fmtPct(r.roe)} on margin`),
      exitBeyondLiq && h('p.warn', 'Your exit price is past the liquidation price. The position would be closed before reaching it.'),
      h('dl.kv',
        h('div', h('dt', 'Position size'), h('dd', fmtUsd(r.notional))),
        h('div', h('dt', 'Quantity'), h('dd', r.qty.toPrecision(5))),
        h('div', h('dt', 'Profit before fees'), h(`dd.${signClass(r.gross)}`, fmtUsd(r.gross, true))),
        h('div', h('dt', 'Fees, open and close'), h('dd', fmtUsd(-r.fees))),
        h('div', h('dt', 'Break-even price'), h('dd', fmtPrice(r.breakeven))),
        h('div', h('dt', 'Liquidation price, estimate'), h('dd.down', fmtPrice(r.liq))),
        h('div', h('dt', 'Distance to liquidation'), h('dd', fmtPct(r.liqDistance, 2))),
      ),
      h('p.note', 'Binance uses tiered maintenance rates and adds funding payments, so the real liquidation price can differ slightly.'),
    ].filter(Boolean));
  }
  update();
  return () => {};
}
