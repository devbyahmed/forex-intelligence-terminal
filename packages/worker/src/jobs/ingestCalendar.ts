/**
 * Economic calendar ingestion (master PRD §7).
 *
 * Merges two sources that are individually incomplete:
 *
 *  - **FRED (Tier 1)** — authoritative release dates and, once published, the actual
 *    value. No times, no forecasts.
 *  - **ForexFactory (Tier 3)** — the scheduled time of day, the consensus forecast,
 *    and an importance hint.
 *
 * They are **merged into one row but never into one provenance**. The actual keeps
 * FRED's Tier 1 attribution; the forecast keeps ForexFactory's Tier 3 attribution in
 * its own columns. Presenting a scraped consensus with the same authority as an
 * official statistic is precisely the misrepresentation Amendment A2 exists to stop.
 */

import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  assessFreshness,
  liveTiming,
  measureCoverage,
  zScore,
  type FreshnessThresholds,
  type Importance,
} from '@forex-agent/core';
import type { Database } from '@forex-agent/db';
import { economicEvents, economicReleases, eventImportanceRules } from '@forex-agent/db';
import type { EconomicCalendarProvider, ForexFactoryRelease } from '@forex-agent/providers';
import type { JobContext, JobOutcome } from '../runner.js';

/**
 * Collapse a name to a stable dedupe key.
 *
 * The two feeds name the same release differently — "Non-Farm Employment Change"
 * versus "Employment Situation" — so exact matching would create duplicate events.
 * Normalisation plus the alias table below is what lets them meet.
 */
export function normaliseEventName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Known aliases between the Tier 1 and Tier 3 vocabularies.
 *
 * Deliberately a small, explicit table rather than fuzzy matching: a wrong match here
 * would attach one release's actual to another's forecast, producing a fabricated
 * surprise. Explicit and incomplete beats clever and occasionally wrong.
 */
const NAME_ALIASES: Readonly<Record<string, string>> = {
  'non farm employment change': 'employment situation',
  'nonfarm payrolls': 'employment situation',
  'unemployment rate': 'employment situation',
  'average hourly earnings m m': 'employment situation',
  'cpi m m': 'consumer price index',
  'core cpi m m': 'consumer price index',
  'cpi y y': 'consumer price index',
  'unemployment claims': 'unemployment insurance weekly claims report',
  'federal funds rate': 'fomc press release',
  'fomc statement': 'fomc press release',
  'advance gdp q q': 'gross domestic product',
};

export function canonicalEventKey(name: string): string {
  const normalised = normaliseEventName(name);
  return NAME_ALIASES[normalised] ?? normalised;
}

/**
 * Map a currency code to the country whose agency publishes its statistics.
 *
 * The two feeds disagree on what "country" means: FRED says `US`, ForexFactory puts
 * the **currency code** in its country field. Without reconciling them, curated
 * importance rules keyed on `US` never match a ForexFactory row keyed `USD` — which
 * is exactly what happened on the first live run: 143 releases ingested, **zero**
 * curated importance matches, so CPI and NFP silently kept whatever rating the
 * scraped feed happened to assert.
 */
const CURRENCY_TO_COUNTRY: Readonly<Record<string, string>> = {
  USD: 'US',
  EUR: 'EU',
  GBP: 'GB',
  JPY: 'JP',
  CHF: 'CH',
  CAD: 'CA',
  AUD: 'AU',
  NZD: 'NZ',
  CNY: 'CN',
};

/** Normalise a feed's country/currency field into an ISO-ish country code. */
export function toCountryCode(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return CURRENCY_TO_COUNTRY[upper] ?? upper;
}

/** Recover the currency for a feed value that may already be one. */
export function toCurrencyCode(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (upper in CURRENCY_TO_COUNTRY) return upper;
  const found = Object.entries(CURRENCY_TO_COUNTRY).find(([, country]) => country === upper);
  return found?.[0] ?? upper;
}

/**
 * Resolve importance: curated rules win over whatever the Tier 3 feed asserts.
 *
 * A scraped rating must not be able to downgrade CPI or NFP — that would silently
 * disable the event-risk warning which caps confidence before a major release.
 */
export async function resolveImportance(
  db: Database,
  params: { country: string; eventName: string; hint: Importance | null },
): Promise<{ importance: Importance; curated: boolean }> {
  const normalised = normaliseEventName(params.eventName);

  const rules = await db
    .select({ pattern: eventImportanceRules.eventPattern, importance: eventImportanceRules.importance })
    .from(eventImportanceRules)
    .where(eq(eventImportanceRules.country, params.country));

  // Longest matching pattern wins, so 'core cpi' beats 'cpi'.
  let best: { pattern: string; importance: Importance } | null = null;
  for (const rule of rules) {
    if (normalised.includes(rule.pattern) && (best === null || rule.pattern.length > best.pattern.length)) {
      best = { pattern: rule.pattern, importance: rule.importance };
    }
  }

  if (best !== null) return { importance: best.importance, curated: true };
  return { importance: params.hint ?? 'LOW', curated: false };
}

