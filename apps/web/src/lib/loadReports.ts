/**
 * Reading stored reports.
 *
 * The archive summary comes from the report's own stored `payload`, not from a fresh
 * query against the analysis. A report is a record of what was said; deriving its
 * summary from current data would let a row in the archive drift away from the document
 * it links to.
 */

import { desc, eq } from 'drizzle-orm';
import { reports } from '@forex-agent/db';
import { openDb } from './session';

export interface ArchiveEntry {
  readonly id: string;
  readonly reportDate: string;
  readonly title: string;
  readonly signedScore: number | null;
  readonly band: string | null;
  readonly confidenceLevel: string | null;
  readonly coverage: number;
  readonly generatedAt: string;
}

interface StoredPayload {
  readonly signedScore?: number | null;
  readonly band?: string | null;
  readonly confidence?: { readonly level?: string } | null;
  readonly coverage?: number;
}

export async function loadReportArchive(limit = 60): Promise<readonly ArchiveEntry[]> {
  const handle = openDb();
  try {
    const rows = await handle.db
      .select({
        id: reports.id,
        reportDate: reports.reportDate,
        title: reports.title,
        payload: reports.payload,
        generatedAt: reports.generatedAt,
      })
      .from(reports)
      .orderBy(desc(reports.reportDate))
      .limit(limit);

    return rows.map((r) => {
      const payload = (r.payload ?? {}) as StoredPayload;
      return {
        id: r.id,
        reportDate: r.reportDate,
        title: r.title,
        signedScore: payload.signedScore ?? null,
        band: payload.band ?? null,
        confidenceLevel: payload.confidence?.level ?? null,
        coverage: payload.coverage ?? 0,
        generatedAt: r.generatedAt.toISOString(),
      };
    });
  } finally {
    await handle.close();
  }
}

/** One stored report, rendered exactly as it was sent. */
export async function loadStoredReport(
  id: string,
): Promise<{ readonly title: string; readonly html: string; readonly generatedAt: string } | null> {
  const handle = openDb();
  try {
    const [row] = await handle.db
      .select({
        title: reports.title,
        html: reports.contentHtml,
        generatedAt: reports.generatedAt,
      })
      .from(reports)
      .where(eq(reports.id, id))
      .limit(1);

    if (row === undefined) return null;
    return { title: row.title, html: row.html, generatedAt: row.generatedAt.toISOString() };
  } finally {
    await handle.close();
  }
}
