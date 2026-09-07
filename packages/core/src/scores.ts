/**
 * Score scales and bias bands.
 *
 * The master PRD uses two scales: 12 defines the fundamental score as -100..+100,
 * while 17, 19 and 31 display 0..100. Rather than convert ad hoc at each call site —
 * which is how a sign error eventually ships — the signed scale is canonical
 * internally (direction is intrinsic to it) and the display transform lives here,
 * in exactly one place.
 */

import type { Bias, ConfidenceLevel } from './vocab.js';

export const SIGNED_MIN = -100;
export const SIGNED_MAX = 100;
export const DISPLAY_MIN = 0;
export const DISPLAY_MAX = 100;

export class ScoreRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoreRangeError';
  }
}

export function assertSignedScore(v: number): void {
  if (!Number.isFinite(v) || v < SIGNED_MIN || v > SIGNED_MAX) {
    throw new ScoreRangeError(`Signed score must be a finite number in [-100, 100], got ${String(v)}`);
  }
}

export function assertDisplayScore(v: number): void {
  if (!Number.isFinite(v) || v < DISPLAY_MIN || v > DISPLAY_MAX) {
    throw new ScoreRangeError(`Display score must be a finite number in [0, 100], got ${String(v)}`);
  }
}

export function clampSigned(v: number): number {
  if (!Number.isFinite(v)) throw new ScoreRangeError(`Cannot clamp non-finite value ${String(v)}`);
  return Math.min(SIGNED_MAX, Math.max(SIGNED_MIN, v));
}

/** -100..+100 to 0..100. Rounded for display; the signed value stays authoritative. */
export function toDisplayScore(signed: number): number {
  assertSignedScore(signed);
  return Math.round((signed + 100) / 2);
}

/**
 * 0..100 back to -100..+100. Not an exact inverse of `toDisplayScore` because that
 * rounds; round-tripping a signed score returns a value within 1 unit.
 */
export function toSignedScore(display: number): number {
  assertDisplayScore(display);
  return display * 2 - 100;
}

// ── Bias bands (master PRD 17), expressed on the display scale ──────────────

export interface BiasBand {
  readonly label: string;
  /** Inclusive lower bound on the 0..100 display scale. */
  readonly min: number;
  /** Inclusive upper bound. */
  readonly max: number;
  readonly bias: Bias;
}

/** Ordered high to low. Thresholds are configurable; these are the defaults. */
export const DEFAULT_BIAS_BANDS: readonly BiasBand[] = [
  { label: 'Extremely Bullish', min: 90, max: 100, bias: 'BULLISH' },
  { label: 'Strong Bullish', min: 75, max: 89, bias: 'BULLISH' },
  { label: 'Bullish', min: 60, max: 74, bias: 'BULLISH' },
  { label: 'Neutral', min: 45, max: 59, bias: 'NEUTRAL' },
  { label: 'Bearish', min: 30, max: 44, bias: 'BEARISH' },
  { label: 'Strong Bearish', min: 15, max: 29, bias: 'BEARISH' },
  { label: 'Extremely Bearish', min: 0, max: 14, bias: 'BEARISH' },
];

export function classifyDisplayScore(
  display: number,
  bands: readonly BiasBand[] = DEFAULT_BIAS_BANDS,
): BiasBand {
  assertDisplayScore(display);
  const rounded = Math.round(display);
  const band = bands.find((b) => rounded >= b.min && rounded <= b.max);
  if (band === undefined) {
    throw new ScoreRangeError(
      `No bias band covers display score ${String(rounded)} — band configuration has a gap`,
    );
  }
  return band;
}

export function classifySignedScore(
  signed: number,
  bands: readonly BiasBand[] = DEFAULT_BIAS_BANDS,
): BiasBand {
  return classifyDisplayScore(toDisplayScore(signed), bands);
}

/** Validate at config-load time that bands tile 0..100 with no gap or overlap. */
export function assertBandsCoverRange(bands: readonly BiasBand[]): void {
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  if (sorted.length === 0) throw new ScoreRangeError('Bias bands must not be empty');
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    throw new ScoreRangeError('Bias bands must not be empty');
  }
  if (first.min !== DISPLAY_MIN) {
    throw new ScoreRangeError(`Bias bands must start at 0, start at ${String(first.min)}`);
  }
  if (last.max !== DISPLAY_MAX) {
    throw new ScoreRangeError(`Bias bands must end at 100, end at ${String(last.max)}`);
  }
  for (let i = 0; i < sorted.length; i += 1) {
    const band = sorted[i];
    if (band === undefined) continue;
    if (band.min > band.max) {
      throw new ScoreRangeError(`Bias band "${band.label}" has min above max`);
    }
    const next = sorted[i + 1];
    if (next !== undefined && next.min !== band.max + 1) {
      throw new ScoreRangeError(
        `Bias bands must tile without gaps or overlap: "${band.label}" ends at ${String(
          band.max,
        )} but "${next.label}" starts at ${String(next.min)}`,
      );
    }
  }
}

// ── Confidence (master PRD 21) ──────────────────────────────────────────────

export interface ConfidenceThresholds {
  /** Inclusive floor for HIGH. */
  readonly high: number;
  /** Inclusive floor for MEDIUM. */
  readonly medium: number;
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = { high: 70, medium: 45 };

export function classifyConfidence(
  value: number,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS,
): ConfidenceLevel {
  assertDisplayScore(value);
  if (value >= thresholds.high) return 'HIGH';
  if (value >= thresholds.medium) return 'MEDIUM';
  return 'LOW';
}

/** Apply a cap, e.g. imminent high-impact event limits confidence to MEDIUM. */
export function capConfidence(level: ConfidenceLevel, cap: ConfidenceLevel): ConfidenceLevel {
  const rank: Record<ConfidenceLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  return rank[level] <= rank[cap] ? level : cap;
}

// ── Amendment A3 ────────────────────────────────────────────────────────────

/**
 * The caveat that must accompany every rendered score.
 *
 * It lives in core rather than in a UI file because it is a property of what a score
 * *is*, not a piece of presentation. A score summarises conditions that currently
 * hold; nothing in this system has yet measured whether those conditions predict
 * price, and until V6 supplies walk-forward out-of-sample evidence, the product must
 * not sound as though they do.
 */
export const SCORE_DESCRIPTIVE_CAVEAT =
  'Describes current conditions. Not a forecast of price movement.';

/** Longer form for emails and report headers, where there is room to be explicit. */
export const SCORE_DESCRIPTIVE_CAVEAT_LONG =
  'This score describes market conditions as measured now. It is not a prediction of ' +
  'future price movement, and no claim is made about its historical accuracy.';
