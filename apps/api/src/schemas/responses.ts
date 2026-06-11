import { z } from '@hono/zod-openapi';
// Plan 16-2: value-import ErrorCode via @spatula/shared (the back-compat shim).
// The monorepo ESLint rule blocks value-imports from @spatula/core-types
// directly; this consumer is allowed because it routes through the shim.
import { ErrorCode } from '@spatula/shared';
import { cursorEnvelopeSchema, offsetEnvelopeSchema } from './pagination.js';

// Closed-set enum surfaced into the OpenAPI document so SDK consumers see the
// frozen v1 ErrorCode list (DOMAIN.CODE form) in generated types. The zod
// schema stays `z.string()` — switching to `z.nativeEnum(ErrorCode)` would
// couple the runtime validator to the const-object enum, which is unnecessary
// (the server is the only producer; clients consume strings).
const ERROR_CODE_ENUM = Object.values(ErrorCode) as [string, ...string[]];

// --- Entity schemas (describe JSON shapes returned by endpoints) ---

export const jobResponseSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    config: z.record(z.unknown()),
    status: z.enum([
      'pending',
      'queued',
      'running',
      'paused',
      'reconciling',
      'completed',
      'failed',
      'cancelled',
    ]),
    schemaId: z.string().uuid().nullable(),
    stats: z.record(z.number()).nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .openapi('Job');

export const tenantResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    config: z.record(z.unknown()).nullable(),
    createdAt: z.string(),
  })
  .openapi('Tenant');

export const schemaVersionResponseSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    tenantId: z.string().uuid(),
    version: z.number().int(),
    definition: z.record(z.unknown()),
    parentId: z.string().uuid().nullable(),
    createdAt: z.string(),
  })
  .openapi('SchemaVersion');

export const extractionResponseSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    tenantId: z.string().uuid(),
    pageId: z.string().uuid().nullable(),
    pageUrl: z.string().nullable(),
    schemaVersion: z.number().int(),
    data: z.record(z.unknown()),
    unmappedFields: z.array(z.unknown()).nullable(),
    metadata: z.record(z.unknown()),
    createdAt: z.string(),
  })
  .openapi('Extraction');

// Full entity (returned by GET /:entityId)
export const entityResponseSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    tenantId: z.string().uuid(),
    mergedData: z.record(z.unknown()),
    provenance: z.record(z.unknown()),
    categories: z.array(z.string()),
    qualityScore: z.number(),
    createdAt: z.string(),
  })
  .openapi('Entity');

// List projection (returned by GET / — no provenance, has sourceCount)
export const entityListItemSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    tenantId: z.string().uuid(),
    mergedData: z.record(z.unknown()),
    categories: z.array(z.string()),
    qualityScore: z.number(),
    sourceCount: z.number().int(),
    createdAt: z.string(),
  })
  .openapi('EntityListItem');

export const actionResponseSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    tenantId: z.string().uuid(),
    type: z.string(),
    payload: z.record(z.unknown()),
    source: z.enum(['extraction', 'schema_evolution', 'reconciliation', 'quality_audit']),
    status: z.enum(['pending_review', 'approved', 'applied', 'rejected', 'rolled_back']),
    confidence: z.number(),
    reasoning: z.string(),
    stateChanges: z.record(z.unknown()).nullable(),
    reviewedBy: z.string().nullable(),
    createdAt: z.string(),
    appliedAt: z.string().nullable(),
  })
  .openapi('Action');

export const exportResponseSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    tenantId: z.string().uuid(),
    format: z.string(),
    status: z.string(),
    includeProvenance: z.boolean(),
    entityCount: z.number().nullable(),
    contentRef: z.string().nullable(),
    fileSize: z.number().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .openapi('Export');

// --- Common wrappers ---

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({
        description:
          'Frozen v1 error code in DOMAIN.CODE form (e.g., JOB.NOT_FOUND). Additive-only in 1.x.',
        example: 'JOB.NOT_FOUND',
        enum: ERROR_CODE_ENUM,
      }),
      message: z.string(),
      requestId: z.string(),
      details: z.record(z.unknown()).optional().openapi({
        description:
          'Optional free-form structured context (e.g., { field, issues } for validation; { limit, resetAt } for rate-limit). Shape is per-code; envelope itself is frozen at v1.',
      }),
    }),
  })
  .openapi('Error');

export function dataResponse<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

export function listResponse<T extends z.ZodType>(schema: T) {
  return z.object({ data: z.array(schema) });
}

/**
 * Phase 16 plan 16-1: canonical cursor-paginated response helper.
 * Shape `{ data, nextCursor?, hasMore }`. No `total` count.
 */
export function cursorListResponse<T extends z.ZodTypeAny>(itemSchema: T) {
  return cursorEnvelopeSchema(itemSchema);
}

/**
 * @deprecated Phase 16 plan 16-1: offset-paginated response helper.
 * Shape `{ data, total, page, limit, hasMore }`. Removal target v2.0; routes
 * that emit this MUST also call `applyDeprecationHeaders(c)`.
 */
export function offsetListResponse<T extends z.ZodTypeAny>(itemSchema: T) {
  return offsetEnvelopeSchema(itemSchema);
}

export function jsonContent<T extends z.ZodType>(schema: T, description: string) {
  return {
    content: { 'application/json': { schema } },
    description,
  };
}
