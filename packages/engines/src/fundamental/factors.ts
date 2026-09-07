/**
 * The eight factors (PRD_V1 §8.5.2).
 *
 * Every factor follows the same shape, and the shape is what matters more than any
 * individual formula: **gather inputs → abstain if they are not there → normalise →
 * score**. The abstention check comes before the arithmetic, never after, so there is
 * no code path on which a missing input reaches a calculation and emerges as a number.
 *
 * Freshness is taken from the inputs, not recomputed. `UNAVAILABLE` is treated as
 * absence — a value too old to be evidence of anything current is not evidence — so a
 * factor whose primary series is UNAVAILABLE abstains rather than scoring stale data
 * at reduced weight.
 */

import {
  FRESHNESS_WEIGHT,
  isUsable,
  worstFreshness,
  type FactorId,
  type FreshnessStatus,
  type MacroSeriesId,
  type SourceTier,
} from '@forex-agent/core';
import {
  ATTRIBUTION_OF,
  TIER_WEIGHT,
  type AbstentionReason,
  type FactRef,
  type FactorLimitation,
  type FactorOutcome,
} from './factor.js';
import {
  combineSignals,
  directionOf,
  inputCompleteness,
  normaliseSignal,
  type FactorSign,
  type NormalisationConfig,
  type NormalisedSignal,
} from './normalise.js';
import {
  changeHistory,
  latestChange,
  latestValue,
  valuesOf,
  yearOnYear,
  type FundamentalInputs,
  type MacroSeriesView,
  type StructuralGapKind,
} from './inputs.js';
import { explainFactor } from './explain.js';

export interface FactorConfigView {
  readonly weight: number;
  readonly enabled: boolean;
}

export interface InflationNetRule {
  readonly hedgeWeight: number;
  readonly rateChannelWeight: number;
  readonly inflationTargetPct: number;
}

export interface FactorComputeConfig {
  readonly factors: Readonly<Record<FactorId, FactorConfigView>>;
  readonly normalisation: NormalisationConfig;
  readonly inflationNetRule: InflationNetRule;
}

/** Everything a factor needs to describe itself when it cannot produce a reading. */
interface AbstainArgs {
  readonly factorId: FactorId;
  readonly factorName: string;
  readonly weight: number;
  readonly reason: AbstentionReason;
  readonly detail: string;
  readonly freshness?: FreshnessStatus;
  readonly factRefs?: readonly FactRef[];
}

function abstain(args: AbstainArgs): FactorOutcome {
  return {
    kind: 'ABSTAINED',
    factorId: args.factorId,
    factorName: args.factorName,
    weight: args.weight,
    reason: args.reason,
    detail: args.detail,
    freshness: args.freshness ?? 'UNAVAILABLE',
    attribution: ATTRIBUTION_OF[args.reason],
    factRefs: args.factRefs ?? [],
    explanation: `${args.factorName} is not scored: ${args.detail}.`,
  };
}

interface ScoreArgs {
  readonly factorId: FactorId;
  readonly factorName: string;
  readonly weight: number;
  readonly signal: NormalisedSignal;
  readonly rawSignal: Readonly<Record<string, number | null>>;
  readonly freshness: FreshnessStatus;
  readonly factRefs: readonly FactRef[];
  readonly resolvedInputs: number;
  readonly requiredInputs: number;
  readonly units: Readonly<Record<string, string>>;
  readonly limitations?: readonly FactorLimitation[];
}

