import type { MiddlewareHandler } from 'hono';
import { ErrorCode } from '@spatula/shared';
import type { AuthProvider, AuditLogger } from '@spatula/shared';
import type { UserTenantRepository, TenantRepository } from '@spatula/db';

const SKIP_AUTH_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/api/docs',
  '/api/openapi.json',
]);

const SKIP_AUTH_PREFIXES = ['/api/v1/tenants'];

export function authMiddleware(
  provider: AuthProvider,
  auditLogger?: AuditLogger,
  userTenantRepo?: UserTenantRepository,
  tenantRepo?: TenantRepository,
): MiddlewareHandler {
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
          ipAddress: (c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))
            ?.split(',')[0]
            ?.trim(),
        });
      }
      throw error;
    }

    // JWT tenant resolution: resolve tenant from user_tenants table
    if (result.strategy === 'jwt' && userTenantRepo && tenantRepo) {
      const entries = await userTenantRepo.findByUserId(result.userId);
      let resolvedTenantId: string;

      if (entries.length === 0) {
        // Auto-create a Free tenant for new JWT users.
        // Race condition: two concurrent requests may both see 0 entries.
        // userTenantRepo.create uses ON CONFLICT DO NOTHING, so the second
        // insert is a no-op. We re-query after to get the winning tenant.
        try {
          const tenantName = result.displayName ?? result.userId;
          const newTenant = await tenantRepo.create({ name: tenantName });
          await userTenantRepo.create(result.userId, newTenant.id, 'owner');
        } catch {
          // Ignore — a racing request may have created the tenant already
        }
        const refreshed = await userTenantRepo.findByUserId(result.userId);
        if (refreshed.length === 0) {
          return c.json(
            {
              // Phase 16 plan 16-1: frozen DOMAIN.CODE enum value (was 'SERVER_ERROR').
              error: { code: ErrorCode.INTERNAL_ERROR, message: 'Failed to provision tenant' },
            },
            500,
          );
        }
        resolvedTenantId = refreshed[0].tenantId;
      } else if (entries.length === 1) {
        // Single tenant: auto-select
        resolvedTenantId = entries[0].tenantId;
      } else {
        // Multiple tenants: require X-Tenant-Id header
        const requestedTenantId = c.req.header('x-tenant-id');
        if (!requestedTenantId) {
          return c.json(
            {
              // Phase 16 plan 16-1: frozen DOMAIN.CODE enum value (was 'TENANT_REQUIRED').
              error: {
                code: ErrorCode.VALIDATION_PARAMS,
                message: 'Multiple tenants found. Specify X-Tenant-Id header.',
                details: {
                  reason: 'tenant_selection_required',
                  tenants: entries.map((e) => ({ tenantId: e.tenantId, role: e.role })),
                },
              },
            },
            400,
          );
        }
        // Verify user belongs to the specified tenant
        const match = entries.find((e) => e.tenantId === requestedTenantId);
        if (!match) {
          return c.json(
            {
              // Phase 16 plan 16-1: frozen DOMAIN.CODE enum value (was 'TENANT_FORBIDDEN').
              error: {
                code: ErrorCode.AUTH_INSUFFICIENT_SCOPE,
                message: 'User does not belong to the specified tenant.',
                details: { requestedTenantId },
              },
            },
            403,
          );
        }
        resolvedTenantId = requestedTenantId;
      }

      const resolvedResult = { ...result, tenantId: resolvedTenantId };

      if (auditLogger) {
        auditLogger.log({
          tenantId: resolvedResult.tenantId,
          actorId: resolvedResult.userId,
          actorType: 'user',
          action: 'auth.login_success',
          ipAddress: (c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))
            ?.split(',')[0]
            ?.trim(),
        });
      }

      c.set('tenantId', resolvedResult.tenantId);
      c.set('auth', resolvedResult);
      return next();
    }

    // Non-JWT strategies (api-key, none): existing behavior unchanged
    if (auditLogger) {
      auditLogger.log({
        tenantId: result.tenantId,
        actorId: result.userId,
        actorType: result.userId === 'anonymous' ? 'system' : 'api_key',
        action: 'auth.login_success',
        ipAddress: (c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))
          ?.split(',')[0]
          ?.trim(),
      });
    }

    c.set('tenantId', result.tenantId);
    c.set('auth', result);
    return next();
  };
}
