import { defineConfig } from 'vitest/config';

// The Node tests: the pipeline against a real Postgres, and the adapters with stub fetches.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['test/node/global-setup.ts'],
    fileParallelism: false,
  },
});
