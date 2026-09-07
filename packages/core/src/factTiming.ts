/**
 * Fact timing — making the freshness decision structurally unambiguous.
 *
 * Three separate bugs in this codebase were the same mistake: measuring a fact's age
 * from the wrong timestamp.
 *
 *  1. `DTWEXBGS` classified `DAILY` when H.10 publishes ~9 days in arrears, which
 *     would have made the joint-heaviest factor abstain permanently.
 *  2. A CPI print marked `UNAVAILABLE` because age was measured from the observation
 *     *period* (1 July) rather than the publication date (mid-August).
 *  3. Calendar thresholds applied to a monthly statistic, so a perfectly current
 *     figure looked two months stale.
 *
 * The root cause is a field called `sourceTimestamp` that could plausibly mean either
 * "when this was published" or "what period it describes". Every caller had to
 * remember which, and three times someone did not.
 *
 * `FactTiming` removes the choice. The two concepts have different names, different
 * types, and only one of them can reach the freshness calculation.
 */

import {
  assertValidThresholds,
  type FreshnessResult,
  type FreshnessStatus,
  type FreshnessThresholds,
} from './freshness.js';

/**
 * When a fact became known, and what it describes.
 *
 * `knownAt` is the only field freshness reads. `describesPeriod` is carried for
 * display and for engines that reason about the period itself — it is deliberately a
 * different type (a date-only string, not a `Date`) so the two cannot be mixed up by
 * accident.
 */
export interface FactTiming {
  /**
   * When the source published this, or when the value was observed for live data.
   *
   * **This is what freshness measures.** For a statistic it is the release date or
   * ALFRED vintage. For a quote it is the tick time. For an article it is the
   * publication time.
   */
  readonly knownAt: Date;

  /**
   * The period the value describes, as `YYYY-MM-DD`, where that differs from
   * `knownAt`.
   *
   * July's CPI has `describesPeriod: '2026-07-01'` and `knownAt` in mid-August.
   * **Never used for freshness** — a monthly figure is not stale for being about
   * last month.
   */
  readonly describesPeriod?: string;

  /** When we fetched it. */
  readonly retrievedAt: Date;
}

export class FactTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactTimingError';
  }
}

/**
 * Assess freshness from a `FactTiming`.
 *
 * The only supported way to compute freshness for a stored fact. It takes no
 * `sourceTimestamp` parameter, so the ambiguity that caused the three bugs above
 * cannot be expressed.
 */
export function assessFreshness(
  timing: FactTiming,
  thresholds: FreshnessThresholds,
  now: Date,
): FreshnessResult {
  assertValidThresholds(thresholds);

  if (timing.describesPeriod !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(timing.describesPeriod)) {
    // Catches a `Date` or an ISO datetime being passed here — the exact confusion
    // this type exists to prevent.
    throw new FactTimingError(
      `describesPeriod must be a YYYY-MM-DD date, got "${timing.describesPeriod}". ` +
        'If you meant "when this was published", use knownAt.',
    );
  }

  const FUTURE_SKEW_TOLERANCE_MS = 60_000;
  const rawAge = now.getTime() - timing.knownAt.getTime();
  const rawRetrievalAge = now.getTime() - timing.retrievedAt.getTime();

  const impossiblyFuture =
    rawAge < -FUTURE_SKEW_TOLERANCE_MS || rawRetrievalAge < -FUTURE_SKEW_TOLERANCE_MS;

  const sourceAgeMs = Math.max(0, rawAge);
  const retrievalAgeMs = Math.max(0, rawRetrievalAge);
  const verificationOverdue = retrievalAgeMs > thresholds.maxRetrievalAgeMs;

  if (impossiblyFuture) {
    return { status: 'UNAVAILABLE', sourceAgeMs, retrievalAgeMs, verificationOverdue };
  }

  let status: FreshnessStatus;
  if (sourceAgeMs <= thresholds.liveMs) status = 'LIVE';
  else if (sourceAgeMs <= thresholds.recentMs) status = 'RECENT';
  else if (sourceAgeMs <= thresholds.staleBeyondMs) status = 'STALE';
  else status = 'UNAVAILABLE';

  return { status, sourceAgeMs, retrievalAgeMs, verificationOverdue };
}

