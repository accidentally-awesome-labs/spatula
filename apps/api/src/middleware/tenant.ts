import type { MiddlewareHandler } from 'hono';
import { ValidationError } from '@spatula/shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP_PATHS = new Set(['/health', '/api/docs', '/api/openapi.json']);

export const tenantMiddleware: MiddlewareHandler = async (c, next) => {
  if (SKIP_PATHS.has(c.req.path)) {
    return next();
  }

  const tenantId = c.req.header('x-tenant-id');
  if (!tenantId) {
    throw new ValidationError('x-tenant-id header is required');
  }

  if (!UUID_REGEX.test(tenantId)) {
    throw new ValidationError('x-tenant-id must be a valid UUID');
  }

  c.set('tenantId', tenantId);
  return next();
};
