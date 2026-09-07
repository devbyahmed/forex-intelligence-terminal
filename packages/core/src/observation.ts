/**
 * The provenance envelope (Principle P3, master PRD 38).
 *
 * Every fact that enters the system from outside is wrapped in `Observation<T>`.
 * There is no way to carry a value through the pipeline without carrying where it
 * came from, when the source said it was true, and when we fetched it — which is
 * the whole point: an unattributed number cannot be distinguished from an invented
 * one, so the type system refuses to produce one.
 */

import type { FreshnessStatus } from './freshness.js';
import type { SourceTier } from './vocab.js';

export interface Provenance {
  /** Stable id of the provider implementation, e.g. 'fred', 'yahoo-finance'. */
  readonly providerId: string;
  /** Human-readable publisher, e.g. 'Federal Reserve Economic Data'. */
  readonly sourceName: string;
  /** Deep link to the exact series or document. Null only when none is addressable. */
  readonly sourceUrl: string | null;
  readonly sourceTier: SourceTier;
  /** When the SOURCE says the fact was true or was published. */
  readonly sourceTimestamp: Date;
  /** When WE fetched it. */
  readonly retrievedAt: Date;
}

/**
 * Data-validation findings (master PRD 52). Flags travel with the fact rather than
 * causing a silent drop, so a suspicious value stays visible and auditable instead
 * of vanishing from the record.
 */
export const QUALITY_FLAGS = [
  'IMPOSSIBLE_VALUE',
  'OUT_OF_RANGE',
  'DUPLICATE',
  'ANOMALY',
  'REVISED',
  'CONFLICTING_SOURCES',
  'FUTURE_TIMESTAMP',
  'INTERPOLATED_BY_SOURCE',
  'LOW_SAMPLE',
] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

export interface Observation<T> {
  readonly value: T;
  readonly provenance: Provenance;
  readonly freshness: FreshnessStatus;
  readonly qualityFlags: readonly QualityFlag[];
}

export function makeObservation<T>(
  value: T,
  provenance: Provenance,
  freshness: FreshnessStatus,
  qualityFlags: readonly QualityFlag[] = [],
): Observation<T> {
  return { value, provenance, freshness, qualityFlags };
}

/** Map the value while preserving provenance exactly. */
export function mapObservation<A, B>(o: Observation<A>, f: (a: A) => B): Observation<B> {
  return {
    value: f(o.value),
    provenance: o.provenance,
    freshness: o.freshness,
    qualityFlags: o.qualityFlags,
  };
}

export function withQualityFlags<T>(
  o: Observation<T>,
  ...flags: readonly QualityFlag[]
): Observation<T> {
  const merged = new Set([...o.qualityFlags, ...flags]);
  return { ...o, qualityFlags: [...merged] };
}

/**
 * True when a fact carries a flag that should keep it out of scoring. Flagged data
 * is still stored and still shown — it is just not permitted to move a score.
 */
const DISQUALIFYING: ReadonlySet<QualityFlag> = new Set<QualityFlag>([
  'IMPOSSIBLE_VALUE',
  'OUT_OF_RANGE',
  'FUTURE_TIMESTAMP',
]);

export function isDisqualified<T>(o: Observation<T>): boolean {
  return o.qualityFlags.some((f) => DISQUALIFYING.has(f));
}