function toScored(args: ScoreArgs): FactorOutcome {
  const completeness = inputCompleteness(args.resolvedInputs, args.requiredInputs);
  const meanTier =
    args.factRefs.length === 0
      ? 1
      : args.factRefs.reduce((s, r) => s + TIER_WEIGHT[r.sourceTier], 0) / args.factRefs.length;

  // freshness × tier × completeness (PRD_V1 §8.5.4).
  const confidence = FRESHNESS_WEIGHT[args.freshness] * meanTier * completeness;

  return {
    kind: 'SCORED',
    factorId: args.factorId,
    factorName: args.factorName,
    weight: args.weight,
    score: args.signal.score,
    zScore: args.signal.zScore,
    direction: directionOf(args.signal.score),
    rawSignal: args.rawSignal,
    confidence,
    freshness: args.freshness,
    inputCompleteness: completeness,
    limitations: args.limitations ?? [],
    factRefs: args.factRefs,
    explanation: explainFactor({
      factorName: args.factorName,
      score: args.signal.score,
      signal: args.signal,
      rawSignal: args.rawSignal,
      freshness: args.freshness,
      units: args.units,
      limitations: args.limitations ?? [],
    }),
  };
}

/** Reference to a series' newest fact, for provenance. */
function refFor(view: MacroSeriesView): FactRef[] {
  const last = view.points[view.points.length - 1];
  if (last === undefined) return [];
  return [
    {
      table: 'macro_observations',
      id: last.factId,
      label: view.displayName,
      freshness: view.freshness,
      sourceTier: view.sourceTier,
    },
  ];
}

/**
 * Resolve a series, or explain why it cannot be used.
 *
 * `UNAVAILABLE` is folded into absence here rather than at each call site: it is the
 * single most repeated decision in this file, and one call site forgetting it would
 * mean one factor quietly scoring data the rest of the system considers too old.
 */
function useSeries(
  inputs: FundamentalInputs,
  seriesId: MacroSeriesId,
): SeriesResolution {
  const view = inputs.series[seriesId];
  if (view === undefined) return { missing: 'INPUT_MISSING', detail: `${seriesId} was not fetched` };
  if (!isUsable(view.freshness)) {
    return { missing: 'INPUT_UNAVAILABLE', detail: `${seriesId} is UNAVAILABLE` };
  }
  if (valuesOf(view).length === 0) {
    return { missing: 'INPUT_MISSING', detail: `${seriesId} returned no usable values` };
  }
  return { view };
}

type SeriesResolution = { view: MacroSeriesView } | { missing: AbstentionReason; detail: string };

function isMissing(r: SeriesResolution): r is { missing: AbstentionReason; detail: string } {
  return 'missing' in r;
}

/** A change-based sub-signal: the h-period change standardised against its own history. */
function changeSignal(
  view: MacroSeriesView,
  horizon: number,
  absolute: boolean,
  sign: FactorSign,
  config: NormalisationConfig,
): NormalisedSignal | null {
  const current = latestChange(view, horizon, absolute);
  if (current === null) return null;
  const history = changeHistory(valuesOf(view), horizon, absolute);
  return normaliseSignal(current, history, sign, config);
}

/** A level-based sub-signal: the current level standardised against past levels. */
function levelSignal(
  view: MacroSeriesView,
  sign: FactorSign,
  config: NormalisationConfig,
): NormalisedSignal | null {
  const current = latestValue(view);
  if (current === null) return null;
  return normaliseSignal(current, valuesOf(view), sign, config);
}


/**
 * Attribute a missing sub-signal.
 *
 * The engine sees only that a value is absent. Whether that is the world (no release
 * has happened yet), our configuration (we never fetched it), or a permanent limit of
 * the free tier is a question about the *sources*, which the caller declares. Absent a
 * declaration the honest answer is WORLD — a transient absence is the weaker claim,
 * and over-claiming permanence would tell users a gap will never close when it might.
 */
function limitationFor(
  inputs: FundamentalInputs,
  kind: StructuralGapKind,
  missing: string,
): FactorLimitation {
  // Redundant today only because STRUCTURAL_GAP_KINDS has a single member. The
  // comparison is the point: V2 adds intraday history depth and V4 adds per-pair
  // provider coverage, and a factor must match its own gap rather than any gap.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const declared = inputs.structuralGaps.find((g) => g.kind === kind);
  if (declared === undefined) {
    return {
      attribution: 'WORLD',
      missing,
      reason: 'no value was available for this run',
      resolution: null,
    };
  }
  return {
    attribution: 'STRUCTURAL',
    missing,
    reason: declared.reason,
    resolution: declared.resolution,
  };
}

