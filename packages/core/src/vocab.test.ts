import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_MODES,
  ANALYSIS_MODES_V1,
  FACTOR_IDS,
  FACTOR_NAMES,
  LAYER_RANK,
  MACRO_SERIES_CADENCE,
  MACRO_SERIES_IDS,
  STATEMENT_LAYERS,
  TIER_WEIGHT,
  TIMEFRAMES,
  TIMEFRAME_MS,
  isAnalysisMode,
  isAssetSymbol,
  isMacroSeriesId,
  isSourceTier,
  isTimeframe,
} from './vocab.js';

describe('type guards', () => {
  it('accepts known values and rejects unknown ones', () => {
    expect(isAssetSymbol('XAUUSD')).toBe(true);
    expect(isAssetSymbol('BTCUSD')).toBe(false);
    expect(isTimeframe('4h')).toBe(true);
    expect(isTimeframe('3h')).toBe(false);
    expect(isMacroSeriesId('DFII10')).toBe(true);
    expect(isMacroSeriesId('NOTASERIES')).toBe(false);
    expect(isSourceTier(1)).toBe(true);
    expect(isSourceTier(5)).toBe(false);
    expect(isSourceTier(0)).toBe(false);
  });
});

describe('analysis modes', () => {
  it('names every future mode so the API contract is forward-compatible', () => {
    expect(ANALYSIS_MODES).toContain('FULL_CONFLUENCE');
    expect(ANALYSIS_MODES).toContain('TECHNICAL_ONLY');
  });

  it('permits only FUNDAMENTAL in V1', () => {
    // The others must be rejected with an explicit error, never silently accepted
    // and quietly downgraded to a fundamental run.
    expect(ANALYSIS_MODES_V1).toEqual(['FUNDAMENTAL']);
    expect(isAnalysisMode('FULL_CONFLUENCE')).toBe(true);
    expect(ANALYSIS_MODES_V1).not.toContain('FULL_CONFLUENCE');
  });
});

describe('epistemic layers (Amendment A2)', () => {
  it('ranks layers so lineage can only descend', () => {
    expect(LAYER_RANK.FACT).toBeLessThan(LAYER_RANK.INTERPRETATION);
    expect(LAYER_RANK.INTERPRETATION).toBeLessThan(LAYER_RANK.AI_ASSESSMENT);
  });

  it('ranks every declared layer', () => {
    for (const layer of STATEMENT_LAYERS) {
      expect(typeof LAYER_RANK[layer]).toBe('number');
    }
  });
});

describe('source tiers', () => {
  it('weights official sources above unverified ones', () => {
    expect(TIER_WEIGHT[1]).toBeGreaterThan(TIER_WEIGHT[2]);
    expect(TIER_WEIGHT[2]).toBeGreaterThan(TIER_WEIGHT[3]);
    expect(TIER_WEIGHT[3]).toBeGreaterThan(TIER_WEIGHT[4]);
  });
});

describe('lookup table completeness', () => {
  // These catch the classic failure of adding an enum member and forgetting the
  // map that goes with it — a bug that otherwise surfaces as `undefined` at runtime.
  it('gives every timeframe a duration', () => {
    for (const tf of TIMEFRAMES) {
      expect(TIMEFRAME_MS[tf]).toBeGreaterThan(0);
    }
  });

  it('orders timeframe durations ascending', () => {
    const durations = TIMEFRAMES.map((tf) => TIMEFRAME_MS[tf]);
    expect([...durations].sort((a, b) => a - b)).toEqual(durations);
  });

  it('gives every macro series a cadence', () => {
    for (const id of MACRO_SERIES_IDS) {
      expect(MACRO_SERIES_CADENCE[id]).toBeDefined();
    }
  });

  it('gives every factor a name', () => {
    for (const id of FACTOR_IDS) {
      expect(FACTOR_NAMES[id]).toBeTruthy();
    }
  });

  it('declares exactly the eight V1 factors', () => {
    expect(FACTOR_IDS).toHaveLength(8);
  });
});
