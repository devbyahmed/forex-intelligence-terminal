/**
 * Login rate limiting and lockout (master PRD §3, §53).
 *
 * **All state lives in Postgres.** Nothing is held in process memory and nothing is
 * derived from anything the client sends beyond the identifier it is attacking. That
 * is not incidental: the primary deployment target is serverless, where there is no
 * long-lived process to hold a counter, every request may land on a fresh instance,
 * and an in-memory limiter would reset itself constantly — giving an attacker
 * unlimited attempts while appearing to work in local testing.
 *
 * Two independent limits apply, and the stricter one wins:
 *
 *  - **per account** — stops one account being ground down from many addresses
 *  - **per IP address** — stops one host spraying many accounts
 */

import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '@forex-agent/db';
import { loginAttempts } from '@forex-agent/db';

export interface RateLimitPolicy {
  /** Failures inside the window before the identifier is locked. */
  readonly maxFailuresPerIdentifier: number;
  /** Failures inside the window before the address is locked. */
  readonly maxFailuresPerIp: number;
  readonly windowMs: number;
  /** First lockout duration; doubles per additional lockout-worth of failures. */
  readonly baseLockoutMs: number;
  readonly maxLockoutMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  maxFailuresPerIdentifier: 5,
  maxFailuresPerIp: 20,
  windowMs: 15 * 60_000,
  baseLockoutMs: 60_000,
  maxLockoutMs: 60 * 60_000,
};

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** How long the caller must wait. Zero when allowed. */
  readonly retryAfterMs: number;
  readonly reason: 'OK' | 'IDENTIFIER_LOCKED' | 'IP_LOCKED';
  readonly identifierFailures: number;
  readonly ipFailures: number;
}

/** Identifiers are compared lowercased so casing cannot dodge the limiter. */
export const normaliseIdentifier = (identifier: string): string =>
  identifier.trim().toLowerCase();

/**
 * Lockout grows with the number of failures beyond the threshold, doubling each
 * time, capped. A fixed delay is trivially waited out; unbounded growth would let
 * one careless typing streak lock an account for days.
 */
export function lockoutDurationMs(
  failures: number,
  threshold: number,
  policy: RateLimitPolicy,
): number {
  if (failures < threshold) return 0;
  const over = failures - threshold;
  const doublings = Math.floor(over / threshold);
  const duration = policy.baseLockoutMs * 2 ** doublings;
  return Math.min(duration, policy.maxLockoutMs);
}

/**
 * Decide whether an attempt may proceed.
 *
 * Counts only failures since the last success: a successful login clears the slate,
 * so a legitimate user who mistypes twice and then succeeds is not penalised on
 * their next visit.
 */
export async function checkRateLimit(
  db: Database,
  params: { identifier: string; ipAddress: string | null; now: Date },
  policy: RateLimitPolicy = DEFAULT_RATE_LIMIT,
): Promise<RateLimitDecision> {
  const identifier = normaliseIdentifier(params.identifier);
  const windowStart = new Date(params.now.getTime() - policy.windowMs);

  const identifierFailures = await countFailuresSinceLastSuccess(db, {
    column: 'identifier',
    value: identifier,
    windowStart,
  });

  const ipFailures =
    params.ipAddress === null
      ? 0
      : await countFailuresSinceLastSuccess(db, {
          column: 'ip_address',
          value: params.ipAddress,
          windowStart,
        });

  const identifierLock = lockoutDurationMs(
    identifierFailures,
    policy.maxFailuresPerIdentifier,
    policy,
  );
  const ipLock = lockoutDurationMs(ipFailures, policy.maxFailuresPerIp, policy);

  if (identifierLock > 0 || ipLock > 0) {
    const lastFailureAt = await lastFailureTime(db, identifier, params.ipAddress);
    const lockMs = Math.max(identifierLock, ipLock);
    const elapsed =
      lastFailureAt === null ? lockMs : params.now.getTime() - lastFailureAt.getTime();
    const retryAfterMs = Math.max(0, lockMs - elapsed);

    if (retryAfterMs > 0) {
      return {
        allowed: false,
        retryAfterMs,
        reason: identifierLock >= ipLock ? 'IDENTIFIER_LOCKED' : 'IP_LOCKED',
        identifierFailures,
        ipFailures,
      };
    }
  }

  return {
    allowed: true,
    retryAfterMs: 0,
    reason: 'OK',
    identifierFailures,
    ipFailures,
  };
}

