// Measured record of each setup across many coins, from `node tools/setups.mjs --compare` on the server.
// The Live setups grade uses it as a check, because the record of BTC, ETH and SOL alone (what the page
// loads) is usually too small to judge a setup by.
//
// Source: 2 Nov 2026, 40 most traded Binance USDT perpetuals, 1,500 candles per timeframe, with the
// "stop wide enough for costs" filter (the setups as they now run). Each coin's history split into its
// older 70% ("seen") and newest 30% ("unseen"). Expectancy in R after fees, slippage and funding.
// Re-run the comparison every month or two and update these numbers.

export const TESTED = {
  date: '2026-11-02',
  pairs: 40,
  record: {
    sweep: {
      '15m': { seen: { n: 181, expR: -0.06 }, unseen: { n: 58, expR: -0.17 } },
      '1h': { seen: { n: 260, expR: -0.24 }, unseen: { n: 79, expR: 0.0 } },
      '4h': { seen: { n: 165, expR: -0.12 }, unseen: { n: 64, expR: -0.08 } },
    },
    retest: {
      '15m': { seen: { n: 240, expR: 0.12 }, unseen: { n: 114, expR: 0.29 } },
      '1h': { seen: { n: 521, expR: -0.03 }, unseen: { n: 230, expR: 0.07 } },
      '4h': { seen: { n: 634, expR: -0.03 }, unseen: { n: 286, expR: 0.07 } },
    },
    regime: {
      '15m': { seen: { n: 370, expR: 0.05 }, unseen: { n: 130, expR: 0.03 } },
      '1h': { seen: { n: 470, expR: -0.05 }, unseen: { n: 172, expR: -0.11 } },
      '4h': { seen: { n: 392, expR: 0.05 }, unseen: { n: 153, expR: -0.17 } },
    },
  },
};

/**
 * Verdict for one setup and timeframe:
 *   good     made money on both the older and the newest part, at least +0.05R per trade on the newest
 *   bad      did not make money on either part
 *   neutral  mixed, or too few trades (under 30 on either part)
 */
export function testedVerdict(model, tf) {
  const r = TESTED.record[model]?.[tf];
  if (!r || r.seen.n < 30 || r.unseen.n < 30) return { state: 'neutral', r: r ?? null };
  if (r.seen.expR > 0 && r.unseen.expR >= 0.05) return { state: 'good', r };
  if (r.seen.expR <= 0 && r.unseen.expR <= 0) return { state: 'bad', r };
  return { state: 'neutral', r };
}
