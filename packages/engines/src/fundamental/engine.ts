/**
 * The fundamental engine (PRD_V1 §8.5).
 *
 * `(facts, config, now) → FundamentalResult`. Pure: no database, no network, no
 * ambient clock. Everything that varies arrives as an argument, so a result is
 * reproducible from its inputs and every branch — including the ones that only occur
 * when half the providers are down — is reachable in a unit test.
 *
 * The order of operations carries a decision worth naming: **event risk is assessed
 * even when no score is published**. A run that cannot judge still owes the user the
 * warning that a HIGH-impact release is due, and withholding it because coverage was
 * thin would mean the user hears least at the moment conditions are worst.
 *
 * The other is that **the AI is not called on an insufficient run**, and the result
 * type is what enforces it: `aiEligible` is `false` on the insufficient branch and
 * there is no score for a model to describe. Amendment A3 again — a model handed a
 * missing score will write around it, and prose that fills a gap reads exactly like
 * prose that reports a finding.
 */

import type { BiasBand, ConfidenceThresholds, FactorId } from '@forex-agent/core';
import {
  aggregateFactors,
  type FundamentalAggregation,
  type ScoredAggregation,
} from './aggregate.js';
import { computeConfidence, type ConfidenceResult, type ConfidenceWeights } from './confidence.js';
import { assessEventRisk, type EventRiskConfig, type EventRiskResult } from './eventRisk.js';
import { computeAllFactors, type FactorComputeConfig } from './factors.js';
import { explainInsufficiency } from './explain.js';
import type { FactorOutcome } from './factor.js';
import type { FundamentalInputs } from './inputs.js';

export interface FundamentalEngineConfig extends FactorComputeConfig {
  readonly confidence: {
    readonly thresholds: ConfidenceThresholds;
    readonly insufficientCoverageFloor: number;
    readonly mediumCapCoverage: number;
    readonly weights: ConfidenceWeights;
  };
  readonly eventRisk: EventRiskConfig;
  readonly bands?: readonly BiasBand[];
}

interface ResultBase {
  readonly factors: readonly FactorOutcome[];
  readonly coverage: number;
  readonly abstained: readonly { readonly factorId: FactorId; readonly reason: string; readonly detail: string }[];
  readonly eventRisk: EventRiskResult;
  readonly degradedProviders: readonly string[];
  readonly computedAt: Date;
}

export interface ScoredResult extends ResultBase {
  readonly status: 'SCORED';
  readonly signedScore: number;
  readonly displayScore: number;
  readonly band: string;
  readonly bias: ScoredAggregation['bias'];
  readonly agreement: number;
  readonly confidence: ConfidenceResult;
  /** The AI may be given this result to describe. */
  readonly aiEligible: true;
}

export interface InsufficientResult extends ResultBase {
  readonly status: 'INSUFFICIENT_DATA';
  readonly reason: string;
  /**
   * The AI is not called. There is no score to describe, and a model asked to
   * comment on an absent number writes prose indistinguishable from a finding.
   */
  readonly aiEligible: false;
  // No score, no band, no bias, no confidence value.
}

export type FundamentalResult = ScoredResult | InsufficientResult;

export function runFundamentalEngine(
  inputs: FundamentalInputs,
  config: FundamentalEngineConfig,
  now: Date,
): FundamentalResult {
  const factors = computeAllFactors(inputs, config);

  const aggregation: FundamentalAggregation = aggregateFactors({
    factors,
    insufficientCoverageFloor: config.confidence.insufficientCoverageFloor,
    ...(config.bands === undefined ? {} : { bands: config.bands }),
  });

  // Assessed on both branches. A thin run still owes the user this warning.
  const eventRisk = assessEventRisk(inputs.upcomingReleases, now, config.eventRisk);

  const base: ResultBase = {
    factors,
    coverage: aggregation.coverage,
    abstained: aggregation.abstained,
    eventRisk,
    degradedProviders: inputs.degradedProviders,
    computedAt: now,
  };

  if (aggregation.status === 'INSUFFICIENT_DATA') {
    return {
      ...base,
      status: 'INSUFFICIENT_DATA',
      reason: explainInsufficiency(
        aggregation.coverage,
        config.confidence.insufficientCoverageFloor,
        aggregation.abstained.map((a) => `${a.factorId} (${a.detail})`),
      ),
      aiEligible: false,
    };
  }

  const confidence = computeConfidence({
    coverage: aggregation.coverage,
    agreement: aggregation.agreement,
    factors,
    weights: config.confidence.weights,
    thresholds: config.confidence.thresholds,
    mediumCapCoverage: config.confidence.mediumCapCoverage,
    eventRiskImminent: eventRisk.imminent,
    degradedProviders: inputs.degradedProviders,
  });

  return {
    ...base,
    status: 'SCORED',
    signedScore: aggregation.signedScore,
    displayScore: aggregation.displayScore,
    band: aggregation.band,
    bias: aggregation.bias,
    agreement: aggregation.agreement,
    confidence,
    aiEligible: true,
  };
}
