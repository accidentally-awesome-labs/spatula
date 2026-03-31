import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { batchActionRoutes } from '../../../src/routes/batch-actions.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createTestApp(deps: any) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['actions:write'] });
    return next();
  });
  app.route('/api/v1/actions', batchActionRoutes());
  return app;
}

describe('POST /api/v1/actions/batch', () => {
  let deps: any;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = {
      actionRepo: {
        findById: vi.fn(),
        updateStatus: vi.fn().mockResolvedValue({}),
      },
      auditLogger: { log: vi.fn() },
    };
    app = createTestApp(deps);
  });

  it('approves multiple actions', async () => {
    deps.actionRepo.findById
      .mockResolvedValueOnce({ id: '00000000-0000-0000-0000-000000000001', status: 'pending_review', tenantId: 'tenant-1' })
      .mockResolvedValueOnce({ id: '00000000-0000-0000-0000-000000000002', status: 'pending_review', tenantId: 'tenant-1' });

    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', ids: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual(['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002']);
    expect(body.data.failed).toEqual([]);
    expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001', 'tenant-1', 'approved', 'user-1');
  });

  it('returns partial failure when action not found', async () => {
    deps.actionRepo.findById
      .mockResolvedValueOnce({ id: '00000000-0000-0000-0000-000000000001', status: 'pending_review', tenantId: 'tenant-1' })
      .mockResolvedValueOnce(null);

    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', ids: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual(['00000000-0000-0000-0000-000000000001']);
    expect(body.data.failed).toEqual([{ id: '00000000-0000-0000-0000-000000000099', error: 'Action not found' }]);
  });

  it('rejects already-processed actions', async () => {
    deps.actionRepo.findById.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', status: 'approved', tenantId: 'tenant-1' });

    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', ids: ['00000000-0000-0000-0000-000000000001'] }),
    });

    const body = await res.json();
    expect(body.data.failed[0].error).toContain('already approved');
  });

  it('rejects batch larger than 100', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', ids }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects invalid action type', async () => {
    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', ids: ['00000000-0000-0000-0000-000000000001'] }),
    });

    expect(res.status).toBe(400);
  });

  it('handles reject action', async () => {
    deps.actionRepo.findById.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', status: 'pending_review', tenantId: 'tenant-1' });

    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', ids: ['00000000-0000-0000-0000-000000000001'] }),
    });

    expect(res.status).toBe(200);
    expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001', 'tenant-1', 'rejected', 'user-1');
  });
});
