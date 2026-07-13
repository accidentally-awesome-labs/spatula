#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const turboBin = resolve(repoRoot, 'node_modules/turbo/bin/turbo');
const env = { ...process.env };

// Corepack pnpm can leak version-manager state into Turbo child package tasks.
// Turbo may then spawn a different global pnpm that rejects the pinned version.
delete env.COREPACK_ROOT;
delete env.npm_config_user_agent;
delete env.npm_command;

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
