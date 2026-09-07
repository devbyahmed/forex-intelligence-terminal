/**
 * Factor viability: can this factor score at all, given how much history we keep?
 *
 * **An abstention must be attributable to the world, not to our configuration**
 * (PRD_V1 §8.5.3a). A factor that abstains because a provider is down is information.
 * A factor that abstains because we never fetched enough history to standardise it is
 * a defect — and the two are indistinguishable on the dashboard, because graceful
 * degradation looks exactly like correct operation.
 *
 * That is not hypothetical. With a uniform two-year ingestion window the monthly
 * series held twelve observations; a year-on-year change consumes a twelve-period lag,
 * so F5's baseline had one entry against a thirty-observation minimum. **F5 could not
 * produce a score in any market condition whatsoever**, for two phases, and nothing
 * noticed — because abstaining is precisely what it should do when history is short.
 *
 * This module makes the rule checkable. Every factor declares the series it reads and
 * the longest lag it consumes; `checkFactorViability` compares that against the
 * observations actually available and fails loudly. It runs as a test against the
 * configured lookback windows, and at worker startup against the real row counts —
 * because a window sized correctly in config still fails if ingestion never ran.
 *
 * The manifest below is kept honest by `viability.test.ts`, which drives each factor
 * with exactly `required - 1` observations and asserts it abstains, then with exactly
 * `required` and asserts it scores. A declared requirement that disagrees with the
 * implementation is the seed-divergence failure in another costume, so it is measured
 * rather than trusted.
 */

import type { FactorId, MacroSeriesId } from '@forex-agent/core';
import type { NormalisationConfig } from './normalise.js';

/**
 * One series a factor reads, and every lag it takes from it.
 *
 * **The shortest and longest lags answer different questions, and conflating them was
 * this module's own first bug.** `combineSignals` drops sub-signals it cannot compute
 * and re-weights the rest, so a factor scores as soon as its *shortest* lag can be
 * standardised — F1 produces a reading from the 5-day dollar change alone while the
 * 20-day change is still short. It reaches full input completeness only when its
 * *longest* lag can be standardised too.
 *
 * Sizing viability by the longest lag would have declared factors dead that were
 * merely degraded; sizing it by the shortest alone would have missed a factor stuck
 * permanently below full completeness. Both are configuration artefacts, so both are
 * reported — separately, because only one of them should stop a boot.
 */
export interface SeriesRequirement {
  readonly seriesId: MacroSeriesId;
  /**
   * Every lag this factor takes from this series, in observations.
   *
   * `changeHistory(values, h)` yields `values.length - h` entries, so standardising a
   * lag-`h` change needs `minObservations + h` observations. A level signal has lag 0
   * and needs `minObservations` alone.
   */
  readonly lags: readonly number[];
  /**
   * False when the factor can still score without this series, at reduced input
   * completeness — F4 without `DFF`, F6 without any one labour series.
   */
  readonly required: boolean;
}

const shortestLag = (s: SeriesRequirement): number => Math.min(...s.lags);
const longestLag = (s: SeriesRequirement): number => Math.max(...s.lags);

export interface FactorRequirement {
  readonly factorId: FactorId;
  readonly series: readonly SeriesRequirement[];
  /** True for factors that also read a calendar surprise or the news aggregate. */
  readonly usesExternalSignal: boolean;
}

/**
 * What each factor reads. Ordered as the factors are.
 *
 * Lags are the ones in `factors.ts`, verified against it by test rather than by
 * comment.
 */
