/**
 * Factor viability, and keeping the manifest honest.
 *
 * `FACTOR_REQUIREMENTS` declares how much history each factor needs. A declared
 * requirement that disagrees with the implementation is the seed-divergence failure
 * in another costume — the document says one thing, the running code does another, and
 * nothing compares them.
 *
 * So the manifest is not trusted. The first group below drives each factor with
 * exactly `required - 1` observations and asserts it abstains for lack of history,
 * then with exactly `required` and asserts it scores. If someone changes a lag in
 * `factors.ts` without updating the manifest, one of those two halves fails.
 */

import { describe, expect, it } from 'vitest';
import type { FactorId, MacroSeriesId } from '@forex-agent/core';
import {
  FACTOR_REQUIREMENTS,
  FactorViabilityError,
  assertFactorViability,
  checkFactorViability,
  observationsFromLookback,
  fullObservations,
  minimumObservations,

  OBSERVATIONS_PER_YEAR,
} from './viability.js';
import { computeAllFactors, type FactorComputeConfig } from './factors.js';
import type { FundamentalInputs, MacroSeriesView, NewsAggregateView } from './inputs.js';
import { isScored } from './factor.js';
import type { NormalisationConfig } from './normalise.js';

const NORMALISATION: NormalisationConfig = {
  windowSize: 252,
  clampZ: 3,
  deadbandZ: 0.25,
  minObservations: 30,
};

