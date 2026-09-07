/**
 * Login, logout and password change (master PRD §3).
 *
 * The single most important property here is that **every failure path costs the
 * same and says the same thing**. "No such account" and "wrong password" are
 * indistinguishable to the caller in both message and duration; otherwise the login
 * endpoint becomes an account enumerator, and knowing which addresses are registered
 * is the first step of a credential-stuffing campaign.
 */

import { eq, sql } from 'drizzle-orm';
import { AppError, authError } from '@forex-agent/core';
import type { Database } from '@forex-agent/db';
import { auditEvents, sessions, users } from '@forex-agent/db';
import {
  assertPasswordAcceptable,
  hashPassword,
  needsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from './password.js';
import {
  checkRateLimit,
  normaliseIdentifier,
  recordLoginAttempt,
  type RateLimitPolicy,
} from './rateLimit.js';
import {
  createSession,
  revokeAllSessions,
  revokeSessionByToken,
  type IssuedSession,
  type SessionPolicy,
} from './session.js';

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly now: Date;
}

export interface LoginSuccess {
  readonly ok: true;
  readonly session: IssuedSession;
  readonly userId: string;
}

export interface LoginFailure {
  readonly ok: false;
  /** Uniform, user-safe. Never distinguishes unknown account from bad password. */
  readonly error: AppError;
  readonly retryAfterMs?: number;
}

export type LoginResult = LoginSuccess | LoginFailure;

export interface LoginDeps {
  readonly rateLimitPolicy?: RateLimitPolicy;
  readonly sessionPolicy?: SessionPolicy;
}

