/**
 * Deterministic news classification, asset tagging and sentiment (master PRD §8).
 *
 * Pure functions over article text. **Sentiment is computed by a versioned lexicon,
 * never by the AI** — the same article must always score the same, and the matched
 * terms are returned so a score can be inspected rather than trusted.
 */

import type { NewsCategory } from '@forex-agent/core';

export const CLASSIFIER_VERSION = 'rules-v1';
export const LEXICON_VERSION = 'finance-lexicon-v1';

// ── Category rules ──────────────────────────────────────────────────────────

interface CategoryRule {
  readonly category: NewsCategory;
  readonly patterns: readonly RegExp[];
}

/**
 * Ordered: the first match wins, so more specific categories precede general ones.
 * `MONETARY_POLICY` before `ECONOMY` means "Fed holds rates" is policy, not economy.
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'MONETARY_POLICY',
    patterns: [
      // "Fed holds rates steady" is a policy decision. Requiring an explicit
      // cut/hike let a hold fall through to ECONOMY on the word "growth".
      /\b(fomc|federal open market|rate (?:decision|cut|hike|rise)|(?:holds?|held|keeps?|kept|leaves?|left) rates?|rates? (?:steady|unchanged|on hold)|bank rate|policy rate|refinancing rate|quantitative (?:easing|tightening)|monetary polic|dovish|hawkish|tapering)\b/i,
    ],
  },
  {
    category: 'CENTRAL_BANKS',
    patterns: [
      /\b(federal reserve|fed\b|ecb\b|european central bank|bank of england|bank of japan|boj\b|boe\b|central bank|governing council|powell|lagarde|bailey|ueda)\b/i,
    ],
  },
  {
    category: 'INFLATION',
    patterns: [/\b(inflation|cpi\b|consumer price|ppi\b|producer price|deflation|price pressures|core price)\b/i],
  },
  {
    category: 'EMPLOYMENT',
    patterns: [/\b(payroll|nonfarm|non-farm|unemployment|jobless|jobs report|labou?r market|hiring|layoff|employment situation)\b/i],
  },
  {
    category: 'GEOPOLITICS',
    patterns: [/\b(war|conflict|invasion|sanction|missile|strike|ceasefire|military|geopolit|escalation|tension)\b/i],
  },
  {
    category: 'TRADE',
    patterns: [/\b(tariff|trade (?:war|deal|deficit|talks)|export control|import dut|customs)\b/i],
  },
  {
    category: 'BANKING',
    patterns: [/\b(bank (?:failure|collapse|run)|credit (?:crunch|crisis)|liquidity crisis|deposit|basel|capital requirement|systemic risk)\b/i],
  },
  {
    category: 'GOVERNMENT_POLICY',
    patterns: [/\b(fiscal|budget|deficit|debt ceiling|stimulus|treasury (?:secretary|department)|government shutdown|legislation)\b/i],
  },
  {
    category: 'MARKET_SENTIMENT',
    patterns: [/\b(risk[- ](?:on|off)|safe[- ]haven|volatility|selloff|sell-off|rally|correction|bear market|bull market|investor sentiment)\b/i],
  },
  {
    category: 'RISK_EVENTS',
    patterns: [/\b(default|downgrade|crisis|shock|emergency|contagion|recession fears)\b/i],
  },
  {
    category: 'ECONOMY',
    patterns: [/\b(gdp\b|growth|recession|retail sales|pmi\b|manufacturing|services sector|consumer confidence|economic (?:data|outlook))\b/i],
  },
];

export function classifyArticle(title: string, summary: string | null): NewsCategory {
  const text = `${title} ${summary ?? ''}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.category;
  }
  return 'OTHER';
}

/** Every category the ruleset can produce — used by the coverage assertion. */
export const CLASSIFIABLE_CATEGORIES: readonly NewsCategory[] = CATEGORY_RULES.map(
  (r) => r.category,
);

// ── Asset relevance ─────────────────────────────────────────────────────────

/**
 * What makes an article relevant to gold.
 *
 * Two paths: gold named directly, or a driver that moves it. The second matters
 * more — "Fed signals rate cut" never mentions gold but is the more consequential
 * article.
 */
const GOLD_DIRECT = /\b(gold|bullion|xau|precious metal)\b/i;
const GOLD_DRIVERS =
  /\b(inflation|cpi\b|real yield|treasury yield|10-year|dollar index|dxy\b|fomc|federal reserve|fed\b|rate (?:cut|hike|decision)|monetary polic|safe[- ]haven|geopolit|central bank|payroll|unemployment|recession)\b/i;

export interface RelevanceResult {
  readonly relevant: boolean;
  readonly direct: boolean;
  readonly matchedTerms: readonly string[];
}

export function assessGoldRelevance(title: string, summary: string | null): RelevanceResult {
  const text = `${title} ${summary ?? ''}`;
  const direct = [...text.matchAll(new RegExp(GOLD_DIRECT, 'gi'))].map((m) => m[0].toLowerCase());
  const drivers = [...text.matchAll(new RegExp(GOLD_DRIVERS, 'gi'))].map((m) => m[0].toLowerCase());
  const matched = [...new Set([...direct, ...drivers])];
  return { relevant: matched.length > 0, direct: direct.length > 0, matchedTerms: matched };
}

// ── Sentiment ───────────────────────────────────────────────────────────────

