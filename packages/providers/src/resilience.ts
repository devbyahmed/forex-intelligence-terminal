/**
 * Rate limiting and circuit breaking (master PRD §40).
 *
 * **State lives in Postgres, not in process memory.** Same reasoning as the login
 * limiter: the primary target is serverless, so a counter held in a module-level
 * variable resets on every cold start. It would appear to work in local testing and
 * silently allow unlimited requests in production — which, against a free tier
 * measured in hundreds of calls per day, means a burned quota and a dead domain.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '@forex-agent/db';
import { providerStatus } from '@forex-agent/db';
import type { RateLimitPolicy } from './types.js';

export interface BreakerPolicy {
  /** Consecutive failures before the breaker opens. */
  readonly failureThreshold: number;
  /** How long it stays open before a single trial request is allowed through. */
  readonly cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerPolicy = {
  failureThreshold: 5,
  cooldownMs: 5 * 60_000,
};

export type GateDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'CIRCUIT_OPEN' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED';
      readonly retryAfterMs: number;
    };

interface StatusRow {
  provider_id: string;
  breaker: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutive_failures: number;
  breaker_opened_at: Date | string | null;
  quota_used_today: number;
  quota_limit_daily: number | null;
  quota_reset_at: Date | string | null;
  last_success_at: Date | string | null;
}

const rows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] }).rows ?? [];
};

const toDate = (v: Date | string | null): Date | null => {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
};

/** Create the status row for a provider if it does not exist yet. */
export async function ensureProviderStatus(
  db: Database,
  params: { providerId: string; domain: string; tier: number; quotaLimitDaily?: number | null },
): Promise<void> {
  await db
    .insert(providerStatus)
    .values({
      providerId: params.providerId,
      domain: params.domain,
      tier: params.tier,
      quotaLimitDaily: params.quotaLimitDaily ?? null,
    })
    .onConflictDoNothing({ target: providerStatus.providerId });
}

/**
 * Decide whether a call may proceed, and reserve quota if so.
 *
 * Done in **one atomic statement** rather than read-then-write. Two concurrent
 * invocations reading the same counter and both deciding they are under the limit is
 * exactly how a free tier gets burned; `UPDATE ... WHERE` with the guard in the
 * predicate makes the check and the increment a single decision.
 */
export async function acquireSlot(
  db: Database,
  params: {
    providerId: string;
    limits: RateLimitPolicy;
    now: Date;
    breaker?: BreakerPolicy;
  },
): Promise<GateDecision> {
  const breaker = params.breaker ?? DEFAULT_BREAKER;
  const cost = params.limits.creditsPerRequest ?? 1;
  const dailyCap = params.limits.creditsPerDay ?? params.limits.requestsPerDay ?? null;

  const current = rows<StatusRow>(
    await db.execute(sql`
      SELECT provider_id, breaker, consecutive_failures, breaker_opened_at,
             quota_used_today, quota_limit_daily, quota_reset_at, last_success_at
        FROM provider_status
       WHERE provider_id = ${params.providerId}
    `),
  )[0];

  if (current === undefined) {
    // No status row means the provider was never registered — fail closed rather
    // than silently allowing unmetered calls.
    return { allowed: false, reason: 'CIRCUIT_OPEN', retryAfterMs: 0 };
  }

  // ── Breaker ───────────────────────────────────────────────────────────────
  if (current.breaker === 'OPEN') {
    const openedAt = toDate(current.breaker_opened_at);
    const elapsed = openedAt === null ? breaker.cooldownMs : params.now.getTime() - openedAt.getTime();
    if (elapsed < breaker.cooldownMs) {
      return {
        allowed: false,
        reason: 'CIRCUIT_OPEN',
        retryAfterMs: breaker.cooldownMs - elapsed,
      };
    }
    // Cooldown elapsed: let exactly one trial request through.
    await db.execute(sql`
      UPDATE provider_status SET breaker = 'HALF_OPEN', updated_at = now()
       WHERE provider_id = ${params.providerId} AND breaker = 'OPEN'
    `);
  }

  // ── Daily quota ───────────────────────────────────────────────────────────
  //
  // The reset decision is evaluated **inside** the UPDATE, against the row's own
  // committed state, rather than from the SELECT above.
  //
  // Computing it in JavaScript from a prior read is a real race: twenty concurrent
  // invocations all read `quota_reset_at IS NULL`, all conclude "first call of the
  // day", and all reset the counter to 1 — so a cap of 5 admits 20. Postgres takes a
  // row lock for UPDATE and re-checks the predicate after the lock is released, so
  // expressing it in SQL makes the check and the increment one atomic decision.
  if (dailyCap !== null) {
    const nextReset = new Date(params.now.getTime() + 24 * 60 * 60_000);

    const updated = rows<{ quota_used_today: number }>(
      await db.execute(sql`
        UPDATE provider_status
           SET quota_used_today =
                 CASE WHEN quota_reset_at IS NULL OR quota_reset_at <= ${params.now}
                      THEN ${cost}
                      ELSE quota_used_today + ${cost} END,
               quota_reset_at =
                 CASE WHEN quota_reset_at IS NULL OR quota_reset_at <= ${params.now}
                      THEN ${nextReset}
                      ELSE quota_reset_at END,
               updated_at = now()
         WHERE provider_id = ${params.providerId}
           AND (
                 quota_reset_at IS NULL
              OR quota_reset_at <= ${params.now}
              OR quota_used_today + ${cost} <= ${dailyCap}
           )
        RETURNING quota_used_today
      `),
    );

    if (updated.length === 0) {
      const resetAt = toDate(current.quota_reset_at);
      const resetIn =
        resetAt === null ? 24 * 60 * 60_000 : Math.max(0, resetAt.getTime() - params.now.getTime());
      return { allowed: false, reason: 'QUOTA_EXHAUSTED', retryAfterMs: resetIn };
    }
  }

  return { allowed: true };
}

