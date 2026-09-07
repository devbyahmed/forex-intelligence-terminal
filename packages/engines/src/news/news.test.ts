import { describe, expect, it } from 'vitest';
import {
  CLASSIFIABLE_CATEGORIES,
  assessGoldRelevance,
  canonicaliseUrl,
  classifyArticle,
  scoreSentiment,
  titleSimilarity,
} from './classify.js';
import { aggregateNewsSentiment, describeNewsVolume, type ScorableArticle } from './aggregate.js';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

const CONFIG = {
  windowMs: 48 * 3_600_000,
  halfLifeMs: 12 * 3_600_000,
  minTierForScoring: 3 as const,
  minArticlesForScore: 10,
  minSourcesForScore: 2,
};

const article = (o: Partial<ScorableArticle> & { id: string }): ScorableArticle => ({
  publishedAt: hoursAgo(6),
  sourceTier: 2,
  sourceName: 'CNBC',
  polarity: -0.5,
  matchedTerms: ['hawkish'],
  relevant: true,
  ...o,
});

describe('classifyArticle', () => {
  it('classifies real headlines from the live feeds', () => {
    expect(classifyArticle('Bank Rate maintained at 3.75% - Monetary Policy Summary', null)).toBe(
      'MONETARY_POLICY',
    );
    expect(classifyArticle('US CPI rises 0.3% in July', null)).toBe('INFLATION');
    expect(classifyArticle('Nonfarm payrolls beat expectations', null)).toBe('EMPLOYMENT');
  });

  it('prefers the more specific category', () => {
    // "Fed holds rates" is monetary policy, not generic economy — order matters.
    expect(classifyArticle('Fed holds rates steady amid slowing growth', null)).toBe(
      'MONETARY_POLICY',
    );
  });

  it('falls back to OTHER rather than guessing', () => {
    expect(classifyArticle('Company X appoints new chief marketing officer', null)).toBe('OTHER');
  });

  it('reads the summary as well as the title', () => {
    expect(classifyArticle('Statement released', 'The FOMC voted to raise the policy rate.')).toBe(
      'MONETARY_POLICY',
    );
  });

  it('can produce every category it declares', () => {
    // Guards the join-coverage failure class: a ruleset whose categories are
    // unreachable would silently file everything as OTHER.
    expect(new Set(CLASSIFIABLE_CATEGORIES).size).toBe(CLASSIFIABLE_CATEGORIES.length);
    expect(CLASSIFIABLE_CATEGORIES.length).toBeGreaterThanOrEqual(10);
  });
});

describe('assessGoldRelevance', () => {
  it('matches gold named directly', () => {
    const r = assessGoldRelevance('Gold hits record high', null);
    expect(r.relevant).toBe(true);
    expect(r.direct).toBe(true);
  });

  it('matches a driver even when gold is never mentioned', () => {
    // The more consequential case: "Fed signals rate cut" moves gold without
    // naming it, and filtering on the word "gold" would discard it.
    const r = assessGoldRelevance('Fed signals rate cut as inflation cools', null);
    expect(r.relevant).toBe(true);
    expect(r.direct).toBe(false);
    expect(r.matchedTerms.length).toBeGreaterThan(0);
  });

  it('rejects an unrelated article', () => {
    expect(assessGoldRelevance('Streaming service raises subscription price', null).relevant).toBe(
      false,
    );
  });

  it('returns the matched terms so relevance is inspectable', () => {
    const r = assessGoldRelevance('Treasury yield rises on FOMC minutes', null);
    expect(r.matchedTerms).toContain('fomc');
  });
});

describe('scoreSentiment', () => {
  it('scores finance vocabulary in its financial sense', () => {
    // A general-purpose lexicon mis-scores these badly: "easing" is not relief and
    // "tightening" is not discipline.
    expect(scoreSentiment('Fed turns dovish, signals easing', null).polarity).toBeGreaterThan(0);
    expect(scoreSentiment('Hawkish Fed signals further tightening', null).polarity).toBeLessThan(0);
  });

  it('handles negation', () => {
    const plain = scoreSentiment('Fed is hawkish', null).polarity;
    const negated = scoreSentiment('Fed is not hawkish', null).polarity;
    expect(plain).toBeLessThan(0);
    expect(negated).toBeGreaterThan(0);
  });

  it('applies intensifiers', () => {
    const plain = Math.abs(scoreSentiment('Growth slowdown', null).polarity);
    const strong = Math.abs(scoreSentiment('Sharply worse slowdown', null).polarity);
    expect(strong).toBeGreaterThan(plain);
  });

  it('stays within [-1, 1] however many terms appear', () => {
    const r = scoreSentiment('crisis recession turmoil default plunge slump crisis recession', null);
    expect(r.polarity).toBeGreaterThanOrEqual(-1);
    expect(r.polarity).toBeLessThanOrEqual(1);
  });

  it('returns zero with no matched terms for text carrying no signal', () => {
    // Critical distinction: this is an ABSENCE of signal, not neutral sentiment.
    // The aggregate must be able to tell them apart, which is why matchedTerms
    // is part of the result.
    const r = scoreSentiment('Committee schedules its next meeting', null);
    expect(r.polarity).toBe(0);
    expect(r.matchedTerms).toHaveLength(0);
  });

  it('is deterministic', () => {
    const a = scoreSentiment('Hawkish Fed warns of inflation risk', null);
    const b = scoreSentiment('Hawkish Fed warns of inflation risk', null);
    expect(a).toEqual(b);
  });

  it('reports the terms that produced the score', () => {
    const r = scoreSentiment('Dovish tone lifts optimism', null);
    expect(r.matchedTerms).toContain('dovish');
    expect(r.matchedTerms).toContain('optimism');
  });
});

