import type { MiddlewareHandler } from 'hono';
import type { AuthProvider, AuditLogger } from '@spatula/shared';

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

export function authMiddleware(provider: AuthProvider, auditLogger?: AuditLogger): MiddlewareHandler {
  return async (c, next) => {
    if (SKIP_AUTH_PATHS.has(c.req.path)) {
      return next();
    }
    if (SKIP_AUTH_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      return next();
    }

    let result;
    try {
      result = await provider.authenticate(c.req);
    } catch (error) {
      if (auditLogger) {
        auditLogger.log({
          actorId: 'unknown',
          actorType: 'system',
          action: 'auth.login_failure',
          metadata: { error: (error as Error).message, path: c.req.path },
          ipAddress: (c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))?.split(',')[0]?.trim(),
        });
      }
      throw error;
    }

    if (auditLogger) {
      auditLogger.log({
        tenantId: result.tenantId,
        actorId: result.userId,
        actorType: result.userId === 'anonymous' ? 'system' : 'api_key',
        action: 'auth.login_success',
        ipAddress: (c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))?.split(',')[0]?.trim(),
      });
    }

    c.set('tenantId', result.tenantId);
    c.set('auth', result);
    return next();
  };
}
