import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { depsMiddleware } from './middleware/deps.js';
import { jobRoutes } from './routes/jobs.js';
import { schemaRoutes } from './routes/schemas.js';
import { extractionRoutes } from './routes/extractions.js';
import { entityRoutes } from './routes/entities.js';
import { actionRoutes } from './routes/actions.js';
import { exportRoutes } from './routes/exports.js';
import type { AppDeps, AppEnv } from './types.js';

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use('*', honoLogger());
  app.onError(errorHandler);

  // Health check (before tenant middleware)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Tenant + deps injection for all API routes
  app.use('/api/*', tenantMiddleware);
  app.use('/api/*', depsMiddleware(deps));

  // API v1 routes
  app.route('/api/v1/jobs', jobRoutes());
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());
  app.route('/api/v1/jobs/:jobId', exportRoutes());

  return app;
}
