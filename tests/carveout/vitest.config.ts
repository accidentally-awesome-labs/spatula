import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

// Forward carve-out test suite — proves the OSS-only server satisfies the
// post-carve contract:
//   - OpenAPI spec has no billing/stripe paths
//   - /api/v1/admin/system/metrics aggregates without referencing usage_records
//   - /api/v1/auth/me + /api/v1/admin/tenants/:id work against a live OSS-only
//     server with seeded tenant + API key
//
// Mirrors the alias shape of tests/e2e/vitest.config.ts so workspace imports
// resolve identically (this suite reuses @accidentally-awesome-labs/spatula-* package barrels).
export default defineConfig({
  resolve: {
    alias: {
      '@accidentally-awesome-labs/spatula-shared': resolve(root, 'packages/shared/src/index.ts'),
      '@accidentally-awesome-labs/spatula-core': resolve(root, 'packages/core/src/index.ts'),
      '@accidentally-awesome-labs/spatula-db': resolve(root, 'packages/db/src/index.ts'),
      '@accidentally-awesome-labs/spatula-queue': resolve(root, 'packages/queue/src/index.ts'),
    },
  },
  test: {
    include: ['tests/carveout/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
