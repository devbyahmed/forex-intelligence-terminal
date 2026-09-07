/**
 * Storing an analysis, with its lineage.
 *
 * Amendment A2 says every rendered claim must be traceable to the evidence beneath
 * it. `analysis_statements` is where that stops being a convention: a FACT without
 * provenance, an INTERPRETATION without a parent, or an AI_ASSESSMENT without the
 * generation that produced it are rejected by CHECK constraints and by a trigger that
 * also verifies every parent belongs to the same analysis and to a **strictly lower**
 * layer.
 *
 * That last rule shapes the graph written here. An INTERPRETATION cannot derive from
 * another INTERPRETATION, so the overall reading derives directly from the FACT rows
 * rather than from the per-factor interpretations. This is the honest description
 * anyway: the score is a weighted function of the measured facts, and routing it
 * through the factor prose would imply the prose was an input to the arithmetic when
 * it is a description of it.
 *
 * The layers written, in order:
 *
 * ```
 * FACT             one per stored observation the run consumed, with full provenance
 *   └── INTERPRETATION   one per scored factor, plus one for the overall reading
 *         └── AI_ASSESSMENT   only if the model answered and survived the guards
 * ```
 *
 * Everything happens in one transaction. A half-written analysis — factors stored,
 * statements missing — would render as a score with no traceable evidence, which is
 * the exact state A2 exists to make impossible.
 */


import { uuidv7, type SourceTier } from '@forex-agent/core';
import {
  aiGenerations,
  analyses,
  analysisStatements,
  fundamentalFactors,
  type Database,
} from '@forex-agent/db';
import { isScored, type FundamentalResult } from '@forex-agent/engines';
import type { Assessment, GuardViolation } from '@forex-agent/ai';
import type { EvidenceBundle, FactSource } from './evidenceBundle.js';

export interface AiOutcome {
  readonly providerId: string;
  readonly model: string;
  readonly promptName: string;
  readonly promptVersion: string;
  readonly guardVersion: string;
  readonly outcome: 'VALID' | 'VALID_AFTER_RETRY' | 'INVALID' | 'PROVIDER_ERROR';
  readonly retryCount: number;
  readonly rawResponse: unknown;
  readonly validationErrors: readonly (string | GuardViolation)[];
  readonly assessment?: Assessment;
  readonly promptTokens?: number | null;
  readonly responseTokens?: number | null;
  readonly latencyMs?: number | null;
}

export interface PersistParams {
  readonly assetId: string;
  readonly configProfileId: string;
  readonly result: FundamentalResult;
  readonly bundle: EvidenceBundle;
  readonly facts: readonly FactSource[];
  /** Absent when the AI was not called — an insufficient run never calls it. */
  readonly ai?: AiOutcome;
}

export interface PersistResult {
  readonly analysisId: string;
  readonly factStatements: number;
  readonly interpretationStatements: number;
  readonly aiStatements: number;
  readonly aiGenerationId: string | null;
}

