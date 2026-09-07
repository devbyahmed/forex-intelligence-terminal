/**
 * Deterministic factor explanations (master §12, Amendment A3).
 *
 * **These are templates filled with real values, never AI prose.** The distinction is
 * load-bearing rather than stylistic: an explanation generated here is a FACT-layer
 * statement — it restates numbers the system measured — while anything a model wrote
 * is an AI_ASSESSMENT and has to be labelled, attributed to its generation, and kept
 * behind the boundary the schema enforces (Amendment A2). Producing explanation text
 * from a model and rendering it beside the score would collapse that boundary at the
 * one place users are most likely to trust it.
 *
 * Two rules govern the wording, both from Amendment A3:
 *
 * **Descriptive, never predictive.** These sentences say what a series *has done* and
 * what the factor *currently reads*. They never say what will happen, what the score
 * implies about future prices, or that a reading is a signal to act. No measured
 * evidence for predictive power exists until V6 supplies it, so no copy may imply it.
 *
 * **The deadband and the clamp are stated, not hidden.** A factor reading zero because
 * its signal sat inside the deadband is materially different from one reading zero by
 * coincidence, and a clamped reading is one whose true magnitude the score does not
 * show. Both get said out loud.
 */

import type { FreshnessStatus } from '@forex-agent/core';
import type { NormalisedSignal } from './normalise.js';
import type { FactorLimitation } from './factor.js';

export interface ExplainArgs {
  readonly factorName: string;
  readonly score: number;
  readonly signal: NormalisedSignal;
  readonly rawSignal: Readonly<Record<string, number | null>>;
  readonly freshness: FreshnessStatus;
  /**
   * The unit of each raw value, keyed as `rawSignal` is.
   *
   * Declared per key rather than inferred. An earlier version guessed the unit from
   * the key name and rendered the dollar index level of 118.06 as "+118.06%", which
   * is not a rounding problem — it is a false statement about a number the user is
   * being asked to trust. A missing key renders without a unit, which is merely
   * uninformative rather than wrong.
   */
  readonly units: Readonly<Record<string, string>>;
  /** Sub-signals absent from this reading, disclosed in the sentence itself. */
  readonly limitations?: readonly FactorLimitation[];
}

/** Number formatting that never renders `-0` or a run of noise digits. */
export function fmt(value: number | null, unit = '', digits = 2): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  const rounded = Number(value.toFixed(digits));
  const normalised = Object.is(rounded, -0) ? 0 : rounded;
  const sign = normalised > 0 ? '+' : '';
  return `${sign}${String(normalised)}${unit}`;
}

const FRESHNESS_PHRASE: Readonly<Record<FreshnessStatus, string>> = {
  LIVE: 'current data',
  RECENT: 'recent data',
  STALE: 'stale data',
  UNAVAILABLE: 'unavailable data',
};

/**
 * One sentence describing what the factor read.
 *
 * Deliberately built by concatenation rather than by picking one of several
 * hand-written sentences: every branch has to be reachable and testable, and a
 * template chosen by score band tends to acquire adjectives that drift towards
 * forecasting.
 */
export function explainFactor(args: ExplainArgs): string {
  const parts: string[] = [];

  const directionWord =
    args.score > 0 ? 'supportive of gold' : args.score < 0 ? 'a headwind for gold' : 'neutral';

  const quoted = quoteInputs(args.rawSignal, args.units);
  parts.push(
    `${args.factorName} reads ${fmt(args.score, '', 1)} on the −100…+100 scale ` +
      `(${directionWord})`,
  );

  if (quoted !== '') parts.push(`based on ${quoted}`);

  if (args.signal.inDeadband) {
    // Says which kind of zero this is. A deadbanded zero is a measurement.
    parts.push(
      `the standardised signal of ${fmt(args.signal.rawZ, 'σ')} fell inside the neutral band, ` +
        'so the factor is recorded as no signal rather than a direction',
    );
  } else if (args.signal.clamped) {
    parts.push(
      `the standardised signal of ${fmt(args.signal.rawZ, 'σ')} was capped at the ±3σ limit, ` +
        'so the score understates how unusual the move is',
    );
  } else {
    parts.push(`standardised at ${fmt(args.signal.zScore, 'σ')} against its own trailing history`);
  }

  parts.push(`computed from ${FRESHNESS_PHRASE[args.freshness]}`);

  let sentence = `${parts.join('; ')}.`;

  /**
   * The limitation is appended as its own sentence, not folded into the clause list.
   *
   * "Inflation reads 0 (neutral)" is true and, on its own, misleading: it invites the
   * reader to conclude that inflation is not currently pushing gold either way, when
   * what actually happened is that one of the two opposing channels was measured and
   * the other was not measured at all. A percentage cannot carry that; a sentence can.
   */
  for (const limitation of args.limitations ?? []) {
    sentence +=
      ` This reading excludes ${limitation.missing}, because ${limitation.reason}` +
      `${limitation.resolution === null ? '' : `; it ${limitation.resolution}`}.`;
  }

  return sentence;
}

/** The two or three most informative raw values, each in its own declared unit. */
function quoteInputs(
  raw: Readonly<Record<string, number | null>>,
  units: Readonly<Record<string, string>>,
): string {
  const present = Object.entries(raw).filter(
    (entry): entry is [string, number] => entry[1] !== null && Number.isFinite(entry[1]),
  );
  if (present.length === 0) return '';

  return present
    .slice(0, 3)
    .map(([key, value]) => `${humanise(key)} ${fmt(value, units[key] ?? '')}`)
    .join(', ');
}

function humanise(key: string): string {
  return key
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/\bYoy\b/i, 'year-on-year')
    .replace(/\bDgs2\b/i, '2-year yield')
    .replace(/\bVix\b/i, 'VIX')
    .replace(/\bNfp\b/i, 'payrolls')
    .replace(/\bCpi\b/i, 'CPI')
    .toLowerCase();
}

/**
 * The sentence shown when the whole analysis is withheld.
 *
 * Phrased as a statement about our data, not about the market. "We cannot judge" is
 * honest; "conditions are unclear" would be a claim about the world that the missing
 * data gives us no standing to make.
 */
export function explainInsufficiency(coverage: number, floor: number, missing: readonly string[]): string {
  const pct = (n: number): string => `${String(Math.round(n * 100))}%`;
  const list = missing.length === 0 ? '' : ` Unavailable: ${missing.join(', ')}.`;
  return (
    `No score is published for this run. Factor coverage reached ${pct(coverage)}, ` +
    `below the ${pct(floor)} minimum, so the available data does not support a reading.${list}`
  );
}
