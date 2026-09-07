/**
 * Abstention, renormalisation, insufficiency, and confidence independence.
 *
 * These four behaviours are the product. A terminal that always produces a number is
 * a worse product than one that admits when it cannot judge, because the number it
 * produces on thin data is indistinguishable — to the reader — from the number it
 * produces on good data. Everything here is about keeping those two distinguishable.
 */

import { describe, expect, it } from 'vitest';
import { FACTOR_NAMES, type FactorId, type FreshnessStatus, type SourceTier } from '@forex-agent/core';
import {
  aggregateFactors,
  factorAgreement,
  type FundamentalAggregation,
  type ScoredAggregation,
} from './aggregate.js';
import { computeConfidence } from './confidence.js';
import { effectiveWeight, type FactorOutcome } from './factor.js';

/**
 * The engine is pure and takes its config as a parameter — `packages/engines` depends
 * on `packages/core` and nothing else (ARCHITECTURE §4.1), so it cannot import the
 * shipped profile even for a test.
 *
 * These fixtures therefore restate the PRD_V1 §8.5.2 and §8.5.4 values. That the
 * shipped profile still matches them is asserted separately, in a package that can
 * legitimately see both — see `fundamentalEngine.integration.test.ts`. Copying values
 * without that cross-check is how an engine ends up provably correct against numbers
 * the product does not use.
 */
const FACTOR_WEIGHTS: Readonly<Record<FactorId, number>> = {
  F1: 0.18,
  F2: 0.18,
  F3: 0.1,
  F4: 0.15,
  F5: 0.09,
  F6: 0.1,
  F7: 0.1,
  F8: 0.1,
};

const CONFIDENCE = {
  insufficientCoverageFloor: 0.5,
  mediumCapCoverage: 0.65,
  thresholds: { high: 70, medium: 45 },
  weights: { coverage: 0.4, sourceQuality: 0.15, agreement: 0.3, freshness: 0.15 },
} as const;

const FLOOR = CONFIDENCE.insufficientCoverageFloor;
const weightOf = (id: FactorId): number => FACTOR_WEIGHTS[id];

function scored(
  factorId: FactorId,
  score: number,
  options: {
    confidence?: number;
    freshness?: FreshnessStatus;
    tier?: SourceTier;
  } = {},
): FactorOutcome {
  const freshness = options.freshness ?? 'LIVE';
  const tier = options.tier ?? 1;
  return {
    kind: 'SCORED',
    factorId,
    factorName: FACTOR_NAMES[factorId],
    weight: weightOf(factorId),
    score,
    zScore: score / 33.3,
    direction: score > 0 ? 'BULLISH' : score < 0 ? 'BEARISH' : 'NEUTRAL',
    rawSignal: {},
    confidence: options.confidence ?? 1,
    freshness,
    inputCompleteness: 1,
    limitations: [],
    factRefs: [{ table: 'macro_observations', id: 'x', label: factorId, freshness, sourceTier: tier }],
    explanation: 'test',
  };
}

function abstained(factorId: FactorId): FactorOutcome {
  return {
    kind: 'ABSTAINED',
    factorId,
    factorName: FACTOR_NAMES[factorId],
    weight: weightOf(factorId),
    reason: 'INPUT_UNAVAILABLE',
    detail: `${factorId} input UNAVAILABLE`,
    freshness: 'UNAVAILABLE',
    attribution: 'WORLD',
    factRefs: [],
    explanation: 'test',
  };
}

const aggregate = (factors: readonly FactorOutcome[]): FundamentalAggregation =>
  aggregateFactors({ factors, insufficientCoverageFloor: FLOOR });

/** Narrowing helper — a failure here is a test bug, not an assertion failure. */
function expectScored(a: FundamentalAggregation): ScoredAggregation {
  if (a.status !== 'SCORED') {
    throw new Error(`expected SCORED, got ${a.status}: ${a.reason}`);
  }
  return a;
}

