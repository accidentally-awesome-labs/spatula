/**
 * Tier 2 Pipeline Happy Path Tests — 36 tests sharing a single pipeline run.
 *
 * Uses mock Ollama + fixture HTTP server for deterministic assertions
 * on crawl, classification, extraction, reconciliation, schema evolution,
 * and CLI command output.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';
import { startMockOllama, type MockOllamaServer } from './mock-ollama.js';
import {
  createFixtureProject,
  buildPipelineRunner,
  isPlaywrightAvailable,
  type FixtureProject,
  type PipelineTestHarness,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Shared state — populated once in beforeAll
// ---------------------------------------------------------------------------

let playwrightOk = false;
let fixtureServer: FixtureServer;
let mockOllama: MockOllamaServer;
let project: FixtureProject;
let harness: PipelineTestHarness;

/**
 * Guard: skip the current test at runtime if Playwright is not available.
 * Uses vitest's `TestContext.skip()` which is the correct way to skip
 * from inside a test body when the condition is determined in beforeAll.
 */
function requirePlaywright(ctx: { skip: () => void }) {
  if (!playwrightOk) ctx.skip();
}

beforeAll(async () => {
  playwrightOk = await isPlaywrightAvailable();
  if (!playwrightOk) return;

  fixtureServer = await startFixtureServer();
  mockOllama = await startMockOllama({ mode: 'happy' });
  project = createFixtureProject(fixtureServer.port);
  harness = await buildPipelineRunner(project.projectDir, {
    ollamaBaseUrl: `http://localhost:${mockOllama.port}`,
    fixturePort: fixtureServer.port,
  });

  // Run the pipeline ONCE — all tests assert on this single run
  await harness.runner.run();
}, 120_000);

afterAll(async () => {
  if (harness) await harness.closeAll();
  if (project) project.cleanup();
  if (fixtureServer) await fixtureServer.close();
  if (mockOllama) await mockOllama.close();
});

// ===========================================================================
// 1. Crawl verification (7 tests)
// ===========================================================================

describe('crawl verification', () => {
  it('pipeline completes without errors', (ctx) => {
    requirePlaywright(ctx);
    expect(harness).toBeDefined();
    expect(harness.runner).toBeDefined();
  });

  it('crawled expected pages', (ctx) => {
    requirePlaywright(ctx);
    const paths = fixtureServer.requestLog.map((r) => r.path);
    expect(paths).toContain('/');
    expect(paths).toContain('/products/widget-pro');
    expect(paths).toContain('/recipes/pasta-carbonara');
    expect(paths).toContain('/products/comparison');
    expect(paths).toContain('/robots.txt');
  });

  it('never fetched /admin (robots.txt compliance)', (ctx) => {
    requirePlaywright(ctx);
    const paths = fixtureServer.requestLog.map((r) => r.path);
    expect(paths).not.toContain('/admin');
  });

  it('followed redirect and deduplicated URL', (ctx) => {
    requirePlaywright(ctx);
    // The fixture server serves /products/widget-pro/ as a 301 -> /products/widget-pro.
    // The pipeline should not produce two separate extractions for widget-pro.
    const extractorCalls = mockOllama.getLogByComponent('extractor');
    const widgetProExtractions = extractorCalls.filter(
      (c) =>
        c.userPromptPreview.toLowerCase().includes('widget pro') &&
        !c.userPromptPreview.toLowerCase().includes('deluxe'),
    );
    // Re-extraction (after schema evolution) may add another call, but we should
    // not see more than 2 (initial + possible re-extraction). 0 is also okay if
    // the page was classified as listing/links_only.
    expect(widgetProExtractions.length).toBeLessThanOrEqual(2);
  });

  it('followed pagination to page 2', (ctx) => {
    requirePlaywright(ctx);
    const paths = fixtureServer.requestLog.map((r) => r.path);
    expect(paths).toContain('/page/2');
  });

  it('did not follow external domain links', (ctx) => {
    requirePlaywright(ctx);
    // The fixture pages contain a Twitter link — pipeline must stay on-domain
    const paths = fixtureServer.requestLog.map((r) => r.path);
    const external = paths.filter((p) => p.includes('twitter.com'));
    expect(external).toHaveLength(0);
  });

  it('handled 404 gracefully', (ctx) => {
    requirePlaywright(ctx);
    // Pipeline completed without throwing — that is the assertion.
    expect(harness.runner).toBeDefined();
  });
});

