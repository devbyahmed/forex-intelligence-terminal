/**
 * The daily report.
 *
 * An email is the easiest place in this product to break Amendment A3, for three
 * reasons that have nothing to do with the words chosen: nobody scrolls back to a
 * caveat in an email, nobody opens a provenance expander in one, and the subject line
 * is the only part guaranteed to be read.
 *
 * So the report is held to the same standard as the dashboard, and the predictive-claim
 * corpus is run against its own output — the guard exists to catch a model, but nothing
 * says the template author cannot make the same mistake.
 */

import { describe, expect, it } from 'vitest';
import type { AnalysisResponse, FactorView } from '@forex-agent/contracts';
import { findProhibitedClaims } from '@forex-agent/ai';
import { renderReport as renderReportIn, reportDateFor, type RenderedReport } from './render.js';

/**
 * These tests fix the reporting calendar to UTC.
 *
 * The zone is a parameter now rather than a property of the timestamp, so a test that
 * did not state one would be asserting whatever calendar the machine running it
 * happens to use. UTC is chosen here because it makes the fixtures readable; the day
 * boundary itself is exercised against a real zone below and in
 * `packages/core/src/timeZone.test.ts`.
 */
const ZONE = 'UTC';
const renderReport = (analysis: AnalysisResponse): RenderedReport =>
  renderReportIn(analysis, ZONE);

const provenance = {
  factTable: 'macro_observations',
  factId: 'fact-1',
  sourceName: 'Federal Reserve Economic Data',
  sourceTier: 1 as const,
  sourceUrl: null,
  publishedAt: '2026-09-04T20:16:00.000Z',
  retrievedAt: '2026-09-06T09:00:00.000Z',
  freshness: 'LIVE' as const,
  publicationLagDays: null,
};

const scored = (id: string, score: number): FactorView => ({
  kind: 'SCORED',
  factorId: id,
  factorName: `Factor ${id}`,
  weight: 0.125,
  explanation: `Factor ${id} reads ${String(score)}.`,
  freshness: 'LIVE',
  provenance: [provenance],
  score,
  direction: score > 0 ? 'BULLISH' : score < 0 ? 'BEARISH' : 'NEUTRAL',
  zScore: score / 33,
  effectiveWeight: 0.125,
  confidence: 1,
  inputCompleteness: 1,
  limitations: [],
});

const abstained = (id: string): FactorView => ({
  kind: 'ABSTAINED',
  factorId: id,
  factorName: `Factor ${id}`,
  weight: 0.125,
  explanation: `Factor ${id} is not scored.`,
  freshness: 'UNAVAILABLE',
  provenance: [],
  reason: 'BELOW_VOLUME_THRESHOLD',
  detail: '6 articles from 3 sources, below the 10-article minimum',
  attribution: 'WORLD',
});

const base = {
  id: 'analysis-1',
  asset: 'XAUUSD',
  runAt: '2026-09-06T09:15:00.000Z',
  coverage: 0.875,
  factors: [
    scored('F1', -7.1),
    scored('F2', -27.7),
    scored('F3', 6.2),
    scored('F4', -26.4),
    scored('F5', 0),
    scored('F6', 5.9),
    scored('F7', -31.9),
    abstained('F8'),
  ],
  statements: [],
  eventRisk: [],
  unavailableInputs: ['F8: BELOW_VOLUME_THRESHOLD'],
  degradedProviders: [],
};

const analysis = (over: Partial<AnalysisResponse> = {}): AnalysisResponse =>
  ({
    ...base,
    status: 'SCORED',
    score: {
      signed: -14.6,
      display: 43,
      band: 'Bearish',
      bias: 'BEARISH',
      caveat: 'This score describes current measured conditions, not a forecast.',
    },
    confidence: { value: 88, level: 'HIGH', uncappedLevel: 'HIGH', caps: [], components: {} },
    aiAssessment: null,
    ...over,
  }) as AnalysisResponse;

describe('the caveat travels with the score', () => {
  it('puts the caveat immediately after the reading, not in a footer', () => {
    const report = renderReport(analysis());
    const lines = report.text.split('\n');
    const readingLine = lines.findIndex((l) => l.startsWith('Reading:'));
    const caveatLine = lines.findIndex((l) => l.includes('not a forecast'));

    expect(readingLine).toBeGreaterThanOrEqual(0);
    // Directly beneath. An emailed score with the qualification at the bottom is a
    // score presented without one, because nobody scrolls back.
    expect(caveatLine).toBe(readingLine + 1);
  });

  it('carries the caveat in the HTML part too', () => {
    // The two parts of an email are read by different people; a divergence is invisible
    // to whoever wrote it.
    const report = renderReport(analysis());
    expect(report.html).toContain('not a forecast');
  });
});

