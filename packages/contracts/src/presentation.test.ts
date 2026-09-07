/**
 * Presentation rules.
 *
 * The dashboard is the last place Amendment A3 can fail, and it fails differently
 * here than anywhere else: not through a forbidden word, but through visual grammar.
 * A big arrow, a red/green gauge, a number in hero type — each says "it is going this
 * way" without writing a single sentence a guard could catch.
 *
 * These tests pin the rules that keep the panel a measurement instrument.
 */

import { describe, expect, it } from 'vitest';
import {
  LAG_DISCLOSURE_THRESHOLD_DAYS,
  PROHIBITED_SCORE_FORMS,
  PresentationError,
  assertMeasurementGrammar,
  buildFreshnessBadge,
  buildGapGroups,
  buildLayerBlocks,
  buildScoreBlock,
  coverageSentence,
  gapWeight,
  orderedFactors,
  requiresLagDisclosure,
} from './presentation.js';
import type { AnalysisResponse, FactorView, Provenance } from './analysis.js';

const provenance: Provenance = {
  factTable: 'macro_observations',
  factId: 'fact-1',
  sourceName: 'Federal Reserve Economic Data',
  sourceTier: 1,
  sourceUrl: 'https://fred.stlouisfed.org/series/DGS10',
  publishedAt: '2026-08-28T20:16:00.000Z',
  retrievedAt: '2026-08-31T23:00:00.000Z',
  freshness: 'LIVE',
  publicationLagDays: null,
};

const scored = (id: string, over: Partial<Extract<FactorView, { kind: 'SCORED' }>> = {}): FactorView => ({
  kind: 'SCORED',
  factorId: id,
  factorName: `Factor ${id}`,
  weight: 0.1,
  explanation: `Factor ${id} reads -10.`,
  freshness: 'LIVE',
  provenance: [provenance],
  score: -10,
  direction: 'BEARISH',
  zScore: -0.3,
  effectiveWeight: 0.1,
  confidence: 1,
  inputCompleteness: 1,
  limitations: [],
  ...over,
});

const abstained = (id: string, attribution: 'WORLD' | 'CONFIGURATION' | 'STRUCTURAL'): FactorView => ({
  kind: 'ABSTAINED',
  factorId: id,
  factorName: `Factor ${id}`,
  weight: 0.1,
  explanation: `Factor ${id} is not scored.`,
  freshness: 'UNAVAILABLE',
  provenance: [],
  reason: 'BELOW_VOLUME_THRESHOLD',
  detail: '6 articles from 3 sources, below the 10-article minimum',
  attribution,
});

const analysis = (over: Partial<AnalysisResponse> = {}): AnalysisResponse =>
  ({
    status: 'SCORED',
    id: 'a1',
    asset: 'XAUUSD',
    runAt: '2026-08-31T23:11:09.946Z',
    coverage: 0.815,
    factors: [
      scored('F1'),
      scored('F2'),
      scored('F3'),
      scored('F4'),
      scored('F5'),
      scored('F6'),
      scored('F7'),
      abstained('F8', 'WORLD'),
    ],
    statements: [],
    eventRisk: [],
    unavailableInputs: [],
    degradedProviders: [],
    score: {
      signed: -14.6,
      display: 43,
      band: 'Bearish',
      bias: 'BEARISH',
      caveat: 'This score describes current measured conditions, not a forecast.',
    },
    confidence: { value: 88, level: 'HIGH', uncappedLevel: 'HIGH', caps: [], components: {} },
    aiAssessment: null,
    ...over,
  }) as AnalysisResponse;

describe('the panel reads as a measurement, not a signal', () => {
  it('rejects every presentation form that implies a forecast', () => {
    // Each of these predicts without writing a sentence a text guard could catch.
    for (const form of PROHIBITED_SCORE_FORMS) {
      expect(() => assertMeasurementGrammar(form)).toThrow(PresentationError);
    }
  });

  it('names the arrow, the traffic light and the hero numeral explicitly', () => {
    // "Do not make it look like a signal" is not a reviewable instruction. This is.
    expect(PROHIBITED_SCORE_FORMS).toContain('DIRECTIONAL_ARROW');
    expect(PROHIBITED_SCORE_FORMS).toContain('TRAFFIC_LIGHT');
    expect(PROHIBITED_SCORE_FORMS).toContain('HERO_NUMERAL');
    expect(PROHIBITED_SCORE_FORMS).toContain('GAUGE_NEEDLE');
  });

  it('explains why a prohibited form is prohibited', () => {
    try {
      assertMeasurementGrammar('DIRECTIONAL_ARROW');
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('no measured predictive power');
      expect(message).toContain('Amendment A3');
      expect(message).toContain('BIDIRECTIONAL_SCALE');
    }
  });

  it('rejects an unknown form rather than silently permitting it', () => {
    // A new component inventing its own presentation must justify it here first.
    expect(() => assertMeasurementGrammar('RADIAL_DIAL')).toThrow(/Unknown score presentation/);
  });

  it('renders the score on a bidirectional scale', () => {
    const block = buildScoreBlock(analysis());
    expect(block?.form).toBe('BIDIRECTIONAL_SCALE');
    expect(block?.bidirectional).toBe(true);
  });

  it('labels the reading in the present tense, not as a verdict', () => {
    // "Bearish" alone reads as a call. "Conditions read bearish" is a measurement.
    const block = buildScoreBlock(analysis());
    expect(block?.readingLabel).toBe('Conditions read bearish');
    expect(block?.readingLabel).not.toMatch(/signal|outlook|call/i);
  });
});

