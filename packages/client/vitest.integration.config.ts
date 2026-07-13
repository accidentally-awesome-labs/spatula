import { defineConfig } from 'vitest/config';

/**
 * Integration-mode vitest config for @spatula/client.
 *
 * Default (no env): tests run with mocked fetch — no live server required.
 * Live mode (SPATULA_LIVE_LLM=1): tests against a real running Spatula API
 *   server. Set SPATULA_BASE_URL + SPATULA_API_KEY to point at the server.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // Long timeout to accommodate live LLM round-trips.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    passWithNoTests: true,
    // Each integration test boots its own server harness — keep serial to
    // avoid port-allocation races + Postgres-fixture interleaving.
    sequence: { concurrent: false },
    // Default test:ci does NOT run integration tests; this config is invoked
    // only via `pnpm --filter @spatula/client test:integration`.
  },
});
