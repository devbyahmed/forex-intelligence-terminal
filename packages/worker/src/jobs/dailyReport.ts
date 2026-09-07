/**
 * The daily report job, and the data-failure alert.
 *
 * Two jobs in one file because they are the same decision seen from opposite sides:
 * one sends what the system found, the other sends when it found nothing. The failure
 * this pairing prevents is a silent one — a pipeline that stops ingesting produces no
 * report and no alert, and an empty inbox looks exactly like a quiet market.
 *
 * The ordering inside the report job is deliberate throughout:
 *
 *  1. Render from the **stored** analysis, never recompute. A report describes a run
 *     that happened; regenerating it would describe a different one.
 *  2. Store before sending, so the permanent link resolves when the email arrives.
 *  3. Send, recording the attempt whatever the outcome.
 *
 * An insufficient analysis still produces a report. "No score today, and here is why"
 * is the product working, and skipping the email on those days would mean the reader
 * only ever hears from us when we have a number — which teaches them that silence means
 * nothing is wrong.
 */

import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { zonedDayBounds } from '@forex-agent/core';
import {
  alertRules,
  analyses,
  assets,
  jobRuns,
  reports,
} from '@forex-agent/db';
import type { EmailProvider } from '@forex-agent/providers';
import { analysisResponseById } from '../analysis/toResponse.js';
import { buildSystemStatus } from '../analysis/systemStatus.js';
import { checkCooldown, markRuleFired, notify, recordSuppression, storeReport } from '../report/notify.js';
import { renderReport, reportDateFor } from '../report/render.js';
import type { JobContext, JobOutcome } from '../runner.js';

export interface ReportJobDeps {
  readonly providers: readonly EmailProvider[];
  readonly from: string;
  readonly to: string;
  /** Absolute base for the permanent link in the email. */
  readonly appBaseUrl: string;
  /**
   * The calendar the report's day boundary follows.
   *
   * Required, not defaulted: this decides which analyses count as today, and a
   * default would let a caller silently pick a different day than the one the
   * report is titled with.
   */
  readonly timeZone: string;
  readonly assetSymbol?: string;
}

/**
 * Generate and send the daily report.
 *
 * Idempotent by date: a second run on the same day finds the stored report and does not
 * send again. The tick runs every fifteen minutes and this job is due once a day — the
 * ledger decides when, but a duplicated trigger must not produce a duplicated email.
 */
export function dailyReportJob(deps: ReportJobDeps) {
  return async (ctx: JobContext): Promise<JobOutcome> => {
    const symbol = deps.assetSymbol ?? 'XAUUSD';
    const reportDate = reportDateFor(ctx.now.toISOString(), deps.timeZone);

    const [existing] = await ctx.db
      .select({ id: reports.id })
      .from(reports)
      .where(and(eq(reports.reportDate, reportDate), eq(reports.kind, 'DAILY_BRIEFING')))
      .limit(1);

    if (existing !== undefined) {
      // Already sent today. Not an error and not a retry — the ledger may fire this job
      // more than once, and an email is not something to send twice.
      return { itemsProcessed: 0, detail: `report for ${reportDate} already exists; not resent` };
    }

    // The most recent analysis for today, by its stored id — never recomputed.
    const [asset] = await ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.symbol, symbol))
      .limit(1);

    if (asset === undefined) {
      return { itemsProcessed: 0, detail: `asset ${symbol} is not seeded; no report generated` };
    }

    /*
     * The day as the reporting calendar reckons it, not a 24-hour window from UTC
     * midnight. On the two days a year the offset changes these differ by an hour,
     * and a fixed 86,400,000 would either miss an analysis or claim one from the
     * next day.
     */
    const { start: dayStart, end: dayEnd } = zonedDayBounds(reportDate, deps.timeZone);

    const [latest] = await ctx.db
      .select({ id: analyses.id })
      .from(analyses)
      .where(
        and(
          eq(analyses.assetId, asset.id),
          gte(analyses.runAt, dayStart),
          lt(analyses.runAt, dayEnd),
        ),
      )
      .orderBy(desc(analyses.runAt))
      .limit(1);

    if (latest === undefined) {
      /*
       * No analysis ran today. This is not a report to send — it is a data failure, and
       * sending a report saying "no analysis" would blur the two: the reader cannot tell
       * a market with nothing to say from a pipeline that stopped. The alert job below
       * owns this case.
       */
      return {
        itemsProcessed: 0,
        detail: `no analysis stored for ${symbol} on ${reportDate}; data-failure alert owns this case`,
      };
    }

    const analysis = await analysisResponseById(ctx.db, latest.id);
    const rendered = renderReport(analysis, deps.timeZone);

    const stored = await storeReport(ctx.db, {
      rendered,
      assetId: asset.id,
      analysisId: latest.id,
    });

    // The permanent link, appended after rendering so the report body and the link
    // cannot disagree about which report they refer to.
    const link = `${deps.appBaseUrl.replace(/\/$/, '')}/reports/${stored.id}`;
    const text = `${rendered.text}\n\nPermanent copy of this report: ${link}\n`;

    const outcome = await notify(ctx.db, deps.providers, {
      reportId: stored.id,
      userId: null,
      alertRuleId: null,
      templateName: 'daily-briefing',
      recipient: deps.to,
      from: deps.from,
      subject: rendered.subject,
      text,
      html: rendered.html,
      now: ctx.now,
    });

    return {
      itemsProcessed: 1,
      detail:
        `report ${reportDate} stored (${stored.created ? 'new' : 'existing'}) and ` +
        (outcome.kind === 'SENT' ? 'sent' : `not sent: ${outcome.reason}`),
    };
  };
}

