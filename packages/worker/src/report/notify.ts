/**
 * Storing a report, then sending it.
 *
 * **In that order, and it matters.** The email carries a permanent link to the stored
 * copy, so the copy must exist before the link is sent — otherwise a reader who follows
 * it promptly gets a 404, and a send that fails after storing is recoverable while a
 * store that fails after sending is not.
 *
 * The stored copy is also **immutable**. Re-running a report for a date that already has
 * one returns the existing row rather than rewriting it: the link in an email sent
 * yesterday must resolve to what was sent yesterday, not to what the pipeline would
 * produce now (master §35). A report is a record of what was said, and a record that
 * changes is not one.
 */

import { and, desc, eq, gte } from 'drizzle-orm';
import { uuidv7 } from '@forex-agent/core';
import {
  alertRules,
  notifications,
  reportAssets,
  reports,
  type Database,
} from '@forex-agent/db';
import type { EmailProvider, EmailResult } from '@forex-agent/providers';
import { sendWithFallback } from '@forex-agent/providers';
import type { RenderedReport } from './render.js';

export interface StoredReport {
  readonly id: string;
  readonly reportDate: string;
  /** True when this run created it; false when a report for the date already existed. */
  readonly created: boolean;
}

/**
 * Store a report, or return the one already stored for that date.
 *
 * The unique index on `(report_date, kind)` is what makes this safe under a retry or a
 * duplicated tick: `onConflictDoNothing` plus a read-back means two concurrent runs
 * produce one report and both learn its id, rather than one of them failing or — worse
 * — overwriting the copy an email already points at.
 */
export async function storeReport(
  db: Database,
  params: {
    readonly rendered: RenderedReport;
    readonly assetId: string;
    readonly analysisId: string;
    readonly kind?: string;
  },
): Promise<StoredReport> {
  const kind = params.kind ?? 'DAILY_BRIEFING';
  const { rendered } = params;

  return db.transaction(async (tx) => {
    const id = uuidv7();
    const inserted = await tx
      .insert(reports)
      .values({
        id,
        reportDate: rendered.payload.reportDate,
        kind,
        title: rendered.title,
        contentHtml: rendered.html,
        contentText: rendered.text,
        payload: rendered.payload,
      })
      .onConflictDoNothing({ target: [reports.reportDate, reports.kind] })
      .returning({ id: reports.id });

    const existing = inserted[0];
    if (existing === undefined) {
      // Already stored. Return the original — never rewrite it.
      const [found] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(and(eq(reports.reportDate, rendered.payload.reportDate), eq(reports.kind, kind)))
        .limit(1);

      if (found === undefined) {
        throw new Error(
          `Report for ${rendered.payload.reportDate} conflicted on insert but could not be read ` +
            'back. This should be impossible and suggests the unique index has changed.',
        );
      }
      return { id: found.id, reportDate: rendered.payload.reportDate, created: false };
    }

    await tx
      .insert(reportAssets)
      .values({ reportId: existing.id, assetId: params.assetId, analysisId: params.analysisId })
      .onConflictDoNothing();

    return { id: existing.id, reportDate: rendered.payload.reportDate, created: true };
  });
}

export type NotifyOutcome =
  | { readonly kind: 'SENT'; readonly notificationId: string; readonly providerMessageId: string | null }
  | { readonly kind: 'SUPPRESSED'; readonly notificationId: string; readonly reason: string }
  | { readonly kind: 'FAILED'; readonly notificationId: string; readonly reason: string };

export interface NotifyParams {
  readonly reportId: string | null;
  readonly userId: string | null;
  readonly alertRuleId: string | null;
  readonly templateName: string;
  readonly recipient: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly now: Date;
}

/**
 * Send, recording the attempt whatever the outcome.
 *
 * Every attempt is written to `notifications` — sent, suppressed or failed — before the
 * result is returned. Silence has to be explainable: "no email arrived" and "an email
 * was suppressed by a cooldown" and "the provider refused it" are three different
 * situations, and without a row they are indistinguishable from each other and from a
 * job that never ran.
 */
