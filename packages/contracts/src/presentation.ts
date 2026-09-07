/**
 * Presentation rules — how a measurement panel presents itself.
 *
 * Pure functions, no React, so the rules that carry Amendment A3 are testable without
 * a browser and cannot be quietly overridden by a component that forgets them.
 *
 * **The dashboard is where A3 either holds or quietly fails.** Everything upstream is
 * honest: the engine abstains rather than guessing, the guards reject forecasts, the
 * lineage is enforced by the database. None of that survives a UI that implies
 * prediction through visual grammar — and visual grammar predicts without using a
 * single forbidden word:
 *
 * - **A large directional arrow** says "it is going this way". The score says "this is
 *   how conditions read". Those are different claims and only one is measured.
 * - **A red/green gauge** is the visual vocabulary of buy and sell. Traffic lights
 *   instruct; a thermometer describes.
 * - **A number in hero type** reads as a verdict. Size communicates confidence, and
 *   confidence is a separate measured quantity that is frequently lower.
 * - **A needle on a dial** implies a trajectory toward one end.
 *
 * So the rules below are deliberately restrictive about the *form* a reading may take,
 * not just its wording. The score is rendered as a labelled position on a fixed
 * bidirectional scale — a reading, the way an instrument shows a value — and the
 * caveat travels with it as adjacent text, never a tooltip or a footer.
 */

import type { AnalysisResponse, FactorView, Limitation, Provenance } from './analysis.js';

// ── Visual grammar the panel is not permitted to use ────────────────────────

/**
 * Presentation forms that imply prediction, enumerated so the ban is checkable.
 *
 * A component declares the form it renders; `assertMeasurementGrammar` rejects the
 * ones that instruct rather than describe. This exists because "do not make it look
 * like a signal" is not a reviewable instruction, and the difference between a gauge
 * and a scale is exactly the sort of thing that gets lost between a design decision
 * and the component that implements it.
 */
export const PROHIBITED_SCORE_FORMS = [
  /** Points somewhere. A measurement does not have a direction of travel. */
  'DIRECTIONAL_ARROW',
  /** The visual vocabulary of buy and sell. */
  'TRAFFIC_LIGHT',
  /** A needle implies motion toward one end of the dial. */
  'GAUGE_NEEDLE',
  /** Size reads as certainty, which is measured separately and often lower. */
  'HERO_NUMERAL',
  /** A line through time implies the next point. */
  'TREND_SPARKLINE',
] as const;
export type ProhibitedScoreForm = (typeof PROHIBITED_SCORE_FORMS)[number];

/** The forms a reading may take. All of them describe a position, not a trajectory. */
export const PERMITTED_SCORE_FORMS = [
  /** A marker at a position on a fixed, labelled, bidirectional axis. */
  'BIDIRECTIONAL_SCALE',
  /** The number itself, at body weight, beside its band label. */
  'LABELLED_VALUE',
  /** Per-factor bars showing contribution, both directions from a centre line. */
  'CONTRIBUTION_BARS',
] as const;
export type PermittedScoreForm = (typeof PERMITTED_SCORE_FORMS)[number];

export class PresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresentationError';
  }
}

export function assertMeasurementGrammar(form: string): asserts form is PermittedScoreForm {
  if ((PROHIBITED_SCORE_FORMS as readonly string[]).includes(form)) {
    throw new PresentationError(
      `"${form}" implies a forecast. A score describes current measured conditions and has no ` +
        'measured predictive power (Amendment A3), so it may not be rendered in a form that ' +
        `points, instructs, or projects. Permitted forms: ${PERMITTED_SCORE_FORMS.join(', ')}.`,
    );
  }
  if (!(PERMITTED_SCORE_FORMS as readonly string[]).includes(form)) {
    throw new PresentationError(
      `Unknown score presentation form "${form}". Add it to PERMITTED_SCORE_FORMS with a note on ` +
        'why it describes rather than predicts, or use one of: ' +
        PERMITTED_SCORE_FORMS.join(', '),
    );
  }
}

// ── The score block ─────────────────────────────────────────────────────────

export interface ScoreBlock {
  readonly form: PermittedScoreForm;
  /** 0…100, for the marker's position on the axis. */
  readonly position: number;
  /** The signed value, shown as text at body weight. */
  readonly signed: number;
  readonly band: string;
  /**
   * Phrased as a present-tense reading, never as a verdict.
   *
   * "Conditions read bearish" describes; "Bearish" alone reads as a call, and
   * "Bearish signal" is a recommendation wearing a noun.
   */
  readonly readingLabel: string;
  /**
   * Rendered adjacent to the score, in the same block, always.
   *
   * Not a tooltip — a tooltip is a caveat you have to already suspect. Not a footer —
   * a footer is a caveat below the fold. The requirement is that a reader who sees
   * the number sees the qualification in the same glance.
   */
  readonly caveat: string;
  /** True when the axis must show both directions, which is always. */
  readonly bidirectional: true;
}

