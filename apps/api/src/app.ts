import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { depsMiddleware } from './middleware/deps.js';
import { validateTenantMiddleware } from './middleware/validate-tenant.js';
import { jobRoutes } from './routes/jobs.js';
import { schemaRoutes } from './routes/schemas.js';
import { extractionRoutes } from './routes/extractions.js';
import { entityRoutes } from './routes/entities.js';
import { actionRoutes } from './routes/actions.js';
import { exportRoutes } from './routes/exports.js';
import { tenantRoutes } from './routes/tenants.js';
import type { AppDeps, AppEnv } from './types.js';

export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: result.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join(', '),
              requestId,
            },
          },
          400,
        );
      }
    },
  });

  // Global middleware
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
