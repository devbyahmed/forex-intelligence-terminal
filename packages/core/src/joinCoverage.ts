/**
 * Join-coverage assertions.
 *
 * Wherever two providers describe the same entity in different vocabularies, a
 * mismatch degrades silently: the join simply matches nothing and the system carries
 * on producing plausible-looking output built on less evidence than it should have.
 *
 * This happened for real. Curated importance rules were keyed on country `US`;
 * ForexFactory puts the *currency code* in that field. 143 releases were ingested and
 * **zero** matched a curated rule, so CPI and NFP silently kept whatever rating a
 * scraped feed asserted — and nothing anywhere reported a problem. The pipeline was
 * "working". A second instance followed immediately: `'cpi'` is not a substring of
 * FRED's `'Consumer Price Index'`, so the fix for the first bug still matched nothing.
 *
 * The lesson generalises: **a rule set that matches nothing is a bug, not an empty
 * day.** These helpers make that failure loud.
 */

export interface CoverageReport {
  readonly name: string;
  readonly candidates: number;
  readonly matched: number;
  readonly matchRate: number;
  readonly healthy: boolean;
  readonly reason: string | null;
  /** A few unmatched examples, to make diagnosis immediate. */
  readonly sampleUnmatched: readonly string[];
}

export interface CoverageExpectation {
  /** Fail if fewer than this fraction of candidates matched. */
  readonly minMatchRate?: number;
  /** Fail if fewer than this many matched, regardless of rate. */
  readonly minMatches?: number;
  /**
   * When true, zero candidates is acceptable — a genuinely quiet window. When false
   * (the default), an empty input is itself suspicious and reported.
   */
  readonly allowEmptyInput?: boolean;
}

export class JoinCoverageError extends Error {
  readonly report: CoverageReport;
  constructor(report: CoverageReport) {
    super(
      `Join "${report.name}" matched ${String(report.matched)} of ${String(report.candidates)} ` +
        `candidates (${(report.matchRate * 100).toFixed(1)}%): ${report.reason ?? 'below expectation'}. ` +
        (report.sampleUnmatched.length > 0
          ? `Unmatched examples: ${report.sampleUnmatched.join(', ')}`
          : ''),
    );
    this.name = 'JoinCoverageError';
    this.report = report;
  }
}

/**
 * Measure how much of a candidate set a matcher actually matched.
 *
 * Returns a report rather than throwing, so a caller can log a warning during
 * ingestion and a test can assert on the same numbers.
 */
export function measureCoverage<T>(params: {
  name: string;
  candidates: readonly T[];
  matched: (item: T) => boolean;
  describe: (item: T) => string;
  expectation?: CoverageExpectation;
}): CoverageReport {
  const expectation = params.expectation ?? {};
  const minMatchRate = expectation.minMatchRate ?? 0;
  const minMatches = expectation.minMatches ?? 1;
  const allowEmptyInput = expectation.allowEmptyInput ?? false;

  const unmatched: string[] = [];
  let matched = 0;

  for (const item of params.candidates) {
    if (params.matched(item)) matched += 1;
    else if (unmatched.length < 5) unmatched.push(params.describe(item));
  }

  const candidates = params.candidates.length;
  const matchRate = candidates === 0 ? 0 : matched / candidates;

  let reason: string | null = null;
  if (candidates === 0) {
    reason = allowEmptyInput ? null : 'no candidates were supplied at all';
  } else if (matched < minMatches) {
    reason = `expected at least ${String(minMatches)} match(es)`;
  } else if (matchRate < minMatchRate) {
    reason = `expected at least ${(minMatchRate * 100).toFixed(0)}% to match`;
  }

  return {
    name: params.name,
    candidates,
    matched,
    matchRate,
    healthy: reason === null,
    reason,
    sampleUnmatched: unmatched,
  };
}

/**
 * Measure and throw if the join is unhealthy.
 *
 * Used where a silent zero-match would corrupt downstream reasoning — importance
 * classification, asset tagging, event aliasing.
 */
export function assertCoverage<T>(params: {
  name: string;
  candidates: readonly T[];
  matched: (item: T) => boolean;
  describe: (item: T) => string;
  expectation?: CoverageExpectation;
}): CoverageReport {
  const report = measureCoverage(params);
  if (!report.healthy) throw new JoinCoverageError(report);
  return report;
}

/**
 * Check that a vocabulary on one side of a join overlaps the other at all.
 *
 * Catches the class of bug directly: a rule set keyed on `US` against rows keyed
 * `USD` has zero vocabulary overlap, which is detectable before a single row is
 * processed.
 */
export function assertVocabularyOverlap(params: {
  name: string;
  left: readonly string[];
  right: readonly string[];
  minOverlap?: number;
}): CoverageReport {
  const rightSet = new Set(params.right.map((v) => v.toLowerCase()));
  return assertCoverage({
    name: params.name,
    candidates: params.left,
    matched: (v) => rightSet.has(v.toLowerCase()),
    describe: (v) => v,
    expectation: { minMatches: params.minOverlap ?? 1 },
  });
}
