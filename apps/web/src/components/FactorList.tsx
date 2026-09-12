/**
 * The factor breakdown.
 *
 * Three rules, all of which change what the reader concludes:
 *
 * **One list, not two.** Scored and abstained factors render together, in factor
 * order. Splitting them into "factors" and "unavailable" would let a reader take the
 * first list as the model and miss that an eighth of it is dark.
 *
 * **Freshness and lag sit at the number.** A `RECENT` chip on a dollar index published
 * nine days ago is technically true and practically misleading — a reader takes
 * "recent" to mean recent, not "recent for a series that publishes weekly in arrears".
 * Where the lag is material it is written beside the chip, never behind a hover.
 *
 * **A partial factor says which part is missing.** "Inflation: neutral" reads as
 * "inflation is not pushing either way". The truth may be that the hedge channel is
 * neutral and the opposing rate channel was never measured. A completeness percentage
 * cannot carry that; a sentence can.
 */

import type { FactorView, Provenance } from '@forex-agent/contracts';
import { buildFreshnessBadge, orderedFactors, type AnalysisResponse } from '@forex-agent/contracts';

export function FactorList({ analysis }: { analysis: AnalysisResponse }): React.ReactElement {
  return (
    <section className="panel" aria-labelledby="factors-heading">
      <header className="panel-head">
        <h2 id="factors-heading">Factors</h2>
        <span className="hint">Contribution to the reading, and what each is measured from</span>
      </header>

      <ol className="factor-list">
        {orderedFactors(analysis).map((factor) => (
          <li key={factor.factorId} className={`factor factor-${factor.kind.toLowerCase()}`}>
            <FactorRow factor={factor} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function FactorRow({ factor }: { factor: FactorView }): React.ReactElement {
  return (
    <>
      <div className="factor-head">
        <span className="factor-id">{factor.factorId}</span>
        <span className="factor-name">{factor.factorName}</span>
        <span className="factor-weight">weight {factor.weight.toFixed(2)}</span>
      </div>

      {factor.kind === 'SCORED' ? (
        <ScoredBody factor={factor} />
      ) : (
        <AbstainedBody factor={factor} />
      )}

      {/*
        Derivation detail, one interaction away — and only this.

        What stays visible is everything that qualifies the number: the score, the
        freshness chip, the lag note, and the "Partly measured" caveat. Those are
        governed by their own rules and are never collapsed.

        The explanation is the *method* — which series, what standardisation, which
        window. It also repeats the limitation sentence verbatim, because the same
        string feeds the evidence bundle the model reads and the stored INTERPRETATION
        statement, where it genuinely is load-bearing. Rendered inline it produced the
        same caveat twice in the same card, which reads as a stutter rather than as
        emphasis.
      */}
      <details className="factor-explain">
        <summary>How this was measured</summary>
        <p className="factor-explanation">{factor.explanation}</p>
      </details>

      {factor.provenance.length > 0 ? <ProvenanceExpander provenance={factor.provenance} /> : null}
    </>
  );
}

function ScoredBody({
  factor,
}: {
  factor: Extract<FactorView, { kind: 'SCORED' }>;
}): React.ReactElement {
  return (
    <div className="factor-body">
      {/*
        A contribution bar from a centre line — both directions always visible, so the
        bar reads as a position rather than as a quantity that could grow further.
      */}
      <div className="contribution" role="img" aria-label={`Reads ${String(factor.score)}`}>
        <span className="contribution-centre" aria-hidden="true" />
        <span
          className={`contribution-bar ${factor.score < 0 ? 'negative' : 'positive'}`}
          style={{
            width: `${String(Math.min(50, Math.abs(factor.score) / 2))}%`,
            [factor.score < 0 ? 'right' : 'left']: '50%',
          }}
        />
      </div>

      <span className="factor-score">
        {factor.score > 0 ? '+' : ''}
        {factor.score.toFixed(1)}
      </span>

      {factor.provenance.map((p) => (
        <FreshnessChip key={p.factId} provenance={p} />
      ))}

      {/*
        Which half of the factor is being read. Rendered inline with the score, not in
        an expander, because the caveat qualifies the number itself.
      */}
      {factor.limitations.map((limitation) => (
        <p key={limitation.missing} className={`limitation limitation-${limitation.attribution.toLowerCase()}`}>
          <span className="limitation-tag">Partly measured</span> This reading excludes{' '}
          {limitation.missing}, because {limitation.reason}
          {limitation.resolution === null ? '.' : `; it ${limitation.resolution}.`}
        </p>
      ))}
    </div>
  );
}

function AbstainedBody({
  factor,
}: {
  factor: Extract<FactorView, { kind: 'ABSTAINED' }>;
}): React.ReactElement {
  return (
    <div className="factor-body abstained">
      {/*
        No bar, and deliberately no zero-width one: a bar of length zero at the centre
        line is visually identical to a factor that measured exactly neutral, which is
        the precise confusion abstention exists to prevent.
      */}
      <span className="no-reading">No reading</span>
      <span className={`attribution attribution-${factor.attribution.toLowerCase()}`}>
        {ATTRIBUTION_LABEL[factor.attribution]}
      </span>
      <p className="abstain-detail">{factor.detail}</p>
    </div>
  );
}

const ATTRIBUTION_LABEL: Readonly<Record<string, string>> = {
  WORLD: 'Not measured this run',
  // Says what is missing, not that the sources are doubtful. See GROUP_META.STRUCTURAL
  // in contracts/presentation.ts for why this distinction is load-bearing.
  STRUCTURAL: 'No free provider publishes this',
  CONFIGURATION: 'Configuration defect',
};

/**
 * The freshness chip, with its lag note attached.
 *
 * The two render together or not at all. Separating them is how "RECENT" ends up
 * describing a nine-day-old figure with the qualification one interaction away.
 */
export function FreshnessChip({ provenance }: { provenance: Provenance }): React.ReactElement {
  const badge = buildFreshnessBadge(provenance);

  return (
    <span className="freshness">
      <span className={`chip chip-${badge.status.toLowerCase()}`}>{badge.label}</span>
      <span className="chip-source">
        {badge.sourceName} · tier {badge.sourceTier}
      </span>
      {badge.lagNote === null ? null : <span className="lag-note">{badge.lagNote}</span>}
    </span>
  );
}

/**
 * Provenance, one interaction away — but only ever for *detail*, never for the fact
 * that a value has a source at all. The chip above already names it.
 */
function ProvenanceExpander({
  provenance,
}: {
  provenance: readonly Provenance[];
}): React.ReactElement {
  return (
    <details className="provenance">
      <summary>
        Evidence ({provenance.length} {provenance.length === 1 ? 'fact' : 'facts'})
      </summary>
      <ul>
        {provenance.map((p) => (
          <li key={p.factId}>
            <span className="prov-source">{p.sourceName}</span>
            <span className="prov-meta">
              tier {p.sourceTier} · published {p.publishedAt.slice(0, 10)} · retrieved{' '}
              {p.retrievedAt.slice(0, 10)} · {p.freshness}
            </span>
            {p.publicationLagDays !== null && p.publicationLagDays >= 3 ? (
              <span className="lag-note">
                published {p.publicationLagDays} days after the period it describes
              </span>
            ) : null}
            {p.sourceUrl === null ? null : (
              <a href={p.sourceUrl} rel="noreferrer noopener" target="_blank">
                source
              </a>
            )}
            <span className="prov-id">
              {p.factTable}#{p.factId.slice(0, 8)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
