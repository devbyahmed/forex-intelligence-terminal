/**
 * Seed-to-database integrity.
 *
 * Three times now the seed has said one thing while the running system did another,
 * and every time the divergence was invisible until a live run exposed it:
 *
 *  - **Phase 6.** Feeds removed from the seed stayed active and kept failing forever,
 *    because upserting never turns anything off.
 *  - **Phase 7.** `DTWEXBGS` was reclassified `DAILY` → `WEEKLY` after the H.10 family
 *    was measured publishing ~9 days in arrears, but the upsert refreshed only
 *    `name`, `role` and `unit`. The database kept `DAILY`, and factor F1 — the
 *    joint-heaviest — was scored `STALE` at half weight for two phases.
 *  - **Phase 8.** `expectedPublicationDays` arrives with exactly the same hazard: a
 *    column the seed sets and the upsert could quietly fail to propagate.
 *
 * All three are the same failure. The seed is the source of truth, but nothing
 * checked that the database agreed with it. "The row exists" was never the property
 * that mattered; "every field matches" is.
 *
 * This module compares **field by field**, and runs both as a test and at worker
 * startup, so a fourth instance is structurally impossible rather than discovered by
 * another live run.
 */

import type { Database } from './client.js';
import { assets, eventImportanceRules, macroSeries, newsSources } from './schema/index.js';
import {
  SEED_ASSETS,
  SEED_IMPORTANCE_RULES,
  SEED_MACRO_SERIES,
  SEED_NEWS_SOURCES,
} from './seed.js';

export interface SeedDivergence {
  readonly entity: string;
  /** Natural key of the offending row. */
  readonly key: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly kind: 'FIELD_MISMATCH' | 'MISSING_ROW' | 'ORPHANED_ROW';
}

export class SeedIntegrityError extends Error {
  readonly divergences: readonly SeedDivergence[];

  constructor(divergences: readonly SeedDivergence[]) {
    super(
      `Database does not match the seed definition (${String(divergences.length)} divergence(s)):\n` +
        divergences
          .map(
            (d) =>
              `  - ${d.entity}[${d.key}].${d.field}: expected ${JSON.stringify(d.expected)}, ` +
              `got ${JSON.stringify(d.actual)} (${d.kind})`,
          )
          .join('\n') +
        '\n\nRun the seed to reconcile.',
    );
    this.name = 'SeedIntegrityError';
    this.divergences = divergences;
  }
}

/**
 * Compare the database against every seed definition.
 *
 * Returns divergences rather than throwing, so a test can assert on the list and the
 * caller can decide whether the process should refuse to start.
 */
