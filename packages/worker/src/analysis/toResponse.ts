/**
 * Stored analysis → API response.
 *
 * The one place a database row becomes something a user reads, and therefore the last
 * place the product's invariants can be enforced before they become a number on a
 * screen. The output is parsed through `analysisResponseSchema` before it is returned,
 * so a mapping bug fails here rather than rendering.
 *
 * That validation is not belt-and-braces. The failures this product cares about all
 * look structurally fine — a score attached to an insufficient run, a factor carrying
 * both a reading and an abstention reason, a value whose provenance was dropped in a
 * join. None of them throws on its own; each just renders something untrue.
 */

import { asc, desc, eq, type SQL } from 'drizzle-orm';
import { SCORE_DESCRIPTIVE_CAVEAT, type SourceTier } from '@forex-agent/core';
import {
  analysisResponseSchema,
  type AnalysisResponse,
  type FactorView,
  type Limitation,
  type Provenance,
} from '@forex-agent/contracts';
import {
  aiGenerations,
  analyses,
  analysisStatements,
  assets,
  fundamentalFactors,
  type Database,
} from '@forex-agent/db';

/** Provenance as recorded on a factor's `factRefs`, before it is widened for display. */
interface StoredFactRef {
  readonly table: string;
  readonly id: string;
  readonly label: string;
  readonly freshness: Provenance['freshness'];
  readonly sourceTier: SourceTier;
}

export class AnalysisNotFoundError extends Error {
  constructor(target: string) {
    super(`No stored analysis for ${target}`);
    this.name = 'AnalysisNotFoundError';
  }
}

/** The newest stored run for an asset — what the dashboard shows. */
export async function latestAnalysisResponse(
  db: Database,
  assetSymbol: string,
): Promise<AnalysisResponse> {
  return buildResponse(db, eq(assets.symbol, assetSymbol), assetSymbol);
}

/**
 * One stored run, by id.
 *
 * Shares every line of its mapping with the dashboard's query, which is the point: a
 * separate "report" mapper would be a second chance to disagree about what a run said,
 * and the version people trusted would be whichever they happened to open.
 */
export async function analysisResponseById(
  db: Database,
  analysisId: string,
): Promise<AnalysisResponse> {
  return buildResponse(db, eq(analyses.id, analysisId), analysisId);
}

