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

  it('excludes Release Please changelogs from formatting', () => {
    const prettierIgnore = readFileSync(join(root, '.prettierignore'), 'utf8');

    expect(prettierIgnore).toMatch(/^\*\*\/CHANGELOG\.md$/m);
  });

  it('starts lockstep publication from the root release-please tag', () => {
    const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain("- 'spatula-v*'");
    expect(workflow).toContain('${GITHUB_REF_NAME#spatula-v}');
    expect(workflow).not.toMatch(/^\s*- 'v\*'\s*$/m);
  });

  it('dispatches publication when Release Please creates the root tag', () => {
    const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    const releasePleaseWorkflow = readFileSync(
      join(root, '.github/workflows/release-please.yml'),
      'utf8',
    );

    expect(releaseWorkflow).toMatch(/^\s{2}workflow_dispatch:\s*$/m);
    expect(releasePleaseWorkflow).toMatch(/^\s{2}actions: write\s*$/m);
    expect(releasePleaseWorkflow).toContain('id: release');
    expect(releasePleaseWorkflow).toContain("steps.release.outputs.release_created == 'true'");
    expect(releasePleaseWorkflow).toContain('RELEASE_TAG: ${{ steps.release.outputs.tag_name }}');
    expect(releasePleaseWorkflow).toContain(
      'gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref "$RELEASE_TAG"',
    );
  });
});
