import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_CONFIG,
  RuntimeConfigError,
  assertValidRuntimeConfig,
  type RuntimeConfig,
} from './runtime.js';

const withFactors = (
  overrides: Partial<RuntimeConfig['factors']>,
): RuntimeConfig => ({
  ...DEFAULT_RUNTIME_CONFIG,
  factors: { ...DEFAULT_RUNTIME_CONFIG.factors, ...overrides },
});

describe('default runtime config', () => {
  it('is valid as shipped', () => {
    expect(() => assertValidRuntimeConfig(DEFAULT_RUNTIME_CONFIG)).not.toThrow();
  });

  it('has factor weights summing to exactly 1', () => {
    const sum = Object.values(DEFAULT_RUNTIME_CONFIG.factors)
      .filter((f) => f.enabled)
      .reduce((a, f) => a + f.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('declares all eight V1 factors', () => {
    expect(Object.keys(DEFAULT_RUNTIME_CONFIG.factors)).toHaveLength(8);
  });

  it('gives the two strongest gold drivers the heaviest weights', () => {
    // Real yields and the dollar are the dominant gold drivers; if a future edit
    // demotes them below the news factor, that is a modelling error worth catching.
    const { factors } = DEFAULT_RUNTIME_CONFIG;
    expect(factors.F2.weight).toBeGreaterThanOrEqual(factors.F8.weight);
    expect(factors.F1.weight).toBeGreaterThanOrEqual(factors.F8.weight);
  });

  it('sets the insufficiency floor below the medium-confidence cap', () => {
    const { insufficientCoverageFloor, mediumCapCoverage } = DEFAULT_RUNTIME_CONFIG.confidence;
    expect(insufficientCoverageFloor).toBeLessThanOrEqual(mediumCapCoverage);
  });
});

describe('assertValidRuntimeConfig', () => {
  it('rejects factor weights that do not sum to 1', () => {
    // A silent renormalisation here would make every score subtly wrong.
    expect(() =>
      assertValidRuntimeConfig(withFactors({ F1: { weight: 0.5, direction: 'INVERSE', enabled: true } })),
    ).toThrow(RuntimeConfigError);
  });

  it('rejects a negative or out-of-range factor weight', () => {
    expect(() =>
      assertValidRuntimeConfig(withFactors({ F1: { weight: -0.1, direction: 'INVERSE', enabled: true } })),
    ).toThrow(RuntimeConfigError);
  });

  it('rejects a configuration with every factor disabled', () => {
    const factors = Object.fromEntries(
      Object.entries(DEFAULT_RUNTIME_CONFIG.factors).map(([k, v]) => [k, { ...v, enabled: false }]),
    ) as RuntimeConfig['factors'];
    expect(() => assertValidRuntimeConfig({ ...DEFAULT_RUNTIME_CONFIG, factors })).toThrow(
      RuntimeConfigError,
    );
  });

  it('accepts a subset of factors whose weights are renormalised by the operator', () => {
    // Disabling a factor is legitimate, but the operator must restate the weights;
    // the system will not quietly redistribute them.
    const factors: RuntimeConfig['factors'] = {
      ...DEFAULT_RUNTIME_CONFIG.factors,
      F8: { weight: 0, direction: 'DIRECT', enabled: false },
      F1: { weight: 0.28, direction: 'INVERSE', enabled: true },
    };
    expect(() => assertValidRuntimeConfig({ ...DEFAULT_RUNTIME_CONFIG, factors })).not.toThrow();
  });

  it('rejects inverted confidence thresholds', () => {
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        confidence: {
          ...DEFAULT_RUNTIME_CONFIG.confidence,
          thresholds: { high: 40, medium: 80 },
        },
      }),
    ).toThrow(RuntimeConfigError);
  });

  it('rejects confidence weights that do not sum to 1', () => {
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        confidence: {
          ...DEFAULT_RUNTIME_CONFIG.confidence,
          weights: { coverage: 0.9, sourceQuality: 0.9, agreement: 0.9, freshness: 0.9 },
        },
      }),
    ).toThrow(RuntimeConfigError);
  });

  it('rejects an insufficiency floor above the medium cap', () => {
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        confidence: {
          ...DEFAULT_RUNTIME_CONFIG.confidence,
          insufficientCoverageFloor: 0.9,
          mediumCapCoverage: 0.5,
        },
      }),
    ).toThrow(RuntimeConfigError);
  });

  it('rejects a deadband at or above the clamp', () => {
    // deadband >= clamp would zero out every possible signal.
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        normalisation: { ...DEFAULT_RUNTIME_CONFIG.normalisation, deadbandZ: 3, clampZ: 3 },
      }),
    ).toThrow(RuntimeConfigError);
  });

  it('rejects a window smaller than the minimum observation count', () => {
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        normalisation: { ...DEFAULT_RUNTIME_CONFIG.normalisation, windowSize: 10, minObservations: 30 },
      }),
    ).toThrow(RuntimeConfigError);
  });

  it('rejects inflation net-rule weights that do not sum to 1', () => {
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        inflationNetRule: { hedgeWeight: 0.5, rateChannelWeight: 0.9, inflationTargetPct: 2 },
      }),
    ).toThrow(RuntimeConfigError);
  });

  it('rejects non-monotonic freshness thresholds and names the offending domain', () => {
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        freshness: {
          ...DEFAULT_RUNTIME_CONFIG.freshness,
          news: { liveMs: 9e6, recentMs: 1000, staleBeyondMs: 2000, maxRetrievalAgeMs: 1000 },
        },
      }),
    ).toThrow(/freshness\.news/);
  });

  it('rejects a bias band configuration with a gap', () => {
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        biasBands: [
          { label: 'Low', min: 0, max: 40, bias: 'BEARISH' },
          { label: 'High', min: 50, max: 100, bias: 'BULLISH' },
        ],
      }),
    ).toThrow();
  });

  it('rejects a backoff ceiling below the base delay', () => {
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        resilience: { ...DEFAULT_RUNTIME_CONFIG.resilience, backoffBaseMs: 5000, backoffMaxMs: 100 },
      }),
    ).toThrow(RuntimeConfigError);
  });

  it('rejects an imminent window wider than the warning window', () => {
    expect(() =>
      assertValidRuntimeConfig({
        ...DEFAULT_RUNTIME_CONFIG,
        eventRisk: { warnWindowMs: 1000, imminentWindowMs: 5000 },
      }),
    ).toThrow(RuntimeConfigError);
  });
});
