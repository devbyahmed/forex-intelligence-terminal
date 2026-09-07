#!/usr/bin/env node
/**
 * Create and migrate a database.
 *
 *   node scripts/db-create.mjs           # development database, from DATABASE_URL
 *   node scripts/db-create.mjs --test    # test database, from TEST_DATABASE_URL
 *   node scripts/db-create.mjs --reset   # drop and recreate first
 *
 * Connects to the `postgres` maintenance database to issue CREATE DATABASE, then
 * reconnects to the target to run migrations. Safe to re-run: creation is skipped if
 * the database exists, and migrations are tracked by Drizzle's journal.
 *
 * There is no container runtime in this project — this script assumes a natively
 * installed Postgres reachable at the connection string.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const args = new Set(process.argv.slice(2));
const isTest = args.has('--test');
const shouldReset = args.has('--reset');

/** Minimal .env reader — this script runs before the app and its config loader. */
function loadEnvFile() {
  const path = join(repoRoot, '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== '') out[m[1]] = value;
  }
  return out;
}

const fileEnv = loadEnvFile();
const env = { ...fileEnv, ...process.env };

const varName = isTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
const connectionString = env[varName];

if (!connectionString) {
  console.error(
    `\n${varName} is not set.\n\n` +
      `Copy .env.example to .env and set it, for example:\n` +
      `  ${varName}=postgresql://postgres:postgres@localhost:5432/` +
      `${isTest ? 'forex_agent_test' : 'forex_agent'}\n`,
  );
  process.exit(1);
}

const url = new URL(connectionString);
const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));

if (!dbName) {
  console.error(`${varName} has no database name in its path.`);
  process.exit(1);
}

// Refuse to reset anything that is not obviously a test database. `--reset` drops
// data, and a mistyped variable should not be able to destroy the dev database.
if (shouldReset && !isTest && !/test/i.test(dbName)) {
  console.error(
    `Refusing to --reset "${dbName}": it is not a test database.\n` +
      `Drop it manually if that is really what you want.`,
  );
  process.exit(1);
}

const maintenanceUrl = new URL(url.toString());
maintenanceUrl.pathname = '/postgres';

const redact = (u) => {
  const c = new URL(u.toString());
  if (c.password) c.password = '***';
  return c.toString();
};

async function main() {
  console.log(`Target: ${dbName} (${redact(url)})`);

  const admin = new pg.Client({ connectionString: maintenanceUrl.toString() });
  try {
    await admin.connect();
  } catch (e) {
    console.error(
      `\nCould not connect to Postgres at ${redact(maintenanceUrl)}\n` +
        `  ${e instanceof Error ? e.message : String(e)}\n\n` +
        `Is PostgreSQL installed and running? See README.md.\n`,
    );
    process.exit(1);
  }

  try {
    if (shouldReset) {
      // Existing sessions would block the drop.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      console.log(`Dropped ${dbName}`);
    }

    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created ${dbName}`);
    } else {
      console.log(`${dbName} already exists`);
    }
  } finally {
    await admin.end();
  }

  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');

  const pool = new pg.Pool({ connectionString: url.toString() });
  try {
    const db = drizzle(pool);
    const migrationsFolder = join(repoRoot, 'packages', 'db', 'migrations');
    await migrate(db, { migrationsFolder });
    console.log('Migrations applied.');

    if (!isTest) {
      const { seed } = await import('../packages/db/dist/index.js');
      const { DEFAULT_RUNTIME_CONFIG } = await import('../packages/config/dist/index.js');
      const result = await seed(db, {
        profileName: DEFAULT_RUNTIME_CONFIG.profileName,
        config: DEFAULT_RUNTIME_CONFIG,
      });
      console.log(
        `Seeded: ${result.assets} assets, ${result.macroSeries} macro series, ` +
          `${result.newsSources} news sources, ${result.importanceRules} importance rules.`,
      );
    }
  } finally {
    await pool.end();
  }

  console.log(`\n${dbName} is ready.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