// ── F1: US dollar strength ──────────────────────────────────────────────────

export function computeF1(inputs: FundamentalInputs, config: FactorComputeConfig): FactorOutcome {
  const id: FactorId = 'F1';
  const name = 'US dollar strength';
  const weight = config.factors[id].weight;
  if (!config.factors[id].enabled) {
    return abstain({ factorId: id, factorName: name, weight, reason: 'DISABLED', detail: 'disabled in the active profile' });
  }

  const resolved = useSeries(inputs, 'DTWEXBGS');
  if (isMissing(resolved)) {
    return abstain({ factorId: id, factorName: name, weight, reason: resolved.missing, detail: resolved.detail });
  }
  const { view } = resolved;

  // A stronger dollar is bearish for gold, hence INVERSE.
  const short = changeSignal(view, 5, false, 'INVERSE', config.normalisation);
  const long = changeSignal(view, 20, false, 'INVERSE', config.normalisation);
  const combined = combineSignals([
    { signal: short, weight: 0.5 },
    { signal: long, weight: 0.5 },
  ]);

  if (combined === null) {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'INSUFFICIENT_HISTORY',
      detail: 'not enough DTWEXBGS history to standardise a 5- or 20-day change',
      freshness: view.freshness,
      factRefs: refFor(view),
    });
  }

  return toScored({
    factorId: id,
    factorName: name,
    weight,
    signal: combined,
    rawSignal: {
      level: latestValue(view),
      change5d: latestChange(view, 5, false),
      change20d: latestChange(view, 20, false),
    },
    freshness: view.freshness,
    factRefs: refFor(view),
    resolvedInputs: [short, long].filter((s) => s !== null).length,
    requiredInputs: 2,
    units: { level: ' index', change5d: '%', change20d: '%' },
  });
}

// ── F2: real 10-year yield ──────────────────────────────────────────────────

export function computeF2(inputs: FundamentalInputs, config: FactorComputeConfig): FactorOutcome {
  const id: FactorId = 'F2';
  const name = 'Real 10-year yield';
  const weight = config.factors[id].weight;
  if (!config.factors[id].enabled) {
    return abstain({ factorId: id, factorName: name, weight, reason: 'DISABLED', detail: 'disabled in the active profile' });
  }

  const resolved = useSeries(inputs, 'DFII10');
  if (isMissing(resolved)) {
    return abstain({ factorId: id, factorName: name, weight, reason: resolved.missing, detail: resolved.detail });
  }
  const { view } = resolved;

  // The real yield is gold's opportunity cost: higher real yields, lower gold.
  const level = levelSignal(view, 'INVERSE', config.normalisation);
  const short = changeSignal(view, 5, true, 'INVERSE', config.normalisation);
  const long = changeSignal(view, 20, true, 'INVERSE', config.normalisation);
  const combined = combineSignals([
    { signal: level, weight: 0.5 },
    { signal: short, weight: 0.25 },
    { signal: long, weight: 0.25 },
  ]);

  if (combined === null) {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'INSUFFICIENT_HISTORY',
      detail: 'not enough DFII10 history to standardise',
      freshness: view.freshness,
      factRefs: refFor(view),
    });
  }

  return toScored({
    factorId: id,
    factorName: name,
    weight,
    signal: combined,
    rawSignal: {
      level: latestValue(view),
      change5d: latestChange(view, 5, true),
      change20d: latestChange(view, 20, true),
    },
    freshness: view.freshness,
    factRefs: refFor(view),
    resolvedInputs: [level, short, long].filter((s) => s !== null).length,
    requiredInputs: 3,
    units: { level: 'pp', change5d: 'pp', change20d: 'pp' },
  });
}

// ── F3: nominal 10-year yield ───────────────────────────────────────────────

