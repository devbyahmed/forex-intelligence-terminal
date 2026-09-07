/**
 * Server-only data access.
 *
 * Isolated here so the components stay pure functions of an `AnalysisResponse` — they
 * can be rendered in a test from a fixture, and they cannot accidentally reach the
 * database from a client bundle.
 */

import type { AnalysisResponse } from '@forex-agent/contracts';
import { getEnv } from '@forex-agent/config';
import { createDb, type Database } from '@forex-agent/db';
import {
  AnalysisNotFoundError,
  analysisResponseById,
  latestAnalysisResponse,
} from '@forex-agent/worker';

export async function loadLatestAnalysis(symbol: string): Promise<AnalysisResponse | null> {
  return withDb((db) => latestAnalysisResponse(db, symbol));
}

/** One stored run, by id. What makes a report reproducible rather than regenerated. */
export async function loadAnalysisById(id: string): Promise<AnalysisResponse | null> {
  return withDb((db) => analysisResponseById(db, id));
}

async function withDb(
  read: (db: Database) => Promise<AnalysisResponse>,
): Promise<AnalysisResponse | null> {
  // Validated by the env schema at startup, so there is no half-configured case to
  // return null for here — an absent database is a boot failure, not an empty page.
  const handle = createDb({ connectionString: getEnv().DATABASE_URL });
  try {
    return await read(handle.db);
  } catch (error) {
    // A missing analysis is a 404, not a 500 — asking for a report that does not exist
    // is an ordinary thing for a URL to do.
    if (error instanceof AnalysisNotFoundError) return null;
    throw error;
  } finally {
    await handle.close();
  }
}
