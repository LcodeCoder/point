// Small-sample statistics for the evolution loop.
//
// Every rate this file reports is a proportion over a finite sample, so it is
// reported with a Wilson score interval rather than a normal approximation: at
// n=10 a normal interval runs past 0 and 1 and hides exactly the uncertainty
// that makes a 3pp delta meaningless.

/** Proportion of successes, 0 for an empty sample. */
export function rate(ok, n) {
  return n > 0 ? ok / n : 0;
}

/**
 * Wilson score interval for a binomial proportion.
 * @param ok - successes.
 * @param n - trials.
 * @param z - normal quantile; 1.96 is the 95% interval.
 * @returns `[low, high]` clamped to [0, 1].
 */
export function wilson(ok, n, z = 1.96) {
  if (!Number.isFinite(n) || n <= 0) return [0, 0];
  const p = Math.min(1, Math.max(0, ok / n));
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / denom), Math.min(1, (centre + spread) / denom)];
}

/** after - before, the only delta shape the loop reasons about. */
export function delta(after, before) {
  return after - before;
}

/**
 * A delta below the noise floor is not a result.
 * @param d - measured delta.
 * @param threshold - the floor, default 3pp per the v2 spec.
 */
export function isNoise(d, threshold = 0.03) {
  return Math.abs(d) < threshold;
}

/** Two-sided difference between two proportions, for guard checks. */
export function diff(a, b) {
  return a - b;
}

/** Format a proportion for the round record. */
export function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

/** Mean of a numeric list, 0 for an empty list. */
export function mean(values) {
  const list = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  if (!list.length) return 0;
  return list.reduce((sum, v) => sum + v, 0) / list.length;
}

/** Relative change against a baseline, 0 when the baseline is zero. */
export function relative(after, before) {
  if (!Number.isFinite(before) || before === 0) return 0;
  return (after - before) / before;
}
