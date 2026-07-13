import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // The codebase currently uses `any` at external API, framework, and test-double
      // boundaries. Keep lint as an error gate for enforced rules rather than a
      // stream of warning-only debt.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Enforce the public package boundary: @spatula/core-types is type-only
      // outside its own package. Runtime values such as ErrorCode, STATUS_MAP,
      // ActionType, and JobConfigSchema must come from @spatula/shared or
      // @spatula/core.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@spatula/core-types',
              allowTypeImports: true,
              message:
                '@spatula/core-types is type-only. Use `import type { X }` or import the runtime value via @spatula/shared (ErrorCode/STATUS_MAP) or @spatula/core (zod schemas).',
            },
          ],
        },
      ],
      // CLI commands and one-shot maintenance scripts intentionally write to
      // stdout/stderr. Structured runtime logging is covered by package code
      // review and tests, not this generic browser-oriented rule.
      'no-console': 'off',
    },
  },
  {
    // Exempt @spatula/core-types' own files from the rule — the package
    // legitimately exports values from its own internal modules.
    files: ['packages/core-types/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
  {
    // Exempt the back-compat shim files that intentionally re-export the
    // @spatula/core-types runtime values for legacy consumers.
    files: ['packages/shared/src/error-codes.ts', 'packages/core/src/types/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'],
  },
];
