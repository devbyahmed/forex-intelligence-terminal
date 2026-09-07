/**
 * The three layers, labelled by what kind of claim each carries (Amendment A2).
 *
 * The separation is the point. A reader has to be able to tell, without effort, the
 * difference between:
 *
 * - a **fact** — a value as its source published it, with provenance;
 * - an **interpretation** — what the deterministic engine computed from those facts,
 *   generated from a template and real numbers;
 * - an **AI assessment** — prose a language model wrote, checked against the evidence.
 *
 * Presented as one narrative they would be indistinguishable, and the model's sentence
 * would inherit the authority of the measurement above it. Each layer therefore states
 * what it is beside its heading, and each derived statement can be expanded to show the
 * statements it was built from.
 *
 * The AI layer's absence is explained rather than left blank. A missing section reads
 * as a rendering bug; a section saying the model was unavailable or its response was
 * rejected is the system reporting on itself.
 */

import type { AnalysisResponse, Provenance, StatementView } from '@forex-agent/contracts';
import { buildLayerBlocks } from '@forex-agent/contracts';
import { FreshnessChip } from './FactorList';

export function LayerPanel({ analysis }: { analysis: AnalysisResponse }): React.ReactElement {
  const blocks = buildLayerBlocks(analysis);
  const byId = new Map(analysis.statements.map((s) => [s.id, s]));

  return (
    <section className="panel layer-panel" aria-labelledby="layers-heading">
      <header className="panel-head">
        <h2 id="layers-heading">Evidence and reasoning</h2>
        <span className="hint">Every claim, and what it was derived from</span>
      </header>

      {blocks.map((block) => (
        <div key={block.layer} className={`layer layer-${block.layer.toLowerCase()}`}>
          <h3>
            {block.heading}
            <span className="layer-count">{block.statements.length}</span>
          </h3>
          <p className="layer-meaning">{block.meaning}</p>

          {block.statements.length === 0 ? (
            <p className="layer-empty">
              {block.layer === 'AI_ASSESSMENT'
                ? 'No AI assessment for this run. The measurements above are unaffected.'
                : 'None.'}
            </p>
          ) : (
            <ol className="statements">
              {block.statements.map((statement) => (
                <li key={statement.id}>
                  <p className="statement-body">{statement.body}</p>

                  {statement.provenance === null ? null : (
                    <FreshnessChip provenance={statement.provenance} />
                  )}

                  {statement.derivedFrom.length === 0 ? null : (
                    <LineageExpander parents={statement.derivedFrom} byId={byId} />
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * The lineage expander: which statements this one was built from.
 *
 * Collapsed by default because most readers will not follow it; present on every
 * derived statement because the one who does must be able to, without leaving the
 * page. That is the practical content of "traceable to its evidence" — traceability
 * nobody can exercise is a claim rather than a property.
 */
function LineageExpander({
  parents,
  byId,
}: {
  parents: readonly string[];
  byId: ReadonlyMap<string, StatementView>;
}): React.ReactElement {
  const resolved = parents
    .map((id) => byId.get(id))
    .filter((s): s is StatementView => s !== undefined);

  return (
    <details className="lineage">
      <summary>
        Derived from {resolved.length} {resolved.length === 1 ? 'statement' : 'statements'}
      </summary>
      <ul>
        {resolved.map((parent) => (
          <li key={parent.id}>
            <span className={`layer-tag layer-tag-${parent.layer.toLowerCase()}`}>
              {parent.layer.replace('_', ' ').toLowerCase()}
            </span>
            <span className="lineage-body">{parent.body}</span>
            {parent.provenance === null ? null : <ProvenanceLine provenance={parent.provenance} />}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ProvenanceLine({ provenance }: { provenance: Provenance }): React.ReactElement {
  return (
    <span className="prov-meta">
      {provenance.sourceName} · tier {provenance.sourceTier} · published{' '}
      {provenance.publishedAt.slice(0, 10)}
    </span>
  );
}
