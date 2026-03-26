import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler.js';
import { requestContextMiddleware } from './middleware/request-context.js';
import { securityHeaders } from './middleware/security-headers.js';
import { authMiddleware } from './middleware/auth.js';
import { depsMiddleware } from './middleware/deps.js';
import { validateTenantMiddleware } from './middleware/validate-tenant.js';
import { requireScope } from './middleware/require-scope.js';
import { createOpenAPIRouter } from './openapi-config.js';
import { jobRoutes } from './routes/jobs.js';
import { schemaRoutes } from './routes/schemas.js';
import { extractionRoutes } from './routes/extractions.js';
import { entityRoutes } from './routes/entities.js';
import { actionRoutes } from './routes/actions.js';
import { exportRoutes } from './routes/exports.js';
import { tenantRoutes } from './routes/tenants.js';
import { adminDlqRoutes } from './routes/admin-dlq.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { NoAuthProvider } from './auth/no-auth-provider.js';
import type { AppDeps } from './types.js';
import { getEnvOrDefault } from '@spatula/shared';

export function createApp(deps: AppDeps) {
  const app = createOpenAPIRouter();
  const authProvider = deps.authProvider ?? new NoAuthProvider();

  // Global middleware chain (order matters)
  app.use('*', requestContextMiddleware);
  app.use('*', honoLogger());
  app.use('*', securityHeaders);
  app.onError(errorHandler);

  // CORS
  const allowedOrigins = getEnvOrDefault('CORS_ALLOWED_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim());
  app.use(
    '*',
    cors({
      origin: allowedOrigins,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Tenant-Id'],
      exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-Request-Id'],
      maxAge: 86400,
      credentials: true,
    }),
  );

  // Health check (no auth — authMiddleware skips /health)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // OpenAPI documentation (no auth — authMiddleware skips these)
  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Spatula API',
      version: '1.0.0',
      description: 'AI-powered intelligent web crawling platform',
    },
  });
  app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }));

  // Auth middleware — uses authProvider (NoAuthProvider when AUTH_STRATEGY=none)
  // Note: authMiddleware skips /health, /api/docs, /api/openapi.json, /api/v1/tenants
  app.use('/api/*', authMiddleware(authProvider));
  app.use('/api/*', depsMiddleware(deps));
  app.use('/api/*', validateTenantMiddleware);

  // Tenant management routes (auth skipped by authMiddleware prefix check)
  app.route('/api/v1/tenants', tenantRoutes());

  // API key management routes
  app.use('/api/v1/api-keys', requireScope('keys:manage'));
  app.use('/api/v1/api-keys/*', requireScope('keys:manage'));
  app.route('/api/v1/api-keys', apiKeyRoutes());

  // API v1 routes with per-method scope enforcement
  app.get('/api/v1/jobs', requireScope('jobs:read'));
  app.get('/api/v1/jobs/*', requireScope('jobs:read'));
  app.post('/api/v1/jobs', requireScope('jobs:write'));
  app.post('/api/v1/jobs/*', requireScope('jobs:write'));
  app.patch('/api/v1/jobs/*', requireScope('jobs:write'));
  app.delete('/api/v1/jobs/*', requireScope('jobs:write'));
  app.route('/api/v1/jobs', jobRoutes());
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  app.route('/api/v1/jobs/:jobId/entities', entityRoutes());
  app.get('/api/v1/jobs/:jobId/actions', requireScope('actions:read'));
  app.post('/api/v1/jobs/:jobId/actions/*', requireScope('actions:write'));
  app.route('/api/v1/jobs/:jobId/actions', actionRoutes());
  app.get('/api/v1/jobs/:jobId/exports', requireScope('exports:read'));
  app.get('/api/v1/jobs/:jobId/exports/*', requireScope('exports:read'));
  app.post('/api/v1/jobs/:jobId/exports', requireScope('exports:write'));
  app.route('/api/v1/jobs/:jobId', exportRoutes());

  // Admin routes
  app.use('/api/v1/admin/*', requireScope('admin'));
  app.route('/api/v1/admin/dlq', adminDlqRoutes());

  return app;
}
