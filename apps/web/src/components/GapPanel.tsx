/**
 * What the system does not know, at the same weight as what it does.
 *
 * This panel is not an error region. A factor that produced no reading is the product
 * telling the truth about the limits of its evidence, which is the main thing it
 * offers over a chart with indicators on it. Tucking it into a corner would turn a
 * seven-factor reading into something that looks like an eight-factor one.
 *
 * Grouped by attribution, because the three kinds mean different things to the person
 * reading them:
 *
 * - **Not measured this run** — information about conditions. Nothing to do.
 * - **Not obtainable on current sources** — a standing constraint of the free-tier
 *   decision, shown with the condition under which it resolves so it reads as a known
 *   limitation with an end date rather than a permanent unknown.
 * - **Configuration defect** — should never appear in production. Rendered
 *   differently and listed first, because it is the only category a reader must act on.
 */

import type { AnalysisResponse } from '@forex-agent/contracts';
import { buildGapGroups, gapWeight } from '@forex-agent/contracts';

export function GapPanel({ analysis }: { analysis: AnalysisResponse }): React.ReactElement | null {
  const groups = buildGapGroups(analysis);
  if (groups.length === 0) return null;

  const missing = gapWeight(analysis);

  return (
    <section className="panel gap-panel" aria-labelledby="gaps-heading">
      <header className="panel-head">
        <h2 id="gaps-heading">What this reading does not include</h2>
        <span className="hint">
          {(missing * 100).toFixed(0)}% of factor weight is unmeasured or partly measured
        </span>
      </header>

      {groups.map((group) => (
        <div
          key={group.attribution}
          className={`gap-group gap-${group.attribution.toLowerCase()}${group.isDefect ? ' gap-defect' : ''}`}
        >
          <h3>
            {group.heading}
            {group.isDefect ? <span className="defect-tag">defect</span> : null}
          </h3>
          <p className="gap-meaning">{group.meaning}</p>

          <ul>
            {group.entries.map((entry) => (
              <li key={`${entry.factorId}-${entry.what}`}>
                <span className="gap-factor">
                  {entry.factorId} {entry.factorName}
                </span>
                <span className={`gap-extent gap-extent-${entry.extent.toLowerCase()}`}>
                  {entry.extent === 'DARK' ? 'no reading' : 'partly measured'}
                </span>
                <span className="gap-weight">weight {entry.weight.toFixed(2)}</span>
                <p className="gap-why">
                  {entry.what === 'produced no reading' ? '' : `${entry.what} — `}
                  {entry.why}
                </p>
                {/*
                  The resolution condition. A limitation with an end date reads as a
                  known constraint; the same limitation without one reads as a
                  permanent unknown, and readers discount a product accordingly.
                */}
                {entry.resolution === null ? null : (
                  <p className="gap-resolution">Resolves: {entry.resolution}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
