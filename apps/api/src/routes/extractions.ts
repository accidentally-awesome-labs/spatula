import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { validateQuery } from '../middleware/validate.js';

const listExtractionsQuery = z.object({
  schemaVersion: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
    });

    return c.json({ data: extractions });
  });

  return router;
}