export const FACTOR_REQUIREMENTS: readonly FactorRequirement[] = [
  {
    factorId: 'F1',
    series: [{ seriesId: 'DTWEXBGS', lags: [5, 20], required: true }],
    usesExternalSignal: false,
  },
  {
    factorId: 'F2',
    // Level (lag 0), plus 5- and 20-day changes.
    series: [{ seriesId: 'DFII10', lags: [0, 5, 20], required: true }],
    usesExternalSignal: false,
  },
  {
    factorId: 'F3',
    series: [{ seriesId: 'DGS10', lags: [5, 20], required: true }],
    usesExternalSignal: false,
  },
  {
    factorId: 'F4',
    series: [
      // The 20-day change, and the DGS2−DFF spread standardised on levels (lag 0).
      { seriesId: 'DGS2', lags: [0, 20], required: true },
      { seriesId: 'DFF', lags: [0], required: false },
    ],
    usesExternalSignal: false,
  },
  {
    factorId: 'F5',
    // The year-on-year lag that made this factor impossible under a two-year window.
    series: [{ seriesId: 'CPILFESL', lags: [12], required: true }],
    usesExternalSignal: true,
  },
  {
    factorId: 'F6',
    series: [
      { seriesId: 'ICSA', lags: [4], required: false },
      { seriesId: 'UNRATE', lags: [3], required: false },
      { seriesId: 'PAYEMS', lags: [3], required: false },
    ],
    usesExternalSignal: true,
  },
  {
    factorId: 'F7',
    series: [
      // VIX level (lag 0) and its 5-day change.
      { seriesId: 'VIXCLS', lags: [0, 5], required: false },
      { seriesId: 'BAMLH0A0HYM2', lags: [20], required: false },
    ],
    usesExternalSignal: false,
  },
  {
    // F8 reads no macro series; its history is the news aggregate's own trailing
    // readings, which the news pipeline supplies and this check cannot size.
    factorId: 'F8',
    series: [],
    usesExternalSignal: true,
  },
];

/** Observations a series needs before a lag-`h` signal can be standardised. */
export function observationsRequired(lag: number, config: NormalisationConfig): number {
  return config.minObservations + lag;
}

/** The fewest observations of this series that let the factor score at all. */
export function minimumObservations(s: SeriesRequirement, config: NormalisationConfig): number {
  return observationsRequired(shortestLag(s), config);
}

/** The observations needed for every sub-signal from this series to resolve. */
export function fullObservations(s: SeriesRequirement, config: NormalisationConfig): number {
  return observationsRequired(longestLag(s), config);
}

export interface ViabilityShortfall {
  readonly factorId: FactorId;
  readonly seriesId: MacroSeriesId;
  /** Observations needed for the shortfall being reported. */
  readonly required: number;
  readonly available: number;
  /**
   * FATAL — the factor cannot produce a score at all.
   * DEGRADED — it scores, but can never reach full input completeness.
   *
   * Only FATAL stops a boot. A permanently degraded factor is still a configuration
   * artefact and still worth reporting, but it produces a real reading from real data
   * and refusing to start over it would be worse than surfacing it.
   */
  readonly severity: 'FATAL' | 'DEGRADED';
}

export interface ViabilityReport {
  readonly shortfalls: readonly ViabilityShortfall[];
  /** Factors that cannot produce a score under this configuration at all. */
  readonly deadFactors: readonly FactorId[];
  /** Factors that can score but never at full input completeness. */
  readonly degradedFactors: readonly FactorId[];
  readonly healthy: boolean;
}

export class FactorViabilityError extends Error {
  readonly report: ViabilityReport;

  constructor(report: ViabilityReport) {
    const lines = report.shortfalls.map(
      (s) =>
        `  - ${s.factorId} needs ${String(s.required)} observations of ${s.seriesId} ` +
        `but only ${String(s.available)} are available` +
        (s.severity === 'FATAL' ? ' (FACTOR CANNOT SCORE)' : ' (permanently reduced completeness)'),
    );
    super(
      `Factor viability check failed — ${String(report.deadFactors.length)} factor(s) cannot score ` +
        `under this configuration:\n${lines.join('\n')}\n\n` +
        'These factors would abstain on every run, in every market condition, and that ' +
        'abstention would be indistinguishable from a genuine data outage. Widen the ' +
        'ingestion lookback for the affected cadence, or lower minObservations.',
    );
    this.name = 'FactorViabilityError';
    this.report = report;
  }
}

/**
 * Check every enabled factor against the observations actually available.
 *
 * `availableObservations` is keyed by series id — from the configured lookback at
 * test time, or from real row counts at startup. A series absent from the map counts
 * as zero, which is correct: a series we never fetched provides no history.
 */