/**
 * Count failures since the most recent success for this key.
 *
 * Done in SQL rather than by fetching rows: the window can hold many attempts under
 * an active attack, and shipping them to the application to count would turn a
 * cheap query into a memory problem exactly when the system is under load.
 */
async function countFailuresSinceLastSuccess(
  db: Database,
  params: { column: 'identifier' | 'ip_address'; value: string; windowStart: Date },
): Promise<number> {
  const col = params.column === 'identifier' ? sql`identifier` : sql`ip_address`;
  const value =
    params.column === 'identifier' ? sql`${params.value}` : sql`${params.value}::inet`;

  const rows = await db.execute<{ failures: number }>(sql`
    WITH last_success AS (
      SELECT max(attempted_at) AS at
        FROM login_attempts
       WHERE ${col} = ${value}
         AND succeeded = true
         AND attempted_at >= ${params.windowStart}
    )
    SELECT count(*)::int AS failures
      FROM login_attempts, last_success
     WHERE ${col} = ${value}
       AND succeeded = false
       AND attempted_at >= ${params.windowStart}
       AND (last_success.at IS NULL OR attempted_at > last_success.at)
  `);

  const list = Array.isArray(rows)
    ? (rows as { failures: number }[])
    : ((rows as { rows?: { failures: number }[] }).rows ?? []);
  return list[0]?.failures ?? 0;
}

async function lastFailureTime(
  db: Database,
  identifier: string,
  ipAddress: string | null,
): Promise<Date | null> {
  const rows = await db.execute<{ at: string | null }>(sql`
    SELECT max(attempted_at) AS at
      FROM login_attempts
     WHERE succeeded = false
       AND (identifier = ${identifier}
            ${ipAddress === null ? sql`` : sql`OR ip_address = ${ipAddress}::inet`})
  `);
  const list = Array.isArray(rows)
    ? (rows as { at: string | Date | null }[])
    : ((rows as { rows?: { at: string | Date | null }[] }).rows ?? []);
  const at = list[0]?.at;
  if (at === null || at === undefined) return null;
  return at instanceof Date ? at : new Date(at);
}

/**
 * Record an attempt. Successes are recorded too — without them the limiter cannot
 * tell a burst of failures from ordinary use and would never reset.
 */
export async function recordLoginAttempt(
  db: Database,
  params: {
    identifier: string;
    ipAddress: string | null;
    succeeded: boolean;
    now?: Date;
  },
): Promise<void> {
  await db.insert(loginAttempts).values({
    identifier: normaliseIdentifier(params.identifier),
    ipAddress: params.ipAddress,
    succeeded: params.succeeded,
    ...(params.now === undefined ? {} : { attemptedAt: params.now }),
  });
}

/** Retention sweep: attempt history older than the window has no further use. */
export async function pruneLoginAttempts(db: Database, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(loginAttempts)
    .where(sql`${loginAttempts.attemptedAt} < ${olderThan}`)
    .returning({ id: loginAttempts.id });
  return deleted.length;
}

/** Test and diagnostic helper. */
export async function countAttempts(
  db: Database,
  identifier: string,
  succeeded?: boolean,
): Promise<number> {
  const conditions = [eq(loginAttempts.identifier, normaliseIdentifier(identifier))];
  if (succeeded !== undefined) conditions.push(eq(loginAttempts.succeeded, succeeded));
  const [row] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(...conditions));
  return row?.n ?? 0;
}

export { gte };
