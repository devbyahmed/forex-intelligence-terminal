/**
 * HTTP trigger — an external scheduler calls in.
 *
 * Used on the primary target, where there is no long-lived process: a GitHub Actions
 * schedule (or any other free cron) POSTs to an endpoint, which calls the same
 * `runDue` the interval trigger calls. One code path, two deployment shapes.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Database } from '@forex-agent/db';
import { runDue, type JobDefinition, type RunDueResult } from '../runner.js';
import { assertWorkerPreflight } from '../preflight.js';

export interface HttpTriggerRequest {
  /** Shared secret from the caller, typically an Authorization header. */
  readonly secret: string | undefined;
  readonly now?: Date;
}

export type HttpTriggerResponse =
  | { readonly status: 200; readonly body: RunDueResult }
  | { readonly status: 401; readonly body: { error: string } }
  | { readonly status: 500; readonly body: { error: string } };

export interface HttpTriggerOptions {
  readonly db: Database;
  readonly jobs: readonly JobDefinition[];
  readonly expectedSecret: string;
  /** Below the host's function limit, so work is deferred rather than killed. */
  readonly budgetMs?: number;
  /**
   * Where a preflight failure goes.
   *
   * The response body cannot carry it — this endpoint is public and the divergence
   * list names internal series and feed URLs — but somebody has to see it, or the
   * pipeline stops for a reason nobody can read.
   */
  readonly onPreflightFailure?: (error: unknown) => void;
}

/**
 * The endpoint is publicly reachable, so it is authenticated by a shared secret
 * compared in constant time. Without that, anyone could force ingestion on demand and
 * exhaust a free-tier provider quota for us.
 */
export async function handleHttpTrigger(
  request: HttpTriggerRequest,
  options: HttpTriggerOptions,
): Promise<HttpTriggerResponse> {
  if (!secretMatches(request.secret, options.expectedSecret)) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  try {
    // Fails closed. On this profile a "process" is one cold start, so in practice
    // this runs once per warm instance rather than once per tick.
    try {
      await assertWorkerPreflight(options.db);
    } catch (error) {
      options.onPreflightFailure?.(error);
      throw error;
    }

    const result = await runDue({
      db: options.db,
      jobs: options.jobs,
      now: request.now ?? new Date(),
      triggeredBy: 'http',
      budgetMs: options.budgetMs ?? 240_000,
    });
    return { status: 200, body: result };
  } catch {
    // Never echo the underlying error: this endpoint is public.
    return { status: 500, body: { error: 'Job run failed' } };
  }
}

/**
 * Does the presented secret match?
 *
 * Exported so a caller can decide *before* doing anything expensive. The endpoint is
 * public: composing providers and opening a database connection ahead of this check
 * lets an unauthenticated caller spend compute, and it turns every composition error
 * into a 500 where the honest answer was 401. `handleHttpTrigger` checks again — one
 * definition of the rule, applied twice, rather than two definitions.
 */
export function secretMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided === '' || expected === '') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
