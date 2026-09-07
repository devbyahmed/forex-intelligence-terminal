/**
 * ForexFactory weekly calendar feed (Tier 3).
 *
 * Supplies the three things FRED does not: the **scheduled time of day**, the
 * **consensus forecast**, and an importance hint. Verified 2026-08-30: 110 events,
 * 15 of them HIGH impact, fields `title, country, date, impact, forecast, previous`.
 *
 * It is Tier 3 and is provenanced as such. Its figures sit beside Tier 1 actuals from
 * FRED without ever being merged into them, because a scraped consensus and an
 * official statistic are not the same kind of claim.
 */

import { z } from 'zod';
import {
  assessFreshness,
  liveTiming,
  makeObservation,
  ok,
  unavailable,
  type FreshnessThresholds,
  type ProviderResult,
  type QualityFlag,
} from '@forex-agent/core';
import { httpRequest, parseJson, HttpError } from '../http.js';
import type {
  DateRange,
  EconomicCalendarProvider,
  ProviderHealth,
  RateLimitPolicy,
  RawEconomicRelease,
} from '../types.js';

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

/**
 * The feed's own impact values.
 *
 * **`Holiday` is a fourth value, observed in the live feed and absent from our
 * `HIGH | MEDIUM | LOW` vocabulary.** It is not an impact level at all — it marks a
 * market closure. Coercing it to LOW would file bank holidays as low-importance
 * economic events; dropping the row would lose the fact that a market is shut, which
 * is genuinely useful context for interpreting thin volume.
 *
 * So it is preserved as its own signal: importance `LOW`, plus an `isHoliday` marker
 * the calendar pipeline can act on.
 */
const feedItemSchema = z.object({
  title: z.string().min(1),
  country: z.string().min(1),
  date: z.string().min(1),
  impact: z.enum(['High', 'Medium', 'Low', 'Holiday']),
  forecast: z.string(),
  previous: z.string(),
  // Present on some variants once a release has landed; absent on the weekly feed.
  actual: z.string().optional(),
});

const feedSchema = z.array(feedItemSchema);

export type FeedImpact = z.infer<typeof feedItemSchema>['impact'];

export interface ForexFactoryRelease extends RawEconomicRelease {
  /** True when the feed marked this a market holiday rather than a data release. */
  readonly isHoliday: boolean;
}

/**
 * Parse the feed's numeric strings.
 *
 * Values arrive with units attached — `"4.1%"`, `"213K"`, `"-2.0%"`, `""`. An empty
 * string means *not published*, which must become `null` rather than `0`: a forecast
 * of zero and no forecast at all are entirely different claims, and conflating them
 * would feed a fabricated number into the surprise calculation.
 */
