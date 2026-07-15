import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const PUBLIC_DOC_INPUTS = [
  'README.md',
  '.github',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'package.json',
  'docs',
  'deploy',
  'examples',
  'apps/api/README.md',
  'apps/cli/README.md',
  'packages/client/README.md',
  'packages/core/README.md',
  'packages/core-types/README.md',
  'packages/db/README.md',
  'packages/queue/README.md',
  'packages/shared/README.md',
  'tests/contract/README.md',
  'tests/e2e/browser/README.md',
  'tests/e2e/m2m/README.md',
];

const SKIP_DIRS = new Set(['.git', 'node_modules']);

const TEXT_EXTENSIONS = new Set(['.md', '.json', '.yml', '.yaml']);

const STALE_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /github\.com\/spatulaai\/spatula/i,
    message: 'use the public accidentally-awesome-labs/spatula repo URL',
  },
  {
    pattern: /salar\.sayyad@gmail\.com/i,
    message: 'do not publish personal email addresses in public-facing repo docs',
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
    pattern: /pnpm --filter @spatula\/db(?:\s+run)?\s+migrate\b/i,
    message: 'the db package migration script is `db:migrate`',
  },
  {
    pattern: /\bnpx\s+(?:playwright|tsx)\b/i,
    message: 'repo-local docs should use `pnpm exec`, not `npx`',
  },
  {
    pattern: /\bpnpm\s+dlx\s+tsx\b/i,
    message: 'repo-local docs should use `pnpm exec tsx`, not `pnpm dlx tsx`',
  },
  {
    pattern: /\bpnpm\s+9(?:\.\d+)?\+?/i,
    message: 'the repo requires pnpm 11.13.x',
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
  {
    pattern: /cla-assistant\.io/i,
    message: 'do not promise a specific external CLA bot unless it is repo-visible/enforced',
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
  for (const match of source.matchAll(/^  \.command\(\s*['`]([^'`\s]+)/gm)) {
    commands.add(match[1]);
  }
  return commands;
}

function registeredAdminTenantActions(): Set<string> {
  const source = readFileSync(join(root, 'apps/cli/src/index.tsx'), 'utf8');
  const commandStart = source.indexOf("'tenant <action>'");
  const choicesStart = source.indexOf('choices:', commandStart);
  const choicesEnd = source.indexOf('] as const', choicesStart);

  if (commandStart === -1 || choicesStart === -1 || choicesEnd === -1) {
    return new Set();
  }

  const choicesSource = source.slice(choicesStart, choicesEnd);
  return new Set([...choicesSource.matchAll(/['`]([a-z-]+)['`]/g)].map((match) => match[1]));
}

function normalizedCliInvocation(raw: string): string | null {
  const invocation = raw
    .trim()
    .replace(/\s+#.*$/, '')
    .replace(/[.,;:]$/, '');
  return invocation.startsWith('spatula ') ? invocation : null;
}

function documentedCliInvocations(): Array<{ rel: string; invocation: string }> {
  const invocations: Array<{ rel: string; invocation: string }> = [];

  for (const file of publicTextFiles()) {
    const rel = relative(root, file);
    const text = readFileSync(file, 'utf8');

    for (const match of text.matchAll(/`(spatula\s+[^`\n]+)`/g)) {
      const invocation = normalizedCliInvocation(match[1]);
      if (invocation) invocations.push({ rel, invocation });
    }

    for (const line of text.split('\n')) {
      const invocation = normalizedCliInvocation(line);
      if (invocation) invocations.push({ rel, invocation });
    }
  }

  return invocations;
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

  it('routes security reports away from public issue templates', () => {
    const configPath = join(root, '.github/ISSUE_TEMPLATE/config.yml');

    expect(existsSync(configPath)).toBe(true);

    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('blank_issues_enabled: false');
    expect(text).toContain(
      'https://github.com/accidentally-awesome-labs/spatula/security/advisories/new',
    );
  });

  it('only documents implemented top-level CLI commands in public docs', () => {
    const registered = registeredCliCommands();
    const documented = documentedCliInvocations();

    const unknown = documented
      .map(({ rel, invocation }) => {
        const [, command] = invocation.split(/\s+/);
        return { rel, invocation, command };
      })
      .filter(({ command }) => command && !command.startsWith('-') && !registered.has(command))
      .map(({ rel, invocation }) => `${rel}: ${invocation}`);

    expect(unknown).toEqual([]);
  });

  it('only documents implemented admin tenant CLI actions in public docs', () => {
    const registered = registeredAdminTenantActions();
    const documented = documentedCliInvocations();

    const unknown = documented
      .flatMap(({ rel, invocation }) => {
        const [, command, resource, action] = invocation.split(/\s+/);
        if (command !== 'admin' || resource !== 'tenant' || !action || action.startsWith('<')) {
          return [];
        }

        return action.split('/').map((candidate) => ({ rel, invocation, action: candidate }));
      })
      .filter(({ action }) => !registered.has(action))
      .map(({ rel, invocation }) => `${rel}: ${invocation}`);

    expect(unknown).toEqual([]);
  });
});