export async function notify(
  db: Database,
  providers: readonly EmailProvider[],
  params: NotifyParams,
): Promise<NotifyOutcome> {
  const notificationId = uuidv7();

  const { result } = await sendWithFallback(providers, {
    to: params.recipient,
    from: params.from,
    subject: params.subject,
    text: params.text,
    ...(params.html === undefined ? {} : { html: params.html }),
  });

  await db.insert(notifications).values({
    id: notificationId,
    userId: params.userId,
    alertRuleId: params.alertRuleId,
    reportId: params.reportId,
    channel: 'EMAIL',
    status: statusFor(result),
    templateName: params.templateName,
    subject: params.subject,
    recipient: params.recipient,
    providerId: result.providerId,
    providerMessageId: result.kind === 'SENT' ? result.messageId : null,
    errorCode: result.kind === 'SENT' ? null : result.kind,
    errorMessage: result.kind === 'SENT' ? null : result.reason.slice(0, 500),
    sentAt: result.kind === 'SENT' ? params.now : null,
  });

  if (result.kind === 'SENT') {
    return { kind: 'SENT', notificationId, providerMessageId: result.messageId };
  }
  return { kind: 'FAILED', notificationId, reason: result.reason };
}

function statusFor(result: EmailResult): 'SENT' | 'FAILED' {
  return result.kind === 'SENT' ? 'SENT' : 'FAILED';
}

// ── Cooldown ────────────────────────────────────────────────────────────────

export interface CooldownDecision {
  readonly allowed: boolean;
  /** Present when suppressed, for the notification row and the operator. */
  readonly reason: string;
  readonly nextAllowedAt: Date | null;
}

/**
 * Whether an alert may fire, given when it last did.
 *
 * **A persistent failure must not become ninety-six emails.** The 15-minute tick means
 * an ingestion problem that lasts a day would otherwise send one alert per tick, and
 * the ninety-sixth is not more informative than the first — it is less, because by then
 * nobody is reading them.
 *
 * The window is per rule and stored on the rule, so a data-failure alert can be hourly
 * while a daily briefing is daily, without either knowing about the other.
 */
export function checkCooldown(params: {
  readonly lastFiredAt: Date | null;
  readonly cooldownSeconds: number;
  readonly now: Date;
}): CooldownDecision {
  if (params.lastFiredAt === null) {
    return { allowed: true, reason: '', nextAllowedAt: null };
  }

  const elapsedMs = params.now.getTime() - params.lastFiredAt.getTime();
  const cooldownMs = params.cooldownSeconds * 1000;

  if (elapsedMs >= cooldownMs) {
    return { allowed: true, reason: '', nextAllowedAt: null };
  }

  const nextAllowedAt = new Date(params.lastFiredAt.getTime() + cooldownMs);
  const minutes = Math.ceil((cooldownMs - elapsedMs) / 60_000);
  return {
    allowed: false,
    // Says when, not just "suppressed": an operator seeing a gap in alerts needs to
    // know whether to wait or to investigate.
    reason:
      `Suppressed by a ${String(Math.round(params.cooldownSeconds / 60))}-minute cooldown; ` +
      `last fired ${String(Math.floor(elapsedMs / 60_000))} minutes ago, next allowed in ` +
      `${String(minutes)} minutes.`,
    nextAllowedAt,
  };
}

/**
 * Record a suppression as a notification row.
 *
 * A suppressed alert is still an event. Writing it means the absence of an email is
 * explainable after the fact — otherwise a quiet inbox during an outage looks identical
 * to a working system, which is the same confusion the abstention model exists to
 * prevent, one layer out.
 */
export async function recordSuppression(
  db: Database,
  params: {
    readonly alertRuleId: string;
    readonly userId: string | null;
    readonly templateName: string;
    readonly recipient: string;
    readonly subject: string;
    readonly reason: string;
  },
): Promise<string> {
  const id = uuidv7();
  await db.insert(notifications).values({
    id,
    userId: params.userId,
    alertRuleId: params.alertRuleId,
    channel: 'EMAIL',
    status: 'SUPPRESSED',
    templateName: params.templateName,
    subject: params.subject,
    recipient: params.recipient,
    suppressedReason: params.reason,
  });
  return id;
}

/** Mark a rule as having fired, so the next cooldown window starts from now. */
export async function markRuleFired(
  db: Database,
  alertRuleId: string,
  now: Date,
): Promise<void> {
  await db.update(alertRules).set({ lastFiredAt: now }).where(eq(alertRules.id, alertRuleId));
}

/** Recent notifications, for the system-status panel and the archive. */
export async function recentNotifications(
  db: Database,
  since: Date,
  limit = 50,
): Promise<
  readonly {
    readonly status: string;
    readonly templateName: string;
    readonly subject: string | null;
    readonly suppressedReason: string | null;
    readonly errorMessage: string | null;
    readonly createdAt: Date;
  }[]
> {
  return db
    .select({
      status: notifications.status,
      templateName: notifications.templateName,
      subject: notifications.subject,
      suppressedReason: notifications.suppressedReason,
      errorMessage: notifications.errorMessage,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(gte(notifications.createdAt, since))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}