describe('the caveat travels with the score', () => {
  it('is part of the score block, not a separate concern', () => {
    // Not a tooltip: a tooltip is a caveat you have to already suspect. Not a footer:
    // a footer is a caveat below the fold.
    const block = buildScoreBlock(analysis());
    expect(block?.caveat).toContain('not a forecast');
  });

  it('cannot be rendered without it, because it comes from the payload', () => {
    const block = buildScoreBlock(analysis());
    expect(Object.keys(block ?? {})).toContain('caveat');
  });

  it('returns no block at all for an insufficient run', () => {
    // There is no score, so there is nothing to caveat and nothing to render.
    const insufficient = analysis({
      status: 'INSUFFICIENT_DATA',
      reason: 'Factor coverage 39% is below the 50% minimum.',
    });
    expect(buildScoreBlock(insufficient)).toBeNull();
  });
});

describe('freshness and lag sit at the point of the number', () => {
  it('adds a lag note beside the chip when publication lags materially', () => {
    // The Phase 5 case: F1 showed RECENT on a nine-day-old dollar index. True, and
    // practically misleading — a reader takes "recent" to mean recent.
    const badge = buildFreshnessBadge({ ...provenance, freshness: 'RECENT', publicationLagDays: 9 });
    expect(badge.label).toBe('Recent');
    expect(badge.lagNote).toBe('describes data from 9 days before publication');
  });

  it('omits the note when the lag is immaterial', () => {
    const badge = buildFreshnessBadge({ ...provenance, publicationLagDays: 1 });
    expect(badge.lagNote).toBeNull();
  });

  it('discloses at the threshold, not above it', () => {
    expect(requiresLagDisclosure({ ...provenance, publicationLagDays: LAG_DISCLOSURE_THRESHOLD_DAYS })).toBe(true);
    expect(requiresLagDisclosure({ ...provenance, publicationLagDays: LAG_DISCLOSURE_THRESHOLD_DAYS - 1 })).toBe(false);
  });

  it('carries the source and tier so attribution is one glance away', () => {
    const badge = buildFreshnessBadge(provenance);
    expect(badge.sourceName).toBe('Federal Reserve Economic Data');
    expect(badge.sourceTier).toBe(1);
  });
});

