/**
 * Esbuild configuration consumed by size-limit's @size-limit/esbuild adapter
 * (referenced via the `config` field in package.json's `size-limit` array).
 *
 * Locks the measurement to ESM + browser + es2022 + minify + tree-shake,
 * mirroring spec §3.2.1's wording verbatim:
 *   "esbuild --bundle --minify --format=esm --platform=browser"
 *
 * Plan 16-2 / 16-RESEARCH Pattern 4: do NOT omit this — preset defaults vary
 * across size-limit versions and the explicit form makes the measurement
 * reproducible.
 */
export default {
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  bundle: true,
  minify: true,
  treeShaking: true,
};