describe('canonicaliseUrl', () => {
  it('strips tracking parameters', () => {
    expect(canonicaliseUrl('https://x.com/a?utm_source=rss&utm_medium=feed&id=5')).toBe(
      'https://x.com/a?id=5',
    );
  });

  it('normalises host, fragment and trailing slash', () => {
    expect(canonicaliseUrl('https://www.x.com/a/#top')).toBe('https://x.com/a');
  });

  it('treats the same story from two feeds as one URL', () => {
    // Both CNBC feeds carry overlapping stories; without this the same article
    // counts twice toward the volume threshold.
    expect(canonicaliseUrl('https://www.cnbc.com/2026/08/30/story.html?utm_source=feed1')).toBe(
      canonicaliseUrl('https://cnbc.com/2026/08/30/story.html?utm_source=feed2'),
    );
  });

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(canonicaliseUrl('not a url')).toBe('not a url');
  });
});

describe('titleSimilarity', () => {
  it('detects a rewritten wire headline', () => {
    const s = titleSimilarity(
      'Fed holds rates steady as inflation cools',
      'Fed holds rates steady while inflation cools',
    );
    expect(s).toBeGreaterThan(0.6);
  });

  it('separates genuinely different stories', () => {
    expect(
      titleSimilarity('Gold hits record high', 'Oil slips on demand concerns'),
    ).toBeLessThan(0.2);
  });

  it('is 1 for identical titles', () => {
    expect(titleSimilarity('Same headline here', 'Same headline here')).toBe(1);
  });
});

describe('aggregateNewsSentiment — abstention is the expected path', () => {
  it('abstains below the article threshold, with the observed count', () => {
    // The measured reality: ~3 relevant articles/day means ~6 in a 48h window.
    const articles = Array.from({ length: 6 }, (_, i) => article({ id: `a${String(i)}` }));
    const r = aggregateNewsSentiment(articles, CONFIG, NOW);
    expect(r.scored).toBe(false);
    if (r.scored) return;
    expect(r.reason).toBe('INSUFFICIENT_NEWS_VOLUME');
    expect(r.volume.articlesWithSignal).toBe(6);
    expect(r.volume.requiredArticles).toBe(10);
    // The explanation must distinguish "too little news" from "neutral".
    expect(r.explanation).toContain('not because sentiment is neutral');
  });

  it('abstains when all articles come from one source', () => {
    const articles = Array.from({ length: 15 }, (_, i) =>
      article({ id: `a${String(i)}`, sourceName: 'OnlyOutlet' }),
    );
    const r = aggregateNewsSentiment(articles, CONFIG, NOW);
    expect(r.scored).toBe(false);
    if (r.scored) return;
    expect(r.reason).toBe('INSUFFICIENT_SOURCE_DIVERSITY');
  });

  it('abstains when articles exist but carry no sentiment signal', () => {
    const articles = Array.from({ length: 20 }, (_, i) =>
      article({ id: `a${String(i)}`, matchedTerms: [], polarity: 0 }),
    );
    const r = aggregateNewsSentiment(articles, CONFIG, NOW);
    expect(r.scored).toBe(false);
    if (r.scored) return;
    expect(r.reason).toBe('NO_SENTIMENT_SIGNAL');
    expect(r.explanation).toContain('not a neutral reading');
  });

  it('does not count signal-less articles toward the threshold', () => {
    // Otherwise silent articles would unlock a score computed from a handful.
    const mixed = [
      ...Array.from({ length: 5 }, (_, i) => article({ id: `s${String(i)}` })),
      ...Array.from({ length: 20 }, (_, i) =>
        article({ id: `n${String(i)}`, matchedTerms: [], polarity: 0 }),
      ),
    ];
    const r = aggregateNewsSentiment(mixed, CONFIG, NOW);
    expect(r.scored).toBe(false);
    if (r.scored) return;
    expect(r.volume.articlesWithSignal).toBe(5);
  });

  it('excludes articles outside the window', () => {
    const articles = Array.from({ length: 20 }, (_, i) =>
      article({ id: `a${String(i)}`, publishedAt: hoursAgo(72) }),
    );
    const r = aggregateNewsSentiment(articles, CONFIG, NOW);
    expect(r.volume.articlesInWindow).toBe(0);
  });

  it('excludes irrelevant articles', () => {
    const articles = Array.from({ length: 20 }, (_, i) =>
      article({ id: `a${String(i)}`, relevant: false }),
    );
    expect(aggregateNewsSentiment(articles, CONFIG, NOW).volume.relevantArticles).toBe(0);
  });

  it('reports volume even when it scores', () => {
    const articles = Array.from({ length: 14 }, (_, i) =>
      article({ id: `a${String(i)}`, sourceName: i % 2 === 0 ? 'CNBC' : 'MarketWatch' }),
    );
    const r = aggregateNewsSentiment(articles, CONFIG, NOW);
    expect(r.scored).toBe(true);
    if (!r.scored) return;
    expect(r.volume.articlesWithSignal).toBe(14);
    expect(r.volume.distinctSources).toBe(2);
  });
});

