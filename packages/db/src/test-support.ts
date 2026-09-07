/**
 * Integration-test database helpers.
 *
 * Integration tests run against a **real Postgres**, never a mock. The schema
 * constraints in this system are not incidental — they *are* the enforcement of
 * Amendment A2 and Principle P3. A fake that accepted every insert would test
 * nothing that matters.
 *
 * The provisioning mechanism is a natively installed Postgres and a dedicated test
 * database, truncated between runs.
 *
 * Lives inside packages/db rather than packages/testing to avoid a dependency cycle:
 * packages/testing would otherwise depend on db while db's own tests depend on it.
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Database, type DbHandle } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Works from both `src` (vitest) and `dist` (built) layouts. */
function migrationsFolder(): string {
  return resolve(here, '..', 'migrations');
}

export class TestDatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDatabaseUnavailableError';
  }
}

export function testDatabaseUrl(): string {
  // Read directly rather than through packages/config: this is test infrastructure,
  // and it must work before the app's env schema is satisfied.
  // eslint-disable-next-line no-restricted-properties
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new TestDatabaseUnavailableError(
      'TEST_DATABASE_URL is not set. Integration tests need a real Postgres.\n' +
        'Run: pnpm db:create:test  (see README.md)',
    );
  }
  return url;
}

/** True when integration tests can run here. Used to skip rather than fail locally. */
export function hasTestDatabase(): boolean {
  try {
    testDatabaseUrl();
    return true;
  } catch {
    return false;
  }
}

export interface TestDb extends DbHandle {
  /** Empty every table while leaving the schema and enums in place. */
  truncateAll(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const handle = createDb({
    connectionString: testDatabaseUrl(),
    // Always the plain driver locally, even if the URL looks like Neon.
    driver: 'pg',
    maxConnections: 5,
  });

  await migrate(handle.db, { migrationsFolder: migrationsFolder() });

  return {
    ...handle,
    truncateAll: () => truncateAll(handle.db),
  };
}

/**
 * Truncate every application table in one statement.
 *
 * `TRUNCATE ... CASCADE` in a single call sidesteps foreign-key ordering entirely,
 * which keeps this correct as tables are added in later phases — a hand-maintained
 * delete order would silently rot.
 */
export async function truncateAll(db: Database): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT LIKE '__drizzle%'
  `);

  const list = extractRows<{ tablename: string }>(rows);
  if (list.length === 0) return;

  const identifiers = list.map((r) => `"${r.tablename}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`));
}

/** Normalise driver differences in how `execute` returns rows. */
export function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const withRows = result as { rows?: T[] };
  return withRows.rows ?? [];
}

/**
 * Assert that a database operation is rejected by a specific named constraint.
 *
 * Matching on the constraint name rather than on "it threw" is deliberate: a test
 * that merely observes a failure would pass if the insert broke for an unrelated
 * reason, and would keep passing after the constraint was accidentally dropped.
 */
/**
 * Flatten an error and everything it wraps into one searchable string.
 *
 * Drizzle wraps driver errors, so the Postgres `constraint` field and the real
 * message live on `error.cause` rather than on the error itself. Matching only the
 * top-level error would make every one of these assertions fail even when the
 * constraint fired correctly.
 */
function describeErrorChain(e: unknown): string {
  const parts: string[] = [];
  let current: unknown = e;

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      // Primitive tail of the chain: safe to stringify, unlike a bare object.
      if (current !== undefined && current !== null) {
        parts.push(typeof current === 'string' ? current : JSON.stringify(current));
      }
      break;
    }

    const rec = current as Record<string, unknown>;
    if (current instanceof Error) parts.push(current.message);

    // Postgres surfaces the violated constraint by name — the precise signal.
    for (const field of ['constraint', 'detail', 'code', 'table', 'where'] as const) {
      const v = rec[field];
      if (typeof v === 'string' && v !== '') parts.push(`${field}=${v}`);
    }

    current = rec.cause;
  }

  return parts.join(' | ');
}

export async function expectConstraintViolation(
  fn: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const described = describeErrorChain(e);
    if (described.includes(constraintName)) return;
    throw new Error(
      `Expected constraint "${constraintName}" to reject this operation, ` +
        `but it failed differently: ${described}`,
    );
  }
  throw new Error(
    `Expected constraint "${constraintName}" to reject this operation, but it succeeded.`,
  );
}

/** Assert that an operation is rejected by the lineage trigger, with a message match. */
export async function expectTriggerRejection(
  fn: () => Promise<unknown>,
  messageFragment: string,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const described = describeErrorChain(e);
    if (described.toLowerCase().includes(messageFragment.toLowerCase())) return;
    throw new Error(`Expected rejection mentioning "${messageFragment}", got: ${described}`);
  }
  throw new Error(`Expected rejection mentioning "${messageFragment}", but it succeeded.`);
}
