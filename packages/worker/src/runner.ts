/**
 * The job runner (ARCHITECTURE §14.4).
 *
 * **Due-ness is computed from the `job_runs` ledger, not from process uptime.**
 *
 * That single decision is what lets the same code run under a long-lived process and
 * under a serverless HTTP trigger, and it is why a worker that was offline for three
 * hours catches up correctly rather than silently skipping everything it missed: what
 * is due is a fact in the database, not a timer in memory.
 *
 * Each job body runs inside a **transaction-scoped** advisory lock. Session-scoped
 * locks do not survive PgBouncer in transaction pooling mode — which is exactly how
 * the primary target pools connections — so one would appear to work while doing
 * nothing.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { toAppError } from '@forex-agent/core';
import type { Database, Transaction } from '@forex-agent/db';
import { jobRuns, tryAdvisoryLock } from '@forex-agent/db';

export interface JobContext {
  readonly db: Database;
  /** The slot this run belongs to, not the wall-clock moment it started. */
  readonly scheduledFor: Date;
  readonly now: Date;
  readonly jobName: string;
}

export interface JobOutcome {
  readonly itemsProcessed: number;
  readonly detail?: string;
}

export interface JobDefinition {
  readonly name: string;
  /** How often the job should run. Slots are aligned to this interval. */
  readonly intervalMs: number;
  /** Abandoned after this long, so a hung provider cannot wedge the schedule. */
  readonly timeoutMs: number;
  readonly handler: (ctx: JobContext) => Promise<JobOutcome>;
  /**
   * Skip without recording a failure — e.g. a market-hours gate. Returning false
   * still claims the slot, so the job does not immediately re-run.
   */
  readonly shouldRun?: (now: Date) => boolean;
}

export interface JobRunSummary {
  readonly jobName: string;
  readonly scheduledFor: Date;
  readonly status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'TIMED_OUT' | 'ALREADY_CLAIMED';
  readonly durationMs: number;
  readonly itemsProcessed: number;
  readonly error?: string;
}

export interface RunDueResult {
  readonly startedAt: Date;
  readonly runs: readonly JobRunSummary[];
  readonly triggeredBy: string;
}

/**
 * Align a moment down to its slot boundary.
 *
 * Slots are absolute (epoch-aligned), not relative to when the process started, so
 * two different instances agree on which slot a moment belongs to — the property the
 * `(job_name, scheduled_for)` unique key relies on to make double execution
 * impossible.
 */
export function slotFor(now: Date, intervalMs: number): Date {
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

/**
 * Whether a job is due, and for which slot.
 *
 * Due when the current slot has no ledger row. Deliberately does **not** attempt to
 * backfill every missed slot: after an eight-hour outage, running thirty-two
 * identical ingestion ticks would burn quota to fetch the same current data
 * thirty-two times. One catch-up run gets the same result.
 */
export async function nextDueSlot(
  db: Database,
  job: JobDefinition,
  now: Date,
): Promise<Date | null> {
  const slot = slotFor(now, job.intervalMs);

  const [existing] = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(eq(jobRuns.jobName, job.name), eq(jobRuns.scheduledFor, slot)))
    .limit(1);

  return existing === undefined ? slot : null;
}

export interface RunDueOptions {
  readonly db: Database;
  readonly jobs: readonly JobDefinition[];
  readonly now: Date;
  /** 'interval' or 'http' — recorded so schedule drift is diagnosable. */
  readonly triggeredBy: string;
  /**
   * Stop starting new jobs past this budget. The primary target caps a function at
   * 300 s; work not reached is simply due again on the next tick.
   */
  readonly budgetMs?: number;
  readonly onEvent?: (event: JobRunSummary) => void;
}

