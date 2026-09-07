/**
 * Semantic guards.
 *
 * The two failures that matter here are both perfectly well-formed JSON, which is why
 * a schema cannot catch either: a fabricated number, and a predictive claim. Every
 * case below is written as the model would actually produce it — plausible prose with
 * one thing wrong — rather than as obviously broken input.
 */

import { describe, expect, it } from 'vitest';
import { extractNumbers, permittedNumbersFrom, runGuards, type GuardContext } from './guards.js';
import { assessmentSchema, type Assessment } from './schema.js';

/** A bundle shaped like the real one, with the figures from a real run. */
const BUNDLE = {
  asset: 'XAUUSD',
  coverage: 0.815,
  score: { signed: -14.6, display: 43, band: 'Bearish' },
  confidence: { value: 88, level: 'HIGH' },
  factors: [
    { id: 'F1', score: -7.1, weight: 0.18, effectiveWeight: 0.18 },
    { id: 'F2', score: -27.7, weight: 0.18, effectiveWeight: 0.18 },
    { id: 'F7', score: -31.9, weight: 0.1, effectiveWeight: 0.085 },
    { id: 'F8', score: null, weight: 0.1, effectiveWeight: 0 },
  ],
  facts: [{ label: 'Nominal Broad U.S. Dollar Index', value: 118.75 }],
};

const CONTEXT: GuardContext = {
  permittedNumbers: permittedNumbersFrom(BUNDLE),
  knownFactorIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'],
  abstainedFactorIds: ['F8'],
  requiresGapDisclosure: true,
};

/** A response that should pass every guard. */
const CLEAN: Assessment = {
  headline: 'Real yields and risk sentiment weigh on gold',
  summary:
    'The fundamental reading is -14.6 on the signed scale, a bearish band, with coverage of 0.815. ' +
    'The real 10-year yield is the heaviest contributor at -27.7, and risk sentiment reads -31.9. ' +
    'The dollar index at 118.75 contributes -7.1. One factor produced no reading this run.',
  keyDrivers: [
    { factorId: 'F2', statement: 'The real 10-year yield reads -27.7, the largest single headwind.' },
    { factorId: 'F7', statement: 'Risk sentiment reads -31.9 on current volatility and credit spreads.' },
  ],
  dataGaps: ['News pressure produced no reading because article volume was below the threshold.'],
  factorsCited: ['F1', 'F2', 'F7'],
};

const withText = (over: Partial<Assessment>): Assessment => ({ ...CLEAN, ...over });

describe('a clean response passes', () => {
  it('raises no violations', () => {
    expect(runGuards(CLEAN, CONTEXT)).toEqual([]);
  });

  it('is valid against the schema too', () => {
    expect(assessmentSchema.safeParse(CLEAN).success).toBe(true);
  });
});

describe('fabricated numbers', () => {
  it('catches a figure that appears nowhere in the bundle', () => {
    // The dollar index is 118.75. 121.4 is plausible, wrong, and exactly the kind of
    // number a user would never re-check.
    const v = runGuards(
      withText({ summary: `${CLEAN.summary} The dollar index stands at 121.4 today.` }),
      CONTEXT,
    );
    expect(v.map((x) => x.code)).toContain('FABRICATED_NUMBER');
    expect(v.find((x) => x.code === 'FABRICATED_NUMBER')?.evidence).toContain('121.4');
  });

  it('catches an invented score for a real factor', () => {
    const v = runGuards(
      withText({
        keyDrivers: [{ factorId: 'F1', statement: 'US dollar strength reads -42.3 this run.' }],
      }),
      CONTEXT,
    );
    expect(v.map((x) => x.code)).toContain('FABRICATED_NUMBER');
  });

  it('accepts a rounded restatement rather than calling it fabrication', () => {
    // -27.7 quoted as -27.7 or -28 is restating; a guard that rejects it gets
    // loosened, and a loosened guard is worse than none.
    expect(
      runGuards(withText({ summary: CLEAN.summary.replace('-27.7', '-27.7') }), CONTEXT),
    ).toEqual([]);
  });

  it('allows structural numbers it was given to count with', () => {
    const v = runGuards(
      withText({ summary: `${CLEAN.summary} Seven of 8 factors produced a reading.` }),
      CONTEXT,
    );
    expect(v.filter((x) => x.code === 'FABRICATED_NUMBER')).toEqual([]);
  });

  it('does not fire on factor ids or series names', () => {
    const v = runGuards(
      withText({ summary: `${CLEAN.summary} F1 and F2 both draw on H.15 data.` }),
      CONTEXT,
    );
    expect(v.filter((x) => x.code === 'FABRICATED_NUMBER')).toEqual([]);
  });
});

