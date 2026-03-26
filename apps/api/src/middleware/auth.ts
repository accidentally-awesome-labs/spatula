import type { MiddlewareHandler } from 'hono';
import type { AuthProvider } from '@spatula/shared';

const SKIP_AUTH_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/api/docs',
  '/api/openapi.json',
]);

const SKIP_AUTH_PREFIXES = [
  '/api/v1/tenants',
];

export function authMiddleware(provider: AuthProvider): MiddlewareHandler {
  return async (c, next) => {
    if (SKIP_AUTH_PATHS.has(c.req.path)) {
      return next();
    }
    if (SKIP_AUTH_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      return next();
    }

    const result = await provider.authenticate(c.req);
    c.set('tenantId', result.tenantId);
    c.set('auth', result);
    return next();
  };
}