const ALL_ENABLED = Object.fromEntries(
  (['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const).map((id) => [id, { enabled: true }]),
) as Record<FactorId, { enabled: boolean }>;

const COMPUTE_CONFIG: FactorComputeConfig = {
  factors: Object.fromEntries(
    (['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const).map((id) => [
      id,
      { weight: 0.125, enabled: true },
    ]),
  ) as FactorComputeConfig['factors'],
  normalisation: NORMALISATION,
  inflationNetRule: { hedgeWeight: 0.4, rateChannelWeight: 0.6, inflationTargetPct: 2 },
};

/** A series of exactly `count` observations, with real variance so z-scores exist. */
function seriesOf(seriesId: MacroSeriesId, count: number, base: number): MacroSeriesView {
  return {
    seriesId,
    points: Array.from({ length: count }, (_, i) => ({
      period: new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      value: base + Math.sin(i / 2.7) * Math.abs(base) * 0.02 + i * Math.abs(base) * 0.0005,
      factId: `${seriesId}-${String(i)}`,
    })),
    freshness: 'LIVE',
    sourceTier: 1,
    displayName: seriesId,
  };
}

const NEWS_DARK: NewsAggregateView = {
  kind: 'INSUFFICIENT_VOLUME',
  reason: 'NO_SENTIMENT_SIGNAL',
  explanation:
    'No article in the last 48h carried a scoreable sentiment term. This is an absence ' +
    'of signal, not a neutral reading.',
  articleCount: 0,
  sourceCount: 0,
  requiredArticles: 10,
  requiredSources: 2,
};

const BASE_VALUE: Readonly<Record<string, number>> = {
  DTWEXBGS: 121,
  DFII10: 2.1,
  DGS10: 4.6,
  DGS2: 3.9,
  DFF: 3.6,
  CPILFESL: 320,
  CPIAUCSL: 315,
  PAYEMS: 158_000,
  UNRATE: 4.1,
  ICSA: 225_000,
  VIXCLS: 15,
  BAMLH0A0HYM2: 2.7,
};

/** Build inputs where every series has `count` observations. */
function inputsWith(count: number, only?: MacroSeriesId): FundamentalInputs {
  const series: Partial<Record<MacroSeriesId, MacroSeriesView>> = {};
  for (const [id, base] of Object.entries(BASE_VALUE) as [MacroSeriesId, number][]) {
    // Everything else gets plenty, so a shortfall is attributable to one series.
    const n = only === undefined || only === id ? count : 400;
    series[id] = seriesOf(id, n, base);
  }
  return {
    series,
    surprises: {},
    news: NEWS_DARK,
    upcomingReleases: [],
    degradedProviders: [],
    structuralGaps: [],
  };
}

const scoredIds = (inputs: FundamentalInputs): readonly FactorId[] =>
  computeAllFactors(inputs, COMPUTE_CONFIG)
    .filter(isScored)
    .map((f) => f.factorId);

describe('the manifest matches what the factors actually need', () => {
  // Only factors with a genuinely required series can be tested this way: F6 and F7
  // survive any one series falling short, by design.
  const REQUIRED_SERIES_FACTORS = FACTOR_REQUIREMENTS.filter((r) =>
    r.series.some((s) => s.required),
  );

  it('covers every factor', () => {
    expect(FACTOR_REQUIREMENTS.map((r) => r.factorId)).toEqual([
      'F1',
      'F2',
      'F3',
      'F4',
      'F5',
      'F6',
      'F7',
      'F8',
    ]);
  });

  for (const req of REQUIRED_SERIES_FACTORS) {
    const primary = req.series.find((s) => s.required);
    if (primary === undefined) continue;
    const minimum = minimumObservations(primary, NORMALISATION);
    const full = fullObservations(primary, NORMALISATION);

    it(`${req.factorId} abstains with ${String(minimum - 1)} observations of ${primary.seriesId}`, () => {
      expect(scoredIds(inputsWith(minimum - 1, primary.seriesId))).not.toContain(req.factorId);
    });

    it(`${req.factorId} scores with ${String(minimum)} observations of ${primary.seriesId}`, () => {
      // The other half. Without it the manifest could over-state requirements for
      // ever and every abstention would look justified.
      expect(scoredIds(inputsWith(minimum, primary.seriesId))).toContain(req.factorId);
    });

    if (full > minimum) {
      it(`${req.factorId} is below full completeness at ${String(full - 1)} observations of ${primary.seriesId}`, () => {
        // Scoring is not the same as being whole. This half pins the longest lag, so
        // a factor stuck permanently at reduced weight cannot pass unnoticed.
        const factor = computeAllFactors(inputsWith(full - 1, primary.seriesId), COMPUTE_CONFIG)
          .filter(isScored)
          .find((f) => f.factorId === req.factorId);
        expect(factor?.inputCompleteness).toBeLessThan(1);
      });

      it(`${req.factorId} reaches full completeness at ${String(full)} observations of ${primary.seriesId}`, () => {
        const factor = computeAllFactors(inputsWith(full, primary.seriesId), COMPUTE_CONFIG)
          .filter(isScored)
          .find((f) => f.factorId === req.factorId);
        // F5 and F6 also read an external surprise, which these inputs omit, so full
        // completeness for them is bounded by that rather than by history.
        const ceiling = req.usesExternalSignal ? 0.99 : 1;
        expect(factor?.inputCompleteness).toBeGreaterThanOrEqual(
          req.usesExternalSignal ? 0.5 : ceiling,
        );
      });
    }
  }
});

describe('checkFactorViability', () => {
  const plentiful: Partial<Record<MacroSeriesId, number>> = Object.fromEntries(
    Object.keys(BASE_VALUE).map((id) => [id, 500]),
  );

  it('passes when every series has enough history', () => {
    const report = checkFactorViability({
      availableObservations: plentiful,
      enabledFactors: ALL_ENABLED,
      normalisation: NORMALISATION,
    });
    expect(report.healthy).toBe(true);
    expect(report.deadFactors).toEqual([]);
  });

  it('catches the F5 incident exactly as it happened', () => {
    // Two years of a monthly series: twelve observations against the 42 a
    // year-on-year change needs. F5 could not score in any market condition, and
    // abstained silently for two phases.
    const twoYearsMonthly = { ...plentiful, CPILFESL: 12, CPIAUCSL: 12, PAYEMS: 12, UNRATE: 12 };
    const report = checkFactorViability({
      availableObservations: twoYearsMonthly,
      enabledFactors: ALL_ENABLED,
      normalisation: NORMALISATION,
    });

    expect(report.healthy).toBe(false);
    expect(report.deadFactors).toContain('F5');
    const f5 = report.shortfalls.find((s) => s.factorId === 'F5');
    expect(f5).toMatchObject({
      seriesId: 'CPILFESL',
      required: 42,
      available: 12,
      severity: 'FATAL',
    });
  });

  it('distinguishes a dead factor from a merely degraded one', () => {
    // F4 loses the DGS2−DFF spread without DFF but still scores on the 2-year change,
    // so it is degraded rather than dead. Conflating the two would either hide a real
    // defect or block a boot over a survivable shortfall.
    const noDff = { ...plentiful, DFF: 5 };
    const report = checkFactorViability({
      availableObservations: noDff,
      enabledFactors: ALL_ENABLED,
      normalisation: NORMALISATION,
    });

    expect(report.deadFactors).not.toContain('F4');
    expect(report.degradedFactors).toContain('F4');
    expect(report.healthy).toBe(true);
  });

  it('treats a factor as dead when nothing it reads is viable', () => {
    // F6 tolerates losing any one labour series, but not all of them.
    const noLabour = { ...plentiful, ICSA: 2, UNRATE: 2, PAYEMS: 2 };
    const report = checkFactorViability({
      availableObservations: noLabour,
      enabledFactors: ALL_ENABLED,
      normalisation: NORMALISATION,
    });
    expect(report.deadFactors).toContain('F6');
  });

  it('counts a series that was never fetched as zero, not as absent', () => {
    const missing = { ...plentiful };
    delete missing.DFII10;
    const report = checkFactorViability({
      availableObservations: missing,
      enabledFactors: ALL_ENABLED,
      normalisation: NORMALISATION,
    });
    expect(report.deadFactors).toContain('F2');
    expect(report.shortfalls.find((s) => s.seriesId === 'DFII10')?.available).toBe(0);
  });

  it('ignores a factor that is disabled in the profile', () => {
    // A disabled factor abstains for a reason the operator chose, which is not a
    // configuration defect.
    const report = checkFactorViability({
      availableObservations: { ...plentiful, CPILFESL: 12 },
      enabledFactors: { ...ALL_ENABLED, F5: { enabled: false } },
      normalisation: NORMALISATION,
    });
    expect(report.deadFactors).not.toContain('F5');
  });

  it('skips F8, whose history the news pipeline owns', () => {
    // Sizing F8 here would be a guess dressed as a guarantee: its baseline is the
    // trailing news aggregate, which this check cannot see.
    const report = checkFactorViability({
      availableObservations: {},
      enabledFactors: ALL_ENABLED,
      normalisation: NORMALISATION,
    });
    expect(report.deadFactors).not.toContain('F8');
  });

  it('scales requirements with minObservations', () => {
    const lenient = checkFactorViability({
      availableObservations: { ...plentiful, CPILFESL: 20 },
      enabledFactors: ALL_ENABLED,
      normalisation: { ...NORMALISATION, minObservations: 5 },
    });
    expect(lenient.deadFactors).not.toContain('F5');
  });

  it('throws with every shortfall named and a remedy', () => {
    try {
      assertFactorViability({
        availableObservations: { ...plentiful, CPILFESL: 12 },
        enabledFactors: ALL_ENABLED,
        normalisation: NORMALISATION,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FactorViabilityError);
      const message = (error as Error).message;
      expect(message).toContain('F5');
      expect(message).toContain('CPILFESL');
      expect(message).toContain('FACTOR CANNOT SCORE');
      // The reason it matters, not just the numbers.
      expect(message).toContain('indistinguishable from a genuine data outage');
      expect(message).toContain('lookback');
    }
  });
});

describe('the shipped lookback windows keep every factor alive', () => {
  // The per-cadence windows from `ingestMacro.ts`. Restated here because
  // `packages/engines` cannot import the worker; the worker asserts the same thing
  // against its own constants in `engineViability.test.ts`.
  const LOOKBACK_DAYS: Readonly<Record<MacroSeriesId, number>> = {
    DTWEXBGS: 3650, // WEEKLY cadence
    ICSA: 3650, // WEEKLY cadence
    DFII10: 730,
    DGS10: 730,
    DGS2: 730,
    DFF: 730,
    VIXCLS: 730,
    BAMLH0A0HYM2: 730,
    CPIAUCSL: 9130,
    CPILFESL: 9130,
    PAYEMS: 9130,
    UNRATE: 9130,
  };

  it('leaves no factor dead', () => {
    const report = checkFactorViability({
      availableObservations: observationsFromLookback((id) => LOOKBACK_DAYS[id]),
      enabledFactors: ALL_ENABLED,
      normalisation: NORMALISATION,
    });
    expect(report.deadFactors).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('leaves no factor degraded either', () => {
    // Stricter than "alive": a factor permanently stuck below full input completeness
    // is also a configuration artefact, just a quieter one.
    const report = checkFactorViability({
      availableObservations: observationsFromLookback((id) => LOOKBACK_DAYS[id]),
      enabledFactors: ALL_ENABLED,
      normalisation: NORMALISATION,
    });
    expect(report.degradedFactors).toEqual([]);
  });

  it('would have failed under the old uniform two-year window', () => {
    // The regression this check exists to prevent, pinned so the fix cannot be
    // reverted quietly.
    const report = checkFactorViability({
      availableObservations: observationsFromLookback(() => 730),
      enabledFactors: ALL_ENABLED,
      normalisation: NORMALISATION,
    });
    expect(report.healthy).toBe(false);
    expect(report.deadFactors).toContain('F5');
  });

  it('sizes DTWEXBGS by observation density, not publication cadence', () => {
    // It publishes weekly but is observed every business day. Sizing by cadence would
    // understate its history fivefold — the same conflation as PRD_V1 §13.4.1.
    expect(OBSERVATIONS_PER_YEAR.DTWEXBGS).toBe(252);
    expect(OBSERVATIONS_PER_YEAR.ICSA).toBe(52);
  });
});
