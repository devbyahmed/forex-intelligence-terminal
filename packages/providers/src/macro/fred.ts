/**
 * FRED macro data (Tier 1) — the backbone of the fundamental engine.
 *
 * Every factor F1–F7 reads from here. Two properties of FRED shape this provider,
 * both verified against the live API rather than assumed:
 *
 *  1. **Revisions are real and material.** June payrolls moved 158,984 → 158,881
 *     between vintages. A revision is a new row, never an overwrite, or an analysis
 *     from last month would re-render citing a number that did not exist when it ran.
 *  2. **Publication lag varies by release family.** H.15 yields are current to about
 *     one business day; the H.10 exchange-rate family runs ~9 days behind. Freshness
 *     is therefore measured from the **vintage**, not the observation period, and
 *     each series carries thresholds matching its real cadence.
 */

import { z } from 'zod';
import {
  assessFreshnessOnCalendar,
  makeObservation,
  ok,
  publishedTiming,
  unavailable,
  type FreshnessThresholds,
  type MacroSeriesId,
  type ProviderResult,
  type PublicationDays,
  type QualityFlag,
} from '@forex-agent/core';
import { httpRequest, parseJson, HttpError } from '../http.js';
import type {
  MacroDataProvider,
  MacroPoint,
  MacroSeriesRequest,
  ProviderHealth,
  RateLimitPolicy,
} from '../types.js';

const BASE = 'https://api.stlouisfed.org/fred';

const observationSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** FRED writes '.' for a period with no value — a real absence, never zero. */
  value: z.string(),
  realtime_start: z.string().optional(),
  realtime_end: z.string().optional(),
});

const observationsSchema = z.object({
  observations: z.array(observationSchema),
});

const seriesMetaSchema = z.object({
  seriess: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      frequency_short: z.string().optional(),
      units_short: z.string().optional(),
      last_updated: z.string().optional(),
    }),
  ),
});

export interface FredMacroOptions {
  readonly apiKey: string | undefined;
  readonly timeoutMs?: number;
  /** Fallback thresholds; per-call thresholds should match the series cadence. */
  readonly thresholds: FreshnessThresholds;
  readonly baseUrl?: string;
}

export interface SeriesMetadata {
  readonly seriesId: string;
  readonly title: string;
  readonly frequency: string | null;
  readonly units: string | null;
  readonly lastUpdated: Date | null;
}

export class FredMacroProvider implements MacroDataProvider {
  readonly id = 'fred';
  readonly displayName = 'Federal Reserve Economic Data';
  readonly domain = 'MACRO' as const;
  readonly tier = 1 as const;
  /** Observed 2026-08-30: 429 at ~120 req/min. No documented daily cap. */
  readonly limits: RateLimitPolicy = { requestsPerMinute: 120 };

  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly thresholds: FreshnessThresholds;
  private readonly baseUrl: string;

