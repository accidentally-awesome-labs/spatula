/**
 * CLI binary invocation tests.
 *
 * These tests spawn the actual `spatula` CLI as a subprocess via tsx and verify
 * exit codes, stdout, and stderr. They confirm that yargs command routing, flag
 * validation, help text, and error UX all behave correctly.
 *
 * Note: Each subprocess invocation compiles TypeScript via tsx, so these tests
 * are intentionally slow (~5-10s per invocation). The per-test timeout is set
 * high to accommodate this.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLI_ROOT = join(__dirname, '..', '..');
const TSX = join(CLI_ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = join(CLI_ROOT, 'src', 'index.tsx');

/**
 * Subprocess timeout — tsx compiles TypeScript on each invocation.
 * Under high system load this can take 30-60s, so we use a generous limit.
 */
const SUBPROCESS_TIMEOUT = 60_000;

/** Vitest per-test timeout. Must exceed SUBPROCESS_TIMEOUT. */
const TEST_TIMEOUT = 65_000;

function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      [ENTRY, ...args],
      {
        cwd: options.cwd ?? CLI_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, ...options.env, SPATULA_HOME: '/tmp/spatula-test-home' },
        timeout: SUBPROCESS_TIMEOUT,
      },
      (err, stdout, stderr) => {
        if (err) {
          const error = err as {
            code?: number | string | null;
            stdout?: string | Buffer;
            stderr?: string | Buffer;
          };
          resolve({
            stdout: String(error.stdout ?? stdout ?? ''),
            stderr: String(error.stderr ?? stderr ?? ''),
            exitCode: typeof error.code === 'number' ? error.code : 1,
          });
          return;
        }

        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: 0 });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 1. Help and command discovery
// ---------------------------------------------------------------------------