export function computeF3(inputs: FundamentalInputs, config: FactorComputeConfig): FactorOutcome {
  const id: FactorId = 'F3';
  const name = 'Nominal 10-year yield';
  const weight = config.factors[id].weight;
  if (!config.factors[id].enabled) {
    return abstain({ factorId: id, factorName: name, weight, reason: 'DISABLED', detail: 'disabled in the active profile' });
  }

  const resolved = useSeries(inputs, 'DGS10');
  if (isMissing(resolved)) {
    return abstain({ factorId: id, factorName: name, weight, reason: resolved.missing, detail: resolved.detail });
  }
  const { view } = resolved;

  // Changes only, not the level: the level is already carried by F2's real yield, and
  // scoring both would double-count the same move.
  const short = changeSignal(view, 5, true, 'INVERSE', config.normalisation);
  const long = changeSignal(view, 20, true, 'INVERSE', config.normalisation);
  const combined = combineSignals([
    { signal: short, weight: 0.5 },
    { signal: long, weight: 0.5 },
  ]);

  if (combined === null) {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'INSUFFICIENT_HISTORY',
      detail: 'not enough DGS10 history to standardise a 5- or 20-day change',
      freshness: view.freshness,
      factRefs: refFor(view),
    });
  }

  return toScored({
    factorId: id,
    factorName: name,
    weight,
    signal: combined,
    rawSignal: {
      level: latestValue(view),
      change5d: latestChange(view, 5, true),
      change20d: latestChange(view, 20, true),
    },
    freshness: view.freshness,
    factRefs: refFor(view),
    resolvedInputs: [short, long].filter((s) => s !== null).length,
    requiredInputs: 2,
    units: { level: 'pp', change5d: 'pp', change20d: 'pp' },
  });
}

// ── F4: policy-rate expectations ────────────────────────────────────────────

export function computeF4(inputs: FundamentalInputs, config: FactorComputeConfig): FactorOutcome {
  const id: FactorId = 'F4';
  const name = 'Policy-rate expectations';
  const weight = config.factors[id].weight;
  if (!config.factors[id].enabled) {
    return abstain({ factorId: id, factorName: name, weight, reason: 'DISABLED', detail: 'disabled in the active profile' });
  }

  const two = useSeries(inputs, 'DGS2');
  if (isMissing(two)) {
    return abstain({ factorId: id, factorName: name, weight, reason: two.missing, detail: two.detail });
  }

  const change = changeSignal(two.view, 20, true, 'INVERSE', config.normalisation);

  // DGS2 − DFF as a policy-path proxy: a widening spread implies the market expects
  // tightening, which is bearish for gold. Optional — F4 still scores on the 2-year
  // change alone if DFF is unavailable, at reduced completeness.
  const fff = inputs.series.DFF;
  let spreadSignal: NormalisedSignal | null = null;
  let spreadNow: number | null = null;

  if (fff !== undefined && isUsable(fff.freshness)) {
    const twoValues = valuesOf(two.view);
    const fffValues = valuesOf(fff);
    const n = Math.min(twoValues.length, fffValues.length);
    if (n >= config.normalisation.minObservations) {
      const spreads: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const a = twoValues[twoValues.length - n + i];
        const b = fffValues[fffValues.length - n + i];
        if (a === undefined || b === undefined) continue;
        spreads.push(a - b);
      }
      spreadNow = spreads[spreads.length - 1] ?? null;
      if (spreadNow !== null) {
        spreadSignal = normaliseSignal(spreadNow, spreads, 'INVERSE', config.normalisation);
      }
    }
  }

  const combined = combineSignals([
    { signal: change, weight: 0.6 },
    { signal: spreadSignal, weight: 0.4 },
  ]);

  if (combined === null) {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'INSUFFICIENT_HISTORY',
      detail: 'not enough DGS2 history to standardise a policy-path signal',
      freshness: two.view.freshness,
      factRefs: refFor(two.view),
    });
  }

  const refs = [...refFor(two.view), ...(spreadSignal !== null && fff !== undefined ? refFor(fff) : [])];

  return toScored({
    factorId: id,
    factorName: name,
    weight,
    signal: combined,
    rawSignal: {
      dgs2: latestValue(two.view),
      dgs2Change20d: latestChange(two.view, 20, true),
      policySpread: spreadNow,
    },
    freshness:
      spreadSignal !== null && fff !== undefined
        ? worstFreshness(two.view.freshness, fff.freshness)
        : two.view.freshness,
    factRefs: refs,
    resolvedInputs: [change, spreadSignal].filter((s) => s !== null).length,
    requiredInputs: 2,
    units: { dgs2: 'pp', dgs2Change20d: 'pp', policySpread: 'pp' },
  });
}

