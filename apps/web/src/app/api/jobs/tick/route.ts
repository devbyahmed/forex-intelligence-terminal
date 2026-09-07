/**
 * POST /api/jobs/tick
 *
 * The scheduled entry point. An external cron — GitHub Actions on the free tier — calls
 * this, and it runs whatever the ledger says is due.
 *
 * This is the only surface in the product that is authenticated by a shared secret
 * rather than a session, because the caller is a machine with no user behind it. Two
 * consequences follow, and both are deliberate:
 *
 * - **It never explains a failure.** The endpoint is publicly reachable; the divergence
 *   list from a failed preflight names internal series and feed URLs. Failures go to the
 *   server log, and the caller gets a status code.
 * - **It is safe to call twice.** Every job claims its slot through a unique key, so a
 *   duplicated cron delivery runs nothing twice. The cron can be at-least-once, which is
 *   the only thing a free scheduler will promise.
 */

import { NextResponse } from 'next/server';
import { getEnv } from '@forex-agent/config';
import { buildTick, handleHttpTrigger } from '@forex-agent/worker';
import { openDb } from '../../../../lib/session';
import { logger } from '../../../../lib/logger';

export const dynamic = 'force-dynamic';
/** Above the trigger's own budget, so the runner stops itself rather than being killed. */
export const maxDuration = 300;

export async function POST(request: Request): Promise<NextResponse> {
  const expectedSecret = getEnv().JOB_TRIGGER_SECRET ?? '';
  if (expectedSecret === '') {
    // Fails closed. An unset secret must not mean an open endpoint — that is the one
    // misconfiguration that would let anyone on the internet spend our provider quota.
    logger.error('JOB_TRIGGER_SECRET is not set; refusing to run the tick');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // `Authorization: Bearer <secret>`. The header is compared in constant time inside the
  // trigger; splitting it here only separates the scheme from the value.
  const header = request.headers.get('authorization') ?? '';
  const secret = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

  const handle = openDb();
  try {
    const { jobs } = buildTick();
    const response = await handleHttpTrigger(
      { secret },
      {
        db: handle.db,
        jobs,
        expectedSecret,
        // Under the platform's own ceiling, so unfinished work is left due for the next
        // tick rather than killed mid-write.
        budgetMs: 240_000,
        onPreflightFailure: (error) => {
          logger.error({ err: error }, 'worker preflight failed; no jobs were run');
        },
      },
    );
    return NextResponse.json(response.body, { status: response.status });
  } catch (error) {
    // Composition itself can throw — a missing provider key, for instance. That is a
    // deployment fault and belongs in the log, not in a public response body.
    logger.error({ err: error }, 'tick composition failed');
    return NextResponse.json({ error: 'Job run failed' }, { status: 500 });
  } finally {
    await handle.close();
  }
}