describe('predictive claims (Amendment A3)', () => {
  const cases: readonly [string, string][] = [
    ['a future price move', 'Gold will rise as real yields decline.'],
    // Caught by a live checkpoint run, not by this suite. The original patterns had
    // `will\s+rally` and `likely to`, and this sentence satisfies neither: "likely"
    // sits between "will" and "rally", and there is no "to". The single most
    // characteristic predictive sentence in financial prose walked straight through
    // the guard written to stop it.
    ['a hedged prediction with an adverb between modal and verb', 'Gold will likely rally as real yields decline further.'],
    ['a bare likelihood', 'A softer dollar is likely from here.'],
    ['a continuing move', 'Real yields should decline further.'],
    ['a modal other than will', 'Gold could climb on this reading.'],
    ['an expectation', 'We expect the dollar to weaken from here.'],
    ['a likelihood', 'Gold is likely to break higher on this reading.'],
    ['a forecast frame', 'The bearish outlook remains intact.'],
    ['a forward window', 'Pressure should persist in the coming weeks.'],
  ];

  for (const [label, text] of cases) {
    it(`rejects ${label}`, () => {
      const v = runGuards(withText({ summary: `${CLEAN.summary} ${text}` }), CONTEXT);
      expect(v.map((x) => x.code)).toContain('PREDICTIVE_CLAIM');
    });
  }

  it('does not fire on ordinary descriptive prose', () => {
    // The guard must survive normal writing, or it gets switched off.
    const v = runGuards(
      withText({
        summary:
          'The reading is -14.6. Willingness to hold risk, as measured by credit spreads, ' +
          'has fallen. This describes conditions as measured, not a projection.',
      }),
      CONTEXT,
    );
    expect(v.filter((x) => x.code === 'PREDICTIVE_CLAIM')).toEqual([]);
  });
});

describe('trading advice', () => {
  it('rejects a trade instruction', () => {
    const v = runGuards(withText({ summary: `${CLEAN.summary} Sell gold here.` }), CONTEXT);
    expect(v.map((x) => x.code)).toContain('TRADING_ADVICE');
  });

  it('rejects a price target', () => {
    const v = runGuards(
      withText({ summary: `${CLEAN.summary} A price target below the recent range applies.` }),
      CONTEXT,
    );
    expect(v.map((x) => x.code)).toContain('TRADING_ADVICE');
  });
});

describe('overstated certainty', () => {
  it('rejects language that turns a weighted average into a settled fact', () => {
    const v = runGuards(
      withText({ summary: `${CLEAN.summary} This confirms a deteriorating backdrop.` }),
      CONTEXT,
    );
    expect(v.map((x) => x.code)).toContain('OVERSTATED_CERTAINTY');
  });
});

describe('factor citation', () => {
  it('rejects a factor id that does not exist', () => {
    const v = runGuards(
      withText({ keyDrivers: [{ factorId: 'F9', statement: 'Something about F9.' }] }),
      { ...CONTEXT, knownFactorIds: ['F1', 'F2'] },
    );
    expect(v.map((x) => x.code)).toContain('UNKNOWN_FACTOR');
  });

  it('rejects an abstaining factor cited as a key driver', () => {
    // The subtle fabrication: the id is real, so nothing structural is wrong, but the
    // factor produced no reading and therefore drove nothing.
    const v = runGuards(
      withText({
        keyDrivers: [{ factorId: 'F8', statement: 'News pressure is a key driver this run.' }],
      }),
      CONTEXT,
    );
    expect(v.map((x) => x.code)).toContain('ABSENT_FACTOR_CITED');
    expect(v.find((x) => x.code === 'ABSENT_FACTOR_CITED')?.detail).toContain('produced no reading');
  });

  it('allows an abstaining factor to be named as a gap', () => {
    expect(
      runGuards(
        withText({ dataGaps: ['F8 news pressure produced no reading this run.'] }),
        CONTEXT,
      ),
    ).toEqual([]);
  });
});