// ── F5: inflation, by the documented net rule ───────────────────────────────

export function computeF5(inputs: FundamentalInputs, config: FactorComputeConfig): FactorOutcome {
  const id: FactorId = 'F5';
  const name = 'Inflation';
  const weight = config.factors[id].weight;
  if (!config.factors[id].enabled) {
    return abstain({ factorId: id, factorName: name, weight, reason: 'DISABLED', detail: 'disabled in the active profile' });
  }

  const core = useSeries(inputs, 'CPILFESL');
  if (isMissing(core)) {
    return abstain({ factorId: id, factorName: name, weight, reason: core.missing, detail: core.detail });
  }

  /**
   * F5 combines two opposing channels, explicitly rather than as a judgement call
   * (PRD_V1 §8.5.2): `F5 = 0.4 × hedge − 0.6 × rate_channel`.
   *
   * `hedge` rises with core inflation above target — inflation supports gold. It is
   * scored DIRECT against the history of year-on-year readings.
   *
   * `rate_channel` rises with an upside CPI surprise — a hot print implies tighter
   * policy, which works against gold. It uses the calendar's standardised surprise,
   * so the two channels are on the same scale before they are combined.
   *
   * Both components are returned in `rawSignal` so the user sees the trade-off
   * rather than a net number with no explanation.
   */
  const yoy = yearOnYear(core.view);
  const yoyHistory = changeHistory(valuesOf(core.view), 12, false);
  const hedge =
    yoy === null
      ? null
      : normaliseSignal(
          yoy - config.inflationNetRule.inflationTargetPct,
          yoyHistory.map((v) => v - config.inflationNetRule.inflationTargetPct),
          'DIRECT',
          config.normalisation,
        );

  const cpiSurprise = inputs.surprises.CPI;
  const surpriseZ = cpiSurprise?.surpriseZ ?? null;
  // A hot surprise is bearish for gold, so the rate channel enters with INVERSE sign;
  // the net rule's minus sign is therefore already carried by the sign, and the
  // weights below are both positive.
  const rateChannel =
    surpriseZ === null
      ? null
      : {
          score: -Math.min(1, Math.max(-1, surpriseZ / config.normalisation.clampZ)) * 100,
          zScore: surpriseZ,
          rawZ: surpriseZ,
          inDeadband: Math.abs(surpriseZ) < config.normalisation.deadbandZ,
          clamped: Math.abs(surpriseZ) > config.normalisation.clampZ,
        };

  const combined = combineSignals([
    { signal: hedge, weight: config.inflationNetRule.hedgeWeight },
    { signal: rateChannel, weight: config.inflationNetRule.rateChannelWeight },
  ]);

  if (combined === null) {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'INSUFFICIENT_HISTORY',
      detail: 'neither the inflation hedge channel nor the rate channel could be standardised',
      freshness: core.view.freshness,
      factRefs: refFor(core.view),
    });
  }

  const refs = [...refFor(core.view)];
  if (cpiSurprise !== undefined && rateChannel !== null) {
    refs.push({
      table: 'economic_releases',
      id: cpiSurprise.factId,
      label: cpiSurprise.eventName,
      freshness: cpiSurprise.freshness,
      sourceTier: cpiSurprise.sourceTier,
    });
  }

  return toScored({
    factorId: id,
    factorName: name,
    weight,
    signal: combined,
    rawSignal: {
      coreYoyPct: yoy,
      hedgeComponent: hedge?.score ?? null,
      rateChannelComponent: rateChannel?.score ?? null,
      cpiSurpriseZ: surpriseZ,
    },
    freshness:
      cpiSurprise !== undefined && rateChannel !== null
        ? worstFreshness(core.view.freshness, cpiSurprise.freshness)
        : core.view.freshness,
    factRefs: refs,
    resolvedInputs: [hedge, rateChannel].filter((s) => s !== null).length,
    requiredInputs: 2,
    // Named in words. A completeness of 0.5 tells the user how much weight F5 lost;
    // it does not tell them the missing half is the channel that pushes the OTHER
    // WAY, which is the difference between 'inflation is neutral' and 'the hedge
    // channel is neutral and the rate channel is unmeasured'.
    limitations:
      rateChannel === null
        ? [
            limitationFor(
              inputs,
              'RELEASE_SURPRISE_HISTORY',
              'the rate channel — the policy-tightening response to a hot CPI print, which ' +
                'works against gold and carries 0.6 of this factor',
            ),
          ]
        : [],
    units: { coreYoyPct: '% y/y', hedgeComponent: '', rateChannelComponent: '', cpiSurpriseZ: 'σ' },
  });
}