/**
 * Standardised surprise.
 *
 * Returns null below `minObservations`: a z-score from four data points is a number
 * with no meaning, and publishing one would give the fundamental engine false
 * precision. Absence is the honest answer.
 */
export function surpriseZ(
  surprise: number,
  history: readonly number[],
  minObservations = 12,
): number | null {
  // Delegates to the shared implementation. Both null cases — too little history and
  // too little variance — are documented there, including why the variance floor is
  // scaled to the data rather than a fixed epsilon. Twelve is the calendar's own
  // minimum: a year of monthly releases.
  return zScore(surprise, history, { minObservations });
}

export interface CalendarIngestDeps {
  readonly fred: EconomicCalendarProvider;
  readonly forexFactory: EconomicCalendarProvider;
  readonly thresholds: FreshnessThresholds;
  /** How far ahead to look. */
  readonly lookAheadDays?: number;
  readonly lookBackDays?: number;
}

interface MergedRelease {
  readonly country: string;
  readonly currency: string;
  readonly eventName: string;
  readonly canonicalKey: string;
  readonly scheduledAt: Date;
  readonly scheduledLocalTime: string | null;
  readonly importanceHint: Importance | null;
  readonly isHoliday: boolean;
  readonly previous: number | null;
  readonly unit: string | null;
  // Tier 3, kept separate from anything FRED said.
  readonly forecast: number | null;
  readonly forecastProvider: string | null;
  readonly forecastSourceName: string | null;
  readonly forecastTier: number | null;
  readonly forecastRetrievedAt: Date | null;
  // Tier 1.
  readonly actual: number | null;
  readonly actualProvider: string | null;
  readonly actualSourceName: string | null;
  readonly actualTier: number | null;
  readonly actualSourceUrl: string | null;
  /**
   * Provenance of the ROW, distinct from the forecast's.
   *
   * A release with no forecast still came from somewhere. Deriving row provenance
   * from the forecast fields recorded 68 real ForexFactory events as tier 4
   * "unknown" on the first live run — an attributable fact stored as unattributed.
   */
  readonly rowProvider: string;
  readonly rowSourceName: string;
  readonly rowSourceUrl: string | null;
  readonly rowTier: number;
  readonly sourceTimestamp: Date;
  readonly retrievedAt: Date;
}

