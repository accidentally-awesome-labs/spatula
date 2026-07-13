#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const turboBin = resolve(repoRoot, 'node_modules/turbo/bin/turbo');
const env = { ...process.env };

// Corepack pnpm can leak version-manager state into Turbo child package tasks.
// Turbo may then spawn a different global pnpm that rejects the pinned version.
delete env.COREPACK_ROOT;
delete env.npm_config_user_agent;
delete env.npm_command;
env.npm_config_manage_package_manager_versions = 'false';

const pnpmExecPath = process.env.npm_execpath;
if (pnpmExecPath?.includes('pnpm') && existsSync(pnpmExecPath)) {
  const shimDir = mkdtempSync(join(tmpdir(), 'spatula-pnpm-'));
  const shimPath = join(shimDir, 'pnpm');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

  writeFileSync(
    shimPath,
    `#!/bin/sh\nexport npm_config_manage_package_manager_versions=false\nexec ${quote(
      process.execPath,
    )} ${quote(pnpmExecPath)} "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
  env.PATH = `${shimDir}${delimiter}${env.PATH ?? ''}`;
}

const child = spawn(process.execPath, [turboBin, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
