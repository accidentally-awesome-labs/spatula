import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { qualityRoutes } from '../../../src/routes/quality.js';

function createTestApp(mockDeps: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['jobs:read'] });
    c.set('deps', mockDeps);
    return next();
  });
  app.route('/api/v1/jobs/:jobId/quality', qualityRoutes());
  return app;
}

describe('Quality routes', () => {
  let mockEntityRepo: any;

  beforeEach(() => {
    mockEntityRepo = {
      getQualityAggregation: vi.fn().mockResolvedValue({
        entityCount: 500, averageQuality: 0.78,
        distribution: { excellent: 120, good: 200, fair: 130, poor: 50 },
        fieldCompleteness: { name: 0.98, price: 0.85, description: 0.72 },
      }),
    };
  });

  it('returns quality aggregation for a job', async () => {
    const app = createTestApp({ entityRepo: mockEntityRepo });
    const res = await app.request('/api/v1/jobs/job-1/quality');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.entityCount).toBe(500);
    expect(body.data.averageQuality).toBe(0.78);
    expect(body.data.distribution.excellent).toBe(120);
    expect(body.data.fieldCompleteness.name).toBe(0.98);
    expect(mockEntityRepo.getQualityAggregation).toHaveBeenCalledWith('job-1', 'tenant-1');
  });
});
