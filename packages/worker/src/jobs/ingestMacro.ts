/**
 * Macro ingestion (master PRD §6, §11, §52).
 *
 * Every seeded FRED series, stored with its revision history. Three properties this
 * job exists to preserve:
 *
 *  1. **A revision is a new row, never an overwrite.** June payrolls moved
 *     158,984 → 158,881 between vintages; overwriting would make an analysis from
 *     last month re-render citing a number that did not exist when it ran.
 *  2. **Freshness comes from the vintage, not the observation period.** July's CPI
 *     published in mid-August is current in late August. Measuring from 1 July marked
 *     it `UNAVAILABLE` and silently dropped the inflation factor.
 *  3. **Thresholds follow the series' real cadence.** The H.10 dollar index publishes
 *     ~9 days in arrears; treating it as daily made factor F1 abstain permanently.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  assessFreshnessOnCalendar,
  measureCoverage,
  publishedTiming,
  type FreshnessThresholds,
  type MacroSeriesId,
  type PublicationDays,
  type SeriesCadence,
} from '@forex-agent/core';
import type { Database } from '@forex-agent/db';
import { macroObservations, macroSeries } from '@forex-agent/db';
import { validateMacroPoint, type FredMacroProvider, type MacroPoint } from '@forex-agent/providers';
import type { JobContext, JobOutcome } from '../runner.js';

export interface CadenceThresholds {
  readonly DAILY: FreshnessThresholds;
  readonly WEEKLY: FreshnessThresholds;
  readonly MONTHLY: FreshnessThresholds;
}

/**
 * How much history to request, per cadence.
 *
 * **A single window across all cadences silently disabled two factors.** With two
 * years for everything, the monthly series held twelve observations. A year-on-year
 * change consumes a twelve-period lag, so the trailing history of year-on-year
 * readings had *one* entry against a thirty-observation minimum — meaning F5 could
 * never produce a score, in any market condition, and F6 ran on jobless claims alone
 * at a quarter of its input completeness. Neither failed loudly: both abstained,
 * which is the correct response to insufficient history and therefore looked exactly
 * like the system working.
 *
 * The windows below are sized from what each cadence's longest sub-signal needs, plus
 * the thirty-observation floor:
 *
 * | cadence | longest lag | needs | window | observations |
 * |---|---|---|---|---|
 * | DAILY | 20 days | 272 | 2 years | ~500 |
 * | WEEKLY | 4 weeks | 34 | 10 years | ~520 |
 * | MONTHLY | 12 months | 42 | 25 years | ~300 |
 *
 * FRED charges nothing for history and these are twelve series, so the cost is one
 * larger response per series on the first run and a few thousand rows — negligible
 * against the 0.5 GB budget in `LIMITS.md`. The cost of getting it wrong was two
 * factors that could not exist.
 */
export const DEFAULT_LOOKBACK_DAYS: Readonly<Record<SeriesCadence, number>> = {
  DAILY: 730,
  WEEKLY: 3650,
  MONTHLY: 9130,
};

export interface MacroIngestDeps {
  readonly fred: FredMacroProvider;
  readonly thresholds: CadenceThresholds;
  /** Overrides the per-cadence defaults. Mainly for tests. */
  readonly lookBackDays?: Partial<Record<SeriesCadence, number>>;
}

export interface SeriesIngestOutcome {
  readonly seriesId: string;
  readonly status: 'OK' | 'UNAVAILABLE' | 'FAILED';
  readonly pointsFetched: number;
  readonly stored: number;
  readonly revisions: number;
  readonly flagged: number;
  readonly error?: string;
}

