import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // The files share one test database.
    fileParallelism: false,
  },
});
