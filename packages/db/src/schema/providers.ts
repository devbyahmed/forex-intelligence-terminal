/**
 * Provider plumbing: raw archive, cache, health, and the job ledger.
 *
 * `job_runs` is load-bearing beyond bookkeeping — it is the *source of truth for
 * what is due*. The runner reads it rather than holding schedule state in memory,
 * which is what lets the same code run under a long-lived process or a serverless
 * HTTP trigger, and lets a worker that was offline catch up correctly
 * (ARCHITECTURE §14.4).
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { breakerState, jobStatus } from './enums.js';
import { primaryId, timestamps } from './columns.js';

/**
 * Raw provider payloads, kept so any derived value can be recomputed and audited.
 *
 * The dominant storage consumer against a 0.5 GB cap, so it carries a retention
 * window pruned by a scheduled job — see LIMITS.md §1. Without that window this
 * table alone exceeds the free tier within about three months.
 */
export const providerResponses = pgTable(
  'provider_responses',
  {
    id: primaryId(),
    providerId: text('provider_id').notNull(),
    /** Logical operation, e.g. 'getSeries:DGS10'. Not the URL — URLs carry keys. */
    operation: text('operation').notNull(),
    requestUrl: text('request_url'),
    httpStatus: integer('http_status'),
    /** SHA-256 of the body, so an unchanged payload is stored once. */
    payloadHash: text('payload_hash').notNull(),
    payload: jsonb('payload'),
    durationMs: integer('duration_ms'),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index('provider_responses_provider_time_idx').on(t.providerId, t.retrievedAt),
    // Drives the retention sweep.
    index('provider_responses_retrieved_at_idx').on(t.retrievedAt),
    uniqueIndex('provider_responses_hash_operation_idx').on(t.payloadHash, t.operation),
  ],
);

/** Response cache (master PRD §39). Postgres-backed; `CacheStore` allows Redis later. */
export const providerCache = pgTable(
  'provider_cache',
  {
    key: text('key').primaryKey(),
    payload: jsonb('payload').notNull(),
    /** Provenance travels with the cached value; a cache hit is still a sourced fact. */
    provenance: jsonb('provenance').notNull(),
    storedAt: timestamp('stored_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps(),
  },
  (t) => [index('provider_cache_expires_at_idx').on(t.expiresAt)],
);

/**
 * Live provider health (master PRD §40).
 *
 * Feeds the system status panel and the confidence engine: a chain running on its
 * fallback is less trustworthy than one running on its primary, and confidence
 * should say so.
 */
export const providerStatus = pgTable(
  'provider_status',
  {
    providerId: text('provider_id').primaryKey(),
    domain: text('domain').notNull(),
    tier: smallint('tier').notNull(),
    breaker: breakerState('breaker').notNull().default('CLOSED'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
    lastErrorCode: text('last_error_code'),
    /** Never a raw provider body — that could contain a key echoed back. */
    lastErrorMessage: text('last_error_message'),
    breakerOpenedAt: timestamp('breaker_opened_at', { withTimezone: true, mode: 'date' }),
    /** Local view of remaining free-tier quota, for the status panel. */
    quotaUsedToday: integer('quota_used_today').notNull().default(0),
    quotaLimitDaily: integer('quota_limit_daily'),
    quotaResetAt: timestamp('quota_reset_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [index('provider_status_domain_idx').on(t.domain)],
);

/**
 * The job ledger — the scheduler's memory.
 *
 * `(job_name, scheduled_for)` is unique, which is the idempotency guarantee: two
 * triggers firing for the same slot cannot both run it. `scheduled_for` is the
 * canonical slot the run belongs to, not the moment it happened, so a late run still
 * occupies the slot it was meant for.
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: primaryId(),
    jobName: text('job_name').notNull(),
    /** The scheduling slot this run claims. Distinct from `startedAt`. */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }).notNull(),
    status: jobStatus('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    durationMs: integer('duration_ms'),
    itemsProcessed: integer('items_processed').notNull().default(0),
    /** User-safe message only. Detail belongs in the logs. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** Which trigger invoked it — 'interval' or 'http'. Useful when debugging drift. */
    triggeredBy: text('triggered_by'),
    attempt: integer('attempt').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('job_runs_name_slot_idx').on(t.jobName, t.scheduledFor),
    index('job_runs_name_time_idx').on(t.jobName, t.scheduledFor.desc()),
    index('job_runs_status_idx').on(t.status),
    check(
      'job_runs_finished_after_started',
      sql`${t.finishedAt} is null or ${t.startedAt} is null or ${t.finishedAt} >= ${t.startedAt}`,
    ),
  ],
);