export async function persistAnalysis(
  db: Database,
  params: PersistParams,
): Promise<PersistResult> {
  const { result, bundle } = params;

  return db.transaction(async (tx) => {
    const analysisId = uuidv7();

    await tx.insert(analyses).values({
      id: analysisId,
      assetId: params.assetId,
      mode: 'FUNDAMENTAL',
      status: statusFor(params),
      runAt: result.computedAt,
      configProfileId: params.configProfileId,
      // Null on an insufficient run — enforced independently by
      // `analyses_insufficient_has_no_score`, so a bug here is caught by the database
      // rather than published.
      fundamentalScore: result.status === 'SCORED' ? result.signedScore : null,
      fundamentalBias: result.status === 'SCORED' ? result.bias : null,
      confidence: result.status === 'SCORED' ? result.confidence.level : null,
      confidenceScore: result.status === 'SCORED' ? result.confidence.value : null,
      confidenceBreakdown:
        result.status === 'SCORED'
          ? { ...result.confidence.components, caps: result.confidence.caps, uncappedLevel: result.confidence.uncappedLevel }
          : null,
      coverage: result.coverage,
      evidenceBundle: bundle,
      unavailableInputs: result.abstained.map((a) => `${a.factorId}: ${a.reason}`),
    });

    // ── Per-factor rows ─────────────────────────────────────────────────────
    for (const f of result.factors) {
      await tx.insert(fundamentalFactors).values({
        id: uuidv7(),
        analysisId,
        factorId: f.factorId,
        factorName: f.factorName,
        direction: isScored(f) ? f.direction : 'NEUTRAL',
        score: isScored(f) ? f.score : null,
        rawSignal: isScored(f) ? f.rawSignal : null,
        zScore: isScored(f) ? f.zScore : null,
        weight: f.weight,
        effectiveWeight: isScored(f) ? f.weight * f.confidence : 0,
        confidence: isScored(f) ? f.confidence : 0,
        freshness: f.freshness,
        explanation: f.explanation,
        factRefs: f.factRefs,
        abstainedReason: isScored(f) ? null : `${f.reason}: ${f.detail}`,
      });
    }

    // ── Layer 1: FACT ───────────────────────────────────────────────────────
    let ordinal = 0;
    const factIdByFactId = new Map<string, string>();

    for (const fact of params.facts) {
      const statementId = uuidv7();
      factIdByFactId.set(fact.id, statementId);
      await tx.insert(analysisStatements).values({
        id: statementId,
        analysisId,
        layer: 'FACT',
        ordinal: ordinal++,
        body: factBody(fact),
        factTable: fact.table,
        factId: fact.id,
        sourceProvider: fact.sourceProvider,
        sourceName: fact.sourceName,
        sourceUrl: fact.sourceUrl ?? null,
        sourceTier: fact.sourceTier,
        sourceTimestamp: fact.sourceTimestamp,
        retrievedAt: fact.retrievedAt,
        freshness: fact.freshness,
        derivedFrom: [],
      });
    }

    const allFactStatementIds = [...factIdByFactId.values()];

    // ── Layer 2: INTERPRETATION ─────────────────────────────────────────────
    const interpretationIds: string[] = [];

    for (const f of result.factors) {
      // An abstaining factor still produces an interpretation: "this was not
      // measured, and here is why" is a claim about the run that the user needs, and
      // omitting it would leave the absence invisible in the lineage.
      const parents = f.factRefs
        .map((r) => factIdByFactId.get(r.id))
        .filter((id): id is string => id !== undefined);

      // The trigger requires at least one parent for a derived statement. A factor
      // that consumed nothing (F8 today) derives from the run's facts as a whole,
      // which is truthful: its absence is a property of this evidence set.
      const derivedFrom = parents.length > 0 ? parents : allFactStatementIds;
      if (derivedFrom.length === 0) continue;

      const statementId = uuidv7();
      interpretationIds.push(statementId);
      await tx.insert(analysisStatements).values({
        id: statementId,
        analysisId,
        layer: 'INTERPRETATION',
        ordinal: ordinal++,
        body: f.explanation,
        derivedFrom,
      });
    }

    if (allFactStatementIds.length > 0) {
      // The overall reading. Derives from the facts rather than from the factor
      // interpretations, because the trigger forbids same-layer parents — and because
      // it is the accurate description: the score is a function of the measurements.
      const overallId = uuidv7();
      interpretationIds.push(overallId);
      await tx.insert(analysisStatements).values({
        id: overallId,
        analysisId,
        layer: 'INTERPRETATION',
        ordinal: ordinal++,
        body: overallBody(result),
        derivedFrom: allFactStatementIds,
      });
    }

    // ── Layer 3: AI_ASSESSMENT ──────────────────────────────────────────────
    let aiGenerationId: string | null = null;
    let aiStatements = 0;

    if (params.ai !== undefined) {
      aiGenerationId = uuidv7();
      await tx.insert(aiGenerations).values({
        id: aiGenerationId,
        analysisId,
        providerId: params.ai.providerId,
        model: params.ai.model,
        promptName: params.ai.promptName,
        promptVersion: params.ai.promptVersion,
        outcome: params.ai.outcome,
        retryCount: params.ai.retryCount,
        // Stored whether it passed or failed. A rejected generation is the record of
        // a guard doing its job, and discarding it would leave nothing to audit.
        validationErrors:
          params.ai.validationErrors.length > 0 ? params.ai.validationErrors : null,
        guardVersion: params.ai.guardVersion,
        rawResponse: params.ai.rawResponse ?? null,
        promptTokens: params.ai.promptTokens ?? null,
        responseTokens: params.ai.responseTokens ?? null,
        latencyMs: params.ai.latencyMs ?? null,
      });

      // Statements are written ONLY for a generation that passed. A rejected response
      // is recorded in `ai_generations` and rendered nowhere.
      if (params.ai.outcome !== 'INVALID' && params.ai.outcome !== 'PROVIDER_ERROR') {
        const assessment = params.ai.assessment;
        if (assessment !== undefined && interpretationIds.length > 0) {
          for (const body of [assessment.headline, assessment.summary]) {
            await tx.insert(analysisStatements).values({
              id: uuidv7(),
              analysisId,
              layer: 'AI_ASSESSMENT',
              ordinal: ordinal++,
              body,
              derivedFrom: interpretationIds,
              aiGenerationId,
            });
            aiStatements += 1;
          }
        }
      }
    }

    return {
      analysisId,
      factStatements: allFactStatementIds.length,
      interpretationStatements: interpretationIds.length,
      aiStatements,
      aiGenerationId,
    };
  });
}

function statusFor(params: PersistParams): 'COMPLETE' | 'AI_UNAVAILABLE' | 'INSUFFICIENT_DATA' {
  if (params.result.status === 'INSUFFICIENT_DATA') return 'INSUFFICIENT_DATA';
  if (params.ai === undefined) return 'AI_UNAVAILABLE';
  // A rejected generation is not a complete analysis. The deterministic layers stand
  // on their own, but the run is recorded as having no usable AI layer rather than as
  // fully successful — otherwise a silent guard failure looks like a normal day.
  if (params.ai.outcome === 'INVALID' || params.ai.outcome === 'PROVIDER_ERROR') {
    return 'AI_UNAVAILABLE';
  }
  return 'COMPLETE';
}

function factBody(fact: FactSource): string {
  const value = fact.value === null ? 'no value published' : `${String(fact.value)}${fact.unit === '' ? '' : ` ${fact.unit}`}`;
  const period = fact.describesPeriod === undefined ? '' : ` for ${fact.describesPeriod}`;
  return `${fact.label}${period}: ${value} (${fact.sourceName}, tier ${String(fact.sourceTier)}, ${fact.freshness}).`;
}

function overallBody(result: FundamentalResult): string {
  if (result.status === 'INSUFFICIENT_DATA') return result.reason;
  return (
    `The fundamental reading is ${result.signedScore.toFixed(1)} on the signed −100…+100 scale ` +
    `(${String(result.displayScore)} on the 0–100 display scale, ${result.band}), computed from ` +
    `${String(result.factors.filter(isScored).length)} of ${String(result.factors.length)} factors ` +
    `at ${String(Math.round(result.coverage * 100))}% coverage. ` +
    `Confidence ${result.confidence.level} (${String(result.confidence.value)}). ` +
    'This describes current measured conditions and is not a forecast.'
  );
}

export type { SourceTier };
