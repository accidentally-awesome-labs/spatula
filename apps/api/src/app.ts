import { swaggerUI } from '@hono/swagger-ui';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler.js';
import { requestContextMiddleware } from './middleware/request-context.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { depsMiddleware } from './middleware/deps.js';
import { validateTenantMiddleware } from './middleware/validate-tenant.js';
import { createOpenAPIRouter } from './openapi-config.js';
import { jobRoutes } from './routes/jobs.js';
import { schemaRoutes } from './routes/schemas.js';
import { extractionRoutes } from './routes/extractions.js';
import { entityRoutes } from './routes/entities.js';
import { actionRoutes } from './routes/actions.js';
import { exportRoutes } from './routes/exports.js';
import { tenantRoutes } from './routes/tenants.js';
import type { AppDeps } from './types.js';

export function createApp(deps: AppDeps) {
  const app = createOpenAPIRouter();

  // Global middleware
  app.use('*', requestContextMiddleware);  // NEW — first in chain
  app.use('*', honoLogger());
  app.onError(errorHandler);

  // Health check (no auth)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // OpenAPI documentation (no auth)
  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Spatula API',
      version: '1.0.0',
      description: 'AI-powered intelligent web crawling platform',
    },
  });
  app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }));

  // Tenant management routes (no x-tenant-id required, only deps)
  app.use('/api/v1/tenants', depsMiddleware(deps));
  app.use('/api/v1/tenants/*', depsMiddleware(deps));
  app.route('/api/v1/tenants', tenantRoutes());

  // Tenant + deps injection for all other API routes
  app.use('/api/*', tenantMiddleware);
  app.use('/api/*', depsMiddleware(deps));
  app.use('/api/*', validateTenantMiddleware);

  // API v1 routes
  app.route('/api/v1/jobs', jobRoutes());
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());
  app.route('/api/v1/jobs/:jobId', exportRoutes());

  return app;
}