const ALL_FACTORS: readonly FactorId[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'];

describe('a factor with UNAVAILABLE data abstains and carries zero weight', () => {
  it('contributes exactly zero effective weight', () => {
    expect(effectiveWeight(abstained('F1'))).toBe(0);
  });

  it('cannot be given influence by any field a caller controls', () => {
    // The type has no `score` and no `confidence` to set. This asserts the runtime
    // behaviour matches: even an object carrying stray fields contributes nothing,
    // because `effectiveWeight` branches on `kind` and reads nothing else.
    const smuggled = {
      ...abstained('F1'),
      score: 100,
      confidence: 1,
    } as unknown as FactorOutcome;
    expect(effectiveWeight(smuggled)).toBe(0);
  });

  it('does not vote zero — the score is what the others say, not what they say diluted', () => {
    // The failure this prevents: treating a missing input as a neutral reading. With
    // F1 abstaining, the remaining factors' agreement must come through undiluted.
    const withAbstention = expectScored(
      aggregate([
        abstained('F1'),
        scored('F2', 60),
        scored('F3', 60),
        scored('F4', 60),
        scored('F5', 60),
        scored('F6', 60),
        scored('F7', 60),
        scored('F8', 60),
      ]),
    );
    expect(withAbstention.signedScore).toBeCloseTo(60, 6);

    // If F1 had voted zero instead of abstaining, the score would have been dragged
    // down by its full 0.18 weight. That is the number we must NOT produce.
    const ifItHadVotedZero = expectScored(
      aggregate([
        scored('F1', 0),
        scored('F2', 60),
        scored('F3', 60),
        scored('F4', 60),
        scored('F5', 60),
        scored('F6', 60),
        scored('F7', 60),
        scored('F8', 60),
      ]),
    );
    expect(ifItHadVotedZero.signedScore).toBeCloseTo(49.2, 1);
    expect(withAbstention.signedScore).not.toBeCloseTo(ifItHadVotedZero.signedScore, 1);
  });

  it('reports the abstention with its reason rather than hiding it', () => {
    const result = aggregate([abstained('F1'), ...ALL_FACTORS.slice(1).map((id) => scored(id, 20))]);
    expect(result.abstained).toEqual([
      { factorId: 'F1', reason: 'INPUT_UNAVAILABLE', detail: 'F1 input UNAVAILABLE' },
    ]);
  });

  it('degrades weight proportionally for a STALE factor without abstaining it', () => {
    // STALE is half weight, not zero: the data is old but real. Only UNAVAILABLE
    // removes a factor entirely.
    const stale = scored('F1', 50, { confidence: 0.5, freshness: 'STALE' });
    expect(effectiveWeight(stale)).toBeCloseTo(0.09, 6);
  });
});

describe('remaining weights renormalise, and coverage is reported honestly', () => {
  it('renormalises the score across the surviving factors only', () => {
    // F1 (0.18) and F2 (0.18) dark; the rest carry 0.64 between them.
    const result = expectScored(
      aggregate([
        abstained('F1'),
        abstained('F2'),
        scored('F3', 80),
        scored('F4', 40),
        scored('F5', 0),
        scored('F6', -20),
        scored('F7', 60),
        scored('F8', 20),
      ]),
    );

    const expected =
      (80 * 0.1 + 40 * 0.15 + 0 * 0.09 + -20 * 0.1 + 60 * 0.1 + 20 * 0.1) /
      (0.1 + 0.15 + 0.09 + 0.1 + 0.1 + 0.1);
    expect(result.signedScore).toBeCloseTo(expected, 6);
  });

  it('divides coverage by ALL weights, including the abstaining ones', () => {
    // The bug this pins: using Σ effective_weight as the coverage denominator too
    // would make coverage identically 1.0 and the insufficiency rule unreachable.
    const result = aggregate([
      abstained('F1'),
      abstained('F2'),
      ...ALL_FACTORS.slice(2).map((id) => scored(id, 10)),
    ]);
    expect(result.coverage).toBeCloseTo(0.64, 6);
    expect(result.coverage).not.toBe(1);
    expect(result.totalWeight).toBeCloseTo(1, 6);
  });

  it('reports coverage of 1.0 only when every factor contributes at full confidence', () => {
    const result = aggregate(ALL_FACTORS.map((id) => scored(id, 10)));
    expect(result.coverage).toBeCloseTo(1, 6);
  });

  it('reduces coverage for partial confidence, not just for abstention', () => {
    // Every factor present but all STALE: the model ran in full, and we still know
    // less than a fully-fresh run. Coverage must show that.
    const result = aggregate(
      ALL_FACTORS.map((id) => scored(id, 10, { confidence: 0.5, freshness: 'STALE' })),
    );
    expect(result.coverage).toBeCloseTo(0.5, 6);
  });

  it('renormalisation leaves a unanimous score unchanged whatever is missing', () => {
    // A property, not an example: if every surviving factor says 42, the answer is 42
    // regardless of which factors survived. Anything else means a missing factor is
    // still influencing the number.
    for (const dark of ALL_FACTORS.slice(0, 4)) {
      const factors = ALL_FACTORS.map((id) => (id === dark ? abstained(id) : scored(id, 42)));
      expect(expectScored(aggregate(factors)).signedScore).toBeCloseTo(42, 6);
    }
  });
});

describe('below the coverage floor there is no score at all', () => {
  it('returns INSUFFICIENT_DATA when coverage falls under the floor', () => {
    // F1, F2, F4 and F6 dark: 0.61 of the model gone, coverage 0.39.
    const result = aggregate([
      abstained('F1'),
      abstained('F2'),
      scored('F3', 90),
      abstained('F4'),
      scored('F5', 90),
      abstained('F6'),
      scored('F7', 90),
      scored('F8', 90),
    ]);

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.coverage).toBeCloseTo(0.39, 6);
  });

  it('carries no score field whatsoever, not a null one', () => {
    const result = aggregate([
      abstained('F1'),
      abstained('F2'),
      abstained('F3'),
      abstained('F4'),
      scored('F5', 90),
      scored('F6', 90),
      scored('F7', 90),
      abstained('F8'),
    ]);

    expect(result.status).toBe('INSUFFICIENT_DATA');
    // Not `toBeNull` — the key must be absent. A null score can be rendered as 0,
    // formatted as '0.0', or averaged into something downstream; an absent key
    // cannot.
    expect(result).not.toHaveProperty('signedScore');
    expect(result).not.toHaveProperty('displayScore');
    expect(result).not.toHaveProperty('band');
    expect(result).not.toHaveProperty('bias');
  });

  it('survives serialisation without acquiring a score', () => {
    // The dashboard and the email both see JSON, not the union.
    const result = aggregate([
      ...ALL_FACTORS.slice(0, 6).map((id) => abstained(id)),
      scored('F7', 90),
      scored('F8', 90),
    ]);
    const roundTripped = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(roundTripped.status).toBe('INSUFFICIENT_DATA');
    expect(Object.keys(roundTripped)).not.toContain('signedScore');
  });

  it('says which factors are missing and why', () => {
    const result = aggregate([
      abstained('F1'),
      abstained('F2'),
      abstained('F3'),
      abstained('F4'),
      abstained('F5'),
      scored('F6', 10),
      scored('F7', 10),
      scored('F8', 10),
    ]);
    if (result.status !== 'INSUFFICIENT_DATA') throw new Error('expected INSUFFICIENT_DATA');
    expect(result.reason).toContain('30%');
    expect(result.reason).toContain('50%');
    expect(result.reason).toContain('F1');
    expect(result.reason).toContain('UNAVAILABLE');
  });

  it('publishes at exactly the floor, and withholds just below it', () => {
    // The boundary is inclusive of publishing, per §8.5.4's `coverage < 0.50`.
    const atFloor = aggregate(ALL_FACTORS.map((id) => scored(id, 10, { confidence: 0.5 })));
    expect(atFloor.coverage).toBeCloseTo(0.5, 6);
    expect(atFloor.status).toBe('SCORED');

    const justBelow = aggregate(ALL_FACTORS.map((id) => scored(id, 10, { confidence: 0.499 })));
    expect(justBelow.status).toBe('INSUFFICIENT_DATA');
  });

  it('returns INSUFFICIENT_DATA rather than NaN when every factor abstains', () => {
    // 0/0. Without the guard this produces NaN, which would pass a range check,
    // survive rounding, store as null, and render as a blank number.
    const result = aggregate(ALL_FACTORS.map((id) => abstained(id)));
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.coverage).toBe(0);
    expect(result).not.toHaveProperty('signedScore');
  });

  it('refuses an empty factor set instead of calling it insufficient', () => {
    // Different failure, different response: no factors ran at all is a wiring bug,
    // and reporting it as INSUFFICIENT_DATA would present a broken pipeline to the
    // user as an honest data shortage.
    expect(() => aggregate([])).toThrow(/programming error/);
  });
});

