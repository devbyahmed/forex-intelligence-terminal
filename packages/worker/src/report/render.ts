/**
 * Rendering the daily report.
 *
 * A pure function from a stored analysis to text and HTML, so the same evidence always
 * produces the same report and a stored copy can be re-rendered and compared.
 *
 * **The email inherits every constraint the dashboard has**, because it reaches the
 * reader in the same way and with less context — nobody scrolls back to a caveat in an
 * email, and nobody opens a provenance expander in one. So:
 *
 * - The A3 caveat travels with the score, in the same block, not in a footer.
 * - Gaps are stated at the same prominence as the reading, not appended as small print.
 *   A seven-factor reading presented as though it were eight is the failure this
 *   product exists to avoid, and an email is the easiest place to commit it.
 * - No AI prose is included unless it survived the guards. The deterministic layers
 *   stand alone when it did not, and the report says so rather than quietly omitting a
 *   section.
 * - Nothing is phrased as a forecast. The same words are forbidden here as in a model
 *   response, and the text is checked against the same corpus in test.
 *
 * Text is generated first and HTML derived from it, so the two cannot disagree about
 * what the report says — a divergence between the plain-text and HTML parts of an email
 * is invisible to whoever wrote it and obvious to whoever reads the wrong one.
 */

import type { AnalysisResponse } from '@forex-agent/contracts';
import { buildGapGroups, coverageSentence, isScoredAnalysis } from '@forex-agent/contracts';
import { civilDateIn } from '@forex-agent/core';

export interface RenderedReport {
  readonly title: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** The structured payload the render came from, stored beside it. */
  readonly payload: ReportPayload;
}

export interface ReportPayload {
  readonly schemaVersion: '1';
  readonly reportDate: string;
  readonly asset: string;
  readonly analysisId: string;
  readonly status: AnalysisResponse['status'];
  readonly signedScore: number | null;
  readonly displayScore: number | null;
  readonly band: string | null;
  readonly confidence: { readonly value: number; readonly level: string } | null;
  readonly coverage: number;
  readonly gapCount: number;
  readonly hasAiAssessment: boolean;
}

/**
 * The civil day the report covers, in the reporting calendar.
 *
 * Not a UTC slice. Every fact in this system is anchored to US release and market
 * calendars, and a UTC boundary would file a run made at 20:00 ET under tomorrow's
 * date while its contents describe today — the emailed link and the report it points
 * at would then disagree about which day they are about.
 *
 * The zone is required rather than defaulted. A default here would be a calendar rule
 * chosen by whichever caller forgot to pass one.
 */
export function reportDateFor(runAt: string, timeZone: string): string {
  return civilDateIn(new Date(runAt), timeZone);
}