// ── F6: growth and employment ───────────────────────────────────────────────

export function computeF6(inputs: FundamentalInputs, config: FactorComputeConfig): FactorOutcome {
  const id: FactorId = 'F6';
  const name = 'Growth and employment';
  const weight = config.factors[id].weight;
  if (!config.factors[id].enabled) {
    return abstain({ factorId: id, factorName: name, weight, reason: 'DISABLED', detail: 'disabled in the active profile' });
  }

  const claims = inputs.series.ICSA;
  const unemployment = inputs.series.UNRATE;
  const payrolls = inputs.series.PAYEMS;

  // Strong growth is bearish for gold, so every sub-signal here is INVERSE except
  // unemployment and claims, which move the opposite way to growth and are therefore
  // DIRECT: rising claims mean a weakening economy, which supports gold.
  const claimsSignal =
    claims !== undefined && isUsable(claims.freshness)
      ? changeSignal(claims, 4, false, 'DIRECT', config.normalisation)
      : null;
  const unemploymentSignal =
    unemployment !== undefined && isUsable(unemployment.freshness)
      ? changeSignal(unemployment, 3, true, 'DIRECT', config.normalisation)
      : null;
  const payrollsSignal =
    payrolls !== undefined && isUsable(payrolls.freshness)
      ? changeSignal(payrolls, 3, false, 'INVERSE', config.normalisation)
      : null;

  const nfpSurprise = inputs.surprises.NFP;
  const nfpZ = nfpSurprise?.surpriseZ ?? null;
  const nfpSignal =
    nfpZ === null
      ? null
      : {
          score: -Math.min(1, Math.max(-1, nfpZ / config.normalisation.clampZ)) * 100,
          zScore: nfpZ,
          rawZ: nfpZ,
          inDeadband: Math.abs(nfpZ) < config.normalisation.deadbandZ,
          clamped: Math.abs(nfpZ) > config.normalisation.clampZ,
        };

  const combined = combineSignals([
    { signal: claimsSignal, weight: 0.3 },
    { signal: unemploymentSignal, weight: 0.2 },
    { signal: payrollsSignal, weight: 0.2 },
    { signal: nfpSignal, weight: 0.3 },
  ]);

  if (combined === null) {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'INPUT_UNAVAILABLE',
      detail: 'no usable labour-market input (ICSA, UNRATE, PAYEMS or the NFP surprise)',
    });
  }

  const views = [claims, unemployment, payrolls].filter(
    (v): v is MacroSeriesView => v !== undefined && isUsable(v.freshness),
  );
  const refs = views.flatMap(refFor);
  if (nfpSurprise !== undefined && nfpSignal !== null) {
    refs.push({
      table: 'economic_releases',
      id: nfpSurprise.factId,
      label: nfpSurprise.eventName,
      freshness: nfpSurprise.freshness,
      sourceTier: nfpSurprise.sourceTier,
    });
  }

  const freshnesses = refs.map((r) => r.freshness);
  const freshness =
    freshnesses.length === 0
      ? 'UNAVAILABLE'
      : worstFreshness(freshnesses[0] ?? 'UNAVAILABLE', ...freshnesses.slice(1));

  return toScored({
    factorId: id,
    factorName: name,
    weight,
    signal: combined,
    rawSignal: {
      claimsChange4w: claims === undefined ? null : latestChange(claims, 4, false),
      unemploymentChange3m: unemployment === undefined ? null : latestChange(unemployment, 3, true),
      payrollsChange3m: payrolls === undefined ? null : latestChange(payrolls, 3, false),
      nfpSurpriseZ: nfpZ,
    },
    freshness,
    factRefs: refs,
    resolvedInputs: [claimsSignal, unemploymentSignal, payrollsSignal, nfpSignal].filter(
      (s) => s !== null,
    ).length,
    requiredInputs: 4,
    limitations:
      nfpSignal === null
        ? [
            limitationFor(
              inputs,
              'RELEASE_SURPRISE_HISTORY',
              'the payrolls surprise — how far the latest jobs report landed from consensus',
            ),
          ]
        : [],
    units: { claimsChange4w: '%', unemploymentChange3m: 'pp', payrollsChange3m: '%', nfpSurpriseZ: 'σ' },
  });
}