/** Record a success: closes the breaker and clears the failure count. */
export async function recordSuccess(
  db: Database,
  providerId: string,
  now: Date,
): Promise<void> {
  await db.execute(sql`
    UPDATE provider_status
       SET breaker = 'CLOSED',
           consecutive_failures = 0,
           last_success_at = ${now},
           breaker_opened_at = NULL,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = now()
     WHERE provider_id = ${providerId}
  `);
}

/**
 * Record a failure, opening the breaker once the threshold is reached.
 *
 * `errorMessage` is truncated and must never be a raw provider body — an error
 * response can echo back the API key that was sent.
 */
export async function recordFailure(
  db: Database,
  params: {
    providerId: string;
    now: Date;
    errorCode: string;
    errorMessage?: string;
    breaker?: BreakerPolicy;
  },
): Promise<void> {
  const breaker = params.breaker ?? DEFAULT_BREAKER;
  const message = params.errorMessage?.slice(0, 500) ?? null;

  await db.execute(sql`
    UPDATE provider_status
       SET consecutive_failures = consecutive_failures + 1,
           last_failure_at = ${params.now},
           last_error_code = ${params.errorCode},
           last_error_message = ${message},
           breaker = CASE
             WHEN consecutive_failures + 1 >= ${breaker.failureThreshold} THEN 'OPEN'
             ELSE breaker END,
           breaker_opened_at = CASE
             WHEN consecutive_failures + 1 >= ${breaker.failureThreshold}
              AND breaker <> 'OPEN' THEN ${params.now}
             ELSE breaker_opened_at END,
           updated_at = now()
     WHERE provider_id = ${params.providerId}
  `);
}

export interface ProviderStatusSnapshot {
  readonly providerId: string;
  readonly breaker: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  readonly consecutiveFailures: number;
  readonly quotaUsedToday: number;
  readonly quotaLimitDaily: number | null;
  readonly lastSuccessAt: Date | null;
}

export async function getProviderStatus(
  db: Database,
  providerId: string,
): Promise<ProviderStatusSnapshot | null> {
  const row = rows<StatusRow>(
    await db.execute(sql`
      SELECT provider_id, breaker, consecutive_failures, breaker_opened_at,
             quota_used_today, quota_limit_daily, quota_reset_at, last_success_at
        FROM provider_status WHERE provider_id = ${providerId}
    `),
  )[0];
  if (row === undefined) return null;
  return {
    providerId: row.provider_id,
    breaker: row.breaker,
    consecutiveFailures: row.consecutive_failures,
    quotaUsedToday: row.quota_used_today,
    quotaLimitDaily: row.quota_limit_daily,
    lastSuccessAt: toDate(row.last_success_at),
  };
}

/** Exponential backoff with jitter, capped. Never an unbounded retry (master §40). */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // Full jitter: without it, many clients failing together retry in lockstep and
  // hammer a recovering service at exactly the same moment.
  return Math.floor(exponential * random());
}

/** HTTP statuses worth retrying. A 4xx other than 429 will fail again identically. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}
