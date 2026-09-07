/**
 * Shared vocabulary. Every enumerated concept in the system is named here exactly
 * once, so `packages/db`, `packages/providers`, `packages/engines` and the UI cannot
 * drift apart on spelling.
 *
 * Values that later versions need (extra assets, timeframes) are declared now even
 * though V1 only exercises a subset — the vocabulary is cheap, the migration is not.
 */

// ── Assets ──────────────────────────────────────────────────────────────────

/** V1 analyses XAUUSD only; the rest arrive in V4 (ROADMAP.md). */
export const ASSET_SYMBOLS = [
  'XAUUSD',
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'NZDUSD',
  'USDCAD',
] as const;
export type AssetSymbol = (typeof ASSET_SYMBOLS)[number];

export const ASSET_CLASSES = ['METAL', 'FX'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const CURRENCY_CODES = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CHF',
  'AUD',
  'NZD',
  'CAD',
  'XAU',
] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

// ── Timeframes ──────────────────────────────────────────────────────────────

/** Declared in full from V1; only `1d` is ingested until V2. */
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * Source credibility tiers (master PRD 45).
 * 1 official government / central banks / statistical agencies
 * 2 major established financial data and news providers
 * 3 other reputable financial publications
 * 4 unverified — stored, but excluded from scoring by default
 */
export type SourceTier = 1 | 2 | 3 | 4;

/** Multiplier applied to a fact's contribution based on who published it. */
export const TIER_WEIGHT: Readonly<Record<SourceTier, number>> = {
  1: 1.0,
  2: 0.9,
  3: 0.75,
  4: 0.4,
};

// ── Epistemic layers (Amendment A2) ─────────────────────────────────────────

/**
 * The three-layer separation required by master PRD 58, promoted from a formatting
 * convention to a type. Ordering matters: a statement may only derive from a
 * strictly lower layer, which is what keeps the lineage graph acyclic.
 */
export const STATEMENT_LAYERS = ['FACT', 'INTERPRETATION', 'AI_ASSESSMENT'] as const;
export type StatementLayer = (typeof STATEMENT_LAYERS)[number];

export const LAYER_RANK: Readonly<Record<StatementLayer, number>> = {
  FACT: 0,
  INTERPRETATION: 1,
  AI_ASSESSMENT: 2,
};

// ── Economic calendar ───────────────────────────────────────────────────────

export const IMPORTANCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

// ── News ────────────────────────────────────────────────────────────────────

/** Categories from master PRD 8. */
export const NEWS_CATEGORIES = [
  'MONETARY_POLICY',
  'INFLATION',
  'EMPLOYMENT',
  'ECONOMY',
  'GEOPOLITICS',
  'CENTRAL_BANKS',
  'GOVERNMENT_POLICY',
  'TRADE',
  'BANKING',
  'MARKET_SENTIMENT',
  'RISK_EVENTS',
  'OTHER',
] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

// ── Analysis ────────────────────────────────────────────────────────────────

/**
 * All modes are named from V1 so the API contract is forward-compatible, but V1
 * accepts only FUNDAMENTAL and rejects the rest with an explicit
 * "not available in this version" error rather than pretending to support them.
 */
export const ANALYSIS_MODES = [
  'FUNDAMENTAL',
  'QUICK',
  'FULL',
  'TECHNICAL_ONLY',
  'FULL_CONFLUENCE',
] as const;
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];

export const ANALYSIS_MODES_V1: readonly AnalysisMode[] = ['FUNDAMENTAL'];

export const BIASES = ['BULLISH', 'BEARISH', 'NEUTRAL', 'MIXED'] as const;
export type Bias = (typeof BIASES)[number];

export const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/**
 * Status of a stored analysis. INSUFFICIENT_DATA is a first-class outcome, not an
 * error: when factor coverage falls below the configured floor the system publishes
 * no score at all rather than a score built on absence (PRD_V1.md 8.5.4).
 */
export const ANALYSIS_STATUSES = [
  'COMPLETE',
  'AI_UNAVAILABLE',
  'INSUFFICIENT_DATA',
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

// ── Macro series ────────────────────────────────────────────────────────────

/**
 * FRED series seeded in V1 (PRD_V1.md 9.2), keyed by the role each plays in the
 * fundamental engine rather than by its opaque FRED id.
 */
export const MACRO_SERIES_IDS = [
  'DTWEXBGS', // Broad trade-weighted US dollar index
  'DFII10', // 10-year Treasury inflation-indexed (real) yield
  'DGS10', // 10-year Treasury constant maturity (nominal)
  'DGS2', // 2-year Treasury constant maturity
  'DFF', // Effective federal funds rate
  'CPIAUCSL', // CPI, all urban consumers
  'CPILFESL', // Core CPI (less food and energy)
  'PAYEMS', // Total nonfarm payrolls
  'UNRATE', // Unemployment rate
  'ICSA', // Initial jobless claims
  'VIXCLS', // CBOE volatility index
  'BAMLH0A0HYM2', // ICE BofA US high-yield option-adjusted spread
] as const;
export type MacroSeriesId = (typeof MACRO_SERIES_IDS)[number];

/** How often the underlying series actually updates — drives freshness thresholds. */
export const SERIES_CADENCE = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type SeriesCadence = (typeof SERIES_CADENCE)[number];

export const MACRO_SERIES_CADENCE: Readonly<Record<MacroSeriesId, SeriesCadence>> = {
  DTWEXBGS: 'DAILY',
  DFII10: 'DAILY',
  DGS10: 'DAILY',
  DGS2: 'DAILY',
  DFF: 'DAILY',
  CPIAUCSL: 'MONTHLY',
  CPILFESL: 'MONTHLY',
  PAYEMS: 'MONTHLY',
  UNRATE: 'MONTHLY',
  ICSA: 'WEEKLY',
  VIXCLS: 'DAILY',
  BAMLH0A0HYM2: 'DAILY',
};

// ── Fundamental factors (PRD_V1.md 8.5.2) ───────────────────────────────────

export const FACTOR_IDS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const;
export type FactorId = (typeof FACTOR_IDS)[number];

export const FACTOR_NAMES: Readonly<Record<FactorId, string>> = {
  F1: 'US dollar strength',
  F2: 'Real 10-year yield',
  F3: 'Nominal 10-year yield',
  F4: 'Policy-rate expectations',
  F5: 'Inflation',
  F6: 'Growth and employment',
  F7: 'Risk sentiment',
  F8: 'Geopolitical and policy news pressure',
};

// ── Type guards ─────────────────────────────────────────────────────────────

const asSet = (xs: readonly string[]): ReadonlySet<string> => new Set(xs);

const ASSET_SET = asSet(ASSET_SYMBOLS);
const TIMEFRAME_SET = asSet(TIMEFRAMES);
const CURRENCY_SET = asSet(CURRENCY_CODES);
const MACRO_SET = asSet(MACRO_SERIES_IDS);
const MODE_SET = asSet(ANALYSIS_MODES);

export const isAssetSymbol = (v: string): v is AssetSymbol => ASSET_SET.has(v);
export const isTimeframe = (v: string): v is Timeframe => TIMEFRAME_SET.has(v);
export const isCurrencyCode = (v: string): v is CurrencyCode => CURRENCY_SET.has(v);
export const isMacroSeriesId = (v: string): v is MacroSeriesId => MACRO_SET.has(v);
export const isAnalysisMode = (v: string): v is AnalysisMode => MODE_SET.has(v);
export const isSourceTier = (v: number): v is SourceTier =>
  v === 1 || v === 2 || v === 3 || v === 4;
