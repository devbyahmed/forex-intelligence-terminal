/**
 * News ingestion (master PRD §8).
 *
 * Fetches the seeded feeds with conditional GET, parses CDATA-safely, deduplicates
 * within and across feeds, classifies and scores deterministically, and stores each
 * article with full provenance.
 *
 * Two failure modes are made loud rather than quiet, because both previously looked
 * like success:
 *
 *  - A feed returning 200 that parses to zero items (the CDATA bug).
 *  - A classification ruleset that matches nothing (the importance-rules bug).
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import {
  assessFreshness,
  measureCoverage,
  type FreshnessThresholds,
  type SourceTier,
} from '@forex-agent/core';
import type { Database } from '@forex-agent/db';
import { assets, newsArticleAssets, newsArticles, newsSentiment, newsSources } from '@forex-agent/db';
import {
  assertParseYield,
  httpRequest,
  parseFeed,
  FeedParseError,
  HttpError,
} from '@forex-agent/providers';
import {
  CLASSIFIER_VERSION,
  assessGoldRelevance,
  canonicaliseUrl,
  classifyArticle,
  scoreSentiment,
  titleSimilarity,
} from '@forex-agent/engines';
import type { JobContext, JobOutcome } from '../runner.js';

export interface NewsIngestDeps {
  readonly thresholds: FreshnessThresholds;
  readonly duplicateTitleThreshold: number;
  /** Only articles published within this window are ingested. */
  readonly lookBackMs?: number;
  readonly timeoutMs?: number;
}

interface FeedRow {
  id: string;
  name: string;
  feedUrl: string;
  tier: number;
  lastEtag: string | null;
  lastModified: string | null;
}

export interface FeedIngestOutcome {
  readonly feedName: string;
  readonly status: 'OK' | 'NOT_MODIFIED' | 'FAILED';
  readonly itemsSeen: number;
  readonly itemsParsed: number;
  readonly stored: number;
  readonly relevant: number;
  readonly error?: string;
}

/**
 * Content hash over normalised title and summary.
 *
 * Catches the same story republished at a different URL, which URL canonicalisation
 * alone cannot see.
 */