export function renderReport(analysis: AnalysisResponse, timeZone: string): RenderedReport {
  const reportDate = reportDateFor(analysis.runAt, timeZone);
  const title = `${analysis.asset} — fundamental conditions, ${reportDate}`;

  const lines: string[] = [];
  lines.push(title, '='.repeat(title.length), '');

  if (isScoredAnalysis(analysis)) {
    lines.push(
      `Reading: ${analysis.score.signed > 0 ? '+' : ''}${analysis.score.signed.toFixed(1)} ` +
        `on the -100 to +100 scale (${analysis.score.band}).`,
    );
    // Immediately beneath the number, never in a footer. An emailed score with the
    // qualification at the bottom is a score presented without one.
    lines.push(analysis.score.caveat);
    lines.push('');
    lines.push(
      `Confidence: ${analysis.confidence.level} (${String(analysis.confidence.value)} of 100).`,
    );
    for (const cap of analysis.confidence.caps) lines.push(`  - ${cap}`);
  } else {
    lines.push('No score is published for this run.');
    lines.push(analysis.reason);
  }

  lines.push('', coverageSentence(analysis), '');

  // ── What the reading excludes ───────────────────────────────────────────
  const gapGroups = buildGapGroups(analysis);
  if (gapGroups.length > 0) {
    lines.push('WHAT THIS READING DOES NOT INCLUDE', '');
    for (const group of gapGroups) {
      lines.push(`${group.heading}${group.isDefect ? '  [DEFECT]' : ''}`);
      lines.push(`  ${group.meaning}`);
      for (const entry of group.entries) {
        lines.push(
          `  - ${entry.factorId} ${entry.factorName}: ${entry.what}. ${entry.why}` +
            (entry.resolution === null ? '' : ` Resolves: ${entry.resolution}`),
        );
      }
      lines.push('');
    }
  }

  // ── Factors ─────────────────────────────────────────────────────────────
  lines.push('FACTORS', '');
  for (const factor of [...analysis.factors].sort((a, b) => a.factorId.localeCompare(b.factorId))) {
    if (factor.kind === 'SCORED') {
      lines.push(
        `  ${factor.factorId} ${factor.factorName}: ` +
          `${factor.score > 0 ? '+' : ''}${factor.score.toFixed(1)} (${factor.freshness})`,
      );
    } else {
      // Never a zero. An abstaining factor rendered as 0.0 in a plain-text email is
      // indistinguishable from a factor that measured exactly neutral.
      lines.push(`  ${factor.factorId} ${factor.factorName}: not measured — ${factor.detail}`);
    }
  }
  lines.push('');

  // ── Event risk ──────────────────────────────────────────────────────────
  if (analysis.eventRisk.length > 0) {
    lines.push('UPCOMING RELEASES', '');
    for (const event of analysis.eventRisk) lines.push(`  - ${event.caution}`);
    lines.push('');
  }

  // ── AI assessment, only if it survived the guards ────────────────────────
  const ai = isScoredAnalysis(analysis) ? analysis.aiAssessment : null;
  if (ai !== null) {
    lines.push('AI SUMMARY', '');
    lines.push(`  ${ai.headline}`, '', `  ${ai.summary}`, '');
    lines.push(
      `  Written by ${ai.model} from the measured evidence above, and checked against it. ` +
        'Every figure it states appears in that evidence.',
    );
  } else {
    // Said rather than omitted: a missing section reads as a rendering fault, while a
    // sentence explaining the absence is the system reporting on itself.
    lines.push('AI SUMMARY', '', '  Not included in this report. The model was unavailable or its');
    lines.push('  response did not pass the checks that every stated figure must appear in');
    lines.push('  the evidence above. The measured layers are unaffected.');
  }

  lines.push('', '---');
  lines.push('Scores describe current measured conditions. They are not forecasts, carry no');
  lines.push('measured predictive power, and are not financial advice.');

  const text = lines.join('\n');

  return {
    title,
    subject: subjectFor(analysis, reportDate),
    text,
    html: toHtml(title, text),
    payload: {
      schemaVersion: '1',
      reportDate,
      asset: analysis.asset,
      analysisId: analysis.id,
      status: analysis.status,
      signedScore: isScoredAnalysis(analysis) ? analysis.score.signed : null,
      displayScore: isScoredAnalysis(analysis) ? analysis.score.display : null,
      band: isScoredAnalysis(analysis) ? analysis.score.band : null,
      confidence: isScoredAnalysis(analysis)
        ? { value: analysis.confidence.value, level: analysis.confidence.level }
        : null,
      coverage: analysis.coverage,
      gapCount: gapGroups.reduce((n, g) => n + g.entries.length, 0),
      hasAiAssessment: ai !== null,
    },
  };
}

/**
 * The subject line.
 *
 * States the reading, not a verdict — a subject is the one line guaranteed to be read,
 * and "XAUUSD bearish" in an inbox is a call rather than a measurement. It also names
 * the insufficient case explicitly, so a run that published nothing is not silently
 * indistinguishable from one that did.
 */
function subjectFor(analysis: AnalysisResponse, reportDate: string): string {
  if (!isScoredAnalysis(analysis)) {
    return `${analysis.asset} ${reportDate}: no score published (insufficient data)`;
  }
  const sign = analysis.score.signed > 0 ? '+' : '';
  return (
    `${analysis.asset} ${reportDate}: conditions read ${analysis.score.band.toLowerCase()} ` +
    `(${sign}${analysis.score.signed.toFixed(1)}), confidence ${analysis.confidence.level.toLowerCase()}`
  );
}

/** Escape for HTML text nodes. Applied to every interpolated value without exception. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML derived from the text, not written separately.
 *
 * Two hand-maintained renderings of one report will eventually disagree, and the
 * disagreement is invisible to whoever wrote them: a mail client shows one part, and
 * the author reads the other. Deriving one from the other makes divergence impossible
 * rather than unlikely.
 *
 * Inline styles because email clients strip `<style>` blocks, and a monospace block
 * because the text layout is the layout.
 */
function toHtml(title: string, text: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '</head>',
    '<body style="margin:0;background:#101215;color:#dfe3e8;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;">',
    '<div style="max-width:680px;margin:0 auto;padding:24px;">',
    `<pre style="white-space:pre-wrap;word-wrap:break-word;margin:0;font:inherit;">${escapeHtml(text)}</pre>`,
    '</div></body></html>',
  ].join('');
}
