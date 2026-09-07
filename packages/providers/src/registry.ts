/**
 * The provider registry — cache, fallback chain, and the STALE/UNAVAILABLE decision
 * (master PRD §9, §39, §40).
 *
 * `resolve()` is the only way provider data enters the system, which is what makes
 * Principle P2 enforceable: there is exactly one place that decides what happens when
 * data cannot be obtained, and it has no branch that returns a substitute value.
 */

import { eq, sql } from 'drizzle-orm';
import {
  assessFreshness,
  liveTiming,
  makeObservation,
  ok,
  stale,
  unavailable,
  type AttemptLog,
  type FreshnessThresholds,
  type Observation,
  type Provenance,
  type ProviderResult,
} from '@forex-agent/core';
import type { Database } from '@forex-agent/db';
import { providerCache } from '@forex-agent/db';
import { HttpError } from './http.js';
import {
  acquireSlot,
  backoffDelayMs,
  isRetryableStatus,
  recordFailure,
  recordSuccess,
  type BreakerPolicy,
} from './resilience.js';
import type { Provider, ProviderCall, ResolveOptions } from './types.js';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseMs: number;
  readonly maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseMs: 1000, maxMs: 30_000 };

export interface RegistryDeps {
  readonly db: Database;
  readonly retry?: RetryPolicy;
  readonly breaker?: BreakerPolicy;
  /** Injected so tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface CachedEnvelope<T> {
  readonly value: T;
  readonly provenance: {
    providerId: string;
    sourceName: string;
    sourceUrl: string | null;
    sourceTier: 1 | 2 | 3 | 4;
    sourceTimestamp: string;
    retrievedAt: string;
  };
}


/**
 * A chain of providers for one domain, tried in order.
 *
 * Order is significance, not preference: the first entry is the most authoritative
 * source, so a fallback answer is always a downgrade in tier and is recorded as such.
 */
export class ProviderChain<P extends Provider> {
  constructor(
    readonly domain: string,
    private readonly providers: readonly P[],
    private readonly deps: RegistryDeps,
  ) {}

  get members(): readonly P[] {
    return this.providers;
  }

  /**
   * Resolve a call across the chain.
   *
   * 1. Fresh cache hit → `OK`
   * 2. Each configured provider whose breaker and quota allow → first success wins
   * 3. Stale cache within `acceptStaleUpToMs` → `STALE`
   * 4. Otherwise → `UNAVAILABLE`, carrying every attempt so the failure is explainable
   *
   * There is deliberately no step that produces a value from nothing.
   */
  async resolve<T>(
    call: ProviderCall<P, T>,
    options: ResolveOptions & { thresholds: FreshnessThresholds },
  ): Promise<ProviderResult<T>> {
    const attempts: AttemptLog[] = [];
    const retry = this.deps.retry ?? DEFAULT_RETRY;
    const sleep = this.deps.sleep ?? defaultSleep;

    if (options.cacheKey !== undefined && options.ttlMs !== undefined) {
      const cached = await this.readCache<T>(options.cacheKey, options.now, options.ttlMs);
      if (cached !== null) {
        return ok(this.reFresh(cached, options.thresholds, options.now));
      }
    }

    for (const provider of this.providers) {
      if (!provider.isConfigured()) {
        attempts.push({
          providerId: provider.id,
          startedAt: options.now,
          durationMs: 0,
          outcome: 'SKIPPED',
          skipReason: 'NOT_CONFIGURED',
        });
        continue;
      }

      const gate = await acquireSlot(this.deps.db, {
        providerId: provider.id,
        limits: provider.limits,
        now: options.now,
        ...(this.deps.breaker === undefined ? {} : { breaker: this.deps.breaker }),
      });

      if (!gate.allowed) {
        attempts.push({
          providerId: provider.id,
          startedAt: options.now,
          durationMs: 0,
          outcome: 'SKIPPED',
          skipReason: gate.reason,
        });
        continue;
      }

      const result = await this.callWithRetry(provider, call, attempts, retry, sleep, options.now);

      if (result !== null && result.status === 'OK') {
        await recordSuccess(this.deps.db, provider.id, options.now);
        if (options.cacheKey !== undefined) {
          await this.writeCache(options.cacheKey, result.observation, options.now, options.ttlMs ?? 0);
        }
        return result;
      }
    }

    // Every provider is exhausted. A stale cached value is still a real observation
    // with real provenance — it is just old, and it is labelled old.
    if (options.cacheKey !== undefined && options.acceptStaleUpToMs !== undefined) {
      const staleHit = await this.readCache<T>(
        options.cacheKey,
        options.now,
        options.acceptStaleUpToMs,
      );
      if (staleHit !== null) {
        const observation = this.reFresh(staleHit, options.thresholds, options.now);
        return stale(observation, 'ALL_PROVIDERS_FAILED', attempts);
      }
    }

    return unavailable<T>(
      attempts.some((a) => a.outcome === 'FAILURE') ? 'ALL_PROVIDERS_FAILED' : 'NOT_CONFIGURED',
      attempts,
    );
  }

