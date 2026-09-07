/**
 * Seed reconciliation against real Postgres.
 *
 * A unit test with a fake database would prove nothing here. The property under test
 * is "the *actual* database agrees with the seed definition", and it has now failed
 * three times in a running system while every unit test passed:
 *
 *  - feeds removed from the seed stayed active (Phase 6),
 *  - `DTWEXBGS`'s cadence never propagated through the upsert (Phase 7),
 *  - and `expectedPublicationDays` arrived with the same hazard (Phase 8).
 *
 * Each test below corrupts one row in the way the real incident corrupted it, then
 * asserts the check catches it. A test that only verified the happy path would have
 * passed throughout all three incidents.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, hasTestDatabase, truncateAll, type TestDb } from './test-support.js';
import { macroSeries, newsSources, eventImportanceRules } from './schema/index.js';
import { seed, SEED_MACRO_SERIES } from './seed.js';
import { SeedIntegrityError, assertSeedIntegrity, verifySeedIntegrity } from './seedIntegrity.js';

const describeIfDb = hasTestDatabase() ? describe : describe.skip;

describeIfDb('seed integrity', () => {
  let handle: TestDb;

  // A placeholder profile, not the real one: `packages/db` depends only on
  // `packages/core` (ARCHITECTURE §4.1), which is why `seed` takes the profile as a
  // parameter rather than importing it. Nothing under test reads its contents.
  const reseed = async (): Promise<void> => {
    await seed(handle.db, { profileName: 'default', config: { placeholder: true } });
  };

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    // Truncate first. Several cases below insert rows that the seed will never
    // remove — that is the point of them — so without this each test would run
    // against the previous test's wreckage.
    await truncateAll(handle.db);
    await reseed();
  });

  it('reports no divergence for a freshly seeded database', async () => {
    // The baseline the other tests depend on: if this ever fails, every assertion
    // below is measuring the wrong thing.
    expect(await verifySeedIntegrity(handle.db)).toEqual([]);
    await expect(assertSeedIntegrity(handle.db)).resolves.toBeUndefined();
  });

  it('catches the Phase 7 incident: a cadence that never propagated', async () => {
    // The exact corruption. DTWEXBGS sat at DAILY in the database while the seed
    // said WEEKLY, and factor F1 was scored STALE at half weight for two phases.
    await handle.db
      .update(macroSeries)
      .set({ cadence: 'DAILY' })
      .where(eq(macroSeries.seriesId, 'DTWEXBGS'));

    const divergences = await verifySeedIntegrity(handle.db);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({
      entity: 'macro_series',
      key: 'DTWEXBGS',
      field: 'cadence',
      expected: 'WEEKLY',
      actual: 'DAILY',
      kind: 'FIELD_MISMATCH',
    });
  });

  it('catches the Phase 8 hazard: a publication calendar that never propagated', async () => {
    // Left at the column default, DTWEXBGS would be treated as publishing Mon–Fri
    // when it publishes only on Mondays — the weekend fix reintroducing a weekday
    // distortion of its own.
    await handle.db
      .update(macroSeries)
      .set({ expectedPublicationDays: [1, 2, 3, 4, 5] })
      .where(eq(macroSeries.seriesId, 'DTWEXBGS'));

    const divergences = await verifySeedIntegrity(handle.db);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.field).toBe('expectedPublicationDays');
    expect(divergences[0]?.expected).toEqual([1]);
  });

  it('does not report a divergence for a reordered calendar', async () => {
    // [5,4,3,2,1] is the same week. Reporting it would be noise, and noise trains
    // whoever reads this output to stop reading it.
    await handle.db
      .update(macroSeries)
      .set({ expectedPublicationDays: [5, 4, 3, 2, 1] })
      .where(eq(macroSeries.seriesId, 'DGS10'));

    expect(await verifySeedIntegrity(handle.db)).toEqual([]);
  });

  it('catches the Phase 6 incident: a feed dropped from the seed but left active', async () => {
    // BLS and Treasury were removed after failing verification, then went on
    // producing ingestion failures on every run because nothing turned them off.
    await handle.db.insert(newsSources).values({
      name: 'Retired Feed',
      feedUrl: 'https://example.invalid/retired.xml',
      tier: 1,
      isActive: true,
    });

    const divergences = await verifySeedIntegrity(handle.db);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({
      entity: 'news_sources',
      key: 'https://example.invalid/retired.xml',
      field: 'isActive',
      kind: 'ORPHANED_ROW',
    });
  });

  it('accepts a dropped feed once it has been deactivated', async () => {
    // Deactivated rather than deleted: historical articles cite it, and deleting it
    // would cascade away the provenance those facts depend on.
    await handle.db.insert(newsSources).values({
      name: 'Retired Feed',
      feedUrl: 'https://example.invalid/retired.xml',
      tier: 1,
      isActive: false,
    });

    expect(await verifySeedIntegrity(handle.db)).toEqual([]);
  });

  it('catches a non-HTTPS feed inserted by hand', async () => {
    // GDELT was rejected over exactly this. The seed test asserts it never enters
    // the seed; this asserts it cannot enter the database by another route either.
    await handle.db.insert(newsSources).values({
      name: 'Plaintext Feed',
      feedUrl: 'http://example.invalid/insecure.xml',
      tier: 3,
      isActive: true,
    });

    const divergences = await verifySeedIntegrity(handle.db);
    const scheme = divergences.find((d) => d.field === 'scheme');
    expect(scheme).toMatchObject({ expected: 'https', actual: 'http' });
  });

  it('catches an importance rule left behind after removal', async () => {
    // Rules are deleted, not deactivated — a leftover keeps classifying releases by
    // a policy the operator has already retired.
    await handle.db.insert(eventImportanceRules).values({
      country: 'ZZ',
      eventPattern: 'retired rule',
      importance: 'HIGH',
    });

    const divergences = await verifySeedIntegrity(handle.db);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({
      entity: 'event_importance_rules',
      key: 'ZZ|retired rule',
      kind: 'ORPHANED_ROW',
    });
  });

  it('catches a seeded series missing from the database entirely', async () => {
    await handle.db.delete(macroSeries).where(eq(macroSeries.seriesId, 'VIXCLS'));

    const divergences = await verifySeedIntegrity(handle.db);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({ key: 'VIXCLS', kind: 'MISSING_ROW' });
  });

  it('throws with every divergence named, not just the first', async () => {
    // Whoever reads this failure needs the whole list. Fixing them one run at a
    // time is how a two-field divergence takes two deploys to find.
    await handle.db
      .update(macroSeries)
      .set({ cadence: 'DAILY', name: 'Wrong Name' })
      .where(eq(macroSeries.seriesId, 'ICSA'));

    await expect(assertSeedIntegrity(handle.db)).rejects.toThrow(SeedIntegrityError);
    try {
      await assertSeedIntegrity(handle.db);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SeedIntegrityError);
      const { divergences } = error as SeedIntegrityError;
      expect(divergences.map((d) => d.field).sort()).toEqual(['cadence', 'name']);
      expect((error as Error).message).toContain('ICSA');
      expect((error as Error).message).toContain('cadence');
    }
  });

  it('re-running the seed repairs every divergence', async () => {
    // The remedy the error message names has to actually work, or the check just
    // reports an unfixable problem.
    await handle.db.update(macroSeries).set({ cadence: 'DAILY', expectedPublicationDays: [2] });
    expect((await verifySeedIntegrity(handle.db)).length).toBeGreaterThan(0);

    await reseed();
    expect(await verifySeedIntegrity(handle.db)).toEqual([]);
  });

  it('rejects a publication calendar the database cannot make sense of', async () => {
    // Enforced by CHECK, not application code: an empty calendar freezes a series'
    // age at zero, so it would read LIVE forever. Silent, and permanent.
    await expect(
      handle.db.execute(
        sql`UPDATE macro_series SET expected_publication_days = '{}'::smallint[] WHERE series_id = 'DGS10'`,
      ),
    ).rejects.toThrow();

    await expect(
      handle.db.execute(
        sql`UPDATE macro_series SET expected_publication_days = '{9}'::smallint[] WHERE series_id = 'DGS10'`,
      ),
    ).rejects.toThrow();
  });

  it('checks every seeded macro series, not a sample', async () => {
    // Guards against the check silently narrowing: if a series is added to the seed
    // and the comparison loop is not updated, this fails.
    const rows = await handle.db.select({ id: macroSeries.seriesId }).from(macroSeries);
    expect(rows).toHaveLength(SEED_MACRO_SERIES.length);
  });
});