export function ingestCalendarJob(deps: CalendarIngestDeps) {
  return async (ctx: JobContext): Promise<JobOutcome> => {
    const lookAhead = (deps.lookAheadDays ?? 14) * 86_400_000;
    const lookBack = (deps.lookBackDays ?? 3) * 86_400_000;
    const range = {
      from: new Date(ctx.now.getTime() - lookBack),
      to: new Date(ctx.now.getTime() + lookAhead),
    };

    const merged = new Map<string, MergedRelease>();

    // ── Tier 3 first: it is the only source of scheduled times ─────────────
    const ffResult = await deps.forexFactory.getReleases(range);
    if (ffResult.status !== 'UNAVAILABLE') {
      const observation = ffResult.observation;
      for (const raw of observation.value as ForexFactoryRelease[]) {
        const key = mergeKey(toCountryCode(raw.country), canonicalEventKey(raw.eventName), raw.scheduledAt);
        merged.set(key, {
          country: toCountryCode(raw.country),
          currency: toCurrencyCode(raw.currency),
          eventName: raw.eventName,
          canonicalKey: canonicalEventKey(raw.eventName),
          scheduledAt: raw.scheduledAt,
          scheduledLocalTime: raw.scheduledLocalTime,
          importanceHint: raw.importanceHint,
          isHoliday: raw.isHoliday,
          previous: raw.previous,
          unit: raw.unit,
          forecast: raw.forecast,
          forecastProvider: raw.forecast === null ? null : observation.provenance.providerId,
          forecastSourceName: raw.forecast === null ? null : observation.provenance.sourceName,
          forecastTier: raw.forecast === null ? null : observation.provenance.sourceTier,
          forecastRetrievedAt: raw.forecast === null ? null : observation.provenance.retrievedAt,
          actual: null,
          actualProvider: null,
          actualSourceName: null,
          actualTier: null,
          actualSourceUrl: null,
          rowProvider: observation.provenance.providerId,
          rowSourceName: observation.provenance.sourceName,
          rowSourceUrl: observation.provenance.sourceUrl,
          rowTier: observation.provenance.sourceTier,
          sourceTimestamp: observation.provenance.sourceTimestamp,
          retrievedAt: observation.provenance.retrievedAt,
        });
      }
    }

    // ── Tier 1: authoritative dates, filling gaps the Tier 3 feed missed ───
    const fredResult = await deps.fred.getReleases(range);
    if (fredResult.status !== 'UNAVAILABLE') {
      const observation = fredResult.observation;
      for (const raw of observation.value) {
        const canonical = canonicalEventKey(raw.eventName);
        const key = mergeKey(toCountryCode(raw.country), canonical, raw.scheduledAt);
        const existing = merged.get(key);

        if (existing !== undefined) {
          // Both sources have it. Keep the Tier 3 time (FRED has none) but upgrade
          // the row's own provenance to Tier 1, since FRED confirms the date.
          merged.set(key, {
            ...existing,
            rowProvider: observation.provenance.providerId,
            rowSourceName: observation.provenance.sourceName,
            rowSourceUrl: observation.provenance.sourceUrl,
            rowTier: observation.provenance.sourceTier,
            sourceTimestamp: observation.provenance.sourceTimestamp,
            retrievedAt: observation.provenance.retrievedAt,
            actualProvider: observation.provenance.providerId,
            actualSourceName: observation.provenance.sourceName,
            actualTier: observation.provenance.sourceTier,
            actualSourceUrl: observation.provenance.sourceUrl,
          });
          continue;
        }

        merged.set(key, {
          country: toCountryCode(raw.country),
          currency: toCurrencyCode(raw.currency),
          eventName: raw.eventName,
          canonicalKey: canonical,
          scheduledAt: raw.scheduledAt,
          // Customary time, not a published one — recorded as such.
          scheduledLocalTime: raw.scheduledLocalTime,
          importanceHint: raw.importanceHint,
          isHoliday: false,
          previous: null,
          unit: null,
          forecast: null,
          forecastProvider: null,
          forecastSourceName: null,
          forecastTier: null,
          forecastRetrievedAt: null,
          actual: null,
          actualProvider: observation.provenance.providerId,
          actualSourceName: observation.provenance.sourceName,
          actualTier: observation.provenance.sourceTier,
          actualSourceUrl: observation.provenance.sourceUrl,
          rowProvider: observation.provenance.providerId,
          rowSourceName: observation.provenance.sourceName,
          rowSourceUrl: observation.provenance.sourceUrl,
          rowTier: observation.provenance.sourceTier,
          sourceTimestamp: observation.provenance.sourceTimestamp,
          retrievedAt: observation.provenance.retrievedAt,
        });
      }
    }

    if (merged.size === 0) {
      // Both chains empty. Not a silent success — the job reports zero so the
      // system status panel shows the calendar is not being populated.
      return { itemsProcessed: 0, detail: 'no releases from either source' };
    }

    let written = 0;
    let curatedMatches = 0;
    for (const release of merged.values()) {
      const curated = await persist(ctx.db, release, deps.thresholds, ctx.now);
      if (curated) curatedMatches += 1;
      written += 1;
    }

    /**
     * The curated importance rules must actually match something.
     *
     * This is the assertion that would have caught the real failure: 143 releases
     * ingested with **zero** curated matches, because the rules were keyed on country
     * `US` while the feed supplies the currency code `USD`. Nothing reported a
     * problem — the pipeline looked healthy while CPI and NFP silently kept whatever
     * rating a scraped feed asserted.
     *
     * A rule set that matches nothing is a bug, not a quiet day.
     */
    const coverage = measureCoverage({
      name: 'curated importance rules ↔ ingested releases',
      candidates: [...merged.values()],
      matched: () => curatedMatches > 0,
      describe: (r) => `${r.country}/${r.eventName}`,
      expectation: { minMatches: 1 },
    });

    return {
      itemsProcessed: written,
      detail: coverage.healthy
        ? `${String(curatedMatches)} curated importance matches`
        : `WARNING: ${coverage.reason ?? 'curated rules matched nothing'} — ` +
          `${String(merged.size)} releases, 0 curated matches. ` +
          `Check that rule country codes match the feed's vocabulary.`,
    };
  };
}

const mergeKey = (country: string, canonical: string, at: Date): string =>
  `${country}|${canonical}|${at.toISOString().slice(0, 10)}`;

