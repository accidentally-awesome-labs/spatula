import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function packageManifestPaths(): string[] {
  const manifests = ['package.json'];

  for (const workspaceRoot of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, workspaceRoot), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const manifest = join(workspaceRoot, entry.name, 'package.json');
      if (existsSync(join(root, manifest))) manifests.push(manifest);
    }
  }

  return manifests.sort();
}

describe('package manager metadata guard', () => {
  it('does not keep pnpm-only settings in the root npm config', () => {
    const npmrcPath = join(root, '.npmrc');
    if (!existsSync(npmrcPath)) return;

    const npmrc = readFileSync(npmrcPath, 'utf8');
    expect(npmrc).not.toMatch(/^\s*auto-install-peers\s*=/m);
  });

  it('declares the supported Node runtime in every package manifest', () => {
    const missing = packageManifestPaths().filter((manifest) => {
      const pkg = JSON.parse(readFileSync(join(root, manifest), 'utf8')) as {
        engines?: { node?: string };
      };

      return pkg.engines?.node !== '>=22';
    });

    expect(missing).toEqual([]);
  });

  it('does not copy an absent root npm config into Docker dependency stages', () => {
    const offenders = readdirSync(root)
      .filter((entry) => entry.startsWith('Dockerfile'))
      .filter((entry) => readFileSync(join(root, entry), 'utf8').includes('.npmrc'));

    expect(offenders).toEqual([]);
  });
});
