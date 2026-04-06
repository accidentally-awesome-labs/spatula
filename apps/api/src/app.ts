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
import { adminWorkerRoutes } from './routes/admin-workers.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { qualityRoutes } from './routes/quality.js';
import { timingMiddleware } from './middleware/timing.js';
import { wsTokenRoutes } from './routes/ws-token.js';
import { usageRoutes } from './routes/usage.js';
import { healthRoutes } from './routes/health.js';
import { createQueueDashboard } from './routes/admin-queues.js';
import { batchActionRoutes } from './routes/batch-actions.js';
import { batchJobRoutes } from './routes/batch-jobs.js';
import { timeoutMiddleware } from './middleware/timeout.js';
import { createAuthProvider } from './auth/factory.js';
import type { AppDeps } from './types.js';
import { getEnvOrDefault } from '@spatula/shared';

export function createApp(deps: AppDeps) {
  const app = createOpenAPIRouter();
  const authStrategy = getEnvOrDefault('AUTH_STRATEGY', 'none');
  const authProvider = deps.authProvider ?? createAuthProvider(authStrategy, {
    apiKeyRepo: deps.apiKeyRepo!,
    jwtConfig: authStrategy === 'jwt' ? {
      issuer: getEnvOrDefault('JWT_ISSUER', ''),
      audience: getEnvOrDefault('JWT_AUDIENCE', ''),
      jwksUrl: getEnvOrDefault('JWT_JWKS_URL', ''),
    } : undefined,
  });

  // Global middleware chain (order matters)
  app.use('*', requestContextMiddleware);
  app.use('*', timingMiddleware(deps.metrics ?? null));
  app.use('*', honoLogger());
  app.use('*', securityHeaders);
  app.use('*', timeoutMiddleware({
    defaultMs: 30_000,
    overrides: { '/api/v1/exports/:exportId/download': 300_000 },
  }));
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
      allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Tenant-Id', 'Idempotency-Key'],
      exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-Request-Id'],
      maxAge: 86400,
      credentials: true,
    }),
  );

  // Health check (no auth — authMiddleware skips /health)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Deep health checks (no auth — paths are in SKIP_AUTH_PATHS)
  app.route('', healthRoutes({ dbPool: deps.dbPool, redis: deps.redis, queues: deps.queues }));

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
  app.use('/api/*', authMiddleware(authProvider, deps.auditLogger, deps.userTenantRepo, deps.tenantRepo));
  app.use('/api/*', depsMiddleware(deps));
  app.use('/api/*', validateTenantMiddleware);

  // Load tenant quotas for rate limiting
  app.use('/api/*', async (c, next) => {
    const tenantId = c.get('tenantId');
    if (tenantId && deps.tenantRepo) {
      try {
        const quotas = await deps.tenantRepo.getQuotas(tenantId);
        c.set('rateLimitTier', (quotas as any).rateLimitTier ?? 'free');
      } catch {
        c.set('rateLimitTier', 'free');
      }
    }
    return next();
  });

  // Rate limiting (after auth + quota loading)
  if (deps.redis) {
    app.use('/api/*', rateLimitMiddleware(deps.redis));
  }

  // Idempotency (after rate limiting, before routes)
  app.use('/api/*', idempotencyMiddleware());

  // Tenant management routes (auth skipped by authMiddleware prefix check)
  // TODO(Wave 3-1b): Add admin-only or shared-secret protection for tenant creation
  // in production. Currently open for bootstrap — acceptable for dev/self-hosted.
  app.route('/api/v1/tenants', tenantRoutes());

  // API key management routes
  app.use('/api/v1/api-keys', requireScope('keys:manage'));
  app.use('/api/v1/api-keys/*', requireScope('keys:manage'));
  app.route('/api/v1/api-keys', apiKeyRoutes());

  // WebSocket token endpoint
  if (deps.redis) {
    app.route('/api/v1/ws-token', wsTokenRoutes());
  }

  // Batch operations (registered before parameterized routes so /batch matches first)
  app.post('/api/v1/actions/batch', requireScope('actions:write'));
  app.route('/api/v1/actions', batchActionRoutes());
  app.post('/api/v1/jobs/batch', requireScope('jobs:write'));
  app.route('/api/v1/jobs', batchJobRoutes());

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
  app.get('/api/v1/jobs/:jobId/quality', requireScope('jobs:read'));
  app.route('/api/v1/jobs/:jobId/quality', qualityRoutes());

  // Usage API (requires jobs:read scope)
  app.get('/api/v1/usage', requireScope('jobs:read'));
  app.route('/api/v1/usage', usageRoutes());

  // Admin routes
  app.use('/api/v1/admin/*', requireScope('admin'));
  app.route('/api/v1/admin/dlq', adminDlqRoutes());
  app.route('/api/v1/admin/workers', adminWorkerRoutes());

  // Queue dashboard (admin scope enforced by /api/v1/admin/* middleware)
  if (deps.queues) {
    try {
      app.route('', createQueueDashboard(deps.queues));
    } catch {
      // Bull Board requires real BullMQ Queue instances; skip in test/mock environments
    }
  }

  return app;
}
