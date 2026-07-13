#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCache = resolve(tmpdir(), 'spatula-npm-cache');
mkdirSync(npmCache, { recursive: true });

const workspaceRoots = ['apps', 'packages'];

const disallowed = [
  ['source directory', (path) => path === 'src' || path.startsWith('src/')],
  ['test directory', (path) => path === 'test' || path.startsWith('test/')],
  ['tests directory', (path) => path === 'tests' || path.startsWith('tests/')],
  ['__tests__ directory', (path) => path.includes('/__tests__/') || path.startsWith('__tests__/')],
  ['turbo cache', (path) => path === '.turbo' || path.startsWith('.turbo/')],
  ['coverage output', (path) => path === 'coverage' || path.startsWith('coverage/')],
  ['node_modules', (path) => path === 'node_modules' || path.startsWith('node_modules/')],
  ['environment file', (path) => path === '.env' || path.startsWith('.env.')],
  ['TypeScript build info', (path) => path.endsWith('.tsbuildinfo')],
  ['test artifact', (path) => /\.(test|spec)\./.test(path)],
  ['dev config', (path) => /^(vitest|eslint|tsup|drizzle\.config)\..+/.test(path)],
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packageDirs() {
  return workspaceRoots.flatMap((root) => {
    const absoluteRoot = resolve(repoRoot, root);
    if (!existsSync(absoluteRoot)) {
      return [];
    }

    return readdirSync(absoluteRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(absoluteRoot, entry.name))
      .filter((dir) => existsSync(resolve(dir, 'package.json')));
  });
}

function collectExportTargets(value, targets = []) {
  if (typeof value === 'string') {
    targets.push(value);
    return targets;
  }

  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectExportTargets(nested, targets);
    }
  }

  return targets;
}

function toPackagePath(target) {
  if (typeof target !== 'string' || !target.startsWith('./')) {
    return null;
  }
  return target.slice(2).replaceAll('\\', '/');
}

function requiredTargets(pkg) {
  const targets = [pkg.main, pkg.module, pkg.types];

  if (pkg.bin && typeof pkg.bin === 'object') {
    targets.push(...Object.values(pkg.bin));
  }

  if (pkg.exports) {
    targets.push(...collectExportTargets(pkg.exports));
  }

  return [...new Set(targets.map(toPackagePath).filter(Boolean))];
}

function runPack(dir) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
  });

  if (result.status !== 0) {
    throw new Error(`${result.stderr}${result.stdout}`.trim());
  }

  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`Unexpected npm pack JSON output: ${result.stdout}`);
  }

  return parsed[0];
}

let failures = 0;

for (const dir of packageDirs()) {
  const pkgPath = resolve(dir, 'package.json');
  const pkg = readJson(pkgPath);

  if (pkg.private || !pkg.name?.startsWith('@spatula/')) {
    continue;
  }

  const errors = [];

  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    errors.push('package.json must define a non-empty files allowlist');
  }

  let pack;
  try {
    pack = runPack(dir);
  } catch (error) {
    console.error(`${pkg.name}: npm pack failed`);
    console.error(error instanceof Error ? error.message : error);
    failures += 1;
    continue;
  }

  const paths = new Set(pack.files.map((file) => file.path));

  for (const file of pack.files) {
    const match = disallowed.find(([, isDisallowed]) => isDisallowed(file.path));
    if (match) {
      errors.push(`${match[0]} included: ${file.path}`);
    }
  }

  for (const target of requiredTargets(pkg)) {
    if (!paths.has(target)) {
      errors.push(`declared package entrypoint missing from tarball: ${target}`);
    }
  }

  for (const requiredFile of ['package.json', 'README.md']) {
    if (!paths.has(requiredFile)) {
      errors.push(`required package file missing from tarball: ${requiredFile}`);
    }
  }

  if (pkg.name === '@spatula/db') {
    for (const migrationDir of ['drizzle/', 'drizzle-sqlite/']) {
      if (![...paths].some((path) => path.startsWith(migrationDir))) {
        errors.push(`database migration assets missing from tarball: ${migrationDir}`);
      }
    }
  }

  if (errors.length > 0) {
    failures += 1;
    console.error(`${pkg.name}: package content audit failed`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    continue;
  }

  console.log(`${pkg.name}: ${pack.entryCount} files, ${pack.unpackedSize} bytes`);
}

if (failures > 0) {
  process.exit(1);
}
