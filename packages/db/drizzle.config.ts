import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated as plain SQL and committed. In a system where an old
 * report must re-render exactly as generated, schema history is part of the audit
 * trail, not an implementation detail of the ORM.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Read here rather than through packages/config: drizzle-kit is a CLI that runs
    // outside the app's boot sequence.
    url: process.env['DATABASE_URL'] ?? '',
  },
  strict: true,
  verbose: true,
});
