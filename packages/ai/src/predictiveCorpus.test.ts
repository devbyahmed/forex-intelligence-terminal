/**
 * Adversarial corpus for the predictive-claim guard.
 *
 * This guard is the weakest enforcement in the system, and it is the one standing
 * between the product and an implied forecast. Everything else — the schema, the
 * abstention rules, the lineage constraints — is structural and either holds or fails
 * loudly. This is regex over natural language, and on its first realistic test it
 * **failed against its own author**: "Gold will likely rally as real yields decline
 * further" passed every pattern written to stop exactly that sentence.
 *
 * Two regression cases were not enough to establish that it works. What follows is
 * adversarial: sentences phrased the way a market commentator actually phrases them,
 * across the forms prediction takes — modal verbs, hedged probability, conditionals,
 * targets, technical setup language, timeframes, and the passive constructions used
 * to imply a forecast without owning one.
 *
 * The negative half matters just as much. A guard that fires on legitimate
 * descriptive prose gets loosened, and a loosened guard protects nothing. Ten
 * sentences that must pass, several of them deliberately close to the line.
 */

import { describe, expect, it } from 'vitest';
import { runGuards, permittedNumbersFrom, type GuardContext } from './guards.js';
import type { Assessment } from './schema.js';

const BUNDLE = {
  score: { signed: -14.6, display: 43 },
  confidence: { value: 88 },
  coverage: 0.815,
  factors: [
    { id: 'F1', score: -7.1 },
    { id: 'F2', score: -27.7 },
    { id: 'F7', score: -31.9 },
  ],
  facts: [{ value: 118.75 }, { value: 2.42 }, { value: 14.43 }],
};

const CONTEXT: GuardContext = {
  permittedNumbers: permittedNumbersFrom(BUNDLE),
  knownFactorIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'],
  abstainedFactorIds: [],
  requiresGapDisclosure: false,
};

const base: Assessment = {
  headline: 'Real yields and risk sentiment weigh on gold',
  summary: 'The fundamental reading is -14.6 with coverage of 0.815.',
  keyDrivers: [{ factorId: 'F2', statement: 'The real 10-year yield reads -27.7.' }],
  dataGaps: [],
  factorsCited: ['F2'],
};

const check = (text: string): readonly string[] =>
  runGuards({ ...base, summary: `${base.summary} ${text}` }, CONTEXT).map((v) => v.code);

/**
 * Sentences a market commentator would write, each carrying an implied forecast.
 *
 * Grouped by the grammatical device that does the predicting, because that is what
 * the patterns have to cover — not a list of banned words.
 */
const PREDICTIVE: readonly { readonly form: string; readonly text: string }[] = [
  // ── Modal verbs, with and without an intervening adverb ──────────────────
  { form: 'bare modal', text: 'Gold will rise as real yields fall.' },
  { form: 'modal + adverb (the case that defeated the first version)', text: 'Gold will likely rally as real yields decline further.' },
  { form: 'softer modal', text: 'Gold could climb if risk sentiment deteriorates.' },
  { form: 'obligation modal', text: 'Gold should test the upper end of its recent range.' },
  { form: 'remote modal', text: 'The metal might weaken should the dollar recover.' },

  // ── Probability and hedging ──────────────────────────────────────────────
  { form: 'bare likelihood', text: 'A softer dollar is likely from here.' },
  { form: 'negated likelihood', text: 'A sustained rally is unlikely on this reading.' },
  { form: 'explicit probability', text: 'There is a strong probability of further downside.' },
  { form: 'odds language', text: 'The odds favour a move lower in the metal.' },
  { form: 'risk-of framing', text: 'The risk of a move toward lower levels is elevated.' },

  // ── Expectation verbs ────────────────────────────────────────────────────
  { form: 'first person expectation', text: 'We expect the dollar to weaken from here.' },
  { form: 'passive expectation', text: 'Gold is expected to remain under pressure.' },
  { form: 'anticipation', text: 'Markets anticipate a softer inflation print next month.' },
  { form: 'forecast noun used as a verb', text: 'We forecast continued weakness in the metal.' },

  // ── Targets and levels ───────────────────────────────────────────────────
  { form: 'explicit target', text: 'A price target below the recent range applies.' },
  { form: 'move toward a level', text: 'Expect a move toward the lower end of the range.' },
  { form: 'trader setup language', text: 'This sets up for a decline in the metal.' },
  { form: 'testing a level', text: 'Gold should test support on this reading.' },

  // ── Time projection ──────────────────────────────────────────────────────
  { form: 'named horizon', text: 'Pressure is set to persist in the coming weeks.' },
  { form: 'continuation', text: 'Real yields should decline further from here.' },
  { form: 'trajectory noun', text: 'The bearish outlook remains intact into month end.' },

  // ── Conditional forecast ─────────────────────────────────────────────────
  { form: 'if-then forecast', text: 'If real yields fall, gold will recover.' },
  { form: 'conditional with modal', text: 'Should the dollar weaken, the metal would strengthen.' },
];

