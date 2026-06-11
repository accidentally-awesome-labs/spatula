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
import {
  createOpenAPIRouter,
  getCachedOpenAPISpec,
  validateExamplesAtBoot,
} from './openapi-config.js';
import { openapiRoute } from './routes/openapi.js';
import { wellKnownRoute } from './routes/well-known.js';
import { jobRoutes } from './routes/jobs.js';
import { schemaRoutes } from './routes/schemas.js';
import { extractionRoutes } from './routes/extractions.js';
import { entityRoutes } from './routes/entities.js';
import { actionRoutes } from './routes/actions.js';
import { exportRoutes } from './routes/exports.js';
import { tenantRoutes } from './routes/tenants.js';
import { adminDlqRoutes } from './routes/admin-dlq.js';
import { adminWorkerRoutes } from './routes/admin-workers.js';
import { adminTenantRoutes } from './routes/admin-tenants.js';
import { adminForensicRoutes } from './routes/admin-forensic.js';
import { adminJobRoutes } from './routes/admin-jobs.js';
import { adminSystemRoutes } from './routes/admin-system.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { qualityRoutes } from './routes/quality.js';
import { entitySourceRoutes } from './routes/entity-sources.js';
import { timingMiddleware } from './middleware/timing.js';
import { wsTokenRoutes } from './routes/ws-token.js';
import { jobEventsRoute } from './routes/job-events.js';
import { createSseHandler } from './sse/handler.js';
import { usageRoutes } from './routes/usage.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { createQueueDashboard } from './routes/admin-queues.js';
import { batchActionRoutes } from './routes/batch-actions.js';
import { batchJobRoutes } from './routes/batch-jobs.js';
import { timeoutMiddleware } from './middleware/timeout.js';
import { createAuthProvider } from './auth/factory.js';
import type { AppDeps } from './types.js';
import { getEnvOrDefault } from '@spatula/shared';
import { buildOriginMatcher } from './lib/cors-origin.js';