export async function runDue(options: RunDueOptions): Promise<RunDueResult> {
  const startedAt = new Date();
  const runs: JobRunSummary[] = [];
  const budgetMs = options.budgetMs ?? 240_000;

  for (const job of options.jobs) {
    if (Date.now() - startedAt.getTime() > budgetMs) {
      // Out of time. Remaining jobs stay due and run on the next tick — which is
      // exactly why due-ness lives in the ledger rather than in a timer.
      break;
    }

    const slot = await nextDueSlot(options.db, job, options.now);
    if (slot === null) continue;

    const summary = await runOne(options.db, job, slot, options.now, options.triggeredBy);
    runs.push(summary);
    options.onEvent?.(summary);
  }

  return { startedAt, runs, triggeredBy: options.triggeredBy };
}

/** Run a single job for a slot, claiming it atomically first. */
export async function runOne(
  db: Database,
  job: JobDefinition,
  scheduledFor: Date,
  now: Date,
  triggeredBy: string,
): Promise<JobRunSummary> {
  const started = Date.now();

  if (job.shouldRun !== undefined && !job.shouldRun(now)) {
    // Claim the slot so the gate is not re-evaluated every tick, but record it as a
    // deliberate skip rather than a failure.
    const claimed = await claimSlot(db, job.name, scheduledFor, now, triggeredBy, 'SKIPPED');
    return {
      jobName: job.name,
      scheduledFor,
      status: claimed ? 'SKIPPED' : 'ALREADY_CLAIMED',
      durationMs: 0,
      itemsProcessed: 0,
    };
  }

  // The unique key on (job_name, scheduled_for) is the idempotency guarantee: two
  // triggers firing for one slot cannot both get past this.
  const claimed = await claimSlot(db, job.name, scheduledFor, now, triggeredBy, 'RUNNING');
  if (!claimed) {
    return {
      jobName: job.name,
      scheduledFor,
      status: 'ALREADY_CLAIMED',
      durationMs: 0,
      itemsProcessed: 0,
    };
  }

  try {
    const outcome = await withJobLock(db, job.name, async () => {
      return withTimeout(
        job.handler({ db, scheduledFor, now, jobName: job.name }),
        job.timeoutMs,
        job.name,
      );
    });

    if (outcome === null) {
      // The lock was held: another invocation is running this job right now. Not an
      // error — the ledger row is released so the slot can be retried.
      await releaseSlot(db, job.name, scheduledFor);
      return {
        jobName: job.name,
        scheduledFor,
        status: 'ALREADY_CLAIMED',
        durationMs: Date.now() - started,
        itemsProcessed: 0,
      };
    }

    const durationMs = Date.now() - started;
    await finishSlot(db, {
      jobName: job.name,
      scheduledFor,
      startedAt: now,
      status: 'SUCCEEDED',
      durationMs,
      itemsProcessed: outcome.itemsProcessed,
      errorCode: null,
      errorMessage: null,
    });

    return {
      jobName: job.name,
      scheduledFor,
      status: 'SUCCEEDED',
      durationMs,
      itemsProcessed: outcome.itemsProcessed,
    };
  } catch (e) {
    const durationMs = Date.now() - started;
    const timedOut = e instanceof JobTimeoutError;
    const appError = toAppError(e);

    await finishSlot(db, {
      jobName: job.name,
      scheduledFor,
      startedAt: now,
      status: timedOut ? 'TIMED_OUT' : 'FAILED',
      durationMs,
      itemsProcessed: 0,
      errorCode: appError.code,
      // User-safe message only; the detail belongs in the logs.
      errorMessage: appError.userMessage.slice(0, 500),
    });

    return {
      jobName: job.name,
      scheduledFor,
      status: timedOut ? 'TIMED_OUT' : 'FAILED',
      durationMs,
      itemsProcessed: 0,
      error: appError.userMessage,
    };
  }
}