describe('the report says nothing predictive', () => {
  /*
   * Checked with `findProhibitedClaims` — **the same definition applied to the model's
   * output**, not a re-typed copy.
   *
   * The first version of this suite re-typed the patterns and immediately disagreed
   * with the real guard: it flagged the disclaimer "they are not forecasts" on the noun
   * form of `forecast`, a false positive the real guard was specifically fixed to
   * avoid. Two copies of a rule are two rules.
   *
   * The point stands regardless: template prose never passes through `runGuards`,
   * because it never goes near the model. Nothing but this stops a template author
   * writing "should continue".
   */
  it('avoids every prohibited construction in a scored report', () => {
    const report = renderReport(analysis());
    expect(findProhibitedClaims(report.text)).toEqual([]);
    expect(findProhibitedClaims(report.subject)).toEqual([]);
  });

  it('avoids them in an insufficient report too', () => {
    const report = renderReport(
      analysis({
        status: 'INSUFFICIENT_DATA',
        reason: 'Factor coverage 39% is below the 50% minimum.',
      }),
    );
    expect(findProhibitedClaims(report.text)).toEqual([]);
    expect(findProhibitedClaims(report.subject)).toEqual([]);
  });

  it('avoids them when an AI summary is included', () => {
    // The model's words are already guarded, but they land inside our template and the
    // combined text is what the reader sees.
    const report = renderReport(
      analysis({
        aiAssessment: {
          headline: 'Real yields weigh on gold',
          summary: 'The reading is -14.6 with coverage of 0.875.',
          model: 'gemini-3.5-flash',
          generatedAt: '2026-09-06T09:16:00.000Z',
        },
      }),
    );
    expect(findProhibitedClaims(report.text)).toEqual([]);
  });

  it('would catch a predictive template if one were written', () => {
    // Proof the check is live rather than passing because it looks at nothing.
    expect(findProhibitedClaims('Conditions should continue to weaken further.').length)
      .toBeGreaterThan(0);
  });

  it('closes with the standing disclaimer', () => {
    expect(renderReport(analysis()).text).toContain('not forecasts');
    expect(renderReport(analysis()).text).toContain('not financial advice');
  });
});

describe('the subject line is a measurement, not a call', () => {
  it('states the reading rather than a verdict', () => {
    // The one line guaranteed to be read. "XAUUSD bearish" in an inbox is a call.
    const report = renderReport(analysis());
    expect(report.subject).toContain('conditions read bearish');
    expect(report.subject).toContain('-14.6');
    expect(report.subject).toContain('confidence high');
  });

  it('names the insufficient case explicitly', () => {
    // A run that published nothing must not be indistinguishable in an inbox from one
    // that did.
    const report = renderReport(
      analysis({
        status: 'INSUFFICIENT_DATA',
        reason: 'Factor coverage 39% is below the 50% minimum.',
      }),
    );
    expect(report.subject).toContain('no score published');
    expect(report.subject).toContain('insufficient data');
  });
});

describe('gaps are stated, not appended as small print', () => {
  it('reports what the reading excludes, before the factor detail', () => {
    const report = renderReport(analysis());
    const gapsAt = report.text.indexOf('WHAT THIS READING DOES NOT INCLUDE');
    const factorsAt = report.text.indexOf('FACTORS');

    expect(gapsAt).toBeGreaterThanOrEqual(0);
    expect(gapsAt).toBeLessThan(factorsAt);
  });

  it('renders an abstaining factor as not measured, never as zero', () => {
    // A factor rendered `0.0` in plain text is indistinguishable from one that measured
    // exactly neutral — the confusion abstention exists to prevent.
    const report = renderReport(analysis());
    expect(report.text).toMatch(/F8 Factor F8: not measured/);
    expect(report.text).not.toMatch(/F8 Factor F8: \+?0\.0/);
  });

  it('states the resolution condition for a structural gap', () => {
    const withLimitation = analysis({
      factors: [
        {
          ...(scored('F5', 0) as Extract<FactorView, { kind: 'SCORED' }>),
          inputCompleteness: 0.5,
          limitations: [
            {
              attribution: 'STRUCTURAL',
              missing: 'the rate channel',
              reason: 'historical consensus forecasts are not available from any free source',
              resolution: 'resolves once roughly twelve months of forecasts have accumulated',
            },
          ],
        },
        ...['F1', 'F2', 'F3', 'F4', 'F6', 'F7'].map((id) => scored(id, -10)),
        abstained('F8'),
      ],
    });

    const report = renderReport(withLimitation);
    expect(report.text).toContain('excludes the rate channel');
    expect(report.text).toContain('Resolves: resolves once roughly twelve months');
  });

  it('marks a configuration gap as a defect', () => {
    const withDefect = analysis({
      factors: [
        { ...(abstained('F5') as Extract<FactorView, { kind: 'ABSTAINED' }>), attribution: 'CONFIGURATION', reason: 'INSUFFICIENT_HISTORY', detail: 'not enough history' },
        ...['F1', 'F2', 'F3', 'F4', 'F6', 'F7'].map((id) => scored(id, -10)),
        abstained('F8'),
      ],
    });
    expect(renderReport(withDefect).text).toContain('[DEFECT]');
  });
});