export function createApp(deps: AppDeps) {
  const app = createOpenAPIRouter();
  const authStrategy = getEnvOrDefault('AUTH_STRATEGY', 'none');
  const authProvider =
    deps.authProvider ??
    createAuthProvider(authStrategy, {
      apiKeyRepo: deps.apiKeyRepo!,
      jwtConfig:
        authStrategy === 'jwt'
          ? {
              issuer: getEnvOrDefault('JWT_ISSUER', ''),
              audience: getEnvOrDefault('JWT_AUDIENCE', ''),
              jwksUrl: getEnvOrDefault('JWT_JWKS_URL', ''),
            }
          : undefined,
    });

  // Global middleware chain (order matters)
  app.use('*', requestContextMiddleware);
  app.use('*', timingMiddleware(deps.metrics ?? null));
  app.use('*', honoLogger());
  app.use('*', securityHeaders);
  app.use(
    '*',
    timeoutMiddleware({
      defaultMs: 30_000,
      overrides: {
        '/api/v1/exports/:exportId/download': 300_000,
        // SSE connections are long-lived — 0 means no timeout (see timeout.ts).
        // Without this override the 30s default would terminate SSE streams.
        '/api/v1/jobs/:id/events': 0,
      },
    }),
  );
  app.onError(errorHandler);

  // CORS — function-form origin with single-label wildcard support (AUTH-03, D-08 through D-10).
  // buildOriginMatcher returns null if CORS_ALLOWED_ORIGINS is empty or contains a bare `*`.
  // A null result is a misconfiguration: fail fast at boot with CORS_CONFIG_INVALID.
  const corsRaw = getEnvOrDefault('CORS_ALLOWED_ORIGINS', 'http://localhost:3000');
  const originMatcher = buildOriginMatcher(corsRaw);
  if (!originMatcher) {
    throw new Error(
      'CORS_CONFIG_INVALID: CORS_ALLOWED_ORIGINS is empty or malformed (a bare "*" is not allowed)',
    );
  }
  app.use(
    '*',
    cors({
      origin: (origin) => (origin && originMatcher.match(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'X-Request-Id',
        'X-Tenant-Id',
        'Idempotency-Key',
      ],
      // D-09: extends exposeHeaders to include X-RateLimit-Reset + Retry-After
      exposeHeaders: [
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'X-Request-Id',
        'Retry-After',
      ],
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
  app.use(
    '/api/*',
    authMiddleware(authProvider, deps.auditLogger, deps.userTenantRepo, deps.tenantRepo),
  );
  app.use('/api/*', depsMiddleware(deps));
  app.use('/api/*', validateTenantMiddleware);

  // Rate limiting (after auth + quota loading)
  if (deps.redis) {
    app.use('/api/*', rateLimitMiddleware(deps.redis));
  }

  // Idempotency (after rate limiting, before routes)
  app.use('/api/*', idempotencyMiddleware());

  // Tenant management routes — protected by shared secret in production
  const creationSecret = process.env.TENANT_CREATION_SECRET;
  if (creationSecret) {
    app.post('/api/v1/tenants', async (c, next) => {
      if (c.req.header('X-Creation-Secret') !== creationSecret) {
        // Phase 16 plan 16-1: legacy 'FORBIDDEN' → AUTH.INSUFFICIENT_SCOPE
        return c.json(
          {
            error: {
              code: 'AUTH.INSUFFICIENT_SCOPE',
              message: 'Invalid creation secret',
            },
          },
          403,
        );
      }
      return next();
    });
  }
  app.route('/api/v1/tenants', tenantRoutes());

  // API key management routes
  app.use('/api/v1/api-keys', requireScope('keys:manage'));
  app.use('/api/v1/api-keys/*', requireScope('keys:manage'));
  app.route('/api/v1/api-keys', apiKeyRoutes());

  // Auth introspection endpoint — see apps/api/src/routes/auth.ts
  app.route('/api/v1/auth', authRoutes());

  // WebSocket token endpoint
  if (deps.redis) {
    app.route('/api/v1/ws-token', wsTokenRoutes());
  }

  // SSE events endpoint — MUST be registered BEFORE the requireScope('jobs:read') guard
  // on app.get('/api/v1/jobs/*', ...) (line ~187). EventSource cannot send Authorization
  // headers; the handler does its own in-handler GETDEL token auth (RESEARCH Pitfall 2 +
  // Open Question 3). The path is also on the auth-middleware skip-list (see auth.ts).
  //
  // Registered directly on `app` (not a sub-router) because Hono evaluates GET handlers
  // in registration order — a specific route registered BEFORE the wildcard scope guard
  // takes precedence, preventing requireScope from intercepting SSE connections.
  if (deps.redis) {
    app.openapi(jobEventsRoute, createSseHandler(deps) as any);
  }

  // Batch operations (registered before parameterized routes so /batch matches first)
  app.post('/api/v1/actions/batch', requireScope('actions:write'));
  app.route('/api/v1/actions', batchActionRoutes());
  app.post('/api/v1/jobs/batch', requireScope('jobs:write'));
  app.route('/api/v1/jobs', batchJobRoutes());

  // API v1 routes with per-method scope enforcement.
  // SSE path (/api/v1/jobs/:id/events) is intentionally excluded from the
  // wildcard scope guard — it does its own in-handler ?token= auth (RESEARCH Pitfall 2).
  // The SSE route was registered above via app.openapi(jobEventsRoute, ...) before this guard.
  const SSE_PATH_RE = /^\/api\/v1\/jobs\/[^/]+\/events$/;
  const jobsReadScope = requireScope('jobs:read');
  app.get('/api/v1/jobs', jobsReadScope);
  app.get('/api/v1/jobs/*', async (c, next) => {
    if (SSE_PATH_RE.test(c.req.path)) return next(); // SSE: skip scope guard
    return jobsReadScope(c, next);
  });
  app.post('/api/v1/jobs', requireScope('jobs:write'));
  app.post('/api/v1/jobs/*', requireScope('jobs:write'));
  app.patch('/api/v1/jobs/*', requireScope('jobs:write'));
  app.delete('/api/v1/jobs/*', requireScope('jobs:write'));
  app.route('/api/v1/jobs', jobRoutes());
  app.route('/api/v1/jobs/:jobId/schema', schemaRoutes());
  app.route('/api/v1/jobs/:jobId/extractions', extractionRoutes());
  app.route('/api/v1/jobs/:jobId/entity-sources', entitySourceRoutes());
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
  app.route('/api/v1/admin/tenants', adminTenantRoutes());
  app.route('/api/v1/admin/jobs', adminJobRoutes());
  app.route('/api/v1/admin/system', adminSystemRoutes());

  // Forensic extractions endpoint (SEC-05 — x-spatula-experimental: true)
  // Mounted AFTER the /api/v1/admin/* requireScope('admin') guard so that:
  //   - Callers with `admin` scope pass the outer guard AND the inner requireScope('admin:forensic:read')
  //     (the inner guard allows `admin` superset via requireScope's existing logic).
  //   - Callers with only `admin:forensic:read` are rejected by the outer `admin` guard — this is
  //     intentional: the forensic surface is strictly admin-tier. See Plan 18-05 Open Question 3.
  app.route('/api/v1/admin/forensic', adminForensicRoutes());

  // Queue dashboard (admin scope enforced by /api/v1/admin/* middleware)
  if (deps.queues) {
    try {
      app.route('', createQueueDashboard(deps.queues));
    } catch {
      // Bull Board requires real BullMQ Queue instances; skip in test/mock environments
    }
  }

  // === Phase 16 plan 16-3 route mounts (additional routes inserted AFTER all
  // other routes register; ordering is load-bearing — the cached OpenAPI spec
  // must include every registered route). ===
  app.route('/api/v1', openapiRoute(app));
  app.route('/', wellKnownRoute()); // /.well-known/spatula-version is a sibling of /api/v1

  // === dev-only example validation (D-16). Skip in NODE_ENV=production so
  // production cold-starts are not blocked on schema compile. ===
  if (process.env.NODE_ENV !== 'production') {
    const { errors } = validateExamplesAtBoot(getCachedOpenAPISpec(app));
    if (errors.length) {
      console.error('OpenAPI example validation failed at boot:\n' + errors.join('\n'));
      throw new Error('OpenAPI example validation failed (dev/test only); see logs.');
    }
  }

  return app;
}
