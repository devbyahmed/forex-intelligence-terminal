/**
 * The contract's invariants.
 *
 * These are the same guarantees the engine and the database each make, asserted a
 * third time at the boundary the user actually sees. That repetition is deliberate:
 * the engine protects the calculation, the database protects what is stored, and this
 * protects what is rendered. A payload is the last place a bad value can be stopped
 * before it becomes a number on a screen that someone believes.
 */

import { describe, expect, it } from 'vitest';
import {
  analysisResponseSchema,
  factorSchema,
  isScoredAnalysis,
  provenancedValueSchema,
  type AnalysisResponse,
} from './analysis.js';

const provenance = {
  factTable: 'macro_observations',
  factId: '01a05a17-0000-7000-8000-000000000000',
  sourceName: 'Federal Reserve Economic Data',
  sourceTier: 1 as const,
  sourceUrl: 'https://fred.stlouisfed.org/series/DGS10',
  publishedAt: '2026-08-28T20:16:00.000Z',
  retrievedAt: '2026-08-31T23:00:00.000Z',
  freshness: 'LIVE' as const,
  publicationLagDays: null,
};

const scoredFactor = {
  kind: 'SCORED' as const,
  factorId: 'F2',
  factorName: 'Real 10-year yield',
  weight: 0.18,
  explanation: 'Real 10-year yield reads -27.7 on the −100…+100 scale.',
  freshness: 'LIVE' as const,
  provenance: [provenance],
  score: -27.7,
  direction: 'BEARISH' as const,
  zScore: 0.83,
  effectiveWeight: 0.18,
  confidence: 1,
  inputCompleteness: 1,
  limitations: [],
};

const abstainedFactor = {
  kind: 'ABSTAINED' as const,
  factorId: 'F8',
  factorName: 'Geopolitical and policy news pressure',
  weight: 0.1,
  explanation: 'Not scored: 6 relevant articles from 3 sources.',
  freshness: 'UNAVAILABLE' as const,
  provenance: [],
  reason: 'BELOW_VOLUME_THRESHOLD',
  detail: '6 articles from 3 sources, below the 10-article minimum',
  attribution: 'WORLD' as const,
};

const eightFactors = [
  scoredFactor,
  { ...scoredFactor, factorId: 'F1' },
  { ...scoredFactor, factorId: 'F3' },
  { ...scoredFactor, factorId: 'F4' },
  { ...scoredFactor, factorId: 'F5' },
  { ...scoredFactor, factorId: 'F6' },
  { ...scoredFactor, factorId: 'F7' },
  abstainedFactor,
];

const scoredAnalysis: AnalysisResponse = {
  status: 'SCORED',
  id: 'analysis-1',
  asset: 'XAUUSD',
  runAt: '2026-08-31T23:11:09.946Z',
  coverage: 0.815,
  factors: eightFactors,
  statements: [],
  eventRisk: [],
  unavailableInputs: ['F8: BELOW_VOLUME_THRESHOLD'],
  degradedProviders: [],
  score: {
    signed: -14.6,
    display: 43,
    band: 'Bearish',
    bias: 'BEARISH',
    caveat: 'This score describes current measured conditions, not a forecast.',
  },
  confidence: {
    value: 88,
    level: 'HIGH',
    uncappedLevel: 'HIGH',
    caps: [],
    components: { coverage: 0.326, sourceQuality: 0.15, agreement: 0.24, freshness: 0.147 },
  },
  aiAssessment: null,
};

describe('no value renders without provenance', () => {
  it('requires provenance on every rendered figure', () => {
    // Not optional, not nullable. The moment it is either, a renderer gains a branch
    // for "value without source" and the invariant becomes a convention.
    const withoutProvenance = { label: 'DGS10', value: 4.73, unit: 'percent' };
    expect(provenancedValueSchema.safeParse(withoutProvenance).success).toBe(false);
  });

  it('accepts a null value with provenance — an absence is still attributable', () => {
    // FRED writes '.' for a period with no figure. That gap has a source and a
    // retrieval time like any other fact, and rendering it as "no value published"
    // is honest; dropping it would hide that we looked.
    expect(
      provenancedValueSchema.safeParse({
        label: 'DGS10',
        value: null,
        unit: 'percent',
        provenance,
      }).success,
    ).toBe(true);
  });

  it('rejects a source tier outside 1..4', () => {
    expect(
      provenancedValueSchema.safeParse({
        label: 'x',
        value: 1,
        unit: '',
        provenance: { ...provenance, sourceTier: 5 },
      }).success,
    ).toBe(false);
  });
});

