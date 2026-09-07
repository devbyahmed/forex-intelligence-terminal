/**
 * Spot-price ingestion (master PRD §11, §52).
 *
 * Twelve Data verified spot, falling back to a Yahoo COMEX futures proxy. The
 * fallback is a **downgrade that is recorded, not hidden**: the stored row says
 * `FUTURES_PROXY`, keeps Yahoo's Tier 3 provenance, and the UI renders the
 * distinction. A ~71-point basis between the two is not rounding error.
 *
 * **No V1 fundamental factor consumes price data** — F1–F8 are FRED series plus news
 * — so a total market-data outage degrades the displayed price to `UNAVAILABLE`
 * while the score still computes. That is why an unverified provider was never a V1
 * blocker (LIMITS.md §6.6).
 */

import { desc, eq, sql } from 'drizzle-orm';
import {
  assessFreshness,
  liveTiming,
  type AssetSymbol,
  type FreshnessThresholds,
  type QualityFlag,
} from '@forex-agent/core';
import type { Database } from '@forex-agent/db';
import { assets, marketQuotes } from '@forex-agent/db';
import type { MarketDataProvider, Quote } from '@forex-agent/providers';
import type { JobContext, JobOutcome } from '../runner.js';

export interface MarketIngestDeps {
  /** Ordered by authority: verified spot first, labelled proxy second. */
  readonly chain: readonly MarketDataProvider[];
  readonly thresholds: FreshnessThresholds;
  /** Reject a quote this far from the previous one. */
  readonly maxMovePercent?: number;
}

export interface QuoteIngestOutcome {
  readonly symbol: string;
  readonly status: 'OK' | 'UNAVAILABLE' | 'QUARANTINED';
  readonly providerId: string | null;
  readonly instrumentKind: string | null;
  readonly price: number | null;
  readonly usedFallback: boolean;
  readonly flags: readonly QualityFlag[];
}

/**
 * Is the gold market open?
 *
 * Roughly Sunday 22:00 UTC to Friday 22:00 UTC. Outside it the last price is hours
 * old and re-polling only burns provider credits, so the job skips rather than
 * storing a weekend-stale quote every tick.
 */
export function isGoldMarketOpen(now: Date): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false; // Saturday
  if (day === 0) return hour >= 22; // Sunday, opens 22:00 UTC
  if (day === 5) return hour < 22; // Friday, closes 22:00 UTC
  return true;
}

export function ingestMarketJob(deps: MarketIngestDeps) {
  return async (ctx: JobContext): Promise<JobOutcome> => {
    const active = await ctx.db
      .select({ id: assets.id, symbol: assets.symbol })
      .from(assets)
      .where(eq(assets.isActive, true));

    const outcomes: QuoteIngestOutcome[] = [];

    for (const asset of active) {
      outcomes.push(
        await ingestQuote(ctx.db, {
          assetId: asset.id,
          symbol: asset.symbol as AssetSymbol,
          now: ctx.now,
          deps,
        }),
      );
    }

    const stored = outcomes.filter((o) => o.status === 'OK').length;
    const fallbacks = outcomes.filter((o) => o.usedFallback);
    const quarantined = outcomes.filter((o) => o.status === 'QUARANTINED');
    const unavailable = outcomes.filter((o) => o.status === 'UNAVAILABLE');

    const detail = [
      `${String(stored)} quote(s) stored`,
      fallbacks.length > 0
        ? `DEGRADED: ${fallbacks.map((f) => `${f.symbol} on ${f.providerId ?? '?'} (${f.instrumentKind ?? '?'})`).join(', ')}`
        : null,
      quarantined.length > 0 ? `${String(quarantined.length)} quarantined` : null,
      unavailable.length > 0 ? `UNAVAILABLE: ${unavailable.map((u) => u.symbol).join(', ')}` : null,
    ]
      .filter((s) => s !== null)
      .join('; ');

    return { itemsProcessed: stored, detail };
  };
}

