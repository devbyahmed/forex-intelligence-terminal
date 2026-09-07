/**
 * Normalisation (PRD_V1 §8.5.3).
 *
 * The load-bearing test here is the last group: a signal that cannot be standardised
 * returns `null` so the factor abstains, and never a zero. Zero means "measured, and
 * neutral"; null means "not measured". Collapsing the second into the first is
 * invisible in the output and changes the score.
 */

import { describe, expect, it } from 'vitest';
import {
  assertValidNormalisation,
  combineSignals,
  directionOf,
  inputCompleteness,
  normaliseSignal,
  NormalisationError,
  type NormalisationConfig,
} from './normalise.js';

/** The shipped defaults (PRD_V1 §8.5.3). */
const CONFIG: NormalisationConfig = {
  windowSize: 252,
  clampZ: 3,
  deadbandZ: 0.25,
  minObservations: 30,
};

/** A history with mean 0 and standard deviation 1, so z equals the input. */
const UNIT_HISTORY: readonly number[] = (() => {
  // 40 points, symmetric around zero, sd normalised to exactly 1.
  const raw = Array.from({ length: 40 }, (_, i) => i - 19.5);
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  const sd = Math.sqrt(raw.reduce((a, b) => a + (b - mean) ** 2, 0) / raw.length);
  return raw.map((v) => (v - mean) / sd);
})();

