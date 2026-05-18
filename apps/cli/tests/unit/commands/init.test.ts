import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInitCommand, createProjectYaml, updateGitignore } from '../../../src/commands/init.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'spatula-init-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runInitCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates spatula.yaml with the provided seed URL', async () => {
    const url = 'https://example.com/products';

    await runInitCommand({ url, cwd: tmpDir });

    const yamlPath = join(tmpDir, 'spatula.yaml');
    expect(existsSync(yamlPath)).toBe(true);

    const content = readFileSync(yamlPath, 'utf-8');
    expect(content).toContain(`- ${url}`);
    expect(content).toContain('depth:');
    expect(content).toContain('limit:');
    expect(content).toContain('seeds:');
  });

  it('creates the .spatula/ directory structure', async () => {
    await runInitCommand({ cwd: tmpDir });

    const spatulaDir = join(tmpDir, '.spatula');
    expect(existsSync(spatulaDir)).toBe(true);

    // Standard subdirectories should be present
    for (const subdir of ['pages', 'exports', 'logs']) {
      expect(existsSync(join(spatulaDir, subdir))).toBe(true);
    }
    // Nested subdir
    expect(existsSync(join(spatulaDir, 'cache', 'robots'))).toBe(true);
  });

  it('does not overwrite an existing spatula.yaml', async () => {
    const yamlPath = join(tmpDir, 'spatula.yaml');
    const original = '# existing config\nseeds:\n  - https://original.com\n';
    writeFileSync(yamlPath, original, 'utf-8');

    const result = await runInitCommand({ url: 'https://new-url.com', cwd: tmpDir });

    expect(result.createdYaml).toBe(false);
    // File content must be unchanged
    expect(readFileSync(yamlPath, 'utf-8')).toBe(original);
  });

  it('appends .spatula/ to .gitignore when .gitignore exists', async () => {
    const gitignorePath = join(tmpDir, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules/\ndist/\n', 'utf-8');

    const result = await runInitCommand({ cwd: tmpDir });

    expect(result.gitignoreUpdated).toBe(true);
    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('.spatula/');
  });

  it('skips .gitignore update if .spatula/ is already listed', async () => {
    const gitignorePath = join(tmpDir, '.gitignore');
    const original = 'node_modules/\n.spatula/\ndist/\n';
    writeFileSync(gitignorePath, original, 'utf-8');

    const result = await runInitCommand({ cwd: tmpDir });

    expect(result.gitignoreUpdated).toBe(false);
    // File content must be unchanged
    expect(readFileSync(gitignorePath, 'utf-8')).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for individual helpers
// ---------------------------------------------------------------------------

describe('createProjectYaml', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when it creates the file', () => {
    const result = createProjectYaml(tmpDir, { url: 'https://a.com', depth: 2, limit: 500 });
    expect(result).toBe(true);
    expect(existsSync(join(tmpDir, 'spatula.yaml'))).toBe(true);
  });

  it('returns false when the file already exists', () => {
    writeFileSync(join(tmpDir, 'spatula.yaml'), 'existing', 'utf-8');
    const result = createProjectYaml(tmpDir, { url: 'https://a.com', depth: 2, limit: 500 });
    expect(result).toBe(false);
  });

  it('uses a placeholder URL when none is provided', () => {
    createProjectYaml(tmpDir, { depth: 3, limit: 200 });
    const content = readFileSync(join(tmpDir, 'spatula.yaml'), 'utf-8');
    expect(content).toContain('example.com');
  });
});

describe('updateGitignore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when .gitignore does not exist', () => {
    const result = updateGitignore(tmpDir);
    expect(result).toBe(false);
  });

  it('handles a .gitignore that already contains ".spatula" (without trailing slash)', () => {
    const gitignorePath = join(tmpDir, '.gitignore');
    writeFileSync(gitignorePath, '.spatula\n', 'utf-8');
    const result = updateGitignore(tmpDir);
    expect(result).toBe(false);
  });
});
