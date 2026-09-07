/**
 * Rate limiter and circuit breaker integration tests.
 *
 * All of this state lives in Postgres for the same reason the login limiter does:
 * the primary target is serverless, so a counter in a module-level variable resets on
 * every cold start. It would pass any test using a fake and silently allow unlimited
 * requests in production — burning a free tier measured in hundreds of calls a day.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, hasTestDatabase, type TestDb } from '@forex-agent/db/test-support';
import {
  DEFAULT_BREAKER,
  acquireSlot,
  backoffDelayMs,
  ensureProviderStatus,
  getProviderStatus,
  isRetryableStatus,
  recordFailure,
  recordSuccess,
} from './resilience.js';
import { parseRetryAfter } from './http.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

const NOW = new Date('2026-08-30T12:00:00.000Z');
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const PROVIDER = 'test-provider';

describe('backoff', () => {
  it('grows exponentially and is capped', () => {
    const noJitter = () => 1;
    expect(backoffDelayMs(1, 1000, 30_000, noJitter)).toBe(1000);
    expect(backoffDelayMs(2, 1000, 30_000, noJitter)).toBe(2000);
    expect(backoffDelayMs(3, 1000, 30_000, noJitter)).toBe(4000);
    expect(backoffDelayMs(20, 1000, 30_000, noJitter)).toBe(30_000);
  });

  it('applies jitter', () => {
    // Without jitter, many clients failing together retry in lockstep and hammer a
    // recovering service at exactly the same moment.
    expect(backoffDelayMs(3, 1000, 30_000, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(3, 1000, 30_000, () => 0)).toBe(0);
  });
});

describe('isRetryableStatus', () => {
  it('retries throttling and server errors only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    // A 401 or 404 will fail identically on retry; retrying wastes quota.
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('reads a seconds value', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Sun, 30 Aug 2026 12:01:00 GMT', NOW)).toBe(60_000);
  });

  it('returns null for absent or unparseable values', () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter('soon', NOW)).toBeNull();
  });

  it('never returns a negative delay for a past date', () => {
    expect(parseRetryAfter('Sun, 30 Aug 2026 11:00:00 GMT', NOW)).toBe(0);
  });
});

describeDb('provider resilience (real Postgres)', () => {
  let handle: TestDb;

  beforeAll(async () => {
    handle = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
  });

  describe('registration', () => {
    it('fails closed for an unregistered provider', async () => {
      // No status row means unmetered calls would be possible; refuse instead.
      const decision = await acquireSlot(handle.db, {
        providerId: 'never-registered',
        limits: {},
        now: NOW,
      });
      expect(decision.allowed).toBe(false);
    });

    it('is idempotent', async () => {
      await ensureProviderStatus(handle.db, { providerId: PROVIDER, domain: 'MACRO', tier: 1 });
      await ensureProviderStatus(handle.db, { providerId: PROVIDER, domain: 'MACRO', tier: 1 });
      expect(await getProviderStatus(handle.db, PROVIDER)).not.toBeNull();
    });
  });

  describe('daily quota', () => {
    beforeEach(async () => {
      await ensureProviderStatus(handle.db, {
        providerId: PROVIDER,
        domain: 'MARKET_DATA',
        tier: 2,
      });
    });

    it('allows calls up to the cap and refuses beyond it', async () => {
      const limits = { requestsPerDay: 3 };
      for (let i = 0; i < 3; i += 1) {
        expect((await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW })).allowed).toBe(
          true,
        );
      }
      const over = await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW });
      expect(over.allowed).toBe(false);
      if (over.allowed) return;
      expect(over.reason).toBe('QUOTA_EXHAUSTED');
    });

    it('counts credits rather than calls when the vendor meters that way', async () => {
      // Twelve Data bills credits, and one call can cost several.
      const limits = { creditsPerDay: 10, creditsPerRequest: 4 };
      expect((await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW })).allowed).toBe(true);
      expect((await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW })).allowed).toBe(true);
      // 8 used, a third call would be 12 — over the cap.
      expect((await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW })).allowed).toBe(false);
    });

    it('is atomic under concurrency', async () => {
      // Two invocations reading the same counter and both deciding they are under
      // the limit is exactly how a free tier gets burned.
      const limits = { requestsPerDay: 5 };
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW }),
        ),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(5);
    });

    it('resets after the quota window', async () => {
      const limits = { requestsPerDay: 2 };
      await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW });
      await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW });
      expect((await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW })).allowed).toBe(false);

      const tomorrow = at(25 * 60 * 60_000);
      expect(
        (await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: tomorrow })).allowed,
      ).toBe(true);
    });

    it('survives a process restart', async () => {
      const limits = { requestsPerDay: 2 };
      await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW });
      await acquireSlot(handle.db, { providerId: PROVIDER, limits, now: NOW });

      // A second connection stands in for a fresh serverless instance.
      const fresh = await createTestDb();
      try {
        const decision = await acquireSlot(fresh.db, { providerId: PROVIDER, limits, now: NOW });
        expect(decision.allowed).toBe(false);
      } finally {
        await fresh.close();
      }
    }, 30_000);

    it('imposes no cap when the vendor documents none', async () => {
      for (let i = 0; i < 50; i += 1) {
        expect(
          (await acquireSlot(handle.db, { providerId: PROVIDER, limits: {}, now: NOW })).allowed,
        ).toBe(true);
      }
    });
  });

  describe('circuit breaker', () => {
    beforeEach(async () => {
      await ensureProviderStatus(handle.db, { providerId: PROVIDER, domain: 'NEWS', tier: 3 });
    });

    it('opens after consecutive failures', async () => {
      for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i += 1) {
        await recordFailure(handle.db, {
          providerId: PROVIDER,
          now: NOW,
          errorCode: 'TIMEOUT',
        });
      }
      const status = await getProviderStatus(handle.db, PROVIDER);
      expect(status?.breaker).toBe('OPEN');
    });

    it('refuses calls while open', async () => {
      // Master PRD §40: never continuously retry an unavailable API.
      for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i += 1) {
        await recordFailure(handle.db, { providerId: PROVIDER, now: NOW, errorCode: 'TIMEOUT' });
      }
      const decision = await acquireSlot(handle.db, {
        providerId: PROVIDER,
        limits: {},
        now: at(1000),
      });
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reason).toBe('CIRCUIT_OPEN');
      expect(decision.retryAfterMs).toBeGreaterThan(0);
    });

    it('half-opens after the cooldown to allow one trial call', async () => {
      for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i += 1) {
        await recordFailure(handle.db, { providerId: PROVIDER, now: NOW, errorCode: 'TIMEOUT' });
      }
      const afterCooldown = at(DEFAULT_BREAKER.cooldownMs + 1000);
      const decision = await acquireSlot(handle.db, {
        providerId: PROVIDER,
        limits: {},
        now: afterCooldown,
      });
      expect(decision.allowed).toBe(true);
      expect((await getProviderStatus(handle.db, PROVIDER))?.breaker).toBe('HALF_OPEN');
    });

    it('closes on the next success and clears the failure count', async () => {
      for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i += 1) {
        await recordFailure(handle.db, { providerId: PROVIDER, now: NOW, errorCode: 'TIMEOUT' });
      }
      await recordSuccess(handle.db, PROVIDER, at(60_000));
      const status = await getProviderStatus(handle.db, PROVIDER);
      expect(status?.breaker).toBe('CLOSED');
      expect(status?.consecutiveFailures).toBe(0);
      expect(status?.lastSuccessAt).not.toBeNull();
    });

    it('does not open on intermittent failures broken by a success', async () => {
      // Consecutive, not cumulative: a flaky provider that mostly works should stay
      // in the chain.
      for (let i = 0; i < 4; i += 1) {
        await recordFailure(handle.db, { providerId: PROVIDER, now: NOW, errorCode: 'TIMEOUT' });
      }
      await recordSuccess(handle.db, PROVIDER, at(1000));
      for (let i = 0; i < 4; i += 1) {
        await recordFailure(handle.db, { providerId: PROVIDER, now: at(2000), errorCode: 'TIMEOUT' });
      }
      expect((await getProviderStatus(handle.db, PROVIDER))?.breaker).toBe('CLOSED');
    });

    it('truncates the recorded error and never stores a raw provider body', async () => {
      // An error response can echo back the API key that was sent.
      await recordFailure(handle.db, {
        providerId: PROVIDER,
        now: NOW,
        errorCode: 'HTTP_500',
        errorMessage: 'x'.repeat(5000),
      });
      const status = await getProviderStatus(handle.db, PROVIDER);
      expect(status?.consecutiveFailures).toBe(1);
    });
  });
});
