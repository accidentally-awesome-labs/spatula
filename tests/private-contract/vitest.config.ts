import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

// Reverse private-contract test suite — proves the TS + SQL surface that the
// (private) spatula-saas repo consumes from this OSS monorepo is intact.
//
// TS-surface test (oss-surface.test.ts): mocked consumer import block; 6 import
//   groups + an explicit negative-billing assertion. Build fails on silent
//   removal of any consumed export.
//
// SQL schema-lint test (schema-lint.test.ts): applies 0000_v1_baseline.sql to
//   an ephemeral Postgres, snapshots the schema via pg_dump --schema-only +
//   the Wave 4 normalizer, and compares against a committed baseline.
//
// Alias shape matches tests/e2e/vitest.config.ts so workspace imports resolve.
export default defineConfig({
  resolve: {
    alias: {
      '@spatula/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@spatula/core': resolve(root, 'packages/core/src/index.ts'),
      '@spatula/db': resolve(root, 'packages/db/src/index.ts'),
      '@spatula/queue': resolve(root, 'packages/queue/src/index.ts'),
    },
  },
  test: {
    include: ['tests/private-contract/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
