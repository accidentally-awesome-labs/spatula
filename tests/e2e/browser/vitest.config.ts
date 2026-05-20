/**
 * Vitest config for the browser OIDC + SSE Playwright e2e suite.
 *
 * This is a HEAVY suite — it requires:
 *   - Docker + docker-compose (for Dex IDP)
 *   - Playwright Chromium binaries (`playwright install chromium`)
 *   - A live PostgreSQL instance (TEST_DATABASE_URL or default)
 *   - A live Redis instance (REDIS_URL or default localhost:6379)
 *
 * It is NOT run in normal CI (not included in the default tests/e2e/vitest.config.ts
 * glob). It runs in the dedicated `test-e2e-browser` CI job on main branch and tags.
 *
 * Run manually:
 *   pnpm exec vitest run --config tests/e2e/browser/vitest.config.ts
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');

export default defineConfig({
  resolve: {
    alias: {
      '@spatula/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@spatula/core': resolve(root, 'packages/core/src/index.ts'),
      '@spatula/db': resolve(root, 'packages/db/src/index.ts'),
      '@spatula/queue': resolve(root, 'packages/queue/src/index.ts'),
      '@spatula/client': resolve(root, 'packages/client/src/index.ts'),
    },
  },
  test: {
    // Generous timeouts — Docker boot + Playwright browser + API server spin-up
    // can take 60+ seconds in a cold environment.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    include: ['tests/e2e/browser/**/*.spec.ts'],
    // Run serially — the suite boots real infrastructure (Dex, API server,
    // Postgres, Redis). Parallelism would cause port conflicts.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
