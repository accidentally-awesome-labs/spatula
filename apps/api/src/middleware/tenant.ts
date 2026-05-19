import type { MiddlewareHandler } from 'hono';
import { ValidationParamsError } from '@spatula/shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP_PATHS = new Set(['/health', '/api/docs', '/api/openapi.json']);

export const tenantMiddleware: MiddlewareHandler = async (c, next) => {
  if (SKIP_PATHS.has(c.req.path)) {
    return next();
  }

  const tenantId = c.req.header('x-tenant-id');
  if (!tenantId) {
    throw new ValidationParamsError('x-tenant-id header is required', {
      context: { header: 'x-tenant-id' },
    });
  }

  if (!UUID_REGEX.test(tenantId)) {
    throw new ValidationParamsError('x-tenant-id must be a valid UUID', {
      context: { header: 'x-tenant-id', value: tenantId },
    });
  }

  c.set('tenantId', tenantId);
  return next();
};
