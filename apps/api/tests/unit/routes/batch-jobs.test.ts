import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { batchJobRoutes } from '../../../src/routes/batch-jobs.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createTestApp(deps: any) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['jobs:write'] });
    return next();
  });
  app.route('/api/v1/jobs', batchJobRoutes());
  return app;
}

describe('POST /api/v1/jobs/batch', () => {
  let deps: any;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = {
      jobRepo: {
        findById: vi.fn(),
        updateStatus: vi.fn().mockResolvedValue({}),
        deleteWithData: vi.fn().mockResolvedValue(undefined),
      },
      auditLogger: { log: vi.fn() },
    };
    app = createTestApp(deps);
  });

  it('cancels multiple jobs', async () => {
    deps.jobRepo.findById
      .mockResolvedValueOnce({
        id: '00000000-0000-0000-0000-000000000001',
        status: 'running',
        tenantId: 'tenant-1',
      })
      .mockResolvedValueOnce({
        id: '00000000-0000-0000-0000-000000000002',
        status: 'paused',
        tenantId: 'tenant-1',
      });

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'cancel',
        ids: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual([
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    ]);
    expect(deps.jobRepo.updateStatus).toHaveBeenCalledTimes(2);
  });

  it('deletes multiple jobs', async () => {
    deps.jobRepo.findById
      .mockResolvedValueOnce({
        id: '00000000-0000-0000-0000-000000000001',
        status: 'completed',
        tenantId: 'tenant-1',
      })
      .mockResolvedValueOnce({
        id: '00000000-0000-0000-0000-000000000002',
        status: 'failed',
        tenantId: 'tenant-1',
      });

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        ids: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual([
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    ]);
    expect(deps.jobRepo.deleteWithData).toHaveBeenCalledTimes(2);
  });

  it('returns partial failure for not-found jobs', async () => {
    deps.jobRepo.findById.mockResolvedValueOnce(null);

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', ids: ['00000000-0000-0000-0000-000000000099'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual([]);
    expect(body.data.failed).toEqual([
      { id: '00000000-0000-0000-0000-000000000099', error: 'Job not found' },
    ]);
  });

  it('rejects cancel on completed job', async () => {
    deps.jobRepo.findById.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000001',
      status: 'completed',
      tenantId: 'tenant-1',
    });

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', ids: ['00000000-0000-0000-0000-000000000001'] }),
    });

    const body = await res.json();
    expect(body.data.failed[0].error).toContain('Cannot cancel');
  });

  it('rejects batch larger than 100', async () => {
    const ids = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    );

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', ids }),
    });

    expect(res.status).toBe(400);
  });
});
