/**
 * Job runner integration tests.
 *
 * The properties under test — idempotency, catch-up after downtime, no double
 * execution — are all properties of the *ledger*, so they can only be verified
 * against a real database. A fake would make the unique key and the advisory lock,
 * which are the entire mechanism, untested.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobRuns, seed } from '@forex-agent/db';
import { createTestDb, hasTestDatabase, type TestDb } from '@forex-agent/db/test-support';
import {
  nextDueSlot,
  reclaimStuckRuns,
  recentRuns,
  runDue,
  runOne,
  slotFor,
  type JobDefinition,
} from './runner.js';
import { handleHttpTrigger } from './triggers/http.js';
import { resetPreflightCache } from './preflight.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

const MINUTE = 60_000;
const NOW = new Date('2026-08-30T12:07:33.000Z');

const makeJob = (
  overrides: Partial<JobDefinition> & { name: string },
): JobDefinition => ({
  intervalMs: 15 * MINUTE,
  timeoutMs: 10_000,
  handler: () => Promise.resolve({ itemsProcessed: 1 }),
  ...overrides,
});

describe('slotFor', () => {
  it('aligns a moment down to its slot boundary', () => {
    // Slots are epoch-aligned, not relative to process start — two instances must
    // agree on which slot a moment belongs to for the unique key to work.
    expect(slotFor(NOW, 15 * MINUTE).toISOString()).toBe('2026-08-30T12:00:00.000Z');
    expect(slotFor(new Date('2026-08-30T12:14:59Z'), 15 * MINUTE).toISOString()).toBe(
      '2026-08-30T12:00:00.000Z',
    );
    expect(slotFor(new Date('2026-08-30T12:15:00Z'), 15 * MINUTE).toISOString()).toBe(
      '2026-08-30T12:15:00.000Z',
    );
  });

  it('is stable across separate calls with different moments in one slot', () => {
    const a = slotFor(new Date('2026-08-30T12:00:01Z'), 15 * MINUTE);
    const b = slotFor(new Date('2026-08-30T12:14:58Z'), 15 * MINUTE);
    expect(a.getTime()).toBe(b.getTime());
  });
});

describeDb('job runner (real Postgres)', () => {
  let handle: TestDb;

  beforeAll(async () => {
    handle = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
    // The triggers run `assertWorkerPreflight`, which refuses to ingest against a
    // database that disagrees with the seed — and a truncated database disagrees
    // with it completely. Re-seeding here is not a workaround for the check: it is
    // what makes these tests exercise the real production path rather than a
    // variant with the safety turned off. There is deliberately no off switch.
    await seed(handle.db, { profileName: 'default', config: { placeholder: true } });
    resetPreflightCache();
  });

  describe('due-ness from the ledger', () => {
    it('reports a job due when its slot has no run', async () => {
      const job = makeJob({ name: 'test.tick' });
      const slot = await nextDueSlot(handle.db, job, NOW);
      expect(slot?.toISOString()).toBe('2026-08-30T12:00:00.000Z');
    });

    it('reports not due once the slot has a run', async () => {
      const job = makeJob({ name: 'test.tick' });
      await runOne(handle.db, job, slotFor(NOW, job.intervalMs), NOW, 'test');
      expect(await nextDueSlot(handle.db, job, NOW)).toBeNull();
    });

    it('becomes due again in the next slot', async () => {
      const job = makeJob({ name: 'test.tick' });
      await runOne(handle.db, job, slotFor(NOW, job.intervalMs), NOW, 'test');
      const later = new Date(NOW.getTime() + 15 * MINUTE);
      expect(await nextDueSlot(handle.db, job, later)).not.toBeNull();
    });
  });

  describe('idempotency', () => {
    it('runs a slot exactly once even when two triggers fire together', async () => {
      // The core guarantee. Both callers see the slot as due; only one may execute.
      let executions = 0;
      const job = makeJob({
        name: 'test.once',
        handler: () => {
          executions += 1;
          return Promise.resolve({ itemsProcessed: 1 });
        },
      });
      const slot = slotFor(NOW, job.intervalMs);

      const [a, b] = await Promise.all([
        runOne(handle.db, job, slot, NOW, 'trigger-a'),
        runOne(handle.db, job, slot, NOW, 'trigger-b'),
      ]);

      expect(executions).toBe(1);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(['ALREADY_CLAIMED', 'SUCCEEDED']);
    });

    it('leaves exactly one ledger row per slot', async () => {
      const job = makeJob({ name: 'test.once' });
      const slot = slotFor(NOW, job.intervalMs);
      await runOne(handle.db, job, slot, NOW, 'a');
      await runOne(handle.db, job, slot, NOW, 'b');
      const rows = await handle.db
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .where(eq(jobRuns.jobName, 'test.once'));
      expect(rows).toHaveLength(1);
    });
  });

  describe('trigger equivalence', () => {
    it('produces the same result under the interval and HTTP triggers', async () => {
      // The whole point of the redesign: one code path, two deployment shapes. If
      // these ever diverge, the fallback target silently behaves differently.
      const runs: string[] = [];
      const job = makeJob({
        name: 'test.equivalent',
        handler: (ctx) => {
          runs.push(ctx.jobName);
          return Promise.resolve({ itemsProcessed: 3 });
        },
      });

      const viaInterval = await runDue({
        db: handle.db,
        jobs: [job],
        now: NOW,
        triggeredBy: 'interval',
      });

      const nextSlot = new Date(NOW.getTime() + 15 * MINUTE);
      const viaHttp = await handleHttpTrigger(
        { secret: 'shared-secret', now: nextSlot },
        { db: handle.db, jobs: [job], expectedSecret: 'shared-secret' },
      );

      expect(viaInterval.runs[0]?.status).toBe('SUCCEEDED');
      expect(viaInterval.runs[0]?.itemsProcessed).toBe(3);
      expect(viaHttp.status).toBe(200);
      if (viaHttp.status !== 200) return;
      expect(viaHttp.body.runs[0]?.status).toBe('SUCCEEDED');
      expect(viaHttp.body.runs[0]?.itemsProcessed).toBe(3);
      expect(runs).toHaveLength(2);
    });

    it('records which trigger ran each slot', async () => {
      const job = makeJob({ name: 'test.provenance' });
      await runDue({ db: handle.db, jobs: [job], now: NOW, triggeredBy: 'http' });
      const [row] = await handle.db
        .select({ triggeredBy: jobRuns.triggeredBy })
        .from(jobRuns)
        .where(eq(jobRuns.jobName, 'test.provenance'));
      expect(row?.triggeredBy).toBe('http');
    });
  });

  describe('catch-up after downtime', () => {
    it('runs once on restart rather than replaying every missed slot', async () => {
      // After an eight-hour outage, thirty-two identical ingestion ticks would burn
      // provider quota fetching the same current data over and over. One run gets
      // the same result.
      let executions = 0;
      const job = makeJob({
        name: 'test.catchup',
        handler: () => {
          executions += 1;
          return Promise.resolve({ itemsProcessed: 1 });
        },
      });

      await runDue({ db: handle.db, jobs: [job], now: NOW, triggeredBy: 'interval' });
      expect(executions).toBe(1);

      // Eight hours later, after being offline the whole time.
      const afterOutage = new Date(NOW.getTime() + 8 * 60 * MINUTE);
      await runDue({ db: handle.db, jobs: [job], now: afterOutage, triggeredBy: 'interval' });
      expect(executions).toBe(2);

      const rows = await recentRuns(handle.db, 'test.catchup', 50);
      expect(rows).toHaveLength(2);
    });
  });

  describe('failure handling', () => {
    it('records a failure without leaking the underlying message', async () => {
      const job = makeJob({
        name: 'test.fails',
        handler: () => Promise.reject(new Error('postgres://user:hunter2@host/db unreachable')),
      });
      const summary = await runOne(handle.db, job, slotFor(NOW, job.intervalMs), NOW, 'test');
      expect(summary.status).toBe('FAILED');

      const [row] = await handle.db
        .select({ status: jobRuns.status, message: jobRuns.errorMessage })
        .from(jobRuns)
        .where(eq(jobRuns.jobName, 'test.fails'));
      expect(row?.status).toBe('FAILED');
      // The ledger is operational data, not a place for connection strings.
      expect(row?.message ?? '').not.toContain('hunter2');
    });

    it('does not re-run a failed slot', async () => {
      // A job that fails every time must not become an infinite retry loop against
      // a metered provider quota; it waits for the next slot.
      let executions = 0;
      const job = makeJob({
        name: 'test.failonce',
        handler: () => {
          executions += 1;
          return Promise.reject(new Error('nope'));
        },
      });
      await runDue({ db: handle.db, jobs: [job], now: NOW, triggeredBy: 'test' });
      await runDue({ db: handle.db, jobs: [job], now: NOW, triggeredBy: 'test' });
      expect(executions).toBe(1);
    });

    it('times out a hung job rather than wedging the schedule', async () => {
      const job = makeJob({
        name: 'test.hangs',
        timeoutMs: 200,
        handler: () => new Promise(() => undefined),
      });
      const summary = await runOne(handle.db, job, slotFor(NOW, job.intervalMs), NOW, 'test');
      expect(summary.status).toBe('TIMED_OUT');
    }, 15_000);

    it('continues to later jobs after one fails', async () => {
      let secondRan = false;
      const failing = makeJob({
        name: 'test.first',
        handler: () => Promise.reject(new Error('boom')),
      });
      const succeeding = makeJob({
        name: 'test.second',
        handler: () => {
          secondRan = true;
          return Promise.resolve({ itemsProcessed: 1 });
        },
      });
      const result = await runDue({
        db: handle.db,
        jobs: [failing, succeeding],
        now: NOW,
        triggeredBy: 'test',
      });
      expect(secondRan).toBe(true);
      expect(result.runs.map((r) => r.status)).toEqual(['FAILED', 'SUCCEEDED']);
    });
  });

  describe('shouldRun gate', () => {
    it('claims the slot and skips without recording a failure', async () => {
      let ran = false;
      const job = makeJob({
        name: 'test.gated',
        shouldRun: () => false,
        handler: () => {
          ran = true;
          return Promise.resolve({ itemsProcessed: 1 });
        },
      });
      const summary = await runOne(handle.db, job, slotFor(NOW, job.intervalMs), NOW, 'test');
      expect(ran).toBe(false);
      expect(summary.status).toBe('SKIPPED');

      // Claiming the slot stops the gate being re-evaluated every tick.
      expect(await nextDueSlot(handle.db, job, NOW)).toBeNull();
    });
  });

  describe('budget', () => {
    it('defers remaining jobs when the time budget is spent', async () => {
      // On a 300 s function limit, unreached work must stay due rather than be lost.
      const slow = makeJob({
        name: 'test.slow',
        handler: async () => {
          await new Promise((r) => setTimeout(r, 300));
          return { itemsProcessed: 1 };
        },
      });
      const later = makeJob({ name: 'test.later' });

      const result = await runDue({
        db: handle.db,
        jobs: [slow, later],
        now: NOW,
        triggeredBy: 'test',
        budgetMs: 100,
      });

      expect(result.runs).toHaveLength(1);
      // Still due, so the next tick picks it up.
      expect(await nextDueSlot(handle.db, later, NOW)).not.toBeNull();
    }, 15_000);
  });

  describe('stuck run recovery', () => {
    it('reclaims a run abandoned mid-execution', async () => {
      // A serverless invocation killed mid-job leaves its row claimed forever, which
      // would silently stop that job from ever running again.
      const job = makeJob({ name: 'test.stuck' });
      const slot = slotFor(NOW, job.intervalMs);
      await handle.db.insert(jobRuns).values({
        jobName: job.name,
        scheduledFor: slot,
        status: 'RUNNING',
        startedAt: new Date(NOW.getTime() - 60 * MINUTE),
        triggeredBy: 'test',
      });

      const reclaimed = await reclaimStuckRuns(handle.db, NOW, 15 * MINUTE);
      expect(reclaimed).toBe(1);

      const [row] = await handle.db
        .select({ status: jobRuns.status, code: jobRuns.errorCode })
        .from(jobRuns)
        .where(eq(jobRuns.jobName, 'test.stuck'));
      expect(row?.status).toBe('FAILED');
      expect(row?.code).toBe('ABANDONED');
    });

    it('leaves a recently started run alone', async () => {
      const job = makeJob({ name: 'test.running' });
      await handle.db.insert(jobRuns).values({
        jobName: job.name,
        scheduledFor: slotFor(NOW, job.intervalMs),
        status: 'RUNNING',
        startedAt: new Date(NOW.getTime() - MINUTE),
        triggeredBy: 'test',
      });
      expect(await reclaimStuckRuns(handle.db, NOW, 15 * MINUTE)).toBe(0);
    });
  });

  describe('HTTP trigger authentication', () => {
    it('rejects a missing secret', async () => {
      const response = await handleHttpTrigger(
        { secret: undefined },
        { db: handle.db, jobs: [], expectedSecret: 'correct' },
      );
      expect(response.status).toBe(401);
    });

    it('rejects a wrong secret', async () => {
      // The endpoint is publicly reachable; without this anyone could force
      // ingestion and exhaust a free-tier provider quota for us.
      const response = await handleHttpTrigger(
        { secret: 'wrong-secret' },
        { db: handle.db, jobs: [], expectedSecret: 'correct-secret' },
      );
      expect(response.status).toBe(401);
    });

    it('rejects an empty expected secret rather than accepting anything', async () => {
      const response = await handleHttpTrigger(
        { secret: '' },
        { db: handle.db, jobs: [], expectedSecret: '' },
      );
      expect(response.status).toBe(401);
    });

    it('accepts the correct secret', async () => {
      const response = await handleHttpTrigger(
        { secret: 'correct-secret' },
        { db: handle.db, jobs: [], expectedSecret: 'correct-secret' },
      );
      expect(response.status).toBe(200);
    });
  });
});
