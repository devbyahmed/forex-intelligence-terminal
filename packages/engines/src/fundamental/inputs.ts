/**
 * What the engine is given.
 *
 * The engine is a pure function of these values — no database, no fetch, no ambient
 * clock (ARCHITECTURE §4.1). Everything time-dependent arrives as data, including
 * `now`, so a run is reproducible from its inputs alone and a factor's behaviour on
 * stale data can be tested without waiting for data to go stale.
 *
 * Freshness arrives **already assessed**. The engine does not re-derive it from
 * timestamps: that computation belongs to `assessFreshnessOnCalendar`, which knows
 * each series' publication calendar, and duplicating it here would be a second place
 * to get the H.10 lag wrong.
 */

import type {
  FreshnessStatus,
  Importance,
  MacroSeriesId,
  SourceTier,
} from '@forex-agent/core';

/** One observation of a macro series, as stored. */
export interface MacroPointView {
  /** The period described, `YYYY-MM-DD`. */
  readonly period: string;
  /** Null where the source published a gap — FRED writes '.' for a real absence. */
  readonly value: number | null;
  /** Row id, for the provenance expander. */
  readonly factId: string;
}

/**
 * A macro series as the engine sees it.
 *
 * `points` are ordered oldest → newest and already deduplicated to one row per period
 * at its latest vintage — revisions are resolved before the engine sees them, so a
 * factor never has to decide which vintage is current.
 */
export interface MacroSeriesView {
  readonly seriesId: MacroSeriesId;
  readonly points: readonly MacroPointView[];
  /** Freshness of the newest point, from the publication-calendar assessment. */
  readonly freshness: FreshnessStatus;
  readonly sourceTier: SourceTier;
  /** Human label for explanations, e.g. '10-Year TIPS Constant Maturity'. */
  readonly displayName: string;
}

/** A standardised release surprise from the calendar pipeline (PRD_V1 §8.2). */
export interface SurpriseView {
  readonly eventName: string;
  readonly country: string;
  /** Actual − forecast, in the release's own units. */
  readonly surprise: number | null;
  /** Standardised against the release's own history; null when it could not be. */
  readonly surpriseZ: number | null;
  readonly releasedAt: Date;
  readonly freshness: FreshnessStatus;
  readonly sourceTier: SourceTier;
  readonly factId: string;
}

/** An upcoming release, for event risk (PRD_V1 §8.7). */
export interface UpcomingReleaseView {
  readonly eventName: string;
  readonly country: string;
  readonly scheduledAt: Date;
  readonly importance: Importance;
  readonly factId: string;
}

/**
 * The news aggregate, or the reason there isn't one.
 *
 * A discriminated union for the same reason factors are: "insufficient volume" must
 * not be representable as a polarity of zero. F8 is dark today because measured
 * volume is roughly 3 gold-relevant articles a day against a floor of 10 (PRD_V1
 * §8.3a), and that is the correct outcome rather than something to engineer around.
 */
export type NewsAggregateView =
  | {
      readonly kind: 'AVAILABLE';
      /** Recency-decayed, tier-weighted mean polarity, −1…+1. */
      readonly polarity: number;
      readonly articleCount: number;
      readonly sourceCount: number;
      /** Trailing polarity readings, for standardisation. */
      readonly history: readonly number[];
      readonly freshness: FreshnessStatus;
      readonly sourceTier: SourceTier;
      readonly factIds: readonly string[];
    }
  | {
      readonly kind: 'INSUFFICIENT_VOLUME';
      /**
       * Which threshold was missed.
       *
       * Carried rather than re-derived from the counts. "Twenty articles, none of
       * which carried a sentiment term" and "no articles at all" are different facts
       * about the world, and both reduce to zero scoreable articles — a factor that
       * reported the second when the first was true would be describing an absence
       * of news that did not happen.
       */
      readonly reason: 'INSUFFICIENT_NEWS_VOLUME' | 'INSUFFICIENT_SOURCE_DIVERSITY' | 'NO_SENTIMENT_SIGNAL';
      /** The aggregate’s own sentence, so one rule states it in one place. */
      readonly explanation: string;
      readonly articleCount: number;
      readonly sourceCount: number;
      readonly requiredArticles: number;
      readonly requiredSources: number;
    };

/**
 * A sub-signal that is unobtainable on the sources this product is built on.
 *
 * Declared by the caller rather than inferred by the engine, because the engine sees
 * only that a value is absent — it cannot know whether the pipeline has not fetched it
 * yet, or whether no amount of fetching ever will. Attributing that difference by
 * guesswork is how a permanent constraint gets reported as a transient outage.
 */
