import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration tests live under tests/integration/ and have their own
    // vitest config (vitest.integration.config.ts). The default `pnpm test`
    // run excludes them so contributor-fork CI passes without
    // SPATULA_LIVE_LLM=1 + OPENROUTER_API_KEY in the env. Live mode runs
    // only via `pnpm test:integration` or an explicit live-LLM workflow.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
  },
});