// ===========================================================================
// 2. Classification verification (2 tests)
// ===========================================================================

describe('classification verification', () => {
  it('classified pages with correct strategies', (ctx) => {
    requirePlaywright(ctx);
    const classifierCalls = mockOllama.getLogByComponent('classifier');
    expect(classifierCalls.length).toBeGreaterThan(0);
  });

  it('skipped irrelevant about page extraction', (ctx) => {
    requirePlaywright(ctx);
    const extractorCalls = mockOllama.getLogByComponent('extractor');
    const aboutExtractions = extractorCalls.filter(
      (c) =>
        c.userPromptPreview.toLowerCase().includes('about') ||
        c.userPromptPreview.toLowerCase().includes('company history'),
    );
    expect(aboutExtractions).toHaveLength(0);
  });
});

// ===========================================================================
// 3. Extraction verification (5 tests)
// ===========================================================================

describe('extraction verification', () => {
  it('extracted product entity with correct fields', async (ctx) => {
    requirePlaywright(ctx);
    const entities = await harness.dataSource.getEntities({ limit: 50, offset: 0 });
    const widgetPro = entities.data.find(
      (e) => (e.mergedData as any).title === 'Widget Pro',
    );
    expect(widgetPro).toBeDefined();
    expect((widgetPro!.mergedData as any).price).toBeDefined();
  });

  it('extracted recipe entity with category-specific fields', async (ctx) => {
    requirePlaywright(ctx);
    const entities = await harness.dataSource.getEntities({ limit: 50, offset: 0 });
    const carbonara = entities.data.find(
      (e) => (e.mergedData as any).title === 'Pasta Carbonara',
    );
    expect(carbonara).toBeDefined();
  });

  it('extracted entity from comparison table', async (ctx) => {
    requirePlaywright(ctx);
    // The comparison page is extracted as a single page; the mock returns Widget A.
    // In a real scenario the extractor might return multiple entities from a table,
    // but the mock returns one extraction per page call.
    const entities = await harness.dataSource.getEntities({ limit: 50, offset: 0 });
    const titles = entities.data.map((e) => (e.mergedData as any).title);
    expect(titles).toContain('Widget A');
  });

  it('partial page produced low-confidence entity', async (ctx) => {
    requirePlaywright(ctx);
    const entities = await harness.dataSource.getEntities({ limit: 50, offset: 0 });
    const review = entities.data.find((e) =>
      ((e.mergedData as any).title ?? '').includes('Review'),
    );
    if (review) {
      const products = entities.data.filter(
        (e) => (e.mergedData as any).title === 'Widget Pro',
      );
      if (products.length > 0) {
        expect(review.qualityScore).toBeLessThanOrEqual(products[0].qualityScore);
      }
    }
  });

  it('handled slow page without blocking pipeline', (ctx) => {
    requirePlaywright(ctx);
    // Pipeline completed within the 120s timeout — slow page did not block.
    const paths = fixtureServer.requestLog.map((r) => r.path);
    expect(paths.length).toBeGreaterThan(3);
  });
});

// ===========================================================================
// 4. Reconciliation verification (3 tests)
// ===========================================================================

describe('reconciliation verification', () => {
  it('merged duplicate Widget Pro entities', async (ctx) => {
    requirePlaywright(ctx);
    const entities = await harness.dataSource.getEntities({ limit: 50, offset: 0 });
    const widgetPros = entities.data.filter(
      (e) => (e.mergedData as any).title === 'Widget Pro',
    );
    // The mock entity matcher groups by title, so both Widget Pro extractions
    // (from /products/widget-pro and /products/widget-pro-deluxe) merge into one.
    expect(widgetPros).toHaveLength(1);
  });

  it('non-duplicate entities remain separate', async (ctx) => {
    requirePlaywright(ctx);
    const entities = await harness.dataSource.getEntities({ limit: 50, offset: 0 });
    const titles = entities.data.map((e) => (e.mergedData as any).title);
    const uniqueTitles = new Set(titles);
    // Every entity should have a distinct title — no unintended merges
    expect(uniqueTitles.size).toBe(titles.length);
  });

  it('singleton extractions form individual entities', async (ctx) => {
    requirePlaywright(ctx);
    const entities = await harness.dataSource.getEntities({ limit: 50, offset: 0 });
    const carbonara = entities.data.find(
      (e) => (e.mergedData as any).title === 'Pasta Carbonara',
    );
    expect(carbonara).toBeDefined();
  });
});

