import { z } from '@hono/zod-openapi';

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
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
    }),
  })
  .openapi('Error');

export function dataResponse<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

export function listResponse<T extends z.ZodType>(schema: T) {
  return z.object({ data: z.array(schema) });
}

export function jsonContent<T extends z.ZodType>(schema: T, description: string) {
  return {
    content: { 'application/json': { schema } },
    description,
  };
}