export function parseFeedNumber(raw: string): { value: number | null; unit: string | null } {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, unit: null };

  const match = /^(-?[\d,]*\.?\d+)\s*([%KMBT]?)$/i.exec(trimmed);
  if (match === null) return { value: null, unit: null };

  const numeric = Number.parseFloat((match[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return { value: null, unit: null };

  const suffix = (match[2] ?? '').toUpperCase();
  const multiplier =
    suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : suffix === 'T' ? 1e12 : 1;

  return {
    value: numeric * multiplier,
    // The unit is retained rather than normalised away: '4.1%' and '4.1' are
    // different facts, and the UI must be able to render what the source published.
    unit: suffix === '%' ? '%' : suffix === '' ? null : suffix,
  };
}

/**
 * Parse the feed's timestamps.
 *
 * Observed format: `2026-09-04T08:30:00-04:00` — a **US Eastern offset**, not UTC.
 * `-04:00` is EDT; the same feed emits `-05:00` in winter under EST.
 *
 * The offset is embedded in the string, so `Date.parse` handles the conversion
 * correctly on its own and **we must not apply a fixed offset of our own**. Hard-coding
 * −4 would silently shift every event by an hour for the four winter months — the exact
 * class of bug that puts an FOMC decision in the wrong hour and invalidates event-risk
 * warnings.
 *
 * What we do instead is verify the string actually carries an offset. A timestamp
 * without one would be interpreted in the *server's* local zone, which on a serverless
 * host is UTC and on a developer's laptop is whatever they live in.
 */
export function parseFeedTimestamp(raw: string): { at: Date; localTime: string } | null {
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw.trim());
  if (!hasExplicitOffset) return null;

  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;

  // Retain the source's own rendering for display fidelity: showing a user
  // "08:30 ET" as published beats showing them a converted 12:30 UTC.
  const localTime = raw.slice(11, 16);
  return { at: new Date(ms), localTime };
}

const IMPACT_MAP: Readonly<Record<FeedImpact, 'HIGH' | 'MEDIUM' | 'LOW'>> = {
  High: 'HIGH',
  Medium: 'MEDIUM',
  Low: 'LOW',
  // Not an impact level — see the note on the schema above.
  Holiday: 'LOW',
};

export function normaliseFeedItem(
  item: z.infer<typeof feedItemSchema>,
): ForexFactoryRelease | null {
  const timestamp = parseFeedTimestamp(item.date);
  if (timestamp === null) return null;

  const forecast = parseFeedNumber(item.forecast);
  const previous = parseFeedNumber(item.previous);
  const actual = item.actual === undefined ? { value: null, unit: null } : parseFeedNumber(item.actual);

  return {
    // The feed puts the currency code in `country`; both are recorded because the
    // calendar is filtered by currency but displayed by country.
    country: item.country,
    currency: item.country,
    eventName: item.title,
    scheduledAt: timestamp.at,
    scheduledLocalTime: timestamp.localTime,
    previous: previous.value,
    forecast: forecast.value,
    actual: actual.value,
    unit: forecast.unit ?? previous.unit,
    importanceHint: IMPACT_MAP[item.impact],
    isHoliday: item.impact === 'Holiday',
  };
}

export interface ForexFactoryOptions {
  readonly timeoutMs?: number;
  readonly thresholds: FreshnessThresholds;
  readonly feedUrl?: string;
}

export class ForexFactoryCalendarProvider implements EconomicCalendarProvider {
  readonly id = 'forexfactory';
  readonly displayName = 'ForexFactory Weekly Calendar';
  readonly domain = 'ECONOMIC_CALENDAR' as const;
  /** Tier 3: a scraped consensus, never an official statistic. */
  readonly tier = 3 as const;
  readonly limits: RateLimitPolicy = { requestsPerDay: 200 };
  /** It carries `previous`, and sometimes `actual`, but is not authoritative for either. */
  readonly providesActuals = false;
  readonly providesForecasts = true;

  private readonly feedUrl: string;
  private readonly timeoutMs: number;
  private readonly thresholds: FreshnessThresholds;

  constructor(options: ForexFactoryOptions) {
    this.feedUrl = options.feedUrl ?? FEED_URL;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.thresholds = options.thresholds;
  }

  /** No key required, so it is always configured. */
  isConfigured(): boolean {
    return true;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const response = await httpRequest({ url: this.feedUrl, timeoutMs: this.timeoutMs });
      return { providerId: this.id, reachable: response.ok, checkedAt: new Date() };
    } catch (e) {
      return {
        providerId: this.id,
        reachable: false,
        checkedAt: new Date(),
        detail: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
      };
    }
  }

  async getEvents(range: DateRange): Promise<ProviderResult<ForexFactoryRelease[]>> {
    return this.getReleases(range);
  }

  async getReleases(
    range: DateRange,
    now: Date = new Date(),
  ): Promise<ProviderResult<ForexFactoryRelease[]>> {
    const response = await httpRequest({ url: this.feedUrl, timeoutMs: this.timeoutMs }, now);

    if (!response.ok) {
      throw new HttpError(
        `HTTP_${String(response.status)}`,
        `ForexFactory feed returned ${String(response.status)}`,
        response.status,
        response.durationMs,
      );
    }

    const parsed = feedSchema.safeParse(parseJson(response));
    if (!parsed.success) {
      // A shape change must fail loudly. Silently ingesting a feed that has
      // restructured is how corrupt calendar data reaches the event-risk engine.
      throw new HttpError(
        'SCHEMA_MISMATCH',
        `ForexFactory feed did not match the expected shape: ${parsed.error.issues[0]?.message ?? ''}`,
        response.status,
        response.durationMs,
      );
    }

    const flags: QualityFlag[] = [];
    const releases: ForexFactoryRelease[] = [];
    let unparseableTimestamps = 0;

    for (const item of parsed.data) {
      const normalised = normaliseFeedItem(item);
      if (normalised === null) {
        unparseableTimestamps += 1;
        continue;
      }
      if (
        normalised.scheduledAt >= range.from &&
        normalised.scheduledAt <= range.to
      ) {
        releases.push(normalised);
      }
    }

    if (unparseableTimestamps > 0) flags.push('ANOMALY');

    if (releases.length === 0) {
      // An empty week is possible but unusual; report it as unavailable rather than
      // as a successful empty result, so the caller can fall back.
      return unavailable('INVALID_RESPONSE', []);
    }

    // The feed publishes a week at a time and is refreshed continuously; its own
    // freshness is the retrieval time, since it carries no publication timestamp.
    // The feed carries no publication timestamp of its own, so retrieval is the
    // best available statement of when this became known.
    const freshness = assessFreshness(liveTiming(now, now), this.thresholds, now);

    return ok(
      makeObservation(
        releases,
        {
          providerId: this.id,
          sourceName: this.displayName,
          sourceUrl: this.feedUrl,
          sourceTier: this.tier,
          sourceTimestamp: now,
          retrievedAt: now,
        },
        freshness.status,
        flags,
      ),
    );
  }
}