export function buildScoreBlock(analysis: AnalysisResponse): ScoreBlock | null {
  if (analysis.status !== 'SCORED') return null;
  const form: PermittedScoreForm = 'BIDIRECTIONAL_SCALE';
  assertMeasurementGrammar(form);

  return {
    form,
    position: analysis.score.display,
    signed: analysis.score.signed,
    band: analysis.score.band,
    readingLabel: `Conditions read ${analysis.score.band.toLowerCase()}`,
    caveat: analysis.score.caveat,
    bidirectional: true,
  };
}

// ── Freshness, at the point of the number ───────────────────────────────────

/**
 * A freshness chip is not sufficient on its own.
 *
 * Flagged in Phase 5: `F1` showed a `RECENT` chip on a dollar index published nine
 * days earlier. The chip was technically true — the value was recent *relative to its
 * own publication schedule* — and practically misleading, because a reader takes
 * "recent" to mean "recent", not "recent for a series that publishes weekly in
 * arrears".
 *
 * So where publication lags the period described, the lag is stated **beside the
 * chip**, not one interaction away. A user should never have to hover to discover
 * that a current-looking figure describes last week.
 */
export interface FreshnessBadge {
  readonly status: Provenance['freshness'];
  readonly label: string;
  /** Present whenever the lag is material. Rendered inline, adjacent to the chip. */
  readonly lagNote: string | null;
  /** The period the value describes, where that differs from when it was published. */
  readonly describesPeriod: string | null;
  readonly publishedAt: string;
  readonly sourceName: string;
  readonly sourceTier: Provenance['sourceTier'];
}

const FRESHNESS_LABEL: Readonly<Record<Provenance['freshness'], string>> = {
  LIVE: 'Current',
  RECENT: 'Recent',
  STALE: 'Stale',
  UNAVAILABLE: 'Unavailable',
};

/** Lag at or above this many days is disclosed inline (PRD_V1 §8.5.2a). */
export const LAG_DISCLOSURE_THRESHOLD_DAYS = 3;

export function buildFreshnessBadge(provenance: Provenance): FreshnessBadge {
  const lag = provenance.publicationLagDays;
  const material = lag !== null && lag >= LAG_DISCLOSURE_THRESHOLD_DAYS;

  return {
    status: provenance.freshness,
    label: FRESHNESS_LABEL[provenance.freshness],
    lagNote: material
      ? `describes data from ${String(lag)} days before publication`
      : null,
    describesPeriod: null,
    publishedAt: provenance.publishedAt,
    sourceName: provenance.sourceName,
    sourceTier: provenance.sourceTier,
  };
}

/**
 * True when a freshness chip alone would mislead.
 *
 * Used by tests and by the component that renders the chip, so the pairing cannot be
 * separated: a badge with a lag note must render both parts or neither.
 */
export function requiresLagDisclosure(provenance: Provenance): boolean {
  return (
    provenance.publicationLagDays !== null &&
    provenance.publicationLagDays >= LAG_DISCLOSURE_THRESHOLD_DAYS
  );
}

// ── Gaps, at equal weight, grouped by attribution ───────────────────────────

export interface GapGroup {
  readonly attribution: Limitation['attribution'];
  readonly heading: string;
  /** What this category means, so the grouping is self-explaining. */
  readonly meaning: string;
  readonly entries: readonly GapEntry[];
  /**
   * `CONFIGURATION` should never appear in production. When it does, it is a defect
   * report rather than a reading, and the panel says so rather than styling it like
   * the others.
   */
  readonly isDefect: boolean;
}

export interface GapEntry {
  readonly factorId: string;
  readonly factorName: string;
  /** Dark (abstained entirely) or partial (scored, missing a sub-signal). */
  readonly extent: 'DARK' | 'PARTIAL';
  readonly what: string;
  readonly why: string;
  /** The condition under which it resolves. Null where genuinely unknown. */
  readonly resolution: string | null;
  readonly weight: number;
}

const GROUP_META: Readonly<
  Record<Limitation['attribution'], { heading: string; meaning: string; isDefect: boolean }>
> = {
  WORLD: {
    heading: 'Not measured this run',
    meaning:
      'The data does not exist yet or the source had nothing to report. This is information ' +
      'about current conditions, not a fault.',
    isDefect: false,
  },
  STRUCTURAL: {
    heading: 'Not obtainable on current sources',
    meaning:
      'The data exists but is not reachable from the free sources this product uses. A known, ' +
      'standing constraint rather than an outage.',
    isDefect: false,
  },
  CONFIGURATION: {
    heading: 'Configuration defect',
    meaning:
      'A factor cannot produce a reading because of how this system is set up. This should ' +
      'never appear in production and is a bug, not a market condition.',
    isDefect: true,
  },
};

/**
 * Every gap in the run, grouped so a reader can see at a glance what is dark and what
 * is half-lit.
 *
 * **Gaps get the same visual weight as scores.** A factor that abstained is not an
 * error state to be tucked into a corner — it is the product telling the truth about
 * what it knows, which is the main thing it offers over a chart with indicators on it.
 * Hiding it would leave a seven-factor reading looking like an eight-factor one.
 */
