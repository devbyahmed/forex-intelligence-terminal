/**
 * Semantic guards (Amendment A3, master §23, §43, §44).
 *
 * A schema proves the response is *shaped* correctly. It says nothing about whether
 * the content is true, and the two failures that matter here are both well-formed:
 *
 *  - **A fabricated number.** `"the dollar index at 121.4"` when the bundle says
 *    118.75 is a valid string in a valid field. Nothing structural is wrong with it,
 *    and it is the single most damaging thing this product could emit, because a
 *    figure attributed to measured data is exactly what a user will not re-check.
 *  - **A predictive claim.** `"gold should rally"` is likewise well-formed, and
 *    forbidden until V6 supplies measured evidence for it (Amendment A3).
 *
 * So every number in the response is checked against the bundle, and the prose is
 * checked against a prohibited-claim lexicon. Both are mechanical: the bundle is the
 * complete vocabulary of permitted figures, because the AI package cannot reach the
 * database or the providers and therefore cannot legitimately know anything else.
 *
 * **These guards reject; they never rewrite.** Editing a model's output to remove a
 * forbidden phrase produces text that passes the check while the reasoning behind it
 * remains whatever it was. A response that breaks the rules is discarded, and the
 * deterministic layers — which are the ones carrying the actual claims — are shown
 * without it.
 */

import type { Assessment } from './schema.js';

export const GUARD_CODES = [
  'FABRICATED_NUMBER',
  'PREDICTIVE_CLAIM',
  'TRADING_ADVICE',
  'UNKNOWN_FACTOR',
  'ABSENT_FACTOR_CITED',
  'MISSING_DATA_GAP_DISCLOSURE',
  'OVERSTATED_CERTAINTY',
] as const;
export type GuardCode = (typeof GUARD_CODES)[number];

export interface GuardViolation {
  readonly code: GuardCode;
  readonly detail: string;
  /** The offending fragment, so a rejection can be read without guessing. */
  readonly evidence: string;
  readonly field: string;
}

export interface GuardContext {
  /** Every number the model is permitted to state, already rounded as the bundle is. */
  readonly permittedNumbers: readonly number[];
  /** Factor ids present in this run. */
  readonly knownFactorIds: readonly string[];
  /** Factor ids that abstained — citable as gaps, never as drivers. */
  readonly abstainedFactorIds: readonly string[];
  /** True when the run has abstentions the summary is obliged to mention. */
  readonly requiresGapDisclosure: boolean;
}

/**
 * Language that asserts a future outcome.
 *
 * Word-boundary anchored so ordinary prose survives: "will" must not fire on
 * "willing", and "target" must not fire on "targeted inflation". A guard that cries
 * wolf gets loosened, and a loosened guard is worse than none.
 */
/** Verbs that describe a price going somewhere. */
const DIRECTIONAL = 'rise|rises|fall|falls|rally|rallies|drop|drops|climb|climbs|decline|declines|continue|continues|break|breaks|reach|reaches|test|tests|strengthen|strengthens|weaken|weakens|extend|extends|recover|recovers';

