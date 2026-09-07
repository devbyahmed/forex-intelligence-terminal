/**
 * Fact tables — everything the system learned from the outside world.
 *
 * Every table here spreads `sourcedColumns()`. That is the mechanical expression of
 * Principle P3: a value in this schema without a source, a source timestamp and a
 * retrieval time cannot be inserted, because the columns are `NOT NULL`.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { importanceLevel, newsCategory } from './enums.js';
import { fkId, primaryId, sourcedColumns, sourcedConstraints, timestamps } from './columns.js';
import { assets, macroSeries } from './reference.js';

// ── Market data ─────────────────────────────────────────────────────────────

/**
 * Spot quotes.
 *
 * `instrumentKind` is not decoration. The only free source that resolves is Yahoo's
 * `GC=F`, which is COMEX **futures**, not spot XAUUSD. Storing that as though it
 * were spot would be exactly the quiet misrepresentation Amendment A2 exists to
 * prevent, so the distinction is a column and the UI renders it.
 */
export const marketQuotes = pgTable(
  'market_quotes',
  {
    id: primaryId(),
    assetId: fkId('asset_id', () => assets.id)
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    price: numeric('price', { precision: 20, scale: 8 }).notNull(),
    /** 'SPOT' | 'FUTURES_PROXY' | 'FIXING' */
    instrumentKind: text('instrument_kind').notNull(),
    /** The provider's own symbol, e.g. 'GC=F'. Shown in provenance. */
    providerSymbol: text('provider_symbol'),
    ...sourcedColumns(),
  },
  (t) => [
    ...sourcedConstraints('market_quotes', t),
    index('market_quotes_asset_time_idx').on(t.assetId, t.sourceTimestamp.desc()),
    check('market_quotes_price_positive', sql`${t.price} > 0`),
  ],
);

/** OHLCV. V1 ingests daily only; V2 adds intraday (see LIMITS.md §1 first). */
export const marketCandles = pgTable(
  'market_candles',
  {
    id: primaryId(),
    assetId: fkId('asset_id', () => assets.id)
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    timeframe: text('timeframe').notNull(),
    openTime: timestamp('open_time', { withTimezone: true, mode: 'date' }).notNull(),
    open: numeric('open', { precision: 20, scale: 8 }).notNull(),
    high: numeric('high', { precision: 20, scale: 8 }).notNull(),
    low: numeric('low', { precision: 20, scale: 8 }).notNull(),
    close: numeric('close', { precision: 20, scale: 8 }).notNull(),
    volume: numeric('volume', { precision: 24, scale: 8 }),
    instrumentKind: text('instrument_kind').notNull(),
    ...sourcedColumns(),
  },
  (t) => [
    ...sourcedConstraints('market_candles', t),
    // Two providers may both supply the same bar; keep both, provenanced separately,
    // rather than silently preferring one.
    uniqueIndex('market_candles_unique_idx').on(
      t.assetId,
      t.timeframe,
      t.openTime,
      t.sourceProvider,
    ),
    index('market_candles_asset_tf_time_idx').on(t.assetId, t.timeframe, t.openTime.desc()),
    // A bar whose high is below its low, or which fails to contain its own open and
    // close, is corrupt. Catching it here stops it reaching the technical engine.
    check(
      'market_candles_ohlc_coherent',
      sql`${t.high} >= ${t.low}
        and ${t.high} >= ${t.open} and ${t.high} >= ${t.close}
        and ${t.low} <= ${t.open} and ${t.low} <= ${t.close}
        and ${t.low} > 0`,
    ),
  ],
);

// ── Macro ───────────────────────────────────────────────────────────────────

/**
 * Macro observations, with revision vintages.
 *
 * A revision is a new row, never an overwrite. Overwriting would make an old
 * analysis unreproducible — it would re-render citing a number that did not exist
 * when it ran.
 */
export const macroObservations = pgTable(
  'macro_observations',
  {
    id: primaryId(),
    seriesRowId: fkId('series_row_id', () => macroSeries.id)
      .notNull()
      .references(() => macroSeries.id, { onDelete: 'cascade' }),
    /** The date the observation describes, not when it was published. */
    observationDate: date('observation_date', { mode: 'string' }).notNull(),
    /** Null is meaningful in FRED: the series exists but has no value that period. */
    value: numeric('value', { precision: 24, scale: 8 }),
    /** Publication vintage; a later vintage supersedes an earlier one for display. */
    vintage: timestamp('vintage', { withTimezone: true, mode: 'date' }).notNull(),
    ...sourcedColumns(),
  },
  (t) => [
    ...sourcedConstraints('macro_observations', t),
    uniqueIndex('macro_observations_unique_idx').on(t.seriesRowId, t.observationDate, t.vintage),
    index('macro_observations_series_date_idx').on(t.seriesRowId, t.observationDate.desc()),
  ],
);

// ── Economic calendar ───────────────────────────────────────────────────────

/** A recurring event definition, e.g. "US CPI m/m". */
export const economicEvents = pgTable(
  'economic_events',
  {
    id: primaryId(),
    country: text('country').notNull(),
    currency: text('currency').notNull(),
    name: text('name').notNull(),
    /** Lowercased, whitespace-collapsed name; the dedupe key. */
    normalisedName: text('normalised_name').notNull(),
    importance: importanceLevel('importance').notNull(),
    /** True when importance came from the curated rules rather than a Tier 3 feed. */
    importanceIsCurated: boolean('importance_is_curated').notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex('economic_events_unique_idx').on(t.country, t.normalisedName)],
);

