import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runResetCommand } from '../../../src/commands/reset.js';

// Mock @spatula/db so unit tests don't need a real SQLite native module.
// The DB-level selective cleanup is covered by integration tests.
const preparedSql: string[] = [];
vi.mock('@spatula/db', () => {
  return {
    createProjectDb: vi.fn(() => ({
      sqlite: {
        prepare: vi.fn((sql: string) => {
          preparedSql.push(sql);
          return { run: vi.fn() };
        }),
        close: vi.fn(),
      },
      close: vi.fn(),
    })),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'spatula-reset-test-'));
}

/**
 * Scaffold a minimal project inside `dir`:
 *   - spatula.yaml          (so findProjectRoot succeeds)
 *   - .spatula/pages/       (standard subdir)
 *   - .spatula/exports/     (standard subdir)
 *   - .spatula/logs/        (standard subdir)
 *   - .spatula/cache/robots (nested standard subdir)
 *   - .spatula/project.db   (fake SQLite database file)
 */
function scaffoldProject(dir: string): void {
  writeFileSync(join(dir, 'spatula.yaml'), 'seeds:\n  - https://example.com\n', 'utf-8');

  mkdirSync(join(dir, '.spatula', 'pages'), { recursive: true });
  mkdirSync(join(dir, '.spatula', 'exports'), { recursive: true });
  mkdirSync(join(dir, '.spatula', 'logs'), { recursive: true });
  mkdirSync(join(dir, '.spatula', 'cache', 'robots'), { recursive: true });

  writeFileSync(join(dir, '.spatula', 'project.db'), 'fake-db-content', 'utf-8');

  // Add some crawl artefacts to pages/ and exports/
  writeFileSync(join(dir, '.spatula', 'pages', 'page-1.html'), '<html/>', 'utf-8');
  writeFileSync(join(dir, '.spatula', 'exports', 'results.json'), '[]', 'utf-8');
  writeFileSync(join(dir, '.spatula', 'logs', 'run.log'), 'log line\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runResetCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    scaffoldProject(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full reset removes all .spatula contents and recreates directory structure', async () => {
    const result = await runResetCommand({ cwd: tmpDir });

    // Reported the correct project root
    expect(result.projectRoot).toBe(tmpDir);

    // Nothing was kept
    expect(result.keptItems).toHaveLength(0);

    // The .spatula dir itself still exists
    expect(existsSync(join(tmpDir, '.spatula'))).toBe(true);

    // Crawl artefacts are gone
    expect(existsSync(join(tmpDir, '.spatula', 'pages', 'page-1.html'))).toBe(false);
    expect(existsSync(join(tmpDir, '.spatula', 'exports', 'results.json'))).toBe(false);
    expect(existsSync(join(tmpDir, '.spatula', 'logs', 'run.log'))).toBe(false);
    expect(existsSync(join(tmpDir, '.spatula', 'project.db'))).toBe(false);

    // Standard subdirectories are recreated
    expect(existsSync(join(tmpDir, '.spatula', 'pages'))).toBe(true);
    expect(existsSync(join(tmpDir, '.spatula', 'exports'))).toBe(true);
    expect(existsSync(join(tmpDir, '.spatula', 'logs'))).toBe(true);
    expect(existsSync(join(tmpDir, '.spatula', 'cache', 'robots'))).toBe(true);
  });

  it('--keep-exports preserves the exports directory and its contents', async () => {
    const result = await runResetCommand({ cwd: tmpDir, keepExports: true });

    // exports was kept
    expect(result.keptItems).toContain('exports');

    // The export file is still present
    expect(existsSync(join(tmpDir, '.spatula', 'exports', 'results.json'))).toBe(true);

    // Everything else is wiped
    expect(existsSync(join(tmpDir, '.spatula', 'pages', 'page-1.html'))).toBe(false);
    expect(existsSync(join(tmpDir, '.spatula', 'project.db'))).toBe(false);
  });

  it('--keep-entities preserves the project.db database file', async () => {
    const result = await runResetCommand({ cwd: tmpDir, keepEntities: true });

    // project.db was kept
    expect(result.keptItems).toContain('project.db');

    // The database file still exists with original content
    expect(existsSync(join(tmpDir, '.spatula', 'project.db'))).toBe(true);

    // Crawl artefacts in other dirs are removed
    expect(existsSync(join(tmpDir, '.spatula', 'pages', 'page-1.html'))).toBe(false);
    expect(existsSync(join(tmpDir, '.spatula', 'exports', 'results.json'))).toBe(false);
  });
});

describe('reset --keep-remote', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpDir();
    scaffoldProject(projectDir);
    preparedSql.length = 0;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('implies --keep-entities (DB file preserved)', async () => {
    const result = await runResetCommand({ keepRemote: true, cwd: projectDir });
    expect(result.keptItems).toContain('project.db');
  });

  it('removes .spatula directories but preserves DB', async () => {
    const result = await runResetCommand({ keepRemote: true, cwd: projectDir });
    expect(result.removedItems).toContain('pages');
    expect(result.removedItems).toContain('logs');
    expect(result.keptItems).toContain('project.db');
  });

  it('deletes orphan entity_sources rows before deleting entities/extractions', async () => {
    await runResetCommand({ keepRemote: true, cwd: projectDir });

    const entitySourcesIdx = preparedSql.findIndex(s => s.includes('DELETE FROM entity_sources'));
    const entitiesIdx = preparedSql.findIndex(s => s.match(/DELETE FROM entities\b/));
    const extractionsIdx = preparedSql.findIndex(s => s.includes('DELETE FROM extractions'));

    expect(entitySourcesIdx).toBeGreaterThanOrEqual(0);
    // Must run BEFORE entities/extractions deletes, otherwise the subselect matches nothing
    expect(entitySourcesIdx).toBeLessThan(entitiesIdx);
    expect(entitySourcesIdx).toBeLessThan(extractionsIdx);
  });
});
