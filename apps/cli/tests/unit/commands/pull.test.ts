// apps/cli/tests/unit/commands/pull.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPullCommand } from '../../../src/commands/pull.js';
import type { GlobalConfig } from '@spatula/core';

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(() => ({
      version: 1,
      remotes: {
        prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live_abc' },
      },
    } as GlobalConfig)),
  };
});

const mockMetaGet = vi.fn();
const mockMetaSet = vi.fn();
const mockMetaDelete = vi.fn();

const mockUpsertBatch = vi.fn().mockResolvedValue({ inserted: 5, updated: 0 });
const mockDeleteByRunIds = vi.fn().mockResolvedValue(0);
const mockSchemaFindLatest = vi.fn().mockResolvedValue(null);
const mockSchemaCreate = vi.fn().mockResolvedValue({ id: 'schema-1' });
const mockRunCreate = vi.fn().mockResolvedValue({ id: 'run-1' });
const mockRunUpdateStats = vi.fn();

const mockFindIdsBySourcePrefix = vi.fn().mockResolvedValue([]);

function buildMockAdapter() {
  return {
    entityRepo: { upsertBatch: mockUpsertBatch, deleteByRunIds: mockDeleteByRunIds },
    schemaRepo: { findLatest: mockSchemaFindLatest, create: mockSchemaCreate },
    runRepo: { create: mockRunCreate, updateStats: mockRunUpdateStats, findIdsBySourcePrefix: mockFindIdsBySourcePrefix },
  };
}

function mockFetchSequence(responses: Array<{ data: unknown; pagination?: unknown; status?: number }>) {
  let callIdx = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      const resp = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      const status = resp.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(
          resp.pagination
            ? { data: resp.data, pagination: resp.pagination }
            : { data: resp.data },
        ),
      });
    }),
  );
}

describe('runPullCommand', () => {
  beforeEach(() => {
    mockMetaGet.mockReset();
    mockMetaSet.mockReset();
    mockMetaDelete.mockReset();
    mockUpsertBatch.mockReset().mockResolvedValue({ inserted: 5, updated: 0 });
    mockDeleteByRunIds.mockReset().mockResolvedValue(0);
    mockSchemaFindLatest.mockReset().mockResolvedValue(null);
    mockSchemaCreate.mockReset().mockResolvedValue({ id: 'schema-1' });
    mockRunCreate.mockReset().mockResolvedValue({ id: 'run-1' });
    mockRunUpdateStats.mockReset();
    mockFindIdsBySourcePrefix.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('pulls entities from a completed remote job', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    mockFetchSequence([
      // getJob
      { data: { id: 'remote-job-1', status: 'completed', stats: { pagesProcessed: 10 } } },
      // getSchema
      { data: { version: 1, fields: [{ name: 'title', type: 'string', required: true, description: '' }], fieldAliases: [], createdAt: '2026-01-01', parentVersion: null } },
      // getEntitiesStreamPaginated — single batch
      { data: [{ id: 'e1', mergedData: { title: 'A' }, provenance: {}, categories: [], qualityScore: 0.9, tenantId: 't1', jobId: 'remote-job-1' }], pagination: { hasMore: false, total: 1 } },
      // getUsage
      { data: { period: {}, totalTokens: 1000, totalCostUsd: 0.05, byModel: {}, byPurpose: {}, byJob: [{ jobId: 'remote-job-1', tokens: 1000, costUsd: 0.05 }] } },
    ]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
    });

    expect(result.success).toBe(true);
    expect(result.entitiesInserted).toBe(5);
    expect(mockUpsertBatch).toHaveBeenCalled();
    expect(mockRunCreate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pulled',
      source: 'remote:prod:remote-job-1',
    }));
    expect(mockMetaSet).toHaveBeenCalledWith('remote:prod:last_pull_at', expect.any(String));
    expect(mockMetaDelete).toHaveBeenCalledWith('remote:prod:pull_cursor');
  });

  it('errors when no linked job exists', async () => {
    mockMetaGet.mockResolvedValue(null);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No job linked');
  });

  it('errors when remote is not configured', async () => {
    const result = await runPullCommand({
      remoteName: 'nonexistent',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('resumes from cursor when interrupted pull detected', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      if (key === 'remote:prod:pull_cursor') return 'saved-cursor-abc';
      return null;
    });

    mockFetchSequence([
      // getJob (still needed for status check)
      { data: { id: 'remote-job-1', status: 'completed' } },
      // getEntitiesStreamPaginated — resumes from cursor
      { data: [{ id: 'e5', mergedData: {}, provenance: {}, categories: [], qualityScore: 0.8, tenantId: 't1', jobId: 'j1' }], pagination: { hasMore: false, total: 1 } },
      // getUsage
      { data: { period: {}, totalTokens: 0, totalCostUsd: 0, byModel: {}, byPurpose: {}, byJob: [] } },
    ]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      skipSchema: true,
    });

    expect(result.success).toBe(true);
    expect(result.resumed).toBe(true);
  });

  it('clears entities on --full flag before pulling', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });
    mockFindIdsBySourcePrefix.mockResolvedValue(['run-old-1', 'run-old-2']);

    mockFetchSequence([
      { data: { id: 'remote-job-1', status: 'completed' } },
      { data: { version: 1, fields: [], fieldAliases: [], createdAt: '2026-01-01', parentVersion: null } },
      { data: [], pagination: { hasMore: false, total: 0 } },
      { data: { period: {}, totalTokens: 0, totalCostUsd: 0, byModel: {}, byPurpose: {}, byJob: [] } },
    ]);

    await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      full: true,
    });

    expect(mockDeleteByRunIds).toHaveBeenCalled();
  });
});
