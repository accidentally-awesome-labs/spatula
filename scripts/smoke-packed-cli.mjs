#!/usr/bin/env node
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
const workDir = mkdtempSync(join(tmpdir(), 'spatula-package-smoke-'));
process.once('exit', () => rmSync(workDir, { recursive: true, force: true }));
const packDir = join(workDir, 'packs');
const installDir = join(workDir, 'install');
const projectDir = join(workDir, 'project');
const expectedVersion = JSON.parse(
  readFileSync(join(repoRoot, 'apps/cli/package.json'), 'utf-8'),
).version;
mkdirSync(packDir, { recursive: true });
mkdirSync(installDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
writeFileSync(
  join(installDir, 'package.json'),
  JSON.stringify({
    private: true,
    allowScripts: {
      'better-sqlite3': true,
      protobufjs: false,
    },
  }),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf-8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result;
}

const closure = [
  '@accidentally-awesome-labs/spatula-core-types',
  '@accidentally-awesome-labs/spatula-shared',
  '@accidentally-awesome-labs/spatula-core',
  '@accidentally-awesome-labs/spatula-db',
  '@accidentally-awesome-labs/spatula',
];

for (const name of closure) {
  run('corepack', ['pnpm', '--filter', name, 'pack', '--pack-destination', packDir], {
    capture: true,
  });
}

const tarballs = readdirSync(packDir)
  .filter((name) => name.endsWith('.tgz'))
  .map((name) => join(packDir, name));
if (tarballs.length !== closure.length) {
  throw new Error(`Expected ${closure.length} tarballs, found ${tarballs.length}.`);
}

const installStarted = Date.now();
run('npm', ['install', '--prefix', installDir, '--no-audit', '--no-fund', ...tarballs]);
const installSeconds = (Date.now() - installStarted) / 1000;

const bin = join(installDir, 'node_modules', '.bin', 'spatula');
const version = run(bin, ['--version'], { capture: true }).stdout.trim();
if (version !== expectedVersion) {
  throw new Error(`Expected CLI ${expectedVersion}, received ${version}.`);
}
run(bin, ['--help'], { capture: true });
run(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    "import { createProjectDb, initializeProjectDb } from '@accidentally-awesome-labs/spatula-db'; const opened = createProjectDb(process.argv[1]); initializeProjectDb(opened.db, { projectId: 'package-smoke', name: 'Package smoke' }); opened.close();",
    join(workDir, 'native-smoke.db'),
  ],
  { cwd: installDir, capture: true },
);
run(bin, ['init', 'https://example.com'], {
  cwd: projectDir,
  capture: true,
  env: { ...process.env, SPATULA_HOME: join(workDir, 'home') },
});

function directoryBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

const installedMiB = directoryBytes(join(installDir, 'node_modules')) / 1024 / 1024;
const maxSeconds = Number(process.env.SPATULA_INSTALL_BUDGET_SECONDS ?? 180);
const maxMiB = Number(process.env.SPATULA_INSTALL_BUDGET_MIB ?? 500);
console.log(
  `Packed CLI smoke passed: ${installSeconds.toFixed(1)}s, ${installedMiB.toFixed(1)} MiB.`,
);
if (installSeconds > maxSeconds) {
  throw new Error(`Install time ${installSeconds.toFixed(1)}s exceeds ${maxSeconds}s budget.`);
}
if (installedMiB > maxMiB) {
  throw new Error(`Installed size ${installedMiB.toFixed(1)} MiB exceeds ${maxMiB} MiB budget.`);
}
