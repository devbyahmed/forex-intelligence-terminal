/**
 * Raw SQL against tables the schema already describes.
 *
 * A query written as a raw `sql` template is invisible to both TypeScript and ESLint.
 * That is not a theoretical weakness: `systemStatus.ts` hand-wrote
 * `SELECT ... breaker_open_until FROM provider_status`, a column that does not exist —
 * the table records a `breaker` state enum and a `breaker_opened_at` timestamp. It
 * passed typecheck, passed lint, and shipped a 500 to the dashboard. The same file had
 * a sibling query with the identical weakness.
 *
 * The lesson is the CHECK-constraint lesson again: **having found one, find out
 * whether there are others**, and make the answer a test rather than a memory.
 *
 * This audit is deliberately narrow. It does not object to `sql` templates in general —
 * they are the right tool for schema defaults, `excluded.x` in an upsert, computed
 * expressions in a select list, and everything in `migrations/`. It objects to exactly
 * one shape: **a raw query naming a table the Drizzle schema describes**, because
 * that is the shape where a wrong identifier survives every other check.
 *
 * Each allowlisted case is here because the typed builder genuinely cannot express it,
 * and says which. "It was easier" is not on the list.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index.js';

/** Every table name the Drizzle schema describes. */
function schemaTableNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (typeof value !== 'object') continue;
    // Drizzle stores the SQL name on a well-known symbol; read it without importing
    // internals by matching the symbol's description.
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (!/OriginalName|Name$/.test(symbol.description ?? '')) continue;
      const name = (value as unknown as Record<symbol, unknown>)[symbol];
      if (typeof name === 'string' && name !== '') names.add(name);
    }
  }
  return names;
}

/**
 * Raw queries that must stay raw, each with the reason the typed builder cannot do it.
 *
 * Keyed by file path and table so an allowlist entry cannot silently widen to cover a
 * second query someone adds to the same file later.
 */
const ALLOWED: readonly {
  readonly file: string;
  readonly table: string;
  readonly why: string;
}[] = [
  {
    file: 'packages/auth/src/rateLimit.ts',
    table: 'login_attempts',
    why:
      'A single statement combining a windowed count, a lateral last-success lookup and a ' +
      'lockout decision. Splitting it into typed queries would make the rate-limit decision ' +
      'non-atomic, which is the failure the whole module exists to prevent.',
  },
  {
    file: 'packages/providers/src/resilience.ts',
    table: 'provider_status',
    why:
      'The atomic quota reservation: the cap check lives inside the UPDATE ... WHERE predicate ' +
      'so the check and the increment are one decision. Drizzle cannot express a conditional ' +
      'increment guarded by the pre-update value, and read-then-write is exactly how a free ' +
      'tier gets burned by two concurrent calls.',
  },
  {
    file: 'packages/worker/src/jobs/ingestMacro.ts',
    table: 'macro_observations',
    why:
      'A window function (DISTINCT ON over series and period ordered by vintage) that resolves ' +
      'revisions to one row per period. Drizzle has no builder for DISTINCT ON.',
  },
  {
    file: 'packages/worker/src/jobs/ingestMacro.ts',
    table: 'macro_series',
    why:
      'The join side of the same DISTINCT ON statement above. Listed separately rather than ' +
      'folded into it, so allowlisting one query cannot silently cover a second query against ' +
      'a different table in the same file.',
  },
];

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Source files to audit — everything but tests, schema definitions and migrations. */
function sourceFiles(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'migrations') continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      // Schema files define the tables; naming them there is the point.
      if (full.replace(/\\/g, '/').includes('/schema/')) continue;
      out.push(full);
    }
  };
  for (const pkg of ['core', 'config', 'db', 'providers', 'engines', 'ai', 'auth', 'worker']) {
    const dir = join(REPO_ROOT, 'packages', pkg, 'src');
    try {
      walk(dir);
    } catch {
      // A package without a src directory is not an error here.
    }
  }
  return out;
}

interface Finding {
  readonly file: string;
  readonly table: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * Raw SQL naming a schema table.
 *
 * Matches `FROM x`, `JOIN x`, `INTO x` and `UPDATE x` — the four ways a query binds
 * itself to a table. A `sql` template that merely interpolates a Drizzle column
 * reference (`${macroObservations.value}`) is not raw in the sense that matters: the
 * identifier comes from the schema and a wrong name is a compile error.
 */
function findRawTableReferences(tables: ReadonlySet<string>): readonly Finding[] {
  const findings: Finding[] = [];

  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    const relativePath = relative(REPO_ROOT, file).replace(/\\/g, '/');
    const lines = source.split('\n');

    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(
        /\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)\b/gi,
      )) {
        const table = match[1]?.toLowerCase();
        if (table === undefined || !tables.has(table)) continue;
        findings.push({
          file: relativePath,
          table,
          line: index + 1,
          snippet: line.trim().slice(0, 100),
        });
      }
    }
  }
  return findings;
}

describe('raw SQL against schema-described tables', () => {
  const tables = schemaTableNames();

  it('knows the schema tables it is auditing against', () => {
    // If this collapses to a handful, the audit below is passing because it is
    // looking for nothing.
    expect(tables.size).toBeGreaterThanOrEqual(20);
    expect(tables.has('provider_status')).toBe(true);
    expect(tables.has('macro_observations')).toBe(true);
    expect(tables.has('analysis_statements')).toBe(true);
  });

  it('finds only allowlisted raw queries', () => {
    const findings = findRawTableReferences(tables);
    const allowed = new Set(ALLOWED.map((a) => `${a.file}::${a.table}`));

    const unexpected = findings.filter((f) => !allowed.has(`${f.file}::${f.table}`));

    /*
     * If this fails, the query is almost certainly better written with the typed
     * builder — a wrong column name then becomes a compile error rather than a 500.
     * If it genuinely cannot be, add it to ALLOWED with the reason the builder cannot
     * express it. "It was easier" is not a reason.
     */
    expect(
      unexpected.map((f) => `${f.file}:${String(f.line)} references ${f.table} — ${f.snippet}`),
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    // An allowlist entry for a query that no longer exists is a hole held open for
    // nothing, and the next person to touch the file inherits permission they did not
    // ask for.
    const findings = findRawTableReferences(tables);
    const present = new Set(findings.map((f) => `${f.file}::${f.table}`));

    const stale = ALLOWED.filter((a) => !present.has(`${a.file}::${a.table}`)).map(
      (a) => `${a.file}::${a.table}`,
    );
    expect(stale).toEqual([]);
  });

  it('requires every allowlist entry to say why the builder cannot do it', () => {
    for (const entry of ALLOWED) {
      expect(entry.why.length).toBeGreaterThan(60);
      // The reason must describe a capability gap, not a preference.
      expect(entry.why).not.toMatch(/easier|simpler|quicker|convenient/i);
    }
  });
});