  private async callWithRetry<T>(
    provider: P,
    call: ProviderCall<P, T>,
    attempts: AttemptLog[],
    retry: RetryPolicy,
    sleep: (ms: number) => Promise<void>,
    now: Date,
  ): Promise<ProviderResult<T> | null> {
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const startedAt = new Date();
      try {
        const result = await call(provider);
        if (result.status === 'OK') {
          attempts.push({
            providerId: provider.id,
            startedAt,
            durationMs: Date.now() - startedAt.getTime(),
            outcome: 'SUCCESS',
          });
          return result;
        }
        // The provider answered but had nothing — not an error, and not retryable.
        attempts.push({
          providerId: provider.id,
          startedAt,
          durationMs: Date.now() - startedAt.getTime(),
          outcome: 'FAILURE',
          errorCode: result.status === 'UNAVAILABLE' ? result.reason : 'STALE',
        });
        return null;
      } catch (e) {
        const durationMs = Date.now() - startedAt.getTime();
        const httpError = e instanceof HttpError ? e : null;
        const code = httpError?.code ?? 'PROVIDER_ERROR';
        const status = httpError?.status ?? null;

        attempts.push({
          providerId: provider.id,
          startedAt,
          durationMs,
          outcome: 'FAILURE',
          errorCode: code,
          errorMessage: e instanceof Error ? e.message.slice(0, 300) : String(e),
          ...(status === null ? {} : { httpStatus: status }),
        });

        await recordFailure(this.deps.db, {
          providerId: provider.id,
          now,
          errorCode: code,
          ...(e instanceof Error ? { errorMessage: e.message } : {}),
          ...(this.deps.breaker === undefined ? {} : { breaker: this.deps.breaker }),
        });

        const retryable = status === null ? code === 'TIMEOUT' || code === 'NETWORK_ERROR' : isRetryableStatus(status);
        if (!retryable || attempt === retry.maxAttempts) return null;

        await sleep(backoffDelayMs(attempt, retry.baseMs, retry.maxMs, this.deps.random));
      }
    }
    return null;
  }

  /**
   * Recompute freshness at read time.
   *
   * A value written as LIVE an hour ago is not LIVE now. Storing the status without
   * re-evaluating it would make the freshness chip a record of the past rather than a
   * statement about the present.
   */
  private reFresh<T>(
    observation: Observation<T>,
    thresholds: FreshnessThresholds,
    now: Date,
  ): Observation<T> {
    // The stored provenance already records when the value became known, so this
    // re-evaluates the same fact against the current clock rather than re-deciding
    // which timestamp to use.
    const freshness = assessFreshness(
      liveTiming(observation.provenance.sourceTimestamp, observation.provenance.retrievedAt),
      thresholds,
      now,
    );
    return { ...observation, freshness: freshness.status };
  }

  private async readCache<T>(
    key: string,
    now: Date,
    maxAgeMs: number,
  ): Promise<Observation<T> | null> {
    const cutoff = new Date(now.getTime() - maxAgeMs);
    const row = await readCacheRow(this.deps.db, key);

    if (row === undefined) return null;
    const storedAt = row.storedAt;
    if (storedAt.getTime() < cutoff.getTime()) return null;

    const payload = row.payload as CachedEnvelope<T>;
    const p = payload.provenance;
    const provenance: Provenance = {
      providerId: p.providerId,
      sourceName: p.sourceName,
      sourceUrl: p.sourceUrl,
      sourceTier: p.sourceTier,
      sourceTimestamp: new Date(p.sourceTimestamp),
      retrievedAt: new Date(p.retrievedAt),
    };
    return makeObservation(payload.value, provenance, 'RECENT');
  }

  private async writeCache<T>(
    key: string,
    observation: Observation<T>,
    now: Date,
    ttlMs: number,
  ): Promise<void> {
    const envelope: CachedEnvelope<T> = {
      value: observation.value,
      provenance: {
        providerId: observation.provenance.providerId,
        sourceName: observation.provenance.sourceName,
        sourceUrl: observation.provenance.sourceUrl,
        sourceTier: observation.provenance.sourceTier,
        sourceTimestamp: observation.provenance.sourceTimestamp.toISOString(),
        retrievedAt: observation.provenance.retrievedAt.toISOString(),
      },
    };

    await this.deps.db
      .insert(providerCache)
      .values({
        key,
        payload: envelope,
        provenance: envelope.provenance,
        storedAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
      })
      .onConflictDoUpdate({
        target: providerCache.key,
        set: {
          payload: sql`excluded.payload`,
          provenance: sql`excluded.provenance`,
          storedAt: sql`excluded.stored_at`,
          expiresAt: sql`excluded.expires_at`,
        },
      });
  }
}

/**
 * Read one cache entry.
 *
 * Typed builder rather than a raw select. It was raw, with two unused parameters and a
 * hand-written column list — the same shape that let `breaker_open_until` (a column
 * that does not exist) reach production in `systemStatus.ts`. Nothing here needs SQL
 * the builder cannot write, so nothing here should be invisible to the type checker.
 */
async function readCacheRow(
  db: Database,
  key: string,
): Promise<{ payload: unknown; storedAt: Date; expiresAt: Date } | undefined> {
  const [row] = await db
    .select({
      payload: providerCache.payload,
      storedAt: providerCache.storedAt,
      expiresAt: providerCache.expiresAt,
    })
    .from(providerCache)
    .where(eq(providerCache.key, key))
    .limit(1);
  return row;
}

/** Remove expired cache entries. Runs on the maintenance job. */
export async function pruneProviderCache(db: Database, now: Date): Promise<number> {
  const deleted = await db
    .delete(providerCache)
    .where(sql`${providerCache.expiresAt} < ${now}`)
    .returning({ key: providerCache.key });
  return deleted.length;
}
