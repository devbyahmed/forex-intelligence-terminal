/**
 * A stored report.
 *
 * The point of this page is **reproducibility** (master §35): re-opening a run from
 * three months ago must render what was true then, not what the pipeline would produce
 * today. It reads the stored analysis by id — the same rows, the same evidence bundle,
 * the same statement lineage — so nothing about it depends on current data.
 *
 * That is also why the report and the dashboard share their components rather than
 * having a "report view" of their own. Two renderers for the same evidence is two
 * chances for them to disagree about what the run said, and the one people would trust
 * is whichever they happened to open.
 */

import { notFound, redirect } from 'next/navigation';
import { ScorePanel } from '../../../components/ScorePanel';
import { GapPanel } from '../../../components/GapPanel';
import { FactorList } from '../../../components/FactorList';
import { LayerPanel } from '../../../components/LayerPanel';
import { loadAnalysisById } from '../../../lib/loadAnalysis';
import { currentSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await currentSession();
  if (session === null) redirect('/login');

  const { id } = await params;
  const analysis = await loadAnalysisById(id);
  if (analysis === null) notFound();

  return (
    <>
      <div className="report-head">
        <span className="report-tag">Stored report</span>
        <span className="report-when">
          Run at {analysis.runAt.replace('T', ' ').slice(0, 16)} UTC
        </span>
        <a href="/">Back to the dashboard</a>
      </div>

      {/*
        A note, not a disclaimer. A reader arriving at a three-month-old report needs to
        know they are looking at a snapshot before they read the number, not after.
      */}
      <p className="report-note">
        This is the run exactly as it was recorded. Values, freshness and evidence are
        those of the run — not current readings.
      </p>

      <ScorePanel analysis={analysis} />
      <GapPanel analysis={analysis} />
      <FactorList analysis={analysis} />
      <LayerPanel analysis={analysis} />
    </>
  );
}