// ── F7: risk sentiment ──────────────────────────────────────────────────────

export function computeF7(inputs: FundamentalInputs, config: FactorComputeConfig): FactorOutcome {
  const id: FactorId = 'F7';
  const name = 'Risk sentiment';
  const weight = config.factors[id].weight;
  if (!config.factors[id].enabled) {
    return abstain({ factorId: id, factorName: name, weight, reason: 'DISABLED', detail: 'disabled in the active profile' });
  }

  const vix = inputs.series.VIXCLS;
  const spread = inputs.series.BAMLH0A0HYM2;

  // Risk-off is bullish for gold, so rising volatility and widening credit spreads
  // both score DIRECT.
  const vixLevel =
    vix !== undefined && isUsable(vix.freshness)
      ? levelSignal(vix, 'DIRECT', config.normalisation)
      : null;
  const vixChange =
    vix !== undefined && isUsable(vix.freshness)
      ? changeSignal(vix, 5, false, 'DIRECT', config.normalisation)
      : null;
  const spreadChange =
    spread !== undefined && isUsable(spread.freshness)
      ? changeSignal(spread, 20, true, 'DIRECT', config.normalisation)
      : null;

  const combined = combineSignals([
    { signal: vixLevel, weight: 0.3 },
    { signal: vixChange, weight: 0.3 },
    { signal: spreadChange, weight: 0.4 },
  ]);

  if (combined === null) {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'INPUT_UNAVAILABLE',
      detail: 'neither VIXCLS nor BAMLH0A0HYM2 produced a usable signal',
    });
  }

  const views = [vix, spread].filter(
    (v): v is MacroSeriesView => v !== undefined && isUsable(v.freshness),
  );
  const refs = views.flatMap(refFor);
  const freshnesses = refs.map((r) => r.freshness);
  const freshness =
    freshnesses.length === 0
      ? 'UNAVAILABLE'
      : worstFreshness(freshnesses[0] ?? 'UNAVAILABLE', ...freshnesses.slice(1));

  return toScored({
    factorId: id,
    factorName: name,
    weight,
    signal: combined,
    rawSignal: {
      vixLevel: vix === undefined ? null : latestValue(vix),
      vixChange5d: vix === undefined ? null : latestChange(vix, 5, false),
      highYieldSpread: spread === undefined ? null : latestValue(spread),
      spreadChange20d: spread === undefined ? null : latestChange(spread, 20, true),
    },
    freshness,
    factRefs: refs,
    resolvedInputs: [vixLevel, vixChange, spreadChange].filter((s) => s !== null).length,
    requiredInputs: 3,
    units: { vixLevel: '', vixChange5d: '%', highYieldSpread: 'pp', spreadChange20d: 'pp' },
  });
}

