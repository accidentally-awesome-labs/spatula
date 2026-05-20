/**
 * @spatula/core-types: errors/codes.ts
 *
 * Frozen v1 error-code enum. Category-prefixed `DOMAIN.CODE` shape per
 * design decisions D-05 / D-06 / D-07 / D-08 (see
 * .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md).
 *
 * v1 freeze rules:
 *   - Additive-only in 1.x — adding a new entry is OK; renaming, removing,
 *     or repurposing one is a breaking change requiring v2.
 *   - The enum is a `const` object (not TS `enum`) so it ships with zero
 *     runtime side-effects.
 *   - Every `code` value matches `^[A-Z_]+\.[A-Z_]+$` (`DOMAIN.CODE`).
 *
 * Canonical location: This module is the source of truth for the public
 * error-code surface (plan 16-2 moved it here from `@spatula/shared`).
 * `@spatula/shared` re-exports it for backward compatibility, and the
 * monorepo ESLint rule blocks value-imports from `@spatula/core-types`
 * directly — consumers go through `@spatula/shared` for runtime value
 * imports, or use `import type` for type-only.
 */

/**
 * Frozen v1 error-code enum.
 *
 * Convention: `DOMAIN.CODE` — `DOMAIN` is the resource/category, `CODE` is the
 * specific failure mode. Adding a new code in 1.x is non-breaking; renaming or
 * removing one is breaking and requires v2.
 */
export const ErrorCode = {
  // JOB.* — job lifecycle errors
  JOB_NOT_FOUND: 'JOB.NOT_FOUND',
  JOB_CONFLICT: 'JOB.CONFLICT',
  JOB_INVALID_STATE: 'JOB.INVALID_STATE',

  // EXTRACTION.* — extraction-pipeline errors
  EXTRACTION_QUOTA_EXCEEDED: 'EXTRACTION.QUOTA_EXCEEDED',
  EXTRACTION_FAILED: 'EXTRACTION.FAILED',

  // SCHEMA.* — schema-evolution errors
  SCHEMA_NOT_FOUND: 'SCHEMA.NOT_FOUND',
  SCHEMA_VERSION_CONFLICT: 'SCHEMA.VERSION_CONFLICT',

  // ENTITY.* — entity-store errors
  ENTITY_NOT_FOUND: 'ENTITY.NOT_FOUND',

  // EXPORT.* — export-pipeline errors
  EXPORT_NOT_FOUND: 'EXPORT.NOT_FOUND',
  EXPORT_FAILED: 'EXPORT.FAILED',

  // AUTH.* — authentication / authorization errors
  AUTH_INVALID_TOKEN: 'AUTH.INVALID_TOKEN',
  AUTH_MISSING_TOKEN: 'AUTH.MISSING_TOKEN',
  AUTH_INSUFFICIENT_SCOPE: 'AUTH.INSUFFICIENT_SCOPE',

  // RESOURCE.* — generic cross-resource lookup failures (additive 1.x — Phase 17)
  RESOURCE_NOT_FOUND: 'RESOURCE.NOT_FOUND',

  // TENANT.* — tenant errors
  TENANT_NOT_FOUND: 'TENANT.NOT_FOUND',

  // RATE_LIMIT.* / QUOTA.* — backpressure errors
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT.EXCEEDED',
  QUOTA_EXCEEDED: 'QUOTA.EXCEEDED',

  // VERSION.* — client/server version mismatch
  VERSION_MISMATCH: 'VERSION.MISMATCH',

  // VALIDATION.* — request validation errors (DOMAIN.CODE shape per D-05)
  VALIDATION_SCHEMA: 'VALIDATION.SCHEMA',
  VALIDATION_PARAMS: 'VALIDATION.PARAMS',

  // IDEMPOTENCY.* — idempotency key conflicts
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY.KEY_CONFLICT',

  // WEBHOOK.* — webhook signature / payload errors
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK.SIGNATURE_INVALID',

  // INTERNAL.* — infrastructure / server errors
  INTERNAL_ERROR: 'INTERNAL.ERROR',
  INTERNAL_TIMEOUT: 'INTERNAL.TIMEOUT',
  INTERNAL_QUEUE: 'INTERNAL.QUEUE',
  INTERNAL_NETWORK: 'INTERNAL.NETWORK',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * HTTP-status mapping for every `ErrorCode` value. Frozen at v1 alongside the
 * enum. The `error-handler.ts` middleware reads from this map; any new entry
 * added to `ErrorCode` MUST get a matching `STATUS_MAP` entry (enforced by
 * `codes.test.ts`).
 *
 * Status conventions:
 *   400 — VALIDATION.* (malformed request)
 *   401 — AUTH.MISSING_TOKEN, AUTH.INVALID_TOKEN, WEBHOOK.SIGNATURE_INVALID
 *   403 — AUTH.INSUFFICIENT_SCOPE
 *   404 — *.NOT_FOUND
 *   409 — *.CONFLICT, *.INVALID_STATE, IDEMPOTENCY.KEY_CONFLICT, SCHEMA.VERSION_CONFLICT
 *   422 — EXTRACTION.FAILED, EXPORT.FAILED (semantic processing failure)
 *   426 — VERSION.MISMATCH (Upgrade Required per RFC 7231 §6.5.15)
 *   429 — RATE_LIMIT.EXCEEDED, QUOTA.EXCEEDED, EXTRACTION.QUOTA_EXCEEDED
 *   500 — INTERNAL.ERROR
 *   502 — INTERNAL.NETWORK
 *   503 — INTERNAL.QUEUE
 *   504 — INTERNAL.TIMEOUT
 */
export const STATUS_MAP: Record<ErrorCode, number> = {
  [ErrorCode.JOB_NOT_FOUND]: 404,
  [ErrorCode.JOB_CONFLICT]: 409,
  [ErrorCode.JOB_INVALID_STATE]: 409,

  [ErrorCode.EXTRACTION_QUOTA_EXCEEDED]: 429,
  [ErrorCode.EXTRACTION_FAILED]: 422,

  [ErrorCode.SCHEMA_NOT_FOUND]: 404,
  [ErrorCode.SCHEMA_VERSION_CONFLICT]: 409,

  [ErrorCode.ENTITY_NOT_FOUND]: 404,

  [ErrorCode.EXPORT_NOT_FOUND]: 404,
  [ErrorCode.EXPORT_FAILED]: 422,

  [ErrorCode.AUTH_INVALID_TOKEN]: 401,
  [ErrorCode.AUTH_MISSING_TOKEN]: 401,
  [ErrorCode.AUTH_INSUFFICIENT_SCOPE]: 403,

  [ErrorCode.RESOURCE_NOT_FOUND]: 404,

  [ErrorCode.TENANT_NOT_FOUND]: 404,

  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCode.QUOTA_EXCEEDED]: 429,

  [ErrorCode.VERSION_MISMATCH]: 426,

  [ErrorCode.VALIDATION_SCHEMA]: 400,
  [ErrorCode.VALIDATION_PARAMS]: 400,

  [ErrorCode.IDEMPOTENCY_KEY_CONFLICT]: 409,

  [ErrorCode.WEBHOOK_SIGNATURE_INVALID]: 401,

  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.INTERNAL_TIMEOUT]: 504,
  [ErrorCode.INTERNAL_QUEUE]: 503,
  [ErrorCode.INTERNAL_NETWORK]: 502,
};
