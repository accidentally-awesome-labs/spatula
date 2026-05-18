import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import {
  schemaVersionResponseSchema,
  errorResponseSchema,
  dataResponse,
  listResponse,
  jsonContent,
} from '../schemas/responses.js';
import { NotFoundError } from '../middleware/error-handler.js';
import { ValidationError } from '@spatula/shared';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const getLatestRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Schemas'],
  summary: 'Get latest schema version for a job',
  request: { params: jobIdParam },
  responses: {
    200: jsonContent(dataResponse(schemaVersionResponseSchema), 'Latest schema'),
    404: jsonContent(errorResponseSchema, 'Schema not found'),
  },
});

const listVersionsRoute = createRoute({
  method: 'get',
  path: '/versions',
  tags: ['Schemas'],
  summary: 'List all schema versions',
  request: { params: jobIdParam },
  responses: { 200: jsonContent(listResponse(schemaVersionResponseSchema), 'All schema versions') },
});

const getVersionRoute = createRoute({
  method: 'get',
  path: '/versions/{version}',
  tags: ['Schemas'],
  summary: 'Get a specific schema version',
  request: {
    params: jobIdParam.extend({
      version: z.string().openapi({ param: { name: 'version', in: 'path' }, example: '1' }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(schemaVersionResponseSchema), 'Schema version'),
    404: jsonContent(errorResponseSchema, 'Version not found'),
  },
});

export function schemaRoutes() {
  const router = createOpenAPIRouter();

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(getLatestRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const schema = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schema) throw new NotFoundError('Schema', jobId);

    return c.json({ data: schema });
  });

  router.openapi(listVersionsRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const versions = await deps.schemaRepo.findAllVersions(jobId, tenantId);
    return c.json({ data: versions });
  });

  // @ts-expect-error — OpenAPI handler return type narrowing
  router.openapi(getVersionRoute, async (c) => {
    const { jobId, version: versionStr } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const version = parseInt(versionStr, 10);

    if (isNaN(version) || version < 1) {
      throw new ValidationError('Version must be a positive integer');
    }

    const schema = await deps.schemaRepo.findByVersion(jobId, tenantId, version);
    if (!schema) throw new NotFoundError('Schema version', String(version));

    return c.json({ data: schema });
  });

  return router;
}