  constructor(options: FredMacroOptions) {
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
        // Never echo the URL: it carries the API key as a query parameter.
        `FRED returned ${String(response.status)}`,
        response.status,
        response.durationMs,
      );
    }
    return parseJson(response);
  }

  /**
   * Series metadata — used by the Phase 8 freshness-classification audit to check a
   * declared cadence against the source's own frequency and update behaviour.
   */
  async getMetadata(seriesId: MacroSeriesId, now: Date = new Date()): Promise<SeriesMetadata | null> {
    if (!this.isConfigured()) return null;
    const raw = await this.fetchJson(this.url('series', { series_id: seriesId }), now);
    const parsed = seriesMetaSchema.safeParse(raw);
    const meta = parsed.success ? parsed.data.seriess[0] : undefined;
    if (meta === undefined) return null;
    return {
      seriesId: meta.id,
      title: meta.title,
      frequency: meta.frequency_short ?? null,
      units: meta.units_short ?? null,
      lastUpdated: meta.last_updated === undefined ? null : new Date(meta.last_updated),
    };
  }

  /**
   * Observations across their revision history.
   *
   * Requests a realtime range so FRED returns **one row per vintage** — the shape
   * verified against the live API, where `realtime_start` is the publication date of
   * that revision. Without the range FRED collapses to the current vintage only, and
   * revision history is lost.
   */
  async getSeries(
    request: MacroSeriesRequest,
    now: Date = new Date(),
    thresholds: FreshnessThresholds = this.thresholds,
  ): Promise<ProviderResult<MacroPoint[]>> {
    if (!this.isConfigured()) return unavailable('NOT_CONFIGURED', []);

    const params: Record<string, string> = {
      series_id: request.seriesId,
      sort_order: 'asc',
    };
    if (request.from !== undefined) params.observation_start = isoDate(request.from);
    if (request.to !== undefined) params.observation_end = isoDate(request.to);
    if (request.limit !== undefined) params.limit = String(request.limit);
    // Ask for every vintage published in the last two years, so revisions arrive
    // as distinct rows rather than being silently collapsed.
    params.realtime_start = isoDate(new Date(now.getTime() - 730 * 86_400_000));
    params.realtime_end = isoDate(now);

    const raw = await this.fetchJson(this.url('series/observations', params), now);
    const parsed = observationsSchema.safeParse(raw);
    if (!parsed.success) return unavailable('INVALID_RESPONSE', []);

    const points: MacroPoint[] = [];
    for (const o of parsed.data.observations) {
      // '.' means the period exists but has no value. Skipping is correct; coercing
      // it to 0 would inject a fabricated data point into every factor using it.
      if (o.value === '.') continue;
      const value = Number.parseFloat(o.value);
      if (!Number.isFinite(value)) continue;

      points.push({
        seriesId: request.seriesId,
        observationDate: o.date,
        value,
        vintage: o.realtime_start === undefined ? now : new Date(`${o.realtime_start}T00:00:00Z`),
      });
    }

    if (points.length === 0) return unavailable('NO_CACHED_VALUE', []);

    // Freshness of the batch reflects the newest thing we learned.
    const newestVintage = points.reduce(
      (max, p) => (p.vintage > max ? p.vintage : max),
      points[0]?.vintage ?? now,
    );
    const newestPeriod = points.reduce(
      (max, p) => (p.observationDate > max ? p.observationDate : max),
      points[0]?.observationDate ?? '',
    );

    // Counted in publication days, not calendar hours. The Friday yield read on a
    // Sunday is the latest yield in existence; nothing published because nothing was
    // due, so nothing is late.
    const freshness = assessFreshnessOnCalendar(
      publishedTiming({ publishedAt: newestVintage, describesPeriod: newestPeriod, retrievedAt: now }),
      thresholds,
      now,
      request.publicationDays,
    );

    return ok(
      makeObservation(
        points,
        {
          providerId: this.id,
          sourceName: this.displayName,
          sourceUrl: `https://fred.stlouisfed.org/series/${request.seriesId}`,
          sourceTier: this.tier,
          // The publication instant, never the period the value describes.
          sourceTimestamp: newestVintage,
          retrievedAt: now,
        },
        freshness.status,
      ),
    );
  }

  /** The current value: latest observation at its latest vintage. */
  async getLatest(
    seriesId: MacroSeriesId,
    publicationDays: PublicationDays,
    now: Date = new Date(),
    thresholds: FreshnessThresholds = this.thresholds,
  ): Promise<ProviderResult<MacroPoint>> {
    if (!this.isConfigured()) return unavailable('NOT_CONFIGURED', []);

    const raw = await this.fetchJson(
      this.url('series/observations', {
        series_id: seriesId,
        sort_order: 'desc',
        limit: '5',
      }),
      now,
    );

    const parsed = observationsSchema.safeParse(raw);
    if (!parsed.success) return unavailable('INVALID_RESPONSE', []);

    // Walk back past any trailing '.' periods to the most recent real value.
    const observation = parsed.data.observations.find((o) => o.value !== '.');
    if (observation === undefined) return unavailable('NO_CACHED_VALUE', []);

    const value = Number.parseFloat(observation.value);
    if (!Number.isFinite(value)) return unavailable('INVALID_RESPONSE', []);

    // Without a realtime range FRED reports the current realtime period, so this is
    // "as of today" rather than the first-publication date — correct for a latest
    // value, and distinct from the vintage semantics of getSeries.
    const vintage =
      observation.realtime_start === undefined
        ? now
        : new Date(`${observation.realtime_start}T00:00:00Z`);

    const freshness = assessFreshnessOnCalendar(
      publishedTiming({
        publishedAt: vintage,
        describesPeriod: observation.date,
        retrievedAt: now,
      }),
      thresholds,
      now,
      publicationDays,
    );

    return ok(
      makeObservation(
        { seriesId, observationDate: observation.date, value, vintage },
        {
          providerId: this.id,
          sourceName: this.displayName,
          sourceUrl: `https://fred.stlouisfed.org/series/${seriesId}`,
          sourceTier: this.tier,
          sourceTimestamp: vintage,
          retrievedAt: now,
        },
        freshness.status,
      ),
    );
  }
}

const isoDate = (d: Date): string => d.toISOString().split('T')[0] ?? '';

// ── Validation (master PRD §52) ─────────────────────────────────────────────

/**
 * Plausible ranges per series role.
 *
 * A yield of 400% or a VIX of −5 means the provider changed units or returned an
 * error payload that happened to parse. Flagged and quarantined rather than scored:
 * the value is still stored and visible, it just may not move a factor.
 */
const PLAUSIBLE_RANGE: Readonly<Record<string, { min: number; max: number }>> = {
  DGS10: { min: -5, max: 25 },
  DGS2: { min: -5, max: 25 },
  DFII10: { min: -10, max: 20 },
  DFF: { min: -1, max: 25 },
  DTWEXBGS: { min: 50, max: 200 },
  VIXCLS: { min: 5, max: 150 },
  BAMLH0A0HYM2: { min: 0, max: 30 },
  CPIAUCSL: { min: 50, max: 1000 },
  CPILFESL: { min: 50, max: 1000 },
  PAYEMS: { min: 50_000, max: 500_000 },
  UNRATE: { min: 0, max: 40 },
  ICSA: { min: 50_000, max: 10_000_000 },
};

export function validateMacroPoint(
  point: MacroPoint,
  previous?: MacroPoint,
): readonly QualityFlag[] {
  const flags: QualityFlag[] = [];

  // A revision is detectable regardless of whether either value is present.
  if (point.observationDate === previous?.observationDate) {
    flags.push('REVISED');
  }

  /**
   * A null value is a real absence — FRED's '.' meaning the period exists but has no
   * figure. There is nothing to range-check or compare, and inventing a comparison
   * against zero would flag every legitimate gap as an anomaly.
   */
  if (point.value === null) return flags;

  const range = PLAUSIBLE_RANGE[point.seriesId];
  if (range !== undefined && (point.value < range.min || point.value > range.max)) {
    flags.push('IMPOSSIBLE_VALUE');
  }

  if (previous?.value != null && previous.value !== 0) {
    const change = Math.abs((point.value - previous.value) / previous.value);
    // A daily series moving more than 50% overnight is almost always a unit change
    // or a bad print, not a market event.
    if (change > 0.5) flags.push('ANOMALY');
  }

  return flags;
}
