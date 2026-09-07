/**
 * Database rows → `FundamentalInputs`.
 *
 * The seam between storage and the pure engine. Everything time-dependent is resolved
 * here — revisions collapsed, freshness read from the stored classification, surprises
 * matched to their event family — so the engine receives a plain value and stays
 * reproducible from it.
 *
 * Freshness is **read, not recomputed**. It was assessed at ingestion by
 * `assessFreshnessOnCalendar`, which knows each series' publication calendar;
 * re-deriving it here from timestamps would be a second implementation of the H.10
 * lag rule and a second chance to get it wrong.
 */

import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { MacroSeriesId, SourceTier } from '@forex-agent/core';
import {
  economicEvents,
  economicReleases,
  macroObservations,
  macroSeries,
  type Database,
} from '@forex-agent/db';
import {
  RELEASE_SURPRISE_GAP,
  type FundamentalInputs,
  type MacroSeriesView,
  type NewsAggregateView,
  type StructuralGap,
} from '@forex-agent/engines';
import type { FactSource } from './evidenceBundle.js';

export interface BuildInputsResult {
  readonly inputs: FundamentalInputs;
  /** The newest fact per series and surprise, for the FACT statement layer. */
  readonly facts: readonly FactSource[];
}

export async function buildFundamentalInputs(
  db: Database,
  params: { readonly now: Date; readonly news: NewsAggregateView; readonly degradedProviders?: readonly string[] },
): Promise<BuildInputsResult> {
  const rows = await db
    .select({
      seriesId: macroSeries.seriesId,
      displayName: macroSeries.name,
      unit: macroSeries.unit,
      observationDate: macroObservations.observationDate,
      value: macroObservations.value,
      vintage: macroObservations.vintage,
      freshness: macroObservations.freshness,
      sourceTier: macroObservations.sourceTier,
      sourceProvider: macroObservations.sourceProvider,
      sourceName: macroObservations.sourceName,
      sourceUrl: macroObservations.sourceUrl,
      retrievedAt: macroObservations.retrievedAt,
      sourceTimestamp: macroObservations.sourceTimestamp,
      id: macroObservations.id,
    })
    .from(macroSeries)
    .innerJoin(macroObservations, eq(macroObservations.seriesRowId, macroSeries.id))
    .where(eq(macroSeries.isActive, true))
    .orderBy(macroSeries.seriesId, macroObservations.observationDate, macroObservations.vintage);

  /**
   * One row per (series, period), at its latest vintage.
   *
   * Revisions are real and material — June payrolls moved 158,984 to 158,881 — but the
   * engine's contract is one value per period. Resolving it here means no factor has
   * to decide which vintage is current, and the ordering above guarantees the last
   * write wins.
   */
  const bySeries = new Map<string, { points: Map<string, (typeof rows)[number]>; meta: (typeof rows)[number] }>();
  for (const r of rows) {
    let entry = bySeries.get(r.seriesId);
    if (entry === undefined) {
      entry = { points: new Map(), meta: r };
      bySeries.set(r.seriesId, entry);
    }
    entry.points.set(r.observationDate, r);
    entry.meta = r;
  }

  const series: Partial<Record<MacroSeriesId, MacroSeriesView>> = {};
  const facts: FactSource[] = [];

  for (const [seriesId, entry] of bySeries) {
    const ordered = [...entry.points.values()].sort((a, b) =>
      a.observationDate.localeCompare(b.observationDate),
    );
    const newest = ordered[ordered.length - 1];
    if (newest === undefined) continue;

    series[seriesId as MacroSeriesId] = {
      seriesId: seriesId as MacroSeriesId,
      points: ordered.map((p) => ({
        period: p.observationDate,
        value: p.value === null ? null : Number(p.value),
        factId: p.id,
      })),
      freshness: newest.freshness,
      sourceTier: newest.sourceTier as SourceTier,
      displayName: newest.displayName,
    };

    // One FACT per series — the newest observation. Every earlier point informed the
    // z-score baseline, but citing 500 rows per factor would bury the lineage rather
    // than expose it; the baseline is reproducible from the series id and the window.
    facts.push({
      id: newest.id,
      table: 'macro_observations',
      label: newest.displayName,
      value: newest.value === null ? null : Number(newest.value),
      unit: newest.unit,
      sourceProvider: newest.sourceProvider,
      sourceName: newest.sourceName,
      ...(newest.sourceUrl === null ? {} : { sourceUrl: newest.sourceUrl }),
      sourceTier: newest.sourceTier as SourceTier,
      sourceTimestamp: newest.sourceTimestamp,
      retrievedAt: newest.retrievedAt,
      freshness: newest.freshness,
      describesPeriod: newest.observationDate,
    });
  }

  // ── Release surprises ─────────────────────────────────────────────────────
  const surpriseRows = await db
    .select({
      id: economicReleases.id,
      eventName: economicEvents.name,
      normalisedName: economicEvents.normalisedName,
      country: economicEvents.country,
      surprise: economicReleases.surprise,
      surpriseZ: economicReleases.surpriseZ,
      actualReportedAt: economicReleases.actualReportedAt,
      freshness: economicReleases.freshness,
      sourceTier: economicReleases.sourceTier,
      sourceProvider: economicReleases.sourceProvider,
      sourceName: economicReleases.sourceName,
      retrievedAt: economicReleases.retrievedAt,
      sourceTimestamp: economicReleases.sourceTimestamp,
    })
    .from(economicReleases)
    .innerJoin(economicEvents, eq(economicEvents.id, economicReleases.eventId))
    .where(and(isNotNull(economicReleases.surpriseZ), isNotNull(economicReleases.actualReportedAt)))
    .orderBy(desc(economicReleases.actualReportedAt));

  const surprises: Record<string, FundamentalInputs['surprises'][string]> = {};
  for (const r of surpriseRows) {
    const family = familyOf(r.normalisedName);
    if (family === null || surprises[family] !== undefined) continue;
    surprises[family] = {
      eventName: r.eventName,
      country: r.country,
      // `surprise` is numeric (arrives as a string); `surpriseZ` is real (a number).
      surprise: r.surprise === null ? null : Number(r.surprise),
      surpriseZ: r.surpriseZ,
      releasedAt: r.actualReportedAt ?? r.sourceTimestamp,
      freshness: r.freshness,
      sourceTier: r.sourceTier as SourceTier,
      factId: r.id,
    };
    facts.push({
      id: r.id,
      table: 'economic_releases',
      label: `${r.country} ${r.eventName} surprise`,
      value: r.surprise === null ? null : Number(r.surprise),
      unit: '',
      sourceProvider: r.sourceProvider,
      sourceName: r.sourceName,
      sourceTier: r.sourceTier as SourceTier,
      sourceTimestamp: r.sourceTimestamp,
      retrievedAt: r.retrievedAt,
      freshness: r.freshness,
    });
  }

  // ── Upcoming releases, for event risk ─────────────────────────────────────
  const upcoming = await db
    .select({
      id: economicReleases.id,
      eventName: economicEvents.name,
      country: economicEvents.country,
      importance: economicEvents.importance,
      scheduledAt: economicReleases.scheduledAt,
    })
    .from(economicReleases)
    .innerJoin(economicEvents, eq(economicEvents.id, economicReleases.eventId))
    .where(gte(economicReleases.scheduledAt, params.now))
    .orderBy(economicReleases.scheduledAt)
    .limit(50);

  return {
    inputs: {
      series,
      surprises,
      news: params.news,
      upcomingReleases: upcoming.map((u) => ({
        eventName: u.eventName,
        country: u.country,
        scheduledAt: u.scheduledAt,
        importance: u.importance,
        factId: u.id,
      })),
      degradedProviders: params.degradedProviders ?? [],
      structuralGaps: await detectStructuralGaps(db),
    },
    facts,
  };
}

