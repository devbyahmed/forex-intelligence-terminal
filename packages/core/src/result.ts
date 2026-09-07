/**
 * Provider outcomes (Principle P2, master PRD 9, 23).
 *
 * A provider never throws to signal "no data" and never returns a placeholder. It
 * returns one of exactly three shapes, and there is deliberately no fourth variant
 * that carries an assumed, interpolated or defaulted value. If code wants a number
 * it must first handle the case where there isn't one — which is the only reliable
 * way to guarantee the system never fabricates data.
 */

import type { Observation } from './observation.js';

export const STALE_REASONS = [
  'ALL_PROVIDERS_FAILED',
  'RATE_LIMITED',
  'CIRCUIT_OPEN',
  'SOURCE_NOT_UPDATED',
] as const;
export type StaleReason = (typeof STALE_REASONS)[number];

export const UNAVAILABLE_REASONS = [
  'ALL_PROVIDERS_FAILED',
  'NO_CACHED_VALUE',
  'CACHE_TOO_OLD',
  'NOT_SUPPORTED',
  'INVALID_RESPONSE',
  'RATE_LIMITED',
  'CIRCUIT_OPEN',
  'NOT_CONFIGURED',
  'TIMEOUT',
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** One attempt against one provider. Kept so a failure is explainable afterwards. */
export interface AttemptLog {
  readonly providerId: string;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'SKIPPED';
  /** Present on failure. Never contains a secret or a raw provider body. */
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly httpStatus?: number;
  /** Why we did not even try, e.g. breaker open or quota exhausted. */
  readonly skipReason?: string;
}

export type ProviderResult<T> =
  | { readonly status: 'OK'; readonly observation: Observation<T> }
  | {
      readonly status: 'STALE';
      readonly observation: Observation<T>;
      readonly reason: StaleReason;
      readonly attempted: readonly AttemptLog[];
    }
  | {
      readonly status: 'UNAVAILABLE';
      readonly reason: UnavailableReason;
      readonly attempted: readonly AttemptLog[];
    };

// ── Constructors ────────────────────────────────────────────────────────────

export function ok<T>(observation: Observation<T>): ProviderResult<T> {
  return { status: 'OK', observation };
}

export function stale<T>(
  observation: Observation<T>,
  reason: StaleReason,
  attempted: readonly AttemptLog[] = [],
): ProviderResult<T> {
  return { status: 'STALE', observation, reason, attempted };
}

export function unavailable<T>(
  reason: UnavailableReason,
  attempted: readonly AttemptLog[] = [],
): ProviderResult<T> {
  return { status: 'UNAVAILABLE', reason, attempted };
}

// ── Inspection ──────────────────────────────────────────────────────────────

/** True when a value is present, whether fresh or stale. */
export function hasValue<T>(
  r: ProviderResult<T>,
): r is Extract<ProviderResult<T>, { observation: Observation<T> }> {
  return r.status === 'OK' || r.status === 'STALE';
}

/**
 * The observation if there is one, otherwise null.
 *
 * Note there is no `unwrapOr(defaultValue)`. Supplying a fallback number is exactly
 * the fabrication this module exists to prevent, so callers must branch explicitly.
 */
export function observationOrNull<T>(r: ProviderResult<T>): Observation<T> | null {
  return hasValue(r) ? r.observation : null;
}

export function valueOrNull<T>(r: ProviderResult<T>): T | null {
  return hasValue(r) ? r.observation.value : null;
}

/** Map the contained value, preserving status, provenance and attempt history. */
export function mapResult<A, B>(r: ProviderResult<A>, f: (a: A) => B): ProviderResult<B> {
  if (r.status === 'UNAVAILABLE') return r;
  const observation: Observation<B> = {
    value: f(r.observation.value),
    provenance: r.observation.provenance,
    freshness: r.observation.freshness,
    qualityFlags: r.observation.qualityFlags,
  };
  return r.status === 'OK'
    ? { status: 'OK', observation }
    : { status: 'STALE', observation, reason: r.reason, attempted: r.attempted };
}

/** Exhaustiveness helper: makes an unhandled variant a compile-time error. */
export function matchResult<T, R>(
  r: ProviderResult<T>,
  handlers: {
    ok: (o: Observation<T>) => R;
    stale: (o: Observation<T>, reason: StaleReason) => R;
    unavailable: (reason: UnavailableReason) => R;
  },
): R {
  switch (r.status) {
    case 'OK':
      return handlers.ok(r.observation);
    case 'STALE':
      return handlers.stale(r.observation, r.reason);
    case 'UNAVAILABLE':
      return handlers.unavailable(r.reason);
  }
}