/**
 * Finance-oriented polarity lexicon.
 *
 * Deliberately small and inspectable. General-purpose sentiment lexicons mis-score
 * financial text badly — "aggressive tightening" is not enthusiasm, and "easing" is
 * not relief. Terms here are chosen for what they mean in a rates-and-inflation
 * context, and every score returns the terms that produced it.
 */
const POSITIVE: Readonly<Record<string, number>> = {
  dovish: 0.8, easing: 0.6, cut: 0.5, stimulus: 0.6, rebound: 0.6, rally: 0.7,
  optimism: 0.7, resilient: 0.5, beat: 0.5, stronger: 0.4, growth: 0.4,
  recovery: 0.6, surge: 0.6, gains: 0.5, upbeat: 0.7, expansion: 0.5,
  cooling: 0.4, moderating: 0.4, eased: 0.5, improved: 0.5,
};

const NEGATIVE: Readonly<Record<string, number>> = {
  hawkish: -0.8, tightening: -0.6, hike: -0.5, recession: -0.9, crisis: -0.9,
  slump: -0.7, plunge: -0.8, selloff: -0.7, 'sell-off': -0.7, fears: -0.6,
  weak: -0.5, weaker: -0.5, contraction: -0.7, downgrade: -0.7, default: -0.9,
  turmoil: -0.8, uncertainty: -0.5, slowdown: -0.6, miss: -0.5, tumble: -0.7,
  warning: -0.5, risk: -0.3, conflict: -0.7, sanctions: -0.6, tariff: -0.5,
  inflationary: -0.4, surged: -0.2, elevated: -0.3,
};

const NEGATORS = /\b(not|no|never|without|fails? to|unlikely to|refused? to)\b/i;
const INTENSIFIERS: Readonly<Record<string, number>> = {
  very: 1.5, sharply: 1.5, significantly: 1.4, slightly: 0.6, marginally: 0.5,
  modestly: 0.7, deeply: 1.5, heavily: 1.4,
};

export interface SentimentResult {
  /** Polarity in [-1, 1]. */
  readonly polarity: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly matchedTerms: readonly string[];
  readonly methodVersion: string;
}

/**
 * Score an article's polarity.
 *
 * Returns exactly 0 with no matched terms when nothing in the lexicon appears —
 * which the caller must treat as *no signal*, not as neutral sentiment. That
 * distinction is why `matchedTerms` is part of the result rather than a debug aid.
 */
export function scoreSentiment(title: string, summary: string | null): SentimentResult {
  const text = `${title} ${summary ?? ''}`.toLowerCase();
  const words = text.split(/[^a-z-]+/).filter((w) => w !== '');

  let total = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  const matched: string[] = [];

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === undefined) continue;

    const base = POSITIVE[word] ?? NEGATIVE[word];
    if (base === undefined) continue;

    // Look back two words for a negator or intensifier.
    const window = words.slice(Math.max(0, i - 2), i).join(' ');
    const negated = NEGATORS.test(window);
    const intensifier = words
      .slice(Math.max(0, i - 2), i)
      .map((w) => INTENSIFIERS[w])
      .find((v) => v !== undefined);

    let score = base * (intensifier ?? 1);
    if (negated) score = -score;

    total += score;
    matched.push(negated ? `not:${word}` : word);
    if (score > 0) positiveCount += 1;
    else negativeCount += 1;
  }

  // tanh keeps the result in [-1, 1] while staying near-linear for small counts,
  // so three mildly negative terms do not saturate to -1.
  const polarity = matched.length === 0 ? 0 : Math.tanh(total / 2);

  return {
    polarity: Number(polarity.toFixed(4)),
    positiveCount,
    negativeCount,
    matchedTerms: matched,
    methodVersion: LEXICON_VERSION,
  };
}

// ── Deduplication ───────────────────────────────────────────────────────────

/** Strip tracking parameters and fragments so the same story has one identity. */
export function canonicaliseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|source|campaign|partner)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.replace(/^www\./, '');
    // A trailing slash is not a different article.
    if (url.pathname.endsWith('/') && url.pathname.length > 1) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return raw.trim();
  }
}

/**
 * Function words carry no topical content, and wire rewrites swap them freely — "as"
 * becomes "while", "amid" becomes "after".
 *
 * Filtering by word length treated "as" as noise but kept "while", so the same story
 * under two headlines scored 0.57 and slipped under the 0.8 duplicate threshold,
 * letting one event count twice toward the volume floor that gates F8.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'as', 'while', 'amid', 'after', 'before',
  'on', 'in', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'its', 'that', 'this', 'than', 'then', 'over',
  'into', 'out', 'up', 'down', 'new', 'says', 'said',
]);

/** Word shingles for near-duplicate detection. */
function shingles(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const out = new Set<string>();
  for (let i = 0; i < words.length - 1; i += 1) out.add(`${words[i] ?? ''} ${words[i + 1] ?? ''}`);
  if (out.size === 0 && words.length === 1) out.add(words[0] ?? '');
  return out;
}

/**
 * Jaccard similarity between two headlines.
 *
 * Catches the same wire story republished under slightly different headlines, which
 * would otherwise let one event count several times toward the article threshold and
 * pull the sentiment mean with it.
 */
export function titleSimilarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let intersection = 0;
  for (const s of sa) if (sb.has(s)) intersection += 1;
  return intersection / (sa.size + sb.size - intersection);
}