/**
 * Which known-unobtainable gaps apply to this run.
 *
 * Measured rather than asserted. The release-surprise gap is declared only when no
 * standardised surprise exists *and* no forecast older than the feed's own window has
 * ever been stored — the second half is what distinguishes "the source cannot give us
 * history" from "we started ingesting last week". Observed 2026-09-01: 78 forecasts
 * held, none older than eight days, which is the signature of a rolling window rather
 * than of a young database (LIMITS.md §6.9).
 *
 * It resolves itself. Once twelve surprises have accrued from live ingestion the
 * standardisation succeeds, the sub-signal returns, and this stops firing — without
 * anyone editing a constant.
 */
async function detectStructuralGaps(db: Database): Promise<readonly StructuralGap[]> {
  const [row] = await db
    .select({
      withZ: sql<number>`count(*) filter (where ${economicReleases.surpriseZ} is not null)::int`,
      oldForecasts: sql<number>`count(*) filter (
        where ${economicReleases.forecastValue} is not null
          and ${economicReleases.scheduledAt} < now() - interval '30 days'
      )::int`,
    })
    .from(economicReleases);

  if (row === undefined) return [];
  if (row.withZ > 0) return [];
  // Forecasts exist for old releases, so history is accruing and the absence is
  // transient — not a permanent property of the sources.
  if (row.oldForecasts > 0) return [];
  return [RELEASE_SURPRISE_GAP];
}

/**
 * Map a release to the family the engine reads.
 *
 * Matched on the normalised name rather than the raw one, because the same release
 * arrives as "Consumer Price Index" from FRED and "CPI m/m" from ForexFactory — the
 * mismatch that once produced zero curated importance matches on 143 releases.
 */
function familyOf(normalisedName: string): 'CPI' | 'NFP' | null {
  const n = normalisedName.toLowerCase();
  if (n.includes('consumer price index') || /\bcpi\b/.test(n)) return 'CPI';
  if (n.includes('nonfarm') || n.includes('non-farm') || n.includes('payroll')) return 'NFP';
  return null;
}


