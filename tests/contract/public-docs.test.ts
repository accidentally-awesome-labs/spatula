import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const PUBLIC_DOC_INPUTS = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'package.json',
  'docs',
  'examples',
  'apps/api/README.md',
  'apps/cli/README.md',
  'packages/client/README.md',
  'packages/core/README.md',
  'packages/core-types/README.md',
  'packages/db/README.md',
  'packages/queue/README.md',
  'packages/shared/README.md',
];

const SKIP_DIRS = new Set(['.git', 'node_modules']);

const TEXT_EXTENSIONS = new Set(['.md', '.json']);

const STALE_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /github\.com\/spatulaai\/spatula/i,
    message: 'use the public accidentally-awesome-labs/spatula repo URL',
  },
  {
    pattern: /https:\/\/api\.spatula\.dev/i,
    message: 'do not imply an official hosted API exists; use localhost/self-hosted examples',
  },
  {
    pattern: /spatula setup --skip/i,
    message: '`spatula setup --skip` is not implemented',
  },
  {
    pattern: /spatula jobs:/i,
    message: '`spatula jobs:*` commands are not implemented',
  },
  {
    pattern: /pnpm --filter @spatula\/db migrate\b/i,
    message: 'the db package migration script is `db:migrate`',
  },
  {
    pattern: /multi-tenant SaaS API/i,
    message: 'current OSS docs should describe the self-hosted API, not an active SaaS',
  },
  {
    pattern: /official deployment infrastructure/i,
    message: 'there is no active official deployment in the OSS repo scope',
  },
  {
    pattern: /all with field-level provenance/i,
    message: 'only JSON exports currently include optional provenance',
  },
  {
    pattern: /spatula-saas/i,
    message: 'do not reference private downstream repositories in public docs',
  },
  {
    pattern: /docs\/private-contract\.md/i,
    message: 'private-contract documentation is not part of the public OSS surface',
  },
  {
    pattern: /tests\/private-contract/i,
    message: 'private-contract tests are not part of the public OSS surface',
  },
  {
    pattern: /docs\/superpowers/i,
    message: 'internal planning archives are not part of the public OSS docs',
  },
  {
    pattern: /docs\/plans/i,
    message: 'internal planning archives are not part of the public OSS docs',
  },
  {
    pattern: /\.planning/i,
    message: 'local agent planning files are not part of the public OSS docs',
  },
  {
    pattern: /\bPhase\s+\d+/i,
    message: 'public docs should use durable release/product language, not internal phase labels',
  },
  {
    pattern: /\bWave\s+\d+/i,
    message: 'public docs should use durable release/product language, not internal wave labels',
  },
];

const FORBIDDEN_PUBLIC_PATHS = [
  'docs/private-contract.md',
  'docs/legal/uspto-tess-search.md',
  'docs/plans',
  'docs/superpowers',
  'tests/private-contract',
];

function isSkipped(path: string): boolean {
  const rel = relative(root, path);
  return [...SKIP_DIRS].some((skip) => rel === skip || rel.startsWith(`${skip}/`));
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

  const ext = path.slice(path.lastIndexOf('.'));
  if (TEXT_EXTENSIONS.has(ext)) out.push(path);
}

function publicTextFiles(): string[] {
  const files: string[] = [];
  for (const input of PUBLIC_DOC_INPUTS) {
    walk(join(root, input), files);
  }
  return [...new Set(files)].sort();
}

function registeredCliCommands(): Set<string> {
  const source = readFileSync(join(root, 'apps/cli/src/index.tsx'), 'utf8');
  const commands = new Set<string>();
  for (const match of source.matchAll(/\.command\(\s*['`]([^'`\s]+)/g)) {
    commands.add(match[1]);
  }
  return commands;
}

describe('public documentation guard', () => {
  it('does not include internal planning, private-contract, or legal research artifacts', () => {
    const present = FORBIDDEN_PUBLIC_PATHS.filter((path) => existsSync(join(root, path)));

    expect(present).toEqual([]);
  });

  it('does not contain stale hosted-service, repo, or unsupported CLI references', () => {
    const failures: string[] = [];

    for (const file of publicTextFiles()) {
      const rel = relative(root, file);
      const text = readFileSync(file, 'utf8');
      for (const { pattern, message } of STALE_PATTERNS) {
        if (pattern.test(text)) {
          failures.push(`${rel}: ${message}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('documents root package repository metadata for the actual public repo', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      repository?: { url?: string };
      homepage?: string;
      bugs?: { url?: string };
    };

    expect(pkg.repository?.url).toBe('https://github.com/accidentally-awesome-labs/spatula.git');
    expect(pkg.homepage).toBe('https://github.com/accidentally-awesome-labs/spatula#readme');
    expect(pkg.bugs?.url).toBe('https://github.com/accidentally-awesome-labs/spatula/issues');
  });

  it('only lists implemented top-level CLI commands in the README command table', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const registered = registeredCliCommands();
    const documented = [...readme.matchAll(/`spatula ([a-z][a-z-]*)(?:\s|`)/g)].map((m) => m[1]);

    const unknown = documented.filter((cmd) => !registered.has(cmd));
    expect(unknown).toEqual([]);
  });
});
