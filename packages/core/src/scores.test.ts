import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BIAS_BANDS,
  SCORE_DESCRIPTIVE_CAVEAT,
  ScoreRangeError,
  assertBandsCoverRange,
  capConfidence,
  classifyConfidence,
  classifyDisplayScore,
  classifySignedScore,
  clampSigned,
  toDisplayScore,
  toSignedScore,
  type BiasBand,
} from './scores.js';

describe('score scale conversion', () => {
  it('maps the signed range onto the display range', () => {
    expect(toDisplayScore(-100)).toBe(0);
    expect(toDisplayScore(0)).toBe(50);
    expect(toDisplayScore(100)).toBe(100);
  });

  it('round-trips within rounding tolerance', () => {
    for (const signed of [-100, -73, -1, 0, 1, 42, 99, 100]) {
      expect(Math.abs(toSignedScore(toDisplayScore(signed)) - signed)).toBeLessThanOrEqual(1);
    }
  });

  it('rejects out-of-range values instead of silently clamping', () => {
    // Silent clamping would hide an engine bug; a thrown error surfaces it.
    expect(() => toDisplayScore(101)).toThrow(ScoreRangeError);
    expect(() => toDisplayScore(-101)).toThrow(ScoreRangeError);
    expect(() => toSignedScore(101)).toThrow(ScoreRangeError);
  });

  it('rejects non-finite values', () => {
    expect(() => toDisplayScore(Number.NaN)).toThrow(ScoreRangeError);
    expect(() => toDisplayScore(Number.POSITIVE_INFINITY)).toThrow(ScoreRangeError);
  });

  it('clamps explicitly when asked', () => {
    expect(clampSigned(150)).toBe(100);
    expect(clampSigned(-150)).toBe(-100);
    expect(clampSigned(37)).toBe(37);
  });
});

describe('bias bands', () => {
  it('classifies the documented examples from the master PRD', () => {
    expect(classifyDisplayScore(78).label).toBe('Strong Bullish');
    expect(classifyDisplayScore(58).label).toBe('Neutral');
    expect(classifyDisplayScore(41).label).toBe('Bearish');
  });

  it('classifies every boundary on the correct side', () => {
    expect(classifyDisplayScore(90).label).toBe('Extremely Bullish');
    expect(classifyDisplayScore(89).label).toBe('Strong Bullish');
    expect(classifyDisplayScore(75).label).toBe('Strong Bullish');
    expect(classifyDisplayScore(74).label).toBe('Bullish');
    expect(classifyDisplayScore(60).label).toBe('Bullish');
    expect(classifyDisplayScore(59).label).toBe('Neutral');
    expect(classifyDisplayScore(45).label).toBe('Neutral');
    expect(classifyDisplayScore(44).label).toBe('Bearish');
    expect(classifyDisplayScore(30).label).toBe('Bearish');
    expect(classifyDisplayScore(29).label).toBe('Strong Bearish');
    expect(classifyDisplayScore(15).label).toBe('Strong Bearish');
    expect(classifyDisplayScore(14).label).toBe('Extremely Bearish');
    expect(classifyDisplayScore(0).label).toBe('Extremely Bearish');
  });

  it('classifies from the signed scale consistently', () => {
    // Signed 0 is neutral, which must land in the Neutral band at display 50.
    expect(classifySignedScore(0).bias).toBe('NEUTRAL');
    expect(classifySignedScore(60).bias).toBe('BULLISH');
    expect(classifySignedScore(-60).bias).toBe('BEARISH');
  });

  it('accepts the shipped default bands as a complete tiling', () => {
    expect(() => assertBandsCoverRange(DEFAULT_BIAS_BANDS)).not.toThrow();
  });

  it('rejects a band configuration with a gap', () => {
    // Configuration is user-editable, so a bad edit must fail loudly at load time
    // rather than throw later on one unlucky score.
    const gapped: BiasBand[] = [
      { label: 'Low', min: 0, max: 40, bias: 'BEARISH' },
      { label: 'High', min: 50, max: 100, bias: 'BULLISH' },
    ];
    expect(() => assertBandsCoverRange(gapped)).toThrow(ScoreRangeError);
  });

  it('rejects bands that do not reach the ends of the range', () => {
    expect(() =>
      assertBandsCoverRange([{ label: 'Mid', min: 10, max: 90, bias: 'NEUTRAL' }]),
    ).toThrow(ScoreRangeError);
  });

  it('rejects an overlapping band configuration', () => {
    const overlapping: BiasBand[] = [
      { label: 'Low', min: 0, max: 60, bias: 'BEARISH' },
      { label: 'High', min: 50, max: 100, bias: 'BULLISH' },
    ];
    expect(() => assertBandsCoverRange(overlapping)).toThrow(ScoreRangeError);
  });
});

describe('confidence', () => {
  it('classifies against the default thresholds', () => {
    expect(classifyConfidence(85)).toBe('HIGH');
    expect(classifyConfidence(70)).toBe('HIGH');
    expect(classifyConfidence(69)).toBe('MEDIUM');
    expect(classifyConfidence(45)).toBe('MEDIUM');
    expect(classifyConfidence(44)).toBe('LOW');
  });

  it('caps without ever raising', () => {
    // Caps exist to lower confidence near event risk; a cap must never promote.
    expect(capConfidence('HIGH', 'MEDIUM')).toBe('MEDIUM');
    expect(capConfidence('LOW', 'MEDIUM')).toBe('LOW');
    expect(capConfidence('LOW', 'HIGH')).toBe('LOW');
    expect(capConfidence('HIGH', 'HIGH')).toBe('HIGH');
  });
});

describe('Amendment A3', () => {
  it('states that the score is descriptive, not predictive', () => {
    expect(SCORE_DESCRIPTIVE_CAVEAT).toContain('Not a forecast');
  });

  it('keeps the caveat free of forecast vocabulary', () => {
    // The caveat itself must not undermine its own claim.
    const forbidden = ['will rise', 'will fall', 'expect', 'target', 'probability'];
    for (const phrase of forbidden) {
      expect(SCORE_DESCRIPTIVE_CAVEAT.toLowerCase()).not.toContain(phrase);
    }
  });
});
