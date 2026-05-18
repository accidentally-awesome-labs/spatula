import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/types.js';
import type { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

const SAMPLE_DLQ_ENTRY = {
  id: 'dlq-1',
  queueName: 'spatula.crawl',
  jobId: 'bullmq-123',
  tenantId: TENANT_ID,
  spatulaJobId: 'job-1',
  payload: { taskId: 'task-1', url: 'https://example.com' },
  errorMessage: 'Network timeout',
  errorStack: 'Error: Network timeout\n    at ...',
  attempts: 3,
  failedAt: new Date('2026-03-25T10:00:00Z'),
  resolvedAt: null,
  resolution: null,
};

function createMockDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    dbPool: { end: vi.fn() } as unknown as Pool,
    jobRepo: {
      findById: vi.fn(),
      findByTenant: vi.fn(),
      countByTenant: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateStats: vi.fn(),
      deleteWithData: vi.fn(),
    } as any,
    schemaRepo: {} as any,
    extractionRepo: {} as any,
    entityRepo: {} as any,
    entitySourceRepo: {} as any,
    actionRepo: {} as any,
    taskRepo: {} as any,
    jobManager: {
      createJob: vi.fn(),
      startJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      triggerReconciliation: vi.fn(),
    } as any,
    exportRepo: {} as any,
    contentStore: {} as any,
    exportQueue: {} as any,
    dlqRepo: {
      findUnresolved: vi.fn().mockResolvedValue([SAMPLE_DLQ_ENTRY]),
      countUnresolved: vi.fn().mockResolvedValue(1),
      findById: vi.fn().mockResolvedValue(SAMPLE_DLQ_ENTRY),
      resolve: vi
        .fn()
        .mockResolvedValue({ ...SAMPLE_DLQ_ENTRY, resolvedAt: new Date(), resolution: 'retried' }),
      insert: vi.fn(),
    } as any,
    ...overrides,
  };
}

const tenantHeader = { 'x-tenant-id': TENANT_ID };

describe('GET /api/v1/admin/dlq', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns unresolved entries with pagination', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].queueName).toBe('spatula.crawl');
    expect(body.pagination).toEqual({ total: 1, limit: 50, offset: 0 });
  });

  it('passes queue filter and pagination params to repo', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/admin/dlq?queue=spatula.export&limit=10&offset=5', {
      headers: tenantHeader,
    });

    // NoAuthProvider gives admin scope, so tenantId is omitted for cross-tenant access
    expect((deps as any).dlqRepo.findUnresolved).toHaveBeenCalledWith({
      queueName: 'spatula.export',
      tenantId: undefined,
      limit: 10,
      offset: 5,
    });
    expect((deps as any).dlqRepo.countUnresolved).toHaveBeenCalledWith('spatula.export', undefined);
  });

  it('clamps limit to max 100', async () => {
    const app = createApp(deps);
    await app.request('/api/v1/admin/dlq?limit=500', { headers: tenantHeader });

    expect((deps as any).dlqRepo.findUnresolved).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('returns 503 when dlqRepo is not configured', async () => {
    deps = createMockDeps({ dlqRepo: undefined });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq', { headers: tenantHeader });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_CONFIGURED');
  });
});

