/**
 * The job schedule — one list, assembled once, used by every trigger.
 *
 * Before this existed, each entry point decided for itself what to run: the checkpoint
 * script ran an analysis, the report script ran a report, and nothing ran ingestion.
 * Three entry points meant three answers to "what is a complete tick", and the one that
 * mattered — production — had none at all.
 *
 * **Order matters here and is not alphabetical.** A tick has a budget, and `runDue` works
 * down the list until it runs out, leaving the rest due next time. So the list runs in
 * dependency order: collect facts, then score them, then report the score. Any other
 * order costs a full cycle before a new fact reaches a reader — ingestion at 08:31 that
 * scores at 09:31 and reports at 10:31 is three ticks to say what the first already knew.
 *
 * Cadences are unequal and follow the data rather than convenience:
 *
 * - **Market** — every 15 minutes. The only input that moves intraday.
 * - **News** — every 30 minutes. Feeds update continuously against a 48-hour window, so
 *   polling harder buys nothing but quota.
 * - **Macro** — hourly. FRED publishes daily at best; hourly is already generous, and
 *   its purpose is to notice a release promptly, not to see new numbers.
 * - **Calendar** — every 6 hours. It describes the days ahead.
 * - **Analysis** — hourly, behind ingestion in this list.
 * - **Report** — hourly by slot, but idempotent by date: it sends once a day and later
 *   attempts find the stored report and stop. The cadence is a retry policy, not a send
 *   policy. A job that could only fire in one narrow slot would skip a day silently
 *   whenever that slot happened to fail.
 * - **Data-failure alert** — every 15 minutes, with its cooldown carried on the rule. It
 *   has to notice quickly and speak rarely.
 */

import type { RuntimeConfig } from '@forex-agent/config';
import type {
  EconomicCalendarProvider,
  FredMacroProvider,
  MarketDataProvider,
} from '@forex-agent/providers';
import type { JobDefinition } from '../runner.js';
import { analysisJob, type AnalysisJobDeps } from './analysis.js';
import { dailyReportJob, dataFailureAlertJob, type ReportJobDeps } from './dailyReport.js';
import { ingestCalendarJob } from './ingestCalendar.js';
import { ingestMacroJob } from './ingestMacro.js';
import { ingestMarketJob } from './ingestMarket.js';
import { ingestNewsJob } from './ingestNews.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface JobRegistryDeps {
  readonly config: RuntimeConfig;
  /** Ordered by authority: verified spot first, labelled proxy second. */
  readonly marketChain: readonly MarketDataProvider[];
  readonly fredMacro: FredMacroProvider;
  readonly fredCalendar: EconomicCalendarProvider;
  readonly forexFactory: EconomicCalendarProvider;
  readonly analysis: Omit<AnalysisJobDeps, 'config'>;
  readonly report: ReportJobDeps;
}

/**
 * Every job a complete tick runs, in the order it should attempt them.
 *
 * One list rather than a set of per-caller lists. The local runner and the deployed HTTP
 * trigger must agree about what runs, or "it worked locally" stops being evidence of
 * anything about production.
 */
export function allJobs(deps: JobRegistryDeps): readonly JobDefinition[] {
  const c = deps.config;

  return [
    {
      name: 'ingest-market',
      intervalMs: 15 * MINUTE,
      timeoutMs: 90_000,
      handler: ingestMarketJob({
        chain: deps.marketChain,
        thresholds: c.freshness.spotQuote,
      }),
    },
    {
      name: 'ingest-news',
      intervalMs: 30 * MINUTE,
      // Twelve feeds fetched in sequence, each with its own timeout. The generous
      // ceiling is for the whole sweep, not for any one feed.
      timeoutMs: 3 * MINUTE,
      handler: ingestNewsJob({
        thresholds: c.freshness.news,
        duplicateTitleThreshold: c.news.duplicateTitleThreshold,
      }),
    },
    {
      name: 'ingest-macro',
      intervalMs: HOUR,
      timeoutMs: 3 * MINUTE,
      handler: ingestMacroJob({
        fred: deps.fredMacro,
        thresholds: {
          DAILY: c.freshness.dailyMacro,
          WEEKLY: c.freshness.weeklyMacro,
          MONTHLY: c.freshness.monthlyMacro,
        },
      }),
    },
    {
      name: 'ingest-calendar',
      intervalMs: 6 * HOUR,
      timeoutMs: 2 * MINUTE,
      handler: ingestCalendarJob({
        fred: deps.fredCalendar,
        forexFactory: deps.forexFactory,
        thresholds: c.freshness.economicCalendar,
      }),
    },
    {
      name: 'analysis',
      intervalMs: HOUR,
      // Long enough for a Gemini call plus a slow database; short enough that a hung
      // provider cannot hold the slot past the next one.
      timeoutMs: 4 * MINUTE,
      handler: analysisJob({ config: c, ...deps.analysis }),
    },
    {
      name: 'daily-report',
      intervalMs: HOUR,
      timeoutMs: 2 * MINUTE,
      handler: dailyReportJob(deps.report),
    },
    {
      name: 'data-failure-alert',
      intervalMs: 15 * MINUTE,
      timeoutMs: MINUTE,
      handler: dataFailureAlertJob(deps.report),
    },
  ];
}
