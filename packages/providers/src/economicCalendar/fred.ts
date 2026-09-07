/**
 * FRED release calendar (Tier 1).
 *
 * Authoritative for **which** releases occur, **on what date**, and — through the
 * underlying series — what the **actual** value turned out to be.
 *
 * Verified 2026-08-30, two limits that shape the design:
 *
 *  1. **FRED publishes dates, never times.** `releases/dates` returns a bare
 *     `YYYY-MM-DD`. The design originally assumed FRED was authoritative for "when";
 *     it is authoritative for the *day*. The time of day comes from the Tier 3 feed or
 *     a curated schedule, and is provenanced separately.
 *  2. **`releases/dates` returns everything** — 3,378 upcoming dates across every
 *     release FRED tracks. Ingesting the lot would bury CPI among crypto price feeds,
 *     so the job filters to a curated set of releases that actually move gold.
 */

import { z } from 'zod';
import {
  assessFreshness,
  liveTiming,
  makeObservation,
  ok,
  publishedTiming,
  unavailable,
  zoneOffsetMinutes,
  type FreshnessThresholds,
  type MacroSeriesId,
  type ProviderResult,
} from '@forex-agent/core';
import { httpRequest, parseJson, HttpError } from '../http.js';
import type {
  DateRange,
  EconomicCalendarProvider,
  ProviderHealth,
  RateLimitPolicy,
  RawEconomicRelease,
} from '../types.js';

const BASE = 'https://api.stlouisfed.org/fred';

/**
 * The releases worth tracking, and the series carrying each one's actual value.
 *
 * Curated rather than discovered: FRED tracks thousands of releases, and an
 * unfiltered calendar is noise. Release ids verified against the live API.
 */
export interface TrackedRelease {
  readonly releaseId: number;
  readonly name: string;
  readonly country: string;
  readonly currency: string;
  /** Series whose observation is the headline number for this release. */
  readonly actualSeriesId: MacroSeriesId | null;
  /**
   * Publication time in US Eastern, as a fallback when the Tier 3 feed has no entry.
   * Stored as a curated fact with its own provenance — never presented as FRED's.
   */
  readonly customaryEasternTime: string | null;
  /**
   * Whether this release has **discrete scheduled dates** worth putting on a calendar.
   *
   * Observed 2026-08-30: `include_release_dates_with_no_data=true` is required to see
   * future scheduled dates at all — with it off, CPI, Employment Situation and Claims
   * all return nothing ahead of today. But with it on, continuously-updated data
   * products emit an entry for **every calendar day**: FOMC Press Release produced 18
   * dates over 18 days, which would have populated the calendar with a daily phantom
   * FOMC meeting and fired event-risk warnings every single day.
   *
   * So the flag stays on and these releases are excluded from event generation. They
   * remain tracked for their *actual values*, which is what they are actually good for.
   */
  readonly emitsCalendarEvents: boolean;
}

export const TRACKED_RELEASES: readonly TrackedRelease[] = [
  { releaseId: 10, name: 'Consumer Price Index', country: 'US', currency: 'USD', actualSeriesId: 'CPIAUCSL', customaryEasternTime: '08:30', emitsCalendarEvents: true },
  { releaseId: 50, name: 'Employment Situation', country: 'US', currency: 'USD', actualSeriesId: 'PAYEMS', customaryEasternTime: '08:30', emitsCalendarEvents: true },
  { releaseId: 180, name: 'Unemployment Insurance Weekly Claims Report', country: 'US', currency: 'USD', actualSeriesId: 'ICSA', customaryEasternTime: '08:30', emitsCalendarEvents: true },
  { releaseId: 53, name: 'Gross Domestic Product', country: 'US', currency: 'USD', actualSeriesId: null, customaryEasternTime: '08:30', emitsCalendarEvents: true },
  // Continuously updated in FRED — emits a date every day. Real FOMC meeting dates
  // come from the Tier 3 feed, which publishes actual scheduled meetings.
  { releaseId: 101, name: 'FOMC Press Release', country: 'US', currency: 'USD', actualSeriesId: null, customaryEasternTime: '14:00', emitsCalendarEvents: false },
  { releaseId: 18, name: 'H.15 Selected Interest Rates', country: 'US', currency: 'USD', actualSeriesId: 'DGS10', customaryEasternTime: '16:15', emitsCalendarEvents: false },
  { releaseId: 17, name: 'H.10 Foreign Exchange Rates', country: 'US', currency: 'USD', actualSeriesId: 'DTWEXBGS', customaryEasternTime: '16:15', emitsCalendarEvents: false },
];

