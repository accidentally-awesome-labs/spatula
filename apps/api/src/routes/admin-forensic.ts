/**
 * Forensic extractions admin route — Plan 18-05 Task 2 (SEC-05)
 *
 * GET /extractions (mounted at /api/v1/admin/forensic)
 * - Requires `admin:forensic:read` scope (or `admin` superset)
 * - Returns cursor-first { data: ForensicExtraction[], nextCursor, hasMore }
 * - Each item carries metadata + a signed URL contentRef (15-min TTL, 900s)
 * - NEVER returns inline HTML in any field
 * - Returns 503 when the content store does not support presigned URLs
 *
 * Data source: reads `suspicious_extraction` DLQ records for the tenant.
 * The forensicRef in each DLQ payload is exchanged for a signed URL.
 *
 * x-spatula-experimental: true — the forensic surface is the sole v1
 * experimental endpoint (see docs/deprecation-policy.md).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { supportsPresignedUrls } from '@spatula/core';
import { InternalQueueError } from '@spatula/shared';
import { requireScope } from '../middleware/require-scope.js';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';

const FORENSIC_QUEUE_NAME = 'suspicious_extraction';
/** Signed URL TTL: 15 minutes (900 seconds) per SEC-05 spec. */
const SIGNED_URL_TTL_SECONDS = 900;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/** Schema for a single forensic extraction item. */
const forensicExtractionSchema = z
  .object({
    /** DLQ record ID (the forensic record identifier). */
    id: z.string().uuid().openapi({ example: 'a1b2c3d4-0000-0000-0000-000000000001' }),
    /** The extraction ID that triggered the forensic archival. */
    extractionId: z.string().openapi({ example: 'e1e2e3e4-0000-0000-0000-000000000002' }),
    /** Tenant that owns the extraction. */
    tenantId: z.string().uuid().openapi({ example: 'f1f2f3f4-0000-0000-0000-000000000003' }),
    /** Why archival was triggered. */
    reason: z
      .string()
      .openapi({ example: 'suspicious_extraction', enum: ['suspicious_extraction', 'off_schema_retry'] }),
    /** ISO-8601 timestamp when the forensic record was created. */
    createdAt: z.string().openapi({ example: '2026-05-20T20:00:00.000Z' }),
    /**
     * Signed URL to the raw HTML blob in the content store (15-min TTL).
     * NEVER inline HTML — callers must fetch via this URL.
     */
    contentRef: z
      .string()
      .openapi({ example: 'https://storage.example.com/forensic/tenant-id/ext-id/ts.html?Expires=900' }),
  })
  .openapi('ForensicExtraction');

/** GET /api/v1/admin/forensic/extractions route definition */
const getForensicExtractionsRoute = createRoute({
  method: 'get',
  path: '/extractions',
  tags: ['Admin Forensic'],
  summary: 'List forensic extraction records (experimental)',
  description:
    'Returns forensic extraction metadata with 15-minute signed-URL contentRefs. ' +
    'Raw HTML is never returned inline — only via the signed URL. ' +
    'Requires admin:forensic:read or admin scope. ' +
    'This endpoint is experimental (x-spatula-experimental: true).',
  // x-spatula-experimental marks this as the sole v1 experimental surface per
  // docs/deprecation-policy.md (6-month max lifetime for any experimental surface).
  'x-spatula-experimental': true,
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT).optional(),
      cursor: z.string().optional().openapi({
        description: 'Opaque pagination cursor (base64url). Treat as opaque — do not parse.',
      }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({
        data: z.array(forensicExtractionSchema),
        nextCursor: z
          .string()
          .nullable()
          .openapi({ description: 'Opaque cursor for the next page. Null when hasMore is false.' }),
        hasMore: z.boolean(),
      }),
      'Paginated list of forensic extraction records',
    ),
    503: jsonContent(
      errorResponseSchema,
      'Content store does not support presigned URLs (local deployment)',
    ),
    403: jsonContent(errorResponseSchema, 'Insufficient scope'),
  },
});

export function adminForensicRoutes() {
  const app = createOpenAPIRouter();

  // Scope guard: requires admin:forensic:read (or admin superset via requireScope logic)
  app.use('/extractions', requireScope('admin:forensic:read'));

  // @ts-expect-error — OpenAPI handler return type narrowing
  app.openapi(getForensicExtractionsRoute, async (c) => {
    const deps = c.get('deps');

    // Guard: presigned URL support is required — LocalContentStore cannot generate them
    if (!supportsPresignedUrls(deps.contentStore)) {
      return c.json(
        {
          error: {
            code: 'INTERNAL.UNAVAILABLE',
            message:
              'forensic signed URLs require object storage — this deployment uses a local content store that does not support presigned URLs',
            requestId: c.get('requestId') ?? crypto.randomUUID(),
          },
        },
        503,
      );
    }

    if (!deps.dlqRepo) {
      throw new InternalQueueError('DLQ repo not configured');
    }

    const query = c.req.valid('query');
    const limit = Math.max(
      1,
      Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    );

    // Decode cursor (simple offset-based — cursor stores numeric offset)
    let offset = 0;
    if (query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, 'base64url').toString('utf-8');
        const parsed = JSON.parse(decoded) as { offset?: number };
        offset = typeof parsed.offset === 'number' ? parsed.offset : 0;
      } catch {
        // Ignore malformed cursors — start from offset 0
      }
    }

    // Fetch one extra record to determine hasMore
    const tenantId = c.get('tenantId');
    const records = await deps.dlqRepo.findUnresolved({
      queueName: FORENSIC_QUEUE_NAME,
      tenantId,
      limit: limit + 1,
      offset,
    });

    const hasMore = records.length > limit;
    const page = records.slice(0, limit);

    // Build signed URLs for each forensic blob — NEVER inline HTML
    const data = await Promise.all(
      page.map(async (record) => {
        const payload = record.payload as {
          extractionId?: string;
          forensicRef?: string;
          reason?: string;
          scanFlags?: unknown[];
        };

        const forensicRef = payload.forensicRef ?? '';
        let contentRef: string;
        try {
          contentRef = await deps.contentStore.getDownloadUrl!(forensicRef, SIGNED_URL_TTL_SECONDS);
        } catch {
          // URL generation failure is non-fatal for the list — return empty string
          contentRef = '';
        }

        return {
          id: record.id,
          extractionId: payload.extractionId ?? record.jobId,
          tenantId: record.tenantId ?? tenantId,
          reason: payload.reason ?? 'suspicious_extraction',
          createdAt: record.failedAt.toISOString(),
          // NEVER inline HTML — only the signed URL reaches the caller
          contentRef,
        };
      }),
    );

    // Encode next cursor
    const nextCursor: string | null = hasMore
      ? Buffer.from(JSON.stringify({ offset: offset + limit })).toString('base64url')
      : null;

    return c.json({ data, nextCursor, hasMore });
  });

  return app;
}