export function ingestMacroJob(deps: MacroIngestDeps) {
  return async (ctx: JobContext): Promise<JobOutcome> => {
    const lookBackFor = (cadence: SeriesCadence): Date => {
      const days = deps.lookBackDays?.[cadence] ?? DEFAULT_LOOKBACK_DAYS[cadence];
      return new Date(ctx.now.getTime() - days * 86_400_000);
    };

    // Only active series. A series dropped from the seed is deactivated rather than
    // deleted (PRD_V1 §9.4a), and must stop being fetched.
    const series = await ctx.db
      .select({
        id: macroSeries.id,
        seriesId: macroSeries.seriesId,
        cadence: macroSeries.cadence,
        role: macroSeries.role,
        expectedPublicationDays: macroSeries.expectedPublicationDays,
      })
      .from(macroSeries)
      .where(eq(macroSeries.isActive, true));

    const outcomes: SeriesIngestOutcome[] = [];
    let totalStored = 0;

    for (const s of series) {
      const outcome = await ingestOneSeries(ctx.db, {
        rowId: s.id,
        seriesId: s.seriesId as MacroSeriesId,
        cadence: s.cadence,
        publicationDays: s.expectedPublicationDays,
        from: lookBackFor(s.cadence),
        now: ctx.now,
        deps,
      });
      outcomes.push(outcome);
      totalStored += outcome.stored;
    }

    /**
     * Every active series must yield something.
     *
     * A series returning nothing is indistinguishable from a quiet market unless it
     * is checked — and a silently empty macro series removes a whole factor from the
     * score while everything else keeps working.
     */
    const coverage = measureCoverage({
      name: 'macro series returning data',
      candidates: outcomes,
      matched: (o) => o.status === 'OK' && o.pointsFetched > 0,
      describe: (o) => `${o.seriesId} (${o.status}${o.error === undefined ? '' : `: ${o.error}`})`,
      expectation: { minMatchRate: 0.9 },
    });

    const failed = outcomes.filter((o) => o.status !== 'OK');
    const revisions = outcomes.reduce((n, o) => n + o.revisions, 0);
    const flagged = outcomes.reduce((n, o) => n + o.flagged, 0);

    const detail = [
      `${String(totalStored)} observations stored across ${String(outcomes.length)} series`,
      revisions > 0 ? `${String(revisions)} revisions` : null,
      flagged > 0 ? `${String(flagged)} flagged` : null,
      failed.length > 0 ? `${String(failed.length)} FAILED: ${failed.map((f) => f.seriesId).join(', ')}` : null,
      coverage.healthy ? null : `WARNING: ${coverage.reason ?? 'series returned nothing'}`,
    ]
      .filter((s) => s !== null)
      .join('; ');

    return { itemsProcessed: totalStored, detail };
  };
}

async function ingestOneSeries(
  db: Database,
  params: {
    rowId: string;
    seriesId: MacroSeriesId;
    cadence: SeriesCadence;
    publicationDays: PublicationDays;
    from: Date;
    now: Date;
    deps: MacroIngestDeps;
  },
): Promise<SeriesIngestOutcome> {
  const base = {
    seriesId: params.seriesId,
    pointsFetched: 0,
    stored: 0,
    revisions: 0,
    flagged: 0,
  };

  // Thresholds matching the series' real publication cadence, not its name.
  const thresholds = params.deps.thresholds[params.cadence];

  let result;
  try {
    result = await params.deps.fred.getSeries(
      { seriesId: params.seriesId, from: params.from, publicationDays: params.publicationDays },
      params.now,
      thresholds,
    );
  } catch (e) {
    return {
      ...base,
      status: 'FAILED',
      error: e instanceof Error ? e.message.slice(0, 120) : 'unknown',
    };
  }

  if (result.status === 'UNAVAILABLE') {
    return { ...base, status: 'UNAVAILABLE', error: result.reason };
  }

  const points = result.observation.value;
  let stored = 0;
  let revisions = 0;
  let flagged = 0;

  // Sorted by period then vintage, so `previous` is the prior observation of the same
  // series — which is what revision and anomaly detection compare against.
  const sorted = [...points].sort((a, b) =>
    a.observationDate === b.observationDate
      ? a.vintage.getTime() - b.vintage.getTime()
      : a.observationDate.localeCompare(b.observationDate),
  );

  let previous: MacroPoint | undefined;
  for (const point of sorted) {
    const flags = validateMacroPoint(point, previous);
    if (flags.length > 0) flagged += 1;
    if (flags.includes('REVISED')) revisions += 1;

    // The stored freshness is what the fundamental engine reads to weight a factor,
    // so this is the value that actually decides whether F1 votes at full strength.
    // Counted in publication days: a Friday vintage read on a Sunday is current.
    const freshness = assessFreshnessOnCalendar(
      publishedTiming({
        publishedAt: point.vintage,
        describesPeriod: point.observationDate,
        retrievedAt: params.now,
      }),
      thresholds,
      params.now,
      params.publicationDays,
    );

    const inserted = await db
      .insert(macroObservations)
      .values({
        seriesRowId: params.rowId,
        observationDate: point.observationDate,
        value: point.value === null ? null : String(point.value),
        vintage: point.vintage,
        sourceProvider: result.observation.provenance.providerId,
        sourceName: result.observation.provenance.sourceName,
        sourceUrl: result.observation.provenance.sourceUrl,
        sourceTier: result.observation.provenance.sourceTier,
        // The publication instant. The period lives in `observationDate`.
        sourceTimestamp: point.vintage,
        retrievedAt: params.now,
        freshness: freshness.status,
        qualityFlags: [...flags],
      })
      // Unique on (series, period, vintage): re-running is a no-op, but a genuine
      // revision has a new vintage and therefore becomes a new row.
      .onConflictDoNothing({
        target: [
          macroObservations.seriesRowId,
          macroObservations.observationDate,
          macroObservations.vintage,
        ],
      })
      .returning({ id: macroObservations.id });

    if (inserted.length > 0) stored += 1;
    previous = point;
  }

  return {
    ...base,
    status: 'OK',
    pointsFetched: points.length,
    stored,
    revisions,
    flagged,
  };
}