describe('aggregateNewsSentiment — scoring, once it clears', () => {
  const many = (polarity: number): ScorableArticle[] =>
    Array.from({ length: 14 }, (_, i) =>
      article({
        id: `a${String(i)}`,
        polarity,
        sourceName: i % 2 === 0 ? 'CNBC' : 'MarketWatch',
      }),
    );

  it('produces a signed score on the −100…+100 scale', () => {
    const r = aggregateNewsSentiment(many(0.5), CONFIG, NOW);
    expect(r.scored).toBe(true);
    if (!r.scored) return;
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('carries the sign of the underlying polarity', () => {
    const negative = aggregateNewsSentiment(many(-0.5), CONFIG, NOW);
    expect(negative.scored && negative.score < 0).toBe(true);
  });

  it('weights recent articles more heavily', () => {
    const base = { sourceName: 'CNBC', relevant: true, matchedTerms: ['x'], sourceTier: 2 as const };
    const recentPositive = Array.from({ length: 7 }, (_, i) =>
      article({ ...base, id: `r${String(i)}`, polarity: 1, publishedAt: hoursAgo(1) }),
    );
    const oldNegative = Array.from({ length: 7 }, (_, i) =>
      article({
        ...base,
        id: `o${String(i)}`,
        sourceName: 'MarketWatch',
        polarity: -1,
        publishedAt: hoursAgo(40),
      }),
    );
    const r = aggregateNewsSentiment([...recentPositive, ...oldNegative], CONFIG, NOW);
    expect(r.scored).toBe(true);
    if (!r.scored) return;
    // Equal counts, opposite polarity — recency decay must break the tie upward.
    expect(r.score).toBeGreaterThan(0);
  });

  it('gives modest confidence at the threshold, not full', () => {
    // Ten articles is the floor at which a mean means anything, not the point at
    // which it is reliable.
    const r = aggregateNewsSentiment(many(0.5).slice(0, 10), CONFIG, NOW);
    expect(r.scored).toBe(true);
    if (!r.scored) return;
    expect(r.confidence).toBeLessThan(0.8);
    expect(r.confidence).toBeGreaterThan(0.3);
  });

  it('scores exactly at the boundary and abstains one below it', () => {
    const ten = many(0.5).slice(0, 10);
    expect(aggregateNewsSentiment(ten, CONFIG, NOW).scored).toBe(true);
    expect(aggregateNewsSentiment(ten.slice(0, 9), CONFIG, NOW).scored).toBe(false);
  });
});

describe('describeNewsVolume', () => {
  it('always states the observed count when dark', () => {
    const r = aggregateNewsSentiment([article({ id: 'a' })], CONFIG, NOW);
    const text = describeNewsVolume(r);
    expect(text).toContain('INSUFFICIENT_NEWS_VOLUME');
    expect(text).toContain('1/10');
  });

  it('summarises a scored window', () => {
    const articles = Array.from({ length: 12 }, (_, i) =>
      article({ id: `a${String(i)}`, sourceName: i % 2 === 0 ? 'CNBC' : 'MarketWatch' }),
    );
    expect(describeNewsVolume(aggregateNewsSentiment(articles, CONFIG, NOW))).toContain(
      '12 relevant articles from 2 sources',
    );
  });
});
