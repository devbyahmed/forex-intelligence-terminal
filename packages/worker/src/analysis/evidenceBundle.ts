/**
 * The evidence bundle — everything the AI is allowed to know.
 *
 * This is the only channel through which facts reach the model. It is a plain value
 * built from stored rows, and the AI package cannot reach the database or the
 * providers (ARCHITECTURE §4.1), so **anything not in this object does not exist as
 * far as the model is concerned**. That is what makes hallucination detectable: a
 * number in the response that is not in the bundle was invented, and the semantic
 * guards can say so mechanically rather than by judgement.
 *
 * Three properties follow from that, and each one is load-bearing:
 *
 * **Every figure carries its provenance.** Source, tier, publication time, retrieval
 * time and freshness travel with the value, so the model is never handed a bare
 * number it might describe as more certain than it is.
 *
 * **Absences are stated, not omitted.** An abstaining factor appears in the bundle
 * with its reason. Dropping it would leave the model to infer a complete picture from
 * an incomplete one, and a model shown seven factors will write about seven factors as
 * though that were all of them.
 *
 * **The bundle is stored verbatim on the analysis row.** Re-reading a report from
 * three months ago shows exactly what the model saw, not what the pipeline would
 * produce today (master §35).
 */

import type {
  FactorOutcome,
  FundamentalResult,
  ScoredResult,
} from '@forex-agent/engines';
import { isScored } from '@forex-agent/engines';
import type { FreshnessStatus, SourceTier } from '@forex-agent/core';

/** A single fact, with the provenance that makes it citable. */
export interface EvidenceFact {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
  readonly source: string;
  readonly sourceTier: SourceTier;
  readonly publishedAt: string;
  readonly retrievedAt: string;
  readonly freshness: FreshnessStatus;
  /** Present where publication lags the period described — F1's H.10 case. */
  readonly describesPeriod?: string;
  readonly publicationLagDays?: number;
}

export interface EvidenceFactor {
  readonly id: string;
  readonly name: string;
  readonly scored: boolean;
  readonly score: number | null;
  readonly direction: string | null;
  readonly weight: number;
  readonly effectiveWeight: number;
  readonly freshness: FreshnessStatus;
  /** The deterministic explanation. The model may restate it; it may not replace it. */
  readonly explanation: string;
  /** Present only when the factor abstained. */
  readonly abstentionReason?: string;
  readonly abstentionDetail?: string;
  /** WORLD | CONFIGURATION | STRUCTURAL — why the gap exists, for grouping. */
  readonly attribution?: string;
  /** Sub-signals absent from a scored factor, in words the model must repeat. */
  readonly limitations?: readonly {
    readonly attribution: string;
    readonly missing: string;
    readonly reason: string;
    readonly resolution: string | null;
  }[];
  readonly rawSignal?: Readonly<Record<string, number | null>>;
}

export interface EvidenceBundle {
  readonly schemaVersion: '1';
  readonly asset: string;
  readonly runAt: string;
  readonly status: 'SCORED' | 'INSUFFICIENT_DATA';

  /** Absent on an insufficient run — there is no score for the model to describe. */
  readonly score?: {
    readonly signed: number;
    readonly display: number;
    readonly band: string;
    readonly bias: string;
  };
  readonly confidence?: {
    readonly value: number;
    readonly level: string;
    readonly caps: readonly string[];
  };

  readonly coverage: number;
  readonly factors: readonly EvidenceFactor[];
  readonly facts: readonly EvidenceFact[];
  readonly eventRisk: readonly {
    readonly eventName: string;
    readonly country: string;
    readonly scheduledAt: string;
    readonly minutesUntil: number;
    readonly imminent: boolean;
  }[];
  /** Named, never silently dropped (PRD_V1 §9.4). */
  readonly unavailableInputs: readonly string[];
  readonly degradedProviders: readonly string[];

  /**
   * Stated inside the bundle, not only in the prompt.
   *
   * A model that reads only the numbers will reach for predictive language, because
   * that is what financial prose does. Carrying the constraint alongside the data
   * means the instruction cannot be separated from the evidence it governs.
   */
  readonly constraints: readonly string[];
}

/**
 * Provenance for a stored fact.
 *
 * Carries more than the bundle renders: `table`, `sourceProvider` and `sourceUrl` are
 * not shown to the model — a URL in the bundle is something a model will happily cite
 * as though it had read it — but they are written to the FACT statement, which is what
 * the provenance expander follows back to the row.
 */
export interface FactSource {
  readonly id: string;
  /** The table the row lives in, for the expander. */
  readonly table: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
  readonly sourceProvider: string;
  readonly sourceName: string;
  readonly sourceUrl?: string;
  readonly sourceTier: SourceTier;
  readonly sourceTimestamp: Date;
  readonly retrievedAt: Date;
  readonly freshness: FreshnessStatus;
  readonly describesPeriod?: string;
}

