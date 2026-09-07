/**
 * Yahoo Finance market data (Tier 3) — a **futures proxy**, never spot.
 *
 * Verified 2026-08-30: `XAUUSD=X` does not exist ("symbol may be delisted"). Only
 * `GC=F` resolves, and it reports `instrumentType: "FUTURE"` on `fullExchangeName:
 * "COMEX"`. It quoted 4529.90 while Twelve Data's spot was 4458.79 — a ~71 basis.
 *
 * That gap is why every value from here is stamped `FUTURES_PROXY` and carried as
 * such all the way to the UI. Labelling COMEX futures as XAUUSD spot would be exactly
 * the quiet misrepresentation Amendment A2 exists to prevent — the number would look
 * right and be wrong by the cost of carry.
 *
 * Tier 3 also because this is an undocumented endpoint with no terms covering it: it
 * works, but it is a courtesy rather than a contract.
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

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

/**
 * Only gold has a usable proxy here.
 *
 * The FX pairs deliberately have no entry: `EURUSD=X` and friends do resolve on
 * Yahoo, but adding them would give V4 a silent Tier 3 fallback for assets whose
 * primary is a verified spot feed. An explicit `NOT_SUPPORTED` is better than a
 * quiet downgrade.
 */
const SYMBOL_MAP: Readonly<Partial<Record<AssetSymbol, string>>> = {
  XAUUSD: 'GC=F',
};

const INTERVAL_MAP: Readonly<Record<string, string>> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '1d': '1d',
  // Yahoo has no native 4h; V2 derives it by aggregation rather than substituting
  // a different interval and hoping nobody notices.
};

const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            symbol: z.string(),
            currency: z.string().optional(),
            instrumentType: z.string().optional(),
            fullExchangeName: z.string().optional(),
            regularMarketPrice: z.number().optional(),
            regularMarketTime: z.number().optional(),
          }),
          timestamp: z.array(z.number()).optional(),
          indicators: z
            .object({
              quote: z
                .array(
                  z.object({
                    open: z.array(z.number().nullable()).optional(),
                    high: z.array(z.number().nullable()).optional(),
                    low: z.array(z.number().nullable()).optional(),
                    close: z.array(z.number().nullable()).optional(),
                    volume: z.array(z.number().nullable()).optional(),
                  }),
                )
                .optional(),
            })
            .optional(),
        }),
      )
      .nullable(),
    error: z
      .object({ code: z.string(), description: z.string() })
      .nullable()
      .optional(),
  }),
});

export interface YahooOptions {
  readonly timeoutMs?: number;
  readonly thresholds: FreshnessThresholds;
  readonly baseUrl?: string;
}

export class YahooFinanceProvider implements MarketDataProvider {
  readonly id = 'yahoo-finance';
  readonly displayName = 'Yahoo Finance (COMEX futures proxy)';
  readonly domain = 'MARKET_DATA' as const;
  readonly tier = 3 as const;
  /** Undocumented. Self-imposed to stay a polite consumer. */
  readonly limits: RateLimitPolicy = { requestsPerMinute: 30, requestsPerDay: 2000 };

  private readonly timeoutMs: number;
  private readonly thresholds: FreshnessThresholds;
  private readonly baseUrl: string;

  constructor(options: YahooOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.thresholds = options.thresholds;
    this.baseUrl = options.baseUrl ?? BASE;
  }