const PREDICTIVE_PATTERNS: readonly { readonly re: RegExp; readonly why: string }[] = [
  /**
   * Modal + optional adverb + directional verb.
   *
   * The adverb slot is why this is not simply `will\s+rally`. A live run produced
   * **"Gold will likely rally as real yields decline further"**, which passed every
   * pattern here: `will rally` did not match because "likely" sat between them, and
   * `likely to` did not match because there was no "to". The canonical predictive
   * sentence in financial prose walked straight through the guard written to stop it.
   */
  {
    re: new RegExp(
      String.raw`\b(?:will|would|could|should|may|might|shall)\s+(?:\w+ly\s+)?(?:` +
        DIRECTIONAL +
        String.raw`)\b`,
      'i',
    ),
    why: 'asserts a future price move',
  },
  /** "likely" in any construction — hedged prediction is still prediction. */
  { re: /\b(?:un)?likely\b/i, why: 'hedges a forecast rather than describing a measurement' },
  // `projection` is deliberately absent: it appears in legitimate disclaimers —
  // "this describes measured conditions, not a projection" — and a guard that fires
  // on a sentence denying a forecast is the kind that gets switched off. Verb forms
  // only.
  /**
   * `forecast` is matched as a **verb only**.
   *
   * As a noun it names a data type we talk about constantly and legitimately:
   * "historical consensus forecasts are not available from any free source" is the
   * disclosure the product is required to make about F5's missing rate channel. The
   * first version of this pattern matched the bare word and rejected the model for
   * correctly stating our own limitation — the guard firing on the very sentence it
   * exists to protect.
   *
   * The verb forms need a subject or a complement; the noun does not.
   */
  { re: /\b(?:we|i|they|analysts?|markets?|traders?)\s+(?:expect|anticipate|forecast|predict)s?\b/i, why: 'states an expectation' },
  { re: /\bforecasts?\s+(?:that|continued|further|a\s+\w+\s+(?:move|rise|fall))\b/i, why: 'makes a forecast' },
  { re: /\bis\s+(?:expected|anticipated|forecast|predicted|projected)\s+to\b/i, why: 'states an expectation' },
  { re: /\b(?:expects|anticipates|predicts|projecting)\b/i, why: 'states an expectation' },
  { re: /\bexpect\s+(?:a|an|the|further|continued)\b/i, why: 'states an expectation' },
  { re: /\b(?:set to|poised to|on track to|bound to|due to\s+(?:rise|fall))\s*\w*/i, why: 'implies a likely outcome' },
  {
    re: new RegExp(
      String.raw`\b(?:` + DIRECTIONAL + String.raw`)\s+(?:further|from here|going forward)\b`,
      'i',
    ),
    why: 'projects a continuing move',
  },
  { re: /\b(?:bullish|bearish)\s+(?:outlook|forecast|prognosis)\b/i, why: 'frames the reading as a forecast' },
  { re: /\b(?:upside|downside)\s+(?:potential|risk\s+to\s+the\s+price)\b/i, why: 'implies a directional expectation' },
  { re: /\bin\s+the\s+(?:coming|next)\s+(?:days?|weeks?|months?|sessions?)\b/i, why: 'projects forward in time' },

  /**
   * The forms below were all found by the adversarial corpus, not by design.
   *
   * Each is a way of predicting without using a predictive verb, which is exactly how
   * market commentary is written — the forecast lives in a noun ("probability",
   * "odds", "target") or in a phrasal construction ("sets up for", "move toward")
   * rather than in a modal. A word-list guard misses all of them.
   */
  { re: /\b(?:probability|probabilities|likelihood)\s+of\b/i, why: 'states a probability of an outcome' },
  { re: /\bodds\s+(?:favour|favor|of|are)\b/i, why: 'frames the reading as odds on an outcome' },
  { re: /\bchances?\s+of\s+(?:a\s+)?\w+/i, why: 'states a chance of an outcome' },
  { re: /\brisk\s+of\s+(?:a\s+|further\s+)*(?:move|decline|rally|drop|fall|rise|break)/i, why: 'projects a possible move' },
  { re: /\bsets?\s+up\s+for\b/i, why: 'trader setup language implying a coming move' },
  { re: /\bmove\s+(?:toward|towards|lower|higher|up|down)\b/i, why: 'names a directional move to come' },
  { re: /\bprice\s+targets?\b/i, why: 'names a level the price is expected to reach' },
  { re: /\b(?:further|continued|sustained)\s+(?:downside|upside|weakness|strength|pressure)\b/i, why: 'projects the current move continuing' },
];

const ADVICE_PATTERNS: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /\b(?:buy|sell|short|long)\s+(?:gold|xau|the\s+metal|here|now)\b/i, why: 'gives a trade instruction' },
  { re: /\b(?:entry|exit|stop[-\s]?loss|take[-\s]?profit|price\s+target)\b/i, why: 'names a trade level' },
  { re: /\b(?:position\s+siz|risk\s+per\s+trade|allocate\s+\d)/i, why: 'gives position guidance' },
  { re: /\b(?:recommend|advise|suggest)\s+(?:buying|selling|holding|a\s+position)/i, why: 'gives a recommendation' },
];

/**
 * Language claiming more certainty than a descriptive reading supports.
 *
 * Distinct from the predictive guard: these do not assert a future, they overstate
 * the present. "Confirms" and "proves" turn a weighted average of eight factors into
 * a settled fact about the world.
 */
