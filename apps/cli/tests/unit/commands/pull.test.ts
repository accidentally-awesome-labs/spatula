// apps/cli/tests/unit/commands/pull.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPullCommand } from '../../../src/commands/pull.js';
import type { GlobalConfig } from '@spatula/core';

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
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
    runRepo: {
      create: mockRunCreate,
      updateStats: mockRunUpdateStats,
      findIdsBySourcePrefix: mockFindIdsBySourcePrefix,
    },
  };
}

function mockFetchSequence(
  responses: Array<{ data: unknown; pagination?: unknown; status?: number }>,
) {
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
        json: () =>
          Promise.resolve(
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
    mockUpsertBatch.mockResolvedValue({ inserted: 1, updated: 0 });

    mockFetchSequence([
      // getJob
      { data: { id: 'remote-job-1', status: 'completed', stats: { pagesProcessed: 10 } } },
      // getSchema
      {
        data: {
          version: 1,
          fields: [{ name: 'title', type: 'string', required: true, description: '' }],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      // getEntitiesStreamPaginated — single batch with 1 entity
      {
        data: [
          {
            id: 'e1',
            mergedData: { title: 'A' },
            provenance: { title: {} },
            categories: ['product'],
            qualityScore: 0.9,
            tenantId: 't1',
            jobId: 'remote-job-1',
          },
        ],
        pagination: { hasMore: false, total: 1 },
      },
      // getUsage
      {
        data: {
          period: {},
          totalTokens: 1000,
          totalCostUsd: 0.05,
          byModel: {},
          byPurpose: {},
          byJob: [{ jobId: 'remote-job-1', tokens: 1000, costUsd: 0.05 }],
        },
      },
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
    expect(result.entitiesInserted).toBe(1);
    expect(result.llmTokens).toBe(1000);
    expect(result.llmCostUsd).toBe(0.05);

    // Verify entity transformation: tenantId stripped, runId set
    expect(mockUpsertBatch).toHaveBeenCalledTimes(1);
    const batch = mockUpsertBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe('e1');
    expect(batch[0].mergedData).toEqual({ title: 'A' });
    expect(batch[0].qualityScore).toBe(0.9);
    expect(batch[0].categories).toEqual(['product']);
    expect(batch[0].runId).toBe('run-1'); // from mockRunCreate
    expect(batch[0]).not.toHaveProperty('tenantId');
    expect(batch[0]).not.toHaveProperty('jobId'); // stripped, not remapped into batch

    expect(mockRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pulled',
        source: 'remote:prod:remote-job-1',
      }),
    );
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
      {
        data: [
          {
            id: 'e5',
            mergedData: {},
            provenance: {},
            categories: [],
            qualityScore: 0.8,
            tenantId: 't1',
            jobId: 'j1',
          },
        ],
        pagination: { hasMore: false, total: 1 },
      },
      // getUsage
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
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
      {
        data: {
          version: 1,
          fields: [],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      { data: [], pagination: { hasMore: false, total: 0 } },
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
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

    expect(mockFindIdsBySourcePrefix).toHaveBeenCalledWith('remote:prod:');
    expect(mockDeleteByRunIds).toHaveBeenCalledWith(['run-old-1', 'run-old-2']);
  });

  // -------------------------------------------------------------------------
  // Error resilience tests
  // -------------------------------------------------------------------------

  it('returns failure when getJob throws a network error', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS resolution failed')));

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
    expect(result.error).toContain('DNS resolution failed');
  });

  it('preserves cursor from first batch when second entity batch throws', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });
    mockUpsertBatch.mockResolvedValue({ inserted: 1, updated: 0 });

    let entityCallCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if ((url as string).includes('/entities')) {
          entityCallCount++;
          if (entityCallCount === 2) throw new Error('Network lost');
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: [
                  {
                    id: 'e1',
                    mergedData: { title: 'A' },
                    provenance: {},
                    categories: [],
                    qualityScore: 0.9,
                    tenantId: 't1',
                    jobId: 'remote-job-1',
                  },
                ],
                pagination: { nextCursor: 'cur-2', hasMore: true, total: 10 },
              }),
          };
        }
        // getJob
        if ((url as string).includes('/jobs/')) {
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
          };
        }
        // getSchema
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: {
                version: 1,
                fields: [],
                fieldAliases: [],
                createdAt: '2026-01-01',
                parentVersion: null,
              },
            }),
        };
      }),
    );

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
    expect(result.entitiesInserted).toBe(1); // 1 entity from first batch
    expect(result.error).toContain('Pull interrupted');
    // cursor from the first batch should have been checkpointed
    expect(mockMetaSet).toHaveBeenCalledWith('remote:prod:pull_cursor', 'cur-2');
  });

  it('continues entity pull even when schema fetch throws', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    let schemaFetched = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if ((url as string).includes('/schema')) {
          schemaFetched = true;
          throw new Error('Schema endpoint down');
        }
        if ((url as string).includes('/entities')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: [
                  {
                    id: 'e1',
                    mergedData: {},
                    provenance: {},
                    categories: [],
                    qualityScore: 0.8,
                    tenantId: 't1',
                    jobId: 'remote-job-1',
                  },
                ],
                pagination: { hasMore: false, total: 1 },
              }),
          };
        }
        if ((url as string).includes('/usage')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: {
                  period: {},
                  totalTokens: 0,
                  totalCostUsd: 0,
                  byModel: {},
                  byPurpose: {},
                  byJob: [],
                },
              }),
          };
        }
        // getJob
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
        };
      }),
    );

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
    });

    expect(schemaFetched).toBe(true);
    expect(result.success).toBe(true);
    expect(result.schemaFieldsAdded).toBe(0);
    expect(mockUpsertBatch).toHaveBeenCalled();
  });

  it('still succeeds and returns llmTokens=0 when usage fetch throws', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if ((url as string).includes('/usage')) throw new Error('Usage service unavailable');
        if ((url as string).includes('/entities')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: [],
                pagination: { hasMore: false, total: 0 },
              }),
          };
        }
        if ((url as string).includes('/schema')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: {
                  version: 1,
                  fields: [],
                  fieldAliases: [],
                  createdAt: '2026-01-01',
                  parentVersion: null,
                },
              }),
          };
        }
        // getJob
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
        };
      }),
    );

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
    expect(result.llmTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Schema resolution tests
  // -------------------------------------------------------------------------

  it('creates schema when no local schema exists and remote has fields', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });
    // schemaFindLatest returns null (already the default reset value)

    mockFetchSequence([
      // getJob
      { data: { id: 'remote-job-1', status: 'completed' } },
      // getSchema — 2 fields
      {
        data: {
          version: 2,
          fields: [
            { name: 'title', type: 'string', required: true, description: '' },
            { name: 'remote_field', type: 'number', required: false, description: '' },
          ],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      // getEntitiesStreamPaginated
      { data: [], pagination: { hasMore: false, total: 0 } },
      // getUsage
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
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
    expect(mockSchemaCreate).toHaveBeenCalled();
    expect(result.schemaFieldsAdded).toBe(2);
    expect(result.newFields).toHaveLength(2);
    expect(result.newFields?.map((f) => f.name)).toContain('title');
    expect(result.newFields?.map((f) => f.name)).toContain('remote_field');
  });

  it('creates new schema version with remote definition when conflict resolves as remote', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });
    mockSchemaFindLatest.mockResolvedValue({
      id: 'local-schema-1',
      version: 1,
      definition: {
        version: 1,
        fields: [
          { name: 'title', type: 'string', required: true, description: '' },
          { name: 'local_field', type: 'string', required: false, description: '' },
        ],
        fieldAliases: [],
        createdAt: '2026-01-01',
        parentVersion: null,
      },
    });

    mockFetchSequence([
      { data: { id: 'remote-job-1', status: 'completed' } },
      {
        data: {
          version: 2,
          fields: [
            { name: 'title', type: 'string', required: true, description: '' },
            { name: 'remote_field', type: 'number', required: false, description: '' },
          ],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      { data: [], pagination: { hasMore: false, total: 0 } },
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
    ]);

    const resolveCallback = vi.fn().mockResolvedValue('remote');
    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      resolveSchemaConflict: resolveCallback,
    });

    expect(result.success).toBe(true);
    expect(mockSchemaCreate).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, parentId: 'local-schema-1' }),
    );
    // Verify the diff passed to the callback was computed correctly
    expect(resolveCallback).toHaveBeenCalledTimes(1);
    const diff = resolveCallback.mock.calls[0][0] as {
      localOnly: { name: string }[];
      remoteOnly: { name: string }[];
      changed: unknown[];
    };
    expect(diff.remoteOnly.map((f: { name: string }) => f.name)).toEqual(['remote_field']);
    expect(diff.localOnly.map((f: { name: string }) => f.name)).toEqual(['local_field']);
    expect(diff.changed).toHaveLength(0); // title is identical in both
    expect(result.newFields?.map((f) => f.name)).toEqual(['remote_field']);
  });

  it('creates merged schema when conflict resolves as merge', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });
    mockSchemaFindLatest.mockResolvedValue({
      id: 'local-schema-1',
      version: 1,
      definition: {
        version: 1,
        fields: [
          { name: 'title', type: 'string', required: true, description: '' },
          { name: 'local_field', type: 'string', required: false, description: '' },
        ],
        fieldAliases: [],
        createdAt: '2026-01-01',
        parentVersion: null,
      },
    });

    mockFetchSequence([
      { data: { id: 'remote-job-1', status: 'completed' } },
      {
        data: {
          version: 2,
          fields: [
            { name: 'title', type: 'string', required: true, description: '' },
            { name: 'remote_field', type: 'number', required: false, description: '' },
          ],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      { data: [], pagination: { hasMore: false, total: 0 } },
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
    ]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      resolveSchemaConflict: vi.fn().mockResolvedValue('merge'),
    });

    expect(result.success).toBe(true);
    expect(mockSchemaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        parentId: 'local-schema-1',
        definition: expect.objectContaining({
          fields: expect.arrayContaining([
            expect.objectContaining({ name: 'title' }),
            expect.objectContaining({ name: 'remote_field' }),
            expect.objectContaining({ name: 'local_field' }),
          ]),
        }),
      }),
    );
  });

  it('does not create schema when conflict resolves as local', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });
    mockSchemaFindLatest.mockResolvedValue({
      id: 'local-schema-1',
      version: 1,
      definition: {
        version: 1,
        fields: [
          { name: 'title', type: 'string', required: true, description: '' },
          { name: 'local_field', type: 'string', required: false, description: '' },
        ],
        fieldAliases: [],
        createdAt: '2026-01-01',
        parentVersion: null,
      },
    });

    mockFetchSequence([
      { data: { id: 'remote-job-1', status: 'completed' } },
      {
        data: {
          version: 2,
          fields: [
            { name: 'title', type: 'string', required: true, description: '' },
            { name: 'remote_field', type: 'number', required: false, description: '' },
          ],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      { data: [], pagination: { hasMore: false, total: 0 } },
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
    ]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      resolveSchemaConflict: vi.fn().mockResolvedValue('local'),
    });

    expect(result.success).toBe(true);
    expect(mockSchemaCreate).not.toHaveBeenCalled();
    expect(result.schemaFieldsAdded).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Incremental pull tests
  // -------------------------------------------------------------------------

  it('passes since param when last_pull_at is set in meta', async () => {
    const lastPullAt = '2026-03-01T00:00:00.000Z';
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      if (key === 'remote:prod:last_pull_at') return lastPullAt;
      return null;
    });

    const capturedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        capturedUrls.push(url as string);
        if ((url as string).includes('/entities')) {
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
          };
        }
        if ((url as string).includes('/schema')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: {
                  version: 1,
                  fields: [],
                  fieldAliases: [],
                  createdAt: '2026-01-01',
                  parentVersion: null,
                },
              }),
          };
        }
        if ((url as string).includes('/usage')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: {
                  period: {},
                  totalTokens: 0,
                  totalCostUsd: 0,
                  byModel: {},
                  byPurpose: {},
                  byJob: [],
                },
              }),
          };
        }
        // getJob
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
        };
      }),
    );

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
    const entityUrl = capturedUrls.find((u) => u.includes('/entities'));
    expect(entityUrl).toBeDefined();
    expect(entityUrl).toContain(`since=${encodeURIComponent(lastPullAt)}`);
  });

  it('does not pass since param when no last_pull_at in meta', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    const capturedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        capturedUrls.push(url as string);
        if ((url as string).includes('/entities')) {
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
          };
        }
        if ((url as string).includes('/schema')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: {
                  version: 1,
                  fields: [],
                  fieldAliases: [],
                  createdAt: '2026-01-01',
                  parentVersion: null,
                },
              }),
          };
        }
        if ((url as string).includes('/usage')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: {
                  period: {},
                  totalTokens: 0,
                  totalCostUsd: 0,
                  byModel: {},
                  byPurpose: {},
                  byJob: [],
                },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
        };
      }),
    );

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
    const entityUrl = capturedUrls.find((u) => u.includes('/entities'));
    expect(entityUrl).toBeDefined();
    expect(entityUrl).not.toContain('since=');
  });

  // -------------------------------------------------------------------------
  // Flag tests
  // -------------------------------------------------------------------------

  it('clears interrupted cursor and sets resumed=false when --restart is used', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      if (key === 'remote:prod:pull_cursor') return 'old-cursor-xyz';
      return null;
    });

    mockFetchSequence([
      { data: { id: 'remote-job-1', status: 'completed' } },
      {
        data: {
          version: 1,
          fields: [],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      { data: [], pagination: { hasMore: false, total: 0 } },
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
    ]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      restart: true,
    });

    expect(result.success).toBe(true);
    expect(result.resumed).toBe(false);
    expect(mockMetaDelete).toHaveBeenCalledWith('remote:prod:pull_cursor');
  });

  it('clears metadata and deletes old entities on --full', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });
    mockFindIdsBySourcePrefix.mockResolvedValue(['run-a', 'run-b', 'run-c']);

    mockFetchSequence([
      { data: { id: 'remote-job-1', status: 'completed' } },
      {
        data: {
          version: 1,
          fields: [],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      { data: [], pagination: { hasMore: false, total: 0 } },
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
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

    expect(mockFindIdsBySourcePrefix).toHaveBeenCalledWith('remote:prod:');
    expect(mockDeleteByRunIds).toHaveBeenCalledWith(['run-a', 'run-b', 'run-c']);
    expect(mockMetaDelete).toHaveBeenCalledWith('remote:prod:pull_cursor');
    expect(mockMetaDelete).toHaveBeenCalledWith('remote:prod:last_pull_at');
  });

  it('clears cursor, entities, and metadata when both --full and --restart are used', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      if (key === 'remote:prod:pull_cursor') return 'stale-cursor';
      return null;
    });
    mockFindIdsBySourcePrefix.mockResolvedValue(['run-old']);

    mockFetchSequence([
      { data: { id: 'remote-job-1', status: 'completed' } },
      {
        data: {
          version: 1,
          fields: [],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      { data: [], pagination: { hasMore: false, total: 0 } },
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
    ]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      full: true,
      restart: true,
    });

    expect(result.success).toBe(true);
    expect(result.resumed).toBe(false);
    expect(mockDeleteByRunIds).toHaveBeenCalledWith(['run-old']);
    // pull_cursor deleted by restart path AND full path
    expect(mockMetaDelete).toHaveBeenCalledWith('remote:prod:pull_cursor');
    expect(mockMetaDelete).toHaveBeenCalledWith('remote:prod:last_pull_at');
  });

  // -------------------------------------------------------------------------
  // Running job tests
  // -------------------------------------------------------------------------

  it('returns error with jobStatus when job is running and no resolveRunningJob callback', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    mockFetchSequence([
      { data: { id: 'remote-job-1', status: 'running', stats: { pagesProcessed: 5 } } },
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

    expect(result.success).toBe(false);
    expect(result.jobStatus).toBe('running');
    expect(result.error).toContain('running');
  });

  it('proceeds with pull when running job resolves as snapshot', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    mockFetchSequence([
      // getJob — running
      { data: { id: 'remote-job-1', status: 'running', stats: { pagesProcessed: 7 } } },
      // getSchema
      {
        data: {
          version: 1,
          fields: [],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      // entities
      { data: [], pagination: { hasMore: false, total: 0 } },
      // usage
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
    ]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      resolveRunningJob: vi.fn().mockResolvedValue('snapshot'),
    });

    expect(result.success).toBe(true);
    // Verify pull actually completed — not just returned success
    expect(mockRunCreate).toHaveBeenCalled();
    expect(mockMetaSet).toHaveBeenCalledWith('remote:prod:last_pull_at', expect.any(String));
    expect(mockMetaDelete).toHaveBeenCalledWith('remote:prod:pull_cursor');
  });

  it('returns cancelled error when running job resolves as cancel', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    mockFetchSequence([{ data: { id: 'remote-job-1', status: 'running', stats: {} } }]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      resolveRunningJob: vi.fn().mockResolvedValue('cancel'),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('cancel');
  });

  // -------------------------------------------------------------------------
  // Extraction pull tests (--include-extractions)
  // -------------------------------------------------------------------------

  describe('pull with --include-extractions', () => {
    const mockExtractionUpsertBatch = vi.fn().mockResolvedValue({ inserted: 3, updated: 0 });
    const mockExtractionDeleteByRunIds = vi.fn().mockResolvedValue(0);
    const mockExtractionFindIdsByRunId = vi.fn().mockResolvedValue([]);
    const mockEntitySourceUpsertBatchSources = vi.fn().mockResolvedValue(2);
    const mockEntitySourceDeleteByExtractionIds = vi.fn().mockResolvedValue(0);

    function buildAdapterWithExtractions() {
      return {
        ...buildMockAdapter(),
        extractionRepo: {
          upsertBatch: mockExtractionUpsertBatch,
          deleteByRunIds: mockExtractionDeleteByRunIds,
          findIdsByRunId: mockExtractionFindIdsByRunId,
        },
        entitySourceRepo: {
          upsertBatchSources: mockEntitySourceUpsertBatchSources,
          deleteByExtractionIds: mockEntitySourceDeleteByExtractionIds,
        },
      };
    }

    beforeEach(() => {
      mockExtractionUpsertBatch.mockReset().mockResolvedValue({ inserted: 3, updated: 0 });
      mockExtractionDeleteByRunIds.mockReset().mockResolvedValue(0);
      mockExtractionFindIdsByRunId.mockReset().mockResolvedValue([]);
      mockEntitySourceUpsertBatchSources.mockReset().mockResolvedValue(2);
      mockEntitySourceDeleteByExtractionIds.mockReset().mockResolvedValue(0);
    });

    it('fetches and stores extractions after entities', async () => {
      mockMetaGet.mockImplementation(async (key: string) => {
        if (key === 'remote:prod:job_id') return 'remote-job-1';
        return null;
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if ((url as string).includes('/extractions')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'ext-1',
                      pageUrl: 'https://a.com',
                      schemaVersion: 1,
                      data: { title: 'A' },
                      unmappedFields: [],
                      metadata: {},
                    },
                    {
                      id: 'ext-2',
                      pageUrl: 'https://b.com',
                      schemaVersion: 1,
                      data: { title: 'B' },
                      unmappedFields: [],
                      metadata: {},
                    },
                    {
                      id: 'ext-3',
                      pageUrl: null,
                      schemaVersion: 2,
                      data: { title: 'C' },
                      unmappedFields: [{ field: 'x' }],
                      metadata: { source: 'llm' },
                    },
                  ],
                  pagination: { hasMore: false, total: 3 },
                }),
            };
          }
          if ((url as string).includes('/entity-sources')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: [
                    { entityId: 'e1', extractionId: 'ext-1', matchConfidence: 0.95 },
                    { entityId: 'e2', extractionId: 'ext-2', matchConfidence: 0.88 },
                  ],
                  pagination: { hasMore: false, total: 2 },
                }),
            };
          }
          if ((url as string).includes('/entities')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/schema')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    version: 1,
                    fields: [],
                    fieldAliases: [],
                    createdAt: '2026-01-01',
                    parentVersion: null,
                  },
                }),
            };
          }
          if ((url as string).includes('/usage')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    period: {},
                    totalTokens: 0,
                    totalCostUsd: 0,
                    byModel: {},
                    byPurpose: {},
                    byJob: [],
                  },
                }),
            };
          }
          // getJob
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
          };
        }),
      );

      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: mockMetaGet,
        metaSet: mockMetaSet,
        metaDelete: mockMetaDelete,
        adapter: buildAdapterWithExtractions() as any,
        projectId: 'test-project',
        projectRoot: '/tmp/test',
        includeExtractions: true,
      });

      expect(result.success).toBe(true);
      expect(result.extractionsInserted).toBe(3);
      expect(result.extractionsUpdated).toBe(0);
      expect(mockExtractionUpsertBatch).toHaveBeenCalledTimes(1);
      const batch = mockExtractionUpsertBatch.mock.calls[0][0];
      expect(batch).toHaveLength(3);
      expect(batch[0].id).toBe('ext-1');
      expect(batch[0].pageUrl).toBe('https://a.com');
      expect(batch[0].runId).toBe('run-1');
      expect(batch[2].unmappedFields).toEqual([{ field: 'x' }]);

      // Entity sources pulled automatically
      expect(result.entitySourcesInserted).toBe(2);
      expect(mockEntitySourceUpsertBatchSources).toHaveBeenCalledTimes(1);
      const esBatch = mockEntitySourceUpsertBatchSources.mock.calls[0][0];
      expect(esBatch).toHaveLength(2);
      expect(esBatch[0].entityId).toBe('e1');
      expect(esBatch[0].matchConfidence).toBe(0.95);
    });

    it('uses separate cursor for extractions', async () => {
      mockMetaGet.mockImplementation(async (key: string) => {
        if (key === 'remote:prod:job_id') return 'remote-job-1';
        return null;
      });

      let extractionCallCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if ((url as string).includes('/extractions')) {
            extractionCallCount++;
            if (extractionCallCount === 1) {
              return {
                ok: true,
                status: 200,
                json: () =>
                  Promise.resolve({
                    data: [
                      {
                        id: 'ext-1',
                        pageUrl: 'https://a.com',
                        schemaVersion: 1,
                        data: {},
                        unmappedFields: [],
                        metadata: {},
                      },
                    ],
                    pagination: { nextCursor: 'extr-cursor-2', hasMore: true, total: 2 },
                  }),
              };
            }
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'ext-2',
                      pageUrl: 'https://b.com',
                      schemaVersion: 1,
                      data: {},
                      unmappedFields: [],
                      metadata: {},
                    },
                  ],
                  pagination: { hasMore: false, total: 2 },
                }),
            };
          }
          if ((url as string).includes('/entity-sources')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/entities')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/schema')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    version: 1,
                    fields: [],
                    fieldAliases: [],
                    createdAt: '2026-01-01',
                    parentVersion: null,
                  },
                }),
            };
          }
          if ((url as string).includes('/usage')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    period: {},
                    totalTokens: 0,
                    totalCostUsd: 0,
                    byModel: {},
                    byPurpose: {},
                    byJob: [],
                  },
                }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
          };
        }),
      );

      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: mockMetaGet,
        metaSet: mockMetaSet,
        metaDelete: mockMetaDelete,
        adapter: buildAdapterWithExtractions() as any,
        projectId: 'test-project',
        projectRoot: '/tmp/test',
        includeExtractions: true,
      });

      expect(result.success).toBe(true);
      expect(mockExtractionUpsertBatch).toHaveBeenCalledTimes(2);
      // Cursor checkpointed between pages
      expect(mockMetaSet).toHaveBeenCalledWith(
        'remote:prod:pull_cursor_extractions',
        'extr-cursor-2',
      );
      // Cursor cleared after completion
      expect(mockMetaDelete).toHaveBeenCalledWith('remote:prod:pull_cursor_extractions');
    });

    it('returns structured failure when entity-source pull throws mid-loop', async () => {
      mockMetaGet.mockImplementation(async (key: string) => {
        if (key === 'remote:prod:job_id') return 'remote-job-1';
        return null;
      });

      let esCallCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if ((url as string).includes('/extractions')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'ext-1',
                      pageUrl: 'https://a.com',
                      schemaVersion: 1,
                      data: {},
                      unmappedFields: [],
                      metadata: {},
                    },
                  ],
                  pagination: { hasMore: false, total: 1 },
                }),
            };
          }
          if ((url as string).includes('/entity-sources')) {
            esCallCount++;
            if (esCallCount === 1) {
              return {
                ok: true,
                status: 200,
                json: () =>
                  Promise.resolve({
                    data: [{ entityId: 'e1', extractionId: 'ext-1', matchConfidence: 0.9 }],
                    pagination: { nextCursor: 'es-cursor-2', hasMore: true, total: 3 },
                  }),
              };
            }
            throw new Error('Network lost during entity-sources pull');
          }
          if ((url as string).includes('/entities')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/schema')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    version: 1,
                    fields: [],
                    fieldAliases: [],
                    createdAt: '2026-01-01',
                    parentVersion: null,
                  },
                }),
            };
          }
          if ((url as string).includes('/usage')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    period: {},
                    totalTokens: 0,
                    totalCostUsd: 0,
                    byModel: {},
                    byPurpose: {},
                    byJob: [],
                  },
                }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
          };
        }),
      );

      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: mockMetaGet,
        metaSet: mockMetaSet,
        metaDelete: mockMetaDelete,
        adapter: buildAdapterWithExtractions() as any,
        projectId: 'test-project',
        projectRoot: '/tmp/test',
        includeExtractions: true,
      });

      // Must not throw — returns structured failure like extraction/action loops
      expect(result.success).toBe(false);
      expect(result.error).toContain('Entity-source pull failed');
      expect(result.entitySourcesInserted).toBe(2); // from mock upsert return value
      // Cursor checkpointed before the throw
      expect(mockMetaSet).toHaveBeenCalledWith(
        'remote:prod:pull_cursor_entity_sources',
        'es-cursor-2',
      );
    });

    it('does not pull extractions when flag is false', async () => {
      mockMetaGet.mockImplementation(async (key: string) => {
        if (key === 'remote:prod:job_id') return 'remote-job-1';
        return null;
      });

      mockFetchSequence([
        { data: { id: 'remote-job-1', status: 'completed' } },
        {
          data: {
            version: 1,
            fields: [],
            fieldAliases: [],
            createdAt: '2026-01-01',
            parentVersion: null,
          },
        },
        { data: [], pagination: { hasMore: false, total: 0 } },
        {
          data: {
            period: {},
            totalTokens: 0,
            totalCostUsd: 0,
            byModel: {},
            byPurpose: {},
            byJob: [],
          },
        },
      ]);

      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: mockMetaGet,
        metaSet: mockMetaSet,
        metaDelete: mockMetaDelete,
        adapter: buildAdapterWithExtractions() as any,
        projectId: 'test-project',
        projectRoot: '/tmp/test',
        includeExtractions: false,
      });

      expect(result.success).toBe(true);
      expect(result.extractionsInserted).toBe(0);
      expect(mockExtractionUpsertBatch).not.toHaveBeenCalled();
      expect(mockEntitySourceUpsertBatchSources).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Action pull tests (--include-actions)
  // -------------------------------------------------------------------------

  describe('pull with --include-actions', () => {
    const mockActionUpsertBatch = vi.fn().mockResolvedValue({ inserted: 2, updated: 1 });
    const mockActionDeleteByRunIds = vi.fn().mockResolvedValue(0);

    function buildAdapterWithActions() {
      return {
        ...buildMockAdapter(),
        actionRepo: {
          upsertBatch: mockActionUpsertBatch,
          deleteByRunIds: mockActionDeleteByRunIds,
        },
      };
    }

    beforeEach(() => {
      mockActionUpsertBatch.mockReset().mockResolvedValue({ inserted: 2, updated: 1 });
      mockActionDeleteByRunIds.mockReset().mockResolvedValue(0);
    });

    it('fetches and stores actions after entities', async () => {
      mockMetaGet.mockImplementation(async (key: string) => {
        if (key === 'remote:prod:job_id') return 'remote-job-1';
        return null;
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if ((url as string).includes('/actions')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'act-1',
                      type: 'add_field',
                      payload: { field: 'price' },
                      source: 'llm',
                      status: 'pending',
                      confidence: 0.9,
                      reasoning: 'Detected numeric field',
                      createdAt: '2026-03-01T00:00:00Z',
                      updatedAt: '2026-03-01T00:00:00Z',
                      appliedAt: null,
                      stateChanges: null,
                      reviewedBy: null,
                    },
                    {
                      id: 'act-2',
                      type: 'rename_field',
                      payload: { from: 'name', to: 'title' },
                      source: 'llm',
                      status: 'applied',
                      confidence: 0.85,
                      reasoning: 'Field rename detected',
                      createdAt: '2026-03-01T00:00:00Z',
                      updatedAt: '2026-03-02T00:00:00Z',
                      appliedAt: '2026-03-02T00:00:00Z',
                      stateChanges: { renamed: true },
                      reviewedBy: 'user-1',
                    },
                  ],
                  pagination: { hasMore: false, total: 2 },
                }),
            };
          }
          if ((url as string).includes('/entities')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/schema')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    version: 1,
                    fields: [],
                    fieldAliases: [],
                    createdAt: '2026-01-01',
                    parentVersion: null,
                  },
                }),
            };
          }
          if ((url as string).includes('/usage')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    period: {},
                    totalTokens: 0,
                    totalCostUsd: 0,
                    byModel: {},
                    byPurpose: {},
                    byJob: [],
                  },
                }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
          };
        }),
      );

      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: mockMetaGet,
        metaSet: mockMetaSet,
        metaDelete: mockMetaDelete,
        adapter: buildAdapterWithActions() as any,
        projectId: 'test-project',
        projectRoot: '/tmp/test',
        includeActions: true,
      });

      expect(result.success).toBe(true);
      expect(result.actionsInserted).toBe(2);
      expect(result.actionsUpdated).toBe(1);
      expect(mockActionUpsertBatch).toHaveBeenCalledTimes(1);
      const batch = mockActionUpsertBatch.mock.calls[0][0];
      expect(batch).toHaveLength(2);
      expect(batch[0].id).toBe('act-1');
      expect(batch[0].type).toBe('add_field');
      expect(batch[0].runId).toBe('run-1');
      expect(batch[1].appliedAt).toBe('2026-03-02T00:00:00Z');
      expect(batch[1].stateChanges).toEqual({ renamed: true });
    });

    it('does not pull actions when flag is false', async () => {
      mockMetaGet.mockImplementation(async (key: string) => {
        if (key === 'remote:prod:job_id') return 'remote-job-1';
        return null;
      });

      mockFetchSequence([
        { data: { id: 'remote-job-1', status: 'completed' } },
        {
          data: {
            version: 1,
            fields: [],
            fieldAliases: [],
            createdAt: '2026-01-01',
            parentVersion: null,
          },
        },
        { data: [], pagination: { hasMore: false, total: 0 } },
        {
          data: {
            period: {},
            totalTokens: 0,
            totalCostUsd: 0,
            byModel: {},
            byPurpose: {},
            byJob: [],
          },
        },
      ]);

      const result = await runPullCommand({
        remoteName: 'prod',
        metaGet: mockMetaGet,
        metaSet: mockMetaSet,
        metaDelete: mockMetaDelete,
        adapter: buildAdapterWithActions() as any,
        projectId: 'test-project',
        projectRoot: '/tmp/test',
        includeActions: false,
      });

      expect(result.success).toBe(true);
      expect(result.actionsInserted).toBe(0);
      expect(mockActionUpsertBatch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // --full with --include-extractions
  // -------------------------------------------------------------------------

  describe('pull --full with --include-extractions', () => {
    const mockExtractionUpsertBatch = vi.fn().mockResolvedValue({ inserted: 0, updated: 0 });
    const mockExtractionDeleteByRunIds = vi.fn().mockResolvedValue(0);
    const mockExtractionFindIdsByRunId = vi.fn();
    const mockEntitySourceUpsertBatchSources = vi.fn().mockResolvedValue(0);
    const mockEntitySourceDeleteByExtractionIds = vi.fn().mockResolvedValue(0);

    function buildAdapterWithAll() {
      return {
        ...buildMockAdapter(),
        extractionRepo: {
          upsertBatch: mockExtractionUpsertBatch,
          deleteByRunIds: mockExtractionDeleteByRunIds,
          findIdsByRunId: mockExtractionFindIdsByRunId,
        },
        entitySourceRepo: {
          upsertBatchSources: mockEntitySourceUpsertBatchSources,
          deleteByExtractionIds: mockEntitySourceDeleteByExtractionIds,
        },
      };
    }

    beforeEach(() => {
      mockExtractionUpsertBatch.mockReset().mockResolvedValue({ inserted: 0, updated: 0 });
      mockExtractionDeleteByRunIds.mockReset().mockResolvedValue(0);
      mockExtractionFindIdsByRunId.mockReset();
      mockEntitySourceUpsertBatchSources.mockReset().mockResolvedValue(0);
      mockEntitySourceDeleteByExtractionIds.mockReset().mockResolvedValue(0);
    });

    it('clears entity_sources before extractions on --full', async () => {
      mockMetaGet.mockImplementation(async (key: string) => {
        if (key === 'remote:prod:job_id') return 'remote-job-1';
        return null;
      });
      mockFindIdsBySourcePrefix.mockResolvedValue(['run-old-1', 'run-old-2']);
      mockExtractionFindIdsByRunId.mockImplementation(async (runId: string) => {
        if (runId === 'run-old-1') return ['ext-a', 'ext-b'];
        if (runId === 'run-old-2') return ['ext-c'];
        return [];
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if ((url as string).includes('/extractions')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/entity-sources')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/entities')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/schema')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    version: 1,
                    fields: [],
                    fieldAliases: [],
                    createdAt: '2026-01-01',
                    parentVersion: null,
                  },
                }),
            };
          }
          if ((url as string).includes('/usage')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    period: {},
                    totalTokens: 0,
                    totalCostUsd: 0,
                    byModel: {},
                    byPurpose: {},
                    byJob: [],
                  },
                }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
          };
        }),
      );

      const callOrder: string[] = [];
      mockEntitySourceDeleteByExtractionIds.mockImplementation(async () => {
        callOrder.push('deleteByExtractionIds');
        return 0;
      });
      mockExtractionDeleteByRunIds.mockImplementation(async () => {
        callOrder.push('deleteByRunIds');
        return 0;
      });

      await runPullCommand({
        remoteName: 'prod',
        metaGet: mockMetaGet,
        metaSet: mockMetaSet,
        metaDelete: mockMetaDelete,
        adapter: buildAdapterWithAll() as any,
        projectId: 'test-project',
        projectRoot: '/tmp/test',
        full: true,
        includeExtractions: true,
      });

      // entity_sources deleted before extractions
      expect(callOrder).toEqual(['deleteByExtractionIds', 'deleteByRunIds']);
      expect(mockEntitySourceDeleteByExtractionIds).toHaveBeenCalledWith([
        'ext-a',
        'ext-b',
        'ext-c',
      ]);
      expect(mockExtractionDeleteByRunIds).toHaveBeenCalledWith(['run-old-1', 'run-old-2']);
    });
  });

  // -------------------------------------------------------------------------
  // --full with --include-actions
  // -------------------------------------------------------------------------

  describe('pull --full with --include-actions', () => {
    const mockActionUpsertBatch = vi.fn().mockResolvedValue({ inserted: 0, updated: 0 });
    const mockActionDeleteByRunIds = vi.fn().mockResolvedValue(0);

    function buildAdapterWithActions() {
      return {
        ...buildMockAdapter(),
        actionRepo: {
          upsertBatch: mockActionUpsertBatch,
          deleteByRunIds: mockActionDeleteByRunIds,
        },
      };
    }

    beforeEach(() => {
      mockActionUpsertBatch.mockReset().mockResolvedValue({ inserted: 0, updated: 0 });
      mockActionDeleteByRunIds.mockReset().mockResolvedValue(0);
    });

    it('clears actions on --full before pulling', async () => {
      mockMetaGet.mockImplementation(async (key: string) => {
        if (key === 'remote:prod:job_id') return 'remote-job-1';
        return null;
      });
      mockFindIdsBySourcePrefix.mockResolvedValue(['run-old-1']);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if ((url as string).includes('/actions')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/entities')) {
            return {
              ok: true,
              status: 200,
              json: () => Promise.resolve({ data: [], pagination: { hasMore: false, total: 0 } }),
            };
          }
          if ((url as string).includes('/schema')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    version: 1,
                    fields: [],
                    fieldAliases: [],
                    createdAt: '2026-01-01',
                    parentVersion: null,
                  },
                }),
            };
          }
          if ((url as string).includes('/usage')) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: {
                    period: {},
                    totalTokens: 0,
                    totalCostUsd: 0,
                    byModel: {},
                    byPurpose: {},
                    byJob: [],
                  },
                }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: { id: 'remote-job-1', status: 'completed' } }),
          };
        }),
      );

      await runPullCommand({
        remoteName: 'prod',
        metaGet: mockMetaGet,
        metaSet: mockMetaSet,
        metaDelete: mockMetaDelete,
        adapter: buildAdapterWithActions() as any,
        projectId: 'test-project',
        projectRoot: '/tmp/test',
        full: true,
        includeActions: true,
      });

      expect(mockActionDeleteByRunIds).toHaveBeenCalledWith(['run-old-1']);
    });
  });
});
