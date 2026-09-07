/**
 * Factor viability against the shipped configuration and the real database.
 *
 * Two checks that have to live here rather than in `packages/engines`, because only
 * the worker can see the ingestion lookback windows, the active config profile and
 * the database at once:
 *
 *  1. **Config-time.** The shipped `DEFAULT_LOOKBACK_DAYS` must leave every enabled
 *     factor able to score. Catches a bad window before it is deployed.
 *  2. **Boot-time.** The observations actually stored must do the same. Catches a
 *     window that is correct on paper while ingestion has been failing — which is a
 *     different failure with an identical symptom.
 *
 * F5 was structurally incapable of producing a score for two phases and nothing
 * noticed, because abstaining is exactly what a factor should do when its history is
 * too short. Both halves are needed: the first would have caught the original defect,
 * the second catches the day the data stops arriving.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_NORMALISATION, DEFAULT_RUNTIME_CONFIG } from '@forex-agent/config';
import type { MacroSeriesId, SeriesCadence } from '@forex-agent/core';
import {
  FACTOR_REQUIREMENTS,
  FactorViabilityError,
  OBSERVATIONS_PER_YEAR,

  checkFactorViability,
  observationsFromLookback,
} from '@forex-agent/engines';
import { SEED_MACRO_SERIES, seed } from '@forex-agent/db';
import { createTestDb, hasTestDatabase, type TestDb } from '@forex-agent/db/test-support';
import { DEFAULT_LOOKBACK_DAYS } from './jobs/ingestMacro.js';
import { assertWorkerPreflight, countObservationsPerSeries, resetPreflightCache } from './preflight.js';

/** Each series' cadence, from the seed — the source of truth for its lookback. */
const CADENCE_OF = new Map<string, SeriesCadence>(
  SEED_MACRO_SERIES.map((s) => [s.seriesId, s.cadence]),
);

const lookbackFor = (seriesId: MacroSeriesId): number => {
  const cadence = CADENCE_OF.get(seriesId);
  if (cadence === undefined) throw new Error(`${seriesId} is not seeded`);
  return DEFAULT_LOOKBACK_DAYS[cadence];
};

const enabledFactors = DEFAULT_RUNTIME_CONFIG.factors;

describe('the shipped lookback windows keep every enabled factor viable', () => {
  it('leaves no factor structurally unable to score', () => {
    const report = checkFactorViability({
      availableObservations: observationsFromLookback(lookbackFor),
      enabledFactors,
      normalisation: DEFAULT_NORMALISATION,
    });

    expect(report.deadFactors).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('leaves no factor permanently below full input completeness', () => {
    // Stricter than "alive". A factor pinned below full completeness on every run is
    // still a configuration artefact — it just costs weight rather than the whole
    // factor, so it is quieter and lasts longer.
    const report = checkFactorViability({
      availableObservations: observationsFromLookback(lookbackFor),
      enabledFactors,
      normalisation: DEFAULT_NORMALISATION,
    });

    expect(report.degradedFactors).toEqual([]);
  });

  it('would have failed under the old uniform two-year window', () => {
    // The regression pinned, so the fix cannot be reverted quietly.
    const report = checkFactorViability({
      availableObservations: observationsFromLookback(() => 730),
      enabledFactors,
      normalisation: DEFAULT_NORMALISATION,
    });

    expect(report.healthy).toBe(false);
    expect(report.deadFactors).toContain('F5');
  });

  it('covers every seeded series', () => {
    // A series added to the seed but missing from OBSERVATIONS_PER_YEAR would be
    // sized as zero and fail the check for the wrong reason; one missing from the
    // seed but present here would be checked and never fetched.
    const seeded = SEED_MACRO_SERIES.map((s) => s.seriesId).sort();
    expect(Object.keys(OBSERVATIONS_PER_YEAR).sort()).toEqual(seeded);
  });

  it('requires only series that are actually seeded and active', () => {
    const seeded = new Set(SEED_MACRO_SERIES.map((s) => s.seriesId));
    for (const req of FACTOR_REQUIREMENTS) {
      for (const s of req.series) {
        expect(seeded.has(s.seriesId)).toBe(true);
      }
    }
  });
});

const describeIfDb = hasTestDatabase() ? describe : describe.skip;

describeIfDb('factor viability at worker startup (real Postgres)', () => {
  let handle: TestDb;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  it('counts distinct periods, not rows', async () => {
    // A revision is a second row for the same period at a new vintage. Counting rows
    // would credit us with history we do not have — the macro pipeline stored 8,177
    // rows across 3,101 revisions, which is enough to turn a failing check into a
    // passing one.
    await handle.truncateAll();
    await seed(handle.db, { profileName: 'default', config: { placeholder: true } });

    const counts = await countObservationsPerSeries(handle.db);
    // Seeded but never ingested: every series is present with zero periods, rather
    // than absent, so a missing series and an empty one are distinguishable.
    expect(Object.keys(counts).sort()).toEqual(SEED_MACRO_SERIES.map((s) => s.seriesId).sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('refuses to start when the stored history cannot support a factor', async () => {
    // An empty database is the extreme case of the F5 defect: every factor would
    // abstain on every run, and every abstention would look like a data outage.
    await handle.truncateAll();
    await seed(handle.db, { profileName: 'default', config: { placeholder: true } });
    resetPreflightCache();

    await expect(
      assertWorkerPreflight(handle.db, {
        viability: { enabledFactors, normalisation: DEFAULT_NORMALISATION },
      }),
    ).rejects.toThrow(FactorViabilityError);
  });

  it('names the factors and says why it matters', async () => {
    await handle.truncateAll();
    await seed(handle.db, { profileName: 'default', config: { placeholder: true } });
    resetPreflightCache();

    try {
      await assertWorkerPreflight(handle.db, {
        viability: { enabledFactors, normalisation: DEFAULT_NORMALISATION },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('FACTOR CANNOT SCORE');
      expect(message).toContain('indistinguishable from a genuine data outage');
    }
  });

  it('skips the check when no viability config is supplied', async () => {
    // The seed check still runs; viability is opt-in so a job that does not score
    // anything is not blocked by history it never reads.
    await handle.truncateAll();
    await seed(handle.db, { profileName: 'default', config: { placeholder: true } });
    resetPreflightCache();

    await expect(assertWorkerPreflight(handle.db)).resolves.toBeUndefined();
  });
});
