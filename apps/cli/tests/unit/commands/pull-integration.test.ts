// apps/cli/tests/unit/commands/pull-integration.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runPullCommand } from '../../../src/commands/pull.js';
import type { GlobalConfig } from '@spatula/core';

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(() => ({
      version: 1,
      remotes: { prod: { url: 'https://api.test', apiKey: 'sk_test' } },
    } as GlobalConfig)),
  };
});

describe('Pull flow integration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('handles multi-batch cursor pagination', async () => {
    const meta: Record<string, string> = { 'remote:prod:job_id': 'j1' };

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const urlStr = url.toString();

      if (urlStr.includes('/jobs/j1') && !urlStr.includes('/entities')) {
        return { ok: true, status: 200, json: () => Promise.resolve({ data: { id: 'j1', status: 'completed' } }) };
      }
      if (urlStr.includes('/schema')) {
        return { ok: true, status: 200, json: () => Promise.resolve({ data: { version: 1, fields: [], fieldAliases: [], createdAt: '2026-01-01', parentVersion: null } }) };
      }
      if (urlStr.includes('/entities')) {
        const hasCursor = urlStr.includes('cursor=');
        if (!hasCursor) {
          return { ok: true, status: 200, json: () => Promise.resolve({
            data: [{ id: 'e1', mergedData: { x: 1 }, provenance: {}, categories: [], qualityScore: 0.9, tenantId: 't', jobId: 'j1' }],
            pagination: { nextCursor: 'cursor-page2', hasMore: true, total: 2 },
          }) };
        }
        return { ok: true, status: 200, json: () => Promise.resolve({
          data: [{ id: 'e2', mergedData: { x: 2 }, provenance: {}, categories: [], qualityScore: 0.8, tenantId: 't', jobId: 'j1' }],
          pagination: { hasMore: false, total: 2 },
        }) };
      }
      if (urlStr.includes('/usage')) {
        return { ok: true, status: 200, json: () => Promise.resolve({
          data: { period: {}, totalTokens: 500, totalCostUsd: 0.01, byModel: {}, byPurpose: {}, byJob: [{ jobId: 'j1', tokens: 500, costUsd: 0.01 }] },
        }) };
      }
      return { ok: true, status: 200, json: () => Promise.resolve({ data: {} }) };
    }));

    const upsertCalls: unknown[][] = [];
    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: async (k) => meta[k] ?? null,
      metaSet: async (k, v) => { meta[k] = v; },
      metaDelete: async (k) => { delete meta[k]; },
      adapter: {
        entityRepo: {
          upsertBatch: async (batch) => { upsertCalls.push(batch); return { inserted: batch.length, updated: 0 }; },
          deleteByRunIds: async () => 0,
        },
        schemaRepo: {
          findLatest: async () => null,
          create: async () => ({ id: 's1' }),
        },
        runRepo: {
          create: async (data) => ({ id: 'run-1', ...data }),
          updateStats: async () => {},
          findIdsBySourcePrefix: async () => [],
        },
      } as any,
      projectId: 'test',
      projectRoot: '/tmp/test',
    });

    expect(result.success).toBe(true);
    expect(upsertCalls).toHaveLength(2); // Two batches
    expect(result.entitiesInserted).toBe(2);
    expect(result.llmTokens).toBe(500);
    expect(meta['remote:prod:last_pull_at']).toBeDefined();
    expect(meta['remote:prod:pull_cursor']).toBeUndefined();
  });
});