const CERTAINTY_PATTERNS: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /\b(?:confirms|proves|guarantees|certainly|undoubtedly|without\s+doubt)\b/i, why: 'overstates certainty' },
  { re: /\bclear\s+(?:signal|indication)\s+that\b/i, why: 'presents a reading as a signal' },
];

/**
 * Numbers the model may always use, because they are structural rather than measured.
 *
 * Factor ids (1–8), the scale bounds, and small integers it needs to count things it
 * was given. Without this a sentence like "three of eight factors" is a fabrication,
 * which would train whoever reads the rejections to ignore them.
 */
const STRUCTURAL_NUMBERS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 100, -100]);

/**
 * Prohibited claims in arbitrary prose.
 *
 * Exported so **our own copy is held to the same standard as the model's**. The daily
 * report is written from a template, and template prose never passes through
 * `runGuards` — so nothing would stop the template author writing "should continue"
 * except a second, hand-typed copy of these patterns, which would drift.
 *
 * That is not hypothetical: the first version of the report test re-typed the patterns
 * and immediately produced a false positive the real guard does not have, flagging the
 * disclaimer "they are not forecasts" on the noun form of `forecast`. One definition,
 * used everywhere, or the definitions disagree about what the rule is.
 */
export function findProhibitedClaims(
  text: string,
): readonly { readonly code: GuardCode; readonly why: string; readonly match: string }[] {
  const found: { code: GuardCode; why: string; match: string }[] = [];

  const scan = (patterns: readonly { re: RegExp; why: string }[], code: GuardCode): void => {
    for (const { re, why } of patterns) {
      const m = re.exec(text);
      if (m !== null) found.push({ code, why, match: m[0] });
    }
  };

  scan(PREDICTIVE_PATTERNS, 'PREDICTIVE_CLAIM');
  scan(ADVICE_PATTERNS, 'TRADING_ADVICE');
  scan(CERTAINTY_PATTERNS, 'OVERSTATED_CERTAINTY');
  return found;
}

/**
 * Every number appearing in a string, including negatives and decimals.
 *
 * ── The lookahead excludes digits and dots, not letters ─────────────────────
 *
 * Excluding letters looked right and silently corrupted any number carrying a unit.
 * The regex engine backtracks rather than failing, so `4.77pp` matched as **4.7** and
 * `48h` matched as **4** — the guard then compared a number the model never wrote
 * against the bundle and called correct output fabricated. Two real model responses
 * were rejected this way before it was noticed, and the rejection message named a
 * figure that appeared nowhere in the conversation.
 *
 * Excluding a following digit or dot cannot backtrack into a shorter number, so a
 * number is read whole or not at all. `F1` and `H.15` are still skipped: both are
 * blocked by the lookbehind, which is what was doing that work all along.
 */
export function extractNumbers(text: string): readonly number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z\d.])(-?\d+(?:\.\d+)?)(?![\d.])/g)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Is this number attributable to the bundle?
 *
 * Compared with a tolerance because a model restating `-7.15` as `-7.1` is rounding,
 * not inventing, and rejecting that would make the guard unusable. The tolerance is
 * relative for large values and absolute for small ones, so `158881` matches
 * `158,881` while `0.4` does not match `0.9`.
 */
function isPermitted(n: number, permitted: readonly number[]): boolean {
  if (STRUCTURAL_NUMBERS.has(n)) return true;
  return permitted.some((p) => {
    const tolerance = Math.max(0.05, Math.abs(p) * 0.005);
    return Math.abs(p - n) <= tolerance;
  });
}

