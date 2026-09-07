/**
 * News sentiment aggregation, and the decision not to produce one.
 *
 * The measured reality (2026-08-30) is about **three gold-relevant articles per day**
 * across twelve feeds, so a 48-hour window holds roughly six. That is below the
 * threshold at which a mean of per-article polarity says anything about the market
 * rather than about which headlines happened to land.
 *
 * So the common path here is **abstention**, and abstention is a first-class result
 * carrying the observed counts — not a silent zero. Amendment A3: a score must not
 * imply more than the data supports, and a user looking at a dark news factor is
 * entitled to see that it is a data limitation rather than a neutral reading.
 */

import { TIER_WEIGHT, type SourceTier } from '@forex-agent/core';

export interface ScorableArticle {
  readonly id: string;
  readonly publishedAt: Date;
  readonly sourceTier: SourceTier;
  readonly sourceName: string;
  readonly polarity: number;
  /** Lexicon terms that produced the polarity. Empty means no signal, not neutral. */
  readonly matchedTerms: readonly string[];
  readonly relevant: boolean;
}

export interface NewsAggregateConfig {
  readonly windowMs: number;
  readonly halfLifeMs: number;
  readonly minTierForScoring: SourceTier;
  readonly minArticlesForScore: number;
  readonly minSourcesForScore: number;
}

export const NEWS_ABSTAIN_REASONS = [
  'INSUFFICIENT_NEWS_VOLUME',
  'INSUFFICIENT_SOURCE_DIVERSITY',
  'NO_SENTIMENT_SIGNAL',
] as const;
export type NewsAbstainReason = (typeof NEWS_ABSTAIN_REASONS)[number];

/**
 * The observed counts behind the decision.
 *
 * Present whether or not a score was produced, because the UI must be able to say
 * *why* the factor is dark, with numbers.
 */
export interface NewsVolumeReport {
  readonly windowHours: number;
  /** Articles in the window before any filtering. */
  readonly articlesInWindow: number;
  /** Of those, relevant to the asset. */
  readonly relevantArticles: number;
  /** Of those, at or above the scoring tier. */
  readonly scorableArticles: number;
  /** Of those, carrying at least one lexicon term. */
  readonly articlesWithSignal: number;
  readonly distinctSources: number;
  readonly requiredArticles: number;
  readonly requiredSources: number;
}

export type NewsAggregateResult =
  | {
      readonly scored: true;
      /** Signed −100…+100, matching the fundamental scale. */
      readonly score: number;
      readonly confidence: number;
      readonly volume: NewsVolumeReport;
      readonly contributingArticleIds: readonly string[];
    }
  | {
      readonly scored: false;
      readonly reason: NewsAbstainReason;
      /** Rendered by the UI beside the dark factor. */
      readonly explanation: string;
      readonly volume: NewsVolumeReport;
    };


/**
 * Aggregate article polarity into a news score, or abstain with reasons.
 *
 * Pure: takes `now` rather than reading the clock, so the same inputs always give the
 * same answer and the abstention boundary is testable exactly.
 */
export function aggregateNewsSentiment(
  articles: readonly ScorableArticle[],
  config: NewsAggregateConfig,
  now: Date,
): NewsAggregateResult {
  const windowStart = now.getTime() - config.windowMs;
  const inWindow = articles.filter((a) => a.publishedAt.getTime() >= windowStart);
  const relevant = inWindow.filter((a) => a.relevant);
  const scorable = relevant.filter((a) => a.sourceTier <= config.minTierForScoring);
  // An article with no lexicon term contributes nothing; counting it toward the
  // threshold would let silent articles unlock a score built on a handful of others.
  const withSignal = scorable.filter((a) => a.matchedTerms.length > 0);
  const sources = new Set(withSignal.map((a) => a.sourceName));

  const volume: NewsVolumeReport = {
    windowHours: Math.round(config.windowMs / 3_600_000),
    articlesInWindow: inWindow.length,
    relevantArticles: relevant.length,
    scorableArticles: scorable.length,
    articlesWithSignal: withSignal.length,
    distinctSources: sources.size,
    requiredArticles: config.minArticlesForScore,
    requiredSources: config.minSourcesForScore,
  };

  if (withSignal.length === 0) {
    return {
      scored: false,
      reason: 'NO_SENTIMENT_SIGNAL',
      explanation:
        `No article in the last ${String(volume.windowHours)}h carried a scoreable sentiment term. ` +
        `This is an absence of signal, not a neutral reading.`,
      volume,
    };
  }

  if (withSignal.length < config.minArticlesForScore) {
    return {
      scored: false,
      reason: 'INSUFFICIENT_NEWS_VOLUME',
      explanation:
        `Only ${String(withSignal.length)} relevant article(s) with sentiment signal in the last ` +
        `${String(volume.windowHours)}h; ${String(config.minArticlesForScore)} are required for an ` +
        `average to mean anything. The news factor is dark because there is too little news, ` +
        `not because sentiment is neutral.`,
      volume,
    };
  }

  if (sources.size < config.minSourcesForScore) {
    return {
      scored: false,
      reason: 'INSUFFICIENT_SOURCE_DIVERSITY',
      explanation:
        `All ${String(withSignal.length)} scoreable articles came from ${String(sources.size)} source(s); ` +
        `${String(config.minSourcesForScore)} are required. A single outlet's editorial tone is not ` +
        `market sentiment.`,
      volume,
    };
  }

  // Recency-decayed, tier-weighted mean.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const a of withSignal) {
    const ageMs = now.getTime() - a.publishedAt.getTime();
    const recency = Math.pow(0.5, ageMs / config.halfLifeMs);
    const weight = TIER_WEIGHT[a.sourceTier] * recency;
    weightedSum += a.polarity * weight;
    weightTotal += weight;
  }

  const mean = weightTotal === 0 ? 0 : weightedSum / weightTotal;

  /**
   * Confidence rises with sample size, saturating at three times the minimum.
   *
   * Ten articles is the floor at which a mean is meaningful, not the point at which
   * it is reliable — so clearing the threshold yields modest confidence, not full.
   */
  const sampleRatio = Math.min(1, withSignal.length / (config.minArticlesForScore * 3));
  const sourceRatio = Math.min(1, sources.size / (config.minSourcesForScore * 2));
  const confidence = Number((0.4 + 0.4 * sampleRatio + 0.2 * sourceRatio).toFixed(3));

  return {
    scored: true,
    score: Number((mean * 100).toFixed(2)),
    confidence,
    volume,
    contributingArticleIds: withSignal.map((a) => a.id),
  };
}

/**
 * A one-line summary for the factor row and the daily email.
 *
 * Always states the observed count, so "dark" is never bare.
 */
export function describeNewsVolume(result: NewsAggregateResult): string {
  const v = result.volume;
  if (result.scored) {
    return `${String(v.articlesWithSignal)} relevant articles from ${String(v.distinctSources)} sources in ${String(v.windowHours)}h`;
  }
  return `${result.reason}: ${String(v.articlesWithSignal)}/${String(v.requiredArticles)} required articles, ${String(v.distinctSources)}/${String(v.requiredSources)} required sources (last ${String(v.windowHours)}h)`;
}