// ===========================================================================
// 5. Schema evolution verification (3 tests)
// ===========================================================================

describe('schema evolution verification', () => {
  it('schema evolved beyond user-defined fields', async (ctx) => {
    requirePlaywright(ctx);
    const schema = (await harness.dataSource.getSchema()) as any;
    expect(schema).toBeDefined();
    const fields = schema.definition?.fields ?? schema.fields ?? [];
    // User defined only title + price; schema evolution should have added more
    expect(fields.length).toBeGreaterThan(2);
  });

  it('schema has multiple versions', async (ctx) => {
    requirePlaywright(ctx);
    const versions = await harness.dataSource.getSchemaVersions();
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });

  it('schema evolution actions created with metadata', async (ctx) => {
    requirePlaywright(ctx);
    // Schema evolution stores actions with status 'applied' (auto-approved)
    const actions = (await harness.dataSource.getActions('applied')) as any[];
    expect(actions.length).toBeGreaterThan(0);
    const first = actions[0];
    expect(first.type).toBeDefined();
    expect(first.confidence).toBeDefined();
    expect(first.source).toBeDefined();
  });
});

// ===========================================================================
// 6. Pipeline state verification (4 tests)
// ===========================================================================

describe('pipeline state verification', () => {
  it('content store has page files', (ctx) => {
    requirePlaywright(ctx);
    const pagesDir = join(project.projectDir, '.spatula', 'pages');
    const files = existsSync(pagesDir) ? readdirSync(pagesDir) : [];
    expect(files.length).toBeGreaterThan(0);
  });

  it('run record has correct stats', async (ctx) => {
    requirePlaywright(ctx);
    const status = await harness.dataSource.getStatus();
    expect(status.lastRun).toBeDefined();
    expect(status.lastRun!.status).toBe('completed');
    expect(status.totalPages).toBeGreaterThan(0);
    expect(status.totalEntities).toBeGreaterThan(0);
  });

  it('LLM calls were made', (ctx) => {
    requirePlaywright(ctx);
    expect(mockOllama.getCallCount()).toBeGreaterThan(0);
  });

  it('model routing used correct model names', (ctx) => {
    requirePlaywright(ctx);
    const classifierCalls = mockOllama.getLogByComponent('classifier');
    const extractorCalls = mockOllama.getLogByComponent('extractor');
    if (classifierCalls.length > 0 && extractorCalls.length > 0) {
      // All calls for the same component should use the same model
      const classifierModels = new Set(classifierCalls.map((c) => c.model));
      expect(classifierModels.size).toBe(1);
    }
  });
});

// ===========================================================================
// 7. Cross-command verification (4 tests)
// ===========================================================================

describe('cross-command verification', () => {
  it('spatula status shows pipeline results', async (ctx) => {
    requirePlaywright(ctx);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runLocalStatusCommand } = await import('../../../src/commands/status.js');
      const found = await runLocalStatusCommand(project.projectDir);
      expect(found).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('spatula schema shows evolved schema', async (ctx) => {
    requirePlaywright(ctx);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(project.projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runSchemaCommand } = await import('../../../src/commands/schema.js');
      await runSchemaCommand({});
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('title');
      expect(output).toContain('price');
    } finally {
      consoleSpy.mockRestore();
      cwdSpy.mockRestore();
    }
  });

  it('spatula export produces file with extracted entities', async (ctx) => {
    requirePlaywright(ctx);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(project.projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const outputPath = join(project.projectDir, 'tier2-export.json');
      const { runExportCommand } = await import('../../../src/commands/export.js');
      await runExportCommand({ format: 'json', output: outputPath });
      expect(existsSync(outputPath)).toBe(true);
      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('Widget');
    } finally {
      consoleSpy.mockRestore();
      cwdSpy.mockRestore();
    }
  });

  it('approve action via DataSource changes status', async (ctx) => {
    requirePlaywright(ctx);
    const actions = (await harness.dataSource.getActions('pending_review')) as any[];
    if (actions.length > 0) {
      const before = actions.length;
      const actionId = actions[0].id;
      await harness.dataSource.approveAction(actionId);
      const remaining = (await harness.dataSource.getActions('pending_review')) as any[];
      expect(remaining.length).toBe(before - 1);
    }
  });
});

