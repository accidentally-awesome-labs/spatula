import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { paginationSchema } from '../schemas/pagination.js';
import { validateQuery } from '../middleware/validate.js';
import { z } from 'zod';

const listExtractionsQuery = paginationSchema.extend({
  schemaVersion: z.coerce.number().int().min(1).optional(),
});

export function extractionRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', validateQuery(listExtractionsQuery), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;
    const query = c.get('validatedQuery') as z.infer<typeof listExtractionsQuery>;

    const extractions = await deps.extractionRepo.findByJob(jobId, tenantId, {
      schemaVersion: query.schemaVersion,
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ data: extractions });
  });

  return router;
}
