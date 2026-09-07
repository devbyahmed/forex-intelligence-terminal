/**
 * Analysis storage, including the Amendment A2 three-layer model.
 *
 * `analysis_statements` is where A2 stops being a formatting convention. A FACT row
 * without provenance, an INTERPRETATION without a parent, or an AI_ASSESSMENT
 * without the generation that produced it are all rejected by the database — not by
 * a code path someone can forget to call.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  aiValidationOutcome,
  analysisMode,
  analysisStatus,
  biasDirection,
  confidenceLevel,
  factorDirection,
  freshnessStatus,
  statementLayer,
} from './enums.js';
import { fkId, primaryId, timestamps } from './columns.js';
import { assets, configProfiles } from './reference.js';

/**
 * One generated analysis.
 *
 * Technical, news and overall columns exist from V1 as nullable. V2 and V3 populate
 * them; until then they stay null rather than holding a placeholder, because a
 * fabricated technical score would violate the anti-hallucination requirement just
 * as surely as an invented price would.
 */
export const analyses = pgTable(
  'analyses',
  {
    id: primaryId(),
    assetId: fkId('asset_id', () => assets.id)
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    mode: analysisMode('mode').notNull(),
    status: analysisStatus('status').notNull(),
    runAt: timestamp('run_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    /** The profile this ran under — what makes an old report re-renderable. */
    configProfileId: fkId('config_profile_id', () => configProfiles.id)
      .notNull()
      .references(() => configProfiles.id),

    /** Canonical signed scale, −100..+100. Null when status is INSUFFICIENT_DATA. */
    fundamentalScore: real('fundamental_score'),
    newsScore: real('news_score'),
    technicalScore: real('technical_score'), // V2
    overallScore: real('overall_score'), // V3

    fundamentalBias: biasDirection('fundamental_bias'),
    technicalBias: biasDirection('technical_bias'), // V2
    overallBias: biasDirection('overall_bias'), // V3

    confidence: confidenceLevel('confidence'),
    confidenceScore: real('confidence_score'),
    /** Component breakdown: coverage, source quality, agreement, freshness, caps. */
    confidenceBreakdown: jsonb('confidence_breakdown'),

    /** Share of factor weight backed by usable data. Below the floor → no score. */
    coverage: real('coverage'),

    regime: text('regime'), // V2

    /** Complete provenance-carrying snapshot of what the analysis saw. */
    evidenceBundle: jsonb('evidence_bundle'),

    /** Named inputs that could not be resolved. Rendered, never silently dropped. */
    unavailableInputs: text('unavailable_inputs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    ...timestamps(),
  },
  (t) => [
    index('analyses_asset_run_idx').on(t.assetId, t.runAt.desc()),
    index('analyses_status_idx').on(t.status),
    check(
      'analyses_fundamental_score_range',
      sql`${t.fundamentalScore} is null or ${t.fundamentalScore} between -100 and 100`,
    ),
    check(
      'analyses_news_score_range',
      sql`${t.newsScore} is null or ${t.newsScore} between -100 and 100`,
    ),
    check(
      'analyses_technical_score_range',
      sql`${t.technicalScore} is null or ${t.technicalScore} between -100 and 100`,
    ),
    check(
      'analyses_overall_score_range',
      sql`${t.overallScore} is null or ${t.overallScore} between -100 and 100`,
    ),
    check('analyses_coverage_range', sql`${t.coverage} is null or ${t.coverage} between 0 and 1`),
    // An insufficient-data run must not carry a score. This is the schema-level
    // guarantee behind the abstention rule (PRD_V1 §8.5.4).
    check(
      'analyses_insufficient_has_no_score',
      sql`${t.status} <> 'INSUFFICIENT_DATA' or ${t.fundamentalScore} is null`,
    ),
  ],
);

/** Per-factor breakdown. Master §12 requires all seven attributes; all are here. */
export const fundamentalFactors = pgTable(
  'fundamental_factors',
  {
    id: primaryId(),
    analysisId: fkId('analysis_id', () => analyses.id)
      .notNull()
      .references(() => analyses.id, { onDelete: 'cascade' }),
    /** 'F1'..'F8'. */
    factorId: text('factor_id').notNull(),
    factorName: text('factor_name').notNull(),

    direction: factorDirection('direction').notNull(),
    /** Null when the factor abstained — distinct from a score of zero. */
    score: real('score'),
    rawSignal: jsonb('raw_signal'),
    zScore: real('z_score'),

    weight: real('weight').notNull(),
    /** weight × confidence. Zero when abstaining, which is how abstention works. */
    effectiveWeight: real('effective_weight').notNull(),
    confidence: real('confidence').notNull(),
    freshness: freshnessStatus('freshness').notNull(),

    /** Template-generated from real values — never AI prose. */
    explanation: text('explanation').notNull(),
    /** Ids of the fact rows consumed, for the provenance expander. */
    factRefs: jsonb('fact_refs').notNull(),

    /** Set when the factor could not be computed, e.g. 'DFII10 UNAVAILABLE'. */
    abstainedReason: text('abstained_reason'),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('fundamental_factors_analysis_factor_idx').on(t.analysisId, t.factorId),
    check(
      'fundamental_factors_score_range',
      sql`${t.score} is null or ${t.score} between -100 and 100`,
    ),
    check('fundamental_factors_weight_range', sql`${t.weight} between 0 and 1`),
    check('fundamental_factors_confidence_range', sql`${t.confidence} between 0 and 1`),
    // An abstaining factor must carry no score and no weight; otherwise a missing
    // input would still move the total.
    check(
      'fundamental_factors_abstain_coherent',
      sql`(${t.abstainedReason} is null and ${t.score} is not null)
        or (${t.abstainedReason} is not null and ${t.score} is null and ${t.effectiveWeight} = 0)`,
    ),
  ],
);

/** One AI call: what was asked, what came back, and whether it survived validation. */
export const aiGenerations = pgTable(
  'ai_generations',
  {
    id: primaryId(),
    analysisId: fkId('analysis_id', () => analyses.id).references(() => analyses.id, {
      onDelete: 'cascade',
    }),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    promptName: text('prompt_name').notNull(),
    promptVersion: text('prompt_version').notNull(),

    outcome: aiValidationOutcome('outcome').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    /** Which guards fired, so a rejection is explainable after the fact. */
    validationErrors: jsonb('validation_errors'),
    /** Version of the A3 prohibited-claim ruleset applied. */
    guardVersion: text('guard_version'),

    rawResponse: jsonb('raw_response'),
    promptTokens: integer('prompt_tokens'),
    responseTokens: integer('response_tokens'),
    latencyMs: integer('latency_ms'),

    ...timestamps(),
  },
  (t) => [
    index('ai_generations_analysis_idx').on(t.analysisId),
    index('ai_generations_outcome_idx').on(t.outcome),
  ],
);

/**
 * Amendment A2 — the three-layer model as a constrained table.
 *
 * The CHECK constraints below are the requirement. A companion trigger (see the
 * handwritten migration) additionally enforces that every parent in `derivedFrom`
 * belongs to the same analysis and to a strictly lower layer, which keeps the
 * lineage graph acyclic and layered by construction.
 */
export const analysisStatements = pgTable(
  'analysis_statements',
  {
    id: primaryId(),
    analysisId: fkId('analysis_id', () => analyses.id)
      .notNull()
      .references(() => analyses.id, { onDelete: 'cascade' }),
    layer: statementLayer('layer').notNull(),
    ordinal: integer('ordinal').notNull(),
    body: text('body').notNull(),

    // FACT lineage: points at a stored fact row and carries its provenance.
    factTable: text('fact_table'),
    factId: uuid('fact_id'),
    sourceProvider: text('source_provider'),
    sourceName: text('source_name'),
    sourceUrl: text('source_url'),
    sourceTier: smallint('source_tier'),
    sourceTimestamp: timestamp('source_timestamp', { withTimezone: true, mode: 'date' }),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true, mode: 'date' }),
    freshness: freshnessStatus('freshness'),

    // INTERPRETATION / AI_ASSESSMENT lineage.
    derivedFrom: uuid('derived_from')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    aiGenerationId: fkId('ai_generation_id', () => aiGenerations.id).references(
      () => aiGenerations.id,
      { onDelete: 'set null' },
    ),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('analysis_statements_order_idx').on(t.analysisId, t.layer, t.ordinal),
    index('analysis_statements_analysis_idx').on(t.analysisId),

    // A fact without provenance is indistinguishable from an invention.
    check(
      'fact_requires_provenance',
      sql`${t.layer} <> 'FACT' or (
        ${t.factTable} is not null and ${t.factId} is not null
        and ${t.sourceProvider} is not null and ${t.sourceName} is not null
        and ${t.sourceTier} is not null and ${t.sourceTimestamp} is not null
        and ${t.retrievedAt} is not null and ${t.freshness} is not null
      )`,
    ),
    // A fact is observed, not derived.
    check(
      'fact_has_no_derivation',
      sql`${t.layer} <> 'FACT' or cardinality(${t.derivedFrom}) = 0`,
    ),
    // An interpretation or assessment with no parent is an assertion from nowhere.
    check(
      'derived_requires_parents',
      sql`${t.layer} = 'FACT' or cardinality(${t.derivedFrom}) >= 1`,
    ),
    check(
      'ai_requires_generation',
      sql`${t.layer} <> 'AI_ASSESSMENT' or ${t.aiGenerationId} is not null`,
    ),
    // Equally important in the other direction: a deterministic statement must not
    // be attributable to the model.
    check(
      'non_ai_has_no_generation',
      sql`${t.layer} = 'AI_ASSESSMENT' or ${t.aiGenerationId} is null`,
    ),
    check(
      'statement_source_tier_valid',
      sql`${t.sourceTier} is null or ${t.sourceTier} between 1 and 4`,
    ),
  ],
);
