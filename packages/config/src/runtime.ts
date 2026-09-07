/**
 * Runtime configuration (master PRD 57, Principle P8).
 *
 * Weights, thresholds and cache durations are data, not code. The defaults below
 * are the seed for the first `config_profiles` row; from Phase 2 onward a profile is
 * loaded from the database and its id is recorded on every analysis, so an old
 * report can always be re-rendered with the weights that were in force when it ran.
 *
 * Nothing here does I/O. The shape is validated on load so a bad edit fails at boot
 * rather than producing a quietly wrong score.
 */

import {
  DEFAULT_BIAS_BANDS,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  assertBandsCoverRange,
  assertValidThresholds,
  type BiasBand,
  type ConfidenceThresholds,
  type FactorId,
  type FreshnessThresholds,
} from '@forex-agent/core';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── Fundamental engine ──────────────────────────────────────────────────────

/** Sign of a factor's effect on gold. `NET_RULE` factors compose two channels. */
export type FactorDirection = 'DIRECT' | 'INVERSE' | 'NET_RULE';

export interface FactorConfig {
  readonly weight: number;
  readonly direction: FactorDirection;
  readonly enabled: boolean;
}

/** Weights from PRD_V1.md 8.5.2. They must sum to 1. */
export const DEFAULT_FACTOR_CONFIG: Readonly<Record<FactorId, FactorConfig>> = {
  F1: { weight: 0.18, direction: 'INVERSE', enabled: true }, // US dollar strength
  F2: { weight: 0.18, direction: 'INVERSE', enabled: true }, // Real 10y yield
  F3: { weight: 0.1, direction: 'INVERSE', enabled: true }, // Nominal 10y yield
  F4: { weight: 0.15, direction: 'INVERSE', enabled: true }, // Policy-rate expectations
  F5: { weight: 0.09, direction: 'NET_RULE', enabled: true }, // Inflation
  F6: { weight: 0.1, direction: 'INVERSE', enabled: true }, // Growth and employment
  F7: { weight: 0.1, direction: 'DIRECT', enabled: true }, // Risk sentiment (risk-off bullish)
  F8: { weight: 0.1, direction: 'DIRECT', enabled: true }, // News pressure (stress bullish)
};

export interface NormalisationConfig {
  /** Trailing observations used for the z-score baseline. */
  readonly windowSize: number;
  /** z is clamped to +/- this before mapping to a score. */
  readonly clampZ: number;
  /** |z| below this is treated as no signal, to keep noise out of the score. */
  readonly deadbandZ: number;
  /** Minimum observations before a z-score is trustworthy at all. */
  readonly minObservations: number;
}

export const DEFAULT_NORMALISATION: NormalisationConfig = {
  windowSize: 252,
  clampZ: 3,
  deadbandZ: 0.25,
  minObservations: 30,
};

/**
 * F5's two opposing channels (PRD_V1.md 8.5.2). Higher inflation supports gold as a
 * hedge, while a hot surprise implies tighter policy and works against it. The
 * weights are explicit so the trade-off is visible rather than buried.
 */
export interface InflationNetRuleConfig {
  readonly hedgeWeight: number;
  readonly rateChannelWeight: number;
  /** Target the hedge component measures core inflation against, in percent. */
  readonly inflationTargetPct: number;
}

export const DEFAULT_INFLATION_NET_RULE: InflationNetRuleConfig = {
  hedgeWeight: 0.4,
  rateChannelWeight: 0.6,
  inflationTargetPct: 2,
};

// ── Confidence ──────────────────────────────────────────────────────────────

export interface ConfidenceConfig {
  readonly thresholds: ConfidenceThresholds;
  /** Below this coverage no score is published at all (PRD_V1.md 8.5.4). */
  readonly insufficientCoverageFloor: number;
  /** Below this coverage confidence is capped at MEDIUM. */
  readonly mediumCapCoverage: number;
  /** A HIGH-impact release within this window caps confidence at MEDIUM. */
  readonly eventRiskCapWindowMs: number;
  /** Relative contribution of each confidence input; must sum to 1. */
  readonly weights: {
    readonly coverage: number;
    readonly sourceQuality: number;
    readonly agreement: number;
    readonly freshness: number;
  };
}

export const DEFAULT_CONFIDENCE: ConfidenceConfig = {
  thresholds: DEFAULT_CONFIDENCE_THRESHOLDS,
  insufficientCoverageFloor: 0.5,
  mediumCapCoverage: 0.65,
  eventRiskCapWindowMs: 60 * MINUTE,
  weights: { coverage: 0.4, sourceQuality: 0.15, agreement: 0.3, freshness: 0.15 },
};