export class JobTimeoutError extends Error {
  constructor(jobName: string, timeoutMs: number) {
    super(`Job ${jobName} exceeded ${String(timeoutMs)}ms`);
    this.name = 'JobTimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, jobName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new JobTimeoutError(jobName, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run `fn` holding a transaction-scoped advisory lock, or return null if held.
 *
 * Non-blocking by design: a job whose previous run is still going should be skipped,
 * not queued. Queuing would let a slow job accumulate overlapping invocations until
 * the connection pool is exhausted.
 */
async function withJobLock<T>(
  db: Database,
  jobName: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx: Transaction) => {
    const acquired = await tryAdvisoryLock(tx, `job:${jobName}`);
    if (!acquired) return null;
    return fn();
  });
}

async function claimSlot(
  db: Database,
  jobName: string,
  scheduledFor: Date,
  now: Date,
  triggeredBy: string,
  status: 'RUNNING' | 'SKIPPED',
): Promise<boolean> {
  const inserted = await db
    .insert(jobRuns)
    .values({
      jobName,
      scheduledFor,
      status,
      startedAt: now,
      ...(status === 'SKIPPED' ? { finishedAt: now, durationMs: 0 } : {}),
      triggeredBy,
    })
    .onConflictDoNothing({ target: [jobRuns.jobName, jobRuns.scheduledFor] })
    .returning({ id: jobRuns.id });

  return inserted.length > 0;
}

async function releaseSlot(db: Database, jobName: string, scheduledFor: Date): Promise<void> {
  await db
    .delete(jobRuns)
    .where(
      and(
        eq(jobRuns.jobName, jobName),
        eq(jobRuns.scheduledFor, scheduledFor),
        eq(jobRuns.status, 'RUNNING'),
      ),
    );
}

async function finishSlot(
  db: Database,
  params: {
    jobName: string;
    scheduledFor: Date;
    /** The same clock that set started_at, so the two stay consistent. */
    startedAt: Date;
    status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
    durationMs: number;
    itemsProcessed: number;
    errorCode: string | null;
    errorMessage: string | null;
  },
): Promise<void> {
  await db
    .update(jobRuns)
    .set({
      status: params.status,
      // Derived from startedAt rather than read from the wall clock: mixing an
      // injected clock with Date.now() produced a finished_at before started_at,
      // which the schema check caught. Duration is still real elapsed time.
      finishedAt: new Date(params.startedAt.getTime() + params.durationMs),
      durationMs: params.durationMs,
      itemsProcessed: params.itemsProcessed,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
    })
    .where(
      and(eq(jobRuns.jobName, params.jobName), eq(jobRuns.scheduledFor, params.scheduledFor)),
    );
}

/**
 * Reclaim runs stuck in RUNNING.
 *
 * A serverless invocation killed mid-job leaves its ledger row claimed forever,
 * which would silently stop that job from ever running again. Nothing else would
 * report it: the job would simply go quiet.
 */
export async function reclaimStuckRuns(
  db: Database,
  now: Date,
  stuckAfterMs = 15 * 60_000,
): Promise<number> {
  const cutoff = new Date(now.getTime() - stuckAfterMs);
  const reclaimed = await db
    .update(jobRuns)
    .set({
      status: 'FAILED',
      finishedAt: now,
      errorCode: 'ABANDONED',
      errorMessage: 'Run did not report completion; likely killed mid-execution.',
    })
    .where(and(eq(jobRuns.status, 'RUNNING'), sql`${jobRuns.startedAt} < ${cutoff}`))
    .returning({ id: jobRuns.id });
  return reclaimed.length;
}

export async function recentRuns(
  db: Database,
  jobName: string,
  limit = 20,
): Promise<
  { scheduledFor: Date; status: string; durationMs: number | null; itemsProcessed: number }[]
> {
  return db
    .select({
      scheduledFor: jobRuns.scheduledFor,
      status: jobRuns.status,
      durationMs: jobRuns.durationMs,
      itemsProcessed: jobRuns.itemsProcessed,
    })
    .from(jobRuns)
    .where(eq(jobRuns.jobName, jobName))
    .orderBy(desc(jobRuns.scheduledFor))
    .limit(limit);
}
