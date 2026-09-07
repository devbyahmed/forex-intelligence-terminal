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

  return (
    <>
      <SignedInBar email={session.email} />
      <ScorePanel analysis={analysis} />
      <GapPanel analysis={analysis} />
      <FactorList analysis={analysis} />
      <LayerPanel analysis={analysis} />
      <NewsPanel coverage={news} />
      <CalendarPanel view={calendar} />
      <RefreshButton quote={quote} />
      <SystemStatusPanel status={status} />
      <p className="report-link">
        <a href={`/reports/${analysis.id}`}>Open the stored report for this run</a>
        {' · '}
        <a href="/reports">Report archive</a>
      </p>
    </>
  );
}