export async function login(
  db: Database,
  request: LoginRequest,
  deps: LoginDeps = {},
): Promise<LoginResult> {
  const identifier = normaliseIdentifier(request.email);
  const ipAddress = request.ipAddress ?? null;

  // Rate limit first: an attacker must not be able to make us do Argon2 work.
  const limit = await checkRateLimit(
    db,
    { identifier, ipAddress, now: request.now },
    deps.rateLimitPolicy,
  );
  if (!limit.allowed) {
    await recordLoginAttempt(db, {
      identifier,
      ipAddress,
      succeeded: false,
      now: request.now,
    });
    return {
      ok: false,
      error: new AppError('RATE_LIMITED', 'Too many attempts. Please try again later.'),
      retryAfterMs: limit.retryAfterMs,
    };
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${identifier}`)
    .limit(1);

  // Both branches perform one Argon2 verification, so the response time carries no
  // information about whether the account exists.
  const passwordOk =
    user === undefined
      ? await verifyAgainstDummy(request.password)
      : await verifyPassword(request.password, user.passwordHash);

  // An inactive account fails exactly like a wrong password — including still having
  // done the hash work — so deactivation is not observable either.
  if (user === undefined || !passwordOk || !user.isActive) {
    await recordLoginAttempt(db, {
      identifier,
      ipAddress,
      succeeded: false,
      now: request.now,
    });
    if (user !== undefined) {
      await audit(db, {
        userId: user.id,
        eventType: 'LOGIN_FAILED',
        ipAddress,
        userAgent: request.userAgent ?? null,
        detail: user.isActive ? 'bad password' : 'inactive account',
        now: request.now,
      });
    }
    return { ok: false, error: authError() };
  }

  // Transparent cost upgrade: raising Argon2 parameters never requires a reset.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(request.password);
    await db.update(users).set({ passwordHash: upgraded }).where(eq(users.id, user.id));
  }

  const session = await createSession(
    db,
    {
      userId: user.id,
      ipAddress,
      userAgent: request.userAgent ?? null,
      now: request.now,
    },
    deps.sessionPolicy,
  );

  await recordLoginAttempt(db, {
    identifier,
    ipAddress,
    succeeded: true,
    now: request.now,
  });
  await db.update(users).set({ lastLoginAt: request.now }).where(eq(users.id, user.id));
  await audit(db, {
    userId: user.id,
    eventType: 'LOGIN',
    ipAddress,
    userAgent: request.userAgent ?? null,
    detail: null,
    now: request.now,
  });

  return { ok: true, session, userId: user.id };
}

export async function logout(
  db: Database,
  params: { token: string; userId?: string; ipAddress?: string | null; now: Date },
): Promise<void> {
  await revokeSessionByToken(db, params.token, params.now);
  if (params.userId !== undefined) {
    await audit(db, {
      userId: params.userId,
      eventType: 'LOGOUT',
      ipAddress: params.ipAddress ?? null,
      userAgent: null,
      detail: null,
      now: params.now,
    });
  }
}

export interface PasswordChangeResult {
  /** A freshly issued session; the caller must replace the cookie with this. */
  readonly session: IssuedSession;
  /** How many other sessions were ended. */
  readonly revokedCount: number;
}

/**
 * Change a password.
 *
 * Every existing session is ended and a **new one is issued** for the caller, rather
 * than sparing the current session in place. Two reasons:
 *
 *  1. Rotating the token on a credential change is standard defence against session
 *     fixation — if the old token had leaked, changing the password should retire it.
 *  2. `session_epoch` then has no exceptions. Sparing the current session would mean
 *     "every session issued before the epoch is invalid, except this one", and an
 *     authentication rule with a carve-out is where bugs live.
 *
 * The user stays logged in — their cookie is replaced in the same response. Other
 * devices are logged out, which is the point.
 */
export async function changePassword(
  db: Database,
  params: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    now: Date;
  },
  deps: LoginDeps = {},
): Promise<PasswordChangeResult> {
  assertPasswordAcceptable(params.newPassword);

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

  if (user?.isActive !== true) throw authError();

  const ok = await verifyPassword(params.currentPassword, user.passwordHash);
  if (!ok) {
    await audit(db, {
      userId: params.userId,
      eventType: 'PASSWORD_CHANGE_FAILED',
      ipAddress: params.ipAddress ?? null,
      userAgent: null,
      detail: 'current password incorrect',
      now: params.now,
    });
    throw new AppError('AUTH_ERROR', 'Current password is incorrect.');
  }

  if (params.newPassword === params.currentPassword) {
    throw new AppError('VALIDATION_ERROR', 'New password must differ from the current one.');
  }

  const newHash = await hashPassword(params.newPassword);

  // Bumping the epoch invalidates every session issued before now, including any
  // this transaction has not explicitly revoked — belt and braces.
  await db
    .update(users)
    .set({ passwordHash: newHash, sessionEpoch: params.now })
    .where(eq(users.id, params.userId));

  const revokedCount = await revokeAllSessions(db, {
    userId: params.userId,
    now: params.now,
  });

  const session = await createSession(
    db,
    {
      userId: params.userId,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      now: params.now,
    },
    deps.sessionPolicy,
  );

  await audit(db, {
    userId: params.userId,
    eventType: 'PASSWORD_CHANGE',
    ipAddress: params.ipAddress ?? null,
    userAgent: params.userAgent ?? null,
    detail: `revoked ${String(revokedCount)} session(s)`,
    now: params.now,
  });

  return { session, revokedCount };
}

/**
 * Administrative password reset (no current password required).
 *
 * Used by the CLI. Ends every session unconditionally — there is no "current"
 * session to preserve when an operator resets someone else's credentials.
 */
export async function adminResetPassword(
  db: Database,
  params: { userId: string; newPassword: string; now: Date },
): Promise<number> {
  assertPasswordAcceptable(params.newPassword);
  const newHash = await hashPassword(params.newPassword);

  await db
    .update(users)
    .set({ passwordHash: newHash, sessionEpoch: params.now })
    .where(eq(users.id, params.userId));

  const revoked = await revokeAllSessions(db, { userId: params.userId, now: params.now });

  await audit(db, {
    userId: params.userId,
    eventType: 'PASSWORD_RESET_ADMIN',
    ipAddress: null,
    userAgent: null,
    detail: `revoked ${String(revoked)} session(s)`,
    now: params.now,
  });

  return revoked;
}

export async function createUser(
  db: Database,
  params: { email: string; password: string; displayName?: string | null; now: Date },
): Promise<string> {
  assertPasswordAcceptable(params.password);
  const passwordHash = await hashPassword(params.password);

  const [row] = await db
    .insert(users)
    .values({
      email: params.email.trim(),
      passwordHash,
      displayName: params.displayName ?? null,
      sessionEpoch: params.now,
    })
    .returning({ id: users.id });

  if (row === undefined) throw new Error('Failed to create user');
  return row.id;
}

async function audit(
  db: Database,
  params: {
    userId: string | null;
    eventType: string;
    ipAddress: string | null;
    userAgent: string | null;
    /** Never a credential — see master PRD §42. */
    detail: string | null;
    now: Date;
  },
): Promise<void> {
  await db.insert(auditEvents).values({
    userId: params.userId,
    eventType: params.eventType,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    detail: params.detail,
    occurredAt: params.now,
  });
}

export { sessions, users };