/**
 * How far behind a source runs, in days.
 *
 * The H.10 lag is a product-visible fact, not a config note: a user reading "USD
 * weakness" is entitled to know the reading is a week old. This is what the UI
 * renders beside the freshness chip.
 */
export function publicationLagDays(timing: FactTiming): number | null {
  if (timing.describesPeriod === undefined) return null;
  const period = Date.parse(`${timing.describesPeriod}T00:00:00Z`);
  if (Number.isNaN(period)) return null;
  return Math.round((timing.knownAt.getTime() - period) / 86_400_000);
}

/**
 * True when a fact's period is materially older than its publication — i.e. the
 * value describes a window that has already closed.
 *
 * Used to decide whether the UI must show an explicit lag note rather than relying
 * on the freshness chip alone.
 */
export function needsLagDisclosure(timing: FactTiming, thresholdDays = 3): boolean {
  const lag = publicationLagDays(timing);
  return lag !== null && lag >= thresholdDays;
}

/** Build a `FactTiming` for live data, where publication and observation coincide. */
export function liveTiming(observedAt: Date, retrievedAt: Date): FactTiming {
  return { knownAt: observedAt, retrievedAt };
}

/**
 * Build a `FactTiming` for a published statistic.
 *
 * Both arguments are required and differently typed, so calling it forces the author
 * to state which is which.
 */
export function publishedTiming(params: {
  publishedAt: Date;
  describesPeriod: string;
  retrievedAt: Date;
}): FactTiming {
  return {
    knownAt: params.publishedAt,
    describesPeriod: params.describesPeriod,
    retrievedAt: params.retrievedAt,
  };
}

// ── Publication calendars ───────────────────────────────────────────────────

/**
 * The weekdays a source actually publishes on, 0 = Sunday .. 6 = Saturday.
 *
 * Wall-clock freshness has a systematic weekend bias. `DGS10` publishes Monday to
 * Friday; the Friday value read on Sunday is 40 hours old by the clock and drops out
 * of `LIVE`, but it is still the latest figure in existence — nothing was published
 * because nothing was due. Two days in seven of degraded confidence on every
 * market-hours series is a persistent distortion, and confidence carries the
 * product's central claim.
 *
 * Measured over the twelve V1 series on 2026-08-30 (FRED `output_type=4`, so the
 * dates are first-release dates, not revision dates):
 *
 * | series        | published on          | median lag |
 * |---------------|-----------------------|-----------|
 * | DGS10/DGS2/DFII10 | Mon–Fri (14–18 each) | 1 day     |
 * | DFF           | Mon–Fri (Tue heaviest) | 1 day     |
 * | VIXCLS        | Mon–Fri               | 0 days    |
 * | BAMLH0A0HYM2  | Mon–Fri               | 0 days    |
 * | DTWEXBGS      | Mon ×75, Tue ×5       | 5 days    |
 * | ICSA          | Thu ×48, Wed ×3       | 5 days    |
 * | CPIAUCSL/CPILFESL | Tue–Fri, never Mon | 43 days   |
 * | PAYEMS/UNRATE | Fri ×6, else Tue–Thu  | 37 days   |
 */
export type PublicationDays = readonly number[];

/** Monday to Friday — the default for anything published on business days. */
export const BUSINESS_DAYS: PublicationDays = [1, 2, 3, 4, 5];

export function assertValidPublicationDays(days: PublicationDays): void {
  if (days.length === 0) {
    throw new FactTimingError(
      'Publication days must not be empty: a series that never publishes cannot be assessed',
    );
  }
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new FactTimingError(`Publication day must be an integer 0..6, got ${String(d)}`);
    }
  }
  if (new Set(days).size !== days.length) {
    throw new FactTimingError(`Publication days must not repeat: [${days.join(', ')}]`);
  }
}

const MS_PER_DAY = 86_400_000;

