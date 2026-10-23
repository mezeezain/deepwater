// Invented smart-money snapshots for demo mode, shaped like parseOverview() output.
// Whales trade at the current price (so entries move the way real VWAPs do) and
// now and then a trader joins the cohort with a different cost basis (a roster change).

function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function side(r, price, usd, count) {
  return { q: usd / price, q0: usd / price, entry: price * (1 + (r() - 0.5) * 0.06), count };
}

/**
 * Snapshots along a price path. bars: [{ t, c }] (any interval); one snapshot per bar.
 * oiUsdOf(bar) gives total open interest so cohort sizes stay plausible.
 */
export function demoSnapshots(symbol, bars, oiUsdOf = () => 5e8) {
  if (!bars.length) return [];
  const r = rng('sm' + symbol);
  const p0 = bars[0].c;
  const oi0 = oiUsdOf(bars[0]);
  const smallCap = r() < 0.25; // some pairs have too few whales, so smart traders are shown
  const whaleCount = smallCap ? 3 + Math.floor(r() * 5) : 15 + Math.floor(r() * 60);
  const book = {
    whale: { long: side(r, p0, oi0 * (0.03 + r() * 0.05), Math.ceil(whaleCount * 0.6)), short: side(r, p0, oi0 * (0.02 + r() * 0.04), Math.floor(whaleCount * 0.4)) },
    smart: { long: side(r, p0, oi0 * (0.01 + r() * 0.02), 120 + Math.floor(r() * 300)), short: side(r, p0, oi0 * (0.01 + r() * 0.02), 100 + Math.floor(r() * 300)) },
  };
  const bias = r() - 0.4; // positive: this pair's whales lean toward adding longs
  const out = [];
  bars.forEach((b, i) => {
    const P = b.c;
    for (const cohort of ['whale', 'smart']) {
      for (const s of ['long', 'short']) {
        const x = book[cohort][s];
        const lean = s === 'long' ? bias : -bias;
        const u = r();
        if (u < 0.012 && i > 0) {
          // Roster change: a trader with a cost basis 5–15% away joins or leaves.
          const dq = x.q * (0.05 + r() * 0.15) * (r() < 0.5 ? -1 : 1);
          const otherEntry = P * (1 + (r() < 0.5 ? -1 : 1) * (0.05 + r() * 0.1));
          if (dq > 0) x.entry = (x.entry * x.q + otherEntry * dq) / (x.q + dq);
          else x.entry = Math.max(P * 0.5, (x.entry * x.q - otherEntry * -dq) / Math.max(1e-9, x.q + dq));
          x.q = Math.max(x.q * 0.2, x.q + dq);
          x.count = Math.max(0, x.count + (dq > 0 ? 1 : -1));
        } else if (u < 0.35 + lean * 0.2) {
          // Add at market: entry moves toward the current price.
          const dq = x.q * r() * 0.03;
          x.entry = (x.entry * x.q + P * dq) / (x.q + dq);
          x.q += dq;
        } else if (u < 0.6) {
          // Close part: contracts drop, entry unchanged.
          x.q *= 1 - r() * 0.025;
        }
        // Positions drift but don't run away: pull gently back toward the starting size.
        x.q += (x.q0 - x.q) * 0.02;
      }
    }
    const snapSide = (x) => {
      const usd = x.q * P;
      const upnlSign = x === book.whale.short || x === book.smart.short ? -1 : 1;
      return { count: x.count, usd, entry: x.entry, upnl: upnlSign * (P - x.entry) * x.q, winRate: Math.min(0.95, Math.max(0.05, 0.5 + upnlSign * ((P - x.entry) / P) * 6)) };
    };
    out.push({
      symbol,
      t: b.t + 60_000,
      mark: P,
      oiUsd: oiUsdOf(b),
      whale: { long: snapSide(book.whale.long), short: snapSide(book.whale.short) },
      smart: { long: snapSide(book.smart.long), short: snapSide(book.smart.short) },
    });
  });
  return out;
}