describe('the AI section', () => {
  it('is included when the assessment survived the guards', () => {
    const report = renderReport(
      analysis({
        aiAssessment: {
          headline: 'Real yields weigh on gold',
          summary: 'The reading is -14.6 with coverage of 0.875.',
          model: 'gemini-3.5-flash',
          generatedAt: '2026-09-06T09:16:00.000Z',
        },
      }),
    );
    expect(report.text).toContain('Real yields weigh on gold');
    expect(report.text).toContain('gemini-3.5-flash');
    expect(report.payload.hasAiAssessment).toBe(true);
  });

  it('explains its absence rather than omitting the section', () => {
    // A missing section reads as a rendering fault; a sentence explaining it is the
    // system reporting on itself.
    const report = renderReport(analysis());
    expect(report.text).toContain('AI SUMMARY');
    expect(report.text).toContain('Not included in this report');
    expect(report.text).toContain('The measured layers are unaffected');
    expect(report.payload.hasAiAssessment).toBe(false);
  });
});

describe('rendering is deterministic and self-consistent', () => {
  it('produces identical output for identical input', () => {
    // A stored report must be re-renderable and comparable; anything time-dependent
    // here would make that impossible.
    expect(renderReport(analysis()).text).toBe(renderReport(analysis()).text);
  });

  it('derives HTML from the text, so the two cannot disagree', () => {
    const report = renderReport(analysis());
    // Every line of the text appears in the HTML, escaped.
    expect(report.html).toContain('Reading:');
    expect(report.html).toContain('WHAT THIS READING DOES NOT INCLUDE');
  });

  it('escapes interpolated content', () => {
    const hostile = analysis({
      asset: '<script>alert(1)</script>',
    });
    const report = renderReport(hostile);
    expect(report.html).not.toContain('<script>alert(1)</script>');
    expect(report.html).toContain('&lt;script&gt;');
  });

  it('derives the report date from the run, in the reporting calendar', () => {
    expect(reportDateFor('2026-09-06T09:15:00.000Z', ZONE)).toBe('2026-09-06');
    expect(renderReport(analysis()).payload.reportDate).toBe('2026-09-06');
  });

  it('dates an evening run by the reporting calendar, not by UTC', () => {
    /*
     * 20:15 ET on the 6th is 00:15 UTC on the 7th. Every fact in this system is
     * anchored to US release and market calendars, so a report generated after the New
     * York close describes the 6th — and a UTC boundary would title it the 7th while
     * its contents, and the analysis it was rendered from, are about the day before.
     */
    const runAt = '2026-09-07T00:15:00.000Z';
    expect(reportDateFor(runAt, 'UTC')).toBe('2026-09-07');
    expect(reportDateFor(runAt, 'America/New_York')).toBe('2026-09-06');
  });

  it('titles the report with the same date its payload carries', () => {
    // Two statements of the same day, and the emailed link resolves to the title.
    const report = renderReportIn(analysis({ runAt: '2026-09-07T00:15:00.000Z' }), 'America/New_York');
    expect(report.payload.reportDate).toBe('2026-09-06');
    expect(report.title).toContain(report.payload.reportDate);
  });

  it('carries the analysis id, so the report is traceable to its run', () => {
    expect(renderReport(analysis()).payload.analysisId).toBe('analysis-1');
  });
});
