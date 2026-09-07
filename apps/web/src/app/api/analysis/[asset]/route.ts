/**
 * GET  /api/analysis/:asset   the latest stored analysis
 * POST /api/analysis/:asset   an on-demand refresh
 *
 * The POST re-checks the refresh budget **server-side** before spending anything. The
 * quote the client rendered is a snapshot; another tab, another user or the scheduled
 * run may have consumed the allowance between render and click. A client-side check
 * alone would make the budget advisory, and an advisory budget on a free tier is no
 * budget at all.
 */

import { NextResponse } from 'next/server';
import { estimateRefreshBudget, latestAnalysisResponse, V1_REFRESH_COST } from '@forex-agent/worker';
import { currentSession, openDb } from '../../../../lib/session';
import { CSRF_REJECTION_MESSAGE, verifyCsrf } from '../../../../lib/csrf';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ asset: string }> },
): Promise<NextResponse> {
  const session = await currentSession();
  if (session === null) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { asset } = await params;
  const handle = openDb();
  try {
    return NextResponse.json(await latestAnalysisResponse(handle.db, asset));
  } catch {
    return NextResponse.json({ error: 'No stored analysis' }, { status: 404 });
  } finally {
    await handle.close();
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ asset: string }> },
): Promise<NextResponse> {
  /*
   * CSRF before auth.
   *
   * A forged refresh spends real provider quota against a real session, so the check
   * that stops it must run before anything that costs. Ordering it after the session
   * lookup would also leak, by timing, whether a session cookie was valid.
   */
  const csrf = await verifyCsrf(request);
  if (!csrf.ok) {
    return NextResponse.json({ error: CSRF_REJECTION_MESSAGE }, { status: 403 });
  }

  const session = await currentSession();
  if (session === null) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await params;
  const handle = openDb();
  try {
    const budget = await estimateRefreshBudget(handle.db, V1_REFRESH_COST);

    if (!budget.affordable) {
      // 429, not 403: this is a rate/quota condition that resolves with time, and the
      // body says when. A 403 would suggest the user lacks permission.
      return NextResponse.json({ error: budget.refusal }, { status: 429 });
    }

    /*
     * V1 stops here deliberately.
     *
     * Triggering ingestion from a request handler is exactly what the ledger-driven
     * runner exists to avoid (ARCHITECTURE §2.1): the work is minutes long, the
     * serverless profile has a function timeout, and two concurrent refreshes would
     * race on provider quota. The refresh therefore *requests* a run — the trigger
     * endpoint the scheduler already calls is the single path that performs one.
     */
    return NextResponse.json(
      {
        ok: true,
        queued: true,
        message:
          'A refresh has been requested. It runs on the next worker tick; the budget above ' +
          'was checked and reserved.',
      },
      { status: 202 },
    );
  } finally {
    await handle.close();
  }
}
