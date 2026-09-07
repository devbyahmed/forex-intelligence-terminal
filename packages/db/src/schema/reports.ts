/**
 * Reports and notifications (master PRD §26, §28, §29, §35).
 *
 * A report is stored before it is sent, so the emailed content and the stored copy
 * cannot diverge — the permanent link in the email always resolves to exactly what
 * was sent.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { notificationChannel, notificationStatus } from './enums.js';
import { fkId, primaryId, timestamps } from './columns.js';
import { analyses } from './analysis.js';
import { assets } from './reference.js';
import { users } from './identity.js';

export const reports = pgTable(
  'reports',
  {
    id: primaryId(),
    /** The trading day the report covers, in UTC. */
    reportDate: text('report_date').notNull(),
    kind: text('kind').notNull().default('DAILY_BRIEFING'),
    title: text('title').notNull(),
    /** Immutable rendered content — the permanent record behind the emailed link. */
    contentHtml: text('content_html').notNull(),
    contentText: text('content_text').notNull(),
    /** Structured payload the render was produced from. */
    payload: jsonb('payload').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('reports_date_kind_idx').on(t.reportDate, t.kind),
    index('reports_generated_idx').on(t.generatedAt.desc()),
  ],
);

/** Which analyses a report cited, so a stored report reopens exactly as generated. */
export const reportAssets = pgTable(
  'report_assets',
  {
    reportId: fkId('report_id', () => reports.id)
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    assetId: fkId('asset_id', () => assets.id)
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    analysisId: fkId('analysis_id', () => analyses.id).references(() => analyses.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('report_assets_pk').on(t.reportId, t.assetId)],
);

/** Alert rules (master PRD §29). Channel-agnostic from V1 so WhatsApp drops in later. */
export const alertRules = pgTable(
  'alert_rules',
  {
    id: primaryId(),
    userId: fkId('user_id', () => users.id)
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'DAILY_BRIEFING' | 'DATA_FAILURE' | 'BIAS_CHANGE' | 'EVENT_RISK' | ... */
    ruleType: text('rule_type').notNull(),
    channel: notificationChannel('channel').notNull().default('EMAIL'),
    isEnabled: boolean('is_enabled').notNull().default(true),
    /** Thresholds and quiet hours; shape depends on ruleType. */
    parameters: jsonb('parameters').notNull().default(sql`'{}'::jsonb`),
    /** Suppression window, so one persistent failure does not become 96 emails. */
    cooldownSeconds: integer('cooldown_seconds').notNull().default(3600),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('alert_rules_user_type_channel_idx').on(t.userId, t.ruleType, t.channel)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    userId: fkId('user_id', () => users.id).references(() => users.id, { onDelete: 'set null' }),
    alertRuleId: fkId('alert_rule_id', () => alertRules.id).references(() => alertRules.id, {
      onDelete: 'set null',
    }),
    reportId: fkId('report_id', () => reports.id).references(() => reports.id, {
      onDelete: 'set null',
    }),
    channel: notificationChannel('channel').notNull(),
    status: notificationStatus('status').notNull().default('PENDING'),
    templateName: text('template_name').notNull(),
    subject: text('subject'),
    recipient: text('recipient').notNull(),
    /** Provider message id, for tracing a delivery back to the vendor's logs. */
    providerMessageId: text('provider_message_id'),
    providerId: text('provider_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    attempt: integer('attempt').notNull().default(1),
    /** Set when suppressed by a cooldown, so silence is explainable. */
    suppressedReason: text('suppressed_reason'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    index('notifications_status_idx').on(t.status),
    index('notifications_created_idx').on(t.createdAt.desc()),
  ],
);