  /** No key required. */
  isConfigured(): boolean {
    return true;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const r = await httpRequest({
        url: `${this.baseUrl}/GC=F?interval=1d&range=1d`,
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

  private async fetchChart(
    providerSymbol: string,
    params: Record<string, string>,
    now: Date,
  ): Promise<z.infer<typeof chartSchema>['chart']> {
    const u = new URL(`${this.baseUrl}/${providerSymbol}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

    const response = await httpRequest({ url: u.toString(), timeoutMs: this.timeoutMs }, now);
    if (!response.ok) {
      throw new HttpError(
        `HTTP_${String(response.status)}`,
        `Yahoo returned ${String(response.status)}`,
        response.status,
        response.durationMs,
      );
    }
    const parsed = chartSchema.safeParse(parseJson(response));
    if (!parsed.success) {
      throw new HttpError('INVALID_RESPONSE', 'Yahoo chart payload did not match', 200, response.durationMs);
    }
    return parsed.data.chart;
  }

  async getQuote(symbol: AssetSymbol, now: Date = new Date()): Promise<ProviderResult<Quote>> {
    const providerSymbol = SYMBOL_MAP[symbol];
    if (providerSymbol === undefined) return unavailable('NOT_SUPPORTED', []);

    const chart = await this.fetchChart(providerSymbol, { interval: '1d', range: '1d' }, now);
    const result = chart.result?.[0];
    if (result === undefined) return unavailable('NO_CACHED_VALUE', []);

    const price = result.meta.regularMarketPrice;
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      return unavailable('INVALID_RESPONSE', []);
    }

    const quotedAt =
      result.meta.regularMarketTime === undefined
        ? now
        : new Date(result.meta.regularMarketTime * 1000);

    const freshness = assessFreshness(liveTiming(quotedAt, now), this.thresholds, now);

    return ok(
      makeObservation(
        {
          symbol,
          price,
          // The whole point of this provider's existence being visible.
          instrumentKind: 'FUTURES_PROXY',
          providerSymbol,
          quotedAt,
        },
        {
          providerId: this.id,
          // Names the instrument in the provenance itself, so a reader hovering the
          // price sees "COMEX futures proxy" rather than an unqualified source.
          sourceName: `${this.displayName} — ${result.meta.fullExchangeName ?? 'COMEX'} ${providerSymbol}`,
          sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(providerSymbol)}`,
          sourceTier: this.tier,
          sourceTimestamp: quotedAt,
          retrievedAt: now,
        },
        freshness.status,
      ),
    );
  }

  async getCandles(
    request: CandleRequest,
    now: Date = new Date(),
  ): Promise<ProviderResult<Candle[]>> {
    const providerSymbol = SYMBOL_MAP[request.symbol];
    const interval = INTERVAL_MAP[request.timeframe];
    if (providerSymbol === undefined || interval === undefined) {
      return unavailable('NOT_SUPPORTED', []);
    }

    const chart = await this.fetchChart(
      providerSymbol,
      { interval, range: rangeFor(request.timeframe, request.limit) },
      now,
    );
    const result = chart.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const timestamps = result?.timestamp;
    if (result === undefined || quote === undefined || timestamps === undefined) {
      return unavailable('NO_CACHED_VALUE', []);
    }

    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const open = quote.open?.[i];
      const high = quote.high?.[i];
      const low = quote.low?.[i];
      const close = quote.close?.[i];
      const ts = timestamps[i];
      // Yahoo pads its arrays with nulls for non-trading intervals. Those are gaps,
      // not zeros, and must be skipped rather than filled.
      if (
        ts === undefined ||
        open == null ||
        high == null ||
        low == null ||
        close == null
      ) {
        continue;
      }
      if (high < low || high < open || high < close || low > open || low > close) continue;

      candles.push({
        symbol: request.symbol,
        timeframe: request.timeframe,
        openTime: new Date(ts * 1000),
        open,
        high,
        low,
        close,
        volume: quote.volume?.[i] ?? null,
        instrumentKind: 'FUTURES_PROXY',
      });
    }

    if (candles.length === 0) return unavailable('NO_CACHED_VALUE', []);

    const newest = candles[candles.length - 1]?.openTime ?? now;
    const freshness = assessFreshness(liveTiming(newest, now), this.thresholds, now);

    return ok(
      makeObservation(
        candles.slice(-request.limit),
        {
          providerId: this.id,
          sourceName: `${this.displayName} — ${result.meta.fullExchangeName ?? 'COMEX'} ${providerSymbol}`,
          sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(providerSymbol)}`,
          sourceTier: this.tier,
          sourceTimestamp: newest,
          retrievedAt: now,
        },
        freshness.status,
      ),
    );
  }
}

/** Yahoo takes a range rather than a count; pick the smallest that covers it. */
function rangeFor(timeframe: string, limit: number): string {
  const perDay: Record<string, number> = { '1m': 1440, '5m': 288, '15m': 96, '1h': 24, '1d': 1 };
  const days = Math.ceil(limit / (perDay[timeframe] ?? 1));
  if (days <= 1) return '1d';
  if (days <= 5) return '5d';
  if (days <= 30) return '1mo';
  if (days <= 90) return '3mo';
  if (days <= 180) return '6mo';
  if (days <= 365) return '1y';
  return '2y';
}
