/**
 * The shape the model must return, and the shape we will accept.
 *
 * Two representations of one contract, deliberately kept separate:
 *
 * - `GEMINI_RESPONSE_SCHEMA` is sent to the API as `responseSchema`, which constrains
 *   generation. Verified working on the free tier on 2026-08-30.
 * - `assessmentSchema` is the Zod parse applied to whatever actually comes back.
 *
 * The second is not redundant. A provider-side schema constrains *structure* and
 * nothing else — it cannot know that `factorsCited` must name factors that exist in
 * this run, or that a number must appear in the evidence bundle. And a provider that
 * silently stops honouring `responseSchema` (Gemini already returns errors as HTTP
 * 200 bodies, and `gemini-2.5-flash` 404s despite being listed) must not be able to
 * put unvalidated text in front of a user. **The API's guarantee is an optimisation;
 * ours is the guarantee.**
 */

import { z } from 'zod';

/** Sent to Gemini as `responseSchema`. Deliberately minimal — OpenAPI subset only. */
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' },
    keyDrivers: {
      type: 'array',
      // Observed 2026-09-05: without these bounds the model returned six drivers and
      // our Zod parse rejected the response. Gemini honours `responseSchema` for
      // structure but did not constrain array length until it was stated — which is
      // the case for keeping our own validation as the guarantee rather than trusting
      // the provider's.
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          factorId: { type: 'string' },
          statement: { type: 'string' },
        },
        required: ['factorId', 'statement'],
      },
    },
    dataGaps: { type: 'array', maxItems: 10, items: { type: 'string' } },
    factorsCited: { type: 'array', maxItems: 8, items: { type: 'string' } },
  },
  required: ['headline', 'summary', 'keyDrivers', 'dataGaps', 'factorsCited'],
} as const;

export const FACTOR_ID_PATTERN = /^F[1-8]$/;

export const assessmentSchema = z.object({
  /** One line. Long enough to say something, short enough not to editorialise. */
  headline: z.string().trim().min(10).max(160),
  summary: z.string().trim().min(40).max(1200),
  keyDrivers: z
    .array(
      z.object({
        factorId: z.string().regex(FACTOR_ID_PATTERN, 'factorId must be F1..F8'),
        statement: z.string().trim().min(10).max(400),
      }),
    )
    .min(1)
    .max(5),
  /**
   * What the model was told is missing, restated in its own words.
   *
   * Required and non-optional: a model that may omit this will omit it, and a summary
   * that never mentions absent factors reads as though the picture were complete.
   */
  dataGaps: z.array(z.string().trim().min(3).max(300)).max(10),
  factorsCited: z.array(z.string().regex(FACTOR_ID_PATTERN)).max(8),
});

export type Assessment = z.infer<typeof assessmentSchema>;

/** The prompt is versioned so a stored generation can be reproduced. */
export const PROMPT_NAME = 'fundamental-assessment';
export const PROMPT_VERSION = '1';
export const GUARD_VERSION = '1';
