/**
 * Twelve Data market data (Tier 2) — the verified spot primary.
 *
 * Verified 2026-08-30 on the registered Basic plan: `XAU/USD` returns
 * `{"price":"4458.78588"}` and `/quote` names it "Gold Spot / US Dollar". It is
 * **genuine spot**, not futures — Yahoo's `GC=F` quoted 4529.90 in the same window,
 * the ~71 difference being the futures basis.
 *
 * Credit economics, measured against `/api_usage`: **1 credit per symbol per call,
 * independent of how many bars come back**. `outputsize=500` costs the same as one
 * bar, which is the fact V2's candle strategy is built on (LIMITS.md §6.4).
 */

import { z } from 'zod';
import {
  assessFreshness,
  liveTiming,
  makeObservation,
  ok,
  unavailable,
  type AssetSymbol,
  type FreshnessThresholds,
  type ProviderResult,
} from '@forex-agent/core';
import { httpRequest, parseJson, HttpError } from '../http.js';
import type {
  Candle,
  CandleRequest,
  MarketDataProvider,
  ProviderHealth,
  Quote,
  RateLimitPolicy,
} from '../types.js';

const BASE = 'https://api.twelvedata.com';

/** Our symbols to theirs. `XAU/USD` is a commodity pair in their catalogue. */
const SYMBOL_MAP: Readonly<Partial<Record<AssetSymbol, string>>> = {
  XAUUSD: 'XAU/USD',
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  USDCHF: 'USD/CHF',
  AUDUSD: 'AUD/USD',
  NZDUSD: 'NZD/USD',
  USDCAD: 'USD/CAD',
};

const INTERVAL_MAP: Readonly<Record<string, string>> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
};

const priceSchema = z.object({ price: z.string() });

const quoteSchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  close: z.string(),
  datetime: z.string().optional(),
  timestamp: z.number().optional(),
  last_quote_at: z.number().optional(),
  is_market_open: z.boolean().optional(),
});

const timeSeriesSchema = z.object({
  values: z.array(
    z.object({
      datetime: z.string(),
      open: z.string(),
      high: z.string(),
      low: z.string(),
      close: z.string(),
      volume: z.string().optional(),
    }),
  ),
});

/** Their error shape is a 200 with a `status: "error"` body — easy to miss. */
const errorSchema = z.object({ code: z.number(), message: z.string(), status: z.literal('error') });

export interface TwelveDataOptions {
  readonly apiKey: string | undefined;
  readonly timeoutMs?: number;
  readonly thresholds: FreshnessThresholds;
  readonly baseUrl?: string;
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = 'twelvedata';
  readonly displayName = 'Twelve Data';
  readonly domain = 'MARKET_DATA' as const;
  readonly tier = 2 as const;
  /** Basic plan, verified: 8/min, 800 credits/day, 1 credit per symbol per call. */
  readonly limits: RateLimitPolicy = {
    requestsPerMinute: 8,
    creditsPerDay: 800,
    creditsPerRequest: 1,
  };

  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly thresholds: FreshnessThresholds;
  private readonly baseUrl: string;

