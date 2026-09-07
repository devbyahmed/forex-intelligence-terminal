/**
 * Signal normalisation (PRD_V1 §8.5.3).
 *
 * ```
 * z      = zScore(signal, trailing window)      -- null when it cannot be trusted
 * z'     = clamp(z, ±clampZ)
 * z''    = |z'| < deadbandZ ? 0 : z'
 * score  = sign × clamp(z'' / clampZ, −1, 1) × 100
 * ```
 *
 * Three deliberate choices:
 *
 * **The deadband exists so that "no signal" is expressible.** Without it every factor
 * returns some non-zero number every day, and the score twitches on noise. A reading
 * inside the deadband is a genuine measurement of "nothing much is happening", which
 * is different from an abstention — the data was there, it just said nothing.
 *
 * **The clamp bounds a single factor's influence.** A six-sigma move in one series
 * should not be able to pin the whole score; it is capped at the same ±100 as a
 * three-sigma move, and the confidence and event-risk machinery is what conveys that
 * something unusual is happening.
 *
 * **A null z abstains rather than scoring zero.** `zScore` returns null when the
 * history is too short or too flat to standardise against. Mapping that to 0 would
 * turn "we cannot measure this" into "we measured this and it is neutral", which is
 * the exact substitution this engine exists to avoid.
 */

import { zScore, type FactorId } from '@forex-agent/core';

/** Which way an increase in the raw signal moves gold. */
export type FactorSign = 'DIRECT' | 'INVERSE';

export interface NormalisationConfig {
  readonly windowSize: number;
  readonly clampZ: number;
  readonly deadbandZ: number;
  readonly minObservations: number;
}

export interface NormalisedSignal {
  /** Signed −100…+100, sign already applied. */
  readonly score: number;
  /** The clamped, deadbanded z. Stored so the raw strength is auditable. */
  readonly zScore: number;
  /** The z before clamping, for the explanation template. */
  readonly rawZ: number;
  /** True when the deadband zeroed a real but small reading. */
  readonly inDeadband: boolean;
  /** True when the clamp bound an extreme reading. */
  readonly clamped: boolean;
}

export class NormalisationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalisationError';
  }
}

export function assertValidNormalisation(c: NormalisationConfig): void {
  if (!(c.clampZ > 0)) throw new NormalisationError(`clampZ must be positive, got ${String(c.clampZ)}`);
  if (c.deadbandZ < 0) {
    throw new NormalisationError(`deadbandZ must not be negative, got ${String(c.deadbandZ)}`);
  }
  if (c.deadbandZ >= c.clampZ) {
    // A deadband at or above the clamp swallows the entire usable range: every
    // reading would be zero and every factor would look permanently neutral.
    throw new NormalisationError(
      `deadbandZ (${String(c.deadbandZ)}) must be below clampZ (${String(c.clampZ)}), ` +
        'otherwise every signal falls inside the deadband and the factor is silently dead.',
    );
  }
  if (c.minObservations < 2) {
    throw new NormalisationError('minObservations must be at least 2 to have any variance');
  }
  if (c.windowSize < c.minObservations) {
    throw new NormalisationError(
      `windowSize (${String(c.windowSize)}) must be at least minObservations (${String(c.minObservations)})`,
    );
  }
}

/**
 * Normalise one signal against its trailing window.
 *
 * Returns `null` when no trustworthy z-score exists — the caller must abstain, not
 * substitute a zero.
 */
export function normaliseSignal(
  signal: number,
  history: readonly number[],
  sign: FactorSign,
  config: NormalisationConfig,
): NormalisedSignal | null {
  assertValidNormalisation(config);

  const window = history.slice(-config.windowSize);
  const raw = zScore(signal, window, { minObservations: config.minObservations });
  if (raw === null) return null;

  const clampedZ = Math.min(config.clampZ, Math.max(-config.clampZ, raw));
  const clamped = clampedZ !== raw;

  const inDeadband = Math.abs(clampedZ) < config.deadbandZ;
  const effectiveZ = inDeadband ? 0 : clampedZ;

  const magnitude = Math.min(1, Math.max(-1, effectiveZ / config.clampZ));
  const directed = sign === 'INVERSE' ? -magnitude : magnitude;

  return {
    score: directed * 100,
    zScore: effectiveZ,
    rawZ: raw,
    inDeadband,
    clamped,
  };
}

/**
 * Combine several normalised sub-signals into one factor score.
 *
 * Several factors read more than one thing — F1 takes a 5-day and a 20-day dollar
 * change, F7 takes VIX level and high-yield spread. Sub-signals are averaged with
 * their own weights *after* normalisation, so a series measured in index points and
 * one measured in percentage points combine on a common scale.
 *
 * Returns null if no sub-signal survived, so the factor abstains rather than
 * averaging over an empty set.
 */
export function combineSignals(
  parts: readonly { readonly signal: NormalisedSignal | null; readonly weight: number }[],
): NormalisedSignal | null {
  const usable = parts.filter(
    (p): p is { signal: NormalisedSignal; weight: number } => p.signal !== null && p.weight > 0,
  );
  if (usable.length === 0) return null;

  const totalWeight = usable.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return null;

  const score = usable.reduce((s, p) => s + p.signal.score * p.weight, 0) / totalWeight;
  const z = usable.reduce((s, p) => s + p.signal.zScore * p.weight, 0) / totalWeight;
  const rawZ = usable.reduce((s, p) => s + p.signal.rawZ * p.weight, 0) / totalWeight;

  return {
    score,
    zScore: z,
    rawZ,
    // Deadbanded only if every contributing part was.
    inDeadband: usable.every((p) => p.signal.inDeadband),
    clamped: usable.some((p) => p.signal.clamped),
  };
}

/** Fraction of a factor's required inputs that resolved (PRD_V1 §8.5.4). */
export function inputCompleteness(resolved: number, required: number): number {
  if (required <= 0) return 0;
  return Math.min(1, Math.max(0, resolved / required));
}

/** Direction label for the factor record (master §12). */
export function directionOf(score: number): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (score > 0) return 'BULLISH';
  if (score < 0) return 'BEARISH';
  return 'NEUTRAL';
}

/** Factor ids in display order, so the UI and the email agree. */
export const FACTOR_ORDER: readonly FactorId[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'];
