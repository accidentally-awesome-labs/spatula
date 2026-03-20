import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { createTenantSchema, updateTenantSchema } from '../schemas/tenant.js';
import type { CreateTenantBody, UpdateTenantBody } from '../schemas/tenant.js';
import { validateBody } from '../middleware/validate.js';
import { NotFoundError } from '../middleware/error-handler.js';

export function tenantRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST / — Create tenant
  router.post('/', validateBody(createTenantSchema), async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) {
      throw new Error('Tenant management not configured');
    }

    const body = c.get('validatedBody') as CreateTenantBody;
    const tenant = await deps.tenantRepo.create(body);
    return c.json({ data: tenant }, 201);
  });

  // GET /:id — Get tenant
  router.get('/:id', async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) {
      throw new Error('Tenant management not configured');
    }

    const tenantId = c.req.param('id');
    const tenant = await deps.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new NotFoundError('Tenant', tenantId);
    }

    return c.json({ data: tenant });
  });

  // PATCH /:id — Update tenant
  router.patch('/:id', validateBody(updateTenantSchema), async (c) => {
    const deps = c.get('deps');
    if (!deps.tenantRepo) {
      throw new Error('Tenant management not configured');
    }

    const tenantId = c.req.param('id');
    const body = c.get('validatedBody') as UpdateTenantBody;
    const tenant = await deps.tenantRepo.update(tenantId, body);
    return c.json({ data: tenant });
  });

  return router;
}
