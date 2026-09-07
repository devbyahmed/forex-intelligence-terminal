/**
 * The confidence engine (PRD_V1 §8.6, master §21).
 *
 * **Confidence is not the score, and must not track it.** A strongly bullish reading
 * built on three of eight factors, two of them stale, deserves low confidence — and a
 * mildly neutral reading built on all eight from Tier 1 sources at full freshness
 * deserves high confidence. Anything that lets the score's magnitude leak into
 * confidence turns the pair into one number reported twice, and the second number is
 * the one users lean on when deciding how much weight to give the first.
 *
 * The guarantee is structural rather than a matter of discipline:
 * `computeConfidence` never receives the score. Its input carries coverage, tier
 * weights, freshness and agreement — and agreement is `|Σws| / Σw|s|`, a measure of
 * dispersion that is invariant to scale, so doubling every factor's score leaves it
 * unchanged. There is no argument to pass a score through and no field to read one
 * from.
 *
 * Two hard caps sit above the weighted sum, because some conditions are not
 * negotiable by arithmetic:
 *
 *  - **Coverage below 0.65 caps at MEDIUM.** A run missing a third of the model
 *    cannot be highly confident regardless of how neatly the survivors agree —
 *    and survivors agreeing is exactly what a thin sample tends to produce.
 *  - **A HIGH-impact release inside 60 minutes caps at MEDIUM.** The reading may be
 *    correct and about to be invalidated; that is a statement about the world, not
 *    about our data.
 */

import {
  FRESHNESS_WEIGHT,
  capConfidence,
  classifyConfidence,
  type ConfidenceLevel,
  type ConfidenceThresholds,
  type FreshnessStatus,
  type SourceTier,
} from '@forex-agent/core';
import { TIER_WEIGHT, effectiveWeight, isScored, type FactorOutcome } from './factor.js';

export interface ConfidenceWeights {
  readonly coverage: number;
  readonly sourceQuality: number;
  readonly agreement: number;
  readonly freshness: number;
}

export interface ConfidenceInput {
  /** From aggregation. The primary driver. */
  readonly coverage: number;
  /** Directional consensus, `|Σws| / Σw|s|`. Scale-invariant by construction. */
  readonly agreement: number;
  readonly factors: readonly FactorOutcome[];
  readonly weights: ConfidenceWeights;
  readonly thresholds: ConfidenceThresholds;
  /** Coverage below this caps the level at MEDIUM. */
  readonly mediumCapCoverage: number;
  /** A HIGH-impact release this close caps the level at MEDIUM. */
  readonly eventRiskImminent: boolean;
  /** A provider chain running on a fallback, or a breaker open. */
  readonly degradedProviders?: readonly string[];
  // Deliberately absent: the score. See the module comment.
}

export interface ConfidenceResult {
  /** 0…100. */
  readonly value: number;
  readonly level: ConfidenceLevel;
  /** Each term's contribution, so the UI can explain the number rather than assert it. */
  readonly components: {
    readonly coverage: number;
    readonly sourceQuality: number;
    readonly agreement: number;
    readonly freshness: number;
    readonly degradationPenalty: number;
  };
  /** Which cap bound the result, if any. Shown to the user as the reason. */
  readonly caps: readonly string[];
  /** Level before caps, so a capped result is visibly capped rather than just low. */
  readonly uncappedLevel: ConfidenceLevel;
}

export class ConfidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfidenceError';
  }
}

