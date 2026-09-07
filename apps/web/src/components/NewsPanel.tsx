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

export function NewsPanel({ coverage }: { coverage: NewsCoverage }): React.ReactElement {
  const short = coverage.relevantCount < coverage.requiredArticles;
  const tooFewSources = coverage.sourceCount < coverage.requiredSources;

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

      {short || tooFewSources ? (
        <div className="news-threshold">
          <p>
            The news factor needs at least {coverage.requiredArticles} relevant articles from{' '}
            {coverage.requiredSources} sources before it produces a score. It has{' '}
            {coverage.relevantCount} from {coverage.sourceCount}, so it is not scoring this run.
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
      ) : (
        <p className="news-threshold">
          Above the {coverage.requiredArticles}-article and {coverage.requiredSources}-source
          minimum, so the news factor is scoring this run.
        </p>
      )}

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