// ── Data-failure alert ──────────────────────────────────────────────────────

export interface DataFailureDeps extends ReportJobDeps {
  /** How stale ingestion must be before it counts as a failure. */
  readonly stalenessMs?: number;
}

/** Six hours: long enough to ride out a provider outage, short enough to matter. */
const DEFAULT_STALENESS_MS = 6 * 60 * 60 * 1000;

/**
 * Alert when the pipeline itself has stopped working.
 *
 * **The alert exists because its absence is invisible.** Every other failure in this
 * product announces itself — a factor abstains, coverage drops, the dashboard says what
 * is missing. A pipeline that stops entirely produces none of those: no analysis, no
 * report, no dashboard change anyone is looking at. The only signal is an inbox that
 * went quiet, and a quiet inbox is indistinguishable from a quiet market.
 *
 * Conditions checked are the ones that mean "we are not measuring any more", not "the
 * measurement is uninteresting": no analysis in the staleness window, failed job runs,
 * or a provider whose breaker is open or quota is spent.
 */
export function dataFailureAlertJob(deps: DataFailureDeps) {
  return async (ctx: JobContext): Promise<JobOutcome> => {
    const stalenessMs = deps.stalenessMs ?? DEFAULT_STALENESS_MS;
    const since = new Date(ctx.now.getTime() - stalenessMs);

    const status = await buildSystemStatus(ctx.db, ctx.now);

    const [recentAnalysis] = await ctx.db
      .select({ id: analyses.id })
      .from(analyses)
      .where(gte(analyses.runAt, since))
      .orderBy(desc(analyses.runAt))
      .limit(1);

    const problems: string[] = [...status.warnings];
    if (recentAnalysis === undefined) {
      problems.unshift(
        `No analysis has been stored in the last ${String(Math.round(stalenessMs / 3_600_000))} hours. ` +
          'The pipeline is not producing readings.',
      );
    }

    const [failedRun] = await ctx.db
      .select({ jobName: jobRuns.jobName })
      .from(jobRuns)
      .where(and(eq(jobRuns.status, 'FAILED'), gte(jobRuns.startedAt, since)))
      .orderBy(desc(jobRuns.startedAt))
      .limit(1);

    if (problems.length === 0 && failedRun === undefined) {
      return { itemsProcessed: 0, detail: 'no data failures detected' };
    }

    // The rule carries the cooldown, so a data-failure alert can be hourly while the
    // daily briefing is daily, without either knowing about the other.
    const [rule] = await ctx.db
      .select({
        id: alertRules.id,
        userId: alertRules.userId,
        cooldownSeconds: alertRules.cooldownSeconds,
        lastFiredAt: alertRules.lastFiredAt,
        isEnabled: alertRules.isEnabled,
      })
      .from(alertRules)
      .where(and(eq(alertRules.ruleType, 'DATA_FAILURE'), eq(alertRules.isEnabled, true)))
      .limit(1);

    if (rule === undefined) {
      return {
        itemsProcessed: 0,
        detail: `${String(problems.length)} problem(s) detected but no enabled DATA_FAILURE rule exists`,
      };
    }

    const subject = `Forex terminal: data pipeline problem (${String(problems.length)} issue(s))`;
    const cooldown = checkCooldown({
      lastFiredAt: rule.lastFiredAt,
      cooldownSeconds: rule.cooldownSeconds,
      now: ctx.now,
    });

    if (!cooldown.allowed) {
      /*
       * Recorded, not merely skipped. At a 15-minute tick a day-long outage would send
       * 96 emails, and the 96th is less informative than the first. But the suppression
       * still has to be visible somewhere, or the gap in alerts is itself unexplained.
       */
      await recordSuppression(ctx.db, {
        alertRuleId: rule.id,
        userId: rule.userId,
        templateName: 'data-failure',
        recipient: deps.to,
        subject,
        reason: cooldown.reason,
      });
      return { itemsProcessed: 0, detail: `alert suppressed: ${cooldown.reason}` };
    }

    const body = [
      'The forex terminal has detected a problem with its own data pipeline.',
      '',
      'This alert is about the SYSTEM, not the market. Everything else in this product',
      'reports a data gap by abstaining visibly; a pipeline that stops entirely produces',
      'no report at all, and a quiet inbox looks the same as a quiet market.',
      '',
      'Problems detected:',
      '',
      ...problems.map((p) => `  - ${p}`),
      '',
      failedRun === undefined ? '' : `Most recent failed job: ${failedRun.jobName}`,
      '',
      `Checked at ${ctx.now.toISOString()}.`,
      `System status: ${deps.appBaseUrl.replace(/\/$/, '')}/`,
    ]
      .filter((l) => l !== '')
      .join('\n');

    const outcome = await notify(ctx.db, deps.providers, {
      reportId: null,
      userId: rule.userId,
      alertRuleId: rule.id,
      templateName: 'data-failure',
      recipient: deps.to,
      from: deps.from,
      subject,
      text: body,
      now: ctx.now,
    });

    // Only after a genuine send: marking the rule fired on a failed send would start a
    // cooldown for an alert nobody received.
    if (outcome.kind === 'SENT') await markRuleFired(ctx.db, rule.id, ctx.now);

    return {
      itemsProcessed: problems.length,
      detail: `${String(problems.length)} problem(s); alert ${outcome.kind.toLowerCase()}`,
    };
  };
}