async function contentHash(title: string, summary: string | null): Promise<string> {
  const { createHash } = await import('node:crypto');
  const normalised = `${title} ${summary ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

export function ingestNewsJob(deps: NewsIngestDeps) {
  return async (ctx: JobContext): Promise<JobOutcome> => {
    const lookBackMs = deps.lookBackMs ?? 3 * 86_400_000;
    const windowStart = new Date(ctx.now.getTime() - lookBackMs);

    const feeds = await ctx.db
      .select({
        id: newsSources.id,
        name: newsSources.name,
        feedUrl: newsSources.feedUrl,
        tier: newsSources.tier,
        lastEtag: newsSources.lastEtag,
        lastModified: newsSources.lastModified,
      })
      .from(newsSources)
      .where(eq(newsSources.isActive, true));

    const [gold] = await ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.symbol, 'XAUUSD'))
      .limit(1);

    const outcomes: FeedIngestOutcome[] = [];
    let totalStored = 0;
    let totalRelevant = 0;

    for (const feed of feeds) {
      const outcome = await ingestOneFeed(ctx.db, feed, {
        windowStart,
        now: ctx.now,
        goldAssetId: gold?.id ?? null,
        deps,
      });
      outcomes.push(outcome);
      totalStored += outcome.stored;
      totalRelevant += outcome.relevant;
    }

    /**
     * A feed answering 200 and yielding nothing is a bug, not a quiet day.
     *
     * Reported rather than thrown so one broken feed does not stop the rest, but it
     * reaches the job ledger and the system status panel instead of vanishing.
     */
    const yieldCoverage = measureCoverage({
      name: 'news feeds producing parseable items',
      candidates: outcomes.filter((o) => o.status === 'OK'),
      matched: (o) => o.itemsParsed > 0,
      describe: (o) => `${o.feedName} (${String(o.itemsSeen)} seen, 0 parsed)`,
      expectation: { minMatchRate: 0.8, allowEmptyInput: true },
    });

    const failed = outcomes.filter((o) => o.status === 'FAILED');
    const detail = [
      `${String(totalStored)} stored, ${String(totalRelevant)} gold-relevant`,
      `${String(outcomes.filter((o) => o.status === 'NOT_MODIFIED').length)} unchanged (304)`,
      failed.length > 0 ? `${String(failed.length)} FAILED: ${failed.map((f) => f.feedName).join(', ')}` : null,
      yieldCoverage.healthy ? null : `WARNING: ${yieldCoverage.reason ?? 'feeds parsed nothing'}`,
    ]
      .filter((s) => s !== null)
      .join('; ');

    return { itemsProcessed: totalStored, detail };
  };
}

async function ingestOneFeed(
  db: Database,
  feed: FeedRow,
  params: {
    windowStart: Date;
    now: Date;
    goldAssetId: string | null;
    deps: NewsIngestDeps;
  },
): Promise<FeedIngestOutcome> {
  const base = { feedName: feed.name, itemsSeen: 0, itemsParsed: 0, stored: 0, relevant: 0 };

  let body: string;
  let etag: string | null;
  let lastModified: string | null;

  try {
    const response = await httpRequest(
      {
        url: feed.feedUrl,
        timeoutMs: params.deps.timeoutMs ?? 20_000,
        // Conditional GET: an unchanged feed costs a 304 rather than a full body.
        etag: feed.lastEtag,
        lastModified: feed.lastModified,
      },
      params.now,
    );

    if (response.notModified) {
      return { ...base, status: 'NOT_MODIFIED' };
    }
    if (!response.ok) {
      return {
        ...base,
        status: 'FAILED',
        error: `HTTP ${String(response.status)}`,
      };
    }
    body = response.body;
    etag = response.etag;
    lastModified = response.lastModified;
  } catch (e) {
    return {
      ...base,
      status: 'FAILED',
      error: e instanceof HttpError ? e.code : 'NETWORK_ERROR',
    };
  }

  let parsed;
  try {
    parsed = parseFeed(body);
    // Throws when a 200 yields nothing usable — the CDATA failure class.
    assertParseYield(feed.name, parsed);
  } catch (e) {
    return {
      ...base,
      status: 'FAILED',
      error: e instanceof FeedParseError ? e.message.slice(0, 200) : 'PARSE_ERROR',
    };
  }

  // Persist conditional-GET state so the next run can be a 304.
  await db
    .update(newsSources)
    .set({ lastEtag: etag, lastModified })
    .where(eq(newsSources.id, feed.id));

  const inWindow = parsed.items.filter((i) => i.publishedAt >= params.windowStart);
  let stored = 0;
  let relevant = 0;

  // Titles already accepted in this run, for near-duplicate detection within the feed.
  const acceptedTitles: string[] = [];

  for (const item of inWindow) {
    const canonicalUrl = canonicaliseUrl(item.link);
    const hash = await contentHash(item.title, item.summary);

    // Near-duplicate against what this run already took.
    if (
      acceptedTitles.some(
        (t) => titleSimilarity(t, item.title) >= params.deps.duplicateTitleThreshold,
      )
    ) {
      continue;
    }

    const relevance = assessGoldRelevance(item.title, item.summary);
    const category = classifyArticle(item.title, item.summary);

    /**
     * Freshness measures publication age, and the article carries no separate
     * observation period — `publishedTiming` would be wrong here, since a news
     * article *is* its publication.
     */
    const freshness = assessFreshness(
      { knownAt: item.publishedAt, retrievedAt: params.now },
      params.deps.thresholds,
      params.now,
    );

    const [row] = await db
      .insert(newsArticles)
      .values({
        canonicalUrl,
        contentHash: hash,
        title: item.title.slice(0, 500),
        // Truncated deliberately: full bodies roughly triple news storage against a
        // 0.5 GB cap, and the canonical URL preserves access to the full text.
        summary: item.summary?.slice(0, 600) ?? null,
        publishedAt: item.publishedAt,
        category,
        classifierVersion: CLASSIFIER_VERSION,
        sourceProvider: 'rss',
        sourceName: feed.name,
        sourceUrl: item.link,
        sourceTier: feed.tier,
        sourceTimestamp: item.publishedAt,
        retrievedAt: params.now,
        freshness: freshness.status,
      })
      .onConflictDoNothing({ target: newsArticles.canonicalUrl })
      .returning({ id: newsArticles.id });

    if (row === undefined) continue; // already stored on a previous run

    acceptedTitles.push(item.title);
    stored += 1;

    const sentiment = scoreSentiment(item.title, item.summary);
    await db
      .insert(newsSentiment)
      .values({
        articleId: row.id,
        polarity: sentiment.polarity,
        positiveCount: sentiment.positiveCount,
        negativeCount: sentiment.negativeCount,
        // Retained so a score can be inspected rather than trusted.
        matchedTerms: [...sentiment.matchedTerms],
        methodVersion: sentiment.methodVersion,
      })
      .onConflictDoNothing({ target: [newsSentiment.articleId, newsSentiment.methodVersion] });

    if (relevance.relevant && params.goldAssetId !== null) {
      relevant += 1;
      await db
        .insert(newsArticleAssets)
        .values({ articleId: row.id, assetId: params.goldAssetId, currency: 'XAU' })
        .onConflictDoNothing();
    }
  }

  return {
    feedName: feed.name,
    status: 'OK',
    itemsSeen: parsed.itemsSeen,
    itemsParsed: parsed.items.length,
    stored,
    relevant,
  };
}

/**
 * Articles for the sentiment aggregate, joined to their scores.
 *
 * Returns the shape `aggregateNewsSentiment` consumes, so the abstention decision is
 * made from stored facts rather than from whatever the last fetch happened to see.
 */
export async function scorableArticlesForAsset(
  db: Database,
  params: { assetId: string; since: Date },
): Promise<
  {
    id: string;
    publishedAt: Date;
    sourceTier: SourceTier;
    sourceName: string;
    polarity: number;
    matchedTerms: string[];
    relevant: boolean;
  }[]
> {
  const rows = await db
    .select({
      id: newsArticles.id,
      publishedAt: newsArticles.publishedAt,
      sourceTier: newsArticles.sourceTier,
      sourceName: newsArticles.sourceName,
      polarity: newsSentiment.polarity,
      matchedTerms: newsSentiment.matchedTerms,
    })
    .from(newsArticles)
    .innerJoin(newsArticleAssets, eq(newsArticleAssets.articleId, newsArticles.id))
    .innerJoin(newsSentiment, eq(newsSentiment.articleId, newsArticles.id))
    .where(
      and(
        eq(newsArticleAssets.assetId, params.assetId),
        gte(newsArticles.publishedAt, params.since),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    publishedAt: r.publishedAt,
    sourceTier: r.sourceTier as SourceTier,
    sourceName: r.sourceName,
    polarity: r.polarity,
    matchedTerms: r.matchedTerms,
    // Joined through news_article_assets, so presence here is relevance.
    relevant: true,
  }));
}

/** Retention sweep — news is a recurring storage consumer (LIMITS.md §1). */
export async function pruneOldNews(db: Database, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(newsArticles)
    .where(sql`${newsArticles.publishedAt} < ${olderThan}`)
    .returning({ id: newsArticles.id });
  return deleted.length;
}