/**
 * Sentences that must pass.
 *
 * Several sit deliberately close to the line — they describe a past move, deny a
 * forecast, or use a word that appears in the banned patterns in a legitimate sense.
 * If the guard cannot tell these from the list above, it is unusable and will be
 * switched off, which is worse than not having it.
 */
const DESCRIPTIVE: readonly { readonly why: string; readonly text: string }[] = [
  { why: 'plain reading', text: 'The fundamental reading is -14.6 on the signed scale.' },
  { why: 'past movement', text: 'Real yields rose over the past twenty sessions.' },
  { why: 'measured state', text: 'Risk sentiment reads -31.9 on current volatility and credit spreads.' },
  { why: 'explicit denial of forecasting', text: 'This describes conditions as measured, not a projection.' },
  { why: 'the word "will" inside another word', text: 'Willingness to hold risk has fallen, as measured by credit spreads.' },
  { why: 'a past-tense decline', text: 'The dollar index declined 0.8 over the last twenty days.' },
  { why: 'inflation target, not a price target', text: 'Core inflation sits above the 2 percent policy target.' },
  { why: 'naming a factor that abstained', text: 'One factor produced no reading because article volume was too low.' },
  { why: 'describing what a score means', text: 'A score of -27.7 indicates the real yield is a headwind at present.' },
  { why: 'stating the caveat itself', text: 'Scores describe current conditions and carry no measured predictive power.' },

  /**
   * Found live, not by design. The guard rejected the model for correctly disclosing
   * F5's missing rate channel, because "historical consensus forecasts" contains the
   * word "forecasts" as a noun. The guard fired on the exact sentence it exists to
   * protect — the strongest possible argument for a negative corpus.
   */
  { why: 'forecast as a noun naming a data type', text: 'The rate channel is excluded because historical consensus forecasts are not available from free sources.' },
  { why: 'forecast as a noun, second phrasing', text: 'This factor omits the payrolls surprise; consensus forecasts for past releases were never published free of charge.' },
  { why: 'expectations as a subject of measurement', text: 'Policy-rate expectations read -26.4 on the two-year yield and the policy spread.' },
];

describe('predictive corpus — sentences a commentator would write', () => {
  for (const { form, text } of PREDICTIVE) {
    it(`catches ${form}: "${text}"`, () => {
      expect(check(text)).toContain('PREDICTIVE_CLAIM');
    });
  }

  it('covers more than twenty distinct predictive forms', () => {
    // A corpus that shrinks is a corpus that stopped being adversarial.
    expect(PREDICTIVE.length).toBeGreaterThanOrEqual(20);
  });
});

describe('descriptive corpus — prose that must survive', () => {
  for (const { why, text } of DESCRIPTIVE) {
    it(`passes ${why}: "${text}"`, () => {
      const codes = check(text);
      expect(codes).not.toContain('PREDICTIVE_CLAIM');
      expect(codes).not.toContain('TRADING_ADVICE');
    });
  }

  it('covers at least ten descriptive forms', () => {
    expect(DESCRIPTIVE.length).toBeGreaterThanOrEqual(10);
  });
});

describe('the corpus is honest about what it proves', () => {
  it('flags nothing in a clean assessment', () => {
    expect(runGuards(base, CONTEXT)).toEqual([]);
  });

  it('checks headlines and key drivers, not only the summary', () => {
    // A forecast in a headline is more prominent than one buried in a paragraph, and
    // an early version only scanned the summary.
    const inHeadline = runGuards(
      { ...base, headline: 'Gold will likely rally from here on softer yields' },
      CONTEXT,
    );
    expect(inHeadline.map((v) => v.code)).toContain('PREDICTIVE_CLAIM');
    expect(inHeadline.find((v) => v.code === 'PREDICTIVE_CLAIM')?.field).toBe('headline');

    const inDriver = runGuards(
      {
        ...base,
        keyDrivers: [{ factorId: 'F2', statement: 'Real yields should decline further from here.' }],
      },
      CONTEXT,
    );
    expect(inDriver.map((v) => v.code)).toContain('PREDICTIVE_CLAIM');
    expect(inDriver.find((v) => v.code === 'PREDICTIVE_CLAIM')?.field).toBe(
      'keyDrivers[0].statement',
    );
  });
});
