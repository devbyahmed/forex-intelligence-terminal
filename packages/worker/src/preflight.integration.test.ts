/**
 * Worker preflight against real Postgres.
 *
 * The property under test is that a divergent database stops the pipeline instead of
 * being ingested into. That only means something against a real database, and only
 * if the corruption used is the corruption that actually happened.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SeedIntegrityError, macroSeries, seed } from '@forex-agent/db';
import { createTestDb, hasTestDatabase, type TestDb } from '@forex-agent/db/test-support';
import { assertWorkerPreflight, resetPreflightCache } from './preflight.js';
import { handleHttpTrigger } from './triggers/http.js';

const describeIfDb = hasTestDatabase() ? describe : describe.skip;

describeIfDb('worker preflight (real Postgres)', () => {
  let handle: TestDb;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
    await seed(handle.db, { profileName: 'default', config: { placeholder: true } });
    resetPreflightCache();
  });

  it('passes against a correctly seeded database', async () => {
    await expect(assertWorkerPreflight(handle.db)).resolves.toBeUndefined();
  });

  it('refuses to proceed when the database diverges from the seed', async () => {
    await handle.db
      .update(macroSeries)
      .set({ cadence: 'DAILY' })
      .where(eq(macroSeries.seriesId, 'DTWEXBGS'));
    resetPreflightCache();

    await expect(assertWorkerPreflight(handle.db)).rejects.toThrow(SeedIntegrityError);
  });

  it('caches a pass, so a 15-minute tick does not re-query every time', async () => {
    const t0 = new Date('2026-08-30T12:00:00Z');
    await assertWorkerPreflight(handle.db, { now: t0 });

    // Corrupt the database, then ask again inside the cache window. The cached pass
    // is the point: this is what keeps the check off the hot path.
    await handle.db
      .update(macroSeries)
      .set({ cadence: 'DAILY' })
      .where(eq(macroSeries.seriesId, 'DTWEXBGS'));

    const t1 = new Date('2026-08-30T12:15:00Z');
    await expect(assertWorkerPreflight(handle.db, { now: t1 })).resolves.toBeUndefined();
  });

  it('re-checks once the cached pass expires', async () => {
    // A long-lived process must not hold a pass from days ago. Six hours is short
    // enough that a divergence introduced by a migration surfaces the same day.
    const t0 = new Date('2026-08-30T12:00:00Z');
    await assertWorkerPreflight(handle.db, { now: t0 });

    await handle.db
      .update(macroSeries)
      .set({ cadence: 'DAILY' })
      .where(eq(macroSeries.seriesId, 'DTWEXBGS'));

    const t1 = new Date('2026-08-30T19:00:00Z');
    await expect(assertWorkerPreflight(handle.db, { now: t1 })).rejects.toThrow(SeedIntegrityError);
  });

  it('never caches a failure', async () => {
    // If a failure were cached, the first tick after a bad deploy would be the only
    // one that complained, and the pipeline would go quiet rather than loud.
    await handle.db
      .update(macroSeries)
      .set({ cadence: 'DAILY' })
      .where(eq(macroSeries.seriesId, 'DTWEXBGS'));
    resetPreflightCache();

    const t0 = new Date('2026-08-30T12:00:00Z');
    await expect(assertWorkerPreflight(handle.db, { now: t0 })).rejects.toThrow(SeedIntegrityError);
    // Immediately again, well inside the cache window.
    await expect(
      assertWorkerPreflight(handle.db, { now: new Date('2026-08-30T12:00:01Z') }),
    ).rejects.toThrow(SeedIntegrityError);
  });

  it('stops the HTTP trigger, without leaking the divergence to a public caller', async () => {
    await handle.db
      .update(macroSeries)
      .set({ cadence: 'DAILY' })
      .where(eq(macroSeries.seriesId, 'DTWEXBGS'));
    resetPreflightCache();

    const seen: unknown[] = [];
    const response = await handleHttpTrigger(
      { secret: 'correct-secret', now: new Date('2026-08-30T12:00:00Z') },
      {
        db: handle.db,
        jobs: [],
        expectedSecret: 'correct-secret',
        onPreflightFailure: (e) => seen.push(e),
      },
    );

    expect(response.status).toBe(500);
    // The body says nothing useful — the endpoint is public and the divergence list
    // names internal series ids and feed URLs.
    expect(JSON.stringify(response.body)).not.toContain('DTWEXBGS');
    // The operator, however, gets the whole thing.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(SeedIntegrityError);
    expect((seen[0] as Error).message).toContain('DTWEXBGS');
  });
});
