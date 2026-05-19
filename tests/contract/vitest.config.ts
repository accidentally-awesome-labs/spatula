import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

// Public REST contract test suite — Phase 16 plan 16-4.
//
// What this suite proves:
//   - Every (route, status, example) tuple in the served /api/v1/openapi.json
//     validates against its own schema via Ajv2020 (D-14 drift detection).
//   - Every 4xx/5xx response from the OSS API matches the v1 error envelope.
//   - Every auth'd success carries the 4 rate-limit headers; 429 carries
//     Retry-After.
//   - Offset routes emit Deprecation + Sunset + Link; cursor routes don't.
//   - All timestamps parse as ISO 8601 UTC.
//   - Every public route is under /api/v1/ (or the well-known sibling).
//   - client.experimental.* throws on access (zero v1.0 experimental surfaces).
//
// Boots a real apps/api server (Node-builtin http.Server adapter — see
// tests/carveout/fixtures/server.ts for the carry-forward pattern; same shape
// avoids adding @hono/node-server to the workspace root).
//
// Alias shape matches tests/carveout/vitest.config.ts so workspace imports
// resolve identically.
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
    include: ['tests/contract/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
