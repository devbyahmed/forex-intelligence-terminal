/**
 * Server-only loaders for the calendar, news and status panels.
 *
 * Each returns a validated contract value, so the components stay pure functions of
 * data and can be rendered from a fixture in a test.
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { CalendarView, NewsCoverage, RefreshQuote, SystemStatus } from '@forex-agent/contracts';
import { calendarViewSchema, newsCoverageSchema, refreshQuoteSchema } from '@forex-agent/contracts';
import {
  economicEvents,
  economicReleases,
  newsArticleAssets,
  newsArticles,
  newsSources,
} from '@forex-agent/db';
import {
  V1_REFRESH_COST,
  buildSystemStatus,
  estimateRefreshBudget,
} from '@forex-agent/worker';
import { DEFAULT_RUNTIME_CONFIG } from '@forex-agent/config';
import { openDb } from './session';

export async function loadNewsCoverage(now: Date): Promise<NewsCoverage> {
  const windowHours = DEFAULT_RUNTIME_CONFIG.news.windowMs / 3_600_000;
  const from = new Date(now.getTime() - DEFAULT_RUNTIME_CONFIG.news.windowMs);

  const handle = openDb();
  try {
    const rows = await handle.db
      .select({
        id: newsArticles.id,
        title: newsArticles.title,
        sourceName: newsArticles.sourceName,
        sourceTier: newsArticles.sourceTier,
        publishedAt: newsArticles.sourceTimestamp,
        url: newsArticles.sourceUrl,
        /*
         * Relevance lives in `news_article_assets`, not on the article.
         *
         * A left join with an existence test rather than an inner join: an article
         * that was collected and found *not* gold-relevant is evidence too — it is
         * what distinguishes "the feeds produced nothing" from "the feeds produced
         * plenty, and little of it was about gold". The panel shows both counts.
         */
        goldRelevant: sql<boolean>`${newsArticleAssets.articleId} is not null`,
      })
      .from(newsArticles)
      .leftJoin(
        newsArticleAssets,
        and(
          eq(newsArticleAssets.articleId, newsArticles.id),
          eq(newsArticleAssets.assetId, sql`(select id from assets where symbol = 'XAUUSD')`),
        ),
      )
      .where(gte(newsArticles.sourceTimestamp, from))
      .orderBy(desc(newsArticles.sourceTimestamp))
      .limit(40);

    const [feeds] = await handle.db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${newsSources.isActive})::int`,
      })
      .from(newsSources);

    const articles = rows.map((r) => ({
      id: r.id,
      title: r.title,
      sourceName: r.sourceName,
      sourceTier: r.sourceTier as 1 | 2 | 3 | 4,
      publishedAt: r.publishedAt.toISOString(),
      url: r.url,
      goldRelevant: r.goldRelevant,
    }));

    const relevant = articles.filter((a) => a.goldRelevant);

    return newsCoverageSchema.parse({
      windowHours,
      feedCount: feeds?.active ?? 0,
      feedFailures: 0,
      totalCount: articles.length,
      relevantCount: relevant.length,
      sourceCount: new Set(relevant.map((a) => a.sourceName)).size,
      requiredArticles: DEFAULT_RUNTIME_CONFIG.news.minArticlesForScore,
      requiredSources: DEFAULT_RUNTIME_CONFIG.news.minSourcesForScore,
      articles,
    });
  } finally {
    await handle.close();
  }
}

export async function loadCalendar(now: Date): Promise<CalendarView> {
  const from = new Date(now.getTime() - 2 * 86_400_000);
  const to = new Date(now.getTime() + 7 * 86_400_000);

  const handle = openDb();
  try {
    const rows = await handle.db
      .select({
        id: economicReleases.id,
        eventName: economicEvents.name,
        country: economicEvents.country,
        importance: economicEvents.importance,
        scheduledAt: economicReleases.scheduledAt,
        actual: economicReleases.actualValue,
        forecast: economicReleases.forecastValue,
        previous: economicReleases.previousValue,
        unit: economicReleases.unit,
        surprise: economicReleases.surprise,
        sourceProvider: economicReleases.sourceProvider,
        sourceName: economicReleases.sourceName,
        sourceUrl: economicReleases.sourceUrl,
        sourceTier: economicReleases.sourceTier,
        sourceTimestamp: economicReleases.sourceTimestamp,
        retrievedAt: economicReleases.retrievedAt,
        freshness: economicReleases.freshness,
      })
      .from(economicReleases)
      .innerJoin(economicEvents, eq(economicEvents.id, economicReleases.eventId))
      .where(and(gte(economicReleases.scheduledAt, from), lte(economicReleases.scheduledAt, to)))
      .orderBy(economicReleases.scheduledAt)
      .limit(60);

    const withForecast = rows.filter((r) => r.forecast !== null).length;

    return calendarViewSchema.parse({
      range: 'week',
      entries: rows.map((r) => ({
        id: r.id,
        eventName: r.eventName,
        country: r.country,
        importance: r.importance,
        scheduledAt: r.scheduledAt.toISOString(),
        actual: r.actual === null ? null : Number(r.actual),
        forecast: r.forecast === null ? null : Number(r.forecast),
        previous: r.previous === null ? null : Number(r.previous),
        unit: r.unit ?? '',
        surprise: r.surprise === null ? null : Number(r.surprise),
        provenance: {
          factTable: 'economic_releases',
          factId: r.id,
          sourceName: r.sourceName,
          sourceTier: r.sourceTier as 1 | 2 | 3 | 4,
          sourceUrl: r.sourceUrl,
          publishedAt: r.sourceTimestamp.toISOString(),
          retrievedAt: r.retrievedAt.toISOString(),
          freshness: r.freshness,
          publicationLagDays: null,
        },
      })),
      // Stated once at panel level rather than left as a column of blanks, which is
      // indistinguishable from a broken join.
      forecastGapNote:
        withForecast < rows.length
          ? `${String(rows.length - withForecast)} of ${String(rows.length)} releases have no ` +
            'consensus forecast. Historical consensus is not available from any free source — ' +
            'the only free feed carrying it covers a rolling one-week window — so past releases ' +
            'show an actual value with nothing to compare it against.'
          : null,
    });
  } finally {
    await handle.close();
  }
}

export async function loadSystemStatus(now: Date): Promise<SystemStatus> {
  const handle = openDb();
  try {
    return await buildSystemStatus(handle.db, now);
  } finally {
    await handle.close();
  }
}

export async function loadRefreshQuote(): Promise<RefreshQuote> {
  const handle = openDb();
  try {
    const budget = await estimateRefreshBudget(handle.db, V1_REFRESH_COST);
    return refreshQuoteSchema.parse({
      affordable: budget.affordable,
      costSummary: budget.costSummary,
      refusal: budget.refusal,
      providers: budget.providers.map((p) => ({
        providerId: p.providerId,
        cost: p.cost,
        unit: p.unit,
        usedToday: p.usedToday,
        dailyLimit: p.dailyLimit,
        remaining: p.remaining,
        reserved: p.reserved,
        resetsAt: p.resetsAt?.toISOString() ?? null,
        affordable: p.affordable,
      })),
    });
  } finally {
    await handle.close();
  }
}