describe('no score renders without its caveat', () => {
  it('accepts a score carrying the A3 caveat', () => {
    expect(analysisResponseSchema.safeParse(scoredAnalysis).success).toBe(true);
  });

  it('rejects a score with the caveat omitted', () => {
    // A caveat the UI is *supposed* to add goes missing in the second component that
    // renders a score. A caveat inside the score object cannot.
    const { caveat: _caveat, ...scoreWithoutCaveat } = scoredAnalysis.score;
    const payload = { ...scoredAnalysis, score: scoreWithoutCaveat };
    expect(analysisResponseSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects an empty caveat, which would render as nothing at all', () => {
    const payload = { ...scoredAnalysis, score: { ...scoredAnalysis.score, caveat: '' } };
    expect(analysisResponseSchema.safeParse(payload).success).toBe(false);
  });
});

describe('an insufficient analysis has no score to render', () => {
  const insufficient = {
    status: 'INSUFFICIENT_DATA' as const,
    id: 'analysis-2',
    asset: 'XAUUSD',
    runAt: '2026-08-31T23:11:09.946Z',
    coverage: 0.39,
    factors: eightFactors,
    statements: [],
    eventRisk: [],
    unavailableInputs: ['F1', 'F2', 'F4'],
    degradedProviders: [],
    reason: 'Factor coverage 39% is below the 50% minimum.',
  };

  it('parses without a score key', () => {
    expect(analysisResponseSchema.safeParse(insufficient).success).toBe(true);
  });

  it('narrows so a component cannot read a score off it', () => {
    const parsed = analysisResponseSchema.parse(insufficient);
    expect(isScoredAnalysis(parsed)).toBe(false);
    // `parsed.score` is not merely null here — the property does not exist on the
    // narrowed type, so `score ?? 0` is a compile error rather than a silent zero.
    expect(parsed).not.toHaveProperty('score');
  });

  it('strips a score if one is smuggled in', () => {
    // Zod's default is to strip unknown keys, so a server bug that attaches a score
    // to an insufficient run cannot deliver it to the client.
    const smuggled = { ...insufficient, score: { signed: -14.6, display: 43 } };
    const parsed = analysisResponseSchema.parse(smuggled);
    expect(parsed).not.toHaveProperty('score');
  });
});

describe('a factor is one shape or the other, never both', () => {
  it('rejects a scored factor carrying an abstention reason', () => {
    const both = { ...scoredFactor, reason: 'INPUT_UNAVAILABLE', attribution: 'WORLD' };
    const parsed = factorSchema.parse(both);
    // The discriminated union keeps only the SCORED fields, so the abstention reason
    // cannot reach a renderer that might show both.
    expect(parsed).not.toHaveProperty('reason');
  });

  it('rejects an abstained factor carrying a score', () => {
    const both = { ...abstainedFactor, score: -27.7 };
    const parsed = factorSchema.parse(both);
    expect(parsed).not.toHaveProperty('score');
  });

  it('requires an attribution on every abstention', () => {
    const { attribution: _a, ...withoutAttribution } = abstainedFactor;
    expect(factorSchema.safeParse(withoutAttribution).success).toBe(false);
  });

  it('rejects an attribution outside the three categories', () => {
    expect(
      factorSchema.safeParse({ ...abstainedFactor, attribution: 'UNKNOWN' }).success,
    ).toBe(false);
  });

  it('requires all eight factors, so a dropped one cannot go unnoticed', () => {
    // Rendering seven factors and calling it the model is how an incomplete picture
    // becomes an unqualified one.
    const seven = { ...scoredAnalysis, factors: eightFactors.slice(0, 7) };
    expect(analysisResponseSchema.safeParse(seven).success).toBe(false);
  });
});

describe('score bounds', () => {
  it('rejects a signed score outside −100..100', () => {
    const payload = { ...scoredAnalysis, score: { ...scoredAnalysis.score, signed: 140 } };
    expect(analysisResponseSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a coverage above 1', () => {
    expect(analysisResponseSchema.safeParse({ ...scoredAnalysis, coverage: 1.4 }).success).toBe(
      false,
    );
  });
});
