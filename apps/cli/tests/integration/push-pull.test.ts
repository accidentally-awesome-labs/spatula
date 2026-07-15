/**
 * Integration tests for push/pull flow.
 *
 * Uses a REAL SQLite database — mocks only the remote API (fetch) and
 * loadGlobalConfig.  After each command, queries the DB to verify that
 * entities, runs, schema, and meta were persisted correctly.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import {
  createProjectDb,
  initializeProjectDb,
  ProjectAdapter,
} from '@accidentally-awesome-labs/spatula-db';
import type { GlobalConfig } from '@accidentally-awesome-labs/spatula-core';
import { slugifyPath } from '../../src/local-project.js';

// ---------------------------------------------------------------------------
// Mock @accidentally-awesome-labs/spatula-core — loadGlobalConfig returns a remote config;
// parseProjectYamlFile / yamlToJobConfig return deterministic stubs.
// ---------------------------------------------------------------------------

vi.mock('@accidentally-awesome-labs/spatula-core', async () => {
  const actual = await vi.importActual<typeof import('@accidentally-awesome-labs/spatula-core')>(
    '@accidentally-awesome-labs/spatula-core',
  );
  return {
    ...actual,
    loadGlobalConfig: vi.fn(
      () =>
        ({
          version: 1,
          remotes: {
            prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live_abc' },
          },
        }) as GlobalConfig,
    ),
    parseProjectYamlFile: vi.fn(() => ({
      name: 'integration-test',
      seeds: ['https://example.com'],
      depth: 2,
      limit: 50,
    })),
    yamlToJobConfig: vi.fn(() => ({
      tenantId: '',
      name: 'integration-test',
      seedUrls: ['https://example.com'],
      crawl: { maxDepth: 2, maxPages: 50, concurrency: 5, crawlerType: 'playwright' },
      schema: { mode: 'discovery' },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
    })),
  };
});

// ---------------------------------------------------------------------------
// Shared fixture — temp directory + real SQLite DB
// ---------------------------------------------------------------------------

let projectDir: string;
let PROJECT_ID: string;
let dbPath: string;

function openDb() {
  const { db, close } = createProjectDb(dbPath);
  const adapter = new ProjectAdapter(db, PROJECT_ID);
  return { db, close, adapter };
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'spatula-push-pull-'));
  PROJECT_ID = slugifyPath(projectDir);

  writeFileSync(
    join(projectDir, 'spatula.yaml'),
    `name: Push Pull Integration Test
description: Testing push and pull commands
seeds:
  - https://example.com
`,
  );

  const dbDir = join(projectDir, '.spatula');
  mkdirSync(dbDir, { recursive: true });
  dbPath = join(dbDir, 'project.db');
  const { db, close } = createProjectDb(dbPath);
  initializeProjectDb(db, { projectId: PROJECT_ID, name: 'Push Pull Test' });
  close();
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function stubFetchRouted(overrides: Record<string, () => unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();
      const method = init?.method ?? 'GET';

      // Allow per-test overrides keyed on partial URL match
      for (const [pattern, handler] of Object.entries(overrides)) {
        if (urlStr.includes(pattern)) {
          return handler();
        }
      }

      // Job creation (POST to /jobs)
      if (urlStr.match(/\/jobs\/?$/) && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'pending' } }),
        };
      }

      // Job start
      if (urlStr.includes('/start')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'running' } }),
        };
      }

      // Job status (GET /jobs/:id — not /entities, /schema)
      if (urlStr.match(/\/jobs\/[^/]+\/?$/) && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: { id: 'remote-job-1', status: 'completed', stats: { pagesProcessed: 10 } },
            }),
        };
      }

      // Schema
      if (urlStr.includes('/schema')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                version: 1,
                fields: [
                  { name: 'title', type: 'string', required: true, description: 'Product title' },
                  {
                    name: 'price',
                    type: 'currency',
                    required: false,
                    description: 'Product price',
                  },
                ],
                fieldAliases: [],
                createdAt: '2026-03-20',
                parentVersion: null,
              },
            }),
        };
      }

      // Entities
      if (urlStr.includes('/entities')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: [
                {
                  id: 'remote-e1',
                  mergedData: { title: 'Remote Product A', price: 19.99 },
                  provenance: { title: { source: 'crawl' } },
                  categories: ['product'],
                  qualityScore: 0.95,
                },
                {
                  id: 'remote-e2',
                  mergedData: { title: 'Remote Product B', price: 29.99 },
                  provenance: { title: { source: 'crawl' } },
                  categories: ['product'],
                  qualityScore: 0.88,
                },
              ],
              pagination: { hasMore: false, total: 2 },
            }),
        };
      }

      // Usage
      if (urlStr.includes('/usage')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                period: { start: '2026-03-01', end: '2026-03-31' },
                totalTokens: 2000,
                totalCostUsd: 0.1,
                byModel: {},
                byPurpose: {},
                byJob: [{ jobId: 'remote-job-1', tokens: 2000, costUsd: 0.1 }],
              },
            }),
        };
      }

      // Fallback
      return { ok: true, status: 200, json: () => Promise.resolve({ data: {} }) };
    }),
  );
}

// ---------------------------------------------------------------------------
// Push tests
// ---------------------------------------------------------------------------

describe('Push integration', () => {
  it('creates a job on the remote and stores link in project_meta', async () => {
    const { close, adapter } = openDb();

    try {
      stubFetchRouted();

      const { runPushCommand } = await import('../../src/commands/push.js');
      const result = await runPushCommand({
        remoteName: 'prod',
        projectRoot: projectDir,
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        autoStart: false,
      });

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('remote-job-1');

      // Verify DB state
      const storedJobId = await adapter.metaRepo.get('remote:prod:job_id');
      expect(storedJobId).toBe('remote-job-1');

      const pushedAt = await adapter.metaRepo.get('remote:prod:pushed_at');
      expect(pushedAt).toBeTruthy();

      const configHash = await adapter.metaRepo.get('remote:prod:config_hash');
      expect(configHash).toMatch(/^[a-f0-9]{12}$/);
    } finally {
      close();
    }
  });

  it('detects existing active job (conflict)', async () => {
    const { close, adapter } = openDb();

    try {
      // Seed an existing job ID in meta
      await adapter.metaRepo.set('remote:prod:job_id', 'existing-running-job');

      stubFetchRouted({
        // GET job status returns running
        '/jobs/existing-running-job': () => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { id: 'existing-running-job', status: 'running' } }),
        }),
      });

      const { runPushCommand } = await import('../../src/commands/push.js');
      const result = await runPushCommand({
        remoteName: 'prod',
        projectRoot: projectDir,
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        autoStart: false,
      });

      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.existingJobId).toBe('existing-running-job');
      expect(result.existingJobStatus).toBe('running');
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// Pull tests
// ---------------------------------------------------------------------------

describe('Pull integration', () => {
  beforeEach(async () => {
    // Ensure a clean job_id is set so pull knows what to fetch
    const { close, adapter } = openDb();
    try {
      await adapter.metaRepo.set('remote:prod:job_id', 'remote-job-1');
      // Clean up any leftover pull state
      await adapter.metaRepo.delete('remote:prod:last_pull_at');
      await adapter.metaRepo.delete('remote:prod:pull_cursor');
    } finally {
      close();
    }
  });

  it('fetches entities from remote and stores them in local SQLite DB', async () => {
    const { close, adapter } = openDb();

    try {
      stubFetchRouted();

      const { runPullCommand } = await import('../../src/commands/pull.js');
      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        metaDelete: (key) => adapter.metaRepo.delete(key),
        adapter: adapter as unknown as Parameters<typeof runPullCommand>[0]['adapter'],
        projectId: PROJECT_ID,
        projectRoot: projectDir,
        skipSchema: true,
      });

      expect(result.success).toBe(true);
      expect(result.entitiesInserted).toBe(2);
      expect(result.entitiesUpdated).toBe(0);

      // Verify entities in DB
      const entitiesInDb = (await adapter.entityRepo.findByJob(PROJECT_ID, PROJECT_ID)) as Array<{
        id: string;
        mergedData: Record<string, unknown>;
        qualityScore: number;
      }>;
      const pulledEntities = entitiesInDb.filter(
        (e) => e.id === 'remote-e1' || e.id === 'remote-e2',
      );
      expect(pulledEntities).toHaveLength(2);
      expect(pulledEntities.find((e) => e.id === 'remote-e1')!.mergedData).toEqual({
        title: 'Remote Product A',
        price: 19.99,
      });

      // Verify last_pull_at meta
      const lastPullAt = await adapter.metaRepo.get('remote:prod:last_pull_at');
      expect(lastPullAt).toBeTruthy();

      // Verify run record
      const run = await adapter.runRepo.findLatestByStatus(['pulled']);
      expect(run).not.toBeNull();
      expect(run!.source).toBe('remote:prod:remote-job-1');
    } finally {
      close();
    }
  });

  it('pulls with schema — remote schema is saved to local DB', async () => {
    const { close, adapter } = openDb();

    try {
      stubFetchRouted();

      const { runPullCommand } = await import('../../src/commands/pull.js');
      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        metaDelete: (key) => adapter.metaRepo.delete(key),
        adapter: adapter as unknown as Parameters<typeof runPullCommand>[0]['adapter'],
        projectId: PROJECT_ID,
        projectRoot: projectDir,
        // Not skipping schema
      });

      expect(result.success).toBe(true);
      expect(result.schemaFieldsAdded).toBe(2); // title + price

      // Verify schema in DB
      const schema = await adapter.schemaRepo.findLatest(PROJECT_ID, PROJECT_ID);
      expect(schema).not.toBeNull();
      expect(schema!.version).toBe(1);
      const def = schema!.definition as { fields: Array<{ name: string }> };
      const fieldNames = def.fields.map((f) => f.name);
      expect(fieldNames).toContain('title');
      expect(fieldNames).toContain('price');
    } finally {
      close();
    }
  });

  it('incremental pull — second pull sends since param', async () => {
    const { close, adapter } = openDb();

    try {
      // Set a previous pull timestamp to trigger incremental mode
      const pastDate = '2026-03-25T10:00:00.000Z';
      await adapter.metaRepo.set('remote:prod:last_pull_at', pastDate);

      let capturedUrl = '';
      stubFetchRouted({
        '/entities': () => {
          // The entities URL will include the since parameter for incremental pull
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: [
                  {
                    id: 'remote-e3',
                    mergedData: { title: 'New Product' },
                    provenance: {},
                    categories: ['product'],
                    qualityScore: 0.9,
                  },
                ],
                pagination: { hasMore: false, total: 1 },
              }),
          };
        },
      });

      // Capture the fetch calls to verify since param
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn(originalFetch);
      vi.stubGlobal('fetch', fetchSpy);

      const { runPullCommand } = await import('../../src/commands/pull.js');
      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        metaDelete: (key) => adapter.metaRepo.delete(key),
        adapter: adapter as unknown as Parameters<typeof runPullCommand>[0]['adapter'],
        projectId: PROJECT_ID,
        projectRoot: projectDir,
        skipSchema: true,
      });

      expect(result.success).toBe(true);
      expect(result.entitiesInserted).toBe(1);

      // Verify the entities URL included the since parameter
      const entityCall = fetchSpy.mock.calls.find((call) =>
        (call[0] as string).includes('/entities'),
      );
      expect(entityCall).toBeDefined();
      capturedUrl = entityCall![0] as string;
      expect(capturedUrl).toContain('since=');

      // Verify last_pull_at was updated (should be newer than pastDate)
      const newLastPull = await adapter.metaRepo.get('remote:prod:last_pull_at');
      expect(newLastPull).toBeTruthy();
      expect(new Date(newLastPull!).getTime()).toBeGreaterThan(new Date(pastDate).getTime());
    } finally {
      close();
    }
  });

  it('pull with --full flag — clears old entities before pulling fresh', async () => {
    const { close, adapter } = openDb();

    try {
      // First, seed some existing "pulled" entities via a run
      const existingRun = await adapter.runRepo.create({
        status: 'pulled',
        source: 'remote:prod:remote-job-1',
        configSnapshot: { remote: 'prod' },
        startedAt: '2026-03-25T10:00:00Z',
      });
      await adapter.entityRepo.upsertBatch([
        {
          id: 'old-entity-1',
          mergedData: { title: 'Old Product' },
          provenance: {},
          qualityScore: 0.8,
          categories: ['product'],
          runId: existingRun.id,
        },
      ]);

      // Confirm old entity exists
      const beforeCount = await adapter.entityRepo.countByJob(PROJECT_ID, PROJECT_ID);
      const beforePulled = (
        (await adapter.entityRepo.findByJob(PROJECT_ID, PROJECT_ID)) as Array<{ id: string }>
      ).filter((e) => e.id === 'old-entity-1');
      expect(beforePulled).toHaveLength(1);

      stubFetchRouted();

      const { runPullCommand } = await import('../../src/commands/pull.js');
      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        metaDelete: (key) => adapter.metaRepo.delete(key),
        adapter: adapter as unknown as Parameters<typeof runPullCommand>[0]['adapter'],
        projectId: PROJECT_ID,
        projectRoot: projectDir,
        full: true,
        skipSchema: true,
      });

      expect(result.success).toBe(true);
      expect(result.entitiesInserted).toBe(2);

      // Verify old entity was cleared and new ones exist
      const remaining = (
        (await adapter.entityRepo.findByJob(PROJECT_ID, PROJECT_ID)) as Array<{ id: string }>
      ).filter((e) => e.id === 'old-entity-1');
      expect(remaining).toHaveLength(0);

      // New entities should be present
      const newEntities = (
        (await adapter.entityRepo.findByJob(PROJECT_ID, PROJECT_ID)) as Array<{ id: string }>
      ).filter((e) => e.id === 'remote-e1' || e.id === 'remote-e2');
      expect(newEntities).toHaveLength(2);
    } finally {
      close();
    }
  });

  it('pull with --restart clears interrupted cursor', async () => {
    const { close, adapter } = openDb();

    try {
      // Set up a stale cursor from a previous interrupted pull
      await adapter.metaRepo.set('remote:prod:pull_cursor', 'stale-cursor-abc');

      stubFetchRouted();

      const { runPullCommand } = await import('../../src/commands/pull.js');
      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        metaDelete: (key) => adapter.metaRepo.delete(key),
        adapter: adapter as unknown as Parameters<typeof runPullCommand>[0]['adapter'],
        projectId: PROJECT_ID,
        projectRoot: projectDir,
        restart: true,
        skipSchema: true,
      });

      expect(result.success).toBe(true);
      expect(result.resumed).toBe(false);

      // Cursor should be fully cleared after successful pull
      const cursor = await adapter.metaRepo.get('remote:prod:pull_cursor');
      expect(cursor).toBeNull();
    } finally {
      close();
    }
  });

  it('pull interrupted mid-batch — cursor is preserved in project_meta for resume', async () => {
    const { close, adapter } = openDb();

    try {
      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
          const urlStr = url.toString();
          const method = init?.method ?? 'GET';

          // Job status
          if (urlStr.match(/\/jobs\/[^/]+\/?$/) && method === 'GET') {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
            };
          }

          // Entities — first batch succeeds, second throws (simulating network failure)
          if (urlStr.includes('/entities')) {
            callCount++;
            if (callCount === 1) {
              return {
                ok: true,
                status: 200,
                json: () =>
                  Promise.resolve({
                    data: [
                      {
                        id: 'batch1-e1',
                        mergedData: { title: 'Batch 1' },
                        provenance: {},
                        categories: [],
                        qualityScore: 0.9,
                      },
                    ],
                    pagination: { nextCursor: 'cursor-page2', hasMore: true, total: 3 },
                  }),
              };
            }
            // Second call — network error
            throw new Error('Network connection lost');
          }

          // Usage (might not be reached)
          if (urlStr.includes('/usage')) {
            return { ok: true, status: 200, json: () => Promise.resolve({ data: { byJob: [] } }) };
          }

          return { ok: true, status: 200, json: () => Promise.resolve({ data: {} }) };
        }),
      );

      const { runPullCommand } = await import('../../src/commands/pull.js');
      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        metaDelete: (key) => adapter.metaRepo.delete(key),
        adapter: adapter as unknown as Parameters<typeof runPullCommand>[0]['adapter'],
        projectId: PROJECT_ID,
        projectRoot: projectDir,
        skipSchema: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Pull interrupted');
      expect(result.entitiesInserted).toBe(1);

      // Cursor should be preserved for resume
      const cursor = await adapter.metaRepo.get('remote:prod:pull_cursor');
      expect(cursor).toBe('cursor-page2');

      // The first batch entity should be in the DB
      const entities = (await adapter.entityRepo.findByJob(PROJECT_ID, PROJECT_ID)) as Array<{
        id: string;
      }>;
      const batch1 = entities.filter((e) => e.id === 'batch1-e1');
      expect(batch1).toHaveLength(1);
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: push -> pull roundtrip
// ---------------------------------------------------------------------------

describe('Push -> Pull roundtrip', () => {
  it('push a config, then pull back entities — verify local DB matches', async () => {
    // Use a fresh DB area by cleaning existing meta for a clean roundtrip
    const { close, adapter } = openDb();

    try {
      // Clean up any previous state
      await adapter.metaRepo.delete('remote:prod:job_id');
      await adapter.metaRepo.delete('remote:prod:pushed_at');
      await adapter.metaRepo.delete('remote:prod:config_hash');
      await adapter.metaRepo.delete('remote:prod:last_pull_at');
      await adapter.metaRepo.delete('remote:prod:pull_cursor');

      // --- Step 1: Push ---
      stubFetchRouted();

      const { runPushCommand } = await import('../../src/commands/push.js');
      const pushResult = await runPushCommand({
        remoteName: 'prod',
        projectRoot: projectDir,
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        autoStart: false,
      });

      expect(pushResult.success).toBe(true);
      expect(pushResult.jobId).toBe('remote-job-1');

      // Verify push stored job link
      const linkedJob = await adapter.metaRepo.get('remote:prod:job_id');
      expect(linkedJob).toBe('remote-job-1');

      // --- Step 2: Pull ---
      // Re-stub fetch with unique entity IDs so this test isn't affected by earlier inserts
      vi.unstubAllGlobals();
      stubFetchRouted({
        '/entities': () => ({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: [
                {
                  id: 'roundtrip-e1',
                  mergedData: { title: 'Roundtrip Product X', price: 49.99 },
                  provenance: { title: { source: 'crawl' } },
                  categories: ['product'],
                  qualityScore: 0.92,
                },
                {
                  id: 'roundtrip-e2',
                  mergedData: { title: 'Roundtrip Product Y', price: 59.99 },
                  provenance: { title: { source: 'crawl' } },
                  categories: ['product'],
                  qualityScore: 0.85,
                },
              ],
              pagination: { hasMore: false, total: 2 },
            }),
        }),
      });

      const { runPullCommand } = await import('../../src/commands/pull.js');
      const pullResult = await runPullCommand({
        remoteName: 'prod',
        metaGet: (key) => adapter.metaRepo.get(key),
        metaSet: (key, value) => adapter.metaRepo.set(key, value),
        metaDelete: (key) => adapter.metaRepo.delete(key),
        adapter: adapter as unknown as Parameters<typeof runPullCommand>[0]['adapter'],
        projectId: PROJECT_ID,
        projectRoot: projectDir,
        skipSchema: true, // Schema tested separately; keeps roundtrip focused on entity flow
      });

      expect(pullResult.success).toBe(true);
      expect(pullResult.entitiesInserted).toBe(2);
      expect(pullResult.llmTokens).toBe(2000);
      expect(pullResult.llmCostUsd).toBe(0.1);

      // --- Step 3: Verify DB state ---

      // Entities exist
      const allEntities = (await adapter.entityRepo.findByJob(PROJECT_ID, PROJECT_ID)) as Array<{
        id: string;
        mergedData: Record<string, unknown>;
        qualityScore: number;
      }>;
      const pulledEntities = allEntities.filter(
        (e) => e.id === 'roundtrip-e1' || e.id === 'roundtrip-e2',
      );
      expect(pulledEntities).toHaveLength(2);

      const e1 = pulledEntities.find((e) => e.id === 'roundtrip-e1')!;
      expect(e1.mergedData).toEqual({ title: 'Roundtrip Product X', price: 49.99 });
      expect(e1.qualityScore).toBe(0.92);

      const e2 = pulledEntities.find((e) => e.id === 'roundtrip-e2')!;
      expect(e2.mergedData).toEqual({ title: 'Roundtrip Product Y', price: 59.99 });

      // Run record exists with correct source
      const run = await adapter.runRepo.findLatestByStatus(['pulled']);
      expect(run).not.toBeNull();
      expect(run!.source).toBe('remote:prod:remote-job-1');

      // Meta keys are set
      const lastPullAt = await adapter.metaRepo.get('remote:prod:last_pull_at');
      expect(lastPullAt).toBeTruthy();

      // Cursor should be cleared after successful pull
      const cursor = await adapter.metaRepo.get('remote:prod:pull_cursor');
      expect(cursor).toBeNull();

      // LLM usage was stored
      const usageStr = await adapter.metaRepo.get('remote:prod:last_pull_usage');
      expect(usageStr).toBeTruthy();
      const usage = JSON.parse(usageStr!);
      expect(usage.totalTokens).toBe(2000);
    } finally {
      close();
    }
  });
});
