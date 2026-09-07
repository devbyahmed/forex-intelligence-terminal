/**
 * The score, rendered as an instrument reading.
 *
 * This component is where Amendment A3 is most likely to fail, and it would fail
 * silently — not through a word a guard could catch, but through visual grammar. The
 * forms deliberately not used here, each of which predicts without saying anything:
 *
 * - **A directional arrow.** Points somewhere. A measurement has no direction of travel.
 * - **A red/green gauge.** The visual vocabulary of buy and sell. Traffic lights
 *   instruct; a thermometer describes.
 * - **A hero numeral.** Size reads as certainty, and certainty is measured separately
 *   here — often lower than the score's prominence would imply.
 * - **A needle on a dial.** Implies motion toward one end.
 *
 * What is used instead is a **fixed bidirectional axis with a marker on it**: the way
 * an instrument shows a value. Both ends are always visible and labelled, so the
 * reading is legible as a position within a known range rather than as a verdict. The
 * number sits beside it at body weight.
 *
 * The caveat renders inside this block, immediately under the reading. Not a tooltip —
 * a tooltip is a caveat you have to already suspect. Not a page footer — that is a
 * caveat below the fold. A reader who sees the number sees the qualification in the
 * same glance, or the qualification has not been made.
 */

import type { AnalysisResponse } from '@forex-agent/contracts';
import { buildScoreBlock, coverageSentence } from '@forex-agent/contracts';

export function ScorePanel({ analysis }: { analysis: AnalysisResponse }): React.ReactElement {
  const block = buildScoreBlock(analysis);

  if (block === null) {
    return <InsufficientPanel analysis={analysis} />;
  }

  return (
    <section className="panel score-panel" aria-labelledby="score-heading">
      <header className="panel-head">
        <h2 id="score-heading">Fundamental conditions</h2>
        <span className="asset">{analysis.asset}</span>
      </header>

      {/*
        A fixed −100…+100 axis. Both extremes are always rendered and labelled, so the
        marker reads as a position in a known range. A bar that grew from zero would
        imply magnitude-as-strength, which is a different claim.
      */}
      <div
        className="scale"
        role="img"
        aria-label={`${block.readingLabel}. Reading ${String(block.signed)} on a scale from minus 100 to plus 100.`}
      >
        <span className="scale-end">−100</span>
        <div className="scale-track">
          <span className="scale-centre" aria-hidden="true" />
          <span className="scale-marker" style={{ left: `${String(block.position)}%` }} />
        </div>
        <span className="scale-end">+100</span>
      </div>

      <div className="reading">
        <span className="reading-label">{block.readingLabel}</span>
        <span className="reading-value">
          {block.signed > 0 ? '+' : ''}
          {block.signed.toFixed(1)}
        </span>
      </div>

      {/*
        Immediately beneath the number, in the same block, at readable size. This is
        the requirement, not a nicety: a score presented without it is presented as a
        forecast by omission.
      */}
      <p className="caveat">{block.caveat}</p>

      <p className="coverage">{coverageSentence(analysis)}</p>

      {analysis.status === 'SCORED' ? <ConfidenceRow analysis={analysis} /> : null}
    </section>
  );
}

/**
 * Confidence, kept visually separate from the score.
 *
 * Adjacent but not merged: they are different measurements, and a combined widget
 * would invite reading the pair as one stronger claim. Where a cap applied, the reason
 * is shown — a capped HIGH that renders as MEDIUM with no explanation looks like a low
 * reading rather than a deliberate limit.
 */
function ConfidenceRow({
  analysis,
}: {
  analysis: Extract<AnalysisResponse, { status: 'SCORED' }>;
}): React.ReactElement {
  const { confidence } = analysis;
  const capped = confidence.level !== confidence.uncappedLevel;

  return (
    <div className="confidence">
      <span className="confidence-label">Confidence in this reading</span>
      <span className="confidence-value">
        {confidence.level} ({confidence.value})
      </span>
      {capped ? (
        <ul className="caps">
          {confidence.caps.map((cap) => (
            <li key={cap}>{cap}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The insufficient-data state.
 *
 * Given the same visual prominence as a score, because it is the same kind of
 * statement: the product reporting what it knows. Styling it as an error would tell
 * the user something has gone wrong, when what has happened is that the system
 * declined to guess — the behaviour the product exists to have.
 */
function InsufficientPanel({ analysis }: { analysis: AnalysisResponse }): React.ReactElement {
  const reason = analysis.status === 'INSUFFICIENT_DATA' ? analysis.reason : '';

  return (
    <section className="panel score-panel insufficient" aria-labelledby="score-heading">
      <header className="panel-head">
        <h2 id="score-heading">No score published</h2>
        <span className="asset">{analysis.asset}</span>
      </header>

      <p className="insufficient-reason">{reason}</p>
      <p className="coverage">{coverageSentence(analysis)}</p>
      <p className="caveat">
        This is not an error. Too little of the model produced a reading for a score to
        mean anything, so none is shown.
      </p>
    </section>
  );
}
