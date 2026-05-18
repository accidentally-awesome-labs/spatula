/**
 * Integration tests for CLI project commands.
 *
 * Uses a REAL SQLite database with seeded data — no mocks for file I/O or DataSource.
 * Verifies the full pipeline: command -> openLocalProject -> DataSource -> SQLite -> formatted output.
 *
 * Commands tested:
 *   1. spatula status   (local mode)
 *   2. spatula estimate (cost estimation from real config)
 *   3. spatula doctor   (health checks framework)
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createProjectDb, initializeProjectDb, ProjectAdapter } from '@spatula/db';
import { slugifyPath } from '../../src/local-project.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

let projectDir: string;
let PROJECT_ID: string;

beforeAll(async () => {
  // 1. Create temp project directory
  projectDir = mkdtempSync(join(tmpdir(), 'spatula-project-cmds-'));
  // Derive the same projectId that openLocalProject will compute
  PROJECT_ID = slugifyPath(projectDir);

  // 2. Write spatula.yaml
  writeFileSync(
    join(projectDir, 'spatula.yaml'),
    `name: Project Commands Test
description: Integration testing
seeds:
  - https://example.com
  - https://test.com
depth: 2
limit: 100
`,
  );

  // 3. Create and seed database
  const dbDir = join(projectDir, '.spatula');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'project.db');
  const { db, close } = createProjectDb(dbPath);
  initializeProjectDb(db, { projectId: PROJECT_ID, name: 'Project Commands Test' });

  const adapter = new ProjectAdapter(db, PROJECT_ID);

  // Seed schema v1
  await adapter.schemaRepo.create({
    jobId: PROJECT_ID,
    tenantId: PROJECT_ID,
    version: 1,
    definition: {
      version: 1,
      fields: [
        { name: 'title', type: 'string', required: true, description: 'Title' },
        { name: 'price', type: 'currency', required: false, description: 'Price' },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-03-28'),
      parentVersion: null,
    },
  });

  // Seed entities
  for (let i = 0; i < 5; i++) {
    await adapter.entityRepo.create({
      jobId: PROJECT_ID,
      tenantId: PROJECT_ID,
      mergedData: { title: `Item ${i + 1}`, price: 10 + i },
      provenance: {},
      qualityScore: 0.8,
    });
  }

  // Seed a completed run
  await adapter.runRepo.create({
    status: 'completed',
    source: 'local',
    configSnapshot: { name: 'test' },
    startedAt: '2026-03-30T10:00:00Z',
  });

  // Seed pending action
  await adapter.actionRepo.create({
    jobId: PROJECT_ID,
    tenantId: PROJECT_ID,
    type: 'add_field',
    payload: { field: { name: 'brand', type: 'string' } },
    source: 'schema_evolution',
    status: 'pending_review',
    confidence: 0.9,
    reasoning: 'Common field',
  });

  // Close DB so commands can open it fresh
  close();
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. spatula status (integration)
// ---------------------------------------------------------------------------

describe('spatula status (integration)', () => {
  it('displays local project status from real database', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runLocalStatusCommand } = await import('../../src/commands/status.js');
    const found = await runLocalStatusCommand(projectDir);

    expect(found).toBe(true);
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Should show entity count
    expect(output).toContain('5');
    // Should show project root path
    expect(output).toContain(projectDir);
    // Should show "completed" from the seeded run
    expect(output).toContain('completed');

    consoleSpy.mockRestore();
  });

  it('returns false for directory without spatula.yaml', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'spatula-nostatus-'));
    try {
      const { runLocalStatusCommand } = await import('../../src/commands/status.js');
      const found = await runLocalStatusCommand(emptyDir);
      expect(found).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('shows pending action count', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runLocalStatusCommand } = await import('../../src/commands/status.js');
    await runLocalStatusCommand(projectDir);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // We seeded 1 pending action
    expect(output).toContain('Pending actions');

    consoleSpy.mockRestore();
  });

  it('shows last run details', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runLocalStatusCommand } = await import('../../src/commands/status.js');
    await runLocalStatusCommand(projectDir);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Last run');
    expect(output).toContain('completed');

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 2. spatula estimate (integration)
// ---------------------------------------------------------------------------

describe('spatula estimate (integration)', () => {
  it('estimates cost from real project config', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runEstimateCommand } = await import('../../src/commands/estimate.js');
    await runEstimateCommand();

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Should show cost breakdown with dollar amounts
    expect(output).toContain('Cost Estimate');
    expect(output).toContain('$');
    // Should show estimated pages
    expect(output).toContain('Estimated pages');
    // Should show total tokens
    expect(output).toContain('Total tokens');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('shows LLM call breakdown table', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runEstimateCommand } = await import('../../src/commands/estimate.js');
    await runEstimateCommand();

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Should show breakdown header
    expect(output).toContain('Breakdown');
    // Should show table columns
    expect(output).toContain('Task');
    expect(output).toContain('Model');
    expect(output).toContain('Calls');
    expect(output).toContain('Cost');
    // Should show confidence level
    expect(output).toContain('Confidence');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('fails gracefully when no spatula.yaml found', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'spatula-noestimate-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(emptyDir);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    const { runEstimateCommand } = await import('../../src/commands/estimate.js');
    await expect(runEstimateCommand()).rejects.toThrow('process.exit called');

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('No spatula.yaml found');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 3. spatula doctor (integration)
// ---------------------------------------------------------------------------

describe('spatula doctor (integration)', () => {
  it('runs system and project checks for a valid project', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runDoctorCommand } = await import('../../src/commands/doctor.js');
    await runDoctorCommand();

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Should contain check results
    expect(output).toContain('Spatula Doctor');
    // Should detect project context
    expect(output).toContain('inside project');
    // Should run system checks
    expect(output).toContain('SYSTEM CHECKS');
    // Should show summary with check count
    expect(output).toMatch(/\d+ checks:/);

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('runs project checks when spatula.yaml is present', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runDoctorCommand } = await import('../../src/commands/doctor.js');
    await runDoctorCommand();

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Should run project checks since spatula.yaml exists
    expect(output).toContain('PROJECT CHECKS');
    // The spatula.yaml check should pass since we wrote a valid one
    expect(output).toContain('spatula.yaml');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('shows node version check result', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runDoctorCommand } = await import('../../src/commands/doctor.js');
    await runDoctorCommand();

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Node version check should show the version
    expect(output).toContain('Node.js');

    consoleSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('determineCategoriesFromContext returns correct categories', async () => {
    const { determineCategoriesFromContext } = await import('../../src/commands/doctor.js');

    // No env, no project
    expect(determineCategoriesFromContext({ hasEnv: false, hasProject: false })).toEqual([
      'system',
    ]);

    // With env file
    expect(determineCategoriesFromContext({ hasEnv: true, hasProject: false })).toEqual([
      'system',
      'server',
    ]);

    // With project
    expect(determineCategoriesFromContext({ hasEnv: false, hasProject: true })).toEqual([
      'system',
      'project',
    ]);

    // Both
    expect(determineCategoriesFromContext({ hasEnv: true, hasProject: true })).toEqual([
      'system',
      'server',
      'project',
    ]);
  });

  it('formatCheckResults produces readable output', async () => {
    const { formatCheckResults } = await import('../../src/commands/doctor.js');

    const results = [
      {
        name: 'test-pass',
        category: 'system' as const,
        status: 'pass' as const,
        message: 'All good',
      },
      {
        name: 'test-warn',
        category: 'system' as const,
        status: 'warn' as const,
        message: 'Minor issue',
      },
      {
        name: 'test-fail',
        category: 'project' as const,
        status: 'fail' as const,
        message: 'Critical',
      },
    ];

    const output = formatCheckResults(results);
    expect(output).toContain('PASS');
    expect(output).toContain('WARN');
    expect(output).toContain('FAIL');
    expect(output).toContain('All good');
    expect(output).toContain('Minor issue');
    expect(output).toContain('Critical');
    expect(output).toContain('3 checks: 1 passed, 1 warnings, 1 failed');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: formatLocalStatus
// ---------------------------------------------------------------------------

describe('formatLocalStatus (unit)', () => {
  it('formats status with last run info', async () => {
    const { formatLocalStatus } = await import('../../src/commands/status.js');

    const output = formatLocalStatus(
      {
        totalPages: 10,
        totalEntities: 25,
        pendingActions: 3,
        schemaFields: 5,
        lastRun: {
          id: 'run-123',
          status: 'completed',
          startedAt: '2026-03-30T10:00:00Z',
          pagesProcessed: 10,
          entitiesCreated: 25,
        },
        storageBytes: { pages: 0, database: 0, exports: 0 },
      },
      '/tmp/my-project',
    );

    expect(output).toContain('/tmp/my-project');
    expect(output).toContain('25');
    expect(output).toContain('10');
    expect(output).toContain('run-123');
    expect(output).toContain('completed');
  });

  it('formats status without any runs', async () => {
    const { formatLocalStatus } = await import('../../src/commands/status.js');

    const output = formatLocalStatus(
      {
        totalPages: 0,
        totalEntities: 0,
        pendingActions: 0,
        schemaFields: 0,
        storageBytes: { pages: 0, database: 0, exports: 0 },
      },
      '/tmp/empty-project',
    );

    expect(output).toContain('No runs recorded yet');
    expect(output).toContain('/tmp/empty-project');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: formatCostEstimate
// ---------------------------------------------------------------------------

describe('formatCostEstimate (unit)', () => {
  it('formats a cost estimate with breakdown', async () => {
    const { formatCostEstimate } = await import('../../src/commands/estimate.js');

    const output = formatCostEstimate({
      estimatedPages: 50,
      totalTokens: 125000,
      totalCostUsd: 0.45,
      confidence: 'medium',
      llmCallBreakdown: [
        { purpose: 'extraction', model: 'claude-sonnet', calls: 35, tokens: 80000, costUsd: 0.3 },
        {
          purpose: 'pageRelevance',
          model: 'claude-haiku',
          calls: 50,
          tokens: 45000,
          costUsd: 0.15,
        },
      ],
      warnings: [],
    });

    expect(output).toContain('Cost Estimate');
    expect(output).toContain('50');
    expect(output).toContain('125,000');
    expect(output).toContain('$0.450');
    expect(output).toContain('medium');
    expect(output).toContain('extraction');
    expect(output).toContain('pageRelevance');
  });

  it('includes warnings when present', async () => {
    const { formatCostEstimate } = await import('../../src/commands/estimate.js');

    const output = formatCostEstimate({
      estimatedPages: 10,
      totalTokens: 5000,
      totalCostUsd: 0.01,
      confidence: 'low',
      llmCallBreakdown: [],
      warnings: ['No model pricing data available', 'Depth may exceed limits'],
    });

    expect(output).toContain('Warnings');
    expect(output).toContain('No model pricing data available');
    expect(output).toContain('Depth may exceed limits');
  });
});