const releaseDateSchema = z.object({
  release_id: z.number(),
  release_name: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const releaseDatesSchema = z.object({
  count: z.number(),
  release_dates: z.array(releaseDateSchema),
});

const observationSchema = z.object({
  date: z.string(),
  value: z.string(),
  realtime_start: z.string().optional(),
  realtime_end: z.string().optional(),
});

const observationsSchema = z.object({
  observations: z.array(observationSchema),
});

export interface FredCalendarOptions {
  readonly apiKey: string | undefined;
  readonly timeoutMs?: number;
  readonly thresholds: FreshnessThresholds;
  readonly baseUrl?: string;
}

export class FredCalendarProvider implements EconomicCalendarProvider {
  readonly id = 'fred-calendar';
  readonly displayName = 'Federal Reserve Economic Data — Release Calendar';
  readonly domain = 'ECONOMIC_CALENDAR' as const;
  readonly tier = 1 as const;
  /** Observed limit ~120 req/min; no documented daily cap. */
  readonly limits: RateLimitPolicy = { requestsPerMinute: 120 };
  readonly providesActuals = true;
  /** FRED publishes no consensus forecast. This is why the chain needs a Tier 3 member. */
  readonly providesForecasts = false;

  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly thresholds: FreshnessThresholds;
  private readonly baseUrl: string;

  constructor(options: FredCalendarOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.thresholds = options.thresholds;
    this.baseUrl = options.baseUrl ?? BASE;
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined && this.apiKey !== '';
  }

  async health(): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return {
        providerId: this.id,
        reachable: false,
        checkedAt: new Date(),
        detail: 'FRED_API_KEY not configured',
      };
    }
    try {
      const r = await httpRequest({
        url: this.url('series', { series_id: 'DGS10' }),
        timeoutMs: this.timeoutMs,
      });
      return { providerId: this.id, reachable: r.ok, checkedAt: new Date() };
    } catch (e) {
      return {
        providerId: this.id,
        reachable: false,
        checkedAt: new Date(),
        detail: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
      };
    }
  }

  private url(path: string, params: Record<string, string>): string {
    const u = new URL(`${this.baseUrl}/${path}`);
    u.searchParams.set('file_type', 'json');
    if (this.apiKey !== undefined) u.searchParams.set('api_key', this.apiKey);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async fetchJson(url: string, now: Date): Promise<unknown> {
    const response = await httpRequest({ url, timeoutMs: this.timeoutMs }, now);
    if (!response.ok) {
      throw new HttpError(
        `HTTP_${String(response.status)}`,
        // Never include the URL body here — it carries the API key as a query param.
        `FRED returned ${String(response.status)}`,
        response.status,
        response.durationMs,
      );
    }
    return parseJson(response);
  }

  async getEvents(range: DateRange): Promise<ProviderResult<RawEconomicRelease[]>> {
    return this.getReleases(range);
  }

  /**
   * Upcoming and recent release dates for the tracked set.
   *
   * One request per tracked release rather than a single unfiltered sweep: seven
   * targeted calls return exactly what we need, where the sweep returns 3,378 rows we
   * would then throw away — and each targeted call is trivially cacheable.
   */
  async getReleases(
    range: DateRange,
    now: Date = new Date(),
  ): Promise<ProviderResult<RawEconomicRelease[]>> {
    if (!this.isConfigured()) return unavailable('NOT_CONFIGURED', []);

    const from = isoDate(range.from);
    const to = isoDate(range.to);
    const releases: RawEconomicRelease[] = [];

    for (const tracked of TRACKED_RELEASES) {
      // Data products are tracked for their values, not as calendar events.
      if (!tracked.emitsCalendarEvents) continue;
      const raw = await this.fetchJson(
        this.url('release/dates', {
          release_id: String(tracked.releaseId),
          realtime_start: from,
          realtime_end: to,
          include_release_dates_with_no_data: 'true',
          sort_order: 'asc',
          limit: '50',
        }),
        now,
      );

      const parsed = releaseDatesSchema.safeParse(raw);
      if (!parsed.success) continue;

      for (const entry of parsed.data.release_dates) {
        const scheduledAt = easternDateTime(entry.date, tracked.customaryEasternTime ?? '08:30');
        if (scheduledAt === null) continue;
        if (scheduledAt < range.from || scheduledAt > range.to) continue;

        releases.push({
          country: tracked.country,
          currency: tracked.currency,
          eventName: tracked.name,
          scheduledAt,
          // Marked as customary rather than published: FRED gave us the date only,
          // and pretending we know the minute would be inventing precision.
          scheduledLocalTime: tracked.customaryEasternTime,
          previous: null,
          // FRED has no forecast. Null here is the honest value, not a gap to fill.
          forecast: null,
          actual: null,
          unit: null,
          importanceHint: null,
        });
      }
    }

    if (releases.length === 0) return unavailable('NO_CACHED_VALUE', []);

    // A calendar listing is live data: publication and observation coincide.
    const freshness = assessFreshness(liveTiming(now, now), this.thresholds, now);

    return ok(
      makeObservation(
        releases,
        {
          providerId: this.id,
          sourceName: this.displayName,
          sourceUrl: 'https://fred.stlouisfed.org/releases',
          sourceTier: this.tier,
          sourceTimestamp: now,
          retrievedAt: now,
        },
        freshness.status,
      ),
    );
  }

  /**
   * The actual value for a release, from its underlying series.
   *
   * This is the Tier 1 half of the calendar: the number itself, from the agency that
   * published it, rather than from a scraped table.
   */
  async getActual(
    seriesId: MacroSeriesId,
    observationDate: string,
    now: Date = new Date(),
    /**
     * Thresholds matching the *series cadence*, not the calendar's.
     *
     * A monthly statistic is inherently weeks old and that is not staleness. Passing
     * the calendar's 48-hour window here marked a perfectly current CPI print
     * `UNAVAILABLE` — caught by the live smoke test. The caller knows the series
     * cadence, so the caller supplies the thresholds.
     */
    thresholds: FreshnessThresholds = this.thresholds,
  ): Promise<ProviderResult<{ value: number; observationDate: string; vintage: Date }>> {
    if (!this.isConfigured()) return unavailable('NOT_CONFIGURED', []);

    const raw = await this.fetchJson(
      this.url('series/observations', {
        series_id: seriesId,
        observation_start: observationDate,
        observation_end: observationDate,
        sort_order: 'desc',
        limit: '1',
      }),
      now,
    );

    const parsed = observationsSchema.safeParse(raw);
    const observation = parsed.success ? parsed.data.observations[0] : undefined;

    // FRED writes '.' for a period with no value. That is a real absence, and it
    // must stay absent rather than becoming zero.
    if (observation === undefined || observation.value === '.') {
      return unavailable('NO_CACHED_VALUE', []);
    }

    const value = Number.parseFloat(observation.value);
    if (!Number.isFinite(value)) return unavailable('INVALID_RESPONSE', []);

    const vintage =
      observation.realtime_start === undefined ? now : new Date(observation.realtime_start);

    /**
     * Freshness is measured from the **publication date**, not the observation period.
     *
     * The period label is what the number describes; the vintage is when it became
     * known. July's CPI published in mid-August is entirely current in late August —
     * measuring from 1 July made it look two months stale and marked it
     * `UNAVAILABLE`, which would have silently dropped the inflation factor.
     */
    // publishedTiming forces the distinction: the vintage is when this became
    // known, observation.date is the period it describes. Only the former can
    // reach the freshness calculation.
    const timing = publishedTiming({
      publishedAt: vintage,
      describesPeriod: observation.date,
      retrievedAt: now,
    });
    const freshness = assessFreshness(timing, thresholds, now);

    return ok(
      makeObservation(
        { value, observationDate: observation.date, vintage },
        {
          providerId: this.id,
          sourceName: 'Federal Reserve Economic Data',
          sourceUrl: `https://fred.stlouisfed.org/series/${seriesId}`,
          sourceTier: this.tier,
          // The publication instant, for the same reason. The period the figure
          // describes is carried separately as `observationDate`.
          sourceTimestamp: vintage,
          retrievedAt: now,
        },
        freshness.status,
      ),
    );
  }
}

const isoDate = (d: Date): string => (d.toISOString().split('T')[0] ?? '');

/**
 * Combine a FRED date with a customary US Eastern time.
 *
 * Eastern is **not a fixed offset**: EDT is −04:00 and EST is −05:00, and US releases
 * are scheduled in local Eastern time, so an 08:30 CPI is 12:30 UTC in summer and
 * 13:30 UTC in winter. Hard-coding either offset would put every event in the wrong
 * hour for part of the year — and an event-risk warning that fires an hour late is
 * worse than none.
 *
 * Resolved by asking `Intl` what the offset actually is on that date, rather than
 * assuming.
 */
export function easternDateTime(isoDay: string, hhmm: string): Date | null {
  const [hourStr, minuteStr] = hhmm.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  // Start from the wall-clock instant interpreted as UTC, then correct by the real
  // Eastern offset for that date.
  const naive = Date.parse(`${isoDay}T${pad(hour)}:${pad(minute)}:00Z`);
  if (Number.isNaN(naive)) return null;

  const offsetMinutes = easternOffsetMinutes(new Date(naive));
  return new Date(naive - offsetMinutes * 60_000);
}

/**
 * The real UTC offset of America/New_York at a given instant, in minutes.
 *
 * Delegates to the shared reader rather than restating the rule. This offset was
 * computed here and again in the report layer; two copies of a calendar rule are two
 * chances to disagree about which day a fact belongs to.
 */
export function easternOffsetMinutes(at: Date): number {
  return zoneOffsetMinutes(at, 'America/New_York');
}
const pad = (n: number): string => String(n).padStart(2, '0');
