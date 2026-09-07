/**
 * Stored articles → the news view the fundamental engine consumes.
 *
 * This bridge did not exist before Phase 12: the news factor's input was assembled by
 * hand in `scripts/checkpoint.mjs`, which meant every scheduled run would have had to
 * either skip F8 or invent its counts. A hand-assembled input is fine for a
 * demonstration and inadmissible in a job that emails somebody the result.
 *
 * The history is computed by re-running the same aggregation over earlier windows rather
 * than by storing a daily series. Two reasons: the aggregation rule then has exactly one
 * definition, and a stored series would have to be backfilled to be usable at all —
 * inventing history for days the pipeline was not running is the same class of error as
 * inventing a number.
 */

import { aggregateNewsSentiment, type NewsAggregateConfig } from '@forex-agent/engines';
import type { NewsAggregateView } from '@forex-agent/engines';
import { assessFreshness, type FreshnessThresholds, type SourceTier } from '@forex-agent/core';
import type { Database } from '@forex-agent/db';
import { scorableArticlesForAsset } from '../jobs/ingestNews.js';

export interface NewsViewParams {
  readonly assetId: string;
  readonly now: Date;
  readonly config: NewsAggregateConfig;
  readonly freshness: FreshnessThresholds;
  /**
   * How many earlier windows to standardise against.
   *
   * Each is one window-length earlier than the last, so they do not overlap and a single
   * loud day cannot appear in the history twice.
   */
  readonly historyWindows?: number;
}

/** Enough readings for a standard deviation to mean anything; below this F8 abstains. */
const DEFAULT_HISTORY_WINDOWS = 30;

export async function buildNewsView(
  db: Database,
  params: NewsViewParams,
): Promise<NewsAggregateView> {
  const windows = params.historyWindows ?? DEFAULT_HISTORY_WINDOWS;
  const { config, now } = params;

  // One query covering the current window and every history window behind it.
  const since = new Date(now.getTime() - config.windowMs * (windows + 1));
  const articles = await scorableArticlesForAsset(db, { assetId: params.assetId, since });

  const current = aggregateNewsSentiment(articles, config, now);

  if (!current.scored) {
    return {
      kind: 'INSUFFICIENT_VOLUME',
      reason: current.reason,
      explanation: current.explanation,
      // The counts the reason is about: articles that carried a scoreable term, and the
      // outlets they came from. `articlesInWindow` would overstate what was measurable.
      articleCount: current.volume.articlesWithSignal,
      sourceCount: current.volume.distinctSources,
      requiredArticles: current.volume.requiredArticles,
      requiredSources: current.volume.requiredSources,
    };
  }

  const history: number[] = [];
  for (let back = 1; back <= windows; back += 1) {
    const at = new Date(now.getTime() - config.windowMs * back);
    const past = aggregateNewsSentiment(articles, config, at);
    // Only windows that cleared the same thresholds. A window that abstained has no
    // reading, and treating it as zero would pull the mean toward neutral for days on
    // which nothing was measured at all.
    if (past.scored) history.push(past.score / 100);
  }

  const contributing = new Set(current.contributingArticleIds);
  const newest = articles
    .filter((a) => contributing.has(a.id))
    .reduce<Date | null>((max, a) => (max === null || a.publishedAt > max ? a.publishedAt : max), null);

  return {
    kind: 'AVAILABLE',
    // The engine's view is in polarity units; the aggregate reports the same mean on the
    // −100…+100 scale the factors share.
    polarity: current.score / 100,
    articleCount: current.volume.articlesWithSignal,
    sourceCount: current.volume.distinctSources,
    history,
    freshness: assessFreshness(
      { knownAt: newest ?? now, retrievedAt: now },
      params.freshness,
      now,
    ).status,
    // The weakest tier that contributed, so the aggregate is never credited with more
    // authority than its least authoritative input.
    sourceTier: articles
      .filter((a) => contributing.has(a.id))
      .reduce<SourceTier>((worst, a) => (a.sourceTier > worst ? a.sourceTier : worst), 1),
    factIds: current.contributingArticleIds,
  };
}