export const BUNDLE_CONSTRAINTS: readonly string[] = [
  'Every number you state must appear verbatim in this bundle. Do not compute, round, ' +
    'infer, or estimate any figure that is not present.',
  'Scores describe current measured conditions. They are not forecasts and carry no ' +
    'measured predictive power. Do not say what will happen, what is likely, or what a ' +
    'reader should do.',
  'Factors listed as not scored were not measured. Do not treat an absent factor as ' +
    'neutral, and do not describe the picture as complete when factors are missing.',
  'Do not give trading advice, price targets, entry or exit levels, or position sizing.',
  'A factor carrying `limitations` was only partly measured. Say which part is missing ' +
    'when you describe it — never present a partial factor as a complete reading.',
];

export function buildEvidenceBundle(params: {
  readonly asset: string;
  readonly result: FundamentalResult;
  readonly facts: readonly FactSource[];
}): EvidenceBundle {
  const { result } = params;

  const factors: EvidenceFactor[] = result.factors.map((f) => toEvidenceFactor(f));

  const facts: EvidenceFact[] = params.facts.map((f) => {
    const lagDays =
      f.describesPeriod === undefined
        ? undefined
        : Math.round(
            (f.sourceTimestamp.getTime() - Date.parse(`${f.describesPeriod}T00:00:00Z`)) / 86_400_000,
          );
    return {
      id: f.id,
      label: f.label,
      value: f.value,
      unit: f.unit,
      source: f.sourceName,
      sourceTier: f.sourceTier,
      publishedAt: f.sourceTimestamp.toISOString(),
      retrievedAt: f.retrievedAt.toISOString(),
      freshness: f.freshness,
      ...(f.describesPeriod === undefined ? {} : { describesPeriod: f.describesPeriod }),
      // Disclosed rather than left implicit: F1 reads last week's dollar, and a model
      // describing it as "current" would be wrong in a way the user cannot detect.
      ...(lagDays === undefined || lagDays < 3 ? {} : { publicationLagDays: lagDays }),
    };
  });

  const base = {
    schemaVersion: '1' as const,
    asset: params.asset,
    runAt: result.computedAt.toISOString(),
    coverage: round(result.coverage, 4),
    factors,
    facts,
    eventRisk: result.eventRisk.warnings.map((w) => ({
      eventName: w.eventName,
      country: w.country,
      scheduledAt: w.scheduledAt.toISOString(),
      minutesUntil: w.minutesUntil,
      imminent: w.imminent,
    })),
    unavailableInputs: result.abstained.map((a) => `${a.factorId}: ${a.detail}`),
    degradedProviders: result.degradedProviders,
    constraints: BUNDLE_CONSTRAINTS,
  };

  if (result.status === 'INSUFFICIENT_DATA') {
    // No score key at all. The AI is not called on this branch, but the bundle is
    // still stored, and a bundle carrying a null score would invite a later reader —
    // human or model — to treat the null as a value.
    return { ...base, status: 'INSUFFICIENT_DATA' };
  }

  const scored: ScoredResult = result;
  return {
    ...base,
    status: 'SCORED',
    score: {
      signed: round(scored.signedScore, 2),
      display: scored.displayScore,
      band: scored.band,
      bias: scored.bias,
    },
    confidence: {
      value: scored.confidence.value,
      level: scored.confidence.level,
      caps: scored.confidence.caps,
    },
  };
}

function toEvidenceFactor(f: FactorOutcome): EvidenceFactor {
  if (isScored(f)) {
    return {
      id: f.factorId,
      name: f.factorName,
      scored: true,
      score: round(f.score, 2),
      direction: f.direction,
      weight: f.weight,
      effectiveWeight: round(f.weight * f.confidence, 4),
      freshness: f.freshness,
      explanation: f.explanation,
      rawSignal: roundSignal(f.rawSignal),
      ...(f.limitations.length === 0 ? {} : { limitations: f.limitations }),
    };
  }
  return {
    id: f.factorId,
    name: f.factorName,
    scored: false,
    // Null, not zero. The bundle must not offer the model a number to average.
    score: null,
    direction: null,
    weight: f.weight,
    effectiveWeight: 0,
    freshness: f.freshness,
    explanation: f.explanation,
    abstentionReason: f.reason,
    abstentionDetail: f.detail,
    attribution: f.attribution,
  };
}

/**
 * Rounded before the model sees them.
 *
 * The guards check that every number in the response appears in the bundle. If the
 * bundle carried `-7.148936170212766` and the model wrote `-7.15`, a strict check
 * would call a correct restatement a fabrication. Rounding here makes the bundle the
 * literal vocabulary of permitted figures.
 */
function round(v: number, dp: number): number {
  const f = 10 ** dp;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

function roundSignal(
  raw: Readonly<Record<string, number | null>>,
): Readonly<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v === null ? null : round(v, 2);
  return out;
}
