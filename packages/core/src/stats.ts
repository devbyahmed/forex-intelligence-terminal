/**
 * The statistics the engines share.
 *
 * There is one z-score in this codebase, not one per caller. The economic-calendar
 * pipeline standardises release surprises and the fundamental engine standardises
 * factor signals; both need the same two judgements about when a z-score is a lie,
 * and both got them wrong once already.
 */

export interface ZScoreOptions {
  /**
   * Below this many observations, no z-score is produced.
   *
   * A z-score computed from four points is a number with no meaning, and the engine
   * cannot tell a meaningless number from a meaningful one — it just multiplies it by
   * a weight. Returning `null` makes the factor abstain, which is the honest outcome.
   */
  readonly minObservations: number;
}

/**
 * Standardise `value` against `history`, or return `null` when that cannot be done
 * honestly.
 *
 * Two `null` cases, both learned the hard way:
 *
 * **Too little history.** See `minObservations`.
 *
 * **Too little variance.** Twenty identical values do not produce a variance of
 * exactly zero in binary floating point — they produce something around 1e-35, and
 * dividing by its square root yields a z-score of 2.9e16. That number is meaningless
 * but perfectly finite, so `Number.isFinite` waves it through and it registers
 * downstream as an enormous signal. Observed for real in the calendar pipeline.
 *
 * The variance floor is therefore scaled to the magnitude of the data rather than
 * being a fixed epsilon: the same function has to serve percentage-point yields
 * around 4 and payroll counts around 159,000, and a constant that is sensible for one
 * is nonsense for the other.
 */
export function zScore(
  value: number,
  history: readonly number[],
  options: ZScoreOptions,
): number | null {
  if (history.length < options.minObservations) return null;
  if (!Number.isFinite(value)) return null;

  const usable = history.filter((h) => Number.isFinite(h));
  if (usable.length < options.minObservations) return null;

  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  const variance = usable.reduce((a, b) => a + (b - mean) ** 2, 0) / usable.length;
  const sd = Math.sqrt(variance);

  const scale = Math.max(Math.abs(mean), ...usable.map(Math.abs), 1);
  if (sd < scale * 1e-9) return null;

  const z = (value - mean) / sd;
  return Number.isFinite(z) ? z : null;
}

/** Percentage change from `from` to `to`, or null when the base is zero or missing. */
export function percentChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

/** Absolute change, in the series' own units. Null-propagating. */
export function absoluteChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return to - from;
}

/** Arithmetic mean, or null for an empty list. */
export function mean(values: readonly number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((a, b) => a + b, 0) / usable.length;
}
