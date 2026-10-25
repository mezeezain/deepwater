// Small-sample statistics for the track record and the backtest. Pure functions, no dependencies.

/** Wilson 95% interval for a proportion k/n. Returns [lo, hi] as fractions, or null when n is 0. */
export function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Deterministic random numbers (mulberry32), so the same signals always give the same interval. */
export function rng(seed = 12345) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap 95% interval for the mean of `values`. Returns [lo, hi], or null with fewer than 5 values
 * (an interval from so few results would look more precise than it is).
 */
export function bootstrapMean(values, { iterations = 1000, seed = 12345, level = 0.95 } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 5) return null;
  const rand = rng(seed);
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[Math.floor(rand() * v.length)];
    means.push(s / v.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(((1 - level) / 2) * iterations)];
  const hi = means[Math.min(iterations - 1, Math.floor((1 - (1 - level) / 2) * iterations))];
  return [lo, hi];
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