export const STRUCTURAL_GAP_KINDS = [
  /**
   * Historical consensus forecasts, needed to standardise release surprises.
   *
   * Measured 2026-09-01: of 197 stored releases, 78 carry a forecast and **none older
   * than eight days**. ForexFactory's free feed is a rolling one-week window; FRED
   * publishes release dates but no consensus at all; every vendor sells the history.
   * `surprise_z` needs twelve past surprises, and we accrue roughly one a month
   * (LIMITS.md §6.9).
   */
  'RELEASE_SURPRISE_HISTORY',
] as const;
export type StructuralGapKind = (typeof STRUCTURAL_GAP_KINDS)[number];

export interface StructuralGap {
  readonly kind: StructuralGapKind;
  readonly reason: string;
  readonly resolution: string | null;
}

/** The gap the product ships with today, stated once so the wording cannot drift. */
export const RELEASE_SURPRISE_GAP: StructuralGap = {
  kind: 'RELEASE_SURPRISE_HISTORY',
  reason:
    'historical consensus forecasts are not available from any free source — the only free ' +
    'feed carrying them is a rolling one-week window, so no surprise history exists to ' +
    'standardise against',
  resolution:
    'resolves once roughly twelve months of forecasts have accumulated from live ingestion ' +
    '(about one per release per month)',
};

export interface FundamentalInputs {
  /** Keyed by FRED series id. A missing key means the series was never fetched. */
  readonly series: Readonly<Partial<Record<MacroSeriesId, MacroSeriesView>>>;
  /** Most recent standardised surprise per event family, e.g. 'CPI', 'NFP'. */
  readonly surprises: Readonly<Record<string, SurpriseView | undefined>>;
  readonly news: NewsAggregateView;
  readonly upcomingReleases: readonly UpcomingReleaseView[];
  /** Provider chains running on a fallback or with a breaker open. */
  readonly degradedProviders: readonly string[];
  /**
   * Sub-signals known to be unobtainable, so their absence is reported as a permanent
   * constraint rather than as a transient outage.
   */
  readonly structuralGaps: readonly StructuralGap[];
}

// ── Series helpers ──────────────────────────────────────────────────────────

/** Values in order, with published gaps dropped. */
export function valuesOf(view: MacroSeriesView | undefined): readonly number[] {
  if (view === undefined) return [];
  return view.points
    .map((p) => p.value)
    .filter((v): v is number => v !== null && Number.isFinite(v));
}

/** The newest usable value, or null. */
export function latestValue(view: MacroSeriesView | undefined): number | null {
  const values = valuesOf(view);
  return values.length === 0 ? null : (values[values.length - 1] ?? null);
}

/** The value `horizon` observations back, or null when the history is too short. */
export function laggedValue(view: MacroSeriesView | undefined, horizon: number): number | null {
  const values = valuesOf(view);
  if (values.length <= horizon) return null;
  return values[values.length - 1 - horizon] ?? null;
}

/**
 * The trailing history of `horizon`-period changes.
 *
 * A 5-day change must be standardised against other 5-day changes, not against the
 * level of the series. Standardising a change against levels compares a number near
 * zero to a distribution centred on 4.6, which produces a large negative z on a
 * completely ordinary day.
 */
export function changeHistory(
  values: readonly number[],
  horizon: number,
  absolute: boolean,
): readonly number[] {
  if (horizon < 1 || values.length <= horizon) return [];
  const out: number[] = [];
  for (let i = horizon; i < values.length; i += 1) {
    const from = values[i - horizon];
    const to = values[i];
    if (from === undefined || to === undefined) continue;
    if (absolute) {
      out.push(to - from);
    } else {
      if (from === 0) continue;
      out.push(((to - from) / Math.abs(from)) * 100);
    }
  }
  return out;
}

/** The most recent `horizon`-period change, matching `changeHistory`'s units. */
export function latestChange(
  view: MacroSeriesView | undefined,
  horizon: number,
  absolute: boolean,
): number | null {
  const to = latestValue(view);
  const from = laggedValue(view, horizon);
  if (to === null || from === null) return null;
  if (absolute) return to - from;
  if (from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

/** Year-on-year percentage change for a monthly series. */
export function yearOnYear(view: MacroSeriesView | undefined): number | null {
  return latestChange(view, 12, false);
}
