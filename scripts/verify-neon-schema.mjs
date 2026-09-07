/**
 * Apply the migration set to Neon and prove the schema matches local.
 *
 * Run before Phase 12 depends on it. Finding a DDL problem during a deploy is worse
 * than finding it now, and there are two specific reasons to expect one:
 *
 *  - **DDL through PgBouncer in transaction mode can misbehave**, which is why
 *    migrations use `DIRECT_DATABASE_URL` rather than the pooled endpoint. This script
 *    refuses to run against a pooled host rather than discovering the difference from a
 *    half-applied migration.
 *  - **A migration that applies is not the same as a schema that matches.** Constraints
 *    and triggers are the parts most likely to differ silently, and they are exactly the
 *    parts this project's invariants rest on: the lineage trigger enforces Amendment
 *    A2, and the CHECK constraints enforce the abstention and provenance rules.
 *
 * So the comparison is structural — table names, CHECK constraint names, trigger names
 * — against the local database, and any difference in either direction is reported.
 *
 * Usage: node scripts/verify-neon-schema.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = Object.fromEntries(
  readFileSync(join(repoRoot, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const direct = env.DIRECT_DATABASE_URL;
const local = env.DATABASE_URL;

if (direct === undefined || direct === '') {
  console.error(
    'DIRECT_DATABASE_URL is not set.\n\n' +
      'Migrations must run over the direct (non-pooled) Neon endpoint: DDL through\n' +
      'PgBouncer in transaction mode can misbehave, and a half-applied migration is a\n' +
      'much worse thing to discover during a deploy.',
  );
  process.exit(1);
}

const directHost = new URL(direct).hostname;
if (directHost.includes('-pooler')) {
  // Refused rather than warned: the entire point of this variable is that it is not the
  // pooled endpoint, and a pooled string here would silently defeat it.
  console.error(
    `DIRECT_DATABASE_URL points at a pooled host (${directHost}).\n` +
      'The direct endpoint has no "-pooler" in its hostname. Migrations must not run\n' +
      'through PgBouncer.',
  );
  process.exit(1);
}

const { createDb } = await import(`file://${join(repoRoot, 'packages/db/dist/index.js')}`);
const { sql } = await import('drizzle-orm');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { drizzle } = await import('drizzle-orm/node-postgres');
const pg = (await import('pg')).default;

/** Names only: values differ between databases, structure must not. */
async function describeSchema(db) {
  const rows = async (q) => {
    const r = await db.execute(q);
    return r.rows ?? r;
  };

  const tables = (
    await rows(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `)
  ).map((r) => r.table_name);

  const checks = (
    await rows(sql`
      SELECT rel.relname || '.' || con.conname AS name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE con.contype = 'c' AND n.nspname = 'public'
      ORDER BY 1
    `)
  ).map((r) => r.name);

  const triggers = (
    await rows(sql`
      SELECT c.relname || '.' || t.tgname AS name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public'
      ORDER BY 1
    `)
  ).map((r) => r.name);

  const enums = (
    await rows(sql`
      SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND n.nspname = 'public'
      ORDER BY 1
    `)
  ).map((r) => r.typname);

  const indexes = (
    await rows(sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname
    `)
  ).map((r) => r.indexname);

  return { tables, checks, triggers, enums, indexes };
}

function diff(label, localList, remoteList) {
  const onlyLocal = localList.filter((x) => !remoteList.includes(x));
  const onlyRemote = remoteList.filter((x) => !localList.includes(x));
  const ok = onlyLocal.length === 0 && onlyRemote.length === 0;
  console.log(
    `  ${ok ? 'MATCH  ' : 'DIFFER '} ${label.padEnd(12)} local ${String(localList.length).padStart(3)}  neon ${String(remoteList.length).padStart(3)}`,
  );
  if (onlyLocal.length > 0) console.log('           missing on Neon :', onlyLocal.join(', '));
  if (onlyRemote.length > 0) console.log('           extra on Neon   :', onlyRemote.join(', '));
  return ok;
}

// ── 1. Apply migrations over the direct connection ──────────────────────────
console.log('=== 1. applying migrations over the DIRECT connection ===');
console.log('host:', directHost);

const pool = new pg.Pool({ connectionString: direct, max: 1 });
try {
  const migrationDb = drizzle(pool);
  await migrate(migrationDb, { migrationsFolder: join(repoRoot, 'packages/db/migrations') });
  console.log('migrations applied.\n');
} finally {
  await pool.end();
}

// ── 2. Compare structure against local ──────────────────────────────────────
console.log('=== 2. comparing schema against local ===');
const neon = createDb({ connectionString: direct });
const localDb = createDb({ connectionString: local });

let allMatch = true;
try {
  const [l, r] = await Promise.all([describeSchema(localDb.db), describeSchema(neon.db)]);
  for (const key of ['tables', 'enums', 'checks', 'triggers', 'indexes']) {
    allMatch = diff(key, l[key], r[key]) && allMatch;
  }

  console.log('\n=== 3. the invariants that carry the amendments ===');
  const lineage = r.triggers.filter((t) => t.includes('lineage') || t.includes('statement'));
  console.log('  lineage trigger      :', lineage.length > 0 ? lineage.join(', ') : 'ABSENT');
  console.log('  CHECK constraints    :', r.checks.length);
  const a2 = r.checks.filter((c) =>
    /fact_requires_provenance|derived_requires_parents|ai_requires_generation|fact_has_no_derivation|non_ai_has_no_generation/.test(
      c,
    ),
  );
  console.log('  A2 lineage checks    :', a2.length, a2.length === 5 ? '(all five)' : '(EXPECTED 5)');
  const abstention = r.checks.filter((c) =>
    /insufficient_has_no_score|abstain_coherent/.test(c),
  );
  console.log('  abstention checks    :', abstention.length, abstention.length === 2 ? '(both)' : '(EXPECTED 2)');

  if (lineage.length === 0 || a2.length !== 5 || abstention.length !== 2) allMatch = false;
} finally {
  await Promise.all([neon.close(), localDb.close()]);
}

// ── 4. Seed and reconcile ───────────────────────────────────────────────────
console.log('\n=== 4. seeding Neon and reconciling ===');
const seedDb = createDb({ connectionString: direct });
try {
  const { seed, verifySeedIntegrity } = await import(
    `file://${join(repoRoot, 'packages/db/dist/index.js')}`
  );
  const { DEFAULT_RUNTIME_CONFIG } = await import(
    `file://${join(repoRoot, 'packages/config/dist/index.js')}`
  );

  const result = await seed(seedDb.db, {
    profileName: 'default',
    config: DEFAULT_RUNTIME_CONFIG,
  });
  console.log(
    `  seeded: ${result.assets} assets, ${result.macroSeries} macro series, ` +
      `${result.newsSources} news sources, ${result.importanceRules} importance rules`,
  );

  const divergences = await verifySeedIntegrity(seedDb.db);
  console.log('  seed reconciliation  :', divergences.length === 0 ? 'CLEAN' : `${divergences.length} DIVERGENCE(S)`);
  for (const d of divergences) {
    console.log(`    - ${d.entity}[${d.key}].${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`);
  }
  if (divergences.length > 0) allMatch = false;
} finally {
  await seedDb.close();
}

console.log(
  '\n' +
    (allMatch
      ? 'RESULT: Neon schema matches local, invariants present, seed reconciles.'
      : 'RESULT: DIFFERENCES FOUND — see above. Do not proceed to Phase 12 on this schema.'),
);
process.exit(allMatch ? 0 : 1);
