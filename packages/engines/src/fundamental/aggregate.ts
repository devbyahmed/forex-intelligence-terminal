/**
 * Aggregation, coverage, and the insufficiency rule (PRD_V1 §8.5.4).
 *
 * ```
 * effective_weight_i = weight_i × factor_confidence_i     (0 when abstaining)
 * fundamental_score  = Σ(score_i × effective_weight_i) / Σ(effective_weight_i)
 * coverage           = Σ(effective_weight_i) / Σ(weight_i)
 * ```
 *
 * Two properties do all the work, and both are easy to get subtly wrong:
 *
 * **The score renormalises by effective weight; coverage does not.** Dividing the
 * score by `Σ effective_weight` is what makes an unavailable factor abstain rather
 * than vote zero — the surviving factors are re-weighted among themselves. But
 * coverage divides by `Σ weight` over **every enabled factor, including the ones that
 * abstained**. Using the same denominator for both would make coverage identically
 * 1.0 and the insufficiency rule dead code: a run with seven of eight factors dark
 * would report full coverage right up until the moment it divided by zero.
 *
 * **Below the coverage floor there is no score at all.** Not a score with a warning,
 * not a score with low confidence — no score. The result type has no field to put one
 * in, so "INSUFFICIENT_DATA with a score" cannot be constructed, serialised, or
 * rendered. A product whose central claim is honesty about its own certainty has to
 * be able to say it does not know, and saying it in the type system is cheaper than
 * remembering to say it at every call site.
 */

import {
  classifySignedScore,
  clampSigned,
  toDisplayScore,
  type Bias,
  type BiasBand,
  type FactorId,
} from '@forex-agent/core';
import { effectiveWeight, isAbstained, isScored, type FactorOutcome } from './factor.js';

export interface AggregationInput {
  readonly factors: readonly FactorOutcome[];
  /** Below this coverage nothing is published. Default 0.50 (PRD_V1 §8.5.4). */
  readonly insufficientCoverageFloor: number;
  readonly bands?: readonly BiasBand[];
}

/** Shared by both outcomes: what was and was not available, and how much it covered. */
export interface AggregationBase {
  readonly coverage: number;
  readonly totalWeight: number;
  readonly effectiveWeight: number;
  readonly factors: readonly FactorOutcome[];
  /** Factors that produced no reading, with the reason, for the UI and the email. */
  readonly abstained: readonly { readonly factorId: FactorId; readonly reason: string; readonly detail: string }[];
}

export interface ScoredAggregation extends AggregationBase {
  readonly status: 'SCORED';
  /** Signed −100…+100. */
  readonly signedScore: number;
  /** 0…100, for display only. */
  readonly displayScore: number;
  readonly band: string;
  readonly bias: Bias;
  /**
   * `|Σ wᵢsᵢ| / Σ wᵢ|sᵢ|` — 1 when every contributing factor points the same way, 0
   * when they cancel exactly. Feeds confidence; deliberately not part of the score.
   */
  readonly agreement: number;
}

export interface InsufficientAggregation extends AggregationBase {
  readonly status: 'INSUFFICIENT_DATA';
  /** Plain-language statement of what is missing, for the UI and the daily email. */
  readonly reason: string;
  // No score, no band, no bias. There is deliberately nowhere to put one.
}

export type FundamentalAggregation = ScoredAggregation | InsufficientAggregation;

export class AggregationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AggregationError';
  }
}

export function aggregateFactors(input: AggregationInput): FundamentalAggregation {
  const { factors, insufficientCoverageFloor } = input;

  if (factors.length === 0) {
    throw new AggregationError(
      'Cannot aggregate zero factors. An empty factor set is a programming error, ' +
        'not an insufficiency — insufficiency means factors ran and could not produce readings.',
    );
  }
  if (!(insufficientCoverageFloor >= 0 && insufficientCoverageFloor <= 1)) {
    throw new AggregationError(
      `insufficientCoverageFloor must be within 0..1, got ${String(insufficientCoverageFloor)}`,
    );
  }

  // Denominator over ALL enabled factors, abstaining ones included. This is the line
  // that makes coverage mean "how much of the model actually ran".
  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  if (totalWeight <= 0) {
    throw new AggregationError('Total factor weight must be positive');
  }

  const effective = factors.reduce((sum, f) => sum + effectiveWeight(f), 0);
  const coverage = effective / totalWeight;

  const abstained = factors.filter(isAbstained).map((f) => ({
    factorId: f.factorId,
    reason: f.reason,
    detail: f.detail,
  }));

  const base: AggregationBase = {
    coverage,
    totalWeight,
    effectiveWeight: effective,
    factors,
    abstained,
  };

  // Checked before the division, not after: `effective === 0` means every factor
  // abstained, and 0/0 is NaN — a NaN score would propagate silently through
  // rounding, banding and storage and surface as a blank number on the dashboard.
  if (effective <= 0 || coverage < insufficientCoverageFloor) {
    return {
      ...base,
      status: 'INSUFFICIENT_DATA',
      reason: describeInsufficiency(coverage, insufficientCoverageFloor, abstained),
    };
  }

  const weightedSum = factors.reduce(
    (sum, f) => (isScored(f) ? sum + f.score * effectiveWeight(f) : sum),
    0,
  );
  const signedScore = clampSigned(weightedSum / effective);
  const displayScore = toDisplayScore(signedScore);
  const classified = classifySignedScore(signedScore, input.bands);

  return {
    ...base,
    status: 'SCORED',
    signedScore,
    displayScore,
    band: classified.label,
    bias: classified.bias,
    agreement: factorAgreement(factors),
  };
}

/**
 * Directional consensus among the contributing factors.
 *
 * `|Σ wᵢsᵢ| / Σ wᵢ|sᵢ|`: 1 when every factor points the same way, 0 when they cancel.
 * It measures dispersion, not level — a unanimous mildly-bullish reading scores 1
 * here, and so does a unanimous strongly-bullish one. That is what keeps confidence
 * from tracking the score, which §8.6 requires it not to do.
 *
 * Returns 1 when every contributing factor sits in the deadband: they do all agree,
 * on "no signal". Confidence is not raised by that, because the coverage and
 * freshness terms carry it.
 */
export function factorAgreement(factors: readonly FactorOutcome[]): number {
  let signed = 0;
  let absolute = 0;
  for (const f of factors) {
    if (!isScored(f)) continue;
    const w = effectiveWeight(f);
    signed += w * f.score;
    absolute += w * Math.abs(f.score);
  }
  if (absolute === 0) return 1;
  return Math.min(1, Math.abs(signed) / absolute);
}

function describeInsufficiency(
  coverage: number,
  floor: number,
  abstained: readonly { readonly factorId: FactorId; readonly detail: string }[],
): string {
  const pct = (n: number): string => `${String(Math.round(n * 100))}%`;
  if (abstained.length === 0) {
    return `Factor coverage ${pct(coverage)} is below the ${pct(floor)} floor required to publish a score.`;
  }
  const missing = abstained.map((a) => `${a.factorId}${a.detail === '' ? '' : ` (${a.detail})`}`);
  return (
    `Factor coverage ${pct(coverage)} is below the ${pct(floor)} floor required to publish a score. ` +
    `No score is reported. Unavailable: ${missing.join('; ')}.`
  );
}
