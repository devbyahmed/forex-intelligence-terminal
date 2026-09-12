/**
 * News coverage.
 *
 * **This panel exists to make F8's darkness legible.** The news factor produces no
 * reading today: twelve feeds yield roughly three gold-relevant articles a day, so a
 * 48-hour window holds about six against a floor of ten (PRD_V1 §8.3a). A blank panel
 * saying "no data" would be the wrong rendering of that, and wrong in a specific way —
 * it looks broken, and a user who thinks a panel is broken concludes the *system* is
 * unreliable rather than that the *evidence* is thin.
 *
 * The distinction the panel has to carry is between:
 *
 *  - **"nothing was published"** — which would be information about the world, and
 *  - **"things were published, and there were not enough of them to average"** —
 *    which is what actually happened, and is a statement about measurement.
 *
 * So the articles are shown, counted, and set against the threshold, with the reason
 * the threshold exists. Six articles is not zero, and the panel says six.
 *
 * The threshold is a product-visible fact, not a config note: it is rendered with its
 * justification, because a floor a user cannot see is a floor they will assume was
 * chosen to make the number look good.
 */

import type { NewsCoverage } from '@forex-agent/contracts';

/*
 * ── This panel does not decide whether F8 scores ─────────────────────────────
 *
 * It used to. It compared `relevantCount` against the scoring thresholds and printed
 * "so the news factor is scoring this run" — and on a live run it said exactly that
 * while F8, on the same screen, reported no reading at all.
 *
 * Both numbers were right; they count different things. Relevance is "is this article
 * about gold" (10 here). Scoring needs an article that also carries a lexicon term and
 * comes from a source at or above the scoring tier (3 here), because the score is a mean
 * of per-article polarity and an article with no sentiment term contributes nothing to a
 * mean. Applying one rule's thresholds to the other rule's population produced a
 * confident, wrong claim.
 *
 * So the verdict now has exactly one author — the factor — and this panel reports what
 * was collected and what the floor is. The two counts are both shown, with the reason
 * they differ, because a reader who sees "10" here and "3" on F8 deserves better than
 * to be left reconciling them.
 */
export function NewsPanel({ coverage }: { coverage: NewsCoverage }): React.ReactElement {
  return (
    <section className="panel news-panel" aria-labelledby="news-heading">
      <header className="panel-head">
        <h2 id="news-heading">News coverage</h2>
        <span className="hint">
          {coverage.windowHours}-hour window · {coverage.feedCount} active feeds
        </span>
      </header>

      {/*
        The measurement, stated first and as a count. "6 of the 10 needed" is a fact
        about coverage; an empty region would be an absence of one.
      */}
      <p className="news-measure">
        <strong>{coverage.relevantCount}</strong> gold-relevant{' '}
        {coverage.relevantCount === 1 ? 'article' : 'articles'} from{' '}
        <strong>{coverage.sourceCount}</strong>{' '}
        {coverage.sourceCount === 1 ? 'source' : 'sources'}, out of {coverage.totalCount} collected.
      </p>

      {/*
        Always rendered, whatever the counts. The floor and its justification are facts
        about how this product measures, not an explanation that is only owed on the days
        the factor happens to be dark.
      */}
      <div className="news-threshold">
        <p>
          The news factor needs at least {coverage.requiredArticles} relevant articles, from{' '}
          {coverage.requiredSources} sources, before it produces a score — and it counts only
          those carrying a sentiment term, which is a smaller set than the relevance count
          above. Whether this run cleared that floor is stated by the F8 factor itself, with
          the count it actually used.
        </p>
        {/*
          Why the floor is where it is. Without this it reads as an arbitrary number
          that happens to block the factor.
        */}
        <p className="news-why">
          The score would be a mean of per-article sentiment, and the error of a mean
          falls as one over the square root of the count. Below ten, the figure moves
          more with which headlines happened to land than with anything about the
          market — so a number here would be noise presented as a measurement.
        </p>
      </div>

      {coverage.articles.length === 0 ? (
        <p className="news-empty">
          No articles were collected in this window. The feeds were reachable
          {coverage.feedFailures === 0
            ? ' and returned nothing'
            : `, though ${String(coverage.feedFailures)} failed`}
          .
        </p>
      ) : (
        <ol className="news-list">
          {coverage.articles.map((article) => (
            <li key={article.id}>
              <span className={`chip chip-tier-${String(article.sourceTier)}`}>
                Tier {article.sourceTier}
              </span>
              <span className="news-source">{article.sourceName}</span>
              <span className="news-when">{article.publishedAt.slice(0, 16).replace('T', ' ')}</span>
              <p className="news-title">{article.title}</p>
              {article.goldRelevant ? (
                <span className="news-relevant">counted toward the factor</span>
              ) : (
                <span className="news-irrelevant">collected, not gold-relevant</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