describe('confidence is computed independently of the score', () => {
  const confidenceFor = (
    factors: readonly FactorOutcome[],
    options: { eventRiskImminent?: boolean; degraded?: readonly string[] } = {},
  ) => {
    const agg = aggregate(factors);
    return computeConfidence({
      coverage: agg.coverage,
      agreement: agg.status === 'SCORED' ? agg.agreement : 0,
      factors,
      weights: CONFIDENCE.weights,
      thresholds: CONFIDENCE.thresholds,
      mediumCapCoverage: CONFIDENCE.mediumCapCoverage,
      eventRiskImminent: options.eventRiskImminent ?? false,
      ...(options.degraded === undefined ? {} : { degradedProviders: options.degraded }),
    });
  };

  it('gives the same confidence to a strong reading and a weak one on identical data', () => {
    // The property that matters: scale the scores, keep the data, and confidence must
    // not move. If it does, confidence is just the score wearing a different label.
    const weak = ALL_FACTORS.map((id) => scored(id, 6));
    const strong = ALL_FACTORS.map((id) => scored(id, 95));

    expect(confidenceFor(weak).value).toBe(confidenceFor(strong).value);
  });

  it('agreement measures direction, not magnitude', () => {
    const mild = ALL_FACTORS.map((id) => scored(id, 5));
    const extreme = ALL_FACTORS.map((id) => scored(id, 100));
    expect(factorAgreement(mild)).toBeCloseTo(factorAgreement(extreme), 9);
  });

  it('gives a high score on thin data LOW or MEDIUM confidence, never HIGH', () => {
    // The case the user cares about most. Every surviving factor screams bullish and
    // agrees perfectly — the most seductive possible input — but more than a third of
    // the model is dark.
    // F1, F3 and F4 dark: 0.43 of the model gone, coverage 0.57 — above the 0.50
    // floor so a score IS published, but below the 0.65 cap threshold.
    const thin = [
      abstained('F1'),
      abstained('F3'),
      abstained('F4'),
      scored('F2', 95),
      scored('F5', 95),
      scored('F6', 95),
      scored('F7', 95),
      scored('F8', 95),
    ];
    const agg = expectScored(aggregate(thin));
    expect(agg.signedScore).toBeCloseTo(95, 6); // an emphatic score
    expect(agg.agreement).toBeCloseTo(1, 6); // and perfect agreement

    const confidence = confidenceFor(thin);
    expect(agg.coverage).toBeCloseTo(0.57, 6);
    expect(confidence.level).not.toBe('HIGH');
    expect(confidence.caps.join(' ')).toContain('capped at MEDIUM');
  });

  it('reports the uncapped level too, so a capped result reads as capped', () => {
    const thin = [
      abstained('F1'),
      abstained('F3'),
      abstained('F4'),
      ...(['F2', 'F5', 'F6', 'F7', 'F8'] as const).map((id) => scored(id, 95)),
    ];
    const confidence = confidenceFor(thin);
    // Without the cap the weighted sum alone would have said HIGH — which is exactly
    // why the cap exists rather than trusting the weights.
    expect(confidence.uncappedLevel).toBe('HIGH');
    expect(confidence.level).toBe('MEDIUM');
  });

  it('gives full, fresh, Tier 1, agreeing data HIGH confidence', () => {
    // The control. If this were not HIGH, the low-confidence results above would be
    // evidence of a broken scale rather than of honest caution.
    const full = ALL_FACTORS.map((id) => scored(id, 40));
    const confidence = confidenceFor(full);
    expect(confidence.level).toBe('HIGH');
    expect(confidence.caps).toEqual([]);
  });

  it('lowers confidence when factors disagree, at identical coverage', () => {
    const agreeing = ALL_FACTORS.map((id) => scored(id, 50));
    const conflicting = ALL_FACTORS.map((id, i) => scored(id, i % 2 === 0 ? 50 : -50));

    expect(aggregate(agreeing).coverage).toBeCloseTo(aggregate(conflicting).coverage, 9);
    expect(confidenceFor(conflicting).value).toBeLessThan(confidenceFor(agreeing).value);
  });

  it('lowers confidence for stale data even when everything is present', () => {
    const fresh = ALL_FACTORS.map((id) => scored(id, 40));
    const stale = ALL_FACTORS.map((id) => scored(id, 40, { freshness: 'STALE' }));
    expect(confidenceFor(stale).value).toBeLessThan(confidenceFor(fresh).value);
  });

  it('lowers confidence for lower-tier sources even when everything is present', () => {
    const tier1 = ALL_FACTORS.map((id) => scored(id, 40, { tier: 1 }));
    const tier3 = ALL_FACTORS.map((id) => scored(id, 40, { tier: 3 }));
    expect(confidenceFor(tier3).value).toBeLessThan(confidenceFor(tier1).value);
  });

  it('caps at MEDIUM when a high-impact release is imminent', () => {
    const full = ALL_FACTORS.map((id) => scored(id, 40));
    expect(confidenceFor(full).level).toBe('HIGH');

    const capped = confidenceFor(full, { eventRiskImminent: true });
    expect(capped.level).toBe('MEDIUM');
    expect(capped.caps.join(' ')).toContain('high-impact release');
  });

  it('penalises running on a degraded provider chain', () => {
    const full = ALL_FACTORS.map((id) => scored(id, 40));
    expect(confidenceFor(full, { degraded: ['twelvedata'] }).value).toBeLessThan(
      confidenceFor(full).value,
    );
  });

  it('rejects a weight set that does not sum to 1', () => {
    // Unnormalised weights rescale every confidence value in the product silently.
    expect(() =>
      computeConfidence({
        coverage: 1,
        agreement: 1,
        factors: ALL_FACTORS.map((id) => scored(id, 10)),
        weights: { coverage: 0.5, sourceQuality: 0.2, agreement: 0.2, freshness: 0.2 },
        thresholds: CONFIDENCE.thresholds,
        mediumCapCoverage: CONFIDENCE.mediumCapCoverage,
        eventRiskImminent: false,
      }),
    ).toThrow(/must sum to 1/);
  });

  it('takes no score as input at all', () => {
    // Structural, not behavioural: the guarantee is that there is no argument through
    // which a score could reach this function. Asserted by listing what it does take.
    const input = {
      coverage: 1,
      agreement: 1,
      factors: [],
      weights: CONFIDENCE.weights,
      thresholds: CONFIDENCE.thresholds,
      mediumCapCoverage: CONFIDENCE.mediumCapCoverage,
      eventRiskImminent: false,
    };
    expect(Object.keys(input).sort()).toEqual([
      'agreement',
      'coverage',
      'eventRiskImminent',
      'factors',
      'mediumCapCoverage',
      'thresholds',
      'weights',
    ]);
  });
});
