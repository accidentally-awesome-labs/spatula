import type { MiddlewareHandler } from 'hono';
import {
  AuthInsufficientScopeError,
  TenantNotFoundError,
} from '@accidentally-awesome-labs/spatula-shared';

export const validateTenantMiddleware: MiddlewareHandler = async (c, next) => {
  const tenantId = c.get('tenantId');
  const deps = c.get('deps');

  if (deps.tenantRepo && tenantId) {
    const tenant = await deps.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new TenantNotFoundError(tenantId);
    }
    const config = (tenant.config ?? {}) as Record<string, unknown>;
    if (config.status === 'suspended') {
      throw new AuthInsufficientScopeError('Account suspended. Contact support.', {
        context: { tenantId, reason: 'suspended' },
      });
    }
  }

  return next();
};