async function ingestQuote(
  db: Database,
  params: {
    assetId: string;
    symbol: AssetSymbol;
    now: Date;
    deps: MarketIngestDeps;
  },
): Promise<QuoteIngestOutcome> {
  const base = {
    symbol: params.symbol,
    providerId: null,
    instrumentKind: null,
    price: null,
    usedFallback: false,
    flags: [] as QualityFlag[],
  };

  let resolved: {
    quote: Quote;
    providerId: string;
    sourceName: string;
    sourceUrl: string | null;
    tier: 1 | 2 | 3 | 4;
    isFallback: boolean;
  } | null = null;

  for (const [index, provider] of params.deps.chain.entries()) {
    if (!provider.isConfigured()) continue;
    try {
      const result = await provider.getQuote(params.symbol);
      if (result.status === 'UNAVAILABLE') continue;
      resolved = {
        quote: result.observation.value,
        providerId: result.observation.provenance.providerId,
        sourceName: result.observation.provenance.sourceName,
        sourceUrl: result.observation.provenance.sourceUrl,
        tier: result.observation.provenance.sourceTier,
        // Anything past the first member is a downgrade, and is recorded as one.
        isFallback: index > 0,
      };
      break;
    } catch {
      // Try the next provider. The registry records the failure and the breaker
      // state; here we only care whether anything answered.
      continue;
    }
  }

  if (resolved === null) return { ...base, status: 'UNAVAILABLE' };

  const flags = await validateQuote(db, {
    assetId: params.assetId,
    price: resolved.quote.price,
    instrumentKind: resolved.quote.instrumentKind,
    maxMovePercent: params.deps.maxMovePercent ?? 20,
  });

  const freshness = assessFreshness(
    liveTiming(resolved.quote.quotedAt, params.now),
    params.deps.thresholds,
    params.now,
  );

  await db.insert(marketQuotes).values({
    assetId: params.assetId,
    price: String(resolved.quote.price),
    // Carried to the UI. A futures proxy must never render as spot.
    instrumentKind: resolved.quote.instrumentKind,
    providerSymbol: resolved.quote.providerSymbol,
    sourceProvider: resolved.providerId,
    sourceName: resolved.sourceName,
    sourceUrl: resolved.sourceUrl,
    sourceTier: resolved.tier,
    sourceTimestamp: resolved.quote.quotedAt,
    retrievedAt: params.now,
    freshness: freshness.status,
    qualityFlags: [...flags],
  });

  return {
    symbol: params.symbol,
    // Stored either way — a flagged value stays visible and auditable — but
    // quarantined ones are excluded from anything that reads a current price.
    status: flags.includes('IMPOSSIBLE_VALUE') || flags.includes('ANOMALY') ? 'QUARANTINED' : 'OK',
    providerId: resolved.providerId,
    instrumentKind: resolved.quote.instrumentKind,
    price: resolved.quote.price,
    usedFallback: resolved.isFallback,
    flags,
  };
}

/**
 * Validate a quote against the previous one (master PRD §52).
 *
 * The comparison is deliberately **restricted to the same instrument kind**. Spot and
 * a futures proxy differ by the cost of carry — about 71 points on gold — so
 * comparing across them would flag every fallback as a 1.6% anomaly and every
 * recovery as another.
 */
async function validateQuote(
  db: Database,
  params: {
    assetId: string;
    price: number;
    instrumentKind: string;
    maxMovePercent: number;
  },
): Promise<QualityFlag[]> {
  const flags: QualityFlag[] = [];

  if (!Number.isFinite(params.price) || params.price <= 0) {
    flags.push('IMPOSSIBLE_VALUE');
    return flags;
  }

  const [previous] = await db
    .select({ price: marketQuotes.price })
    .from(marketQuotes)
    .where(
      sql`${marketQuotes.assetId} = ${params.assetId}
          AND ${marketQuotes.instrumentKind} = ${params.instrumentKind}
          AND NOT ('IMPOSSIBLE_VALUE' = ANY(${marketQuotes.qualityFlags}))`,
    )
    .orderBy(desc(marketQuotes.sourceTimestamp))
    .limit(1);

  if (previous !== undefined) {
    const prior = Number.parseFloat(previous.price);
    if (Number.isFinite(prior) && prior > 0) {
      const movePercent = Math.abs((params.price - prior) / prior) * 100;
      if (movePercent > params.maxMovePercent) flags.push('ANOMALY');
    }
  }

  return flags;
}

/**
 * The current price for display, with everything the UI needs to qualify it.
 *
 * Returns null rather than a substitute when nothing usable exists — the header shows
 * `UNAVAILABLE`, which is the honest state and does not affect the score.
 */
export async function latestQuote(
  db: Database,
  symbol: AssetSymbol,
): Promise<{
  price: number;
  instrumentKind: string;
  sourceName: string;
  sourceUrl: string | null;
  sourceTier: number;
  quotedAt: Date;
  freshness: string;
  isProxy: boolean;
} | null> {
  const [row] = await db
    .select({
      price: marketQuotes.price,
      instrumentKind: marketQuotes.instrumentKind,
      sourceName: marketQuotes.sourceName,
      sourceUrl: marketQuotes.sourceUrl,
      sourceTier: marketQuotes.sourceTier,
      quotedAt: marketQuotes.sourceTimestamp,
      freshness: marketQuotes.freshness,
    })
    .from(marketQuotes)
    .innerJoin(assets, eq(assets.id, marketQuotes.assetId))
    .where(
      sql`${assets.symbol} = ${symbol}
          AND NOT ('IMPOSSIBLE_VALUE' = ANY(${marketQuotes.qualityFlags}))
          AND NOT ('ANOMALY' = ANY(${marketQuotes.qualityFlags}))`,
    )
    .orderBy(desc(marketQuotes.sourceTimestamp))
    .limit(1);

  if (row === undefined) return null;

  return {
    price: Number.parseFloat(row.price),
    instrumentKind: row.instrumentKind,
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    sourceTier: row.sourceTier,
    quotedAt: row.quotedAt,
    freshness: row.freshness,
    // Drives the UI label. A proxy price is a real price of a different instrument.
    isProxy: row.instrumentKind !== 'SPOT',
  };
}
