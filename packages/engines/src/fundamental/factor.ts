/**
 * What a factor produces.
 *
 * The central design decision here is that **abstention is a shape, not a value**.
 *
 * The obvious modelling — `score: number | null` beside `abstainedReason: string | null`
 * — permits four combinations, of which two are nonsense: a score with a reason for
 * having no score, and no score with no reason. Nonsense states that can be written
 * down eventually get written down, and this particular nonsense is the one that
 * matters most: a factor that abstained but still carries a number will still move
 * the total, which is precisely the failure abstention exists to prevent.
 *
 * So the two outcomes are separate variants of a discriminated union. A `SCORED`
 * factor has no `abstainedReason` field to set; an `ABSTAINED` factor has no `score`
 * field to read. The database enforces the same invariant independently
 * (`fundamental_factors_abstain_coherent`), because a type only protects the code
 * that goes through it.
 *
 * The other rule: **a missing input must never become a zero.** Zero on the signed
 * scale means "measured, and neutral" — a real reading that the market gave us. An
 * unavailable input means we do not know. Collapsing the second into the first is the
 * single most consequential lie this engine could tell, because it is invisible: the
 * score looks the same, the factor count looks the same, and nothing in the output
 * says a fifth of the model was guessed.
 */

import type { FactorId, FreshnessStatus, SourceTier } from '@forex-agent/core';

/** Why a factor could not produce a reading. Enumerated so the UI can group them. */
export const ABSTENTION_REASONS = [
  /** A required input was UNAVAILABLE — too old to be evidence of anything current. */
  'INPUT_UNAVAILABLE',
  /** A required input was never fetched, or the series returned nothing. */
  'INPUT_MISSING',
  /** Fewer observations than the z-score needs; a z from four points is not a z. */
  'INSUFFICIENT_HISTORY',
  /** The input series is flat enough that a z-score would be numerical noise. */
  'NO_VARIANCE',
  /** Measured volume below the configured floor — F8's normal state today. */
  'BELOW_VOLUME_THRESHOLD',
  /** Turned off in the active config profile. */
  'DISABLED',
] as const;
export type AbstentionReason = (typeof ABSTENTION_REASONS)[number];

/**
 * Who or what a missing reading is attributable to.
 *
 * The distinction exists because **graceful degradation is indistinguishable from
 * correct operation unless you say which kind it is** (PRD_V1 §8.5.3a). Three cases,
 * and conflating any two of them costs something different:
 *
 * - `WORLD` — the market was quiet, a provider was down, or the data genuinely does
 *   not exist yet. This is *information*: it tells the user something true about
 *   conditions, and nothing needs fixing.
 *
 * - `CONFIGURATION` — our setup makes the reading impossible. F5 spent two phases
 *   structurally unable to score because the ingestion window held twelve monthly
 *   observations against a forty-two-observation requirement. This is a **defect**,
 *   and `checkFactorViability` now fails the boot rather than letting it abstain
 *   quietly.
 *
 * - `STRUCTURAL` — the data exists in the world but is not reachable on the sources
 *   this product is built on. Historical consensus forecasts are the case: they are
 *   published, they are simply behind a paywall at every vendor, and ForexFactory's
 *   free feed is a rolling one-week window (LIMITS.md §6.9).
 *
 * `STRUCTURAL` is not a variant of either neighbour. It is not our misconfiguration —
 * no window we could set would retrieve it — and it is not the market being quiet,
 * because the data is out there. It is a **permanent consequence of the free-tier
 * decision**, and it deserves to be named in the model rather than inferred from a
 * comment, because the same distinction recurs in V2 (intraday history depth) and V4
 * (per-pair provider coverage).
 */
export const LIMITATION_ATTRIBUTIONS = ['WORLD', 'CONFIGURATION', 'STRUCTURAL'] as const;
export type LimitationAttribution = (typeof LIMITATION_ATTRIBUTIONS)[number];

/**
 * Where each abstention reason is attributable.
 *
 * `INSUFFICIENT_HISTORY` and `DISABLED` are ours; the rest describe the world. A
 * reason that becomes structural is added to the map rather than to a caller's
 * judgement, so the same reason cannot be attributed two ways in two places.
 */
export const ATTRIBUTION_OF: Readonly<Record<AbstentionReason, LimitationAttribution>> = {
  INPUT_UNAVAILABLE: 'WORLD',
  INPUT_MISSING: 'WORLD',
  // Ours: the viability check exists precisely so this never ships.
  INSUFFICIENT_HISTORY: 'CONFIGURATION',
  NO_VARIANCE: 'WORLD',
  BELOW_VOLUME_THRESHOLD: 'WORLD',
  DISABLED: 'CONFIGURATION',
};

