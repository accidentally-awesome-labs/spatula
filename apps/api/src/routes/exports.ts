import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import type { AppEnv } from '../types.js';
import { exportRequestSchema } from '../schemas/export-request.js';
import { exportResponseSchema, errorResponseSchema, dataResponse, jsonContent } from '../schemas/responses.js';
import { NotFoundError, ConflictError } from '../middleware/error-handler.js';
import { generateDocumentation, supportsPresignedUrls } from '@spatula/core';
import type { SchemaDefinition } from '@spatula/core';
import type { Entity } from '@spatula/shared';
import { paginationSchema } from '../schemas/pagination.js';
import { decodeCursor, encodeCursor } from '@spatula/shared';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const paginationEnvelopeSchema = z.object({
  total: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
});

const listExportsRoute = createRoute({
  method: 'get', path: '/exports', tags: ['Exports'],
  summary: 'List exports for a job',
  request: { params: jobIdParam, query: paginationSchema },
  responses: {
    200: jsonContent(
      z.object({ data: z.array(exportResponseSchema), pagination: paginationEnvelopeSchema }),
      'Exports with pagination',
    ),
  },
});

const triggerExportRoute = createRoute({
  method: 'post', path: '/export', tags: ['Exports'],
  summary: 'Trigger data export',
  request: {
    params: jobIdParam,
    body: { content: { 'application/json': { schema: exportRequestSchema } }, required: true },
  },
  responses: { 202: jsonContent(dataResponse(exportResponseSchema), 'Export queued') },
});

const getExportRoute = createRoute({
  method: 'get', path: '/export/{exportId}', tags: ['Exports'],
  summary: 'Check export status',
  request: {
    params: jobIdParam.extend({
      exportId: z.string().openapi({ param: { name: 'exportId', in: 'path' } }),
    }),
  },
  responses: {
    200: jsonContent(dataResponse(exportResponseSchema), 'Export status'),
    404: jsonContent(errorResponseSchema, 'Export not found'),
  },
});

const downloadExportRoute = createRoute({
  method: 'get', path: '/export/{exportId}/download', tags: ['Exports'],
  summary: 'Download export file',
  request: {
    params: jobIdParam.extend({
      exportId: z.string().openapi({ param: { name: 'exportId', in: 'path' } }),
    }),
  },
  responses: {
    200: { description: 'File download', content: { 'application/octet-stream': { schema: z.string() } } },
    302: { description: 'Redirect to presigned download URL' },
    404: jsonContent(errorResponseSchema, 'Export not found'),
    409: jsonContent(errorResponseSchema, 'Export not ready'),
  },
});

const getDocumentationRoute = createRoute({
  method: 'get', path: '/documentation', tags: ['Exports'],
  summary: 'Get data dictionary / documentation',
  request: { params: jobIdParam },
  responses: {
    200: jsonContent(z.object({ data: z.record(z.unknown()) }), 'Data documentation'),
    404: jsonContent(errorResponseSchema, 'Schema not found'),
  },
});

export function exportRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(listExportsRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const query = c.req.valid('query');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    if (query.cursor) {
      const { id: cursorId } = decodeCursor(query.cursor);
      const result = await deps.exportRepo.findByJobCursor(jobId, tenantId, query.limit, cursorId, query.since);
      const total = await deps.exportRepo.countByJob(jobId, tenantId);
      return c.json({
        data: result.entities,
        pagination: {
          total,
          limit: query.limit,
          hasMore: !!result.nextCursor,
          nextCursor: result.nextCursor ? encodeCursor({ id: result.nextCursor }) : undefined,
        },
      });
    }

    const exportList = await deps.exportRepo.findByJob(jobId, tenantId);
    const total = await deps.exportRepo.countByJob(jobId, tenantId);
    const offset = query.offset;
    const limit = query.limit;
    const paginated = exportList.slice(offset, offset + limit);

    return c.json({
      data: paginated,
      pagination: {
        total,
        limit,
        hasMore: offset + limit < total,
      },
    });
  });

  router.openapi(triggerExportRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const body = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const exportRecord = await deps.exportRepo.create({
      jobId, tenantId, format: body.format, includeProvenance: body.includeProvenance,
    });

    await deps.exportQueue.add('export', {
      exportId: exportRecord.id, jobId, tenantId,
      format: body.format, includeProvenance: body.includeProvenance,
    }, { removeOnComplete: true, removeOnFail: true });

    // Audit log
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'export.requested',
        resourceType: 'export',
        resourceId: exportRecord.id,
        metadata: { jobId, format: body.format },
      });
    }

    return c.json({ data: exportRecord }, 202);
  });

  router.openapi(getExportRoute, async (c) => {
    const { exportId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const exportRecord = await deps.exportRepo.findById(exportId, tenantId);
    if (!exportRecord) throw new NotFoundError('Export', exportId);

    return c.json({ data: exportRecord });
  });

  router.openapi(downloadExportRoute, async (c) => {
    const { exportId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const exportRecord = await deps.exportRepo.findById(exportId, tenantId);
    if (!exportRecord) throw new NotFoundError('Export', exportId);
    if (exportRecord.status !== 'completed' || !exportRecord.contentRef) {
      throw new ConflictError('Export is not yet completed');
    }

    // If content store supports presigned URLs, redirect instead of streaming
    if (supportsPresignedUrls(deps.contentStore)) {
      const url = await deps.contentStore.getDownloadUrl(exportRecord.contentRef, 3600);
      return c.redirect(url, 302);
    }

    const jobShort = exportRecord.jobId.slice(0, 8);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `spatula-${jobShort}-${date}.${exportRecord.format}`;

    const CONTENT_TYPES: Record<string, string> = {
      json: 'application/json',
      csv: 'text/csv',
      parquet: 'application/vnd.apache.parquet',
      duckdb: 'application/octet-stream',
      sqlite: 'application/vnd.sqlite3',
    };
    const contentType = CONTENT_TYPES[exportRecord.format] ?? 'application/octet-stream';

    const binaryFormats = new Set(['parquet', 'duckdb', 'sqlite']);
    const isBinary = binaryFormats.has(exportRecord.format);

    let body: string | Uint8Array;
    if (isBinary) {
      const data = await deps.contentStore.retrieveBinary(exportRecord.contentRef);
      if (!data) throw new NotFoundError('Export content', exportId);
      body = data;
    } else {
      body = await deps.contentStore.retrieve(exportRecord.contentRef);
    }

    // Audit log
    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: c.get('auth').userId,
        actorType: 'user',
        action: 'export.downloaded',
        resourceType: 'export',
        resourceId: exportId,
        metadata: { format: exportRecord.format },
      });
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        ...(exportRecord.fileSize ? { 'Content-Length': String(exportRecord.fileSize) } : {}),
      },
    });
  });

  router.openapi(getDocumentationRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

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
