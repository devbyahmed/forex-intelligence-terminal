/**
 * The analysis job — collect, score, interpret, persist.
 *
 * Until Phase 12 this sequence existed only inside `scripts/checkpoint.mjs`, assembled
 * by hand on each invocation. That was enough to demonstrate the pipeline and not enough
 * to deploy it: a scheduled tick would have ingested data all day and produced no
 * analysis, and the report job would then have found nothing to report — a system that
 * looks alive from every angle except the one that matters.
 *
 * The ordering is the product's ordering, and it is deliberate:
 *
 *  1. **Collect deterministically.** Every input is read from stored facts with its own
 *     provenance; nothing is fetched here.
 *  2. **Score deterministically.** The engine runs, abstains and reports coverage
 *     without any model involved. This result stands on its own.
 *  3. **Interpret, optionally.** The model is called only if there is a score to
 *     describe, and only its guarded output is stored as an assessment.
 *  4. **Persist as three layers.** FACT, INTERPRETATION, AI_ASSESSMENT, each traceable
 *     to its parents.
 *
 * A failure at step 3 does not fail the job. The deterministic layers are the product;
 * the model is commentary on them, and losing the commentary is not losing the reading.
 */

import { eq } from 'drizzle-orm';
import { assets, configProfiles } from '@forex-agent/db';
import { isScored, runFundamentalEngine } from '@forex-agent/engines';
import type { RuntimeConfig } from '@forex-agent/config';
import {
  buildPrompt,
  GeminiClient,
  GUARD_VERSION,
  permittedNumbersFrom,
  PROMPT_NAME,
  PROMPT_VERSION,
  runGuards,
} from '@forex-agent/ai';
import { buildEvidenceBundle } from '../analysis/evidenceBundle.js';
import { buildFundamentalInputs } from '../analysis/buildInputs.js';
import { buildNewsView } from '../analysis/newsView.js';
import { persistAnalysis, type AiOutcome } from '../analysis/persist.js';
import type { JobContext, JobOutcome } from '../runner.js';

/**
 * The narrowest thing this job needs to report a problem.
 *
 * A structural port rather than the logging library’s type: the job needs somewhere
 * to say that a model call failed, not a dependency on how logging is configured.
 */
export interface JobLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface AnalysisJobDeps {
  readonly config: RuntimeConfig;
  readonly assetSymbol?: string;
  /**
   * Where a rejected or failed model call is reported.
   *
   * The rejection is stored either way; this is so an operator hears about it without
   * querying for it. Optional because a run with nowhere to log is still a valid run.
   */
  readonly logger?: JobLogger;
  /**
   * Absent means the deterministic layers run alone.
   *
   * Not a degraded mode to apologise for: an analysis without the AI layer is complete,
   * scored and publishable. The layer it omits is the only one that was never allowed to
   * introduce a fact.
   */
  readonly gemini?: {
    readonly apiKey: string;
    readonly model: string;
    readonly fallbackModel: string;
  };
}

export function analysisJob(deps: AnalysisJobDeps) {
  return async (ctx: JobContext): Promise<JobOutcome> => {
    const symbol = deps.assetSymbol ?? 'XAUUSD';
    const c = deps.config;

    const [asset] = await ctx.db
      .select({ id: assets.id, symbol: assets.symbol })
      .from(assets)
      .where(eq(assets.symbol, symbol))
      .limit(1);
    if (asset === undefined) {
      return { itemsProcessed: 0, detail: `asset ${symbol} is not seeded` };
    }

    const [profile] = await ctx.db
      .select({ id: configProfiles.id })
      .from(configProfiles)
      .where(eq(configProfiles.isActive, true))
      .limit(1);
    if (profile === undefined) {
      // Without a profile there is nothing to attribute the run's configuration to, and
      // an analysis whose settings cannot be reconstructed is not reproducible.
      return {
        itemsProcessed: 0,
        detail: 'no active config profile; nothing to attribute the run to',
      };
    }

    // ── 1. Collect ──────────────────────────────────────────────────────────
    const news = await buildNewsView(ctx.db, {
      assetId: asset.id,
      now: ctx.now,
      config: c.news,
      freshness: c.freshness.news,
    });

    const { inputs, facts } = await buildFundamentalInputs(ctx.db, { now: ctx.now, news });

    // ── 2. Score ────────────────────────────────────────────────────────────
    const result = runFundamentalEngine(
      inputs,
      {
        factors: c.factors,
        normalisation: c.normalisation,
        inflationNetRule: c.inflationNetRule,
        confidence: c.confidence,
        eventRisk: {
          warnWindowMs: c.eventRisk.warnWindowMs,
          imminentWindowMs: c.eventRisk.imminentWindowMs,
        },
      },
      ctx.now,
    );

    const bundle = buildEvidenceBundle({ asset: asset.symbol, result, facts });

    // ── 3. Interpret ────────────────────────────────────────────────────────
    const ai = await interpret(deps, bundle, result, asset.symbol);

    // ── 4. Persist ──────────────────────────────────────────────────────────
    const persisted = await persistAnalysis(ctx.db, {
      assetId: asset.id,
      configProfileId: profile.id,
      result,
      bundle,
      facts,
      ...(ai === undefined ? {} : { ai }),
    });

    const scoredFactors = result.factors.filter(isScored).length;
    return {
      itemsProcessed: 1,
      detail:
        `${result.status} ` +
        (result.status === 'SCORED' ? `${result.signedScore.toFixed(1)} ${result.band} ` : '') +
        `coverage ${(result.coverage * 100).toFixed(0)}% ` +
        `${String(scoredFactors)}/${String(result.factors.length)} factors ` +
        `ai=${ai?.outcome ?? 'NOT_CALLED'} ` +
        `analysis=${persisted.analysisId}`,
    };
  };
}

