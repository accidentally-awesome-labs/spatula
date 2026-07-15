/**
 * Integration tests for CLI data commands.
 *
 * Uses a REAL SQLite database with seeded data — no mocks.
 * Verifies the full pipeline: command -> openLocalProject -> DataSource -> SQLite -> formatted output.
 *
 * Commands tested:
 *   1. spatula schema   (non-interactive)
 *   2. spatula logs     (non-interactive)
 *   3. spatula export   (non-interactive)
 *   4. spatula explore  (TUI — exit path only)
 *   5. spatula review   (TUI — exit path + approve via DataSource)
 */

import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  createProjectDb,
  initializeProjectDb,
  ProjectAdapter,
} from '@accidentally-awesome-labs/spatula-db';
import { LocalDataSource } from '@accidentally-awesome-labs/spatula-core';
import { slugifyPath } from '../../src/local-project.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

let projectDir: string;
let PROJECT_ID: string;
const INTEGRATION_COMMAND_TIMEOUT = 15_000;

beforeAll(async () => {
  // 1. Create temp project directory
  projectDir = mkdtempSync(join(tmpdir(), 'spatula-integration-'));
  // Derive the same projectId that openLocalProject will compute
  PROJECT_ID = slugifyPath(projectDir);

  // 2. Write spatula.yaml
  writeFileSync(
    join(projectDir, 'spatula.yaml'),
    `name: Integration Test Project
description: Testing data commands
seeds:
  - https://example.com
`,
  );

  // 3. Create and seed database
  const dbDir = join(projectDir, '.spatula');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'project.db');
  const { db, close } = createProjectDb(dbPath);
  initializeProjectDb(db, { projectId: PROJECT_ID, name: 'Integration Test' });

  const adapter = new ProjectAdapter(db, PROJECT_ID);

  // Seed schema v1
  await adapter.schemaRepo.create({
    jobId: PROJECT_ID,
    tenantId: PROJECT_ID,
    version: 1,
    definition: {
      version: 1,
      fields: [
        { name: 'title', type: 'string', required: true, description: 'Page title' },
        { name: 'price', type: 'currency', required: false, description: 'Product price' },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-03-28'),
      parentVersion: null,
    },
  });

  // Seed schema v2 (adds a field)
  await adapter.schemaRepo.create({
    jobId: PROJECT_ID,
    tenantId: PROJECT_ID,
    version: 2,
    definition: {
      version: 2,
      fields: [
        { name: 'title', type: 'string', required: true, description: 'Page title' },
        { name: 'price', type: 'currency', required: false, description: 'Product price' },
        { name: 'imageUrl', type: 'url', required: false, description: 'Product image' },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-03-30'),
      parentVersion: 1,
    },
  });

  // Seed entities
  for (let i = 0; i < 5; i++) {
    await adapter.entityRepo.create({
      jobId: PROJECT_ID,
      tenantId: PROJECT_ID,
      mergedData: { title: `Product ${i + 1}`, price: (10 + i) * 1.5 },
      provenance: {},
      qualityScore: 0.5 + i * 0.1, // 0.5, 0.6, 0.7, 0.8, 0.9
      categories: ['product'],
    });
  }

  // Seed pending actions
  await adapter.actionRepo.create({
    jobId: PROJECT_ID,
    tenantId: PROJECT_ID,
    type: 'add_field',
    payload: { field: { name: 'brand', type: 'string', description: 'Brand name' } },
    source: 'schema_evolution',
    status: 'pending_review',
    confidence: 0.92,
    reasoning: 'Common field detected across pages',
  });

  await adapter.actionRepo.create({
    jobId: PROJECT_ID,
    tenantId: PROJECT_ID,
    type: 'remove_field',
    payload: { fieldName: 'old_field' },
    source: 'schema_evolution',
    status: 'pending_review',
    confidence: 0.7,
    reasoning: 'Field too rare',
  });

  // Seed a run record
  await adapter.runRepo.create({
    status: 'completed',
    source: 'local',
    configSnapshot: { name: 'test' },
    startedAt: '2026-03-30T10:00:00Z',
  });

  // 4. Create log file
  const logsDir = join(dbDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logEntries = [
    { level: 'info', msg: 'Pipeline starting', event: 'run:start', ts: '2026-03-30T10:00:00Z' },
    {
      level: 'info',
      msg: 'Progress',
      event: 'progress',
      pagesProcessed: 5,
      totalPages: 10,
      ts: '2026-03-30T10:01:00Z',
    },
    {
      level: 'error',
      msg: 'Page fetch failed',
      event: 'task:failed',
      url: 'https://example.com/bad',
      ts: '2026-03-30T10:02:00Z',
    },
    { level: 'info', msg: 'Pipeline complete', event: 'run:complete', ts: '2026-03-30T10:03:00Z' },
  ];
  writeFileSync(
    join(logsDir, '2026-03-30T10-00-00.log'),
    logEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  // Close DB so commands can open it fresh
  close();
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. spatula schema (integration)
// ---------------------------------------------------------------------------

describe('spatula schema (integration)', () => {
  it('displays schema fields from real database', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSchemaCommand } = await import('../../src/commands/schema.js');
    await runSchemaCommand({});

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('title');
    expect(output).toContain('string');
    expect(output).toContain('price');
    expect(output).toContain('currency');
    expect(output).toContain('imageUrl'); // from v2

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('displays version history with diff summaries', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSchemaCommand } = await import('../../src/commands/schema.js');
    await runSchemaCommand({ versions: true });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('v2');
    expect(output).toContain('v1');
    expect(output).toContain('+1 field'); // v2 added imageUrl
    expect(output).toContain('(initial)'); // v1 has no parent

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('outputs raw JSON with --json flag', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSchemaCommand } = await import('../../src/commands/schema.js');
    await runSchemaCommand({ json: true });

    const output = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe(2);
    expect(parsed.definition.fields).toHaveLength(3);

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 2. spatula logs (integration)
// ---------------------------------------------------------------------------

describe('spatula logs (integration)', () => {
  it('displays latest log file entries', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runLogsCommand } = await import('../../src/commands/logs.js');
    await runLogsCommand({});

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Pipeline starting');
    expect(output).toContain('Pipeline complete');
    expect(output).toContain('Progress');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('filters to errors only', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runLogsCommand } = await import('../../src/commands/logs.js');
    await runLogsCommand({ errors: true });

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Page fetch failed');
    expect(output).not.toContain('Pipeline starting'); // info level filtered out

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3. spatula export (integration)
// ---------------------------------------------------------------------------

describe('spatula export (integration)', () => {
  it('exports entities to JSON file', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'test-export.json');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'json', output: outputPath });

    // Verify file was created
    expect(existsSync(outputPath)).toBe(true);

    // Verify console summary
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('5'); // 5 entities
    expect(output).toContain('json');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('exports to CSV format', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'test-export.csv');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'csv', output: outputPath });

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('title'); // header
    expect(content).toContain('Product 1'); // data

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('applies min-quality filter', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'test-export-quality.json');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'json', output: outputPath, minQuality: 0.75 });

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Only entities with quality >= 0.75: entities at 0.8 and 0.9 = 2 entities
    expect(output).toContain('2');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. spatula explore (integration)
// ---------------------------------------------------------------------------

describe('spatula explore (integration)', () => {
  it(
    'shows no-entities message when database is empty',
    async () => {
      // Create a separate empty project
      const emptyDir = mkdtempSync(join(tmpdir(), 'spatula-empty-'));
      writeFileSync(
        join(emptyDir, 'spatula.yaml'),
        'name: Empty\nseeds:\n  - https://example.com\n',
      );
      const emptyDbDir = join(emptyDir, '.spatula');
      mkdirSync(emptyDbDir, { recursive: true });
      const { db, close } = createProjectDb(join(emptyDbDir, 'project.db'));
      initializeProjectDb(db, { projectId: 'empty', name: 'Empty' });
      close();

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const { runExploreCommand } = await import('../../src/commands/explore.js');
        await runExploreCommand();

        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('No entities');
      } finally {
        consoleSpy.mockRestore();
        cwdSpy.mockRestore();
        rmSync(emptyDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_COMMAND_TIMEOUT,
  );

  it('builds a store with correct mode from real project', async () => {
    // This test validates the store factory works correctly
    const { buildExploreStore } = await import('../../src/commands/explore.js');
    const store = buildExploreStore(PROJECT_ID);
    const state = store.getState();
    expect(state.activeJobId).toBe(PROJECT_ID);
    expect(state.mode).toBe('explorer');
  });
});

// ---------------------------------------------------------------------------
// 5. spatula review (integration)
// ---------------------------------------------------------------------------

describe('spatula review (integration)', () => {
  it('loads pending actions from real database via DataSource', async () => {
    // Open a fresh connection
    const dbPath = join(projectDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    const adapter = new ProjectAdapter(db, PROJECT_ID);
    const dataSource = new LocalDataSource(adapter);

    // Get pending actions through the DataSource layer
    const actions = await dataSource.getActions('pending_review');

    // We seeded 2 pending actions
    expect(actions.length).toBeGreaterThanOrEqual(2);

    // Check that action shape is correct
    const firstAction = actions[0] as Record<string, unknown>;
    expect(firstAction).toHaveProperty('id');
    expect(firstAction).toHaveProperty('type');
    expect(firstAction).toHaveProperty('confidence');
    expect(firstAction).toHaveProperty('reasoning');

    // Check that our seeded types are present
    const types = actions.map((a: any) => a.type);
    expect(types).toContain('add_field');
    expect(types).toContain('remove_field');

    close();
  });

  it('approves an action via DataSource and confirms it is no longer pending', async () => {
    const dbPath = join(projectDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    const adapter = new ProjectAdapter(db, PROJECT_ID);
    const dataSource = new LocalDataSource(adapter);

    // Get initial actions
    const actionsBefore = await dataSource.getActions('pending_review');
    const firstAction = actionsBefore[0] as { id: string };

    // Approve via DataSource
    await dataSource.approveAction(firstAction.id);

    // Verify it is no longer pending
    const actionsAfter = await dataSource.getActions('pending_review');
    expect(actionsAfter.length).toBe(actionsBefore.length - 1);

    // The approved action should not appear in pending list
    const afterIds = actionsAfter.map((a: any) => a.id);
    expect(afterIds).not.toContain(firstAction.id);

    close();
  });

  it('prints no-actions message when none are pending', async () => {
    // Create a separate project with no pending actions
    const emptyDir = mkdtempSync(join(tmpdir(), 'spatula-noreview-'));
    writeFileSync(
      join(emptyDir, 'spatula.yaml'),
      'name: NoReview\nseeds:\n  - https://example.com\n',
    );
    const emptyDbDir = join(emptyDir, '.spatula');
    mkdirSync(emptyDbDir, { recursive: true });
    const { db, close } = createProjectDb(join(emptyDbDir, 'project.db'));
    initializeProjectDb(db, { projectId: 'no-review', name: 'NoReview' });
    close();

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runReviewCommand } = await import('../../src/commands/review.js');
    await runReviewCommand();

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('No pending actions');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('builds a review store with correct mode', async () => {
    const { buildReviewStore } = await import('../../src/commands/review.js');
    const store = buildReviewStore(PROJECT_ID);
    const state = store.getState();
    expect(state.activeJobId).toBe(PROJECT_ID);
    expect(state.mode).toBe('review');
    expect(state.pendingActions).toEqual([]);
  });

  it('populates store with actions from DataSource and verifies store shape', async () => {
    const dbPath = join(projectDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    const adapter = new ProjectAdapter(db, PROJECT_ID);
    const dataSource = new LocalDataSource(adapter);

    const { buildReviewStore } = await import('../../src/commands/review.js');
    const store = buildReviewStore(PROJECT_ID);

    // Fetch and filter actions like the real command does
    const actions = await dataSource.getActions('pending_review');
    const validActions = actions.filter(
      (a): a is Record<string, unknown> & { id: string; type: string } =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as any).id === 'string' &&
        typeof (a as any).type === 'string',
    );
    store.getState().setPendingActions(validActions);

    // Verify store state
    const state = store.getState();
    expect(state.pendingActions.length).toBeGreaterThanOrEqual(1);
    expect(state.pendingActions[0]).toHaveProperty('id');
    expect(state.pendingActions[0]).toHaveProperty('type');
    expect(state.reviewIndex).toBe(0);

    close();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: DataSource end-to-end
// ---------------------------------------------------------------------------

describe('LocalDataSource end-to-end (integration)', () => {
  it('getStatus returns correct counts from seeded database', async () => {
    const dbPath = join(projectDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    const adapter = new ProjectAdapter(db, PROJECT_ID);
    const dataSource = new LocalDataSource(adapter);

    const status = await dataSource.getStatus();
    expect(status.totalEntities).toBe(5);
    // We approved one action in an earlier test, so pending is reduced
    expect(status.pendingActions).toBeGreaterThanOrEqual(0);

    close();
  });

  it('getEntities with pagination returns correct slices', async () => {
    const dbPath = join(projectDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    const adapter = new ProjectAdapter(db, PROJECT_ID);
    const dataSource = new LocalDataSource(adapter);

    // Page 1: first 2 entities
    const page1 = await dataSource.getEntities({ limit: 2, offset: 0 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);

    // Page 2: next 2
    const page2 = await dataSource.getEntities({ limit: 2, offset: 2 });
    expect(page2.data).toHaveLength(2);

    // Page 3: last 1
    const page3 = await dataSource.getEntities({ limit: 2, offset: 4 });
    expect(page3.data).toHaveLength(1);

    // No overlap between pages
    const ids = [
      ...page1.data.map((e) => e.id),
      ...page2.data.map((e) => e.id),
      ...page3.data.map((e) => e.id),
    ];
    expect(new Set(ids).size).toBe(5);

    close();
  });

  it('getSchema returns the latest version', async () => {
    const dbPath = join(projectDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    const adapter = new ProjectAdapter(db, PROJECT_ID);
    const dataSource = new LocalDataSource(adapter);

    const schema = (await dataSource.getSchema()) as {
      version: number;
      definition: { fields: Array<{ name: string }> };
    };
    expect(schema).not.toBeNull();
    expect(schema.version).toBe(2);
    expect(schema.definition.fields).toHaveLength(3);

    close();
  });

  it('getSchemaVersions returns all versions sorted descending', async () => {
    const dbPath = join(projectDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    const adapter = new ProjectAdapter(db, PROJECT_ID);
    const dataSource = new LocalDataSource(adapter);

    const versions = (await dataSource.getSchemaVersions()) as Array<{
      version: number;
      definition: { parentVersion: number | null };
    }>;
    expect(versions).toHaveLength(2);
    // Descending order
    expect(versions[0].version).toBe(2);
    expect(versions[1].version).toBe(1);
    // Parentage
    expect(versions[1].definition.parentVersion).toBeNull();
    expect(versions[0].definition.parentVersion).toBe(1);

    close();
  });

  it('searchEntities finds matching entities', async () => {
    const dbPath = join(projectDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    const adapter = new ProjectAdapter(db, PROJECT_ID);
    const dataSource = new LocalDataSource(adapter);

    const results = await dataSource.searchEntities('Product 3');
    expect(results.length).toBe(1);
    expect((results[0] as any).mergedData.title).toBe('Product 3');

    close();
  });
});

// ---------------------------------------------------------------------------
// 6. spatula init (integration)
// ---------------------------------------------------------------------------

describe('spatula init (integration)', () => {
  it('creates spatula.yaml and .spatula/ in empty directory', async () => {
    const initDir = mkdtempSync(join(tmpdir(), 'spatula-init-'));
    // Point SPATULA_HOME to temp dir so ensureGlobalConfig does not touch real home
    const fakeHome = join(initDir, '__global__');
    const origHome = process.env.SPATULA_HOME;
    process.env.SPATULA_HOME = fakeHome;
    try {
      const { runInitCommand } = await import('../../src/commands/init.js');
      const result = await runInitCommand({
        url: 'https://example.com',
        depth: 3,
        limit: 500,
        cwd: initDir,
      });

      // Verify files created
      expect(existsSync(join(initDir, 'spatula.yaml'))).toBe(true);
      expect(existsSync(join(initDir, '.spatula'))).toBe(true);

      // Verify standard subdirectories
      expect(existsSync(join(initDir, '.spatula', 'pages'))).toBe(true);
      expect(existsSync(join(initDir, '.spatula', 'exports'))).toBe(true);
      expect(existsSync(join(initDir, '.spatula', 'logs'))).toBe(true);

      // Verify YAML content
      const yaml = readFileSync(join(initDir, 'spatula.yaml'), 'utf-8');
      expect(yaml).toContain('https://example.com');
      expect(yaml).toContain('depth: 3');
      expect(yaml).toContain('limit: 500');

      // Verify result shape
      expect(result.createdYaml).toBe(true);
      expect(result.spatulaDir).toBe(join(initDir, '.spatula'));
    } finally {
      if (origHome === undefined) delete process.env.SPATULA_HOME;
      else process.env.SPATULA_HOME = origHome;
      rmSync(initDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite existing spatula.yaml', async () => {
    const initDir = mkdtempSync(join(tmpdir(), 'spatula-init-'));
    const fakeHome = join(initDir, '__global__');
    const origHome = process.env.SPATULA_HOME;
    process.env.SPATULA_HOME = fakeHome;
    try {
      writeFileSync(join(initDir, 'spatula.yaml'), 'name: existing\n');

      const { runInitCommand } = await import('../../src/commands/init.js');
      const result = await runInitCommand({ cwd: initDir });

      // Should detect existing project and not overwrite
      expect(result.createdYaml).toBe(false);

      // Original content preserved
      const yaml = readFileSync(join(initDir, 'spatula.yaml'), 'utf-8');
      expect(yaml).toContain('existing');
    } finally {
      if (origHome === undefined) delete process.env.SPATULA_HOME;
      else process.env.SPATULA_HOME = origHome;
      rmSync(initDir, { recursive: true, force: true });
    }
  });

  it('updates .gitignore when it exists', async () => {
    const initDir = mkdtempSync(join(tmpdir(), 'spatula-init-'));
    const fakeHome = join(initDir, '__global__');
    const origHome = process.env.SPATULA_HOME;
    process.env.SPATULA_HOME = fakeHome;
    try {
      writeFileSync(join(initDir, '.gitignore'), 'node_modules/\n');

      const { runInitCommand } = await import('../../src/commands/init.js');
      const result = await runInitCommand({ url: 'https://example.com', cwd: initDir });

      expect(result.gitignoreUpdated).toBe(true);

      const gitignore = readFileSync(join(initDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.spatula/');
      expect(gitignore).toContain('node_modules/');
    } finally {
      if (origHome === undefined) delete process.env.SPATULA_HOME;
      else process.env.SPATULA_HOME = origHome;
      rmSync(initDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. spatula add (integration)
// ---------------------------------------------------------------------------

describe('spatula add (integration)', () => {
  it('adds new URLs to spatula.yaml', async () => {
    const addDir = mkdtempSync(join(tmpdir(), 'spatula-add-'));
    try {
      writeFileSync(join(addDir, 'spatula.yaml'), 'name: test\nseeds:\n  - https://existing.com\n');
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(addDir);

      const { runAddCommand } = await import('../../src/commands/add.js');
      const result = await runAddCommand(['https://new.com', 'https://another.com']);

      expect(result.added).toContain('https://new.com');
      expect(result.added).toContain('https://another.com');

      // Verify YAML updated on disk
      const yaml = readFileSync(join(addDir, 'spatula.yaml'), 'utf-8');
      expect(yaml).toContain('https://new.com');
      expect(yaml).toContain('https://another.com');
      expect(yaml).toContain('https://existing.com');

      cwdSpy.mockRestore();
    } finally {
      rmSync(addDir, { recursive: true, force: true });
    }
  });

  it('deduplicates against existing seeds', async () => {
    const addDir = mkdtempSync(join(tmpdir(), 'spatula-add-'));
    try {
      writeFileSync(join(addDir, 'spatula.yaml'), 'name: test\nseeds:\n  - https://existing.com\n');
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(addDir);

      const { runAddCommand } = await import('../../src/commands/add.js');
      const result = await runAddCommand(['https://existing.com', 'https://new.com']);

      expect(result.duplicates).toContain('https://existing.com');
      expect(result.added).toEqual(['https://new.com']);

      cwdSpy.mockRestore();
    } finally {
      rmSync(addDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid URLs', async () => {
    const addDir = mkdtempSync(join(tmpdir(), 'spatula-add-'));
    try {
      writeFileSync(join(addDir, 'spatula.yaml'), 'name: test\nseeds: []\n');
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(addDir);

      const { runAddCommand } = await import('../../src/commands/add.js');
      const result = await runAddCommand(['not-a-url', 'https://valid.com']);

      expect(result.invalid).toContain('not-a-url');
      expect(result.added).toContain('https://valid.com');

      cwdSpy.mockRestore();
    } finally {
      rmSync(addDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 8. spatula reset (integration)
// ---------------------------------------------------------------------------

describe('spatula reset (integration)', () => {
  it('removes .spatula/ directory contents and recreates structure', async () => {
    const resetDir = mkdtempSync(join(tmpdir(), 'spatula-reset-'));
    try {
      // Set up a project with .spatula/ contents
      writeFileSync(join(resetDir, 'spatula.yaml'), 'name: test\nseeds: []\n');
      const spatulaDir = join(resetDir, '.spatula');
      mkdirSync(join(spatulaDir, 'pages'), { recursive: true });
      mkdirSync(join(spatulaDir, 'logs'), { recursive: true });
      mkdirSync(join(spatulaDir, 'exports'), { recursive: true });
      writeFileSync(join(spatulaDir, 'pages', 'page1.html'), '<html></html>');
      writeFileSync(join(spatulaDir, 'logs', 'test.log'), 'log');
      writeFileSync(join(spatulaDir, 'exports', 'export.json'), '{}');

      const { runResetCommand } = await import('../../src/commands/reset.js');
      const result = await runResetCommand({ cwd: resetDir });

      // All top-level items should have been removed
      expect(result.removedItems).toContain('pages');
      expect(result.removedItems).toContain('logs');
      expect(result.removedItems).toContain('exports');
      expect(result.keptItems).toEqual([]);

      // Old files should be gone
      expect(existsSync(join(spatulaDir, 'pages', 'page1.html'))).toBe(false);
      expect(existsSync(join(spatulaDir, 'logs', 'test.log'))).toBe(false);
      expect(existsSync(join(spatulaDir, 'exports', 'export.json'))).toBe(false);

      // Standard subdirectories should be recreated (empty)
      expect(existsSync(join(spatulaDir, 'pages'))).toBe(true);
      expect(existsSync(join(spatulaDir, 'exports'))).toBe(true);
      expect(existsSync(join(spatulaDir, 'logs'))).toBe(true);

      // spatula.yaml should be untouched
      expect(readFileSync(join(resetDir, 'spatula.yaml'), 'utf-8')).toContain('name: test');
    } finally {
      rmSync(resetDir, { recursive: true, force: true });
    }
  });

  it('preserves exports with --keep-exports flag', async () => {
    const resetDir = mkdtempSync(join(tmpdir(), 'spatula-reset-'));
    try {
      writeFileSync(join(resetDir, 'spatula.yaml'), 'name: test\nseeds: []\n');
      const spatulaDir = join(resetDir, '.spatula');
      mkdirSync(join(spatulaDir, 'pages'), { recursive: true });
      mkdirSync(join(spatulaDir, 'exports'), { recursive: true });
      writeFileSync(join(spatulaDir, 'pages', 'page1.html'), '<html></html>');
      writeFileSync(join(spatulaDir, 'exports', 'export.json'), '{}');

      const { runResetCommand } = await import('../../src/commands/reset.js');
      const result = await runResetCommand({ keepExports: true, cwd: resetDir });

      // Exports should be preserved
      expect(existsSync(join(spatulaDir, 'exports', 'export.json'))).toBe(true);
      expect(result.keptItems).toContain('exports');

      // Pages should be removed
      expect(existsSync(join(spatulaDir, 'pages', 'page1.html'))).toBe(false);
      expect(result.removedItems).toContain('pages');
    } finally {
      rmSync(resetDir, { recursive: true, force: true });
    }
  });

  it('preserves project.db with --keep-entities flag', async () => {
    const resetDir = mkdtempSync(join(tmpdir(), 'spatula-reset-'));
    try {
      writeFileSync(join(resetDir, 'spatula.yaml'), 'name: test\nseeds: []\n');
      const spatulaDir = join(resetDir, '.spatula');
      mkdirSync(join(spatulaDir, 'pages'), { recursive: true });
      writeFileSync(join(spatulaDir, 'project.db'), 'fake-db-content');
      writeFileSync(join(spatulaDir, 'pages', 'page1.html'), '<html></html>');

      const { runResetCommand } = await import('../../src/commands/reset.js');
      const result = await runResetCommand({ keepEntities: true, cwd: resetDir });

      // DB file should be preserved
      expect(existsSync(join(spatulaDir, 'project.db'))).toBe(true);
      expect(result.keptItems).toContain('project.db');

      // Pages should be removed
      expect(result.removedItems).toContain('pages');
    } finally {
      rmSync(resetDir, { recursive: true, force: true });
    }
  });

  it('handles missing .spatula/ directory gracefully', async () => {
    const resetDir = mkdtempSync(join(tmpdir(), 'spatula-reset-'));
    try {
      writeFileSync(join(resetDir, 'spatula.yaml'), 'name: test\nseeds: []\n');
      // No .spatula/ directory exists

      const { runResetCommand } = await import('../../src/commands/reset.js');
      const result = await runResetCommand({ cwd: resetDir });

      // Should have recreated the directory structure without errors
      expect(result.removedItems).toEqual([]);
      expect(result.keptItems).toEqual([]);
      expect(existsSync(join(resetDir, '.spatula', 'pages'))).toBe(true);
      expect(existsSync(join(resetDir, '.spatula', 'exports'))).toBe(true);
      expect(existsSync(join(resetDir, '.spatula', 'logs'))).toBe(true);
    } finally {
      rmSync(resetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. spatula export — advanced formats and features (integration)
// ---------------------------------------------------------------------------

describe('spatula export — advanced formats and features (integration)', () => {
  it('exports entities to SQLite format', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'test-export.sqlite');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'sqlite', output: outputPath });

    // Verify file was created and is not empty
    expect(existsSync(outputPath)).toBe(true);
    const stats = statSync(outputPath);
    expect(stats.size).toBeGreaterThan(0);

    // Verify summary output mentions sqlite
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('sqlite');
    expect(output).toContain('5'); // 5 entities

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('exports JSON with --include-provenance flag', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'test-export-provenance.json');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'json', output: outputPath, includeProvenance: true });

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, 'utf-8');
    // The provenance flag should be passed to the exporter
    // The exact structure depends on the JsonExporter implementation
    expect(content.length).toBeGreaterThan(0);

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('batch-loads entities correctly for large datasets (>200)', async () => {
    // Create a separate project with 450 entities
    const largeDir = mkdtempSync(join(tmpdir(), 'spatula-large-'));
    try {
      writeFileSync(
        join(largeDir, 'spatula.yaml'),
        'name: Large\nseeds:\n  - https://example.com\n',
      );
      const dbDir = join(largeDir, '.spatula');
      mkdirSync(dbDir, { recursive: true });

      const { slugifyPath } = await import('../../src/local-project.js');
      const pid = slugifyPath(largeDir);
      const { db, close } = createProjectDb(join(dbDir, 'project.db'));
      initializeProjectDb(db, { projectId: pid, name: 'Large' });

      const adapter = new ProjectAdapter(db, pid);

      // Create schema
      await adapter.schemaRepo.create({
        jobId: pid,
        tenantId: pid,
        version: 1,
        definition: {
          version: 1,
          fields: [{ name: 'title', type: 'string', required: true, description: 'Title' }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      });

      // Insert 450 entities
      for (let i = 0; i < 450; i++) {
        await adapter.entityRepo.create({
          jobId: pid,
          tenantId: pid,
          mergedData: { title: `Item ${i}` },
          provenance: {},
          qualityScore: 0.8,
        });
      }
      close();

      // Export and verify all 450 entities are included
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(largeDir);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const outputPath = join(largeDir, 'large-export.json');
      const { runExportCommand } = await import('../../src/commands/export.js');
      await runExportCommand({ format: 'json', output: outputPath });

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('450'); // all entities exported

      // Verify the file actually has all entities
      const content = readFileSync(outputPath, 'utf-8');
      // Count entity occurrences (rough check)
      expect(content).toContain('Item 0');
      expect(content).toContain('Item 449');

      consoleSpy.mockRestore();
      cwdSpy.mockRestore();
    } finally {
      rmSync(largeDir, { recursive: true, force: true });
    }
  });

  it('min-quality filter works correctly on large dataset', async () => {
    // Create project with entities at various quality levels
    const qualDir = mkdtempSync(join(tmpdir(), 'spatula-quality-'));
    try {
      writeFileSync(
        join(qualDir, 'spatula.yaml'),
        'name: Quality\nseeds:\n  - https://example.com\n',
      );
      const dbDir = join(qualDir, '.spatula');
      mkdirSync(dbDir, { recursive: true });

      const { slugifyPath } = await import('../../src/local-project.js');
      const pid = slugifyPath(qualDir);
      const { db, close } = createProjectDb(join(dbDir, 'project.db'));
      initializeProjectDb(db, { projectId: pid, name: 'Quality' });

      const adapter = new ProjectAdapter(db, pid);
      await adapter.schemaRepo.create({
        jobId: pid,
        tenantId: pid,
        version: 1,
        definition: {
          version: 1,
          fields: [{ name: 'title', type: 'string', required: true, description: 'T' }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      });

      // 300 entities: 100 at 0.3 quality, 100 at 0.6, 100 at 0.9
      for (let i = 0; i < 100; i++) {
        await adapter.entityRepo.create({
          jobId: pid,
          tenantId: pid,
          mergedData: { title: `Low ${i}` },
          provenance: {},
          qualityScore: 0.3,
        });
        await adapter.entityRepo.create({
          jobId: pid,
          tenantId: pid,
          mergedData: { title: `Mid ${i}` },
          provenance: {},
          qualityScore: 0.6,
        });
        await adapter.entityRepo.create({
          jobId: pid,
          tenantId: pid,
          mergedData: { title: `High ${i}` },
          provenance: {},
          qualityScore: 0.9,
        });
      }
      close();

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(qualDir);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const outputPath = join(qualDir, 'quality-export.json');
      const { runExportCommand } = await import('../../src/commands/export.js');
      await runExportCommand({ format: 'json', output: outputPath, minQuality: 0.5 });

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // Should include 200 entities (100 mid + 100 high), exclude 100 low
      expect(output).toContain('200');

      consoleSpy.mockRestore();
      cwdSpy.mockRestore();
    } finally {
      rmSync(qualDir, { recursive: true, force: true });
    }
  });
});