// ── News ────────────────────────────────────────────────────────────────────

export interface NewsConfig {
  /** Articles older than this do not contribute to the aggregate score. */
  readonly windowMs: number;
  /** Half-life for recency decay of an article's contribution. */
  readonly halfLifeMs: number;
  /** Tier 4 is stored but excluded from scoring by default (master PRD 45). */
  readonly minTierForScoring: 1 | 2 | 3 | 4;
  /** Jaccard similarity above which two headlines are treated as duplicates. */
  readonly duplicateTitleThreshold: number;

  /**
   * Minimum relevant articles in the window before factor F8 produces a score.
   *
   * **Ten.** The news score is a recency-decayed, tier-weighted mean of per-article
   * polarity. The standard error of a mean falls as sigma/sqrt(n): a single article
   * carries the full noise of one editor's word choice, four cuts it in half, ten
   * brings it to roughly a third. Below ten, the number would move more with which
   * headlines happened to land than with anything about the market — which Amendment
   * A3 forbids presenting as a measurement.
   *
   * Measured 2026-08-30: the twelve seeded feeds yield about **3 gold-relevant
   * articles per day**, so a 48-hour window holds roughly six. **F8 abstains at
   * present**, and that is the correct outcome rather than a problem to engineer
   * around.
   *
   * This is not a switch to flip when feeds are added. The pipeline measures the
   * window on every run and decides; if a feed dies and relevant volume falls, F8
   * goes dark again automatically.
   */
  readonly minArticlesForScore: number;

  /**
   * Minimum distinct sources among those articles.
   *
   * Ten articles from one outlet measures that outlet's editorial tone, not market
   * sentiment. Two is the floor at which the mean reflects more than a single voice.
   */
  readonly minSourcesForScore: number;
}

export const DEFAULT_NEWS: NewsConfig = {
  windowMs: 48 * HOUR,
  halfLifeMs: 12 * HOUR,
  minTierForScoring: 3,
  duplicateTitleThreshold: 0.8,
  minArticlesForScore: 10,
  minSourcesForScore: 2,
};

// ── Freshness (master PRD 38, PRD_V1.md 9.4) ────────────────────────────────

export interface FreshnessConfig {
  readonly spotQuote: FreshnessThresholds;
  readonly intradayCandles: FreshnessThresholds;
  readonly dailyMacro: FreshnessThresholds;
  readonly weeklyMacro: FreshnessThresholds;
  readonly monthlyMacro: FreshnessThresholds;
  readonly economicCalendar: FreshnessThresholds;
  readonly news: FreshnessThresholds;
}

export const DEFAULT_FRESHNESS: FreshnessConfig = {
  // Widened from the original 2-minute LIVE window: with 5-minute polling a
  // 2-minute threshold could never be satisfied, so the chip would have read
  // RECENT permanently and told the user nothing.
  spotQuote: {
    liveMs: 10 * MINUTE,
    recentMs: 30 * MINUTE,
    staleBeyondMs: 2 * HOUR,
    maxRetrievalAgeMs: 30 * MINUTE,
  },
  intradayCandles: {
    liveMs: 5 * MINUTE,
    recentMs: 30 * MINUTE,
    staleBeyondMs: 2 * HOUR,
    maxRetrievalAgeMs: 30 * MINUTE,
  },
  /**
   * ── Macro thresholds are read in PUBLICATION-DAY time ─────────────────────
   *
   * `assessFreshnessOnCalendar` counts only days the source actually publishes on,
   * so 24h here means "one expected publication", not "one calendar day". Weekends
   * advance the count by zero, which is the point: the Friday yield read on Sunday
   * is the latest yield in existence and should not be marked down for it.
   *
   * Every number below is derived from the 2026-08-30 audit of first-release dates.
   */

  // Published Mon–Fri, median lag 1 day (VIXCLS and BAMLH0A0HYM2 lag 0). One
  // publication day is one business day, so these numbers are unchanged from the
  // wall-clock set — a daily series that misses a single business-day release drops
  // to RECENT, three to STALE.
  dailyMacro: {
    liveMs: 24 * HOUR,
    recentMs: 72 * HOUR,
    staleBeyondMs: 7 * DAY,
    maxRetrievalAgeMs: 6 * HOUR,
  },
  // Published on ONE weekday: DTWEXBGS Mondays (75 of 80 releases), ICSA Thursdays
  // (48 of 51). One publication day is therefore a whole week, so the previous
  // 7/14/30-day wall-clock numbers would have meant seven, fourteen and thirty
  // WEEKS once read in publication time. One, two and four missed releases is the
  // intent, and is what these express.
  weeklyMacro: {
    liveMs: 24 * HOUR,
    recentMs: 48 * HOUR,
    staleBeyondMs: 96 * HOUR,
    maxRetrievalAgeMs: 12 * HOUR,
  },
  // Published on a business day roughly 21 business days apart — CPI median lag 43
  // calendar days, payrolls 37. LIVE must span a full inter-print interval or every
  // monthly figure would degrade while still being the current one: 22 publication
  // days keeps July CPI LIVE until August CPI is due, while 30 and 45 mark a print
  // that has genuinely been missed.
  monthlyMacro: {
    liveMs: 22 * DAY,
    recentMs: 30 * DAY,
    staleBeyondMs: 45 * DAY,
    maxRetrievalAgeMs: 24 * HOUR,
  },
  economicCalendar: {
    liveMs: 6 * HOUR,
    recentMs: 24 * HOUR,
    staleBeyondMs: 48 * HOUR,
    maxRetrievalAgeMs: 8 * HOUR,
  },
  news: {
    liveMs: 30 * MINUTE,
    recentMs: 4 * HOUR,
    staleBeyondMs: 24 * HOUR,
    maxRetrievalAgeMs: HOUR,
  },
};

