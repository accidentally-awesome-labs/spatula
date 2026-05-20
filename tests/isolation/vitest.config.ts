import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

// Cross-tenant isolation test suite — Phase 17 plan 17-07.
//
// What this suite proves:
//   - Cross-tenant resource lookups return RESOURCE.NOT_FOUND (not data leakage).
//   - Tenant A cannot access Tenant B's jobs, entities, api-keys, or exports.
//   - Every isolation assertion uses the canonical ErrorCode enum values.
//
// Mirrors tests/contract/vitest.config.ts alias shape so workspace imports
// resolve identically. Adds @spatula/queue alias for channelForJob / event
// type imports used in SSE isolation assertions.
export default defineConfig({
  resolve: {
    alias: {
      '@spatula/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@spatula/core': resolve(root, 'packages/core/src/index.ts'),
      '@spatula/core-types': resolve(root, 'packages/core-types/src/index.ts'),
      '@spatula/db': resolve(root, 'packages/db/src/index.ts'),
      '@spatula/queue': resolve(root, 'packages/queue/src/index.ts'),
      '@spatula/client': resolve(root, 'packages/client/src/index.ts'),
    },
  },
  test: {
    include: ['tests/isolation/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