export function buildGapGroups(analysis: AnalysisResponse): readonly GapGroup[] {
  const byAttribution = new Map<Limitation['attribution'], GapEntry[]>();

  const push = (attribution: Limitation['attribution'], entry: GapEntry): void => {
    const existing = byAttribution.get(attribution);
    if (existing === undefined) byAttribution.set(attribution, [entry]);
    else existing.push(entry);
  };

  for (const factor of analysis.factors) {
    if (factor.kind === 'ABSTAINED') {
      push(factor.attribution, {
        factorId: factor.factorId,
        factorName: factor.factorName,
        extent: 'DARK',
        what: 'produced no reading',
        why: factor.detail,
        resolution: null,
        weight: factor.weight,
      });
      continue;
    }
    for (const limitation of factor.limitations) {
      push(limitation.attribution, {
        factorId: factor.factorId,
        factorName: factor.factorName,
        extent: 'PARTIAL',
        what: `excludes ${limitation.missing}`,
        why: limitation.reason,
        resolution: limitation.resolution,
        weight: factor.weight,
      });
    }
  }

  // Defects first: they are the only category a reader must act on.
  const order: Limitation['attribution'][] = ['CONFIGURATION', 'STRUCTURAL', 'WORLD'];
  return order
    .filter((a) => byAttribution.has(a))
    .map((attribution) => ({
      attribution,
      ...GROUP_META[attribution],
      entries: byAttribution.get(attribution) ?? [],
    }));
}

/** Share of total factor weight that is dark or partial — the headline of the gaps panel. */
export function gapWeight(analysis: AnalysisResponse): number {
  const total = analysis.factors.reduce((s, f) => s + f.weight, 0);
  if (total <= 0) return 0;
  const missing = analysis.factors.reduce((s, f) => {
    if (f.kind === 'ABSTAINED') return s + f.weight;
    return s + f.weight * (1 - f.inputCompleteness);
  }, 0);
  return missing / total;
}

/**
 * A one-line statement of what the panel is showing, for the top of the page.
 *
 * States coverage as a count of factors rather than a percentage: "seven of eight
 * factors" is something a reader can picture, and "81.5% coverage" is a number that
 * sounds like a score.
 */
export function coverageSentence(analysis: AnalysisResponse): string {
  const scored = analysis.factors.filter((f) => f.kind === 'SCORED').length;
  const total = analysis.factors.length;
  const partial = analysis.factors.filter(
    (f) => f.kind === 'SCORED' && f.limitations.length > 0,
  ).length;

  const base = `${describeCount(scored)} of ${String(total)} factors produced a reading`;
  if (partial === 0) return `${base}.`;
  return `${base}; ${describeCount(partial)} of those ${partial === 1 ? 'is' : 'are'} partly measured.`;
}

function describeCount(n: number): string {
  const words = ['none', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
  return words[n] ?? String(n);
}

// ── The three layers ────────────────────────────────────────────────────────

export interface LayerBlock {
  readonly layer: 'FACT' | 'INTERPRETATION' | 'AI_ASSESSMENT';
  readonly heading: string;
  /** Shown beside the heading so a reader knows what kind of claim they are reading. */
  readonly meaning: string;
  readonly statements: readonly {
    readonly id: string;
    readonly body: string;
    readonly provenance: Provenance | null;
    readonly derivedFrom: readonly string[];
  }[];
}

const LAYER_META: Readonly<Record<LayerBlock['layer'], { heading: string; meaning: string }>> = {
  FACT: {
    heading: 'Facts',
    meaning: 'Values as published by their source, with provenance. Nothing here is inferred.',
  },
  INTERPRETATION: {
    heading: 'Interpretation',
    meaning:
      'What the deterministic engine computed from those facts. Generated from templates and ' +
      'real values — not written by a model.',
  },
  AI_ASSESSMENT: {
    heading: 'AI assessment',
    meaning:
      'Written by a language model from the facts above, checked against them, and shown only ' +
      'if every number it states appears in the evidence. Absent when the model was ' +
      'unavailable or its response was rejected.',
  },
};

export function buildLayerBlocks(analysis: AnalysisResponse): readonly LayerBlock[] {
  const layers: LayerBlock['layer'][] = ['FACT', 'INTERPRETATION', 'AI_ASSESSMENT'];
  return layers.map((layer) => ({
    layer,
    ...LAYER_META[layer],
    statements: analysis.statements
      .filter((s) => s.layer === layer)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((s) => ({
        id: s.id,
        body: s.body,
        provenance: s.provenance,
        derivedFrom: s.derivedFrom,
      })),
  }));
}

/** Factors in display order, scored and abstained together — never two separate lists. */
export function orderedFactors(analysis: AnalysisResponse): readonly FactorView[] {
  return [...analysis.factors].sort((a, b) => a.factorId.localeCompare(b.factorId));
}
