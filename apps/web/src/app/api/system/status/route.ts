/**
 * GET /api/system/status
 *
 * Provider health, quota consumption, recent job runs and per-series freshness. A
 * dashboard that reports on the market without reporting on itself lets a quiet
 * ingestion failure look like a quiet market.
 */

import { NextResponse } from 'next/server';
import { buildSystemStatus } from '@forex-agent/worker';
import { currentSession, openDb } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const session = await currentSession();
  if (session === null) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const handle = openDb();
  try {
    return NextResponse.json(await buildSystemStatus(handle.db, new Date()));
  } finally {
    await handle.close();
  }
}
