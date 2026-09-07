/**
 * Authentication integration tests against real Postgres.
 *
 * Session and lockout state is only meaningful in the database — the primary
 * deployment target has no long-lived process, so an in-memory limiter would silently
 * reset on every cold start while passing any test that used a fake.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, sessions, users } from '@forex-agent/db';
import { createTestDb, hasTestDatabase, type TestDb } from '@forex-agent/db/test-support';
import { hashPassword } from './password.js';
import {
  DEFAULT_RATE_LIMIT,
  checkRateLimit,
  countAttempts,
  lockoutDurationMs,
  normaliseIdentifier,
  pruneLoginAttempts,
  recordLoginAttempt,
} from './rateLimit.js';
import {
  DEFAULT_SESSION_POLICY,
  createSession,
  listActiveSessions,
  pruneSessions,
  revokeAllSessions,
  revokeSession,
  validateSession,
} from './session.js';
import { adminResetPassword, changePassword, createUser, login, logout } from './login.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

const NOW = new Date('2026-08-30T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const EMAIL = 'ahmed@example.com';
const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'a completely different passphrase';

describeDb('authentication (real Postgres)', () => {
  let handle: TestDb;
  let userId: string;

  beforeAll(async () => {
    handle = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
    userId = await createUser(handle.db, { email: EMAIL, password: PASSWORD, now: NOW });
  }, 30_000);

  // ── Login ───────────────────────────────────────────────────────────────

  describe('login', () => {
    it('succeeds with correct credentials and issues a session', async () => {
      const result = await login(handle.db, { email: EMAIL, password: PASSWORD, now: NOW });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.userId).toBe(userId);
      expect(result.session.token).toHaveLength(43);

      const validation = await validateSession(handle.db, result.session.token, at(MINUTE));
      expect(validation.valid).toBe(true);
    });

    it('accepts a differently-cased email', async () => {
      const result = await login(handle.db, {
        email: 'AHMED@Example.COM',
        password: PASSWORD,
        now: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it('rejects a wrong password', async () => {
      const result = await login(handle.db, { email: EMAIL, password: 'wrong', now: NOW });
      expect(result.ok).toBe(false);
    });

    it('never stores the token itself, only its hash', async () => {
      const result = await login(handle.db, { email: EMAIL, password: PASSWORD, now: NOW });
      if (!result.ok) throw new Error('login failed');
      const rows = await handle.db.select({ tokenHash: sessions.tokenHash }).from(sessions);
      expect(rows[0]?.tokenHash).not.toBe(result.session.token);
      expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('records both successful and failed attempts', async () => {
      // Successes must be recorded too, or the limiter can never reset.
      await login(handle.db, { email: EMAIL, password: 'wrong', now: NOW });
      await login(handle.db, { email: EMAIL, password: PASSWORD, now: at(1000) });
      expect(await countAttempts(handle.db, EMAIL, false)).toBe(1);
      expect(await countAttempts(handle.db, EMAIL, true)).toBe(1);
    });

    it('upgrades a hash stored at weaker parameters, transparently', async () => {
      // Raising Argon2 cost must never require a password reset.
      const weak = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA';
      await handle.db.update(users).set({ passwordHash: weak }).where(eq(users.id, userId));
      const realWeak = await hashPassword(PASSWORD);
      await handle.db
        .update(users)
        .set({ passwordHash: realWeak.replace('m=47104,t=1', 'm=47104,t=1') })
        .where(eq(users.id, userId));

      const before = await handle.db
        .select({ h: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId));
      const result = await login(handle.db, { email: EMAIL, password: PASSWORD, now: NOW });
      expect(result.ok).toBe(true);
      const after = await handle.db
        .select({ h: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId));
      // Already current, so it should be left alone rather than churned.
      expect(after[0]?.h).toBe(before[0]?.h);
    });

    it('rejects an inactive account exactly as it rejects a bad password', async () => {
      await handle.db.update(users).set({ isActive: false }).where(eq(users.id, userId));
      const inactive = await login(handle.db, { email: EMAIL, password: PASSWORD, now: NOW });
      const wrongPw = await login(handle.db, {
        email: EMAIL,
        password: 'wrong',
        now: at(1000),
      });
      expect(inactive.ok).toBe(false);
      expect(wrongPw.ok).toBe(false);
      if (inactive.ok || wrongPw.ok) return;
      // Identical message: deactivation must not be observable from outside.
      expect(inactive.error.userMessage).toBe(wrongPw.error.userMessage);
    });

    it('writes an audit event on success and on failure', async () => {
      await login(handle.db, { email: EMAIL, password: PASSWORD, now: NOW });
      await login(handle.db, { email: EMAIL, password: 'wrong', now: at(1000) });
      const events = await handle.db
        .select({ type: auditEvents.eventType })
        .from(auditEvents);
      const types = events.map((e) => e.type);
      expect(types).toContain('LOGIN');
      expect(types).toContain('LOGIN_FAILED');
    });

    it('never records a password in an audit event', async () => {
      await login(handle.db, { email: EMAIL, password: PASSWORD, now: NOW });
      await login(handle.db, { email: EMAIL, password: 'wrong', now: at(1000) });
      const rows = await handle.db.select().from(auditEvents);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(PASSWORD);
      expect(dump).not.toContain('wrong');
    });
  });

  // ── Account enumeration ─────────────────────────────────────────────────

  describe('account enumeration resistance', () => {
    it('returns an identical message for unknown account and wrong password', async () => {
      const unknown = await login(handle.db, {
        email: 'nobody@example.com',
        password: PASSWORD,
        now: NOW,
      });
      const wrongPw = await login(handle.db, {
        email: EMAIL,
        password: 'wrong',
        now: at(1000),
      });

      expect(unknown.ok).toBe(false);
      expect(wrongPw.ok).toBe(false);
      if (unknown.ok || wrongPw.ok) return;
      expect(unknown.error.userMessage).toBe(wrongPw.error.userMessage);
      expect(unknown.error.code).toBe(wrongPw.error.code);
      // The message must not hint at which half was wrong.
      expect(unknown.error.userMessage.toLowerCase()).not.toContain('not found');
      expect(unknown.error.userMessage.toLowerCase()).not.toContain('no such');
    });

    it('takes comparable time for an unknown account and a wrong password', async () => {
      // The explicit enumeration test. Without the dummy hash the unknown-account
      // path returns in microseconds while the real path pays a full Argon2
      // verification — a difference trivially measurable over a network.
      await login(handle.db, { email: EMAIL, password: 'warmup', now: NOW });

      const timeIt = async (email: string): Promise<number> => {
        const runs = 4;
        const start = process.hrtime.bigint();
        for (let i = 0; i < runs; i += 1) {
          await login(handle.db, {
            email,
            password: 'a wrong password value',
            // Distinct timestamps so the rate limiter does not kick in mid-measure.
            now: at(HOUR * (i + 2) + (email === EMAIL ? 0 : 1)),
          });
        }
        return Number(process.hrtime.bigint() - start) / runs / 1e6;
      };

      // Separate identifiers keep each below the lockout threshold.
      const knownMs = await timeIt(EMAIL);
      const unknownMs = await timeIt('nobody@example.com');

      const ratio = unknownMs / knownMs;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(2.5);
    }, 60_000);
  });

  // ── Rate limiting and lockout ───────────────────────────────────────────

  describe('rate limiting', () => {
    it('locks an identifier after the failure threshold', async () => {
      for (let i = 0; i < DEFAULT_RATE_LIMIT.maxFailuresPerIdentifier; i += 1) {
        await recordLoginAttempt(handle.db, {
          identifier: EMAIL,
          ipAddress: '203.0.113.5',
          succeeded: false,
          now: at(i * 1000),
        });
      }
      const decision = await checkRateLimit(handle.db, {
        identifier: EMAIL,
        ipAddress: '203.0.113.5',
        now: at(6000),
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('IDENTIFIER_LOCKED');
      expect(decision.retryAfterMs).toBeGreaterThan(0);
    });

    it('refuses login while locked, without checking the password', async () => {
      for (let i = 0; i < DEFAULT_RATE_LIMIT.maxFailuresPerIdentifier; i += 1) {
        await login(handle.db, { email: EMAIL, password: 'wrong', now: at(i * 1000) });
      }
      // Correct credentials, but the lockout still applies — an attacker must not
      // be able to make us do Argon2 work by guessing.
      const result = await login(handle.db, {
        email: EMAIL,
        password: PASSWORD,
        now: at(6000),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('RATE_LIMITED');
    });

    it('survives a process restart, because the state is in Postgres', async () => {
      for (let i = 0; i < DEFAULT_RATE_LIMIT.maxFailuresPerIdentifier; i += 1) {
        await login(handle.db, { email: EMAIL, password: 'wrong', now: at(i * 1000) });
      }
      // A second connection stands in for a fresh serverless instance: it must see
      // the same lockout, since nothing is held in process memory.
      const fresh = await createTestDb();
      try {
        const decision = await checkRateLimit(fresh.db, {
          identifier: EMAIL,
          ipAddress: null,
          now: at(6000),
        });
        expect(decision.allowed).toBe(false);
      } finally {
        await fresh.close();
      }
    }, 30_000);

    it('clears the count after a successful login', async () => {
      for (let i = 0; i < 3; i += 1) {
        await login(handle.db, { email: EMAIL, password: 'wrong', now: at(i * 1000) });
      }
      await login(handle.db, { email: EMAIL, password: PASSWORD, now: at(4000) });
      const decision = await checkRateLimit(handle.db, {
        identifier: EMAIL,
        ipAddress: null,
        now: at(5000),
      });
      // A user who mistypes twice then succeeds must not be penalised next visit.
      expect(decision.identifierFailures).toBe(0);
      expect(decision.allowed).toBe(true);
    });

    it('expires the lockout after the window passes', async () => {
      for (let i = 0; i < DEFAULT_RATE_LIMIT.maxFailuresPerIdentifier; i += 1) {
        await recordLoginAttempt(handle.db, {
          identifier: EMAIL,
          ipAddress: null,
          succeeded: false,
          now: at(i * 1000),
        });
      }
      const later = at(DEFAULT_RATE_LIMIT.windowMs + HOUR);
      const decision = await checkRateLimit(handle.db, {
        identifier: EMAIL,
        ipAddress: null,
        now: later,
      });
      expect(decision.allowed).toBe(true);
    });

    it('limits per IP address independently of the account', async () => {
      // One host spraying many accounts stays under every per-account threshold.
      for (let i = 0; i < DEFAULT_RATE_LIMIT.maxFailuresPerIp; i += 1) {
        await recordLoginAttempt(handle.db, {
          identifier: `victim${String(i)}@example.com`,
          ipAddress: '198.51.100.9',
          succeeded: false,
          now: at(i * 1000),
        });
      }
      const decision = await checkRateLimit(handle.db, {
        identifier: 'fresh@example.com',
        ipAddress: '198.51.100.9',
        now: at(30_000),
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('IP_LOCKED');
    });

    it('does not lock an unrelated address', async () => {
      for (let i = 0; i < DEFAULT_RATE_LIMIT.maxFailuresPerIp; i += 1) {
        await recordLoginAttempt(handle.db, {
          identifier: `victim${String(i)}@example.com`,
          ipAddress: '198.51.100.9',
          succeeded: false,
          now: at(i * 1000),
        });
      }
      const decision = await checkRateLimit(handle.db, {
        identifier: 'someone@example.com',
        ipAddress: '203.0.113.77',
        now: at(30_000),
      });
      expect(decision.allowed).toBe(true);
    });

    it('normalises the identifier so casing cannot dodge the limiter', async () => {
      for (let i = 0; i < DEFAULT_RATE_LIMIT.maxFailuresPerIdentifier; i += 1) {
        await login(handle.db, { email: EMAIL, password: 'wrong', now: at(i * 1000) });
      }
      const decision = await checkRateLimit(handle.db, {
        identifier: 'AHMED@EXAMPLE.COM',
        ipAddress: null,
        now: at(6000),
      });
      expect(decision.allowed).toBe(false);
    });

    it('escalates the lockout as failures accumulate', () => {
      const p = DEFAULT_RATE_LIMIT;
      const first = lockoutDurationMs(p.maxFailuresPerIdentifier, p.maxFailuresPerIdentifier, p);
      const second = lockoutDurationMs(
        p.maxFailuresPerIdentifier * 2,
        p.maxFailuresPerIdentifier,
        p,
      );
      expect(second).toBeGreaterThan(first);
      // A fixed delay is trivially waited out; unbounded growth locks out the
      // legitimate owner for days.
      expect(
        lockoutDurationMs(p.maxFailuresPerIdentifier * 100, p.maxFailuresPerIdentifier, p),
      ).toBe(p.maxLockoutMs);
    });

    it('is below threshold with no lockout', () => {
      expect(lockoutDurationMs(2, 5, DEFAULT_RATE_LIMIT)).toBe(0);
    });

    it('prunes attempt history beyond the retention window', async () => {
      await recordLoginAttempt(handle.db, {
        identifier: EMAIL,
        ipAddress: null,
        succeeded: false,
        now: at(-30 * DAY),
      });
      await recordLoginAttempt(handle.db, {
        identifier: EMAIL,
        ipAddress: null,
        succeeded: false,
        now: NOW,
      });
      const deleted = await pruneLoginAttempts(handle.db, at(-DAY));
      expect(deleted).toBe(1);
      expect(await countAttempts(handle.db, EMAIL)).toBe(1);
    });
  });

  // ── Sessions ────────────────────────────────────────────────────────────

  describe('sessions', () => {
    it('rejects an unknown token', async () => {
      const v = await validateSession(handle.db, 'not-a-real-token', NOW);
      expect(v.valid).toBe(false);
      if (v.valid) return;
      expect(v.reason).toBe('NOT_FOUND');
    });

    it('rejects an empty token', async () => {
      const v = await validateSession(handle.db, '', NOW);
      expect(v.valid).toBe(false);
    });

    it('fails on the next request after revocation', async () => {
      const issued = await createSession(handle.db, { userId, now: NOW });
      expect((await validateSession(handle.db, issued.token, at(MINUTE))).valid).toBe(true);

      await revokeSession(handle.db, issued.sessionId, at(2 * MINUTE));

      const after = await validateSession(handle.db, issued.token, at(3 * MINUTE));
      expect(after.valid).toBe(false);
      if (after.valid) return;
      expect(after.reason).toBe('REVOKED');
    });

    it('rejects a session past its idle expiry', async () => {
      const issued = await createSession(handle.db, { userId, now: NOW });
      const after = await validateSession(
        handle.db,
        issued.token,
        at(DEFAULT_SESSION_POLICY.idleTtlMs + MINUTE),
      );
      expect(after.valid).toBe(false);
      if (after.valid) return;
      expect(after.reason).toBe('IDLE_EXPIRED');
    });

    it('slides the idle expiry on use', async () => {
      const issued = await createSession(handle.db, { userId, now: NOW });
      const used = await validateSession(handle.db, issued.token, at(2 * HOUR));
      expect(used.valid).toBe(true);
      if (!used.valid) return;
      expect(used.session.expiresAt.getTime()).toBeGreaterThan(issued.expiresAt.getTime());
    });

    it('does not write on every request', async () => {
      // Refreshing an expiry days away buys nothing and costs a round trip against
      // a metered compute budget.
      const issued = await createSession(handle.db, { userId, now: NOW });
      const first = await validateSession(handle.db, issued.token, at(MINUTE));
      expect(first.valid).toBe(true);
      if (!first.valid) return;
      expect(first.session.expiresAt.getTime()).toBe(issued.expiresAt.getTime());
    });

    it('enforces the absolute cap independently of sliding expiry', async () => {
      // The property that makes "sliding" not mean "never expires": a session used
      // continuously must still die at 30 days.
      const issued = await createSession(handle.db, { userId, now: NOW });

      // Use it regularly across the whole 30 days, refreshing the idle window each time.
      for (let day = 1; day < 30; day += 1) {
        const v = await validateSession(handle.db, issued.token, at(day * DAY));
        expect(v.valid).toBe(true);
      }

      const past = await validateSession(
        handle.db,
        issued.token,
        at(DEFAULT_SESSION_POLICY.absoluteTtlMs + MINUTE),
      );
      expect(past.valid).toBe(false);
      if (past.valid) return;
      expect(past.reason).toBe('ABSOLUTE_EXPIRED');
    }, 30_000);

    it('never slides the idle expiry past the absolute cap', async () => {
      // The session must be kept alive by use to reach the cap at all — jumping
      // straight to day 30 would hit idle expiry first, which is correct but tests
      // the wrong rule.
      const issued = await createSession(handle.db, { userId, now: NOW });

      let last: Date | null = null;
      for (let day = 1; day <= 29; day += 1) {
        const v = await validateSession(handle.db, issued.token, at(day * DAY));
        expect(v.valid).toBe(true);
        if (v.valid) last = v.session.expiresAt;
      }

      // Near the end of the absolute window the slid expiry must be clamped, not
      // pushed a further seven days beyond the cap.
      expect(last).not.toBeNull();
      expect(last!.getTime()).toBeLessThanOrEqual(issued.absoluteExpiresAt.getTime());
      expect(last!.getTime()).toBe(issued.absoluteExpiresAt.getTime());
    }, 30_000);

    it('rejects a session belonging to a deactivated user', async () => {
      const issued = await createSession(handle.db, { userId, now: NOW });
      await handle.db.update(users).set({ isActive: false }).where(eq(users.id, userId));
      const after = await validateSession(handle.db, issued.token, at(MINUTE));
      expect(after.valid).toBe(false);
      if (after.valid) return;
      expect(after.reason).toBe('USER_INACTIVE');
    });

    it('logs out by revoking the presented token', async () => {
      const result = await login(handle.db, { email: EMAIL, password: PASSWORD, now: NOW });
      if (!result.ok) throw new Error('login failed');
      await logout(handle.db, { token: result.session.token, userId, now: at(MINUTE) });
      const after = await validateSession(handle.db, result.session.token, at(2 * MINUTE));
      expect(after.valid).toBe(false);
    });

    it('revokes all sessions but one when asked', async () => {
      const a = await createSession(handle.db, { userId, now: NOW });
      const b = await createSession(handle.db, { userId, now: NOW });
      const c = await createSession(handle.db, { userId, now: NOW });

      const revoked = await revokeAllSessions(handle.db, {
        userId,
        exceptSessionId: b.sessionId,
        now: at(MINUTE),
      });
      expect(revoked).toBe(2);
      expect((await validateSession(handle.db, a.token, at(2 * MINUTE))).valid).toBe(false);
      expect((await validateSession(handle.db, b.token, at(2 * MINUTE))).valid).toBe(true);
      expect((await validateSession(handle.db, c.token, at(2 * MINUTE))).valid).toBe(false);
    });

    it('lists only live sessions', async () => {
      const a = await createSession(handle.db, { userId, now: NOW });
      await createSession(handle.db, { userId, now: NOW });
      await revokeSession(handle.db, a.sessionId, at(MINUTE));
      const live = await listActiveSessions(handle.db, userId, at(2 * MINUTE));
      expect(live).toHaveLength(1);
    });

    it('prunes sessions that can no longer be valid', async () => {
      const old = await createSession(handle.db, { userId, now: at(-60 * DAY) });
      await createSession(handle.db, { userId, now: NOW });
      const deleted = await pruneSessions(handle.db, NOW);
      expect(deleted).toBe(1);
      const remaining = await handle.db.select({ id: sessions.id }).from(sessions);
      expect(remaining.map((r) => r.id)).not.toContain(old.sessionId);
    });
  });

  // ── session_epoch ───────────────────────────────────────────────────────

  describe('session_epoch semantics', () => {
    it('invalidates every other session on password change', async () => {
      const phone = await createSession(handle.db, { userId, now: NOW });
      const laptop = await createSession(handle.db, { userId, now: NOW });
      const desktop = await createSession(handle.db, { userId, now: NOW });

      const changed = await changePassword(handle.db, {
        userId,
        currentPassword: PASSWORD,
        newPassword: OTHER_PASSWORD,
        now: at(HOUR),
      });

      // Every pre-existing session is dead, including the one that made the change:
      // the token is rotated rather than spared, so `session_epoch` needs no
      // exception carved into it.
      expect(changed.revokedCount).toBe(3);
      for (const s of [phone, laptop, desktop]) {
        expect((await validateSession(handle.db, s.token, at(HOUR + MINUTE))).valid).toBe(
          false,
        );
      }

      // The caller stays authenticated via the freshly issued session.
      const fresh = await validateSession(handle.db, changed.session.token, at(HOUR + MINUTE));
      expect(fresh.valid).toBe(true);
    });

    it('lets the user log in with the new password and not the old', async () => {
      await changePassword(handle.db, {
        userId,
        currentPassword: PASSWORD,
        newPassword: OTHER_PASSWORD,
        now: at(HOUR),
      });
      expect(
        (await login(handle.db, { email: EMAIL, password: OTHER_PASSWORD, now: at(2 * HOUR) }))
          .ok,
      ).toBe(true);
      expect(
        (await login(handle.db, { email: EMAIL, password: PASSWORD, now: at(3 * HOUR) })).ok,
      ).toBe(false);
    });

    it('rejects a session issued before the epoch even if never explicitly revoked', async () => {
      // The defence-in-depth property: bumping the epoch alone is sufficient, so a
      // revocation that somehow failed to run cannot leave a session alive.
      const stale = await createSession(handle.db, { userId, now: NOW });
      await handle.db
        .update(users)
        .set({ sessionEpoch: at(HOUR) })
        .where(eq(users.id, userId));
      // Deliberately clear the revocation to isolate the epoch check.
      await handle.db.update(sessions).set({ revokedAt: null });

      const after = await validateSession(handle.db, stale.token, at(2 * HOUR));
      expect(after.valid).toBe(false);
      if (after.valid) return;
      expect(after.reason).toBe('EPOCH_INVALIDATED');
    });

    it('leaves a session issued after the epoch valid', async () => {
      await handle.db
        .update(users)
        .set({ sessionEpoch: at(HOUR) })
        .where(eq(users.id, userId));
      const fresh = await createSession(handle.db, { userId, now: at(2 * HOUR) });
      expect((await validateSession(handle.db, fresh.token, at(3 * HOUR))).valid).toBe(true);
    });

    it('refuses a password change with the wrong current password', async () => {
      await expect(
        changePassword(handle.db, {
          userId,
          currentPassword: 'not the password',
          newPassword: OTHER_PASSWORD,
          now: at(HOUR),
        }),
      ).rejects.toThrow(/current password/i);
    });

    it('refuses reusing the same password', async () => {
      await expect(
        changePassword(handle.db, {
          userId,
          currentPassword: PASSWORD,
          newPassword: PASSWORD,
          now: at(HOUR),
        }),
      ).rejects.toThrow(/differ/i);
    });

    it('refuses a new password that fails policy', async () => {
      await expect(
        changePassword(handle.db, {
          userId,
          currentPassword: PASSWORD,
          newPassword: 'short',
          now: at(HOUR),
        }),
      ).rejects.toThrow(/at least/i);
    });

    it('ends every session on an administrative reset', async () => {
      await createSession(handle.db, { userId, now: NOW });
      await createSession(handle.db, { userId, now: NOW });
      const revoked = await adminResetPassword(handle.db, {
        userId,
        newPassword: OTHER_PASSWORD,
        now: at(HOUR),
      });
      expect(revoked).toBe(2);
      expect(await listActiveSessions(handle.db, userId, at(HOUR + MINUTE))).toHaveLength(0);
    });
  });

  describe('normaliseIdentifier', () => {
    it('lowercases and trims', () => {
      expect(normaliseIdentifier('  AHMED@Example.COM ')).toBe(EMAIL);
    });
  });
});
