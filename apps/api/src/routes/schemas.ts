import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { NotFoundError } from '../middleware/error-handler.js';
import { ValidationError } from '@spatula/shared';

export function schemaRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET / — Get current (latest) schema
  router.get('/', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;

    const schema = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schema) {
      throw new NotFoundError('Schema', jobId);
    }

    return c.json({ data: schema });
  });

  // GET /versions — List all schema versions
  router.get('/versions', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;

    const versions = await deps.schemaRepo.findAllVersions(jobId, tenantId);
    return c.json({ data: versions });
  });

  // GET /versions/:version — Get specific schema version
  router.get('/versions/:version', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;
    const version = parseInt(c.req.param('version'), 10);

    if (isNaN(version) || version < 1) {
      throw new ValidationError('Version must be a positive integer');
    }

    const schema = await deps.schemaRepo.findByVersion(jobId, tenantId, version);
    if (!schema) {
      throw new NotFoundError('Schema version', String(version));
    }

    return c.json({ data: schema });
  });

  return router;
}