describe('normaliseSignal', () => {
  it('maps a +3 sigma signal to the top of the scale', () => {
    const r = normaliseSignal(3, UNIT_HISTORY, 'DIRECT', CONFIG);
    expect(r?.score).toBeCloseTo(100, 6);
  });

  it('inverts the sign for an inverse factor', () => {
    // A stronger dollar is bearish for gold, so a positive dollar signal must produce
    // a negative gold score. Getting this backwards would invert the whole product.
    const r = normaliseSignal(3, UNIT_HISTORY, 'INVERSE', CONFIG);
    expect(r?.score).toBeCloseTo(-100, 6);
  });

  it('scales linearly between the deadband and the clamp', () => {
    const r = normaliseSignal(1.5, UNIT_HISTORY, 'DIRECT', CONFIG);
    expect(r?.score).toBeCloseTo(50, 6);
  });

  it('clamps beyond ±3 sigma and says it clamped', () => {
    // A single six-sigma series must not be able to pin the whole score.
    const r = normaliseSignal(6, UNIT_HISTORY, 'DIRECT', CONFIG);
    expect(r?.score).toBeCloseTo(100, 6);
    expect(r?.clamped).toBe(true);
    expect(r?.rawZ).toBeCloseTo(6, 6);
  });

  it('zeroes a signal inside the deadband and marks it', () => {
    // A real measurement that says "nothing much is happening" — distinct from an
    // abstention, and the flag is what lets the UI say which it was.
    const r = normaliseSignal(0.2, UNIT_HISTORY, 'DIRECT', CONFIG);
    expect(r?.score).toBe(0);
    expect(r?.inDeadband).toBe(true);
    expect(r?.rawZ).toBeCloseTo(0.2, 6);
  });

  it('passes a signal just outside the deadband', () => {
    const r = normaliseSignal(0.3, UNIT_HISTORY, 'DIRECT', CONFIG);
    expect(r?.inDeadband).toBe(false);
    expect(r?.score).toBeCloseTo(10, 6);
  });

  it('never exceeds the signed scale in either direction', () => {
    for (const signal of [-50, -6, -3, 0, 3, 6, 50]) {
      const r = normaliseSignal(signal, UNIT_HISTORY, 'DIRECT', CONFIG);
      expect(r?.score).toBeGreaterThanOrEqual(-100);
      expect(r?.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('a signal that cannot be standardised abstains rather than scoring zero', () => {
  it('returns null when history is shorter than minObservations', () => {
    // 29 points against a minimum of 30. A z-score from too few points is a number
    // with no meaning, and the engine cannot tell one from a meaningful one.
    const short = UNIT_HISTORY.slice(0, 29);
    expect(normaliseSignal(1, short, 'DIRECT', CONFIG)).toBeNull();
  });

  it('returns null for a flat history rather than a colossal z', () => {
    // The 2.9e16 case: identical values give a variance around 1e-35, not 0, so the
    // quotient is finite, enormous, and meaningless.
    const flat = Array.from({ length: 40 }, () => 4.67);
    expect(normaliseSignal(4.7, flat, 'DIRECT', CONFIG)).toBeNull();
  });

  it('returns null, not zero — the distinction the whole engine rests on', () => {
    const flat = Array.from({ length: 40 }, () => 0.1);
    const result = normaliseSignal(0.5, flat, 'DIRECT', CONFIG);
    expect(result).toBeNull();
    expect(result).not.toEqual({ score: 0 });
  });

  it('returns null for a non-finite signal', () => {
    expect(normaliseSignal(Number.NaN, UNIT_HISTORY, 'DIRECT', CONFIG)).toBeNull();
    expect(normaliseSignal(Number.POSITIVE_INFINITY, UNIT_HISTORY, 'DIRECT', CONFIG)).toBeNull();
  });

  it('ignores non-finite history points instead of poisoning the mean', () => {
    const poisoned = [...UNIT_HISTORY, Number.NaN];
    const r = normaliseSignal(1.5, poisoned, 'DIRECT', CONFIG);
    expect(r).not.toBeNull();
    expect(Number.isFinite(r?.score ?? Number.NaN)).toBe(true);
  });

  it('only looks at the trailing window', () => {
    // An old regime must not keep influencing the baseline for ever.
    const config = { ...CONFIG, windowSize: 40 };
    const ancient = Array.from({ length: 500 }, () => 1000);
    const recent = [...ancient, ...UNIT_HISTORY];
    const r = normaliseSignal(1.5, recent, 'DIRECT', config);
    expect(r?.score).toBeCloseTo(50, 6);
  });
});

describe('configuration validation', () => {
  it('rejects a deadband at or above the clamp', () => {
    // Every signal would fall inside the deadband, so every factor would read neutral
    // for ever — a silently dead engine that still publishes numbers.
    expect(() => assertValidNormalisation({ ...CONFIG, deadbandZ: 3 })).toThrow(NormalisationError);
    expect(() => assertValidNormalisation({ ...CONFIG, deadbandZ: 4 })).toThrow(/silently dead/);
  });

  it('rejects a non-positive clamp', () => {
    expect(() => assertValidNormalisation({ ...CONFIG, clampZ: 0 })).toThrow(NormalisationError);
  });

  it('rejects a window smaller than the observation minimum', () => {
    expect(() => assertValidNormalisation({ ...CONFIG, windowSize: 10 })).toThrow(
      NormalisationError,
    );
  });
});

describe('combineSignals', () => {
  const sig = (score: number) => ({ score, zScore: score / 33.3, rawZ: score / 33.3, inDeadband: false, clamped: false });

  it('weights sub-signals after normalisation, not before', () => {
    // F1's 5-day and 20-day dollar changes are both index points, but F7 combines VIX
    // levels with credit spreads. Only post-normalisation averaging is meaningful.
    const r = combineSignals([
      { signal: sig(100), weight: 0.5 },
      { signal: sig(0), weight: 0.5 },
    ]);
    expect(r?.score).toBeCloseTo(50, 6);
  });

  it('drops missing sub-signals and re-weights the rest', () => {
    const r = combineSignals([
      { signal: sig(60), weight: 0.5 },
      { signal: null, weight: 0.5 },
    ]);
    // Not 30: the surviving sub-signal is not diluted by the missing one, for the
    // same reason an abstaining factor does not dilute the aggregate.
    expect(r?.score).toBeCloseTo(60, 6);
  });

  it('returns null when every sub-signal is missing', () => {
    expect(combineSignals([{ signal: null, weight: 1 }])).toBeNull();
    expect(combineSignals([])).toBeNull();
  });

  it('is in the deadband only when every part is', () => {
    const dead = { ...sig(0), inDeadband: true };
    expect(combineSignals([{ signal: dead, weight: 1 }])?.inDeadband).toBe(true);
    expect(
      combineSignals([
        { signal: dead, weight: 0.5 },
        { signal: sig(50), weight: 0.5 },
      ])?.inDeadband,
    ).toBe(false);
  });
});

describe('inputCompleteness and directionOf', () => {
  it('reports the resolved fraction', () => {
    expect(inputCompleteness(2, 4)).toBe(0.5);
    expect(inputCompleteness(4, 4)).toBe(1);
    expect(inputCompleteness(0, 4)).toBe(0);
  });

  it('treats zero required inputs as zero completeness, not full', () => {
    // A factor that requires nothing has resolved nothing; calling that "complete"
    // would hand it full confidence on no evidence.
    expect(inputCompleteness(0, 0)).toBe(0);
  });

  it('labels direction from the sign of the score', () => {
    expect(directionOf(10)).toBe('BULLISH');
    expect(directionOf(-10)).toBe('BEARISH');
    expect(directionOf(0)).toBe('NEUTRAL');
  });
});
