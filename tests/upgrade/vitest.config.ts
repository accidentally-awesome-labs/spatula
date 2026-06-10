import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/upgrade/**/*.test.ts'],
    globals: false,
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@spatula/db': resolve(root, 'packages/db/src/index.ts'),
      '@spatula/core': resolve(root, 'packages/core/src/index.ts'),
      '@spatula/queue': resolve(root, 'packages/queue/src/index.ts'),
      '@spatula/shared': resolve(root, 'packages/shared/src/index.ts'),
    },
  },
});
