/**
 * The dashboard.
 *
 * A server component: the evidence bundle, provider keys and raw provenance never
 * reach the client, and the page renders from a validated `AnalysisResponse` rather
 * than from database rows (ARCHITECTURE §4.1, P7).
 *
 * Panel order is a product decision. The score comes first because it is what the
 * reader came for; the gaps come **second, above the factor detail**, because what the
 * reading excludes qualifies it and a qualification below the detail is a
 * qualification most readers never reach.
 */

import { redirect } from 'next/navigation';
import { ScorePanel } from '../components/ScorePanel';
import { GapPanel } from '../components/GapPanel';
import { FactorList } from '../components/FactorList';
import { LayerPanel } from '../components/LayerPanel';
import { SignedInBar } from '../components/SignedInBar';
import { loadLatestAnalysis } from '../lib/loadAnalysis';
import {
  loadCalendar,
  loadNewsCoverage,
  loadRefreshQuote,
  loadSystemStatus,
} from '../lib/loadPanels';
import { NewsPanel } from '../components/NewsPanel';
import { CalendarPanel } from '../components/CalendarPanel';
import { SystemStatusPanel } from '../components/SystemStatusPanel';
import { RefreshButton } from '../components/RefreshButton';
import { currentSession } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await currentSession();
  // Redirect rather than render an empty shell: a dashboard that renders without data
  // because you are signed out looks like a data outage.
  if (session === null) redirect('/login');

  const now = new Date();
  // Loaded in parallel: four independent reads, and serialising them would add a
  // round trip each against a database that scales to zero and reconnects cold.
  const [analysis, news, calendar, status, quote] = await Promise.all([
    loadLatestAnalysis('XAUUSD'),
    loadNewsCoverage(now),
    loadCalendar(now),
    loadSystemStatus(now),
    loadRefreshQuote(),
  ]);

  if (analysis === null) {
    return (
      <>
        <SignedInBar email={session.email} />
        <section className="panel">
          <h2>No analysis yet</h2>
          <p className="coverage">
            No run has been stored for XAUUSD. Ingest data and run the analysis job, then reload.
          </p>
        </section>
      </>
    );
  }

  /*
   * Two columns, split by the question each answers.
   *
   * The left column is the reading and what it is made of; the right is what the system
   * itself is doing. Stacked in one column — as this was — the page ran to over ten
   * thousand pixels, and the panels a reader consults occasionally sat between them and
   * the panels they came for.
   *
   * The order *within* the left column is unchanged and still load-bearing: the gaps
   * come above the factor detail, because what a reading excludes qualifies it, and a
   * qualification placed below the detail is one most readers never reach.
   */
  return (
    <>
      <div className="col-full">
        <SignedInBar email={session.email} />
      </div>

      <div className="col col-primary">
        <ScorePanel analysis={analysis} />
        <GapPanel analysis={analysis} />
        <FactorList analysis={analysis} />
        <LayerPanel analysis={analysis} />
      </div>

      <div className="col col-secondary">
        <NewsPanel coverage={news} />
        <CalendarPanel view={calendar} />
        <RefreshButton quote={quote} />
        <SystemStatusPanel status={status} />
      </div>

      {/*
        Two links, two classes. `.report-link a` matched both, so a test clicking "the
        report link" was ambiguous and Playwright refused it outright — correctly, since
        "this run's report" and "the archive" are different destinations.
      */}
      <p className="report-link col-full">
        <a className="report-run-link" href={`/reports/${analysis.id}`}>
          Open the stored report for this run
        </a>
        {' · '}
        <a className="report-archive-link" href="/reports">
          Report archive
        </a>
      </p>
    </>
  );
}