/**
 * Run the model and check what it said.
 *
 * Returns `undefined` only when the model was never called. Every call that happened is
 * recorded — including the failures — because "the model was not asked" and "the model
 * answered and was rejected" are different facts about a run, and a missing AI section
 * that could mean either is not evidence of anything.
 */
async function interpret(
  deps: AnalysisJobDeps,
  bundle: ReturnType<typeof buildEvidenceBundle>,
  result: ReturnType<typeof runFundamentalEngine>,
  asset: string,
): Promise<AiOutcome | undefined> {
  const gemini = deps.gemini;
  if (gemini === undefined) return undefined;
  // An insufficient run has no score, so there is nothing to describe and no prose that
  // could be grounded in one.
  if (result.status !== 'SCORED') return undefined;

  const client = new GeminiClient({
    apiKey: gemini.apiKey,
    model: gemini.model,
    fallbackModel: gemini.fallbackModel,
  });

  const common = {
    providerId: 'gemini',
    promptName: PROMPT_NAME,
    promptVersion: PROMPT_VERSION,
    guardVersion: GUARD_VERSION,
    retryCount: 0,
  } as const;

  let response;
  try {
    response = await client.generate(
      buildPrompt({ bundleJson: JSON.stringify(bundle, null, 2), asset }),
    );
  } catch (error) {
    // A thrown client is still a run that happened. Swallowing it here would lose the
    // only record that the model was asked at all.
    deps.logger?.warn({ err: error }, 'gemini call threw; the deterministic layers stand alone');
    return {
      ...common,
      model: gemini.model,
      outcome: 'PROVIDER_ERROR',
      rawResponse: null,
      validationErrors: [error instanceof Error ? error.message : String(error)],
      latencyMs: null,
    };
  }

  if (response.kind === 'MALFORMED') {
    // The model answered and the answer did not fit the schema. Recorded with the raw
    // response, because a malformed answer is evidence about the prompt.
    return {
      ...common,
      model: response.model,
      outcome: 'INVALID',
      rawResponse: response.raw,
      validationErrors: response.errors,
      latencyMs: response.latencyMs,
    };
  }

  if (response.kind !== 'OK') {
    // No model was reached at all, so there is no model to name and no latency to
    // report. Naming the configured model here would claim a call that never happened.
    return {
      ...common,
      model: gemini.model,
      outcome: 'PROVIDER_ERROR',
      rawResponse: null,
      validationErrors: [response.reason],
      latencyMs: null,
    };
  }

  const violations = runGuards(response.assessment, {
    permittedNumbers: permittedNumbersFrom(bundle),
    knownFactorIds: result.factors.map((f) => f.factorId),
    abstainedFactorIds: result.abstained.map((a) => a.factorId),
    requiresGapDisclosure: result.abstained.length > 0,
  });

  if (violations.length > 0) {
    deps.logger?.warn(
      { violations: violations.map((v) => v.code) },
      'model output rejected by the guards; storing the rejection, not the prose',
    );
  }

  return {
    ...common,
    model: response.model,
    outcome: violations.length === 0 ? 'VALID' : 'INVALID',
    rawResponse: response.raw,
    validationErrors: violations,
    // The assessment is attached only when nothing was wrong with it. A partially
    // acceptable model response is not a thing this product stores.
    ...(violations.length === 0 ? { assessment: response.assessment } : {}),
    promptTokens: response.promptTokens,
    responseTokens: response.responseTokens,
    latencyMs: response.latencyMs,
  };
}
