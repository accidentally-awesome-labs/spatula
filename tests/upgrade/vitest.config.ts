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
      '@accidentally-awesome-labs/spatula-db': resolve(root, 'packages/db/src/index.ts'),
      '@accidentally-awesome-labs/spatula-core': resolve(root, 'packages/core/src/index.ts'),
      '@accidentally-awesome-labs/spatula-queue': resolve(root, 'packages/queue/src/index.ts'),
      '@accidentally-awesome-labs/spatula-shared': resolve(root, 'packages/shared/src/index.ts'),
    },
  },
});
