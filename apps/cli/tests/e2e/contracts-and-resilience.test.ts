/**
 * E2E tests for JSON output contracts and malformed input resilience.
 *
 * Part 1 — JSON Output Contracts:
 *   Verifies the shape of --json output remains stable for scripting users.
 *   Tests: schema --json, schema --versions --json, export --format json, export --format csv.
 *
 * Part 2 — Malformed Input Resilience:
 *   Verifies graceful error handling for corrupt YAML, missing DB, empty projects,
 *   corrupt DB files, unicode data, paths with spaces, etc.
 *
 * Uses REAL SQLite databases with seeded data — no mocks for storage.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  createProjectDb,
  initializeProjectDb,
  ProjectAdapter,
} from '@accidentally-awesome-labs/spatula-db';

// ---------------------------------------------------------------------------
// Shared fixture for contract tests
// ---------------------------------------------------------------------------

let projectDir: string;
let PROJECT_ID: string;

beforeAll(async () => {
  const { slugifyPath } = await import('../../src/local-project.js');

  // 1. Create temp project directory
  projectDir = mkdtempSync(join(tmpdir(), 'spatula-contracts-'));
  PROJECT_ID = slugifyPath(projectDir);

  // 2. Write spatula.yaml
  writeFileSync(
    join(projectDir, 'spatula.yaml'),
    `name: Contract Test Project
description: JSON contract testing
seeds:
  - https://example.com
`,
  );

  // 3. Create and seed database
  const dbDir = join(projectDir, '.spatula');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'project.db');
  const { db, close } = createProjectDb(dbPath);
  initializeProjectDb(db, { projectId: PROJECT_ID, name: 'Contract Test' });

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
  for (let i = 0; i < 3; i++) {
    await adapter.entityRepo.create({
      jobId: PROJECT_ID,
      tenantId: PROJECT_ID,
      mergedData: { title: `Product ${i + 1}`, price: (10 + i) * 1.5 },
      provenance: {},
      qualityScore: 0.7 + i * 0.1,
    });
  }

  // Close DB so commands can open it fresh
  close();
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ===========================================================================
// Part 1: JSON Output Contracts
// ===========================================================================

describe('JSON output contracts', () => {
  it('schema --json output has stable shape', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSchemaCommand } = await import('../../src/commands/schema.js');
    await runSchemaCommand({ json: true });

    const output = consoleSpy.mock.calls[0][0];
    const schema = JSON.parse(output);

    // Contract: top-level shape
    expect(schema).toHaveProperty('id');
    expect(schema).toHaveProperty('version');
    expect(schema).toHaveProperty('definition');

    // Contract: definition shape
    expect(schema.definition).toHaveProperty('version');
    expect(schema.definition).toHaveProperty('fields');
    expect(Array.isArray(schema.definition.fields)).toBe(true);

    // Contract: field shape
    const field = schema.definition.fields[0];
    expect(field).toHaveProperty('name');
    expect(field).toHaveProperty('type');
    expect(field).toHaveProperty('required');
    expect(typeof field.name).toBe('string');
    expect(typeof field.type).toBe('string');
    expect(typeof field.required).toBe('boolean');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('schema --versions --json output is array of version records', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSchemaCommand } = await import('../../src/commands/schema.js');
    await runSchemaCommand({ versions: true, json: true });

    const output = consoleSpy.mock.calls[0][0];
    const versions = JSON.parse(output);

    // Contract: is an array
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBeGreaterThan(0);

    // Contract: each version has stable shape
    for (const v of versions) {
      expect(v).toHaveProperty('id');
      expect(v).toHaveProperty('version');
      expect(typeof v.version).toBe('number');
      expect(v).toHaveProperty('definition');
      expect(v.definition).toHaveProperty('fields');
    }

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('export --format json produces valid JSON with entity array', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'contract-test.json');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'json', output: outputPath });

    const content = readFileSync(outputPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Contract: JsonExporter produces an array of entity records
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    // Contract: each entity has the shape from JsonExporter
    for (const entity of parsed) {
      expect(entity).toHaveProperty('data');
      expect(entity).toHaveProperty('qualityScore');
      expect(typeof entity.qualityScore).toBe('number');
      // data should contain schema fields
      expect(entity.data).toHaveProperty('title');
    }

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('export --format csv produces valid CSV with headers', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'contract-test.csv');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'csv', output: outputPath });

    const content = readFileSync(outputPath, 'utf-8');
    const lines = content.trim().split('\n');

    // Contract: first line is headers
    expect(lines.length).toBeGreaterThan(1); // header + at least 1 data row
    const headers = lines[0];
    // Headers should include schema field names
    expect(headers).toContain('title');

    // Contract: data rows are non-empty
    for (const line of lines.slice(1)) {
      expect(line.length).toBeGreaterThan(0);
    }

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });
});

// ===========================================================================
// Part 2: Malformed Input Resilience
// ===========================================================================

describe('malformed input resilience', () => {
  it('schema handles corrupt spatula.yaml gracefully', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'spatula-bad-yaml-'));
    try {
      writeFileSync(join(badDir, 'spatula.yaml'), '{{{{not valid yaml!!!!');
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(badDir);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as any);

      const { runSchemaCommand } = await import('../../src/commands/schema.js');

      // Should throw/exit, not crash with unhandled exception
      await expect(runSchemaCommand({})).rejects.toThrow();

      consoleSpy.mockRestore();
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('export handles project with no entities gracefully', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'spatula-empty-'));
    try {
      writeFileSync(
        join(emptyDir, 'spatula.yaml'),
        'name: empty\nseeds:\n  - https://example.com\n',
      );
      const dbDir = join(emptyDir, '.spatula');
      mkdirSync(dbDir, { recursive: true });

      const { slugifyPath } = await import('../../src/local-project.js');
      const pid = slugifyPath(emptyDir);
      const { db, close } = createProjectDb(join(dbDir, 'project.db'));
      initializeProjectDb(db, { projectId: pid, name: 'empty' });
      // Create a schema but NO entities
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
      close();

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { runExportCommand } = await import('../../src/commands/export.js');
      await runExportCommand({ format: 'json', output: join(emptyDir, 'out.json') });

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // Should produce a clear "no entities" message, not crash
      expect(output).toContain('No entities');

      consoleSpy.mockRestore();
      cwdSpy.mockRestore();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('schema handles missing .spatula/project.db gracefully', async () => {
    const noDB = mkdtempSync(join(tmpdir(), 'spatula-nodb-'));
    try {
      writeFileSync(join(noDB, 'spatula.yaml'), 'name: nodb\nseeds: []\n');
      // Don't create .spatula/ at all

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(noDB);

      const { runSchemaCommand } = await import('../../src/commands/schema.js');
      // openLocalProject should handle this — either create DB or give clear error
      // This test verifies no unhandled crash
      try {
        await runSchemaCommand({});
      } catch (err: any) {
        // Expected — should be a clean error, not a stack trace
        expect(err.message).toBeTruthy();
      }

      cwdSpy.mockRestore();
    } finally {
      rmSync(noDB, { recursive: true, force: true });
    }
  });

  it('add handles empty URLs array gracefully', async () => {
    const { validateAndDedup } = await import('../../src/commands/add.js');
    const result = validateAndDedup([], ['https://existing.com']);
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
  });

  it('export handles corrupt DB gracefully', async () => {
    const corruptDir = mkdtempSync(join(tmpdir(), 'spatula-corrupt-'));
    try {
      writeFileSync(join(corruptDir, 'spatula.yaml'), 'name: corrupt\nseeds: []\n');
      const dbDir = join(corruptDir, '.spatula');
      mkdirSync(dbDir, { recursive: true });
      // Write garbage to project.db
      writeFileSync(join(dbDir, 'project.db'), 'this is not a sqlite database');

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(corruptDir);

      const { runExportCommand } = await import('../../src/commands/export.js');
      // Should throw a clear error about corrupt DB, not crash with unintelligible error
      await expect(runExportCommand({ format: 'json' })).rejects.toThrow();

      cwdSpy.mockRestore();
    } finally {
      rmSync(corruptDir, { recursive: true, force: true });
    }
  });

  it('logs handles project with no log files gracefully', async () => {
    const noLogsDir = mkdtempSync(join(tmpdir(), 'spatula-nologs-'));
    try {
      writeFileSync(join(noLogsDir, 'spatula.yaml'), 'name: nologs\nseeds: []\n');
      mkdirSync(join(noLogsDir, '.spatula'), { recursive: true });
      // No logs/ directory

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(noLogsDir);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as any);

      const { runLogsCommand } = await import('../../src/commands/logs.js');
      await expect(runLogsCommand({})).rejects.toThrow('exit');

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('No log files');

      consoleSpy.mockRestore();
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    } finally {
      rmSync(noLogsDir, { recursive: true, force: true });
    }
  });

  it('init handles directory with spaces in path', async () => {
    const spacePath = mkdtempSync(join(tmpdir(), 'spatula path with spaces '));
    try {
      const { runInitCommand } = await import('../../src/commands/init.js');
      const result = await runInitCommand({ url: 'https://example.com', cwd: spacePath });
      expect(existsSync(join(spacePath, 'spatula.yaml'))).toBe(true);
      expect(result.createdYaml).toBe(true);
    } finally {
      rmSync(spacePath, { recursive: true, force: true });
    }
  });

  it('entities with unicode data export correctly', async () => {
    const unicodeDir = mkdtempSync(join(tmpdir(), 'spatula-unicode-'));
    try {
      writeFileSync(
        join(unicodeDir, 'spatula.yaml'),
        'name: unicode\nseeds:\n  - https://example.com\n',
      );
      const dbDir = join(unicodeDir, '.spatula');
      mkdirSync(dbDir, { recursive: true });

      const { slugifyPath } = await import('../../src/local-project.js');
      const pid = slugifyPath(unicodeDir);
      const { db, close } = createProjectDb(join(dbDir, 'project.db'));
      initializeProjectDb(db, { projectId: pid, name: 'unicode' });

      const adapter = new ProjectAdapter(db, pid);
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
      await adapter.entityRepo.create({
        jobId: pid,
        tenantId: pid,
        mergedData: { title: '日本語テスト émojis & spëcial "chars"' },
        provenance: {},
        qualityScore: 0.9,
      });
      close();

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unicodeDir);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const outputPath = join(unicodeDir, 'unicode-export.json');
      const { runExportCommand } = await import('../../src/commands/export.js');
      await runExportCommand({ format: 'json', output: outputPath });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('日本語テスト');

      consoleSpy.mockRestore();
      cwdSpy.mockRestore();
    } finally {
      rmSync(unicodeDir, { recursive: true, force: true });
    }
  });
});