/** Penalty per degraded provider chain, capped so it cannot invert the score. */
const DEGRADATION_PENALTY_EACH = 0.05;
const DEGRADATION_PENALTY_MAX = 0.2;

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const { weights } = input;
  const sum = weights.coverage + weights.sourceQuality + weights.agreement + weights.freshness;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new ConfidenceError(
      `Confidence weights must sum to 1, got ${String(sum)}. ` +
        'An unnormalised set silently rescales every confidence value in the product.',
    );
  }

  const sourceQuality = weightedSourceQuality(input.factors);
  const freshness = weightedFreshness(input.factors);

  const degraded = input.degradedProviders ?? [];
  const degradationPenalty = Math.min(
    DEGRADATION_PENALTY_MAX,
    degraded.length * DEGRADATION_PENALTY_EACH,
  );

  const components = {
    coverage: weights.coverage * clamp01(input.coverage),
    sourceQuality: weights.sourceQuality * sourceQuality,
    agreement: weights.agreement * clamp01(input.agreement),
    freshness: weights.freshness * freshness,
    degradationPenalty,
  };

  const raw =
    components.coverage +
    components.sourceQuality +
    components.agreement +
    components.freshness -
    components.degradationPenalty;

  const value = Math.round(clamp01(raw) * 100);
  const uncappedLevel = classifyConfidence(value, input.thresholds);

  const caps: string[] = [];
  let level = uncappedLevel;

  if (input.coverage < input.mediumCapCoverage) {
    caps.push(
      `Coverage ${String(Math.round(input.coverage * 100))}% is below ` +
        `${String(Math.round(input.mediumCapCoverage * 100))}%, so confidence is capped at MEDIUM.`,
    );
    level = capConfidence(level, 'MEDIUM');
  }
  if (input.eventRiskImminent) {
    caps.push(
      'A high-impact release is imminent, so confidence is capped at MEDIUM: ' +
        'the current reading may be invalidated by it.',
    );
    level = capConfidence(level, 'MEDIUM');
  }

  return { value, level, components, caps, uncappedLevel };
}

/**
 * Effective-weight-weighted mean tier quality of the contributing facts.
 *
 * Weighted by effective weight rather than counted per fact, so a Tier 3 input inside
 * a heavily-weighted factor moves this more than a Tier 3 input inside a light one —
 * which is the direction that matches how much the number actually depends on it.
 *
 * Returns 0 when nothing contributed. Zero is right: with no contributing facts there
 * is no source quality to speak of, and the caller is heading for INSUFFICIENT_DATA
 * anyway.
 */
export function weightedSourceQuality(factors: readonly FactorOutcome[]): number {
  let weighted = 0;
  let total = 0;
  for (const f of factors) {
    if (!isScored(f)) continue;
    const w = effectiveWeight(f);
    if (w <= 0) continue;
    const tiers = f.factRefs.map((r) => TIER_WEIGHT[r.sourceTier]);
    // A factor with no recorded refs is treated as Tier 1 rather than skipped: it is
    // computed from seeded configuration, not from an unattributed source.
    const meanTier = tiers.length === 0 ? 1 : tiers.reduce((a, b) => a + b, 0) / tiers.length;
    weighted += w * meanTier;
    total += w;
  }
  return total === 0 ? 0 : weighted / total;
}

/**
 * Effective-weight-weighted mean freshness of the contributing factors.
 *
 * §8.6 asks for "a penalty proportional to the effective weight sitting on STALE
 * data", which is what this is: STALE contributes 0.5 against LIVE's 1.0, in
 * proportion to how much of the score rests on it.
 */
export function weightedFreshness(factors: readonly FactorOutcome[]): number {
  let weighted = 0;
  let total = 0;
  for (const f of factors) {
    if (!isScored(f)) continue;
    const w = effectiveWeight(f);
    if (w <= 0) continue;
    weighted += w * FRESHNESS_WEIGHT[f.freshness];
    total += w;
  }
  return total === 0 ? 0 : weighted / total;
}

/** Tier of a fact, for callers assembling `FactRef`s. */
export function tierWeight(tier: SourceTier): number {
  return TIER_WEIGHT[tier];
}

/** Freshness multiplier, re-exported so factor code has one source for it. */
export function freshnessWeight(status: FreshnessStatus): number {
  return FRESHNESS_WEIGHT[status];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
