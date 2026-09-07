/**
 * The analysis payload, as the API returns it and the UI consumes it.
 *
 * Validated in *both* directions. Validating a response on the way out looks
 * redundant — the server built it — but it is the last place a value can be caught
 * before it becomes something a user reads and acts on, and the failures this product
 * cares about are precisely the ones that look fine: a score attached to an
 * insufficient run, a number without provenance, a factor carrying both a score and
 * an abstention reason.
 *
 * Two invariants are enforced here rather than left to the renderer:
 *
 * **No value without provenance.** Every rendered figure carries the fact it came
 * from. A component cannot display a number it cannot attribute, because the shape it
 * receives has no number that lacks a source.
 *
 * **No score without its caveat.** `SCORE_DESCRIPTIVE_CAVEAT` travels with the score
 * in the payload, so the UI cannot render one without the other by omission — the
 * caveat is not a prop a developer might forget to pass (Amendment A3).
 */

import { z } from 'zod';

export const freshnessSchema = z.enum(['LIVE', 'RECENT', 'STALE', 'UNAVAILABLE']);
export const sourceTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const attributionSchema = z.enum(['WORLD', 'CONFIGURATION', 'STRUCTURAL']);

/**
 * Provenance travels with every value.
 *
 * Not optional, and not nullable. The moment it is either, a renderer acquires a
 * branch for "value without source" and the invariant becomes a convention.
 */
export const provenanceSchema = z.object({
  factTable: z.string().min(1),
  factId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceTier: sourceTierSchema,
  sourceUrl: z.url().nullable(),
  publishedAt: z.iso.datetime(),
  retrievedAt: z.iso.datetime(),
  freshness: freshnessSchema,
  /** Where publication lags the period described — F1's H.10 case (PRD_V1 §8.5.2a). */
  publicationLagDays: z.number().int().nonnegative().nullable(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/** A figure the UI may render, inseparable from where it came from. */
export const provenancedValueSchema = z.object({
  label: z.string().min(1),
  value: z.number().nullable(),
  unit: z.string(),
  provenance: provenanceSchema,
});
export type ProvenancedValue = z.infer<typeof provenancedValueSchema>;

export const limitationSchema = z.object({
  attribution: attributionSchema,
  missing: z.string().min(1),
  reason: z.string().min(1),
  resolution: z.string().nullable(),
});
export type Limitation = z.infer<typeof limitationSchema>;

const factorBaseSchema = z.object({
  factorId: z.string().regex(/^F[1-8]$/),
  factorName: z.string().min(1),
  weight: z.number().min(0).max(1),
  explanation: z.string().min(1),
  freshness: freshnessSchema,
  provenance: z.array(provenanceSchema),
});

/**
 * A factor is one of two shapes, mirroring the engine's own union.
 *
 * The API could have flattened this to nullable fields for convenience. It does not,
 * because a flattened factor lets a renderer read `score ?? 0` and produce a neutral
 * reading from an absence — the single failure this product is built to prevent, one
 * `??` away.
 */
export const factorSchema = z.discriminatedUnion('kind', [
  factorBaseSchema.extend({
    kind: z.literal('SCORED'),
    score: z.number().min(-100).max(100),
    direction: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
    zScore: z.number(),
    effectiveWeight: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    inputCompleteness: z.number().min(0).max(1),
    limitations: z.array(limitationSchema),
  }),
  factorBaseSchema.extend({
    kind: z.literal('ABSTAINED'),
    reason: z.string().min(1),
    detail: z.string().min(1),
    /** What the UI groups on: the world's gap, our defect, or a free-tier limit. */
    attribution: attributionSchema,
  }),
]);
export type FactorView = z.infer<typeof factorSchema>;

export const eventRiskSchema = z.object({
  eventName: z.string().min(1),
  country: z.string().min(1),
  scheduledAt: z.iso.datetime(),
  minutesUntil: z.number().int(),
  imminent: z.boolean(),
  caution: z.string().min(1),
});

export const statementSchema = z.object({
  id: z.string().min(1),
  layer: z.enum(['FACT', 'INTERPRETATION', 'AI_ASSESSMENT']),
  ordinal: z.number().int().nonnegative(),
  body: z.string().min(1),
  derivedFrom: z.array(z.string()),
  provenance: provenanceSchema.nullable(),
  aiGenerationId: z.string().nullable(),
});
export type StatementView = z.infer<typeof statementSchema>;

const analysisBaseSchema = z.object({
  id: z.string().min(1),
  asset: z.string().min(1),
  runAt: z.iso.datetime(),
  coverage: z.number().min(0).max(1),
  factors: z.array(factorSchema).length(8),
  statements: z.array(statementSchema),
  eventRisk: z.array(eventRiskSchema),
  /** Named, never silently dropped. */
  unavailableInputs: z.array(z.string()),
  degradedProviders: z.array(z.string()),
});

/**
 * The response shape.
 *
 * `INSUFFICIENT_DATA` has no `score` key — not a null one — so a component cannot
 * read a score that does not exist, and `JSON.stringify` cannot produce one either.
 * The union is the same guarantee the engine and the database each make separately;
 * this is the third place it holds, which is the point.
 */
export const analysisResponseSchema = z.discriminatedUnion('status', [
  analysisBaseSchema.extend({
    status: z.literal('SCORED'),
    score: z.object({
      signed: z.number().min(-100).max(100),
      display: z.number().min(0).max(100),
      band: z.string().min(1),
      bias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL', 'MIXED']),
      /**
       * Carried in the payload, not applied by the renderer.
       *
       * Amendment A3 requires that no score is presented as a forecast. A caveat the
       * UI is *supposed* to add is a caveat that goes missing in the second component
       * that renders a score; a caveat travelling inside the score object cannot.
       */
      caveat: z.string().min(1),
    }),
    confidence: z.object({
      value: z.number().min(0).max(100),
      level: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      uncappedLevel: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      caps: z.array(z.string()),
      components: z.record(z.string(), z.number()),
    }),
    aiAssessment: z
      .object({
        headline: z.string().min(1),
        summary: z.string().min(1),
        model: z.string().min(1),
        generatedAt: z.iso.datetime(),
      })
      .nullable(),
  }),
  analysisBaseSchema.extend({
    status: z.literal('INSUFFICIENT_DATA'),
    reason: z.string().min(1),
  }),
]);
export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;

export function isScoredAnalysis(
  a: AnalysisResponse,
): a is Extract<AnalysisResponse, { status: 'SCORED' }> {
  return a.status === 'SCORED';
}
