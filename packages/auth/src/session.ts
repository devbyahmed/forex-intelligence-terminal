/**
 * Session lifecycle (master PRD §3).
 *
 * Validation is a **single query** joining sessions to users and checking every
 * invalidation rule at once — revoked, slid past its expiry, past its absolute cap,
 * user deactivated, or issued before the user's `session_epoch`.
 *
 * That is deliberate. On the primary target every request pays a round trip to a
 * database that may be waking from scale-to-zero, so the difference between one
 * query and three is the difference between one cold-start penalty and three. It is
 * also safer: expressing the rules as one predicate means a future caller cannot
 * check three of them and forget the fourth.
 */

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '@forex-agent/db';
import { sessions, users } from '@forex-agent/db';
import { generateToken, hashToken } from './tokens.js';

export interface SessionPolicy {
  /** Sliding window, refreshed on use. */
  readonly idleTtlMs: number;
  /** Hard ceiling from issue, never extended. */
  readonly absoluteTtlMs: number;
  /**
   * Only refresh the sliding expiry when this much has elapsed. Writing on every
   * request would double the query count and burn compute budget for no security
   * benefit.
   */
  readonly refreshIntervalMs: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleTtlMs: 7 * 24 * 60 * 60_000,
  absoluteTtlMs: 30 * 24 * 60 * 60_000,
  refreshIntervalMs: 60 * 60_000,
};

export interface IssuedSession {
  /** Returned to the caller once, to be set as a cookie. Never stored. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export const SESSION_INVALID_REASONS = [
  'NOT_FOUND',
  'REVOKED',
  'IDLE_EXPIRED',
  'ABSOLUTE_EXPIRED',
  'USER_INACTIVE',
  'EPOCH_INVALIDATED',
] as const;
export type SessionInvalidReason = (typeof SESSION_INVALID_REASONS)[number];

export type SessionValidation =
  | { readonly valid: true; readonly session: AuthenticatedSession }
  | { readonly valid: false; readonly reason: SessionInvalidReason };

export async function createSession(
  db: Database,
  params: {
    userId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    now: Date;
  },
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = new Date(params.now.getTime() + policy.idleTtlMs);
  const absoluteExpiresAt = new Date(params.now.getTime() + policy.absoluteTtlMs);

  const [row] = await db
    .insert(sessions)
    .values({
      userId: params.userId,
      tokenHash: hashToken(token),
      expiresAt,
      absoluteExpiresAt,
      lastUsedAt: params.now,
      createdAt: params.now,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    })
    .returning({ id: sessions.id });

  if (row === undefined) throw new Error('Failed to create session');

  return { token, sessionId: row.id, expiresAt, absoluteExpiresAt };
}

/**
 * Validate a bearer token.
 *
 * The token is looked up **by hash**, so the raw value never reaches a query and a
 * database leak yields nothing usable. Lookup is by primary-key-like unique index
 * rather than by scanning, so there is no timing signal from the comparison itself.
 */
export async function validateSession(
  db: Database,
  token: string,
  now: Date,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): Promise<SessionValidation> {
  if (token === '') return { valid: false, reason: 'NOT_FOUND' };

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      email: users.email,
      displayName: users.displayName,
      expiresAt: sessions.expiresAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      revokedAt: sessions.revokedAt,
      lastUsedAt: sessions.lastUsedAt,
      sessionCreatedAt: sessions.createdAt,
      sessionEpoch: users.sessionEpoch,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);

  if (row === undefined) return { valid: false, reason: 'NOT_FOUND' };

  // Order matters only for the reported reason; any one of these ends the session.
  if (row.revokedAt !== null) return { valid: false, reason: 'REVOKED' };
  if (!row.isActive) return { valid: false, reason: 'USER_INACTIVE' };
  if (row.absoluteExpiresAt.getTime() <= now.getTime()) {
    // Checked independently of the sliding window: a session used continuously for
    // 30 days must still end, or "sliding" would mean "never expires".
    return { valid: false, reason: 'ABSOLUTE_EXPIRED' };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: 'IDLE_EXPIRED' };
  }
  if (row.sessionCreatedAt.getTime() < row.sessionEpoch.getTime()) {
    // Issued before the user's credentials last changed.
    return { valid: false, reason: 'EPOCH_INVALIDATED' };
  }

  const slid = await maybeSlideExpiry(db, {
    sessionId: row.sessionId,
    lastUsedAt: row.lastUsedAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    now,
    policy,
  });

  return {
    valid: true,
    session: {
      sessionId: row.sessionId,
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      expiresAt: slid ?? row.expiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
    },
  };
}

/**
 * Extend the sliding window, but never past the absolute cap.
 *
 * Throttled by `refreshIntervalMs`: on the primary target every write costs a round
 * trip and compute time against a metered budget, and refreshing an expiry that is
 * days away buys nothing.
 */
async function maybeSlideExpiry(
  db: Database,
  params: {
    sessionId: string;
    lastUsedAt: Date;
    absoluteExpiresAt: Date;
    now: Date;
    policy: SessionPolicy;
  },
): Promise<Date | null> {
  const sinceLastUse = params.now.getTime() - params.lastUsedAt.getTime();
  if (sinceLastUse < params.policy.refreshIntervalMs) return null;

  const proposed = new Date(params.now.getTime() + params.policy.idleTtlMs);
  const capped =
    proposed.getTime() > params.absoluteExpiresAt.getTime()
      ? params.absoluteExpiresAt
      : proposed;

  await db
    .update(sessions)
    .set({ expiresAt: capped, lastUsedAt: params.now })
    .where(eq(sessions.id, params.sessionId));

  return capped;
}

export async function revokeSession(
  db: Database,
  sessionId: string,
  now: Date,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeSessionByToken(
  db: Database,
  token: string,
  now: Date,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
}

/** Revoke every live session for a user, optionally sparing one. */
export async function revokeAllSessions(
  db: Database,
  params: { userId: string; exceptSessionId?: string; now: Date },
): Promise<number> {
  const conditions = [eq(sessions.userId, params.userId), isNull(sessions.revokedAt)];
  if (params.exceptSessionId !== undefined) {
    conditions.push(ne(sessions.id, params.exceptSessionId));
  }
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: params.now })
    .where(and(...conditions))
    .returning({ id: sessions.id });
  return revoked.length;
}

/**
 * Delete sessions that can no longer be valid.
 *
 * Revoked and expired rows are kept briefly for audit, then removed — the table
 * would otherwise grow without bound against a 0.5 GB storage cap.
 */
export async function pruneSessions(db: Database, now: Date, graceMs = 7 * 24 * 60 * 60_000): Promise<number> {
  const cutoff = new Date(now.getTime() - graceMs);
  const deleted = await db
    .delete(sessions)
    .where(
      sql`(${sessions.absoluteExpiresAt} < ${cutoff})
          OR (${sessions.revokedAt} IS NOT NULL AND ${sessions.revokedAt} < ${cutoff})`,
    )
    .returning({ id: sessions.id });
  return deleted.length;
}

export async function listActiveSessions(
  db: Database,
  userId: string,
  now: Date,
): Promise<{ id: string; createdAt: Date; lastUsedAt: Date; ipAddress: string | null }[]> {
  return db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      ipAddress: sessions.ipAddress,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > ${now}`,
        sql`${sessions.absoluteExpiresAt} > ${now}`,
      ),
    );
}