describe('gaps carry the same weight as scores', () => {
  it('groups by attribution', () => {
    const groups = buildGapGroups(analysis());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.attribution).toBe('WORLD');
    expect(groups[0]?.entries[0]?.factorId).toBe('F8');
  });

  it('distinguishes a dark factor from a half-lit one', () => {
    // The user should see at a glance that F8 is dark and F5 is half-lit. Those are
    // different states and collapsing them loses the distinction that matters.
    const withPartial = analysis({
      factors: [
        scored('F5', {
          inputCompleteness: 0.5,
          limitations: [
            {
              attribution: 'STRUCTURAL',
              missing: 'the rate channel',
              reason: 'historical consensus forecasts are not available from any free source',
              resolution: 'resolves once roughly twelve months of forecasts have accumulated',
            },
          ],
        }),
        scored('F1'),
        scored('F2'),
        scored('F3'),
        scored('F4'),
        scored('F6'),
        scored('F7'),
        abstained('F8', 'WORLD'),
      ],
    });

    const groups = buildGapGroups(withPartial);
    const structural = groups.find((g) => g.attribution === 'STRUCTURAL');
    const world = groups.find((g) => g.attribution === 'WORLD');

    expect(structural?.entries[0]).toMatchObject({ factorId: 'F5', extent: 'PARTIAL' });
    expect(world?.entries[0]).toMatchObject({ factorId: 'F8', extent: 'DARK' });
  });

  it('states the resolution condition for a structural gap', () => {
    const withPartial = analysis({
      factors: [
        scored('F5', {
          inputCompleteness: 0.5,
          limitations: [
            {
              attribution: 'STRUCTURAL',
              missing: 'the rate channel',
              reason: 'not available from any free source',
              resolution: 'resolves once roughly twelve months of forecasts have accumulated',
            },
          ],
        }),
        ...['F1', 'F2', 'F3', 'F4', 'F6', 'F7'].map((id) => scored(id)),
        abstained('F8', 'WORLD'),
      ],
    });
    const structural = buildGapGroups(withPartial).find((g) => g.attribution === 'STRUCTURAL');
    expect(structural?.entries[0]?.resolution).toContain('twelve months');
    // A known constraint with an end date, not a permanent unknown.
    expect(structural?.meaning).toContain('standing constraint');
  });

  it('marks a configuration gap as a defect, not a market condition', () => {
    const withDefect = analysis({
      factors: [
        abstained('F5', 'CONFIGURATION'),
        ...['F1', 'F2', 'F3', 'F4', 'F6', 'F7'].map((id) => scored(id)),
        abstained('F8', 'WORLD'),
      ],
    });
    const groups = buildGapGroups(withDefect);
    const defect = groups.find((g) => g.attribution === 'CONFIGURATION');

    expect(defect?.isDefect).toBe(true);
    expect(defect?.meaning).toContain('should never appear in production');
    // Listed first: it is the only category a reader must act on.
    expect(groups[0]?.attribution).toBe('CONFIGURATION');
  });

  it('does not mark world or structural gaps as defects', () => {
    const groups = buildGapGroups(analysis());
    expect(groups.every((g) => !g.isDefect)).toBe(true);
  });

  it('reports the share of weight that is dark or partial', () => {
    expect(gapWeight(analysis())).toBeCloseTo(0.1 / 0.8, 6);
  });

  it('counts a half-measured factor as half a gap', () => {
    const withPartial = analysis({
      factors: [
        scored('F5', { inputCompleteness: 0.5 }),
        ...['F1', 'F2', 'F3', 'F4', 'F6', 'F7'].map((id) => scored(id)),
        abstained('F8', 'WORLD'),
      ],
    });
    // F8 dark (0.1) plus half of F5 (0.05), over 0.8 total.
    expect(gapWeight(withPartial)).toBeCloseTo(0.15 / 0.8, 6);
  });

  it('keeps abstained factors in the main list, not a separate one', () => {
    // Two lists would let a reader take the first as "the factors" and miss the rest.
    const ids = orderedFactors(analysis()).map((f) => f.factorId);
    expect(ids).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8']);
  });
});

describe('coverage is stated as something a reader can picture', () => {
  it('counts factors rather than quoting a percentage', () => {
    // "81.5% coverage" is a number that sounds like a score.
    expect(coverageSentence(analysis())).toBe('Seven of 8 factors produced a reading.');
  });

  it('names partly-measured factors separately from dark ones', () => {
    const withPartial = analysis({
      factors: [
        scored('F5', {
          inputCompleteness: 0.5,
          limitations: [
            { attribution: 'STRUCTURAL', missing: 'the rate channel', reason: 'r', resolution: null },
          ],
        }),
        ...['F1', 'F2', 'F3', 'F4', 'F6', 'F7'].map((id) => scored(id)),
        abstained('F8', 'WORLD'),
      ],
    });
    expect(coverageSentence(withPartial)).toContain('One of those is partly measured');
  });
});

describe('the three layers are labelled by what kind of claim they carry', () => {
  it('explains each layer beside its heading', () => {
    const blocks = buildLayerBlocks(analysis());
    expect(blocks.map((b) => b.layer)).toEqual(['FACT', 'INTERPRETATION', 'AI_ASSESSMENT']);
    expect(blocks[0]?.meaning).toContain('Nothing here is inferred');
    expect(blocks[1]?.meaning).toContain('not written by a model');
    expect(blocks[2]?.meaning).toContain('checked against them');
  });

  it('says why the AI layer may be missing rather than leaving a blank', () => {
    const blocks = buildLayerBlocks(analysis());
    expect(blocks[2]?.meaning).toContain('Absent when the model was unavailable');
    expect(blocks[2]?.statements).toEqual([]);
  });

  it('orders statements within a layer by ordinal', () => {
    const withStatements = analysis({
      statements: [
        { id: 's2', layer: 'FACT', ordinal: 1, body: 'second', derivedFrom: [], provenance, aiGenerationId: null },
        { id: 's1', layer: 'FACT', ordinal: 0, body: 'first', derivedFrom: [], provenance, aiGenerationId: null },
      ],
    });
    expect(buildLayerBlocks(withStatements)[0]?.statements.map((s) => s.body)).toEqual([
      'first',
      'second',
    ]);
  });
});
