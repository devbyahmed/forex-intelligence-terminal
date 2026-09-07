/**
 * Data freshness (master PRD 38).
 *
 * Freshness answers "how old is this fact", measured from `sourceTimestamp` — when
 * the source says the value was true — not from when we happened to fetch it. A CPI
 * print released two weeks ago is still the current CPI; re-fetching it every hour
 * does not make it newer, and pretending otherwise would overstate our knowledge.
 *
 * How long since *we last checked* is a separate question with a separate answer:
 * `verificationOverdue`. A worker that died three days ago leaves the values correct
 * but our confidence in them lower, which is why the two axes are reported
 * separately and both feed the confidence engine rather than being averaged into
 * one misleading number.
 */

export const FRESHNESS_STATUSES = ['LIVE', 'RECENT', 'STALE', 'UNAVAILABLE'] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

/** Ordered worst-to-best so degradation comparisons read naturally. */
const SEVERITY: Readonly<Record<FreshnessStatus, number>> = {
  UNAVAILABLE: 0,
  STALE: 1,
  RECENT: 2,
  LIVE: 3,
};

/**
 * Age boundaries in milliseconds. A fact younger than `liveMs` is LIVE; younger
 * than `recentMs` is RECENT; younger than `staleBeyondMs` is STALE; older than that
 * is UNAVAILABLE — too old to be evidence of anything current.
 */
export interface FreshnessThresholds {
  readonly liveMs: number;
  readonly recentMs: number;
  readonly staleBeyondMs: number;
  /** How long we tolerate not re-checking before flagging verification overdue. */
  readonly maxRetrievalAgeMs: number;
}

export interface FreshnessInput {
  readonly sourceTimestamp: Date;
  readonly retrievedAt: Date;
  readonly thresholds: FreshnessThresholds;
  readonly now: Date;
}

export interface FreshnessResult {
  readonly status: FreshnessStatus;
  readonly sourceAgeMs: number;
  readonly retrievalAgeMs: number;
  /** True when our last successful check is older than `maxRetrievalAgeMs`. */
  readonly verificationOverdue: boolean;
}

export class FreshnessThresholdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreshnessThresholdError';
  }
}

export function assertValidThresholds(t: FreshnessThresholds): void {
  if (!(t.liveMs > 0 && t.recentMs > 0 && t.staleBeyondMs > 0 && t.maxRetrievalAgeMs > 0)) {
    throw new FreshnessThresholdError('All freshness thresholds must be positive');
  }
  if (!(t.liveMs <= t.recentMs && t.recentMs <= t.staleBeyondMs)) {
    throw new FreshnessThresholdError(
      `Freshness thresholds must be non-decreasing: live (${String(t.liveMs)}) <= recent (${String(
        t.recentMs,
      )}) <= staleBeyond (${String(t.staleBeyondMs)})`,
    );
  }
}

/**
 * Compute freshness. Boundaries are inclusive of the younger status: an age exactly
 * equal to `liveMs` is LIVE, so a 10-minute threshold means "up to and including 10
 * minutes old".
 *
 * A fact dated in the future is not silently accepted — clock skew or a provider bug
 * would otherwise make stale data look permanently fresh. Small skew (under a
 * minute) is tolerated and clamped to zero; anything larger is UNAVAILABLE.
 */
const FUTURE_SKEW_TOLERANCE_MS = 60_000;

export function computeFreshness(input: FreshnessInput): FreshnessResult {
  const { sourceTimestamp, retrievedAt, thresholds, now } = input;
  assertValidThresholds(thresholds);

  const rawSourceAge = now.getTime() - sourceTimestamp.getTime();
  const rawRetrievalAge = now.getTime() - retrievedAt.getTime();

  const impossiblyFuture =
    rawSourceAge < -FUTURE_SKEW_TOLERANCE_MS || rawRetrievalAge < -FUTURE_SKEW_TOLERANCE_MS;

  const sourceAgeMs = Math.max(0, rawSourceAge);
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

/** The worse (older) of two statuses. Used when a value depends on several facts. */
export function worstFreshness(
  a: FreshnessStatus,
  ...rest: readonly FreshnessStatus[]
): FreshnessStatus {
  return rest.reduce((worst, s) => (SEVERITY[s] < SEVERITY[worst] ? s : worst), a);
}

export function isUsable(status: FreshnessStatus): boolean {
  return status !== 'UNAVAILABLE';
}

/**
 * Confidence multiplier contributed by freshness (PRD_V1.md 8.5.4). STALE data is
 * halved rather than discarded; UNAVAILABLE contributes nothing, which is what makes
 * a missing factor abstain instead of voting zero.
 */
export const FRESHNESS_WEIGHT: Readonly<Record<FreshnessStatus, number>> = {
  LIVE: 1.0,
  RECENT: 0.85,
  STALE: 0.5,
  UNAVAILABLE: 0.0,
};
