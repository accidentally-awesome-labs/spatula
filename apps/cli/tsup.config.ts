import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

/**
 * Build config for @accidentally-awesome-labs/spatula — produces a dual ESM + CJS publish artifact
 * with TypeScript declarations.
 * Externalized: `playwright` (massive native dep — should resolve at install
 * time, not be bundled) + the workspace `@accidentally-awesome-labs/spatula-*` packages (consumer's
 * node_modules will host them via pnpm publish + dependency tree).
 */
export default defineConfig({
  entry: {
    index: 'src/index.tsx',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  target: 'node22',
  splitting: false,
  treeshake: true,
  shims: true,
  define: {
    __SPATULA_VERSION__: JSON.stringify(packageJson.version),
  },
  // Externals: tsup will leave these as runtime `import`/`require()` calls.
  // Consumers install them via the published package's `dependencies` field.
  external: [
    'playwright',
    '@accidentally-awesome-labs/spatula-core',
    '@accidentally-awesome-labs/spatula-db',
    '@accidentally-awesome-labs/spatula-shared',
    // Heavy React + Ink runtime — Ink + React are runtime deps; tree-shake
    // them out of the bundle, let the consumer's node_modules host them.
    'react',
    'ink',
    'ink-spinner',
    'ink-text-input',
    'ink-testing-library',
    'yargs',
    'zod',
    'zustand',
    'yaml',
  ],
  // Shebang is already present at the top of src/index.tsx — tsup preserves
  // it for both ESM and CJS outputs. Do not add a `banner` here or it will
  // produce a doubled #!/usr/bin/env node line.
});
