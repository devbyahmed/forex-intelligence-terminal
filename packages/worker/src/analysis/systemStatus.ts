/**
 * System status: what the pipeline itself is doing.
 *
 * A dashboard that reports on the market without reporting on its own health lets a
 * quiet ingestion failure look like a quiet market — the same confusion the abstention
 * model exists to prevent, one level up. F8 abstaining because the world published six
 * articles and F8 abstaining because the news job has been failing for two days look
 * identical on the analysis panel; only this one can tell them apart.
 *
 * Warnings are derived rather than stored, so they cannot go stale: each is recomputed
 * from the same rows the tables below render, and a condition that has cleared stops
 * being reported without anyone clearing it.
 */

import { desc, eq, sql } from 'drizzle-orm';
import type { SystemStatus } from '@forex-agent/contracts';
import { systemStatusSchema } from '@forex-agent/contracts';
import {
  jobRuns,
  macroObservations,
  macroSeries,
  providerStatus,
  type Database,
} from '@forex-agent/db';

/** A provider is stale if nothing has succeeded in this long. */
const STALE_PROVIDER_MS = 6 * 60 * 60 * 1000;

export async function buildSystemStatus(db: Database, now: Date): Promise<SystemStatus> {
  /*
   * The typed builder, not raw SQL.
   *
   * The first version of this query hand-wrote `breaker_open_until`, a column that
   * does not exist — the table records a `breaker` state enum and a
   * `breaker_opened_at` timestamp. Raw SQL bypasses the schema types, so the mistake
   * survived typecheck and lint and surfaced as a 500 on the dashboard. Going through
   * Drizzle makes a wrong column name a compile error, which is where it belongs.
   */
  const statusRows = await db
    .select({
      providerId: providerStatus.providerId,
      domain: providerStatus.domain,
      tier: providerStatus.tier,
      breaker: providerStatus.breaker,
      consecutiveFailures: providerStatus.consecutiveFailures,
      lastSuccessAt: providerStatus.lastSuccessAt,
      quotaUsedToday: providerStatus.quotaUsedToday,
      quotaLimitDaily: providerStatus.quotaLimitDaily,
      quotaResetAt: providerStatus.quotaResetAt,
    })
    .from(providerStatus)
    .orderBy(providerStatus.providerId);

  const providers = statusRows.map((r) => {
    const lastSuccess = r.lastSuccessAt;
    // Read from the recorded state rather than inferred from a timestamp: the breaker
    // is a state machine, and re-deriving its state here would be a second
    // implementation that can disagree with the one that opens it.
    const breakerOpen = r.breaker === 'OPEN';
    const quotaExhausted =
      r.quotaLimitDaily !== null && r.quotaUsedToday >= r.quotaLimitDaily;

    /*
     * Ordered by severity, not by field order. A provider with an open breaker AND an
     * exhausted quota is reported as BREAKER_OPEN, because that is the condition that
     * has to clear first; reporting the quota would send someone to wait for a reset
     * that will not fix it.
     */
    const state = breakerOpen
      ? 'BREAKER_OPEN'
      : quotaExhausted
        ? 'QUOTA_EXHAUSTED'
        : r.consecutiveFailures > 0
          ? 'DEGRADED'
          : lastSuccess === null
            ? 'UNKNOWN'
            : 'OK';

    return {
      providerId: r.providerId,
      domain: r.domain,
      tier: r.tier as 1 | 2 | 3 | 4,
      state,
      lastSuccessAt: lastSuccess?.toISOString() ?? null,
      consecutiveFailures: r.consecutiveFailures,
      quotaUsedToday: r.quotaUsedToday,
      quotaLimitDaily: r.quotaLimitDaily,
      quotaResetsAt: r.quotaResetAt?.toISOString() ?? null,
    };
  });

  const runs = await db
    .select({
      jobName: jobRuns.jobName,
      status: jobRuns.status,
      startedAt: jobRuns.startedAt,
      finishedAt: jobRuns.finishedAt,
      itemsProcessed: jobRuns.itemsProcessed,
      errorMessage: jobRuns.errorMessage,
    })
    .from(jobRuns)
    .orderBy(desc(jobRuns.startedAt))
    .limit(15);

  const seriesRows = await db
    .select({
      seriesId: macroSeries.seriesId,
      displayName: macroSeries.name,
      cadence: macroSeries.cadence,
      freshness: sql<string | null>`max(${macroObservations.freshness}::text)`,
      latestPeriod: sql<string | null>`max(${macroObservations.observationDate})`,
      publishedAt: sql<Date | null>`max(${macroObservations.sourceTimestamp})`,
      // Distinct periods, not rows: a revision is a second row for the same period,
      // and counting rows would overstate the history we actually hold.
      observationCount: sql<number>`count(distinct ${macroObservations.observationDate})::int`,
    })
    .from(macroSeries)
    .leftJoin(macroObservations, eq(macroObservations.seriesRowId, macroSeries.id))
    .where(eq(macroSeries.isActive, true))
    .groupBy(macroSeries.seriesId, macroSeries.name, macroSeries.cadence)
    .orderBy(macroSeries.seriesId);

  const warnings: string[] = [];

  for (const p of providers) {
    if (p.state === 'BREAKER_OPEN') {
      warnings.push(`${p.providerId}: circuit breaker is open after repeated failures.`);
    } else if (p.state === 'QUOTA_EXHAUSTED') {
      warnings.push(
        `${p.providerId}: daily quota spent (${String(p.quotaUsedToday)} of ` +
          `${String(p.quotaLimitDaily ?? 0)}). Ingestion from this provider is paused until reset.`,
      );
    } else if (
      p.lastSuccessAt !== null &&
      now.getTime() - Date.parse(p.lastSuccessAt) > STALE_PROVIDER_MS
    ) {
      warnings.push(
        `${p.providerId}: no successful call in over six hours. Readings sourced from it may be ` +
          'stale even where the freshness chip says otherwise.',
      );
    }
  }

  for (const s of seriesRows) {
    if (s.observationCount === 0) {
      // The distinction that matters: an empty series is a pipeline failure, and
      // without this it surfaces only as a factor quietly abstaining.
      warnings.push(
        `${s.seriesId}: no observations stored. Any factor reading it will abstain, and that ` +
          'abstention is a configuration or ingestion fault rather than a market condition.',
      );
    }
  }

  const failedRuns = runs.filter((r) => r.status === 'FAILED');
  if (failedRuns.length > 0) {
    warnings.push(
      `${String(failedRuns.length)} of the last ${String(runs.length)} job runs failed: ` +
        `${[...new Set(failedRuns.map((r) => r.jobName))].join(', ')}.`,
    );
  }

  return systemStatusSchema.parse({
    providers,
    // A run with no `started_at` has been claimed but not begun. It is dropped rather
    // than dated `now`, which would show a run that has not started as instantaneous.
    recentRuns: runs
      .filter((r): r is typeof r & { startedAt: Date } => r.startedAt !== null)
      .map((r) => ({
        jobName: r.jobName,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        durationMs:
          r.finishedAt === null ? null : r.finishedAt.getTime() - r.startedAt.getTime(),
        detail:
          r.errorMessage ??
          (r.itemsProcessed > 0 ? `${String(r.itemsProcessed)} items processed` : null),
      })),
    series: seriesRows.map((s) => ({
      seriesId: s.seriesId,
      displayName: s.displayName,
      cadence: s.cadence,
      freshness: s.freshness ?? 'UNAVAILABLE',
      latestPeriod: s.latestPeriod,
      publishedAt: s.publishedAt === null ? null : new Date(s.publishedAt).toISOString(),
      observationCount: s.observationCount,
    })),
    warnings,
  });
}
