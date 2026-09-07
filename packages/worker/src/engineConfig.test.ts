/**
 * The shipped profile against the engine's assumptions.
 *
 * `packages/engines` is pure and takes its configuration as a parameter — it cannot
 * import `packages/config` even for a test (ARCHITECTURE §4.1). So the engine's own
 * unit tests restate the PRD_V1 §8.5 numbers as local fixtures, and are therefore
 * capable of proving the engine correct against weights the product does not use.
 *
 * This closes that gap from the one package that can legitimately see both. It is the
 * same class of check as `verifySeedIntegrity`: two sources of truth that must agree,
 * and no way to notice when they stop agreeing except by comparing them.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIDENCE,
  DEFAULT_FACTOR_CONFIG,
  DEFAULT_INFLATION_NET_RULE,
  DEFAULT_NORMALISATION,
  DEFAULT_RUNTIME_CONFIG,
} from '@forex-agent/config';
import { FACTOR_IDS } from '@forex-agent/core';
import { assertValidNormalisation, computeConfidence } from '@forex-agent/engines';

/** The values the engine's unit-test fixtures hard-code, from PRD_V1 §8.5.2. */
const PRD_WEIGHTS = {
  F1: 0.18,
  F2: 0.18,
  F3: 0.1,
  F4: 0.15,
  F5: 0.09,
  F6: 0.1,
  F7: 0.1,
  F8: 0.1,
} as const;

describe('the shipped profile matches what the engine is tested against', () => {
  it('uses the PRD_V1 §8.5.2 factor weights exactly', () => {
    for (const id of FACTOR_IDS) {
      expect(DEFAULT_FACTOR_CONFIG[id].weight).toBeCloseTo(PRD_WEIGHTS[id], 10);
    }
  });

  it('has every factor enabled, so a dark factor is always a data fact', () => {
    // A factor disabled in config abstains for the reason DISABLED, which reads on the
    // dashboard almost identically to a data outage. Shipping with one disabled would
    // make the product quietly narrower than it claims.
    for (const id of FACTOR_IDS) {
      expect(DEFAULT_FACTOR_CONFIG[id].enabled).toBe(true);
    }
  });

  it('uses the PRD_V1 §8.5.3 normalisation parameters', () => {
    expect(DEFAULT_NORMALISATION.windowSize).toBe(252);
    expect(DEFAULT_NORMALISATION.clampZ).toBe(3);
    expect(DEFAULT_NORMALISATION.deadbandZ).toBe(0.25);
  });

  it('ships a normalisation config the engine will accept', () => {
    // The engine rejects a deadband at or above the clamp, which would make every
    // factor read neutral for ever. Better to fail here than at the first run.
    expect(() => assertValidNormalisation(DEFAULT_NORMALISATION)).not.toThrow();
  });

  it('uses the PRD_V1 §8.5.4 insufficiency floor and confidence cap', () => {
    expect(DEFAULT_CONFIDENCE.insufficientCoverageFloor).toBe(0.5);
    expect(DEFAULT_CONFIDENCE.mediumCapCoverage).toBe(0.65);
  });

  it('ships confidence weights the engine will accept', () => {
    // `computeConfidence` throws on a set that does not sum to 1, because an
    // unnormalised set silently rescales every confidence value in the product.
    expect(() =>
      computeConfidence({
        coverage: 1,
        agreement: 1,
        factors: [],
        weights: DEFAULT_CONFIDENCE.weights,
        thresholds: DEFAULT_CONFIDENCE.thresholds,
        mediumCapCoverage: DEFAULT_CONFIDENCE.mediumCapCoverage,
        eventRiskImminent: false,
      }),
    ).not.toThrow();
  });

  it('keeps the insufficiency floor below the confidence cap threshold', () => {
    // If the floor were the higher of the two, every published score would already be
    // above the cap threshold and the MEDIUM cap would be unreachable — a rule that
    // exists in the config and never fires.
    expect(DEFAULT_CONFIDENCE.insufficientCoverageFloor).toBeLessThan(
      DEFAULT_CONFIDENCE.mediumCapCoverage,
    );
  });

  it('uses the PRD_V1 §8.5.2 inflation net rule', () => {
    expect(DEFAULT_INFLATION_NET_RULE.hedgeWeight).toBe(0.4);
    expect(DEFAULT_INFLATION_NET_RULE.rateChannelWeight).toBe(0.6);
    expect(DEFAULT_INFLATION_NET_RULE.inflationTargetPct).toBe(2);
  });

  it('exposes the same values through the assembled runtime config', () => {
    // The profile stored in `config_profiles` is built from the whole runtime config,
    // so the pieces asserted above have to be the ones that actually ship.
    expect(DEFAULT_RUNTIME_CONFIG.factors).toEqual(DEFAULT_FACTOR_CONFIG);
    expect(DEFAULT_RUNTIME_CONFIG.confidence).toEqual(DEFAULT_CONFIDENCE);
    expect(DEFAULT_RUNTIME_CONFIG.normalisation).toEqual(DEFAULT_NORMALISATION);
  });
});
