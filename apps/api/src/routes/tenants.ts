import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { createTenantSchema, updateTenantSchema } from '../schemas/tenant.js';
import {
  tenantResponseSchema,
  errorResponseSchema,
  dataResponse,
  jsonContent,
} from '../schemas/responses.js';
import { NotFoundError } from '../middleware/error-handler.js';

const createTenantRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Tenants'],
  summary: 'Create a new tenant',
  request: {
    body: { content: { 'application/json': { schema: createTenantSchema } }, required: true },
  },
  responses: {
    201: jsonContent(dataResponse(tenantResponseSchema), 'Tenant created'),
    400: jsonContent(errorResponseSchema, 'Validation error'),
  },
});

const getTenantRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Tenants'],
  summary: 'Get tenant by ID',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(tenantResponseSchema), 'Tenant details'),
    404: jsonContent(errorResponseSchema, 'Tenant not found'),
  },
});

const updateTenantRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Tenants'],
  summary: 'Update tenant name or config',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: updateTenantSchema } }, required: true },
  },
  responses: {
    200: jsonContent(dataResponse(tenantResponseSchema), 'Updated tenant'),
    404: jsonContent(errorResponseSchema, 'Tenant not found'),
  },
});

export function tenantRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(createTenantRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) throw new Error('Tenant management not configured');

    const body = c.req.valid('json');
    const tenant = await deps.tenantRepo.create(body);
    return c.json({ data: tenant }, 201);
  });

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(getTenantRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) throw new Error('Tenant management not configured');

    const { id } = c.req.valid('param');
    const tenant = await deps.tenantRepo.findById(id);
    if (!tenant) throw new NotFoundError('Tenant', id);

    return c.json({ data: tenant });
  });

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(updateTenantRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) throw new Error('Tenant management not configured');

    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const tenant = await deps.tenantRepo.update(id, body);

    // Audit log (tenant routes skip auth, so auth context may be undefined)
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId: id,
        actorId: c.get('auth')?.userId ?? 'system',
        actorType: 'user',
        action: 'tenant.updated',
        resourceType: 'tenant',
        resourceId: id,
      });
    }

    return c.json({ data: tenant });
  });

  return router;
}
