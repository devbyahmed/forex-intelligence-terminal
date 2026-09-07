/**
 * Deterministic fixtures.
 *
 * Fixed timestamps and values so a failing test points at a code change rather than
 * at the calendar.
 */

import type { Provenance } from '@forex-agent/core';

export const FIXED_NOW = new Date('2026-08-30T12:00:00.000Z');

export const minutesAgo = (n: number, from: Date = FIXED_NOW): Date =>
  new Date(from.getTime() - n * 60_000);

export const hoursAgo = (n: number, from: Date = FIXED_NOW): Date => minutesAgo(n * 60, from);

export const daysAgo = (n: number, from: Date = FIXED_NOW): Date => hoursAgo(n * 24, from);

/** A Tier 1 FRED provenance, the shape most fact rows carry. */
export function fredProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    providerId: 'fred',
    sourceName: 'Federal Reserve Economic Data',
    sourceUrl: 'https://fred.stlouisfed.org/series/DGS10',
    sourceTier: 1,
    sourceTimestamp: hoursAgo(20),
    retrievedAt: minutesAgo(30),
    ...overrides,
  };
}

/** Column-shaped provenance for direct inserts in database tests. */
export function provenanceColumns(p: Provenance = fredProvenance()) {
  return {
    sourceProvider: p.providerId,
    sourceName: p.sourceName,
    sourceUrl: p.sourceUrl,
    sourceTier: p.sourceTier,
    sourceTimestamp: p.sourceTimestamp,
    retrievedAt: p.retrievedAt,
  };
}
