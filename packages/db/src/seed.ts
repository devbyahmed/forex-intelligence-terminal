/**
 * Seed data.
 *
 * Idempotent: every insert is an upsert on a natural key, so running it repeatedly
 * against a live database is safe and is the intended way to roll out a new series
 * or feed.
 *
 * Only XAUUSD is seeded active. The forex pairs exist as rows from V1 so that V4 is
 * a configuration change rather than a migration, but an inactive asset is never
 * ingested or analysed.
 */

import { eq, notInArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  assets,
  configProfiles,
  currencies,
  eventImportanceRules,
  macroSeries,
  newsSources,
} from './schema/index.js';

export const SEED_CURRENCIES: readonly { code: string; name: string }[] = [
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'Pound Sterling' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'XAU', name: 'Gold (troy ounce)' },
];

export const SEED_ASSETS = [
  { symbol: 'XAUUSD', name: 'Gold / US Dollar', assetClass: 'METAL', base: 'XAU', quote: 'USD', active: true, order: 0 },
  { symbol: 'EURUSD', name: 'Euro / US Dollar', assetClass: 'FX', base: 'EUR', quote: 'USD', active: false, order: 1 },
  { symbol: 'GBPUSD', name: 'Pound Sterling / US Dollar', assetClass: 'FX', base: 'GBP', quote: 'USD', active: false, order: 2 },
  { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', assetClass: 'FX', base: 'USD', quote: 'JPY', active: false, order: 3 },
  { symbol: 'USDCHF', name: 'US Dollar / Swiss Franc', assetClass: 'FX', base: 'USD', quote: 'CHF', active: false, order: 4 },
  { symbol: 'AUDUSD', name: 'Australian Dollar / US Dollar', assetClass: 'FX', base: 'AUD', quote: 'USD', active: false, order: 5 },
  { symbol: 'NZDUSD', name: 'New Zealand Dollar / US Dollar', assetClass: 'FX', base: 'NZD', quote: 'USD', active: false, order: 6 },
  { symbol: 'USDCAD', name: 'US Dollar / Canadian Dollar', assetClass: 'FX', base: 'USD', quote: 'CAD', active: false, order: 7 },
] as const;

/**
 * The twelve FRED series behind factors F1–F7 (PRD_V1 §8.5.2).
 *
 * `cadence` and `expectedPublicationDays` are both measured, not assumed. The audit
 * on 2026-08-30 read each series' **first-release** dates (FRED `output_type=4` with
 * an explicit realtime range) rather than its revision history, so the publication
 * weekday and lag below are the dates the figures actually first appeared.
 *
 * The two fields answer different questions and must not be conflated:
 *
 *  - `cadence` is how often a new figure is *published*, and selects the freshness
 *    threshold set.
 *  - `expectedPublicationDays` is *which weekdays* it appears on, and converts
 *    wall-clock age into publication-day age.
 *
 * `DTWEXBGS` is the case that shows why both are needed. Its observations are daily
 * — 64 one-day gaps in 80 — but they are released in a single Monday batch, 75 times
 * out of 80, at a median lag of 5 days. It is a daily *series* with a weekly
 * *publication*, and freshness is a question about publication.
 */
export const SEED_MACRO_SERIES = [
  // Published Mondays ×75, Tuesdays ×5 (Monday holidays), median lag 5d, max 10d.
  // WEEKLY + [Mon] together mean "one release a week, on Mondays"; the previous
  // WEEKLY-alone classification got the right answer for the wrong reason.
  { seriesId: 'DTWEXBGS', name: 'Nominal Broad U.S. Dollar Index', role: 'usd_index', unit: 'index', cadence: 'WEEKLY', expectedPublicationDays: [1] },
  // H.15 family: published Mon–Fri, median lag 1d, max 4d over holiday weekends.
  { seriesId: 'DFII10', name: '10-Year TIPS Constant Maturity (real yield)', role: 'real_yield_10y', unit: 'percent', cadence: 'DAILY', expectedPublicationDays: [1, 2, 3, 4, 5] },
  { seriesId: 'DGS10', name: '10-Year Treasury Constant Maturity', role: 'nominal_yield_10y', unit: 'percent', cadence: 'DAILY', expectedPublicationDays: [1, 2, 3, 4, 5] },
  { seriesId: 'DGS2', name: '2-Year Treasury Constant Maturity', role: 'nominal_yield_2y', unit: 'percent', cadence: 'DAILY', expectedPublicationDays: [1, 2, 3, 4, 5] },
  // Uniquely, DFF carries observations for all seven days — the effective rate is
  // defined every calendar day — but still publishes Mon–Fri, Tuesday heaviest
  // because Monday's release covers the weekend. The observation calendar and the
  // publication calendar genuinely differ here, and only the latter belongs below.
  { seriesId: 'DFF', name: 'Effective Federal Funds Rate', role: 'policy_rate', unit: 'percent', cadence: 'DAILY', expectedPublicationDays: [1, 2, 3, 4, 5] },
  // CPI: published Tue–Fri, never a Monday in 11 releases, median lag 43 days.
  { seriesId: 'CPIAUCSL', name: 'CPI for All Urban Consumers', role: 'cpi_headline', unit: 'index', cadence: 'MONTHLY', expectedPublicationDays: [1, 2, 3, 4, 5] },
  { seriesId: 'CPILFESL', name: 'CPI Less Food and Energy (core)', role: 'cpi_core', unit: 'index', cadence: 'MONTHLY', expectedPublicationDays: [1, 2, 3, 4, 5] },
  // Employment situation: Friday ×6 of 11 (the first-Friday convention), the rest
  // Tue–Thu. Median lag 37 days. Narrowing this to [Fri] would misread the other
  // five as late, so the business-day set is the honest encoding.
  { seriesId: 'PAYEMS', name: 'All Employees, Total Nonfarm', role: 'nonfarm_payrolls', unit: 'thousands', cadence: 'MONTHLY', expectedPublicationDays: [1, 2, 3, 4, 5] },
  { seriesId: 'UNRATE', name: 'Unemployment Rate', role: 'unemployment_rate', unit: 'percent', cadence: 'MONTHLY', expectedPublicationDays: [1, 2, 3, 4, 5] },
  // Thursdays ×48 of 51, observation dated the week-ending Saturday every time,
  // 7-day gaps ×50. The cleanest weekly series in the set.
  { seriesId: 'ICSA', name: 'Initial Claims', role: 'initial_claims', unit: 'count', cadence: 'WEEKLY', expectedPublicationDays: [4] },
  // Same-day publication (median lag 0), Mon–Fri.
  { seriesId: 'VIXCLS', name: 'CBOE Volatility Index', role: 'volatility_index', unit: 'index', cadence: 'DAILY', expectedPublicationDays: [1, 2, 3, 4, 5] },
  { seriesId: 'BAMLH0A0HYM2', name: 'ICE BofA US High Yield Option-Adjusted Spread', role: 'high_yield_spread', unit: 'percent', cadence: 'DAILY', expectedPublicationDays: [1, 2, 3, 4, 5] },
] as const;

/**
 * Tier 1 official feeds — they carry the most weight in credibility scoring.
 *
 * **Every URL here was verified reachable on 2026-08-30.** Two feeds from the
 * original design were removed after failing empirically rather than left in to fail
 * silently in production:
 *
 *  - `bls.gov/feed/*` returns **403** to every non-browser request (all four
 *    candidate paths tried). BLS blocks automated clients outright.
 *  - `home.treasury.gov/rss/press.xml` returns **404**; the feed has been retired and
 *    no replacement path responds.
 *
 * Losing BLS as a *news* source does not lose its numbers: CPI, NFP and unemployment
 * reach the system through FRED in the macro and calendar pipelines, at Tier 1. What
 * is lost is the press-release narrative around them. BEA and Census below restore
 * official US coverage for GDP, personal income, retail sales and trade.
 */
export const SEED_NEWS_SOURCES = [
  { name: 'Federal Reserve — Press Releases', feedUrl: 'https://www.federalreserve.gov/feeds/press_all.xml', homepageUrl: 'https://www.federalreserve.gov', tier: 1, publisher: 'Federal Reserve' },
  { name: 'Federal Reserve — Monetary Policy', feedUrl: 'https://www.federalreserve.gov/feeds/press_monetary.xml', homepageUrl: 'https://www.federalreserve.gov', tier: 1, publisher: 'Federal Reserve' },
  { name: 'Federal Reserve — Speeches', feedUrl: 'https://www.federalreserve.gov/feeds/speeches.xml', homepageUrl: 'https://www.federalreserve.gov', tier: 1, publisher: 'Federal Reserve' },
  { name: 'Federal Reserve — Testimony', feedUrl: 'https://www.federalreserve.gov/feeds/testimony.xml', homepageUrl: 'https://www.federalreserve.gov', tier: 1, publisher: 'Federal Reserve' },
  { name: 'European Central Bank — Press', feedUrl: 'https://www.ecb.europa.eu/rss/press.html', homepageUrl: 'https://www.ecb.europa.eu', tier: 1, publisher: 'European Central Bank' },
  { name: 'Bank of England — News', feedUrl: 'https://www.bankofengland.co.uk/rss/news', homepageUrl: 'https://www.bankofengland.co.uk', tier: 1, publisher: 'Bank of England' },
  { name: 'Bank of Japan — What\'s New', feedUrl: 'https://www.boj.or.jp/en/rss/whatsnew.xml', homepageUrl: 'https://www.boj.or.jp/en/', tier: 1, publisher: 'Bank of Japan' },
  { name: 'U.S. Bureau of Economic Analysis', feedUrl: 'https://apps.bea.gov/rss/rss.xml', homepageUrl: 'https://www.bea.gov', tier: 1, publisher: 'Bureau of Economic Analysis' },
  { name: 'U.S. Census Bureau — Economic Indicators', feedUrl: 'https://www.census.gov/economic-indicators/indicator.xml', homepageUrl: 'https://www.census.gov', tier: 1, publisher: 'US Census Bureau' },

  // ── Tier 2: major financial news, HTTPS only ─────────────────────────────
  //
  // Added 2026-08-30 after the Tier 1 feeds were measured at ~0.5 gold-relevant
  // articles/day — too few for a sentiment aggregate. Each was verified for
  // reachability, parse yield, publication frequency AND terms of use.
  //
  // Dow Jones terms permit 'individual, personal and non-commercial use' of RSS
  // content explicitly, which is exactly this tool. That permission lapses if this
  // ever becomes commercial — the same caveat as Vercel Hobby.
  { name: 'MarketWatch — Top Stories', feedUrl: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', homepageUrl: 'https://www.marketwatch.com', tier: 2, publisher: 'MarketWatch (Dow Jones)' },
  // CNBC publishes a public RSS directory and its terms of service, read in full,
  // contain no restriction on RSS consumption. A verified absence, not an
  // unverifiable one.
  { name: 'CNBC — Economy', feedUrl: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', homepageUrl: 'https://www.cnbc.com', tier: 2, publisher: 'CNBC' },
  { name: 'CNBC — Finance', feedUrl: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', homepageUrl: 'https://www.cnbc.com', tier: 2, publisher: 'CNBC' },
] as const;

/**
 * Curated event importance (master PRD §7).
 *
 * These override whatever a Tier 3 calendar feed asserts. CPI, NFP and FOMC are
 * always HIGH; letting a scraped rating downgrade them would silently disable the
 * event-risk warning that caps confidence before a major release.
 */
export const SEED_IMPORTANCE_RULES = [
  // Both vocabularies must be covered. FRED names the release 'Consumer Price
  // Index' and ForexFactory calls it 'CPI m/m'; 'cpi' is not a substring of the
  // former, so a rules table written against one feed silently fails on the other.
  // Observed on the first live run: CPI was not classified HIGH.
  { country: 'US', eventPattern: 'cpi', importance: 'HIGH', notes: 'Headline CPI — primary rate-expectation driver' },
  { country: 'US', eventPattern: 'consumer price index', importance: 'HIGH', notes: 'FRED release name' },
  { country: 'US', eventPattern: 'employment situation', importance: 'HIGH', notes: 'FRED release name for NFP' },
  { country: 'US', eventPattern: 'gross domestic product', importance: 'HIGH', notes: 'FRED release name' },
  { country: 'US', eventPattern: 'fomc press release', importance: 'HIGH', notes: 'FRED release name' },
  { country: 'US', eventPattern: 'unemployment insurance weekly claims report', importance: 'MEDIUM', notes: 'FRED release name' },
  { country: 'US', eventPattern: 'core cpi', importance: 'HIGH', notes: null },
  { country: 'US', eventPattern: 'non-farm employment change', importance: 'HIGH', notes: 'NFP' },
  { country: 'US', eventPattern: 'nonfarm payrolls', importance: 'HIGH', notes: 'NFP' },
  { country: 'US', eventPattern: 'federal funds rate', importance: 'HIGH', notes: 'FOMC decision' },
  { country: 'US', eventPattern: 'fomc statement', importance: 'HIGH', notes: null },
  { country: 'US', eventPattern: 'fomc meeting minutes', importance: 'HIGH', notes: null },
  { country: 'US', eventPattern: 'fed chair powell speaks', importance: 'HIGH', notes: null },
  { country: 'US', eventPattern: 'ppi', importance: 'MEDIUM', notes: null },
  { country: 'US', eventPattern: 'unemployment rate', importance: 'HIGH', notes: null },
  { country: 'US', eventPattern: 'average hourly earnings', importance: 'HIGH', notes: null },
  { country: 'US', eventPattern: 'unemployment claims', importance: 'MEDIUM', notes: null },
  { country: 'US', eventPattern: 'advance gdp', importance: 'HIGH', notes: null },
  { country: 'US', eventPattern: 'retail sales', importance: 'MEDIUM', notes: null },
  { country: 'US', eventPattern: 'ism manufacturing pmi', importance: 'MEDIUM', notes: null },
  { country: 'US', eventPattern: 'ism services pmi', importance: 'MEDIUM', notes: null },
  { country: 'US', eventPattern: 'cb consumer confidence', importance: 'MEDIUM', notes: null },
  { country: 'EU', eventPattern: 'main refinancing rate', importance: 'HIGH', notes: 'ECB decision' },
  { country: 'EU', eventPattern: 'ecb press conference', importance: 'HIGH', notes: null },
  { country: 'GB', eventPattern: 'official bank rate', importance: 'HIGH', notes: 'BoE decision' },
  { country: 'JP', eventPattern: 'boj policy rate', importance: 'HIGH', notes: null },
] as const;

/**
 * The config profile to seed.
 *
 * Passed in rather than imported so `packages/db` keeps depending only on
 * `packages/core` (ARCHITECTURE §4.1). It also makes seeding an alternative profile
 * — a backtest variant, say — a parameter rather than a code change.
 */
export interface SeedProfile {
  readonly profileName: string;
  readonly config: Record<string, unknown>;
}

export interface SeedResult {
  readonly currencies: number;
  readonly assets: number;
  readonly macroSeries: number;
  readonly newsSources: number;
  readonly importanceRules: number;
  readonly configProfileId: string;
}

export async function seed(db: Database, profile: SeedProfile): Promise<SeedResult> {
  await db
    .insert(currencies)
    .values(SEED_CURRENCIES.map((c) => ({ code: c.code, name: c.name })))
    .onConflictDoUpdate({ target: currencies.code, set: { name: sql`excluded.name` } });

  await db
    .insert(assets)
    .values(
      SEED_ASSETS.map((a) => ({
        symbol: a.symbol,
        name: a.name,
        assetClass: a.assetClass,
        baseCurrency: a.base,
        quoteCurrency: a.quote,
        isActive: a.active,
        displayOrder: a.order,
      })),
    )
    .onConflictDoUpdate({
      target: assets.symbol,
      // Deliberately does not overwrite `isActive`: activating an asset is an
      // operational decision, and re-running the seed must not silently undo it.
      set: { name: sql`excluded.name`, displayOrder: sql`excluded.display_order` },
    });

  await db
    .insert(macroSeries)
    .values(
      SEED_MACRO_SERIES.map((s) => ({
        seriesId: s.seriesId,
        provider: 'fred',
        name: s.name,
        role: s.role,
        unit: s.unit,
        cadence: s.cadence,
        expectedPublicationDays: [...s.expectedPublicationDays],
      })),
    )
    .onConflictDoUpdate({
      target: [macroSeries.provider, macroSeries.seriesId],
      set: {
        name: sql`excluded.name`,
        role: sql`excluded.role`,
        unit: sql`excluded.unit`,
        /**
         * `cadence` must propagate, and originally did not.
         *
         * It selects the series' freshness thresholds, so a stale value here is not
         * cosmetic. `DTWEXBGS` was reclassified `DAILY` → `WEEKLY` after the H.10
         * family was measured publishing ~9 days in arrears — but the upsert only
         * refreshed name, role and unit, so the database kept `DAILY` and factor F1
         * went on being scored `STALE` at half weight. The seed said one thing and
         * the running system did another.
         */
        cadence: sql`excluded.cadence`,
        // Propagated for the same reason `cadence` is. It selects the publication
        // calendar freshness is measured against, so a stale value here reintroduces
        // exactly the weekend distortion it was added to remove.
        expectedPublicationDays: sql`excluded.expected_publication_days`,
        isActive: sql`true`,
      },
    });

  await db
    .insert(newsSources)
    .values(
      SEED_NEWS_SOURCES.map((s) => ({
        name: s.name,
        feedUrl: s.feedUrl,
        homepageUrl: s.homepageUrl,
        tier: s.tier,
        publisher: s.publisher,
      })),
    )
    .onConflictDoUpdate({
      target: newsSources.feedUrl,
      set: { name: sql`excluded.name`, tier: sql`excluded.tier`, isActive: sql`true` },
    });

  /**
   * ── Reconcile removals ──────────────────────────────────────────────────
   *
   * Upserting alone leaves a removed entity in the table, still active, still being
   * used. Observed for real: BLS and US Treasury were dropped from the feed list
   * after failing verification, then kept appearing as ingestion failures on every
   * run because nothing ever turned them off.
   *
   * The seed array is the source of truth, so anything not in it must stop being
   * used. Two different mechanisms, chosen by what the row is referenced by:
   *
   *  - **Deactivate** where historical rows point at it. Deleting an asset or a
   *    macro series would cascade away the observations and analyses that cite it,
   *    destroying the provenance chain those facts depend on.
   *  - **Delete** where nothing references it and staleness is actively harmful. An
   *    importance rule left behind keeps classifying events by a rule the operator
   *    has already removed.
   */

  // Anything dropped from a seed array must stop being used — see below.
  await reconcileRemovals(db);

  const profileName = profile.profileName;
  await db
    .insert(configProfiles)
    .values({
      name: profileName,
      isActive: true,
      config: profile.config,
      description: 'Default V1 profile: factor weights, thresholds and cadences.',
    })
    .onConflictDoNothing({ target: configProfiles.name });

  const [storedProfile] = await db
    .select({ id: configProfiles.id })
    .from(configProfiles)
    .where(eq(configProfiles.name, profileName))
    .limit(1);

  if (storedProfile === undefined) {
    throw new Error(`Seed failed: config profile "${profileName}" was not created`);
  }

  return {
    currencies: SEED_CURRENCIES.length,
    assets: SEED_ASSETS.length,
    macroSeries: SEED_MACRO_SERIES.length,
    newsSources: SEED_NEWS_SOURCES.length,
    importanceRules: SEED_IMPORTANCE_RULES.length,
    configProfileId: storedProfile.id,
  };
}

async function reconcileRemovals(db: Database): Promise<void> {
  // Feeds: deactivate. Stored articles keep their source row and provenance.
  await db
    .update(newsSources)
    .set({ isActive: false })
    .where(
      notInArray(
        newsSources.feedUrl,
        SEED_NEWS_SOURCES.map((s) => s.feedUrl),
      ),
    );

  // Macro series: deactivate. `macro_observations` cascades from these, so deleting
  // one would erase the history behind every factor that used it.
  await db
    .update(macroSeries)
    .set({ isActive: false })
    .where(
      notInArray(
        macroSeries.seriesId,
        SEED_MACRO_SERIES.map((s) => s.seriesId),
      ),
    );

  // Assets: deactivate. Candles, quotes, analyses and reports all cascade from an
  // asset; removing one from the seed must stop it being analysed, not delete its
  // history.
  await db
    .update(assets)
    .set({ isActive: false })
    .where(
      notInArray(
        assets.symbol,
        SEED_ASSETS.map((a) => a.symbol),
      ),
    );

  /**
   * Importance rules: delete.
   *
   * Nothing references them — the rule is applied at ingest time and its *result* is
   * stored on the event. So a rule removed from the seed but left in the table would
   * silently keep classifying releases by a policy the operator has already retired,
   * which is worse than an orphaned row: it is an orphaned *decision*.
   */
  const seededRuleKeys = SEED_IMPORTANCE_RULES.map((r) => `${r.country}|${r.eventPattern}`);
  await db.delete(eventImportanceRules).where(
    notInArray(
      sql`${eventImportanceRules.country} || '|' || ${eventImportanceRules.eventPattern}`,
      seededRuleKeys,
    ),
  );

  /**
   * Config profiles are deliberately left alone. Every analysis references the
   * profile it ran under, so an old profile must survive for its reports to remain
   * reproducible (`PRD_V1.md` §9.5). Only one may be active at a time, enforced by a
   * partial unique index, so a superseded profile is already inert.
   *
   * Currencies are likewise left alone: assets reference them, and a currency is
   * never meaningfully "removed".
   */

  await db
    .insert(eventImportanceRules)
    .values(
      SEED_IMPORTANCE_RULES.map((r) => ({
        country: r.country,
        eventPattern: r.eventPattern,
        importance: r.importance,
        notes: r.notes,
      })),
    )
    .onConflictDoUpdate({
      target: [eventImportanceRules.country, eventImportanceRules.eventPattern],
      set: { importance: sql`excluded.importance` },
    });
}