/**
 * Expected publication days elapsed over `(from, to]`, fractionally.
 *
 * Days the source does not publish on contribute nothing, so a weekend advances the
 * count by zero. Partial days contribute their fraction, which is what lets a missed
 * release register a few hours after it was due rather than a whole day later.
 *
 * All arithmetic is UTC. Publication calendars are properties of the *source*, and a
 * source's week does not shift because the reader is in another zone.
 */
export function publicationDaysElapsed(from: Date, to: Date, days: PublicationDays): number {
  assertValidPublicationDays(days);
  if (to.getTime() <= from.getTime()) return 0;

  const publishes = new Set(days);
  let total = 0;

  // Walk whole UTC days; a fact more than a year stale is UNAVAILABLE under every
  // threshold, so the loop is bounded rather than unbounded.
  const MAX_DAYS = 800;
  let cursor = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let i = 0; i < MAX_DAYS && cursor <= to.getTime(); i += 1) {
    const next = cursor + MS_PER_DAY;
    if (publishes.has(new Date(cursor).getUTCDay())) {
      const start = Math.max(cursor, from.getTime());
      const end = Math.min(next, to.getTime());
      if (end > start) total += (end - start) / MS_PER_DAY;
    }
    cursor = next;
  }
  return total;
}

/** Freshness assessed against a publication calendar, with both ages reported. */
export interface CalendarFreshnessResult extends FreshnessResult {
  /**
   * Age in publication time — what `status` was computed from. Expressed in
   * milliseconds so it shares the threshold type, where one publication day is 24h.
   */
  readonly effectiveAgeMs: number;
  /** Fractional expected publication days elapsed. */
  readonly publicationDaysElapsed: number;
  /**
   * True when the calendar produced a better status than the wall clock would have.
   *
   * The UI shows this so a `LIVE` chip on a Sunday is explainable rather than
   * surprising: the reading is Friday's because Friday's is the latest there is.
   */
  readonly calendarAdjusted: boolean;
}

/**
 * Assess freshness for a fact whose source publishes on a fixed weekly calendar.
 *
 * `thresholds` are read in **publication-day time**, not wall-clock time: 24h means
 * one expected publication day. That is why the daily thresholds keep their existing
 * numbers while the weekly ones do not — for `ICSA`, one publication day is a week,
 * so a 7-day wall-clock threshold would have become seven weeks.
 *
 * `maxRetrievalAgeMs` stays wall-clock throughout. Whether our own worker has run
 * recently is a fact about us, not about the publisher's calendar, and a worker that
 * died on Friday is just as dead on Sunday.
 */
export function assessFreshnessOnCalendar(
  timing: FactTiming,
  thresholds: FreshnessThresholds,
  now: Date,
  days: PublicationDays,
): CalendarFreshnessResult {
  const wallClock = assessFreshness(timing, thresholds, now);
  assertValidPublicationDays(days);

  // A future-dated or skewed fact is already UNAVAILABLE; a calendar must not
  // rescue it.
  if (wallClock.status === 'UNAVAILABLE' && wallClock.sourceAgeMs === 0) {
    return {
      ...wallClock,
      effectiveAgeMs: 0,
      publicationDaysElapsed: 0,
      calendarAdjusted: false,
    };
  }

  const elapsed = publicationDaysElapsed(timing.knownAt, now, days);
  const effectiveAgeMs = elapsed * MS_PER_DAY;

  let status: FreshnessStatus;
  if (effectiveAgeMs <= thresholds.liveMs) status = 'LIVE';
  else if (effectiveAgeMs <= thresholds.recentMs) status = 'RECENT';
  else if (effectiveAgeMs <= thresholds.staleBeyondMs) status = 'STALE';
  else status = 'UNAVAILABLE';

  return {
    status,
    sourceAgeMs: wallClock.sourceAgeMs,
    retrievalAgeMs: wallClock.retrievalAgeMs,
    verificationOverdue: wallClock.verificationOverdue,
    effectiveAgeMs,
    publicationDaysElapsed: elapsed,
    calendarAdjusted: status !== wallClock.status,
  };
}