/**
 * A sub-signal a factor could not include, stated in words rather than as a number.
 *
 * A completeness of 0.5 tells a user how much weight the factor lost. It does not tell
 * them **which half they are reading**, and for F5 that is the difference between "the
 * inflation picture is neutral" and "the inflation-hedge channel is neutral, and the
 * opposing rate channel is not being measured at all". The second is the truth; the
 * first is what a percentage lets a reader assume.
 */
export interface FactorLimitation {
  readonly attribution: LimitationAttribution;
  /** The sub-signal that is missing, named as the user would recognise it. */
  readonly missing: string;
  /** Why it is missing, in one sentence. */
  readonly reason: string;
  /**
   * What would resolve it, and roughly when.
   *
   * Null only where genuinely unknown. A limitation with an end date reads as a known
   * constraint; the same limitation without one reads as a permanent unknown, and
   * users discount a product accordingly.
   */
  readonly resolution: string | null;
}

/** A fact this factor consumed, for the provenance expander (master §12). */
export interface FactRef {
  readonly table: string;
  readonly id: string;
  readonly label: string;
  readonly freshness: FreshnessStatus;
  readonly sourceTier: SourceTier;
}

export interface FactorBase {
  readonly factorId: FactorId;
  readonly factorName: string;
  /** Configured weight, before confidence is applied. */
  readonly weight: number;
  /** Every fact consumed — present on abstaining factors too, since a partial read is still evidence of what was tried. */
  readonly factRefs: readonly FactRef[];
  /** Template-filled from real values. Never AI prose (master §12). */
  readonly explanation: string;
}

export interface ScoredFactor extends FactorBase {
  readonly kind: 'SCORED';
  /** Signed −100…+100. */
  readonly score: number;
  readonly zScore: number;
  readonly direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** Raw inputs, stored so the number can be audited without re-fetching. */
  readonly rawSignal: Readonly<Record<string, number | null>>;
  /** freshness × tier × completeness, in 0…1. */
  readonly confidence: number;
  /** Worst freshness among the inputs — one stale input makes the factor stale. */
  readonly freshness: FreshnessStatus;
  /** Fraction of the factor's required inputs that resolved. */
  readonly inputCompleteness: number;
  /**
   * Sub-signals this reading does not include, in words.
   *
   * Empty on a complete factor. Non-empty means the user is reading part of the
   * factor, and must be told which part — a percentage alone lets them assume they
   * are seeing all of it, scaled down.
   */
  readonly limitations: readonly FactorLimitation[];
}

export interface AbstainedFactor extends FactorBase {
  readonly kind: 'ABSTAINED';
  readonly reason: AbstentionReason;
  /** Human-readable specifics, e.g. 'DFII10 UNAVAILABLE (last published 12 days ago)'. */
  readonly detail: string;
  /** Always UNAVAILABLE or the worst freshness seen, for display alongside the reason. */
  readonly freshness: FreshnessStatus;
  /**
   * Whether this absence is the world's, ours, or a permanent limit of the free tier.
   *
   * The UI groups on this: "F8 abstained: 6 articles against a 10 floor" is the world
   * telling the user something. "F5 abstained: insufficient history" would be a bug
   * report wearing the same clothes.
   */
  readonly attribution: LimitationAttribution;
}

export type FactorOutcome = ScoredFactor | AbstainedFactor;

export function isScored(f: FactorOutcome): f is ScoredFactor {
  return f.kind === 'SCORED';
}

export function isAbstained(f: FactorOutcome): f is AbstainedFactor {
  return f.kind === 'ABSTAINED';
}

/**
 * The effective weight a factor carries into the aggregate.
 *
 * **Derived, never supplied.** An abstaining factor returns exactly zero because this
 * function does not look at anything else — there is no field a caller could set to
 * give an abstaining factor influence, and no arithmetic path from `ABSTAINED` to a
 * non-zero result.
 */
export function effectiveWeight(f: FactorOutcome): number {
  return f.kind === 'SCORED' ? f.weight * f.confidence : 0;
}

/**
 * Re-exported from `packages/core`, not redefined.
 *
 * This constant existed in three places — here, in `core/vocab.ts`, and privately in
 * `news/aggregate.ts` — with identical values. Identical *today* is the whole problem:
 * three copies of a rule agree until the day someone reweights tier 3, changes two of
 * them, and the third goes on scoring by the old table with nothing to notice.
 *
 * Callers keep importing `TIER_WEIGHT` from here; the definition lives with the
 * `SourceTier` type it indexes.
 */
export { TIER_WEIGHT } from '@forex-agent/core';
