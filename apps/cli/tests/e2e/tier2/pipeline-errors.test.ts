/**
 * Tier 2 Pipeline Error Mode Tests — 5 tests, each running its own pipeline
 * with a specific LLM error injection mode.
 *
 * Validates that the pipeline degrades gracefully under various failure scenarios:
 *  1. Classifier malformed JSON -> page skipped, pipeline continues
 *  2. Extractor malformed JSON -> extraction skipped, pipeline continues
 *  3. Schema evolution Zod failure -> no broken actions
 *  4. All LLM calls fail -> crawl-only mode (pages stored, zero entities)
 *  5. Zero unmapped fields -> schema evolution skips FieldProposer LLM call
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
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

let playwrightOk = false;

beforeAll(async () => {
  playwrightOk = await isPlaywrightAvailable();
}, 30_000);

describe('LLM failure handling', () => {
  // =========================================================================
  // Test 1: Classifier malformed JSON -> page skipped, pipeline continues
  // =========================================================================

  it('classifier malformed JSON -> pipeline continues', async (ctx) => {
    if (!playwrightOk) {
      ctx.skip();
      return;
    }

    const fixtureServer = await startFixtureServer();
    const mockOllama = await startMockOllama({
      mode: 'malformed-json',
      failOnComponent: 'classifier',
      failOnNthCall: 1, // Fail on the FIRST classifier call
    });
    const project = createFixtureProject(fixtureServer.port);

    try {
      const harness = await buildPipelineRunner(project.projectDir, {
        ollamaBaseUrl: `http://localhost:${mockOllama.port}`,
        fixturePort: fixtureServer.port,
      });

      await harness.runner.run();

      // Pipeline should complete without crashing
      const status = await harness.dataSource.getStatus();
      expect(status.lastRun).toBeDefined();
      expect(status.lastRun!.status).toBe('completed');

      // Pages should still have been crawled
      expect(status.totalPages).toBeGreaterThan(0);

      await harness.closeAll();
    } finally {
      project.cleanup();
      await fixtureServer.close();
      await mockOllama.close();
    }
  }, 120_000);

  // =========================================================================
  // Test 2: Extractor malformed JSON -> extraction skipped, pipeline continues
  // =========================================================================

  it('extractor malformed JSON -> extraction skipped, pipeline continues', async (ctx) => {
    if (!playwrightOk) {
      ctx.skip();
      return;
    }

    const fixtureServer = await startFixtureServer();
    // Use malformed-json for extractor instead of timeout to avoid long waits
    const mockOllama = await startMockOllama({
      mode: 'malformed-json',
      failOnComponent: 'extractor',
      failOnNthCall: 1, // Fail on the FIRST extractor call
    });
    const project = createFixtureProject(fixtureServer.port);

    try {
      const harness = await buildPipelineRunner(project.projectDir, {
        ollamaBaseUrl: `http://localhost:${mockOllama.port}`,
        fixturePort: fixtureServer.port,
      });

      await harness.runner.run();

      // Pipeline should complete without crashing
      const status = await harness.dataSource.getStatus();
      expect(status.lastRun).toBeDefined();
      expect(status.lastRun!.status).toBe('completed');

      // Pages crawled, some entities may exist from other extractor calls that succeeded
      expect(status.totalPages).toBeGreaterThan(0);

      // Classifier calls should still have succeeded (only extractor was targeted)
      const classifierCalls = mockOllama.getLogByComponent('classifier');
      expect(classifierCalls.length).toBeGreaterThan(0);

      await harness.closeAll();
    } finally {
      project.cleanup();
      await fixtureServer.close();
      await mockOllama.close();
    }
  }, 120_000);

  // =========================================================================
  // Test 3: Schema evolution Zod failure -> no broken actions
  // =========================================================================

  it('schema evolution Zod failure -> no broken actions in DB', async (ctx) => {
    if (!playwrightOk) {
      ctx.skip();
      return;
    }

    const fixtureServer = await startFixtureServer();
    const mockOllama = await startMockOllama({
      mode: 'zod-failure',
      failOnComponent: 'field-proposer',
    });
    const project = createFixtureProject(fixtureServer.port);

    try {
      const harness = await buildPipelineRunner(project.projectDir, {
        ollamaBaseUrl: `http://localhost:${mockOllama.port}`,
        fixturePort: fixtureServer.port,
      });

      await harness.runner.run();

      // Pipeline should complete without crashing
      const status = await harness.dataSource.getStatus();
      expect(status.lastRun).toBeDefined();
      expect(status.lastRun!.status).toBe('completed');

      // Actions in DB (if any) should not have missing required fields.
      // Check all actions - 'applied' ones from schema evolution should be valid.
      const appliedActions = (await harness.dataSource.getActions('applied')) as any[];
      for (const action of appliedActions) {
        // Every action must have type, confidence, and source
        expect(action.type).toBeDefined();
        expect(action.confidence).toBeDefined();
        expect(action.source).toBeDefined();
      }

      // Also check pending_review actions
      const pendingActions = (await harness.dataSource.getActions('pending_review')) as any[];
      for (const action of pendingActions) {
        expect(action.type).toBeDefined();
        expect(action.confidence).toBeDefined();
        expect(action.source).toBeDefined();
      }

      await harness.closeAll();
    } finally {
      project.cleanup();
      await fixtureServer.close();
      await mockOllama.close();
    }
  }, 120_000);

  // =========================================================================
  // Test 4: All LLM calls fail -> crawl-only mode
  // =========================================================================

  it('all LLM calls fail -> pages stored, zero entities, run completed', async (ctx) => {
    if (!playwrightOk) {
      ctx.skip();
      return;
    }

    const fixtureServer = await startFixtureServer();
    const mockOllama = await startMockOllama({
      mode: 'malformed-json',
      // No failOnComponent = ALL components fail with malformed JSON
    });
    const project = createFixtureProject(fixtureServer.port);

    try {
      const harness = await buildPipelineRunner(project.projectDir, {
        ollamaBaseUrl: `http://localhost:${mockOllama.port}`,
        fixturePort: fixtureServer.port,
      });

      await harness.runner.run();

      // Pipeline should still complete (graceful degradation)
      const status = await harness.dataSource.getStatus();
      expect(status.lastRun).toBeDefined();
      expect(status.lastRun!.status).toBe('completed');

      // Pages should be stored in content store
      const pagesDir = join(project.projectDir, '.spatula', 'pages');
      const pageFiles = existsSync(pagesDir) ? readdirSync(pagesDir) : [];
      expect(pageFiles.length).toBeGreaterThan(0);

      // Zero entities because no extraction worked
      expect(status.totalEntities).toBe(0);

      // LLM calls were attempted (just all returned garbage)
      expect(mockOllama.getCallCount()).toBeGreaterThan(0);

      await harness.closeAll();
    } finally {
      project.cleanup();
      await fixtureServer.close();
      await mockOllama.close();
    }
  }, 120_000);

  // =========================================================================
  // Test 5: Zero unmapped fields -> schema evolution skips FieldProposer
  // =========================================================================

  it('zero unmapped fields -> field-proposer never called or returns early', async (ctx) => {
    if (!playwrightOk) {
      ctx.skip();
      return;
    }

    const fixtureServer = await startFixtureServer();
    const mockOllama = await startMockOllama({
      mode: 'happy',
      emptyUnmapped: true, // Extractor always returns _unmapped: []
    });
    const project = createFixtureProject(fixtureServer.port);

    try {
      const harness = await buildPipelineRunner(project.projectDir, {
        ollamaBaseUrl: `http://localhost:${mockOllama.port}`,
        fixturePort: fixtureServer.port,
      });

      await harness.runner.run();

      // Pipeline should complete successfully
      const status = await harness.dataSource.getStatus();
      expect(status.lastRun).toBeDefined();
      expect(status.lastRun!.status).toBe('completed');

      // Field-proposer should never have been called (no unmapped fields to propose)
      const fieldProposerCalls = mockOllama.getLogByComponent('field-proposer');
      expect(fieldProposerCalls).toHaveLength(0);

      // Extraction should still have produced entities
      expect(status.totalEntities).toBeGreaterThan(0);

      await harness.closeAll();
    } finally {
      project.cleanup();
      await fixtureServer.close();
      await mockOllama.close();
    }
  }, 120_000);
});