export async function verifySeedIntegrity(db: Database): Promise<SeedDivergence[]> {
  const divergences: SeedDivergence[] = [];

  // ── Macro series ──────────────────────────────────────────────────────────
  const seriesRows = await db
    .select({
      seriesId: macroSeries.seriesId,
      name: macroSeries.name,
      role: macroSeries.role,
      unit: macroSeries.unit,
      cadence: macroSeries.cadence,
      isActive: macroSeries.isActive,
      expectedPublicationDays: macroSeries.expectedPublicationDays,
    })
    .from(macroSeries);

  const seriesByKey = new Map(seriesRows.map((r) => [r.seriesId, r]));

  for (const expected of SEED_MACRO_SERIES) {
    const actual = seriesByKey.get(expected.seriesId);
    if (actual === undefined) {
      divergences.push(missingRow('macro_series', expected.seriesId));
      continue;
    }
    // Every field the seed declares, not only the ones the upsert happens to set.
    const key = expected.seriesId;
    compare(divergences, 'macro_series', key, 'name', expected.name, actual.name);
    compare(divergences, 'macro_series', key, 'role', expected.role, actual.role);
    compare(divergences, 'macro_series', key, 'unit', expected.unit, actual.unit);
    compare(divergences, 'macro_series', key, 'cadence', expected.cadence, actual.cadence);
    compare(divergences, 'macro_series', key, 'isActive', true, actual.isActive);
    compareArray(
      divergences,
      'macro_series',
      key,
      'expectedPublicationDays',
      expected.expectedPublicationDays,
      actual.expectedPublicationDays,
    );
  }

  for (const row of seriesRows) {
    // A series dropped from the seed must be deactivated, not left running.
    if (!SEED_MACRO_SERIES.some((s) => s.seriesId === row.seriesId) && row.isActive) {
      divergences.push({
        entity: 'macro_series',
        key: row.seriesId,
        field: 'isActive',
        expected: false,
        actual: true,
        kind: 'ORPHANED_ROW',
      });
    }
  }

  // ── News sources ──────────────────────────────────────────────────────────
  const feedRows = await db
    .select({
      feedUrl: newsSources.feedUrl,
      name: newsSources.name,
      tier: newsSources.tier,
      isActive: newsSources.isActive,
    })
    .from(newsSources);

  const feedByUrl = new Map(feedRows.map((r) => [r.feedUrl, r]));

  for (const expected of SEED_NEWS_SOURCES) {
    const actual = feedByUrl.get(expected.feedUrl);
    if (actual === undefined) {
      divergences.push(missingRow('news_sources', expected.feedUrl));
      continue;
    }
    compare(divergences, 'news_sources', expected.feedUrl, 'name', expected.name, actual.name);
    compare(divergences, 'news_sources', expected.feedUrl, 'tier', expected.tier, actual.tier);
    compare(divergences, 'news_sources', expected.feedUrl, 'isActive', true, actual.isActive);
  }

  for (const row of feedRows) {
    if (!SEED_NEWS_SOURCES.some((s) => s.feedUrl === row.feedUrl) && row.isActive) {
      divergences.push({
        entity: 'news_sources',
        key: row.feedUrl,
        field: 'isActive',
        expected: false,
        actual: true,
        kind: 'ORPHANED_ROW',
      });
    }
    // HTTPS is a provenance invariant, not a preference — GDELT was rejected over
    // exactly this. Checking it here as well as in the seed test means a row
    // inserted by hand cannot bypass it unnoticed.
    if (row.isActive && !row.feedUrl.startsWith('https://')) {
      divergences.push({
        entity: 'news_sources',
        key: row.feedUrl,
        field: 'scheme',
        expected: 'https',
        actual: row.feedUrl.split(':')[0] ?? '?',
        kind: 'FIELD_MISMATCH',
      });
    }
  }

  // ── Assets ────────────────────────────────────────────────────────────────
  const assetRows = await db
    .select({
      symbol: assets.symbol,
      name: assets.name,
      assetClass: assets.assetClass,
      baseCurrency: assets.baseCurrency,
      quoteCurrency: assets.quoteCurrency,
    })
    .from(assets);

  const assetBySymbol = new Map(assetRows.map((r) => [r.symbol, r]));

  for (const expected of SEED_ASSETS) {
    const actual = assetBySymbol.get(expected.symbol);
    if (actual === undefined) {
      divergences.push(missingRow('assets', expected.symbol));
      continue;
    }
    const key = expected.symbol;
    compare(divergences, 'assets', key, 'name', expected.name, actual.name);
    compare(divergences, 'assets', key, 'assetClass', expected.assetClass, actual.assetClass);
    compare(divergences, 'assets', key, 'baseCurrency', expected.base, actual.baseCurrency);
    compare(divergences, 'assets', key, 'quoteCurrency', expected.quote, actual.quoteCurrency);
    // `isActive` is deliberately NOT compared: activating an asset is an operational
    // decision the seed must not override (PRD_V1 §9.4a).
  }

  // ── Importance rules ──────────────────────────────────────────────────────
  const ruleRows = await db
    .select({
      country: eventImportanceRules.country,
      eventPattern: eventImportanceRules.eventPattern,
      importance: eventImportanceRules.importance,
    })
    .from(eventImportanceRules);

  const ruleByKey = new Map(ruleRows.map((r) => [`${r.country}|${r.eventPattern}`, r]));

  for (const expected of SEED_IMPORTANCE_RULES) {
    const key = `${expected.country}|${expected.eventPattern}`;
    const actual = ruleByKey.get(key);
    if (actual === undefined) {
      divergences.push(missingRow('event_importance_rules', key));
      continue;
    }
    compare(
      divergences,
      'event_importance_rules',
      key,
      'importance',
      expected.importance,
      actual.importance,
    );
  }

  for (const row of ruleRows) {
    const key = `${row.country}|${row.eventPattern}`;
    if (!SEED_IMPORTANCE_RULES.some((r) => `${r.country}|${r.eventPattern}` === key)) {
      // Rules are deleted rather than deactivated — a leftover rule is an orphaned
      // decision that goes on classifying releases by a policy already retired.
      divergences.push({
        entity: 'event_importance_rules',
        key,
        field: '(row)',
        expected: 'absent',
        actual: 'present',
        kind: 'ORPHANED_ROW',
      });
    }
  }

  return divergences;
}

/** Throwing form, for worker startup. */
export async function assertSeedIntegrity(db: Database): Promise<void> {
  const divergences = await verifySeedIntegrity(db);
  if (divergences.length > 0) throw new SeedIntegrityError(divergences);
}

function missingRow(entity: string, key: string): SeedDivergence {
  return {
    entity,
    key,
    field: '(row)',
    expected: 'present',
    actual: 'missing',
    kind: 'MISSING_ROW',
  };
}

function compare(
  into: SeedDivergence[],
  entity: string,
  key: string,
  field: string,
  expected: unknown,
  actual: unknown,
): void {
  if (expected !== actual) {
    into.push({ entity, key, field, expected, actual, kind: 'FIELD_MISMATCH' });
  }
}

/**
 * Order-insensitive array comparison.
 *
 * `[1,2,3,4,5]` and `[5,4,3,2,1]` describe the same week. Comparing them as ordered
 * lists would report a divergence with no operational meaning, and train whoever
 * reads the output to ignore it.
 */
function compareArray(
  into: SeedDivergence[],
  entity: string,
  key: string,
  field: string,
  expected: readonly number[],
  actual: readonly number[] | null,
): void {
  const a = [...expected].sort((x, y) => x - y).join(',');
  const b = [...(actual ?? [])].sort((x, y) => x - y).join(',');
  if (a !== b) {
    into.push({ entity, key, field, expected, actual, kind: 'FIELD_MISMATCH' });
  }
}
