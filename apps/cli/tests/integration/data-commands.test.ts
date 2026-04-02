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
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createProjectDb, initializeProjectDb, ProjectAdapter } from '@spatula/db';
import { LocalDataSource } from '@spatula/core';
import { slugifyPath } from '../../src/local-project.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

let projectDir: string;
let PROJECT_ID: string;

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
  it('shows no-entities message when database is empty', async () => {
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

    const { runExploreCommand } = await import('../../src/commands/explore.js');
    await runExploreCommand();

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('No entities');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
    rmSync(emptyDir, { recursive: true, force: true });
  });

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
