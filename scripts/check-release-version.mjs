#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const repoRoot = resolve(import.meta.dirname, '..');
const expected = (process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '').replace(
  /^(?:spatula-)?v/,
  '',
);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error('Usage: node scripts/check-release-version.mjs <version, vtag, or spatula-vtag>');
  process.exit(1);
}

const manifests = new Map([
  ['package.json', 'spatula'],
  ['packages/core-types/package.json', '@accidentally-awesome-labs/spatula-core-types'],
  ['packages/client/package.json', '@accidentally-awesome-labs/spatula-client'],
  ['packages/shared/package.json', '@accidentally-awesome-labs/spatula-shared'],
  ['packages/core/package.json', '@accidentally-awesome-labs/spatula-core'],
  ['packages/db/package.json', '@accidentally-awesome-labs/spatula-db'],
  ['packages/queue/package.json', '@accidentally-awesome-labs/spatula-queue'],
  ['apps/api/package.json', '@accidentally-awesome-labs/spatula-api'],
  ['apps/cli/package.json', '@accidentally-awesome-labs/spatula'],
]);

let failed = false;
for (const [manifest, expectedName] of manifests) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, manifest), 'utf-8'));
  if (pkg.name !== expectedName) {
    console.error(`${manifest}: expected package name ${expectedName}, found ${String(pkg.name)}`);
    failed = true;
  }
  if (pkg.version !== expected) {
    console.error(`${manifest}: expected ${expected}, found ${String(pkg.version)}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`All workspace packages match release ${expected}.`);
