/**
 * Worker preflight — refuse to ingest against a database that disagrees with the seed.
 *
 * The seed is the source of truth for what the system ingests and how it is
 * classified. Three times the database has quietly disagreed with it, and each time
 * the system kept running and kept producing numbers that looked fine:
 *
 *  - retired feeds still active, failing on every run (Phase 6),
 *  - `DTWEXBGS` stuck at `DAILY` while the seed said `WEEKLY`, so factor F1 was
 *    scored `STALE` at half weight for two phases (Phase 7),
 *  - and `expectedPublicationDays` arriving with the same propagation hazard
 *    (Phase 8).
 *
 * None of those was caught by a test. All three were caught by reading a live run.
 *
 * So the check runs where the ingestion actually happens, and it **fails closed**: a
 * tick that cannot confirm the database matches the seed does not run its jobs. That
 * is a deliberate choice to stop rather than degrade. A halted pipeline is visible
 * and has an obvious remedy; a pipeline scoring a factor at half weight because of a
 * one-word mismatch is neither, and the product's central claim is confidence.
 */

import { assertSeedIntegrity, macroObservations, macroSeries, type Database } from '@forex-agent/db';
import { assertFactorViability, type FactorRequirement } from '@forex-agent/engines';
import type { FactorId, MacroSeriesId } from '@forex-agent/core';
import type { NormalisationConfig } from '@forex-agent/engines';
import { eq, sql } from 'drizzle-orm';

export interface PreflightOptions {
  /**
   * How long a passing result stays good.
   *
   * The check costs a handful of small selects, which is nothing on a long-lived
   * process but is charged per cold start on the serverless profile against a
   * scale-to-zero database. Caching the pass keeps a 15-minute tick from paying for
   * it every time, while re-checking often enough that a divergence introduced by a
   * migration or a manual edit surfaces the same day rather than at the next deploy.
   */
  readonly maxAgeMs?: number;
  readonly now?: Date;
  /**
   * Factor viability inputs. Omitted, the check is skipped.
   *
   * Passed rather than imported so `preflight` does not reach into the config
   * package: the worker's composition root already holds the active profile, and a
   * second path to it is a second thing that can disagree with the first.
   */
  readonly viability?: {
    readonly enabledFactors: Readonly<Record<FactorId, { readonly enabled: boolean }>>;
    readonly normalisation: NormalisationConfig;
    readonly requirements?: readonly FactorRequirement[];
  };
}

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Process-scoped, not global state with a hidden lifetime: on the serverless profile
 * a "process" is one cold start, which is exactly the granularity wanted. A failure
 * is never cached — a divergence must be re-reported on every attempt until it is
 * fixed, or the first tick after a bad deploy would be the only one that complained.
 */
let lastPassedAt: number | null = null;

export async function assertWorkerPreflight(
  db: Database,
  options: PreflightOptions = {},
): Promise<void> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = (options.now ?? new Date()).getTime();

  if (lastPassedAt !== null && now - lastPassedAt < maxAgeMs) return;

  await assertSeedIntegrity(db);

  /**
   * Every enabled factor must be *capable* of scoring on the history actually stored.
   *
   * Checked against real row counts rather than the configured lookback, because a
   * window sized correctly in config still yields nothing if ingestion has never run
   * or has been failing. F5 spent two phases structurally unable to score while the
   * configuration looked entirely reasonable; the only thing that would have caught
   * it is counting what is really there.
   *
   * Fails closed alongside the seed check: a factor that abstains on every run in
   * every market condition is a defect wearing an abstention's clothes, and the whole
   * point is that nobody can tell them apart by looking.
   */
  if (options.viability !== undefined) {
    assertFactorViability({
      availableObservations: await countObservationsPerSeries(db),
      enabledFactors: options.viability.enabledFactors,
      normalisation: options.viability.normalisation,
      ...(options.viability.requirements === undefined
        ? {}
        : { requirements: options.viability.requirements }),
    });
  }

  lastPassedAt = now;
}

/**
 * Distinct observation periods per active series.
 *
 * Distinct *periods*, not rows: a revised figure is a second row for the same period
 * at a new vintage, and counting rows would credit us with history we do not have —
 * the macro pipeline stored 8,177 rows across 3,101 revisions, so the gap is large
 * enough to turn a failing check into a passing one.
 */
export async function countObservationsPerSeries(
  db: Database,
): Promise<Readonly<Partial<Record<MacroSeriesId, number>>>> {
  const rows = await db
    .select({
      seriesId: macroSeries.seriesId,
      periods: sql<number>`count(distinct ${macroObservations.observationDate})::int`,
    })
    .from(macroSeries)
    .leftJoin(macroObservations, eq(macroObservations.seriesRowId, macroSeries.id))
    .where(eq(macroSeries.isActive, true))
    .groupBy(macroSeries.seriesId);

  const out: Partial<Record<MacroSeriesId, number>> = {};
  for (const r of rows) out[r.seriesId as MacroSeriesId] = r.periods;
  return out;
}

/** Discard the cached pass. For tests, and for a process that has just re-seeded. */
export function resetPreflightCache(): void {
  lastPassedAt = null;
}