async function persist(
  db: Database,
  release: MergedRelease,
  thresholds: FreshnessThresholds,
  now: Date,
): Promise<boolean> {
  const { importance, curated } = await resolveImportance(db, {
    country: release.country,
    eventName: release.eventName,
    hint: release.importanceHint,
  });

  const [event] = await db
    .insert(economicEvents)
    .values({
      country: release.country,
      currency: release.currency,
      name: release.eventName,
      normalisedName: release.canonicalKey,
      importance,
      importanceIsCurated: curated,
    })
    .onConflictDoUpdate({
      target: [economicEvents.country, economicEvents.normalisedName],
      set: { importance: sql`excluded.importance`, importanceIsCurated: sql`excluded.importance_is_curated` },
    })
    .returning({ id: economicEvents.id });

  if (event === undefined) return curated;

  // Surprise is computed only when BOTH sides exist. A missing forecast yields a
  // null surprise, never zero — zero would read as "came in exactly as expected".
  const surprise =
    release.actual !== null && release.forecast !== null ? release.actual - release.forecast : null;

  const freshness = assessFreshness(
    liveTiming(release.sourceTimestamp, release.retrievedAt),
    thresholds,
    now,
  );

  await db
    .insert(economicReleases)
    .values({
      eventId: event.id,
      scheduledAt: release.scheduledAt,
      scheduledLocalTime: release.scheduledLocalTime,
      previousValue: release.previous === null ? null : String(release.previous),
      actualValue: release.actual === null ? null : String(release.actual),
      forecastValue: release.forecast === null ? null : String(release.forecast),
      forecastSourceProvider: release.forecastProvider,
      forecastSourceName: release.forecastSourceName,
      forecastSourceTier: release.forecastTier,
      forecastRetrievedAt: release.forecastRetrievedAt,
      surprise: surprise === null ? null : String(surprise),
      surpriseZ: null,
      unit: release.unit,
      sourceProvider: release.rowProvider,
      sourceName: release.rowSourceName,
      sourceUrl: release.rowSourceUrl,
      sourceTier: release.rowTier,
      sourceTimestamp: release.sourceTimestamp,
      retrievedAt: release.retrievedAt,
      freshness: freshness.status,
      qualityFlags: release.isHoliday ? ['LOW_SAMPLE'] : [],
    })
    .onConflictDoUpdate({
      target: [economicReleases.eventId, economicReleases.scheduledAt],
      set: {
        previousValue: sql`coalesce(excluded.previous_value, economic_releases.previous_value)`,
        actualValue: sql`coalesce(excluded.actual_value, economic_releases.actual_value)`,
        /*
         * ── The forecast and its provenance move together ─────────────────────
         *
         * Coalescing the value alone took the number from the incoming row and left
         * the provenance columns as they were, which is how a Tier 3 consensus figure
         * ends up in a row attributed to FRED — the precise thing
         * `economic_releases_forecast_provenanced` exists to forbid, and the reason
         * this surfaced as a constraint violation rather than as a wrong attribution
         * on the dashboard.
         *
         * It stayed latent because a forecast only appears within about a week of the
         * release (LIMITS.md §6.9), so the two sources rarely had one to merge. The
         * first release that did carry one failed the entire ingest.
         *
         * So the value decides and every provenance column follows the same decision.
         * Taking a value from one source and its attribution from another is not a
         * partial update; it is a fabricated citation.
         */
        forecastValue: sql`coalesce(excluded.forecast_value, economic_releases.forecast_value)`,
        forecastSourceProvider: takeWithForecast('forecast_source_provider'),
        forecastSourceName: takeWithForecast('forecast_source_name'),
        forecastSourceUrl: takeWithForecast('forecast_source_url'),
        forecastSourceTier: takeWithForecast('forecast_source_tier'),
        forecastRetrievedAt: takeWithForecast('forecast_retrieved_at'),
        surprise: sql`excluded.surprise`,
        freshness: sql`excluded.freshness`,
        retrievedAt: sql`excluded.retrieved_at`,
      },
    });

  return curated;
}

/**
 * One provenance column, taken from whichever row supplied the forecast value.
 *
 * `sql.raw` carries the column name because it is a literal from the fixed list at the
 * call site, never a value any provider supplied.
 */
function takeWithForecast(column: string): SQL {
  return sql`case when excluded.forecast_value is not null
    then excluded.${sql.raw(column)}
    else economic_releases.${sql.raw(column)} end`;
}
/** How many HIGH-impact releases fall inside a window — feeds event risk (§47). */
export async function upcomingHighImpact(
  db: Database,
  from: Date,
  to: Date,
): Promise<{ eventName: string; scheduledAt: Date; currency: string }[]> {
  return db
    .select({
      eventName: economicEvents.name,
      scheduledAt: economicReleases.scheduledAt,
      currency: economicEvents.currency,
    })
    .from(economicReleases)
    .innerJoin(economicEvents, eq(economicEvents.id, economicReleases.eventId))
    .where(
      and(
        eq(economicEvents.importance, 'HIGH'),
        sql`${economicReleases.scheduledAt} >= ${from}`,
        sql`${economicReleases.scheduledAt} <= ${to}`,
      ),
    )
    .orderBy(economicReleases.scheduledAt);
}