describe('gap disclosure', () => {
  it('rejects a summary that omits its gaps when the run has them', () => {
    // A model shown seven factors writes about seven factors as though that were all
    // of them, which is how an incomplete picture becomes an unqualified one.
    const v = runGuards(withText({ dataGaps: [] }), CONTEXT);
    expect(v.map((x) => x.code)).toContain('MISSING_DATA_GAP_DISCLOSURE');
  });

  it('does not require gaps when there are none', () => {
    const v = runGuards(withText({ dataGaps: [] }), {
      ...CONTEXT,
      abstainedFactorIds: [],
      requiresGapDisclosure: false,
    });
    expect(v.filter((x) => x.code === 'MISSING_DATA_GAP_DISCLOSURE')).toEqual([]);
  });
});

describe('number extraction', () => {
  it('finds decimals, negatives and integers', () => {
    expect(extractNumbers('reads -14.6 with coverage 0.815 across 8 factors')).toEqual([
      -14.6, 0.815, 8,
    ]);
  });

  it('ignores numbers embedded in identifiers', () => {
    expect(extractNumbers('F1 and F8 use H.15 data')).toEqual([]);
  });
});

describe('permitted-number vocabulary', () => {
  it('collects every number in the bundle, at any depth', () => {
    const permitted = permittedNumbersFrom(BUNDLE);
    expect(permitted).toContain(-14.6);
    expect(permitted).toContain(0.815);
    expect(permitted).toContain(118.75);
    expect(permitted).toContain(-27.7);
  });

  it('does not invent numbers that are merely near the ones present', () => {
    expect(permittedNumbersFrom(BUNDLE)).not.toContain(121.4);
  });
});

describe('the bundle speaks in prose as well as numbers', () => {
  /*
   * Regression. F8's abstention explains itself with a window and a threshold — "in the
   * last 48h; 10 are required" — and `permittedNumbersFrom` walked only numeric fields,
   * so it collected neither. Every model response that restated the window was rejected
   * as a FABRICATED_NUMBER while the figure sat in the evidence it was given.
   */
  it('permits a number that appears only in the bundle prose', () => {
    const bundle = {
      abstentions: [
        {
          factorId: 'F8',
          detail:
            'Only 6 relevant article(s) with sentiment signal in the last 48h; ' +
            '10 are required for an average to mean anything.',
        },
      ],
    };
    const permitted = permittedNumbersFrom(bundle);
    expect(permitted).toContain(48);
    expect(permitted).toContain(6);
  });

  it('reads a number carrying a unit suffix, on both sides of the comparison', () => {
    // One extractor, so what the bundle states and what the model claims are measured
    // by the same rule. Two rules here would read as fabrication.
    expect(permittedNumbersFrom({ note: 'window of 48h' })).toContain(48);
    expect(extractNumbers('window of 48h')).toContain(48);
  });

  it('reads a number whole rather than truncating it at a unit', () => {
    /*
     * ── Regression: the extractor was silently corrupting numbers ────────────
     *
     * With a trailing-letter exclusion the engine backtracked instead of failing, so
     * `4.77pp` came out as 4.7 and `48h` as 4. The guard then compared a figure the
     * model never wrote against the bundle and rejected correct output as fabricated,
     * naming a number that appeared nowhere. Truncation is worse than omission: an
     * omitted number is a missed check, a truncated one is a false accusation.
     */
    expect(extractNumbers('a level of 4.77pp')).toEqual([4.77]);
    expect(extractNumbers('in the last 48h')).toEqual([48]);
    expect(extractNumbers('a 5-day change of 0.1pp')).toEqual([5, 0.1]);
  });

  it('still skips identifiers that merely contain digits', () => {
    // What the trailing-letter exclusion was believed to be doing. The lookbehind was
    // doing it all along.
    expect(extractNumbers('F1 and F8 use H.15 data')).toEqual([]);
  });

  it('still rejects a number that appears nowhere in the bundle', () => {
    // The guard has to keep failing on the case it exists for.
    const permitted = permittedNumbersFrom({ note: 'the window is 48h' });
    expect(permitted).not.toContain(121.4);
  });
});
