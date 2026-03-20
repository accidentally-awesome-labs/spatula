import type { MiddlewareHandler } from 'hono';
import { NotFoundError } from './error-handler.js';

export const validateTenantMiddleware: MiddlewareHandler = async (c, next) => {
  const tenantId = c.get('tenantId');
  const deps = c.get('deps');

  if (deps.tenantRepo && tenantId) {
    const tenant = await deps.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new NotFoundError('Tenant', tenantId);
    }
  }

  return next();
};
