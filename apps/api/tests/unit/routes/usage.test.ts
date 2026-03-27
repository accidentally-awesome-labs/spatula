import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { usageRoutes } from '../../../src/routes/usage.js';

function createTestApp(mockDeps: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['jobs:read'] });
    c.set('deps', mockDeps);
    return next();
  });
  app.route('/api/v1/usage', usageRoutes());
  return app;
}

describe('Usage routes', () => {
  let mockLlmUsageRepo: any;

  beforeEach(() => {
    mockLlmUsageRepo = {
      aggregateByTenant: vi.fn().mockResolvedValue({
        totalTokens: 1250000, totalCostUsd: 4.23,
        byModel: { 'anthropic/claude-3-haiku': { tokens: 800000, costUsd: 0.80 } },
        byPurpose: { extraction: { tokens: 500000, costUsd: 2.10 } },
        byJob: [{ jobId: 'job-1', tokens: 125000, costUsd: 0.42 }],
      }),
    };
  });

  it('returns aggregated usage for default 30d period', async () => {
    const app = createTestApp({ llmUsageRepo: mockLlmUsageRepo });
    const res = await app.request('/api/v1/usage');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalTokens).toBe(1250000);
    expect(body.data.totalCostUsd).toBe(4.23);
    expect(body.data.period).toBeDefined();
  });

  it('accepts custom period parameter', async () => {
    const app = createTestApp({ llmUsageRepo: mockLlmUsageRepo });
    const res = await app.request('/api/v1/usage?period=7d');
    expect(res.status).toBe(200);
    expect(mockLlmUsageRepo.aggregateByTenant).toHaveBeenCalledWith('tenant-1', expect.any(Date));
  });
});