async function buildResponse(
  db: Database,
  where: SQL,
  describeTarget: string,
): Promise<AnalysisResponse> {
  const [row] = await db
    .select({
      id: analyses.id,
      symbol: assets.symbol,
      status: analyses.status,
      runAt: analyses.runAt,
      coverage: analyses.coverage,
      score: analyses.fundamentalScore,
      bias: analyses.fundamentalBias,
      confidence: analyses.confidence,
      confidenceScore: analyses.confidenceScore,
      confidenceBreakdown: analyses.confidenceBreakdown,
      unavailableInputs: analyses.unavailableInputs,
      evidenceBundle: analyses.evidenceBundle,
    })
    .from(analyses)
    .innerJoin(assets, eq(assets.id, analyses.assetId))
    .where(where)
    // Newest first. `asc` here returned the OLDEST stored analysis, so the dashboard
    // would have shown the first run ever made and gone on showing it forever.
    .orderBy(desc(analyses.runAt))
    .limit(1);

  if (row === undefined) throw new AnalysisNotFoundError(describeTarget);

  const factorRows = await db
    .select()
    .from(fundamentalFactors)
    .where(eq(fundamentalFactors.analysisId, row.id))
    .orderBy(asc(fundamentalFactors.factorId));

  const statementRows = await db
    .select()
    .from(analysisStatements)
    .where(eq(analysisStatements.analysisId, row.id))
    .orderBy(asc(analysisStatements.ordinal));

  const [generation] = await db
    .select()
    .from(aiGenerations)
    .where(eq(aiGenerations.analysisId, row.id))
    .limit(1);

  const bundle = row.evidenceBundle as
    | { readonly factors?: readonly { readonly id: string; readonly limitations?: unknown; readonly abstentionReason?: string; readonly attribution?: string }[]; readonly facts?: readonly { readonly id: string; readonly publicationLagDays?: number }[] }
    | null;

  /**
   * Publication lag comes from the bundle, which computed it at analysis time.
   *
   * Recomputing it here from timestamps would be a third implementation of the same
   * rule, after `assessFreshnessOnCalendar` and the bundle builder. The bundle is the
   * snapshot of what the run actually saw, which is also what a re-opened report must
   * show — today's lag on a three-month-old report would be a different number.
   */
  const lagByFactId = new Map<string, number>();
  for (const fact of bundle?.facts ?? []) {
    if (typeof fact.publicationLagDays === 'number') lagByFactId.set(fact.id, fact.publicationLagDays);
  }

  const limitationsByFactor = new Map<string, Limitation[]>();
  const attributionByFactor = new Map<string, string>();
  for (const f of bundle?.factors ?? []) {
    if (f.limitations !== undefined) limitationsByFactor.set(f.id, [...(f.limitations as readonly Limitation[])]);
    if (f.attribution !== undefined) attributionByFactor.set(f.id, f.attribution);
  }

  /**
   * Real publication timestamps, from the FACT statements.
   *
   * `fundamental_factors.fact_refs` carries only the identity of each fact — table,
   * id, label, tier, freshness — not when it was published. An earlier version filled
   * the gap with the analysis `run_at`, which rendered as *"Nominal Broad U.S. Dollar
   * Index · published 2026-09-05"* for a figure published on 2026-08-24.
   *
   * That is not a cosmetic slip. The provenance expander exists so a reader can check
   * where a number came from, and a false publication date there is worse than no date
   * at all: it converts the one place designed to be verifiable into a confident
   * misstatement. The FACT statements hold the real timestamps, so they are joined by
   * `fact_id` and a ref without a matching statement is dropped rather than dated with
   * a guess.
   */
  const provenanceByFactId = new Map<string, Provenance>();
  for (const s of statementRows) {
    if (s.layer !== 'FACT' || s.factId === null || s.sourceName === null) continue;
    provenanceByFactId.set(s.factId, {
      factTable: s.factTable ?? 'unknown',
      factId: s.factId,
      sourceName: s.sourceName,
      sourceTier: (s.sourceTier ?? 4) as SourceTier,
      sourceUrl: s.sourceUrl,
      publishedAt: (s.sourceTimestamp ?? row.runAt).toISOString(),
      retrievedAt: (s.retrievedAt ?? row.runAt).toISOString(),
      freshness: s.freshness ?? 'UNAVAILABLE',
      publicationLagDays: lagByFactId.get(s.factId) ?? null,
    });
  }

  const factors: FactorView[] = factorRows.map((f) => {
    const refs = (f.factRefs as readonly StoredFactRef[] | null) ?? [];
    const provenance: Provenance[] = refs
      .map((ref) => provenanceByFactId.get(ref.id))
      .filter((p): p is Provenance => p !== undefined);

    if (f.abstainedReason === null && f.score !== null) {
      return {
        kind: 'SCORED',
        factorId: f.factorId,
        factorName: f.factorName,
        weight: f.weight,
        explanation: f.explanation,
        freshness: f.freshness,
        provenance,
        score: f.score,
        direction: f.direction,
        zScore: f.zScore ?? 0,
        effectiveWeight: f.effectiveWeight,
        confidence: f.confidence,
        // Recomputed from the stored weight and effective weight rather than stored
        // separately: two columns that must agree are two columns that can disagree.
        inputCompleteness: f.weight > 0 ? Math.min(1, f.effectiveWeight / f.weight) : 0,
        limitations: limitationsByFactor.get(f.factorId) ?? [],
      } satisfies Extract<FactorView, { kind: 'SCORED' }>;
    }

    const [reason, ...detail] = (f.abstainedReason ?? 'INPUT_MISSING: no reading').split(': ');
    return {
      kind: 'ABSTAINED',
      factorId: f.factorId,
      factorName: f.factorName,
      weight: f.weight,
      explanation: f.explanation,
      freshness: f.freshness,
      provenance,
      reason: reason ?? 'INPUT_MISSING',
      detail: detail.join(': ') || 'no reading',
      attribution: attributionByFactor.get(f.factorId) ?? 'WORLD',
    } as FactorView;
  });

  const statements = statementRows.map((s) => ({
    id: s.id,
    layer: s.layer,
    ordinal: s.ordinal,
    body: s.body,
    derivedFrom: s.derivedFrom,
    provenance:
      s.factId === null || s.sourceName === null
        ? null
        : ({
            factTable: s.factTable ?? 'unknown',
            factId: s.factId,
            sourceName: s.sourceName,
            sourceTier: (s.sourceTier ?? 4) as SourceTier,
            sourceUrl: s.sourceUrl,
            publishedAt: (s.sourceTimestamp ?? row.runAt).toISOString(),
            retrievedAt: (s.retrievedAt ?? row.runAt).toISOString(),
            freshness: s.freshness ?? 'UNAVAILABLE',
            publicationLagDays: lagByFactId.get(s.factId) ?? null,
          } satisfies Provenance),
    aiGenerationId: s.aiGenerationId,
  }));

  const base = {
    id: row.id,
    asset: row.symbol,
    runAt: row.runAt.toISOString(),
    coverage: row.coverage ?? 0,
    factors,
    statements,
    eventRisk: [],
    unavailableInputs: row.unavailableInputs,
    degradedProviders: [],
  };

  if (row.status === 'INSUFFICIENT_DATA' || row.score === null) {
    return analysisResponseSchema.parse({
      ...base,
      status: 'INSUFFICIENT_DATA',
      reason:
        'Factor coverage was below the minimum required to publish a score, so none is reported.',
    });
  }

  const aiStatements = statements.filter((s) => s.layer === 'AI_ASSESSMENT');
  const breakdown = (row.confidenceBreakdown ?? {}) as Record<string, unknown>;

  return analysisResponseSchema.parse({
    ...base,
    status: 'SCORED',
    score: {
      signed: row.score,
      display: Math.round((row.score + 100) / 2),
      band: bandFor(row.score),
      bias: row.bias ?? 'NEUTRAL',
      // Attached here, from the shared constant, so no route can return a score
      // without it and no component has to remember to add it.
      caveat: SCORE_DESCRIPTIVE_CAVEAT,
    },
    confidence: {
      value: row.confidenceScore ?? 0,
      level: row.confidence ?? 'LOW',
      uncappedLevel: (breakdown.uncappedLevel as string | undefined) ?? row.confidence ?? 'LOW',
      caps: (breakdown.caps as string[] | undefined) ?? [],
      components: Object.fromEntries(
        Object.entries(breakdown).filter(([, v]) => typeof v === 'number'),
      ),
    },
    aiAssessment:
      aiStatements.length >= 2 && generation !== undefined
        ? {
            headline: aiStatements[0]?.body ?? '',
            summary: aiStatements[1]?.body ?? '',
            model: generation.model,
            generatedAt: generation.createdAt.toISOString(),
          }
        : null,
  });
}

/** Display bands from PRD_V1 §8.5.1, applied to the signed scale. */
function bandFor(signed: number): string {
  const display = Math.round((signed + 100) / 2);
  if (display >= 90) return 'Extremely Bullish';
  if (display >= 75) return 'Strong Bullish';
  if (display >= 60) return 'Bullish';
  if (display >= 45) return 'Neutral';
  if (display >= 30) return 'Bearish';
  if (display >= 15) return 'Strong Bearish';
  return 'Extremely Bearish';
}
