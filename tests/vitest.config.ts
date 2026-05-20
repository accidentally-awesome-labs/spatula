import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts', 'tests/shared/**/*.test.ts'],
    globals: false,
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@spatula/db': resolve(root, 'packages/db/src/index.ts'),
      '@spatula/core': resolve(root, 'packages/core/src/index.ts'),
      '@spatula/queue': resolve(root, 'packages/queue/src/index.ts'),
      '@spatula/shared': resolve(root, 'packages/shared/src/index.ts'),
      // pino is a dep of @spatula/shared; alias it to the shared package's copy
      // so tests/shared/ tests can import pino directly for sink testing
      pino: resolve(root, 'packages/shared/node_modules/pino/pino.js'),
    },
  },
});