describe('CLI help and discovery', () => {
  it(
    '--help shows all 20 commands',
    async () => {
      const { stdout, exitCode } = await runCli(['--help']);
      expect(exitCode).toBe(0);
      const commands = [
        'init',
        'run',
        'reset',
        'doctor',
        'add',
        'config',
        'setup',
        'estimate',
        'new',
        'list',
        'status',
        'logs',
        'schema',
        'export',
        'explore',
        'review',
        'test',
        'push',
        'remote',
        'pull',
      ];
      for (const cmd of commands) {
        expect(stdout).toContain(cmd);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'shows error for unknown command',
    async () => {
      const { stderr, exitCode } = await runCli(['nonexistent']);
      expect(exitCode).not.toBe(0);
      // yargs outputs "Unknown argument: nonexistent" to stderr
      expect(stderr).toContain('Unknown argument');
    },
    TEST_TIMEOUT,
  );

  it(
    'shows error when no command given',
    async () => {
      const { stderr, exitCode } = await runCli([]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Please specify a command');
    },
    TEST_TIMEOUT,
  );

  it(
    'schema --help shows --versions and --json flags',
    async () => {
      const { stdout, exitCode } = await runCli(['schema', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('--versions');
      expect(stdout).toContain('--json');
    },
    TEST_TIMEOUT,
  );

  it(
    'export --help shows --format with valid choices',
    async () => {
      const { stdout, exitCode } = await runCli(['export', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('--format');
      expect(stdout).toContain('json');
      expect(stdout).toContain('csv');
      expect(stdout).toContain('sqlite');
      expect(stdout).toContain('parquet');
      expect(stdout).toContain('duckdb');
    },
    TEST_TIMEOUT,
  );

  it(
    'logs --help shows --run, --errors, --tail flags',
    async () => {
      const { stdout, exitCode } = await runCli(['logs', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('--run');
      expect(stdout).toContain('--errors');
      expect(stdout).toContain('--tail');
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 2. Error UX — commands that need a project
// ---------------------------------------------------------------------------

describe('error UX for project-dependent commands', () => {
  // Run from /tmp where there is no spatula.yaml
  const noProjectDir = '/tmp';

  it(
    'schema shows clear error outside project',
    async () => {
      const { stderr, stdout, exitCode } = await runCli(['schema'], { cwd: noProjectDir });
      const output = stderr + stdout;
      expect(exitCode).not.toBe(0);
      expect(output).toContain('spatula.yaml');
    },
    TEST_TIMEOUT,
  );

  it(
    'logs shows clear error outside project',
    async () => {
      const { stderr, stdout, exitCode } = await runCli(['logs'], { cwd: noProjectDir });
      const output = stderr + stdout;
      expect(exitCode).not.toBe(0);
      expect(output).toContain('spatula.yaml');
    },
    TEST_TIMEOUT,
  );

  it(
    'export shows clear error outside project',
    async () => {
      const { stderr, stdout, exitCode } = await runCli(['export'], { cwd: noProjectDir });
      const output = stderr + stdout;
      expect(exitCode).not.toBe(0);
      expect(output).toContain('spatula.yaml');
    },
    TEST_TIMEOUT,
  );

  it(
    'status shows clear error outside project',
    async () => {
      const { stderr, stdout, exitCode } = await runCli(['status'], { cwd: noProjectDir });
      const output = stderr + stdout;
      expect(exitCode).not.toBe(0);
      expect(output).toContain('spatula.yaml');
    },
    TEST_TIMEOUT,
  );

  it(
    'estimate shows clear error outside project',
    async () => {
      const { stderr, stdout, exitCode } = await runCli(['estimate'], { cwd: noProjectDir });
      const output = stderr + stdout;
      expect(exitCode).not.toBe(0);
      expect(output).toContain('spatula.yaml');
    },
    TEST_TIMEOUT,
  );

  it(
    'add requires URLs argument',
    async () => {
      const { stderr, exitCode } = await runCli(['add'], { cwd: noProjectDir });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Not enough');
    },
    TEST_TIMEOUT,
  );

  it(
    'test requires URL argument',
    async () => {
      const { stderr, exitCode } = await runCli(['test'], { cwd: noProjectDir });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Not enough');
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 3. Flag validation
// ---------------------------------------------------------------------------

describe('flag validation', () => {
  it(
    'export rejects invalid --format',
    async () => {
      const { stderr, exitCode } = await runCli(['export', '--format', 'xml']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Invalid values');
    },
    TEST_TIMEOUT,
  );

  it(
    'export accepts valid --format choices',
    async () => {
      // This will fail because no project, but it should NOT fail on flag validation
      const { stderr, stdout } = await runCli(['export', '--format', 'csv']);
      const output = stderr + stdout;
      // Should fail because no project, NOT because of invalid flag
      expect(output).not.toContain('Invalid values');
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 4. Commands with real project
// ---------------------------------------------------------------------------

describe('commands with real project', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'spatula-cli-binary-'));
    // Create a minimal project
    writeFileSync(
      join(projectDir, 'spatula.yaml'),
      'name: CLI Binary Test\nseeds:\n  - https://example.com\n',
    );
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it(
    'init in empty dir creates project',
    async () => {
      const initDir = mkdtempSync(join(tmpdir(), 'spatula-init-'));
      try {
        const { stdout, exitCode } = await runCli(['init', 'https://test.com'], { cwd: initDir });
        expect(exitCode).toBe(0);
        expect(stdout).toContain('spatula.yaml');
      } finally {
        rmSync(initDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'doctor runs and completes',
    async () => {
      const { stdout, stderr, exitCode } = await runCli(['doctor'], { cwd: projectDir });
      // Doctor may exit 1 if some checks fail (e.g., Docker not installed),
      // but should still produce output
      const output = stdout + stderr;
      expect(output.length).toBeGreaterThan(0);
      expect(output).toContain('Spatula Doctor');
    },
    TEST_TIMEOUT,
  );

  it(
    'add adds URLs to project',
    async () => {
      const addDir = mkdtempSync(join(tmpdir(), 'spatula-add-'));
      try {
        writeFileSync(
          join(addDir, 'spatula.yaml'),
          'name: test\nseeds:\n  - https://existing.com\n',
        );
        const { stdout, exitCode } = await runCli(['add', 'https://new.com'], { cwd: addDir });
        expect(exitCode).toBe(0);
        expect(stdout).toContain('Added 1');
      } finally {
        rmSync(addDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );
});
