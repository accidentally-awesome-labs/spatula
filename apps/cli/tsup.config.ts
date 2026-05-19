import { defineConfig } from 'tsup';

/**
 * Build config for @spatula/cli — produces a dual ESM + CJS publish artifact
 * with TypeScript declarations.
 *
 * Spec: docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md §3.2.3
 * Plan: .planning/phases/16-api-contract-sdk-packages/16-5-PLAN.md Task 6
 *
 * Externalized: `playwright` (massive native dep — should resolve at install
 * time, not be bundled) + the workspace `@spatula/*` packages (consumer's
 * node_modules will host them via pnpm publish + dependency tree).
 */
export default defineConfig({
  entry: {
    index: 'src/index.tsx',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  splitting: false,
  treeshake: true,
  shims: true,
  // Externals: tsup will leave these as runtime `import`/`require()` calls.
  // Consumers install them via the published package's `dependencies` field.
  external: [
    'playwright',
    '@spatula/core',
    '@spatula/db',
    '@spatula/shared',
    // Heavy React + Ink runtime — Ink + React are runtime deps; tree-shake
    // them out of the bundle, let the consumer's node_modules host them.
    'react',
    'ink',
    'ink-spinner',
    'ink-text-input',
    'ink-testing-library',
    'node-notifier',
    'yargs',
    'zod',
    'zustand',
    'yaml',
  ],
  // Shebang is already present at the top of src/index.tsx — tsup preserves
  // it for both ESM and CJS outputs. Do not add a `banner` here or it will
  // produce a doubled #!/usr/bin/env node line.
});
