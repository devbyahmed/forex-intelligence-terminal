// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The boundary rules below are not style preferences — they are how the invariants
 * in ARCHITECTURE.md 4.1 stay true as the codebase grows:
 *
 *   P1  engines stay pure, so scoring is reproducible and testable offline
 *   P6  the AI stays swappable, because no Gemini symbol escapes its provider
 *   P7  secrets stay server-side, because only packages/config reads process.env
 *
 * A reviewer will not catch these reliably on the hundredth pull request. A lint
 * rule will.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Surfacing an unhandled rejection late is how ingestion jobs silently stop working.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': 'error',
    },
  },

  // ── P7: only packages/config may read the environment ─────────────────────
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/config/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration from @forex-agent/config. Only packages/config may touch process.env (ARCHITECTURE.md P7).',
        },
      ],
    },
  },

  // ── P1: engines are pure — no I/O, no ambient clock ───────────────────────
  {
    files: ['packages/engines/**/*.ts'],
    ignores: ['packages/engines/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@forex-agent/db', '@forex-agent/db/*'],
              message:
                'Engines must be pure. Pass data in as arguments rather than querying (ARCHITECTURE.md 4.1).',
            },
            {
              group: ['@forex-agent/providers', '@forex-agent/providers/*'],
              message:
                'Engines must be pure. Resolve provider data in the worker and pass it in (ARCHITECTURE.md 4.1).',
            },
            {
              group: ['node:fs', 'node:http', 'node:https', 'node:net'],
              message: 'Engines must not perform I/O (ARCHITECTURE.md 4.1).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Engines must not perform I/O (ARCHITECTURE.md 4.1).' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Engines must take `now` as an injected argument so results are reproducible (ARCHITECTURE.md 8).',
        },
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message:
            'Engines must take `now` as an injected argument so results are reproducible (ARCHITECTURE.md 8).',
        },
      ],
    },
  },

  // ── P1/P6: the AI layer cannot reach data, and Gemini cannot escape ───────
  {
    files: ['packages/ai/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@forex-agent/db', '@forex-agent/db/*'],
              message:
                'The AI layer receives an EvidenceBundle; it must not query data (ARCHITECTURE.md 4.1).',
            },
            {
              group: ['@forex-agent/providers', '@forex-agent/providers/*'],
              message:
                'The AI layer receives an EvidenceBundle; it must not fetch data (ARCHITECTURE.md 4.1).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/ai/src/providers/gemini/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@google/genai', '@google/generative-ai', '@google-cloud/vertexai'],
              message:
                'Gemini may only be imported inside packages/ai/src/providers/gemini. Depend on the AIProvider interface instead (ARCHITECTURE.md P6).',
            },
          ],
        },
      ],
    },
  },

  // ── Tests may do what production code may not ─────────────────────────────
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'packages/testing/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // `expect(() => fn()).toThrow()` is the standard way to assert a throw, and
      // the callee returning void is the point of the assertion, not a mistake.
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },

  // Config files run in Node before the app exists.
  {
    files: ['*.config.js', '*.config.ts', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: { 'no-console': 'off' },
  },
);