export function runGuards(assessment: Assessment, context: GuardContext): readonly GuardViolation[] {
  const violations: GuardViolation[] = [];

  const fields: readonly { readonly name: string; readonly text: string }[] = [
    { name: 'headline', text: assessment.headline },
    { name: 'summary', text: assessment.summary },
    ...assessment.keyDrivers.map((d, i) => ({
      name: `keyDrivers[${String(i)}].statement`,
      text: d.statement,
    })),
    ...assessment.dataGaps.map((g, i) => ({ name: `dataGaps[${String(i)}]`, text: g })),
  ];

  for (const field of fields) {
    for (const n of extractNumbers(field.text)) {
      if (!isPermitted(n, context.permittedNumbers)) {
        violations.push({
          code: 'FABRICATED_NUMBER',
          detail: `The figure ${String(n)} does not appear in the evidence bundle`,
          evidence: excerpt(field.text, String(n)),
          field: field.name,
        });
      }
    }

    for (const { re, why } of PREDICTIVE_PATTERNS) {
      const m = re.exec(field.text);
      if (m !== null) {
        violations.push({
          code: 'PREDICTIVE_CLAIM',
          detail: `Prohibited by Amendment A3 — ${why}`,
          evidence: excerpt(field.text, m[0]),
          field: field.name,
        });
      }
    }

    for (const { re, why } of ADVICE_PATTERNS) {
      const m = re.exec(field.text);
      if (m !== null) {
        violations.push({
          code: 'TRADING_ADVICE',
          detail: `Prohibited — ${why}`,
          evidence: excerpt(field.text, m[0]),
          field: field.name,
        });
      }
    }

    for (const { re, why } of CERTAINTY_PATTERNS) {
      const m = re.exec(field.text);
      if (m !== null) {
        violations.push({
          code: 'OVERSTATED_CERTAINTY',
          detail: `Prohibited — ${why}`,
          evidence: excerpt(field.text, m[0]),
          field: field.name,
        });
      }
    }
  }

  const known = new Set(context.knownFactorIds);
  const abstained = new Set(context.abstainedFactorIds);

  for (const [i, driver] of assessment.keyDrivers.entries()) {
    if (!known.has(driver.factorId)) {
      violations.push({
        code: 'UNKNOWN_FACTOR',
        detail: `${driver.factorId} is not a factor in this run`,
        evidence: driver.factorId,
        field: `keyDrivers[${String(i)}].factorId`,
      });
    } else if (abstained.has(driver.factorId)) {
      // Citing an abstaining factor as a driver is the subtle version of inventing
      // data: the factor exists, so the id checks out, but it produced no reading and
      // therefore drove nothing.
      violations.push({
        code: 'ABSENT_FACTOR_CITED',
        detail: `${driver.factorId} abstained and produced no reading, so it cannot be a key driver`,
        evidence: driver.statement,
        field: `keyDrivers[${String(i)}].factorId`,
      });
    }
  }

  for (const [i, id] of assessment.factorsCited.entries()) {
    if (!known.has(id)) {
      violations.push({
        code: 'UNKNOWN_FACTOR',
        detail: `${id} is not a factor in this run`,
        evidence: id,
        field: `factorsCited[${String(i)}]`,
      });
    }
  }

  if (context.requiresGapDisclosure && assessment.dataGaps.length === 0) {
    violations.push({
      code: 'MISSING_DATA_GAP_DISCLOSURE',
      detail:
        'This run has factors that produced no reading, and the assessment does not mention any. ' +
        'A summary that omits its gaps reads as though the picture were complete.',
      evidence: assessment.summary.slice(0, 120),
      field: 'dataGaps',
    });
  }

  return violations;
}

/** Build the permitted-number vocabulary from a bundle. */
export function permittedNumbersFrom(bundle: unknown): readonly number[] {
  const out = new Set<number>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      /*
       * Prose in the bundle is evidence too. An abstention that explains itself with
       * a window and a threshold — "in the last 48h; 10 are required" — has stated
       * those figures as surely as a numeric field would, and a model restating them
       * is quoting the evidence it was given.
       *
       * The same extractor as the model side, deliberately: one definition of what
       * counts as a number, or the two sides disagree and the disagreement reads as
       * fabrication.
       */
      for (const n of extractNumbers(value)) out.add(n);
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.add(value);
      // A model quoting a percentage from a ratio, or the absolute of a signed score,
      // is restating rather than inventing.
      out.add(Math.round(value * 100) / 100);
      out.add(Math.abs(value));
      out.add(Math.round(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(bundle);
  return [...out];
}

function excerpt(text: string, needle: string): string {
  const i = text.indexOf(needle);
  if (i === -1) return text.slice(0, 120);
  return text.slice(Math.max(0, i - 40), Math.min(text.length, i + needle.length + 40)).trim();
}
