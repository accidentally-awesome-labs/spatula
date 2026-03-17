import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { exportRequestSchema } from '../schemas/export-request.js';
import { validateBody } from '../middleware/validate.js';
import { NotFoundError, ConflictError } from '../middleware/error-handler.js';
import { generateDocumentation } from '@spatula/core';
import type { SchemaDefinition } from '@spatula/core';
import type { Entity } from '@spatula/shared';

export function exportRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST /export — trigger export
  router.post('/export', validateBody(exportRequestSchema), async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;
    const body = c.get('validatedBody') as { format: 'json' | 'csv'; includeProvenance: boolean };

    const exportRecord = await deps.exportRepo.create({
      jobId, tenantId, format: body.format, includeProvenance: body.includeProvenance,
    });

    await deps.exportQueue.add('export', {
      exportId: exportRecord.id, jobId, tenantId,
      format: body.format, includeProvenance: body.includeProvenance,
    }, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });

    return c.json({ data: exportRecord }, 202);
  });

  // GET /export/:exportId — check status
  router.get('/export/:exportId', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const exportId = c.req.param('exportId');

    const exportRecord = await deps.exportRepo.findById(exportId, tenantId);
    if (!exportRecord) throw new NotFoundError('Export', exportId);

    return c.json({ data: exportRecord });
  });

  // GET /export/:exportId/download — download file
  router.get('/export/:exportId/download', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const exportId = c.req.param('exportId');

    const exportRecord = await deps.exportRepo.findById(exportId, tenantId);
    if (!exportRecord) throw new NotFoundError('Export', exportId);
    if (exportRecord.status !== 'completed' || !exportRecord.contentRef) {
      throw new ConflictError('Export is not yet completed');
    }

    const content = await deps.contentStore.retrieve(exportRecord.contentRef);
    const contentType = exportRecord.format === 'csv' ? 'text/csv' : 'application/json';
    const jobShort = exportRecord.jobId.slice(0, 8);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `spatula-${jobShort}-${date}.${exportRecord.format}`;

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        ...(exportRecord.fileSize ? { 'Content-Length': String(exportRecord.fileSize) } : {}),
      },
    });
  });

  // GET /documentation — data dictionary
  router.get('/documentation', async (c) => {
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');
    const jobId = c.req.param('jobId') as string;

    const schemaRow = await deps.schemaRepo.findLatest(jobId, tenantId);
    if (!schemaRow) throw new NotFoundError('Schema', jobId);
    const schema = schemaRow.definition as SchemaDefinition;

    const [entities, totalCount] = await Promise.all([
      deps.entityRepo.findByJob(jobId, tenantId, { limit: 1000 }),
      deps.entityRepo.countByJob(jobId, tenantId),
    ]);

    const documentation = generateDocumentation(schema, entities as unknown as Entity[], jobId);

    return c.json({ data: { ...documentation, entityCount: totalCount } });
  });

  return router;
}
