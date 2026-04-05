/**
 * Tier 2 Pipeline Tests with Real Ollama — 6 tests sharing a single pipeline run.
 *
 * These tests mirror the mock-LLM pipeline tests but use a real Ollama instance
 * at http://localhost:11434. Because real LLM output is nondeterministic, all
 * assertions are structural (no exact field names, values, or counts).
 *
 * Skipped entirely if either Playwright or Ollama is unavailable.
 * Has a 5-minute timeout for real inference.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';
import {
  createFixtureProject,
  buildPipelineRunner,
  isPlaywrightAvailable,
  isOllamaAvailable,
  type FixtureProject,
  type PipelineTestHarness,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Shared state — populated once in beforeAll
// ---------------------------------------------------------------------------

let canRun = false;
let fixtureServer: FixtureServer;
let project: FixtureProject;
let harness: PipelineTestHarness;

beforeAll(async () => {
  const [pw, ollama] = await Promise.all([
    isPlaywrightAvailable(),
    isOllamaAvailable(),
  ]);
  canRun = pw && ollama;
  if (!canRun) return;

  fixtureServer = await startFixtureServer();
  project = createFixtureProject(fixtureServer.port);
  harness = await buildPipelineRunner(project.projectDir, {
    ollamaBaseUrl: 'http://localhost:11434',
    fixturePort: fixtureServer.port,
  });

  await harness.runner.run();
}, 300_000);

afterAll(async () => {
  if (harness) await harness.closeAll();
  if (project) project.cleanup();
  if (fixtureServer) await fixtureServer.close();
});

// ===========================================================================
// Full pipeline with real Ollama (6 tests)
// ===========================================================================

describe('full pipeline with real Ollama', () => {
  it('pipeline completes', (ctx) => {
    if (!canRun) { ctx.skip(); return; }
    expect(harness).toBeDefined();
  });

  it('entities created', async (ctx) => {
    if (!canRun) { ctx.skip(); return; }
    const status = await harness.dataSource.getStatus();
    expect(status.totalEntities).toBeGreaterThan(0);
  });

  it('schema has fields', async (ctx) => {
    if (!canRun) { ctx.skip(); return; }
    const schema = await harness.dataSource.getSchema() as any;
    expect(schema).toBeDefined();
    const fields = schema?.definition?.fields ?? schema?.fields ?? [];
    expect(fields.length).toBeGreaterThan(0);
  });

  it('run record complete', async (ctx) => {
    if (!canRun) { ctx.skip(); return; }
    const status = await harness.dataSource.getStatus();
    expect(status.lastRun?.status).toBe('completed');
  });

  it('about page likely skipped', async (ctx) => {
    if (!canRun) { ctx.skip(); return; }
    const entities = await harness.dataSource.getEntities({ limit: 50, offset: 0 });
    const aboutEntities = entities.data.filter(e => {
      const data = e.mergedData as Record<string, unknown>;
      return Object.values(data).some(v =>
        typeof v === 'string' && v.toLowerCase().includes('company history')
      );
    });
    expect(aboutEntities).toHaveLength(0);
  });

  it('at least one entity has price-like data', async (ctx) => {
    if (!canRun) { ctx.skip(); return; }
    const entities = await harness.dataSource.getEntities({ limit: 50, offset: 0 });
    const hasPrice = entities.data.some(e => {
      const data = e.mergedData as Record<string, unknown>;
      return Object.values(data).some(v =>
        typeof v === 'string'
          ? (v.includes('$') || v.includes('29') || v.includes('19'))
          : typeof v === 'number'
      );
    });
    expect(hasPrice).toBe(true);
  });
});