// ── Cache (master PRD 39) ───────────────────────────────────────────────────

export interface CacheConfig {
  readonly quoteMs: number;
  readonly dailyMacroMs: number;
  readonly calendarMs: number;
  /** Tightened cache while an actual is expected to land. */
  readonly calendarReleaseWindowMs: number;
  readonly newsFeedMs: number;
}

export const DEFAULT_CACHE: CacheConfig = {
  quoteMs: 60 * SECOND,
  dailyMacroMs: 6 * HOUR,
  calendarMs: 30 * MINUTE,
  calendarReleaseWindowMs: 2 * MINUTE,
  newsFeedMs: 10 * MINUTE,
};

// ── Provider resilience (master PRD 40) ─────────────────────────────────────

export interface ResilienceConfig {
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** Consecutive failures before the breaker opens. */
  readonly breakerFailureThreshold: number;
  /** How long the breaker stays open before a trial request. */
  readonly breakerCooldownMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceConfig = {
  requestTimeoutMs: 15 * SECOND,
  maxAttempts: 3,
  backoffBaseMs: SECOND,
  backoffMaxMs: 30 * SECOND,
  breakerFailureThreshold: 5,
  breakerCooldownMs: 5 * MINUTE,
};

// ── Event risk (master PRD 47) ──────────────────────────────────────────────

export interface EventRiskConfig {
  /** Warn when a HIGH-impact release falls inside this window. */
  readonly warnWindowMs: number;
  /** Treat a release as "imminent" for confidence capping inside this window. */
  readonly imminentWindowMs: number;
}

export const DEFAULT_EVENT_RISK: EventRiskConfig = {
  warnWindowMs: 24 * HOUR,
  imminentWindowMs: 60 * MINUTE,
};

// ── Composite profile ───────────────────────────────────────────────────────

export interface RuntimeConfig {
  readonly profileName: string;
  readonly factors: Readonly<Record<FactorId, FactorConfig>>;
  readonly normalisation: NormalisationConfig;
  readonly inflationNetRule: InflationNetRuleConfig;
  readonly biasBands: readonly BiasBand[];
  readonly confidence: ConfidenceConfig;
  readonly news: NewsConfig;
  readonly freshness: FreshnessConfig;
  readonly cache: CacheConfig;
  readonly resilience: ResilienceConfig;
  readonly eventRisk: EventRiskConfig;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  profileName: 'default-v1',
  factors: DEFAULT_FACTOR_CONFIG,
  normalisation: DEFAULT_NORMALISATION,
  inflationNetRule: DEFAULT_INFLATION_NET_RULE,
  biasBands: DEFAULT_BIAS_BANDS,
  confidence: DEFAULT_CONFIDENCE,
  news: DEFAULT_NEWS,
  freshness: DEFAULT_FRESHNESS,
  cache: DEFAULT_CACHE,
  resilience: DEFAULT_RESILIENCE,
  eventRisk: DEFAULT_EVENT_RISK,
};

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

const FLOAT_TOLERANCE = 1e-9;

/**
 * Validate a profile before anything scores against it. Configuration is
 * user-editable, so a bad edit must fail at load with a clear message rather than
 * silently skewing every subsequent analysis.
 */
export function assertValidRuntimeConfig(cfg: RuntimeConfig): void {
  const enabled = Object.values(cfg.factors).filter((f) => f.enabled);
  if (enabled.length === 0) {
    throw new RuntimeConfigError('At least one fundamental factor must be enabled');
  }
  const weightSum = enabled.reduce((sum, f) => sum + f.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new RuntimeConfigError(
      `Enabled factor weights must sum to 1, got ${weightSum.toFixed(6)}`,
    );
  }
  for (const [id, f] of Object.entries(cfg.factors)) {
    if (f.weight < 0 || f.weight > 1) {
      throw new RuntimeConfigError(`Factor ${id} weight must be within [0, 1], got ${String(f.weight)}`);
    }
  }

  assertBandsCoverRange(cfg.biasBands);

  const { thresholds, insufficientCoverageFloor, mediumCapCoverage, weights } = cfg.confidence;
  if (thresholds.medium > thresholds.high) {
    throw new RuntimeConfigError('Confidence MEDIUM threshold must not exceed HIGH threshold');
  }
  for (const [label, v] of [
    ['insufficientCoverageFloor', insufficientCoverageFloor],
    ['mediumCapCoverage', mediumCapCoverage],
  ] as const) {
    if (v < 0 || v > 1) {
      throw new RuntimeConfigError(`confidence.${label} must be within [0, 1], got ${String(v)}`);
    }
  }
  if (insufficientCoverageFloor > mediumCapCoverage) {
    throw new RuntimeConfigError(
      'confidence.insufficientCoverageFloor must not exceed mediumCapCoverage — ' +
        'a run cannot be publishable yet below the floor',
    );
  }
  const confidenceWeightSum =
    weights.coverage + weights.sourceQuality + weights.agreement + weights.freshness;
  if (Math.abs(confidenceWeightSum - 1) > FLOAT_TOLERANCE + 1e-6) {
    throw new RuntimeConfigError(
      `Confidence weights must sum to 1, got ${confidenceWeightSum.toFixed(6)}`,
    );
  }

  const { normalisation: n } = cfg;
  if (n.clampZ <= 0) throw new RuntimeConfigError('normalisation.clampZ must be positive');
  if (n.deadbandZ < 0) throw new RuntimeConfigError('normalisation.deadbandZ must not be negative');
  if (n.deadbandZ >= n.clampZ) {
    throw new RuntimeConfigError('normalisation.deadbandZ must be below clampZ');
  }
  if (n.minObservations < 2) {
    throw new RuntimeConfigError('normalisation.minObservations must be at least 2');
  }
  if (n.windowSize < n.minObservations) {
    throw new RuntimeConfigError('normalisation.windowSize must be at least minObservations');
  }

  const { inflationNetRule: r } = cfg;
  if (r.hedgeWeight < 0 || r.rateChannelWeight < 0) {
    throw new RuntimeConfigError('Inflation net-rule weights must not be negative');
  }
  if (Math.abs(r.hedgeWeight + r.rateChannelWeight - 1) > 1e-6) {
    throw new RuntimeConfigError('Inflation net-rule weights must sum to 1');
  }

  if (cfg.news.duplicateTitleThreshold <= 0 || cfg.news.duplicateTitleThreshold > 1) {
    throw new RuntimeConfigError('news.duplicateTitleThreshold must be within (0, 1]');
  }
  if (cfg.news.halfLifeMs <= 0) {
    throw new RuntimeConfigError('news.halfLifeMs must be positive');
  }

  // Typed key list rather than Object.entries: `entries` widens the value to `any`,
  // which would silently disable checking on exactly the thresholds we are validating.
  const freshnessDomains: readonly (keyof FreshnessConfig)[] = [
    'spotQuote',
    'intradayCandles',
    'dailyMacro',
    'weeklyMacro',
    'monthlyMacro',
    'economicCalendar',
    'news',
  ];
  for (const name of freshnessDomains) {
    try {
      assertValidThresholds(cfg.freshness[name]);
    } catch (e) {
      throw new RuntimeConfigError(
        `freshness.${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const { resilience: res } = cfg;
  if (res.maxAttempts < 1) throw new RuntimeConfigError('resilience.maxAttempts must be at least 1');
  if (res.backoffBaseMs <= 0) throw new RuntimeConfigError('resilience.backoffBaseMs must be positive');
  if (res.backoffMaxMs < res.backoffBaseMs) {
    throw new RuntimeConfigError('resilience.backoffMaxMs must not be below backoffBaseMs');
  }
  if (res.breakerFailureThreshold < 1) {
    throw new RuntimeConfigError('resilience.breakerFailureThreshold must be at least 1');
  }

  if (cfg.eventRisk.imminentWindowMs > cfg.eventRisk.warnWindowMs) {
    throw new RuntimeConfigError('eventRisk.imminentWindowMs must not exceed warnWindowMs');
  }
}
