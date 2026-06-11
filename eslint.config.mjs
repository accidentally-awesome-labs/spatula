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
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Plan 16-2 / D-10: block non-type imports from @spatula/core-types so the
      // type-only boundary holds across the monorepo. Value-imports (ErrorCode,
      // STATUS_MAP, ActionType, JobConfigSchema, etc.) must go through
      // @spatula/shared or @spatula/core; `import type { ... }` from
      // @spatula/core-types remains allowed. The codegen script in
      // @spatula/client/scripts/gen-error-classes.ts complies by importing
      // ErrorCode via @spatula/shared.
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
      'no-console': 'warn',
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
    // @spatula/core-types runtime values for legacy consumers (plan 16-2
    // D-10 — these shims ARE the canonical value-import surface).
    files: ['packages/shared/src/error-codes.ts', 'packages/core/src/types/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'],
  },
];
