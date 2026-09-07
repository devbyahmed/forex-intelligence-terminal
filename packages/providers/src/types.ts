/**
 * Provider contracts (master PRD §9, ARCHITECTURE §5).
 *
 * Every domain has an interface here and one or more implementations behind it. The
 * registry never knows which provider answered — it only knows a `ProviderResult`
 * came back, which is what makes the fallback chain and the STALE/UNAVAILABLE states
 * uniform across market data, news, calendars and macro series.
 */

import type {
  AssetSymbol,
  MacroSeriesId,
  Observation,
  PublicationDays,
  ProviderResult,
  SourceTier,
  Timeframe,
} from '@forex-agent/core';

export const PROVIDER_DOMAINS = [
  'MARKET_DATA',
  'NEWS',
  'ECONOMIC_CALENDAR',
  'MACRO',
] as const;
export type ProviderDomain = (typeof PROVIDER_DOMAINS)[number];

/**
 * Documented free-tier limits, declared in code so the token bucket can enforce them
 * locally. Hitting a published limit by accident is avoidable; being rate-limited by
 * the vendor costs us the data and, on a chain with one member, the whole domain.
 */
export interface RateLimitPolicy {
  readonly requestsPerMinute?: number;
  /** Some vendors meter "credits" rather than requests; one call may cost several. */
  readonly requestsPerDay?: number;
  readonly creditsPerDay?: number;
  readonly creditsPerRequest?: number;
}

export interface ProviderHealth {
  readonly providerId: string;
  readonly reachable: boolean;
  readonly checkedAt: Date;
  readonly detail?: string;
}

export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly domain: ProviderDomain;
  readonly tier: SourceTier;
  readonly limits: RateLimitPolicy;
  /** False when the provider needs a key that is not configured. */
  isConfigured(): boolean;
  /** A cheap liveness probe. Never counts against a meaningful quota. */
  health(): Promise<ProviderHealth>;
}

// ── Market data ─────────────────────────────────────────────────────────────

/**
 * What kind of instrument a price actually is.
 *
 * Not cosmetic: the only free source that resolves for gold is COMEX futures, which
 * is not spot XAUUSD. Labelling it as spot would be exactly the quiet
 * misrepresentation Amendment A2 exists to prevent, so the distinction travels with
 * the value and reaches the UI.
 */
export const INSTRUMENT_KINDS = ['SPOT', 'FUTURES_PROXY', 'FIXING'] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

export interface Quote {
  readonly symbol: AssetSymbol;
  readonly price: number;
  readonly instrumentKind: InstrumentKind;
  readonly providerSymbol: string;
  readonly quotedAt: Date;
}

export interface Candle {
  readonly symbol: AssetSymbol;
  readonly timeframe: Timeframe;
  readonly openTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number | null;
  readonly instrumentKind: InstrumentKind;
}

export interface CandleRequest {
  readonly symbol: AssetSymbol;
  readonly timeframe: Timeframe;
  readonly limit: number;
}

export interface MarketDataProvider extends Provider {
  readonly domain: 'MARKET_DATA';
  getQuote(symbol: AssetSymbol): Promise<ProviderResult<Quote>>;
  getCandles(request: CandleRequest): Promise<ProviderResult<Candle[]>>;
}

// ── Macro ───────────────────────────────────────────────────────────────────

export interface MacroPoint {
  readonly seriesId: MacroSeriesId;
  /** The date the observation describes, ISO `YYYY-MM-DD`. */
  readonly observationDate: string;
  /** Null is meaningful: the series exists but has no value for that period. */
  readonly value: number | null;
  /** Publication vintage; a later vintage supersedes an earlier one. */
  readonly vintage: Date;
}

export interface MacroSeriesRequest {
  readonly seriesId: MacroSeriesId;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
  /**
   * The weekdays this series publishes on, from `macro_series`.
   *
   * **Required, deliberately.** Freshness for a macro series is counted in
   * publication days, and a caller that forgot to supply the calendar would silently
   * fall back to wall-clock age — reintroducing the weekend distortion for that one
   * series while every other series looked fine. That is the exact shape of the
   * `cadence` bug, and an optional field is how it happened.
   */
  readonly publicationDays: PublicationDays;
}

export interface MacroDataProvider extends Provider {
  readonly domain: 'MACRO';
  getSeries(request: MacroSeriesRequest): Promise<ProviderResult<MacroPoint[]>>;
  getLatest(
    seriesId: MacroSeriesId,
    publicationDays: PublicationDays,
  ): Promise<ProviderResult<MacroPoint>>;
}

// ── Economic calendar ───────────────────────────────────────────────────────

export interface RawEconomicRelease {
  readonly country: string;
  readonly currency: string;
  readonly eventName: string;
  readonly scheduledAt: Date;
  readonly scheduledLocalTime: string | null;
  readonly previous: number | null;
  readonly forecast: number | null;
  readonly actual: number | null;
  /** As published, so a value is never silently rescaled. */
  readonly unit: string | null;
  /** The feed's own rating, which curated rules may override. */
  readonly importanceHint: 'HIGH' | 'MEDIUM' | 'LOW' | null;
}

export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Split deliberately: no free source provides both authoritative actuals and a
 * consensus forecast. FRED is Tier 1 for dates and actuals but publishes no
 * forecast; a Tier 3 feed supplies consensus. Keeping them separate methods keeps
 * them separately provenanced all the way to the UI.
 */
export interface EconomicCalendarProvider extends Provider {
  readonly domain: 'ECONOMIC_CALENDAR';
  /** Scheduled releases with whatever values the source has. */
  getReleases(range: DateRange): Promise<ProviderResult<RawEconomicRelease[]>>;
  /** True when this provider's figures are authoritative rather than consensus. */
  readonly providesActuals: boolean;
  readonly providesForecasts: boolean;
}

// ── News ────────────────────────────────────────────────────────────────────

export interface RawArticle {
  readonly title: string;
  readonly url: string;
  readonly summary: string | null;
  readonly publishedAt: Date;
  readonly sourceName: string;
  readonly sourceTier: SourceTier;
}

export interface NewsCursor {
  /** Only fetch items published after this. */
  readonly since: Date;
  /** Conditional-GET state, so an unchanged feed costs a 304 rather than a body. */
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

export interface NewsFetchResult {
  readonly articles: readonly RawArticle[];
  /** Returned so the caller can store it for the next conditional request. */
  readonly etag: string | null;
  readonly lastModified: string | null;
  /** True when the server answered 304 and there was nothing to parse. */
  readonly notModified: boolean;
}

export interface NewsProvider extends Provider {
  readonly domain: 'NEWS';
  fetchSince(cursor: NewsCursor): Promise<ProviderResult<NewsFetchResult>>;
}

// ── Registry ────────────────────────────────────────────────────────────────

export interface ResolveOptions {
  /** Cache key. Omit to bypass the cache entirely. */
  readonly cacheKey?: string;
  readonly ttlMs?: number;
  /** How old a cached value may be before `STALE` becomes `UNAVAILABLE`. */
  readonly acceptStaleUpToMs?: number;
  readonly now: Date;
}

export type ProviderCall<P extends Provider, T> = (provider: P) => Promise<ProviderResult<T>>;

export type { Observation, ProviderResult };
