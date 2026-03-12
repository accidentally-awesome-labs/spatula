import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { exportRoutes } from '../../../src/routes/exports.js';
import type { AppDeps, AppEnv } from '../../../src/types.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', {} as AppDeps);
    c.set('tenantId', 'tenant-1');
    return next();
  });
  app.route('/api/v1/jobs/:jobId', exportRoutes());
  return app;
}

describe('Export & documentation stub routes', () => {
  it('POST /export returns 501', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v1/jobs/job-1/export', { method: 'POST' });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('GET /export/:exportId returns 501', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v1/jobs/job-1/export/exp-1');
    expect(res.status).toBe(501);
  });

  it('GET /documentation returns 501', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v1/jobs/job-1/documentation');
    expect(res.status).toBe(501);
  });
});