/**
 * One occurrence of an event.
 *
 * The actual and the forecast come from **different sources at different tiers** —
 * FRED (Tier 1) publishes the actual; only a Tier 3 feed publishes consensus. Fusing
 * them into one provenance would misrepresent the forecast as authoritative, so the
 * forecast carries its own source columns and the UI labels them separately.
 */
export const economicReleases = pgTable(
  'economic_releases',
  {
    id: primaryId(),
    eventId: fkId('event_id', () => economicEvents.id)
      .notNull()
      .references(() => economicEvents.id, { onDelete: 'cascade' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The source's local time as published, retained for display fidelity. */
    scheduledLocalTime: text('scheduled_local_time'),

    previousValue: numeric('previous_value', { precision: 24, scale: 8 }),
    actualValue: numeric('actual_value', { precision: 24, scale: 8 }),
    actualReportedAt: timestamp('actual_reported_at', { withTimezone: true, mode: 'date' }),

    /** Consensus forecast — separately provenanced, typically Tier 3. */
    forecastValue: numeric('forecast_value', { precision: 24, scale: 8 }),
    forecastSourceProvider: text('forecast_source_provider'),
    forecastSourceName: text('forecast_source_name'),
    forecastSourceUrl: text('forecast_source_url'),
    forecastSourceTier: integer('forecast_source_tier'),
    forecastRetrievedAt: timestamp('forecast_retrieved_at', { withTimezone: true, mode: 'date' }),

    /** actual − forecast. Null whenever either side is missing — never zero. */
    surprise: numeric('surprise', { precision: 24, scale: 8 }),
    /** Standardised surprise; null when fewer than the configured minimum history. */
    surpriseZ: real('surprise_z'),

    /** Raw unit strings ('%', 'K'), kept so a value is never silently rescaled. */
    unit: text('unit'),
    ...sourcedColumns(),
  },
  (t) => [
    ...sourcedConstraints('economic_releases', t),
    uniqueIndex('economic_releases_unique_idx').on(t.eventId, t.scheduledAt),
    index('economic_releases_scheduled_idx').on(t.scheduledAt),
    check(
      'economic_releases_forecast_tier_valid',
      sql`${t.forecastSourceTier} is null or ${t.forecastSourceTier} between 1 and 4`,
    ),
    // A forecast value without its provenance would be indistinguishable from an
    // official figure once rendered.
    check(
      'economic_releases_forecast_provenanced',
      sql`${t.forecastValue} is null
        or (${t.forecastSourceProvider} is not null and ${t.forecastSourceTier} is not null)`,
    ),
  ],
);

// ── News ────────────────────────────────────────────────────────────────────

export const newsArticles = pgTable(
  'news_articles',
  {
    id: primaryId(),
    /** Tracking parameters stripped, redirects resolved. The dedupe key. */
    canonicalUrl: text('canonical_url').notNull(),
    /** SHA-256 of title+body, catching the same story republished at a new URL. */
    contentHash: text('content_hash').notNull(),
    title: text('title').notNull(),
    /**
     * Body stored **truncated** — the canonical URL is kept for the full text.
     * Storing bodies in full roughly triples news storage against a 0.5 GB cap
     * (LIMITS.md §1).
     */
    summary: text('summary'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull(),
    category: newsCategory('category').notNull().default('OTHER'),
    /** Version of the deterministic ruleset that assigned the category. */
    classifierVersion: text('classifier_version').notNull(),
    ...sourcedColumns(),
  },
  (t) => [
    ...sourcedConstraints('news_articles', t),
    uniqueIndex('news_articles_canonical_url_idx').on(t.canonicalUrl),
    index('news_articles_content_hash_idx').on(t.contentHash),
    index('news_articles_published_idx').on(t.publishedAt.desc()),
    index('news_articles_category_published_idx').on(t.category, t.publishedAt.desc()),
  ],
);

export const newsArticleAssets = pgTable(
  'news_article_assets',
  {
    articleId: fkId('article_id', () => newsArticles.id)
      .notNull()
      .references(() => newsArticles.id, { onDelete: 'cascade' }),
    assetId: fkId('asset_id', () => assets.id)
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    /** Currency the article bears on, when narrower than the asset. */
    currency: text('currency'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('news_article_assets_pk').on(t.articleId, t.assetId),
    index('news_article_assets_asset_idx').on(t.assetId),
  ],
);

/**
 * Deterministic sentiment (PRD_V1 §8.3).
 *
 * Produced by a lexicon, not by the AI, so the same article always scores the same
 * and the score can be inspected. `matchedTerms` is what makes it auditable — a
 * number with no visible derivation is not evidence.
 */
export const newsSentiment = pgTable(
  'news_sentiment',
  {
    id: primaryId(),
    articleId: fkId('article_id', () => newsArticles.id)
      .notNull()
      .references(() => newsArticles.id, { onDelete: 'cascade' }),
    /** [-1, 1]. */
    polarity: real('polarity').notNull(),
    positiveCount: integer('positive_count').notNull().default(0),
    negativeCount: integer('negative_count').notNull().default(0),
    matchedTerms: text('matched_terms')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Lexicon + algorithm version, so an old score stays explainable. */
    methodVersion: text('method_version').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('news_sentiment_article_method_idx').on(t.articleId, t.methodVersion),
    check('news_sentiment_polarity_range', sql`${t.polarity} between -1 and 1`),
  ],
);