export function checkFactorViability(params: {
  readonly availableObservations: Readonly<Partial<Record<MacroSeriesId, number>>>;
  readonly enabledFactors: Readonly<Record<FactorId, { readonly enabled: boolean }>>;
  readonly normalisation: NormalisationConfig;
  readonly requirements?: readonly FactorRequirement[];
}): ViabilityReport {
  const requirements = params.requirements ?? FACTOR_REQUIREMENTS;
  const shortfalls: ViabilityShortfall[] = [];
  const deadFactors: FactorId[] = [];
  const degradedFactors: FactorId[] = [];

  for (const req of requirements) {
    if (!params.enabledFactors[req.factorId].enabled) continue;
    // F8 declares no series: its history comes from the news aggregate, whose depth
    // this check has no visibility into. Sizing it here would be a guess dressed as
    // a guarantee.
    if (req.series.length === 0) continue;

    const factorShortfalls: ViabilityShortfall[] = [];
    let anySeriesViable = false;
    let requiredSeriesDead = false;

    for (const s of req.series) {
      const available = params.availableObservations[s.seriesId] ?? 0;
      const minimum = minimumObservations(s, params.normalisation);
      const full = fullObservations(s, params.normalisation);

      if (available < minimum) {
        // Not even the shortest sub-signal can be standardised.
        factorShortfalls.push({
          factorId: req.factorId,
          seriesId: s.seriesId,
          required: minimum,
          available,
          severity: s.required ? 'FATAL' : 'DEGRADED',
        });
        if (s.required) requiredSeriesDead = true;
      } else {
        anySeriesViable = true;
        if (available < full) {
          // Scores, but one sub-signal can never resolve — permanently below full
          // completeness, which lowers this factor's weight on every single run.
          factorShortfalls.push({
            factorId: req.factorId,
            seriesId: s.seriesId,
            required: full,
            available,
            severity: 'DEGRADED',
          });
        }
      }
    }

    shortfalls.push(...factorShortfalls);

    if (requiredSeriesDead || !anySeriesViable) {
      deadFactors.push(req.factorId);
    } else if (factorShortfalls.length > 0) {
      degradedFactors.push(req.factorId);
    }
  }

  return {
    shortfalls,
    deadFactors,
    degradedFactors,
    healthy: deadFactors.length === 0,
  };
}

/** Throwing form, for worker startup and CI. */
export function assertFactorViability(params: Parameters<typeof checkFactorViability>[0]): void {
  const report = checkFactorViability(params);
  if (!report.healthy) throw new FactorViabilityError(report);
}

/**
 * Observations a lookback window yields for a series, given how often it is observed.
 *
 * Keyed by *observation* density, not publication cadence — `DTWEXBGS` publishes
 * weekly but is observed every business day, and sizing its window by its publication
 * cadence would underestimate its available history by a factor of five. The two were
 * conflated once already (PRD_V1 §13.4.1).
 */
export const OBSERVATIONS_PER_YEAR: Readonly<Record<MacroSeriesId, number>> = {
  DTWEXBGS: 252,
  DFII10: 252,
  DGS10: 252,
  DGS2: 252,
  DFF: 365,
  CPIAUCSL: 12,
  CPILFESL: 12,
  PAYEMS: 12,
  UNRATE: 12,
  ICSA: 52,
  VIXCLS: 252,
  BAMLH0A0HYM2: 252,
};

/** What a lookback of `days` yields for each series, for the config-time check. */
export function observationsFromLookback(
  lookbackDaysFor: (seriesId: MacroSeriesId) => number,
): Readonly<Partial<Record<MacroSeriesId, number>>> {
  const out: Partial<Record<MacroSeriesId, number>> = {};
  for (const [seriesId, perYear] of Object.entries(OBSERVATIONS_PER_YEAR) as [
    MacroSeriesId,
    number,
  ][]) {
    out[seriesId] = Math.floor((lookbackDaysFor(seriesId) / 365) * perYear);
  }
  return out;
}
