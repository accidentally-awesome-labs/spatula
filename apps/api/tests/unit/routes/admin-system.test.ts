import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

const ALL_QUEUE_COUNTS = { waiting: 1, active: 2, completed: 10, failed: 0, delayed: 3 };

function makeQueue() {
  return {
    getJobCounts: vi.fn().mockImplementation((...types: string[]) => {
      const result: Record<string, number> = {};
      for (const t of types) {
        result[t] = ALL_QUEUE_COUNTS[t as keyof typeof ALL_QUEUE_COUNTS] ?? 0;
      }
      return Promise.resolve(result);
    }),
  };
}

function createMockRedis(overrides: Record<string, any> = {}) {
  return {
    ping: vi.fn().mockResolvedValue('PONG'),
    eval: vi.fn().mockResolvedValue([1, 1]), // rate-limit middleware uses redis.eval
    ...overrides,
  } as any;
}

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: {
      end: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      totalCount: 10,
      idleCount: 5,
      waitingCount: 0,
    } as unknown as Pool,
    jobRepo: {
      findById: vi.fn(),
      findByTenant: vi.fn(),
      countByTenant: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
      deleteWithData: vi.fn(),
      countAll: vi.fn().mockResolvedValue(5),
    } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {
      createJob: vi.fn(), startJob: vi.fn(), pauseJob: vi.fn(),
      resumeJob: vi.fn(), cancelJob: vi.fn(), triggerReconciliation: vi.fn(),
    } as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    tenantRepo: {
      findById: vi.fn().mockResolvedValue({ id: TENANT_ID, name: 'Test Tenant', config: {} }),
      countAll: vi.fn().mockResolvedValue(3),
      getTotalStorage: vi.fn().mockResolvedValue(1048576),
    } as any,
    redis: createMockRedis(),
    queues: {
      crawl: makeQueue(),
      extract: makeQueue(),
      schemaEvolution: makeQueue(),
      reconciliation: makeQueue(),
      export: makeQueue(),
      webhook: makeQueue(),
      config: {} as any,
      closeAll: vi.fn(),
    } as any,
    dlqRepo: {
      countUnresolved: vi.fn().mockResolvedValue(2),
    } as any,
    auditLogger: { log: vi.fn() } as any,
    ...overrides,
  };
}

const tenantHeader = { 'x-tenant-id': TENANT_ID };

describe('GET /api/v1/admin/system/health', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns detailed status with postgres ok, redis ok, and queue counts', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/health', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.postgres).toBe('ok');
    expect(body.data.redis).toBe('ok');
    expect(body.data.queues.crawl).toEqual({ waiting: 1, active: 2, completed: 10, failed: 0, delayed: 3 });
    expect(body.data.queues.extract).toBeDefined();
    expect(body.data.queues.webhook).toBeDefined();
    expect(body.data.pool).toEqual({ total: 10, idle: 5, waiting: 0 });
    expect(body.data.memory).toHaveProperty('rss');
    expect(body.data.memory).toHaveProperty('heapUsed');
    expect(body.data.memory).toHaveProperty('heapTotal');
  });

  it('marks redis as not_configured when undefined', async () => {
    deps = createMockDeps({ redis: undefined });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/health', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.redis).toBe('not_configured');
  });

  it('marks postgres as error when query fails', async () => {
    deps = createMockDeps({
      dbPool: {
        end: vi.fn(),
        query: vi.fn().mockRejectedValue(new Error('connection refused')),
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
      } as unknown as Pool,
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/health', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.postgres).toBe('error');
  });

  it('marks redis as error when ping fails', async () => {
    deps = createMockDeps({
      redis: createMockRedis({ ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }),
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/health', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.redis).toBe('error');
  });

  it('returns empty queues object when queues are not configured', async () => {
    deps = createMockDeps({ queues: undefined });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/health', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.queues).toEqual({});
  });

  it('marks individual queue as unavailable on error', async () => {
    const failingQueue = { getJobCounts: vi.fn().mockRejectedValue(new Error('disconnected')) };
    deps = createMockDeps({
      queues: {
        crawl: failingQueue,
        extract: makeQueue(),
        schemaEvolution: makeQueue(),
        reconciliation: makeQueue(),
        export: makeQueue(),
        webhook: makeQueue(),
        config: {} as any,
        closeAll: vi.fn(),
      } as any,
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/health', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.queues.crawl).toEqual({ error: 'unavailable' });
    expect(body.data.queues.extract).toEqual({ waiting: 1, active: 2, completed: 10, failed: 0, delayed: 3 });
  });
});

describe('GET /api/v1/admin/system/metrics', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns totalTenants, activeJobs, totalStorageBytes, dlqDepth, and queues', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/metrics', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalTenants).toBe(3);
    expect(body.data.activeJobs).toBe(5);
    expect(body.data.totalStorageBytes).toBe(1048576);
    expect(body.data.dlqDepth).toBe(2);
    expect(body.data.queues).toBeDefined();
    expect(body.data.queues.crawl).toEqual({ waiting: 1, active: 2, failed: 0 });
  });

  it('returns zero for tenants and storage when tenantRepo is not configured', async () => {
    deps = createMockDeps({ tenantRepo: undefined });
    // When tenantRepo is undefined, validate-tenant middleware skips tenant check
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/metrics', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalTenants).toBe(0);
    expect(body.data.totalStorageBytes).toBe(0);
  });

  it('returns zero dlqDepth when dlqRepo is not configured', async () => {
    deps = createMockDeps({ dlqRepo: undefined });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/system/metrics', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.dlqDepth).toBe(0);
  });

  it('calls jobRepo.countAll with status running', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/admin/system/metrics', { headers: tenantHeader });

    expect((deps.jobRepo as any).countAll).toHaveBeenCalledWith({ status: 'running' });
  });
});