  constructor(options: TwelveDataOptions) {
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
        detail: 'TWELVEDATA_API_KEY not configured',
      };
    }
    try {
      const r = await httpRequest({ url: this.url('api_usage', {}), timeoutMs: this.timeoutMs });
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
    if (this.apiKey !== undefined) u.searchParams.set('apikey', this.apiKey);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  /**
   * Fetch and unwrap, treating their in-body error as an error.
   *
   * A 429 arrives as HTTP 429, but a plan or symbol problem arrives as **HTTP 200
   * with `status: "error"`**. Trusting the status code alone would store an error
   * object as though it were a price.
   */
  private async fetchJson(url: string, now: Date): Promise<unknown> {
    const response = await httpRequest({ url, timeoutMs: this.timeoutMs }, now);
    const body = parseJson(response);

    const asError = errorSchema.safeParse(body);
    if (asError.success) {
      throw new HttpError(
        `TWELVEDATA_${String(asError.data.code)}`,
        asError.data.message.slice(0, 200),
        asError.data.code,
        response.durationMs,
      );
    }
    if (!response.ok) {
      throw new HttpError(
        `HTTP_${String(response.status)}`,
        `Twelve Data returned ${String(response.status)}`,
        response.status,
        response.durationMs,
      );
    }
    return body;
  }

  async getQuote(
    symbol: AssetSymbol,
    now: Date = new Date(),
  ): Promise<ProviderResult<Quote>> {
    if (!this.isConfigured()) return unavailable('NOT_CONFIGURED', []);
    const providerSymbol = SYMBOL_MAP[symbol];
    if (providerSymbol === undefined) return unavailable('NOT_SUPPORTED', []);

    const body = await this.fetchJson(this.url('quote', { symbol: providerSymbol }), now);
    const parsed = quoteSchema.safeParse(body);

    if (!parsed.success) {
      // Fall back to the cheaper /price endpoint, which returns only a number.
      const priceBody = await this.fetchJson(this.url('price', { symbol: providerSymbol }), now);
      const price = priceSchema.safeParse(priceBody);
      if (!price.success) return unavailable('INVALID_RESPONSE', []);
      const value = Number.parseFloat(price.data.price);
      if (!Number.isFinite(value) || value <= 0) return unavailable('INVALID_RESPONSE', []);
      return this.buildQuote(symbol, providerSymbol, value, now, now);
    }

    const value = Number.parseFloat(parsed.data.close);
    if (!Number.isFinite(value) || value <= 0) return unavailable('INVALID_RESPONSE', []);

    // `last_quote_at` is the tick time; `timestamp` is the bar time. Prefer the tick,
    // because freshness should reflect when the price was true.
    const quotedAt =
      parsed.data.last_quote_at !== undefined
        ? new Date(parsed.data.last_quote_at * 1000)
        : parsed.data.timestamp !== undefined
          ? new Date(parsed.data.timestamp * 1000)
          : now;

    return this.buildQuote(symbol, providerSymbol, value, quotedAt, now);
  }

  private buildQuote(
    symbol: AssetSymbol,
    providerSymbol: string,
    price: number,
    quotedAt: Date,
    now: Date,
  ): ProviderResult<Quote> {
    const freshness = assessFreshness(liveTiming(quotedAt, now), this.thresholds, now);
    return ok(
      makeObservation(
        {
          symbol,
          price,
          // Verified spot, and labelled as such — the distinction that keeps a
          // futures proxy from being presented as spot.
          instrumentKind: 'SPOT',
          providerSymbol,
          quotedAt,
        },
        {
          providerId: this.id,
          sourceName: this.displayName,
          sourceUrl: `https://twelvedata.com/markets/${providerSymbol.replace('/', '-').toLowerCase()}`,
          sourceTier: this.tier,
          sourceTimestamp: quotedAt,
          retrievedAt: now,
        },
        freshness.status,
      ),
    );
  }

  /**
   * OHLCV. Implemented now, used from V2.
   *
   * `outputsize` is free — 500 bars cost the same single credit as one — which is
   * why V2 fetches the lowest timeframe and aggregates upward rather than making a
   * call per timeframe (LIMITS.md §6.4).
   */
  async getCandles(
    request: CandleRequest,
    now: Date = new Date(),
  ): Promise<ProviderResult<Candle[]>> {
    if (!this.isConfigured()) return unavailable('NOT_CONFIGURED', []);
    const providerSymbol = SYMBOL_MAP[request.symbol];
    const interval = INTERVAL_MAP[request.timeframe];
    if (providerSymbol === undefined || interval === undefined) {
      return unavailable('NOT_SUPPORTED', []);
    }

    const body = await this.fetchJson(
      this.url('time_series', {
        symbol: providerSymbol,
        interval,
        outputsize: String(Math.min(request.limit, 5000)),
        order: 'asc',
      }),
      now,
    );

    const parsed = timeSeriesSchema.safeParse(body);
    if (!parsed.success) return unavailable('INVALID_RESPONSE', []);

    const candles: Candle[] = [];
    for (const v of parsed.data.values) {
      const open = Number.parseFloat(v.open);
      const high = Number.parseFloat(v.high);
      const low = Number.parseFloat(v.low);
      const close = Number.parseFloat(v.close);
      if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) continue;
      // The schema rejects incoherent bars anyway; dropping here keeps them out of
      // the technical engine rather than relying on a constraint violation.
      if (high < low || high < open || high < close || low > open || low > close) continue;

      const openTime = parseTwelveDataTime(v.datetime);
      if (openTime === null) continue;

      candles.push({
        symbol: request.symbol,
        timeframe: request.timeframe,
        openTime,
        open,
        high,
        low,
        close,
        volume: v.volume === undefined ? null : Number.parseFloat(v.volume),
        instrumentKind: 'SPOT',
      });
    }

    if (candles.length === 0) return unavailable('NO_CACHED_VALUE', []);

    const newest = candles[candles.length - 1]?.openTime ?? now;
    const freshness = assessFreshness(liveTiming(newest, now), this.thresholds, now);

    return ok(
      makeObservation(
        candles,
        {
          providerId: this.id,
          sourceName: this.displayName,
          sourceUrl: `https://twelvedata.com/markets/${providerSymbol.replace('/', '-').toLowerCase()}`,
          sourceTier: this.tier,
          sourceTimestamp: newest,
          retrievedAt: now,
        },
        freshness.status,
      ),
    );
  }
}

/**
 * Their datetime is `YYYY-MM-DD` for daily bars and `YYYY-MM-DD HH:mm:ss` for
 * intraday, **with no timezone marker on either**.
 *
 * Their exchange metadata reports a venue timezone, but the series itself is quoted
 * in UTC for FX and metals. Appending `Z` states that assumption explicitly rather
 * than letting `Date.parse` fall back to the server's local zone — which would be UTC
 * on Vercel and something else on a developer's laptop, so the same data would land
 * at different instants in different environments.
 */
export function parseTwelveDataTime(raw: string): Date | null {
  const trimmed = raw.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00Z`
    : `${trimmed.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}
