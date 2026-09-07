import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    // Playwright owns the e2e directory; vitest must not try to run those specs.
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/*/e2e/**'],

    /**
     * Test files run one at a time.
     *
     * Integration tests share a single Postgres database and truncate it between
     * cases. Run in parallel, one file's truncation lands in the middle of
     * another's inserts — producing foreign-key violations and deadlocks that look
     * like schema bugs but are pure test-harness contention.
     *
     * The alternative is a database per file, which is more machinery than a suite
     * this size justifies. Sequential runs cost a few seconds and make failures mean
     * what they say.
     */
    fileParallelism: false,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/test-support.ts'],
    },
  },
});
