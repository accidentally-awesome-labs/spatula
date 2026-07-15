import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const RUNTIME_SOURCE_INPUTS = ['apps/api/src', 'apps/cli/src', 'packages'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const SKIP_SEGMENTS = new Set([
  '__fixtures__',
  '__mocks__',
  '__snapshots__',
  'dist',
  'node_modules',
]);

const SKIP_FILE_PATTERNS = [/\.test\.[cm]?[jt]sx?$/i, /\.spec\.[cm]?[jt]sx?$/i, /\.d\.ts$/i];

const STALE_RUNTIME_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /https?:\/\/(?:[a-z0-9-]+\.)?spatula\.dev/i,
    message: 'do not imply an official hosted Spatula domain exists',
  },
  {
    pattern: /spatula\.dev\/docs/i,
    message: 'link runtime users to checked-in docs or the public GitHub repo',
  },
  {
    pattern: /available in a future release|coming in a future release/i,
    message: 'runtime copy should describe the current command surface',
  },
  {
    pattern: /spatula remote jobs/i,
    message: '`spatula remote jobs` is not implemented',
  },
  {
    pattern: /multi-tenant SaaS API|official deployment infrastructure/i,
    message: 'runtime copy should describe self-hosted OSS infrastructure',
  },
];

function isSkipped(path: string): boolean {
  const rel = relative(root, path);
  const segments = rel.split(/[\\/]/);

  if (segments.some((segment) => SKIP_SEGMENTS.has(segment))) return true;
  return SKIP_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

function hasSourceExtension(path: string): boolean {
  const basename = path.split(/[\\/]/).at(-1) ?? path;
  const extStart = basename.lastIndexOf('.');
  if (extStart === -1) return false;

  return SOURCE_EXTENSIONS.has(basename.slice(extStart));
}

function walk(path: string, out: string[]): void {
  if (!existsSync(path) || isSkipped(path)) return;

  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walk(join(path, entry), out);
    }
    return;
  }

  if (hasSourceExtension(path)) out.push(path);
}

function runtimeSourceFiles(): string[] {
  const files: string[] = [];
  for (const input of RUNTIME_SOURCE_INPUTS) {
    walk(join(root, input), files);
  }

  return [...new Set(files)].sort();
}

describe('runtime copy guard', () => {
  it('does not include stale hosted-service or future-release wording in non-test source', () => {
    const failures: string[] = [];

    for (const file of runtimeSourceFiles()) {
      const rel = relative(root, file);
      const text = readFileSync(file, 'utf8');

      for (const { pattern, message } of STALE_RUNTIME_PATTERNS) {
        if (pattern.test(text)) {
          failures.push(`${rel}: ${message}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