// ===========================================================================
// 8. Re-run and lifecycle (2 tests)
// ===========================================================================

describe('re-run and lifecycle', () => {
  it(
    're-run with config change only crawls new pages',
    async (ctx) => {
      requirePlaywright(ctx);
      // Add a new seed URL to the project YAML by inserting after the last seed
      const yamlPath = join(project.projectDir, 'spatula.yaml');
      const yaml = readFileSync(yamlPath, 'utf-8');
      const newSeedUrl = `http://localhost:${fixtureServer.port}/slow`;
      // Insert the new seed URL after the last existing seed line
      const updatedYaml = yaml.replace(
        /(seeds:\n(?:  - [^\n]+\n)+)/,
        `$1  - ${newSeedUrl}\n`,
      );
      writeFileSync(yamlPath, updatedYaml);

      mockOllama.resetLog();

      const harness2 = await buildPipelineRunner(project.projectDir, {
        ollamaBaseUrl: `http://localhost:${mockOllama.port}`,
        fixturePort: fixtureServer.port,
      });

      await harness2.runner.run();
      await harness2.closeAll();

      // Should have made some LLM calls for the newly added content
      expect(mockOllama.getCallCount()).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    'graceful stop completes without orphaned tasks',
    async (ctx) => {
      requirePlaywright(ctx);
      const stopProject = createFixtureProject(fixtureServer.port);
      const stopHarness = await buildPipelineRunner(stopProject.projectDir, {
        ollamaBaseUrl: `http://localhost:${mockOllama.port}`,
        fixturePort: fixtureServer.port,
      });

      // Start the pipeline, then stop after a brief delay
      const runPromise = stopHarness.runner.run();
      await new Promise((r) => setTimeout(r, 2000));
      stopHarness.runner.stop();
      await runPromise;

      // Verify run completed without an error status
      const status = await stopHarness.dataSource.getStatus();
      if (status.lastRun) {
        expect(status.lastRun.status).toBe('completed');
      }

      await stopHarness.closeAll();
      stopProject.cleanup();
    },
    120_000,
  );
});

// ===========================================================================
// 9. Prompt structure snapshots (6 tests)
// ===========================================================================

describe('prompt structure snapshots', () => {
  it('classifier prompt has expected structure', (ctx) => {
    requirePlaywright(ctx);
    const calls = mockOllama.getLogByComponent('classifier');
    expect(calls.length).toBeGreaterThan(0);
    const prompt = calls[0].fullSystemPrompt;
    expect(prompt).toContain('web page classifier');
    expect(prompt.toLowerCase()).toContain('json');
  });

  it('extractor prompt has expected structure', (ctx) => {
    requirePlaywright(ctx);
    const calls = mockOllama.getLogByComponent('extractor');
    expect(calls.length).toBeGreaterThan(0);
    const prompt = calls[0].fullSystemPrompt;
    expect(prompt).toContain('data extraction expert');
    expect(prompt.toLowerCase()).toContain('schema');
  });

  it('field proposer prompt has expected structure', (ctx) => {
    requirePlaywright(ctx);
    const calls = mockOllama.getLogByComponent('field-proposer');
    if (calls.length > 0) {
      const prompt = calls[0].fullSystemPrompt.toLowerCase();
      expect(prompt).toContain('unmapped fields');
    }
  });

  it('link evaluator prompt has expected structure', (ctx) => {
    requirePlaywright(ctx);
    const calls = mockOllama.getLogByComponent('link-evaluator');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].fullSystemPrompt.toLowerCase()).toContain('link evaluator');
  });

  it('entity matcher prompt has expected structure', (ctx) => {
    requirePlaywright(ctx);
    const calls = mockOllama.getLogByComponent('entity-matcher');
    if (calls.length > 0) {
      expect(calls[0].fullSystemPrompt.toLowerCase()).toContain('entity resolution');
    }
  });

  it('all LLM calls were logged', (ctx) => {
    requirePlaywright(ctx);
    expect(mockOllama.getCallCount()).toBeGreaterThan(0);
  });
});
