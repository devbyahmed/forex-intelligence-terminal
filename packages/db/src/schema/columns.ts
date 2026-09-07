/**
 * Shared column builders.
 *
 * `sourcedColumns()` exists so Principle P3 — every stored fact carries its
 * provenance — cannot be forgotten. A new fact table spreads this helper and gets
 * all eight columns as `NOT NULL`; there is no path to a fact table that merely
 * *happens* to omit `source_timestamp`, because omitting it means not calling the
 * helper, which is visible in review in a way a missing column is not.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  smallint,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '@forex-agent/core';
import { freshnessStatus } from './enums.js';

/** Time-sortable primary key, generated application-side (see core/ids.ts). */
export const primaryId = () => uuid('id').primaryKey().$defaultFn(uuidv7);

/** A foreign-key column pointing at another table's `id`. */
export const fkId = (name: string, ref: () => AnyPgColumn) => uuid(name).references(ref);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * The provenance contract (master PRD §38, ARCHITECTURE §7.1).
 *
 * `sourceUrl` is the only nullable member, and only because some sources publish no
 * individually addressable document. Everything else is required: a value whose
 * origin we cannot state is indistinguishable from one we invented.
 */
export const sourcedColumns = () => ({
  sourceProvider: text('source_provider').notNull(),
  sourceName: text('source_name').notNull(),
  sourceUrl: text('source_url'),
  sourceTier: smallint('source_tier').notNull(),
  /** When the SOURCE says the fact was true or was published. */
  sourceTimestamp: timestamp('source_timestamp', { withTimezone: true, mode: 'date' }).notNull(),
  /** When WE fetched it. */
  retrievedAt: timestamp('retrieved_at', { withTimezone: true, mode: 'date' }).notNull(),
  /** Computed at write time and recomputed at read time — see core/freshness.ts. */
  freshness: freshnessStatus('freshness').notNull(),
  qualityFlags: text('quality_flags')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  ...timestamps(),
});

/**
 * Constraints and indexes that must accompany `sourcedColumns()`.
 * Spread into a table's extra-config array.
 */
export const sourcedConstraints = (
  tableName: string,
  cols: {
    sourceTier: AnyPgColumn;
    sourceTimestamp: AnyPgColumn;
    retrievedAt: AnyPgColumn;
  },
) => [
  check(`${tableName}_source_tier_valid`, sql`${cols.sourceTier} between 1 and 4`),
  // A fact we retrieved before the source published it is a bug in the ingester or
  // a bad provider timestamp — either way it must not enter the store silently.
  // One hour of slack absorbs ordinary clock skew between us and the provider.
  check(
    `${tableName}_retrieved_after_source`,
    sql`${cols.retrievedAt} >= ${cols.sourceTimestamp} - interval '1 hour'`,
  ),
  index(`${tableName}_source_timestamp_idx`).on(cols.sourceTimestamp),
];

/** Monetary and price values. Never float — binary floating point cannot hold 0.1. */
export const priceNumeric = (name: string) => ({ name, precision: 20, scale: 8 }) as const;
