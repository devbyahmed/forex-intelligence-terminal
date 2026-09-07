/**
 * Operational tables (master PRD §42, §52).
 */

import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';

/**
 * Structured application log, for events worth keeping beyond stdout.
 *
 * Redacted before insert. Needs a retention window before V4 — tracked as an open
 * item in LIMITS.md §7.
 */
export const systemLogs = pgTable(
  'system_logs',
  {
    id: primaryId(),
    level: text('level').notNull(),
    event: text('event').notNull(),
    message: text('message').notNull(),
    /** Correlates a log line to the job or request that produced it. */
    correlationId: text('correlation_id'),
    context: jsonb('context'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index('system_logs_occurred_idx').on(t.occurredAt.desc()),
    index('system_logs_level_time_idx').on(t.level, t.occurredAt.desc()),
    index('system_logs_event_idx').on(t.event),
  ],
);

/**
 * Data-quality incidents (master PRD §52).
 *
 * Suspicious data is flagged and recorded rather than dropped. A silently discarded
 * anomaly is indistinguishable from data that never arrived, which makes debugging
 * an ingestion bug guesswork.
 */
export const dataQualityIncidents = pgTable(
  'data_quality_incidents',
  {
    id: primaryId(),
    /** Which table and row the incident concerns. */
    subjectTable: text('subject_table').notNull(),
    subjectId: text('subject_id'),
    providerId: text('provider_id'),
    flag: text('flag').notNull(),
    detail: text('detail').notNull(),
    /** The offending value, kept for inspection. */
    observedValue: jsonb('observed_value'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    detectedAt: timestamp('detected_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index('data_quality_subject_idx').on(t.subjectTable, t.detectedAt.desc()),
    index('data_quality_flag_idx').on(t.flag),
    index('data_quality_unresolved_idx')
      .on(t.detectedAt)
      .where(sql`${t.resolvedAt} is null`),
  ],
);
