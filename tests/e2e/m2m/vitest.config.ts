import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');

/**
 * M2M OIDC client_credentials e2e suite.
 *
 * What this suite proves:
 *   - Dex issues a JWT for the spatula-m2m client via client_credentials grant.
 *   - The JWT carries the expected sub (encodes spatula-m2m) and aud claims.
 *   - A JwtAuthProvider-wired API server accepts the JWT and auto-provisions a
 *     tenant for the M2M sub on first use.
 *   - createJob → listJobs → getEntities via @spatula/client all succeed end-to-end.
 *
 * Prerequisites (must be running before this suite executes):
 *   - Dex: cd examples/auth-dex && docker compose up -d
 *   - Postgres: TEST_DATABASE_URL or DATABASE_URL
 *   - Redis: REDIS_URL or redis://localhost:6379
 *
 * This is an e2e suite — it runs in the "e2e" CI lane (main/tags), NOT on every PR.
 * See tests/e2e/m2m/README.md for full run instructions.
 *
 * Alias shape mirrors tests/contract/vitest.config.ts for consistent workspace resolution.
 */
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
    include: ['tests/e2e/m2m/**/*.spec.ts'],
    environment: 'node',
    // Generous timeouts: Docker start + JWKS fetch + DB provisioning
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
