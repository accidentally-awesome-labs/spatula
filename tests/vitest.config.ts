import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.test.ts'],
    globals: false,
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@spatula/db': resolve(__dirname, '../packages/db/src/index.ts'),
      '@spatula/core': resolve(__dirname, '../packages/core/src/index.ts'),
      '@spatula/queue': resolve(__dirname, '../packages/queue/src/index.ts'),
      '@spatula/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
    },
  },
});
