/**
 * Contracts for the calendar, news and system-status panels.
 *
 * The same discipline as the analysis contract: provenance travels with every value,
 * absences are stated rather than omitted, and a shape that could render something
 * untrue is not expressible.
 *
 * The news contract is the one that matters most. F8 does not score today — twelve
 * feeds yield about three gold-relevant articles a day against a floor of ten — and
 * the panel's job is to render that as a *measurement of coverage* rather than as an
 * empty region. So the shape carries the counts, the thresholds and the articles
 * themselves. A contract offering only `articles: []` would leave the UI nothing to
 * say except "no data", which is both less true and more alarming than "six, and ten
 * are needed".
 */

import { z } from 'zod';
import { freshnessSchema, provenanceSchema, sourceTierSchema } from './analysis.js';

// ── News ────────────────────────────────────────────────────────────────────

export const newsArticleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sourceName: z.string().min(1),
  sourceTier: sourceTierSchema,
  publishedAt: z.iso.datetime(),
  url: z.url().nullable(),
  /** Whether it counted toward the factor, so a reader can see what was excluded. */
  goldRelevant: z.boolean(),
});
export type NewsArticle = z.infer<typeof newsArticleSchema>;

export const newsCoverageSchema = z.object({
  windowHours: z.number().int().positive(),
  feedCount: z.number().int().nonnegative(),
  feedFailures: z.number().int().nonnegative(),
  /** Everything collected in the window, relevant or not. */
  totalCount: z.number().int().nonnegative(),
  /** The subset that counts toward the factor. */
  relevantCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  /**
   * The thresholds, carried in the payload rather than known to the UI.
   *
   * They are product-visible facts (PRD_V1 §8.3a): a floor a user cannot see is a
   * floor they will assume was chosen to make the number look good. Carrying them here
   * also means the panel cannot drift from the engine's actual rule.
   */
  requiredArticles: z.number().int().positive(),
  requiredSources: z.number().int().positive(),
  articles: z.array(newsArticleSchema),
});
export type NewsCoverage = z.infer<typeof newsCoverageSchema>;

// ── Economic calendar ───────────────────────────────────────────────────────

export const calendarEntrySchema = z.object({
  id: z.string().min(1),
  eventName: z.string().min(1),
  country: z.string().min(1),
  importance: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  scheduledAt: z.iso.datetime(),
  /** Null until the release happens — never zero, which would read as a real figure. */
  actual: z.number().nullable(),
  forecast: z.number().nullable(),
  previous: z.number().nullable(),
  unit: z.string(),
  /**
   * Present only where a forecast existed to compare against.
   *
   * Historical consensus is unobtainable on free sources (LIMITS.md §6.9), so this is
   * null for nearly every past release. The panel says so rather than showing a blank
   * column that looks like a rendering fault.
   */
  surprise: z.number().nullable(),
  provenance: provenanceSchema,
});
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

export const calendarViewSchema = z.object({
  range: z.enum(['today', 'tomorrow', 'week']),
  entries: z.array(calendarEntrySchema),
  /**
   * Why forecasts are mostly absent, stated once at panel level.
   *
   * Null when they are present. A column of empty cells with no explanation is
   * indistinguishable from a broken join.
   */
  forecastGapNote: z.string().nullable(),
});
export type CalendarView = z.infer<typeof calendarViewSchema>;

// ── System status ───────────────────────────────────────────────────────────

export const providerHealthSchema = z.object({
  providerId: z.string().min(1),
  domain: z.string().min(1),
  tier: sourceTierSchema,
  state: z.enum(['OK', 'DEGRADED', 'BREAKER_OPEN', 'QUOTA_EXHAUSTED', 'UNKNOWN']),
  lastSuccessAt: z.iso.datetime().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  quotaUsedToday: z.number().int().nonnegative(),
  quotaLimitDaily: z.number().int().positive().nullable(),
  quotaResetsAt: z.iso.datetime().nullable(),
});
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

export const jobRunSummarySchema = z.object({
  jobName: z.string().min(1),
  status: z.string().min(1),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  detail: z.string().nullable(),
});

export const seriesFreshnessSchema = z.object({
  seriesId: z.string().min(1),
  displayName: z.string().min(1),
  cadence: z.string().min(1),
  freshness: freshnessSchema,
  latestPeriod: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  observationCount: z.number().int().nonnegative(),
});

export const systemStatusSchema = z.object({
  providers: z.array(providerHealthSchema),
  recentRuns: z.array(jobRunSummarySchema),
  series: z.array(seriesFreshnessSchema),
  /** Present when something needs attention; empty when nothing does. */
  warnings: z.array(z.string()),
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;

// ── Refresh ─────────────────────────────────────────────────────────────────

/**
 * What a refresh costs, shown before it is spent.
 *
 * The button is not simply enabled or disabled: it carries the price. A refresh that
 * silently consumes a third of the day's Twelve Data credits is how a curious user at
 * 10am breaks the scheduled run at 4pm.
 */
export const refreshQuoteSchema = z.object({
  affordable: z.boolean(),
  costSummary: z.string().min(1),
  refusal: z.string(),
  providers: z.array(
    z.object({
      providerId: z.string().min(1),
      cost: z.number().int().nonnegative(),
      unit: z.enum(['credits', 'requests']),
      usedToday: z.number().int().nonnegative(),
      dailyLimit: z.number().int().positive().nullable(),
      remaining: z.number().int().nullable(),
      reserved: z.number().int().nonnegative(),
      resetsAt: z.iso.datetime().nullable(),
      affordable: z.boolean(),
    }),
  ),
});
export type RefreshQuote = z.infer<typeof refreshQuoteSchema>;