describe('GET /api/v1/admin/dlq/:id', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns single DLQ entry', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1', { headers: tenantHeader });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('dlq-1');
    expect(body.data.queueName).toBe('spatula.crawl');
  });

  it('returns 404 for non-existent entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/nonexistent', { headers: tenantHeader });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/v1/admin/dlq/:id/retry', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('resolves entry as retried', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolution).toBe('retried');
    expect((deps as any).dlqRepo.resolve).toHaveBeenCalledWith('dlq-1', 'retried');
  });

  it('re-enqueues job to original queue when queues are available', async () => {
    const mockCrawlQueue = { add: vi.fn().mockResolvedValue({}) };
    deps = createMockDeps({
      queues: {
        crawl: mockCrawlQueue,
        schemaEvolution: { add: vi.fn() },
        reconciliation: { add: vi.fn() },
        export: { add: vi.fn() },
      } as any,
    });

    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    expect(mockCrawlQueue.add).toHaveBeenCalledWith(
      expect.stringContaining('dlq-retry:'),
      SAMPLE_DLQ_ENTRY.payload,
    );
  });

  it('skips re-enqueue gracefully when queue name is unknown', async () => {
    const unknownQueueEntry = {
      ...SAMPLE_DLQ_ENTRY,
      queueName: 'spatula.unknown-queue',
    };
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue(unknownQueueEntry);

    const mockQueues = {
      crawl: { add: vi.fn() },
      schemaEvolution: { add: vi.fn() },
      reconciliation: { add: vi.fn() },
      export: { add: vi.fn() },
    };
    deps = createMockDeps({
      dlqRepo: (deps as any).dlqRepo,
      queues: mockQueues as any,
    });

    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });

    // Should still resolve as retried, just no re-enqueue
    expect(res.status).toBe(200);
    expect(mockQueues.crawl.add).not.toHaveBeenCalled();
    expect(mockQueues.export.add).not.toHaveBeenCalled();
    expect((deps as any).dlqRepo.resolve).toHaveBeenCalledWith('dlq-1', 'retried');
  });

  it('returns 404 for non-existent entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(404);
  });

  it('returns 409 for already-resolved entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue({
      ...SAMPLE_DLQ_ENTRY,
      resolvedAt: new Date(),
      resolution: 'discarded',
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_RESOLVED');
  });
});

describe('POST /api/v1/admin/dlq/:id/discard', () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('resolves entry as discarded', async () => {
    (deps as any).dlqRepo.resolve = vi.fn().mockResolvedValue({
      ...SAMPLE_DLQ_ENTRY,
      resolvedAt: new Date(),
      resolution: 'discarded',
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/discard', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolution).toBe('discarded');
    expect((deps as any).dlqRepo.resolve).toHaveBeenCalledWith('dlq-1', 'discarded');
  });

  it('returns 404 for non-existent entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue(null);
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/discard', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(404);
  });

  it('returns 409 for already-resolved entry', async () => {
    (deps as any).dlqRepo.findById = vi.fn().mockResolvedValue({
      ...SAMPLE_DLQ_ENTRY,
      resolvedAt: new Date(),
      resolution: 'retried',
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/discard', {
      method: 'POST',
      headers: tenantHeader,
    });

    expect(res.status).toBe(409);
  });
});

describe('admin cross-tenant DLQ access', () => {
  it('omits tenantId filter when caller has admin scope', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq', { headers: tenantHeader });
    expect(res.status).toBe(200);
    expect(deps.dlqRepo!.findUnresolved).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: undefined }),
    );
  });

  it('returns entries from all tenants', async () => {
    const otherTenantEntry = {
      ...SAMPLE_DLQ_ENTRY,
      id: 'dlq-2',
      tenantId: '00000000-0000-0000-0000-000000000099',
    };
    const deps = createMockDeps({
      dlqRepo: {
        findUnresolved: vi.fn().mockResolvedValue([SAMPLE_DLQ_ENTRY, otherTenantEntry]),
        countUnresolved: vi.fn().mockResolvedValue(2),
        findById: vi.fn(),
        resolve: vi.fn(),
        insert: vi.fn(),
      } as any,
    });
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq', { headers: tenantHeader });
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it('admin can access single DLQ entry from any tenant (GET /:id)', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1', { headers: tenantHeader });
    expect(res.status).toBe(200);
    expect(deps.dlqRepo!.findById).toHaveBeenCalledWith('dlq-1', undefined);
  });

  it('admin can retry DLQ entry from any tenant (POST /:id/retry)', async () => {
    const deps = createMockDeps();
    const app = createApp(deps);
    const res = await app.request('/api/v1/admin/dlq/dlq-1/retry', {
      method: 'POST',
      headers: tenantHeader,
    });
    expect(res.status).toBe(200);
    expect(deps.dlqRepo!.findById).toHaveBeenCalledWith('dlq-1', undefined);
  });
});