// ── F8: geopolitical and policy news pressure ───────────────────────────────

export function computeF8(inputs: FundamentalInputs, config: FactorComputeConfig): FactorOutcome {
  const id: FactorId = 'F8';
  const name = 'Geopolitical and policy news pressure';
  const weight = config.factors[id].weight;
  if (!config.factors[id].enabled) {
    return abstain({ factorId: id, factorName: name, weight, reason: 'DISABLED', detail: 'disabled in the active profile' });
  }

  const news = inputs.news;

  /**
   * F8 is dark, and that is the measured outcome rather than a bug.
   *
   * The twelve seeded feeds yield roughly 3 gold-relevant articles a day, so a
   * 48-hour window holds about 6 against a floor of 10 (PRD_V1 §8.3a). The floor is
   * not arbitrary: the news score is a mean of per-article polarity, and the standard
   * error of a mean falls as sigma/sqrt(n) — below ten the number moves more with
   * which headlines happened to land than with anything about the market.
   *
   * The threshold is evaluated on every run, so this is not a switch to be flipped
   * when feeds are added, and F8 goes dark again by itself if relevant volume falls.
   */
  if (news.kind === 'INSUFFICIENT_VOLUME') {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'BELOW_VOLUME_THRESHOLD',
      // The aggregate measured it and already has the words for it. Re-deriving a
      // sentence from the counts here would be a second definition of the same rule,
      // and it would get the no-signal case wrong.
      detail: news.explanation,
    });
  }

  if (!isUsable(news.freshness)) {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'INPUT_UNAVAILABLE',
      detail: 'the news aggregate is UNAVAILABLE',
      freshness: news.freshness,
    });
  }

  // Market stress is bullish for gold, so a more negative news tone scores DIRECT on
  // the stress reading (the aggregate's polarity is negated into a stress measure).
  const signal = normaliseSignal(-news.polarity, news.history.map((h) => -h), 'DIRECT', config.normalisation);

  if (signal === null) {
    return abstain({
      factorId: id,
      factorName: name,
      weight,
      reason: 'INSUFFICIENT_HISTORY',
      detail: 'not enough news-aggregate history to standardise the current reading',
      freshness: news.freshness,
    });
  }

  const refs: FactRef[] = news.factIds.map((factId) => ({
    table: 'news_articles',
    id: factId,
    label: 'News article',
    freshness: news.freshness,
    sourceTier: news.sourceTier,
  }));

  return toScored({
    factorId: id,
    factorName: name,
    weight,
    signal,
    rawSignal: {
      polarity: news.polarity,
      articleCount: news.articleCount,
      sourceCount: news.sourceCount,
    },
    freshness: news.freshness,
    factRefs: refs,
    resolvedInputs: 1,
    requiredInputs: 1,
    units: { polarity: '', articleCount: '', sourceCount: '' },
  });
}

/** Every factor, in display order. */
export function computeAllFactors(
  inputs: FundamentalInputs,
  config: FactorComputeConfig,
): readonly FactorOutcome[] {
  return [
    computeF1(inputs, config),
    computeF2(inputs, config),
    computeF3(inputs, config),
    computeF4(inputs, config),
    computeF5(inputs, config),
    computeF6(inputs, config),
    computeF7(inputs, config),
    computeF8(inputs, config),
  ];
}

/** Re-exported so callers assembling views do not need a second import. */
export type { SourceTier };