/**
 * The current value of a series, at its latest vintage.
 *
 * `DISTINCT ON` picks one row per period — the newest vintage — so a revised figure
 * supersedes its earlier print without the earlier print being lost.
 */
export async function latestObservation(
  db: Database,
  seriesId: MacroSeriesId,
): Promise<{
  value: number | null;
  observationDate: string;
  vintage: Date;
  freshness: string;
  qualityFlags: string[];
} | null> {
  const rows = await db.execute<{
    value: string | null;
    observation_date: string;
    vintage: Date | string;
    freshness: string;
    quality_flags: string[];
  }>(sql`
    SELECT DISTINCT ON (o.observation_date)
           o.value, o.observation_date, o.vintage, o.freshness, o.quality_flags
      FROM macro_observations o
      JOIN macro_series s ON s.id = o.series_row_id
     WHERE s.series_id = ${seriesId}
     ORDER BY o.observation_date DESC, o.vintage DESC
     LIMIT 1
  `);

  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  const row = list[0] as
    | {
        value: string | null;
        observation_date: string;
        vintage: Date | string;
        freshness: string;
        quality_flags: string[];
      }
    | undefined;
  if (row === undefined) return null;

  return {
    value: row.value === null ? null : Number.parseFloat(row.value),
    observationDate: row.observation_date,
    vintage: row.vintage instanceof Date ? row.vintage : new Date(row.vintage),
    freshness: row.freshness,
    qualityFlags: row.quality_flags,
  };
}

/**
 * A series' history at its latest vintages — the input to z-score normalisation.
 *
 * Excludes flagged values: a value the validator called impossible must not move a
 * factor, though it stays stored and visible.
 */
export async function seriesHistory(
  db: Database,
  seriesId: MacroSeriesId,
  limit = 252,
): Promise<{ observationDate: string; value: number }[]> {
  const rows = await db.execute<{ observation_date: string; value: string }>(sql`
    SELECT observation_date, value FROM (
      SELECT DISTINCT ON (o.observation_date)
             o.observation_date, o.value, o.quality_flags
        FROM macro_observations o
        JOIN macro_series s ON s.id = o.series_row_id
       WHERE s.series_id = ${seriesId}
         AND o.value IS NOT NULL
       ORDER BY o.observation_date DESC, o.vintage DESC
    ) latest
     WHERE NOT ('IMPOSSIBLE_VALUE' = ANY(latest.quality_flags))
       AND NOT ('OUT_OF_RANGE' = ANY(latest.quality_flags))
     ORDER BY observation_date DESC
     LIMIT ${limit}
  `);

  const list = Array.isArray(rows)
    ? (rows as { observation_date: string; value: string }[])
    : ((rows as { rows?: { observation_date: string; value: string }[] }).rows ?? []);

  return list
    .map((r) => ({ observationDate: r.observation_date, value: Number.parseFloat(r.value) }))
    .filter((r) => Number.isFinite(r.value))
    .reverse();
}

/** Count of stored observations, for the system status panel. */
export async function macroCoverage(
  db: Database,
): Promise<{ seriesId: string; observations: number; latestPeriod: string | null }[]> {
  const rows = await db
    .select({
      seriesId: macroSeries.seriesId,
      observations: sql<number>`count(${macroObservations.id})::int`,
      latestPeriod: sql<string | null>`max(${macroObservations.observationDate})`,
    })
    .from(macroSeries)
    .leftJoin(macroObservations, eq(macroObservations.seriesRowId, macroSeries.id))
    .where(eq(macroSeries.isActive, true))
    .groupBy(macroSeries.seriesId);

  return rows;
}

export { and };
