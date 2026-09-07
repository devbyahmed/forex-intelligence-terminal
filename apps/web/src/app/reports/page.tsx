/**
 * The report archive.
 *
 * A list of what was sent, not a list of what could be regenerated. Each entry links to
 * the immutable stored copy, so opening a report from three months ago shows what was
 * said then — which is the whole point of storing them (master §35).
 *
 * Rows show the reading **and** whether a report published no score. A list that showed
 * only scores would make an insufficient day look like a missing day, and this product's
 * central claim is that those are different.
 */

import { redirect } from 'next/navigation';
import { loadReportArchive } from '../../lib/loadReports';
import { currentSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

export default async function ReportArchivePage() {
  const session = await currentSession();
  if (session === null) redirect('/login');

  const entries = await loadReportArchive(60);

  return (
    <>
      <div className="report-head">
        <span className="report-tag">Archive</span>
        <a href="/">Back to the dashboard</a>
      </div>

      <section className="panel" aria-labelledby="archive-heading">
        <header className="panel-head">
          <h2 id="archive-heading">Stored reports</h2>
          <span className="hint">{entries.length} kept</span>
        </header>

        {entries.length === 0 ? (
          <p className="news-empty">
            No reports have been generated yet. The daily report job stores one per trading
            day; this list fills as it runs.
          </p>
        ) : (
          <table className="calendar-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Reading</th>
                <th scope="col">Confidence</th>
                <th scope="col">Coverage</th>
                <th scope="col">Generated</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <a href={`/reports/${entry.id}`}>{entry.reportDate}</a>
                  </td>
                  <td>
                    {/*
                      An insufficient day says so, rather than rendering an empty cell.
                      A blank here would be indistinguishable from a missing report.
                    */}
                    {entry.signedScore === null ? (
                      <span className="no-reading">no score published</span>
                    ) : (
                      <>
                        {entry.signedScore > 0 ? '+' : ''}
                        {entry.signedScore.toFixed(1)} {entry.band ?? ''}
                      </>
                    )}
                  </td>
                  <td>{entry.confidenceLevel ?? '—'}</td>
                  <td className="num">{Math.round(entry.coverage * 100)}%</td>
                  <td>{entry.generatedAt.slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
