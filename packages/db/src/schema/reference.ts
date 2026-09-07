/**
 * Reference data and configuration.
 *
 * `config_profiles` is what makes an old analysis reproducible: every analysis
 * records the profile it ran under, so re-opening a report from three months ago
 * renders with the weights that were in force then, not today's (master PRD §35, §57).
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { assetClass, importanceLevel, seriesCadence } from './enums.js';
import { primaryId, timestamps } from './columns.js';

export const currencies = pgTable('currencies', {
  /** ISO 4217, plus XAU for gold. */
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  ...timestamps(),
});

export const assets = pgTable(
  'assets',
  {
    id: primaryId(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    assetClass: assetClass('asset_class').notNull(),
    baseCurrency: text('base_currency')
      .notNull()
      .references(() => currencies.code),
    quoteCurrency: text('quote_currency')
      .notNull()
      .references(() => currencies.code),
    /** V1 analyses XAUUSD only; the rest are seeded but inactive until V4. */
    isActive: boolean('is_active').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex('assets_symbol_idx').on(t.symbol)],
);

/** FRED series and their role in the fundamental engine (PRD_V1 §9.2). */
export const macroSeries = pgTable(
  'macro_series',
  {
    id: primaryId(),
    /** Provider series id, e.g. 'DGS10'. */
    seriesId: text('series_id').notNull(),
    provider: text('provider').notNull().default('fred'),
    name: text('name').notNull(),
    /** Semantic role, so the engine reads roles rather than opaque FRED codes. */
    role: text('role').notNull(),
    unit: text('unit').notNull(),
    cadence: seriesCadence('cadence').notNull(),
    /**
     * Weekdays this series actually publishes on, 0 = Sunday .. 6 = Saturday.
     *
     * Freshness measured in calendar hours marks a Friday close read on a Sunday as
     * STALE, which is wrong: markets were shut and Friday's close is the latest value
     * in existence. Two days in seven of degraded confidence on every market-hours
     * series is a persistent distortion, and confidence carries the product's central
     * claim.
     *
     * Age is therefore counted in **publication days elapsed** rather than calendar
     * days. This also handles genuinely weekly series — H.4.1 on Thursdays, initial
     * claims on Thursdays — which a business-day rule alone would not.
     */
    expectedPublicationDays: smallint('expected_publication_days')
      .array()
      .notNull()
      .default(sql`'{1,2,3,4,5}'::smallint[]`),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('macro_series_provider_series_idx').on(t.provider, t.seriesId)],
);

/** News feeds and their credibility tier (master PRD §45). */
export const newsSources = pgTable(
  'news_sources',
  {
    id: primaryId(),
    name: text('name').notNull(),
    feedUrl: text('feed_url').notNull(),
    homepageUrl: text('homepage_url'),
    /** 1 official, 2 major providers, 3 reputable publications, 4 unverified. */
    tier: smallint('tier').notNull(),
    /** Country or issuing institution, where the feed is institution-specific. */
    publisher: text('publisher'),
    isActive: boolean('is_active').notNull().default(true),
    /** Conditional-GET state, so an unchanged feed costs a 304 (ARCHITECTURE §5.3). */
    lastEtag: text('last_etag'),
    lastModified: text('last_modified'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('news_sources_feed_url_idx').on(t.feedUrl),
    index('news_sources_tier_idx').on(t.tier),
  ],
);

/**
 * Curated event importance (master PRD §7).
 *
 * Deterministic and editable, overriding whatever rating a Tier 3 calendar feed
 * asserts. CPI, NFP and FOMC are always HIGH regardless of what a scraped feed says.
 */
export const eventImportanceRules = pgTable(
  'event_importance_rules',
  {
    id: primaryId(),
    country: text('country').notNull(),
    /** Normalised event name, matched case-insensitively after whitespace collapse. */
    eventPattern: text('event_pattern').notNull(),
    importance: importanceLevel('importance').notNull(),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('event_importance_country_pattern_idx').on(t.country, t.eventPattern)],
);

/**
 * Versioned tunables (master PRD §57).
 *
 * The whole profile is one JSON document validated by
 * `assertValidRuntimeConfig` before use, rather than a column per knob — the shape
 * changes every version, and a migration per weight would be absurd.
 */
export const configProfiles = pgTable(
  'config_profiles',
  {
    id: primaryId(),
    name: text('name').notNull(),
    /** Exactly one row may be active; enforced by a partial unique index. */
    isActive: boolean('is_active').notNull().default(false),
    config: jsonb('config').notNull(),
    description: text('description'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('config_profiles_name_idx').on(t.name),
    uniqueIndex('config_profiles_single_active_idx')
      .on(t.isActive)
      .where(sql`${t.isActive}`),
  ],
);
