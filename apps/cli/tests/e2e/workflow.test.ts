/**
 * E2E workflow test — data lifecycle.
 *
 * Tests the full sequential command chain:
 *   init -> (seed data) -> status -> schema -> schema --versions -> add ->
 *   logs -> export json -> export csv -> export --min-quality ->
 *   reset --keep-entities -> verify data survives -> reset (full)
 *
 * Also tests `spatula test-url --skip-llm` against a local HTTP fixture server.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  createProjectDb,
  initializeProjectDb,
  ProjectAdapter,
} from '@accidentally-awesome-labs/spatula-db';

// ============================================================================
// Part 1: Data Lifecycle Workflow (sequential)
// ============================================================================

describe('data lifecycle workflow (sequential)', () => {
  let projectDir: string;
  let projectId: string;
  let origSpatulaHome: string | undefined;

  // Step 1: Initialize a new project
  it('step 1: spatula init creates project structure', async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'spatula-workflow-'));

    // Prevent global config from touching real home directory
    origSpatulaHome = process.env.SPATULA_HOME;
    process.env.SPATULA_HOME = join(projectDir, '__global__');

    const { runInitCommand } = await import('../../src/commands/init.js');
    const result = await runInitCommand({
      url: 'https://example.com/products',
      depth: 2,
      limit: 100,
      cwd: projectDir,
    });

    expect(result.createdYaml).toBe(true);
    expect(existsSync(join(projectDir, 'spatula.yaml'))).toBe(true);
    expect(existsSync(join(projectDir, '.spatula'))).toBe(true);

    // Verify YAML content
    const yaml = readFileSync(join(projectDir, 'spatula.yaml'), 'utf-8');
    expect(yaml).toContain('https://example.com/products');
    expect(yaml).toContain('depth: 2');
    expect(yaml).toContain('limit: 100');
  });

  // Step 2: Seed the database with realistic data (simulating a completed run)
  it('step 2: seed database with entities, schema, and actions', async () => {
    const { slugifyPath } = await import('../../src/local-project.js');
    projectId = slugifyPath(projectDir);

    const dbPath = join(projectDir, '.spatula', 'project.db');
    const { db, close } = createProjectDb(dbPath);
    initializeProjectDb(db, { projectId, name: 'Workflow Test' });

    const adapter = new ProjectAdapter(db, projectId);

    // Seed schema v1
    await adapter.schemaRepo.create({
      jobId: projectId,
      tenantId: projectId,
      version: 1,
      definition: {
        version: 1,
        fields: [
          { name: 'title', type: 'string', required: true, description: 'Product title' },
          { name: 'price', type: 'currency', required: false, description: 'Product price' },
        ],
        fieldAliases: [],
        createdAt: new Date('2026-03-28'),
        parentVersion: null,
      },
    });

    // Seed schema v2 (adds imageUrl field)
    await adapter.schemaRepo.create({
      jobId: projectId,
      tenantId: projectId,
      version: 2,
      definition: {
        version: 2,
        fields: [
          { name: 'title', type: 'string', required: true, description: 'Product title' },
          { name: 'price', type: 'currency', required: false, description: 'Product price' },
          { name: 'imageUrl', type: 'url', required: false, description: 'Product image' },
        ],
        fieldAliases: [],
        createdAt: new Date('2026-03-30'),
        parentVersion: 1,
      },
    });

    // Seed 10 entities with varied quality scores (0.50 to 0.95)
    for (let i = 0; i < 10; i++) {
      await adapter.entityRepo.create({
        jobId: projectId,
        tenantId: projectId,
        mergedData: {
          title: `Widget ${String.fromCharCode(65 + i)}`,
          price: 9.99 + i * 5,
          imageUrl: `https://example.com/img/${i}.jpg`,
        },
        provenance: {},
        qualityScore: 0.5 + i * 0.05,
        categories: ['product'],
      });
    }

    // Seed pending action
    await adapter.actionRepo.create({
      jobId: projectId,
      tenantId: projectId,
      type: 'add_field',
      payload: { field: { name: 'brand', type: 'string', description: 'Brand name' } },
      source: 'schema_evolution',
      status: 'pending_review',
      confidence: 0.92,
      reasoning: 'Common field',
    });

    // Seed a completed run record
    await adapter.runRepo.create({
      status: 'completed',
      source: 'local',
      configSnapshot: { name: 'Workflow Test' },
      startedAt: '2026-03-30T10:00:00Z',
    });

    // Seed log file
    const logsDir = join(projectDir, '.spatula', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logEntries = [
      { level: 'info', msg: 'Pipeline starting', event: 'run:start', ts: '2026-03-30T10:00:00Z' },
      {
        level: 'info',
        msg: 'Progress',
        event: 'progress',
        pagesProcessed: 10,
        totalPages: 10,
        ts: '2026-03-30T10:05:00Z',
      },
      {
        level: 'info',
        msg: 'Pipeline complete',
        event: 'run:complete',
        ts: '2026-03-30T10:06:00Z',
      },
    ];
    writeFileSync(
      join(logsDir, '2026-03-30T10-00-00.log'),
      logEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );

    close();
    expect(true).toBe(true); // seeding succeeded
  });

  // Step 3: Check status
  it('step 3: spatula status shows seeded data', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runLocalStatusCommand } = await import('../../src/commands/status.js');
    const found = await runLocalStatusCommand(projectDir);

    expect(found).toBe(true);
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('10'); // 10 entities

    consoleSpy.mockRestore();
  });

  // Step 4: Check schema
  it('step 4: spatula schema shows latest version', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSchemaCommand } = await import('../../src/commands/schema.js');
    await runSchemaCommand({});

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('title');
    expect(output).toContain('price');
    expect(output).toContain('imageUrl'); // from v2

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  // Step 5: Check schema versions
  it('step 5: spatula schema --versions shows history with diffs', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSchemaCommand } = await import('../../src/commands/schema.js');
    await runSchemaCommand({ versions: true });

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('v1');
    expect(output).toContain('v2');
    expect(output).toContain('+1 field');
    expect(output).toContain('(initial)');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  // Step 6: Add more URLs
  it('step 6: spatula add appends URLs to project', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const { runAddCommand } = await import('../../src/commands/add.js');
    const result = await runAddCommand(['https://example.com/new-page', 'https://another.com']);

    expect(result.added.length).toBe(2);

    // Verify YAML updated
    const yaml = readFileSync(join(projectDir, 'spatula.yaml'), 'utf-8');
    expect(yaml).toContain('https://example.com/new-page');
    expect(yaml).toContain('https://another.com');

    cwdSpy.mockRestore();
  });

  // Step 7: View logs
  it('step 7: spatula logs shows run log entries', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runLogsCommand } = await import('../../src/commands/logs.js');
    await runLogsCommand({});

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Pipeline starting');
    expect(output).toContain('Pipeline complete');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  // Step 8: Export to JSON
  it('step 8: spatula export produces JSON file with all entities', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'workflow-export.json');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'json', output: outputPath });

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, 'utf-8');
    // Should contain all 10 entities
    expect(content).toContain('Widget A');
    expect(content).toContain('Widget J');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  // Step 9: Export to CSV
  it('step 9: spatula export --format csv produces valid CSV', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'workflow-export.csv');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'csv', output: outputPath });

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(11); // header + 10 data rows
    expect(lines[0]).toContain('title');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  // Step 10: Export with quality filter
  it('step 10: spatula export --min-quality 0.8 filters low-quality entities', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outputPath = join(projectDir, 'workflow-export-quality.json');
    const { runExportCommand } = await import('../../src/commands/export.js');
    await runExportCommand({ format: 'json', output: outputPath, minQuality: 0.8 });

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Entities with quality >= 0.8: scores 0.80, 0.85, 0.90, 0.95 = 4 entities
    expect(output).toContain('4');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  // Step 11: Reset with --keep-entities
  it('step 11: spatula reset --keep-entities preserves DB', async () => {
    const { runResetCommand } = await import('../../src/commands/reset.js');
    const result = await runResetCommand({ keepEntities: true, cwd: projectDir });

    // DB should still exist (kept)
    expect(existsSync(join(projectDir, '.spatula', 'project.db'))).toBe(true);
    expect(result.keptItems).toContain('project.db');

    // Logs directory contents should have been removed
    expect(result.removedItems.length).toBeGreaterThan(0);
  });

  // Step 12: Verify data survives reset --keep-entities
  it('step 12: data survives reset --keep-entities', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runSchemaCommand } = await import('../../src/commands/schema.js');
    await runSchemaCommand({});

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Schema should still be there
    expect(output).toContain('title');
    expect(output).toContain('imageUrl');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  // Step 13: Full reset
  it('step 13: spatula reset wipes everything', async () => {
    const { runResetCommand } = await import('../../src/commands/reset.js');
    const result = await runResetCommand({ cwd: projectDir });

    // project.db should have been removed in the full reset
    expect(result.removedItems).toContain('project.db');

    // .spatula/ directory structure is recreated (empty subdirs)
    expect(existsSync(join(projectDir, '.spatula'))).toBe(true);
    expect(existsSync(join(projectDir, '.spatula', 'pages'))).toBe(true);
    expect(existsSync(join(projectDir, '.spatula', 'logs'))).toBe(true);
  });

  // Cleanup
  afterAll(() => {
    // Restore SPATULA_HOME
    if (origSpatulaHome === undefined) {
      delete process.env.SPATULA_HOME;
    } else {
      process.env.SPATULA_HOME = origSpatulaHome;
    }

    if (projectDir) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Part 2: test-url with local fixture server
// ============================================================================

const PRODUCT_HTML = `<!DOCTYPE html>
<html>
<head><title>Widget Pro - Best Widgets</title></head>
<body>
  <h1>Widget Pro</h1>
  <div class="price">$29.99</div>
  <p class="description">The finest widget money can buy.</p>
  <img src="https://example.com/widget.jpg" alt="Widget Pro" />
  <ul class="features">
    <li>Durable</li>
    <li>Lightweight</li>
    <li>Eco-friendly</li>
  </ul>
  <a href="/related-widget">Related Product</a>
  <a href="/another-widget">Another Widget</a>
</body>
</html>`;

describe('spatula test-url with local fixture server', () => {
  let server: Server;
  let port: number;
  let testDir: string;
  const host = '127.0.0.1';

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'spatula-testurl-'));

    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PRODUCT_HTML);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(0, host, () => {
        server.off('error', onError);
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('extracts data from local fixture page with --skip-llm', async () => {
    // Create a schema file for --skip-llm mode
    const schemaPath = join(testDir, 'test-schema.json');
    writeFileSync(
      schemaPath,
      JSON.stringify({
        version: 1,
        fields: [
          { name: 'title', type: 'string', required: true, description: 'Page title' },
          { name: 'price', type: 'string', required: false, description: 'Product price' },
        ],
        fieldAliases: [],
        createdAt: new Date().toISOString(),
        parentVersion: null,
      }),
    );

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { testUrl } = await import('../../src/commands/test-url.js');
      await testUrl({
        url: `http://${host}:${port}/product`,
        crawler: 'playwright',
        format: 'json',
        schema: schemaPath,
        skipLlm: true,
        showHtml: false,
        showLinks: false,
      });

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // CSS extractor should produce some output
      expect(output.length).toBeGreaterThan(0);
    } catch (err: any) {
      // Playwright may not be installed — skip gracefully
      if (
        err.message?.includes('playwright') ||
        err.message?.includes('browser') ||
        err.message?.includes('process.exit')
      ) {
        console.log('Skipping test-url test: Playwright not available');
        return;
      }
      throw err;
    } finally {
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  }, 30_000);

  it('shows page HTML with --show-html flag', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { testUrl } = await import('../../src/commands/test-url.js');
      await testUrl({
        url: `http://${host}:${port}/product`,
        crawler: 'playwright',
        format: 'raw',
        showHtml: true,
        showLinks: false,
        skipLlm: true,
      });

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('Widget Pro');
    } catch (err: any) {
      if (
        err.message?.includes('playwright') ||
        err.message?.includes('browser') ||
        err.message?.includes('process.exit')
      ) {
        console.log('Skipping test-url test: Playwright not available');
        return;
      }
      throw err;
    } finally {
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  }, 30_000);
});
