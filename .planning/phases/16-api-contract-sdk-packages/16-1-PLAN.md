---
phase: 16-api-contract-sdk-packages
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/api/src/middleware/error-handler.ts
  - apps/api/src/middleware/rate-limit.ts
  - apps/api/src/middleware/rate-limit-config.ts
  - apps/api/src/middleware/rate-limit-config.test.ts
  - apps/api/src/middleware/rate-limit.test.ts
  - apps/api/src/openapi-config.ts
  - apps/api/src/schemas/responses.ts
  - apps/api/src/schemas/pagination.ts
  - apps/api/src/lib/deprecation-headers.ts
  - apps/api/src/lib/deprecation-headers.test.ts
  - apps/api/src/routes/jobs.ts
  - apps/api/src/routes/entities.ts
  - apps/api/src/routes/extractions.ts
  - apps/api/src/routes/actions.ts
  - apps/api/src/routes/exports.ts
  - apps/api/src/routes/admin-jobs.ts
  - apps/api/src/routes/admin-tenants.ts
  - apps/api/src/routes/admin-dlq.ts
  - apps/api/src/routes/admin-queues.ts
  - apps/api/src/routes/admin-system.ts
  - apps/api/src/routes/admin-workers.ts
  - apps/api/src/routes/api-keys.ts
  - apps/api/src/routes/auth.ts
  - apps/api/src/routes/entity-sources.ts
  - apps/api/src/routes/health.ts
  - apps/api/src/routes/batch-actions.ts
  - apps/api/src/routes/batch-jobs.ts
  - apps/api/src/routes/quality.ts
  - apps/api/src/routes/schemas.ts
  - apps/api/src/routes/tenants.ts
  - apps/api/src/routes/usage.ts
  - apps/api/src/routes/ws-token.ts
  - packages/shared/src/error-codes.ts
  - packages/shared/src/error-codes.test.ts
  - packages/shared/src/index.ts
  - packages/shared/src/errors.ts
  - config/rate-limits.yaml
  - scripts/derive-error-codes.ts
autonomous: true
requirements:
  - API-01
  - API-02
  - API-03
  - API-04

must_haves:
  truths:
    - "Every 4xx/5xx response from the API matches the envelope `{ error: { code, message, requestId, details? } }`"
    - "Every error `code` is a value from the new `DOMAIN.CODE` frozen enum (e.g., `JOB.NOT_FOUND`, `RATE_LIMIT.EXCEEDED`)"
    - "Every successful (non-429) auth'd response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers"
    - "429 responses additionally carry `Retry-After`"
    - "Per-route rate limits load from `config/rate-limits.yaml` with `SPATULA_RATE_LIMITS_PATH` overlay; boot-only reload"
    - "Cursor-paginated list responses use the canonical envelope `{ data, nextCursor, hasMore }`"
    - "Offset-paginated list responses include `Deprecation` + `Sunset` HTTP headers (RFC 8594) and `Link: rel=\"successor-version\"`"
  artifacts:
    - path: "packages/shared/src/error-codes.ts"
      provides: "Staged frozen `ErrorCode` enum + per-domain subclass map (`DOMAIN.CODE` convention); moves to `@spatula/core-types` in plan 16-2"
      contains: "export const ErrorCode"
    - path: "apps/api/src/middleware/error-handler.ts"
      provides: "Rewritten error handler emitting `{ code, message, requestId, details? }` keyed off `ErrorCode` enum"
      contains: "details"
    - path: "apps/api/src/middleware/rate-limit.ts"
      provides: "Per-route rate limit middleware emitting four headers including `X-RateLimit-Reset` (epoch seconds)"
      contains: "X-RateLimit-Reset"
    - path: "apps/api/src/middleware/rate-limit-config.ts"
      provides: "Boot-time YAML loader for `config/rate-limits.yaml` with `SPATULA_RATE_LIMITS_PATH` overlay"
      contains: "SPATULA_RATE_LIMITS_PATH"
    - path: "config/rate-limits.yaml"
      provides: "Per-route-group rate-limit configuration (default fallback + named route groups)"
      contains: "default:"
    - path: "apps/api/src/schemas/pagination.ts"
      provides: "Split `cursorEnvelopeSchema<T>` (canonical) + `offsetEnvelopeSchema<T>` (deprecated) zod helpers"
      contains: "cursorEnvelopeSchema"
    - path: "apps/api/src/lib/deprecation-headers.ts"
      provides: "`applyDeprecationHeaders()` helper writing `Deprecation`, `Sunset`, `Link` headers per RFC 8594"
      contains: "Sunset"
    - path: "scripts/derive-error-codes.ts"
      provides: "One-shot walker over `@hono/zod-openapi` registry that enumerates every (route, status) tuple as input to the clean-slate enum design"
      contains: "OpenAPIHono"
  key_links:
    - from: "apps/api/src/middleware/error-handler.ts"
      to: "packages/shared/src/error-codes.ts"
      via: "import { ErrorCode, STATUS_MAP } from '@spatula/shared'"
      pattern: "STATUS_MAP\\[error\\.code\\]"
    - from: "apps/api/src/openapi-config.ts"
      to: "packages/shared/src/error-codes.ts"
      via: "defaultHook returns `ErrorCode.VALIDATION_SCHEMA` (the new code, not the legacy 'VALIDATION_ERROR' string)"
      pattern: "VALIDATION\\.SCHEMA"
    - from: "apps/api/src/middleware/rate-limit.ts"
      to: "apps/api/src/middleware/rate-limit-config.ts"
      via: "lookup per `${method} ${routePath}` against loaded YAML config"
      pattern: "lookupRateLimit"
    - from: "apps/api/src/schemas/pagination.ts"
      to: "apps/api/src/lib/deprecation-headers.ts"
      via: "offset routes call applyDeprecationHeaders(c) inside handler"
      pattern: "applyDeprecationHeaders"
---

<objective>
Sweep the entire API surface to lock in the v1 error envelope (`{ error: { code, message, requestId, details? } }` with a fresh `DOMAIN.CODE` enum derived from the OpenAPI route registry), add the missing `X-RateLimit-Reset` header + per-route rate-limit configuration (`config/rate-limits.yaml`), and reshape the pagination envelope so cursor pagination is the canonical shape with offset routes carrying `Deprecation`/`Sunset` headers.

Purpose: Phase 16 is the freeze point for the v1 REST contract. Everything in this plan is **additive-only after this lands** — getting the enum, the envelope, the header set, and the pagination shape right NOW determines what the contract looks like for the entire v1 lifetime.

Output:
- New `packages/shared/src/error-codes.ts` (staging location; plan 16-2 moves it to `@spatula/core-types`)
- Sweep of every `c.json({error:...})` + `SpatulaError` throw site to the new envelope + enum
- New `config/rate-limits.yaml` + loader + `X-RateLimit-Reset` header
- Split `cursorEnvelopeSchema` / `offsetEnvelopeSchema` + `applyDeprecationHeaders` helper
- Tests covering enum coverage, rate-limit header set, config loader, deprecation headers
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md
@.planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md
@.planning/phases/16-api-contract-sdk-packages/16-VALIDATION.md
@docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md
@.planning/codebase/CONVENTIONS.md

<interfaces>
<!-- Key contracts the executor needs. Extracted from codebase. -->
<!-- Source code already loaded inline below for the files this plan modifies. -->

From `packages/shared/src/errors.ts` (current state):
```typescript
export class SpatulaError extends Error {
  readonly code: string;                          // Currently free-form string
  readonly context?: Record<string, unknown>;     // Repurposed below as the `details` payload
  readonly retryable: boolean;
  constructor(message: string, code: string, options?: SpatulaErrorOptions);
}
// Subclasses: ValidationError, CrawlError, ExtractionError, LLMError, ConfigError,
// StorageError, QueueError, TimeoutError, RateLimitError, NetworkError, StateError,
// AuthError, ForbiddenError. NotFoundError + ConflictError defined in error-handler.ts.
```

From `apps/api/src/middleware/error-handler.ts` (current state):
```typescript
function mapErrorToStatus(error: unknown): number {
  // switch on error.code: 'VALIDATION_ERROR'->400, 'AUTH_ERROR'->401, 'FORBIDDEN'->403,
  // 'NOT_FOUND'->404, 'CONFLICT'->409, 'QUEUE_ERROR'->503, 'TIMEOUT_ERROR'->504,
  // 'RATE_LIMIT_ERROR'->429, 'QUOTA_EXCEEDED'->429, 'NETWORK_ERROR'->502, 'STATE_ERROR'->409
}
export const errorHandler: ErrorHandler = (error, c) => {
  // Returns: { error: { code, message, requestId } } — MISSING `details` field
}
```

From `apps/api/src/openapi-config.ts` (current state):
```typescript
export function createOpenAPIRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      // CURRENTLY returns code: 'VALIDATION_ERROR' on zod validation failure
      // MUST be updated to emit code: 'VALIDATION.SCHEMA' from new enum
    },
  });
}
```

From `apps/api/src/middleware/rate-limit.ts` (current state):
```typescript
// Sets X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After (on 429)
// MISSING: X-RateLimit-Reset (epoch seconds = Math.floor((now + WINDOW_MS) / 1000))
// MISSING: per-route lookup from config/rate-limits.yaml; currently uses DEFAULT_RATE_LIMIT for all routes
// On 429: returns code: 'RATE_LIMIT_ERROR' — must become 'RATE_LIMIT.EXCEEDED'
```

From `apps/api/src/schemas/pagination.ts` (current state):
```typescript
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).default(50).transform(v => Math.min(v, 500)),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.string().optional(),
  since: z.string().datetime().optional(),
});
export const paginationEnvelopeSchema = z.object({
  total: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),    // MIXED offset + cursor — split in this plan
});
```

From `packages/shared/src/cursor.ts` (REUSE; do not modify):
```typescript
export function encodeCursor(payload: CursorPayload): string;
export function decodeCursor(token: string): CursorPayload;
// Already handles base64url + UUID validation + composite payloads (Wave 3-3b)
```

From `packages/shared/src/index.ts` (current):
```typescript
export { DEFAULT_RATE_LIMIT } from './...';   // Phase 15 collapsed tier presets to this
```
</interfaces>

</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Derive frozen ErrorCode enum from OpenAPI route registry + write error-codes.ts staging module</name>
  <files>
    scripts/derive-error-codes.ts,
    packages/shared/src/error-codes.ts,
    packages/shared/src/error-codes.test.ts,
    packages/shared/src/index.ts,
    packages/shared/src/errors.ts
  </files>
  <read_first>
    - apps/api/src/middleware/error-handler.ts (every legacy code in mapErrorToStatus; this is the source of "what codes are currently observable from outside")
    - apps/api/src/openapi-config.ts (defaultHook validation error code path)
    - apps/api/src/routes/*.ts (sample 5 routes to confirm the throw-site pattern — `throw new NotFoundError(...)`, `throw new ValidationError(...)`)
    - packages/shared/src/errors.ts (existing SpatulaError + subclasses; this plan ADDS to it; legacy classes stay so internal callers don't break mid-sweep)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § "Error-Code Enum Design" (D-05, D-06, D-07, D-08)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Common Pitfalls" Pitfall 2 (defaultHook must emit new enum)
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.3.3 (error envelope shape)
  </read_first>
  <behavior>
    - `scripts/derive-error-codes.ts` boots a synthetic OpenAPIHono app (or imports `apps/api/src/app.ts` factory), calls `getOpenAPI31Document()`, walks the resulting `paths[*][*].responses` tree, prints a deduped list of every 4xx/5xx status code observed per route.
    - Output of the script is captured in a top-of-file comment in `packages/shared/src/error-codes.ts` for review traceability (NOT generated; human-curated from the script output).
    - `ErrorCode` is exported as a `const`-style enum object (NOT TS `enum` keyword — D-09 forbids runtime side effects later when this moves to `@spatula/core-types`). Shape: `export const ErrorCode = { JOB_NOT_FOUND: 'JOB.NOT_FOUND', ... } as const; export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];`
    - `STATUS_MAP: Record<ErrorCode, number>` maps every code to HTTP status. Default 500 when key missing.
    - Test `error-codes.test.ts` asserts: (a) every code starts with `[A-Z]+\.[A-Z_]+` pattern (`DOMAIN.CODE` shape), (b) `STATUS_MAP` has an entry for every `ErrorCode` value (no orphans), (c) every status value is in {400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504}.
    - `packages/shared/src/errors.ts` ADDS new typed subclasses (`JobNotFoundError`, `JobConflictError`, `ExtractionQuotaExceededError`, `AuthInvalidTokenError`, `RateLimitExceededError`, `VersionMismatchError`, `ValidationSchemaError`, `IdempotencyKeyConflictError`, `WebhookSignatureInvalidError`, `InternalError`) that pass the new ErrorCode value to `super(message, ErrorCode.X, {context: details})`. The legacy `ValidationError`, `NotFoundError`, etc. stay (no breakage during sweep) but get a `@deprecated` JSDoc pointing at the new subclass.
    - `packages/shared/src/index.ts` re-exports `ErrorCode`, `STATUS_MAP`, and every new typed subclass.
  </behavior>
  <action>
    Step 1: Write `scripts/derive-error-codes.ts`:
    ```typescript
    // scripts/derive-error-codes.ts
    // One-shot walker. Run via: pnpm tsx scripts/derive-error-codes.ts > /tmp/error-codes-survey.txt
    import { createApp } from '../apps/api/src/app.js';   // or copy openapi-config + sample route imports
    const app = createApp(/* minimal deps stub */);
    const doc = (app as any).getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'survey', version: '0' }, servers: [] });
    const tuples: Array<{ path: string; method: string; status: string }> = [];
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(methods as any)) {
        for (const status of Object.keys((op as any).responses ?? {})) {
          if (status.startsWith('4') || status.startsWith('5')) tuples.push({ path, method, status });
        }
      }
    }
    console.log(JSON.stringify(tuples, null, 2));
    ```

    Step 2: Run script, capture output into a `/* TUPLES SURVEYED ON 2026-MM-DD: ... */` header comment in the new file.

    Step 3: Write `packages/shared/src/error-codes.ts`. Frozen enum design (D-05 — category-prefixed, additive-only in 1.x). Include at minimum these categories from the audit + research:
    ```typescript
    export const ErrorCode = {
      // JOB.*
      JOB_NOT_FOUND: 'JOB.NOT_FOUND',
      JOB_CONFLICT: 'JOB.CONFLICT',
      JOB_INVALID_STATE: 'JOB.INVALID_STATE',
      // EXTRACTION.*
      EXTRACTION_QUOTA_EXCEEDED: 'EXTRACTION.QUOTA_EXCEEDED',
      EXTRACTION_FAILED: 'EXTRACTION.FAILED',
      // SCHEMA.*
      SCHEMA_NOT_FOUND: 'SCHEMA.NOT_FOUND',
      SCHEMA_VERSION_CONFLICT: 'SCHEMA.VERSION_CONFLICT',
      // RECONCILIATION.* / ENTITY.* / EXPORT.* (per derive script output)
      ENTITY_NOT_FOUND: 'ENTITY.NOT_FOUND',
      EXPORT_NOT_FOUND: 'EXPORT.NOT_FOUND',
      EXPORT_FAILED: 'EXPORT.FAILED',
      // AUTH.*
      AUTH_INVALID_TOKEN: 'AUTH.INVALID_TOKEN',
      AUTH_MISSING_TOKEN: 'AUTH.MISSING_TOKEN',
      AUTH_INSUFFICIENT_SCOPE: 'AUTH.INSUFFICIENT_SCOPE',
      // TENANT.*
      TENANT_NOT_FOUND: 'TENANT.NOT_FOUND',
      // RATE_LIMIT.* / QUOTA.*
      RATE_LIMIT_EXCEEDED: 'RATE_LIMIT.EXCEEDED',
      QUOTA_EXCEEDED: 'QUOTA.EXCEEDED',
      // VERSION.*
      VERSION_MISMATCH: 'VERSION.MISMATCH',
      // VALIDATION.*
      VALIDATION_SCHEMA: 'VALIDATION.SCHEMA',
      VALIDATION_PARAMS: 'VALIDATION.PARAMS',
      // IDEMPOTENCY.*
      IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY.KEY_CONFLICT',
      // WEBHOOK.*
      WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK.SIGNATURE_INVALID',
      // INTERNAL.*
      INTERNAL_ERROR: 'INTERNAL.ERROR',
      INTERNAL_TIMEOUT: 'INTERNAL.TIMEOUT',
      INTERNAL_QUEUE: 'INTERNAL.QUEUE',
      INTERNAL_NETWORK: 'INTERNAL.NETWORK',
    } as const;
    export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

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
      [ErrorCode.TENANT_NOT_FOUND]: 404,
      [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
      [ErrorCode.QUOTA_EXCEEDED]: 429,
      [ErrorCode.VERSION_MISMATCH]: 426,    // Upgrade Required
      [ErrorCode.VALIDATION_SCHEMA]: 400,
      [ErrorCode.VALIDATION_PARAMS]: 400,
      [ErrorCode.IDEMPOTENCY_KEY_CONFLICT]: 409,
      [ErrorCode.WEBHOOK_SIGNATURE_INVALID]: 401,
      [ErrorCode.INTERNAL_ERROR]: 500,
      [ErrorCode.INTERNAL_TIMEOUT]: 504,
      [ErrorCode.INTERNAL_QUEUE]: 503,
      [ErrorCode.INTERNAL_NETWORK]: 502,
    };
    ```
    Note: VERSION.MISMATCH → 426 follows RFC 7231 for protocol version negotiation; final code curation reviewed against derive script output.

    Step 4: Append new subclasses to `packages/shared/src/errors.ts`:
    ```typescript
    import { ErrorCode } from './error-codes.js';
    export class JobNotFoundError extends SpatulaError {
      constructor(jobId: string, options?: SpatulaErrorOptions) {
        super(`Job ${jobId} not found`, ErrorCode.JOB_NOT_FOUND, { ...options, context: { jobId, ...options?.context } });
        this.name = 'JobNotFoundError';
      }
    }
    // ... one class per new ErrorCode value (10+ classes total)
    // Add @deprecated JSDoc on legacy NotFoundError/ValidationError/etc:
    /** @deprecated Use the domain-specific subclass (JobNotFoundError, EntityNotFoundError, etc.) — flat NotFoundError will be removed in v2. */
    ```

    Step 5: Export from `packages/shared/src/index.ts`:
    ```typescript
    export { ErrorCode, STATUS_MAP } from './error-codes.js';
    export type { ErrorCode as ErrorCodeT } from './error-codes.js';
    export { JobNotFoundError, JobConflictError, /* ... all new subclasses ... */ } from './errors.js';
    ```

    Step 6: Write `packages/shared/src/error-codes.test.ts` asserting the three behaviors above. Run `pnpm --filter @spatula/shared test -- error-codes` and confirm green.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/shared test -- error-codes && grep -E "^  [A-Z_]+: '[A-Z_]+\\.[A-Z_]+'," packages/shared/src/error-codes.ts | wc -l | awk '$1 >= 20 { exit 0 } { exit 1 }' && pnpm --filter @spatula/shared build</automated>
  </verify>
  <acceptance_criteria>
    - `packages/shared/src/error-codes.ts` exists and exports `ErrorCode` (const object) AND `STATUS_MAP`
    - `grep -c "DOMAIN.CODE" packages/shared/src/error-codes.ts` finds at least one occurrence (in a comment or doc)
    - Every value in the `ErrorCode` object matches the regex `^[A-Z_]+\.[A-Z_]+$` — verified by the unit test
    - `STATUS_MAP` has the same number of keys as `ErrorCode` (no orphans) — verified by the unit test
    - `scripts/derive-error-codes.ts` exists and runs without throwing (`pnpm tsx scripts/derive-error-codes.ts | head -1` returns a JSON-shaped line)
    - `packages/shared/src/errors.ts` contains at least 10 new subclasses (`grep -c "extends SpatulaError" packages/shared/src/errors.ts` ≥ 25 counting legacy + new)
    - `packages/shared/src/index.ts` re-exports `ErrorCode` AND `STATUS_MAP` AND at least one new subclass (e.g., `JobNotFoundError`)
    - Implements per D-05 (DOMAIN.CODE), D-06 (clean-slate from OpenAPI), D-08 (free-form details).
    - 16-2 plan will MOVE this enum to `@spatula/core-types`; this plan stages it in `@spatula/shared`.
  </acceptance_criteria>
  <done>
    Frozen ErrorCode enum + STATUS_MAP + 10+ subclasses exist in `@spatula/shared`; unit test enforces shape; derive script is committed for future regeneration; legacy subclasses marked `@deprecated`.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Rewrite error-handler + defaultHook + every route throw site to emit the new envelope and ErrorCode</name>
  <files>
    apps/api/src/middleware/error-handler.ts,
    apps/api/src/middleware/error-handler.test.ts,
    apps/api/src/openapi-config.ts,
    apps/api/src/schemas/responses.ts,
    apps/api/src/routes/jobs.ts,
    apps/api/src/routes/entities.ts,
    apps/api/src/routes/extractions.ts,
    apps/api/src/routes/actions.ts,
    apps/api/src/routes/exports.ts,
    apps/api/src/routes/admin-jobs.ts,
    apps/api/src/routes/admin-tenants.ts,
    apps/api/src/routes/admin-dlq.ts,
    apps/api/src/routes/admin-queues.ts,
    apps/api/src/routes/admin-system.ts,
    apps/api/src/routes/admin-workers.ts,
    apps/api/src/routes/api-keys.ts,
    apps/api/src/routes/auth.ts,
    apps/api/src/routes/entity-sources.ts,
    apps/api/src/routes/health.ts,
    apps/api/src/routes/batch-actions.ts,
    apps/api/src/routes/batch-jobs.ts,
    apps/api/src/routes/quality.ts,
    apps/api/src/routes/schemas.ts,
    apps/api/src/routes/tenants.ts,
    apps/api/src/routes/usage.ts,
    apps/api/src/routes/ws-token.ts
  </files>
  <read_first>
    - apps/api/src/middleware/error-handler.ts (the file being rewritten — must understand current mapErrorToStatus + envelope code path)
    - apps/api/src/openapi-config.ts (the defaultHook IS a throw site for validation errors — must update per Pitfall #2 in 16-RESEARCH)
    - apps/api/src/schemas/responses.ts (errorResponseSchema is the OpenAPI declaration; needs `details?` field)
    - Every route file in `<files>` (each has at least one `c.json({error:...})` literal OR a `throw new NotFoundError(...)` — count them; this is the full sweep)
    - packages/shared/src/error-codes.ts (Task 1 output; provides ErrorCode and STATUS_MAP imports)
    - packages/shared/src/errors.ts (Task 1 added new subclasses; replace legacy class instantiations with new subclasses where the domain is obvious)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § "Error-Code Enum Design" (D-08 details shape)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Common Pitfalls" Pitfall #2 (defaultHook sweep)
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.3.3 (envelope)
  </read_first>
  <behavior>
    - `errorResponseSchema` in `apps/api/src/schemas/responses.ts` gains `details: z.record(z.unknown()).optional()` and `code` becomes `z.string()` (free-form to keep zod inference simple; runtime values come from the enum).
    - `error-handler.ts` `mapErrorToStatus` switches from the legacy code list to `STATUS_MAP[error.code as ErrorCode] ?? 500`.
    - `error-handler.ts` passes `error.context` (from `SpatulaError`) through as the `details` field IF non-empty. Returns the new envelope `{ error: { code, message, requestId, details? } }`.
    - `error-handler.test.ts` (NEW) asserts: (a) `JobNotFoundError('abc')` → status 404 + envelope code === 'JOB.NOT_FOUND' + details.jobId === 'abc'; (b) generic `Error('boom')` → status 500 + envelope code === 'INTERNAL.ERROR' + no details field; (c) `ValidationSchemaError` with context `{field:'foo',issues:[]}` → status 400 + details exposed.
    - `openapi-config.ts` `defaultHook` returns `code: ErrorCode.VALIDATION_SCHEMA` (the string `'VALIDATION.SCHEMA'`) instead of legacy `'VALIDATION_ERROR'`. The handler embeds the zod issues in `details.issues`.
    - Every route file: replace ALL inline `c.json({error:{code:'X',...}}, status)` literals AND `throw new NotFoundError(...)` / `throw new ValidationError(...)` calls with the appropriate new subclass (e.g., `throw new JobNotFoundError(jobId)`). Use the script-generated cheat sheet from Task 1 to map each domain.
    - Where a route currently emits a code that has no obvious new domain (e.g., a one-off `c.json({error:{code:'INVALID_INPUT',...}})`), use `ErrorCode.VALIDATION_SCHEMA` or `ErrorCode.VALIDATION_PARAMS` as appropriate.
    - No route file should retain a legacy code string after this task — `grep -rE "code: ['\"]([A-Z_]+)['\"]" apps/api/src/routes/ | grep -v "\\." | wc -l` should return 0.
  </behavior>
  <action>
    Step 1: Update `apps/api/src/schemas/responses.ts`:
    ```typescript
    export const errorResponseSchema = z.object({
      error: z.object({
        code: z.string().openapi({ description: 'DOMAIN.CODE — frozen at v1, additive-only in 1.x', example: 'JOB.NOT_FOUND' }),
        message: z.string(),
        requestId: z.string(),
        details: z.record(z.unknown()).optional(),
      }),
    }).openapi('Error');
    ```

    Step 2: Rewrite `apps/api/src/middleware/error-handler.ts`:
    ```typescript
    import type { ErrorHandler } from 'hono';
    import { SpatulaError, ErrorCode, STATUS_MAP, createLogger, captureException } from '@spatula/shared';
    const logger = createLogger('api:error-handler');
    function mapErrorToStatus(error: unknown): number {
      if (error instanceof SpatulaError) {
        return STATUS_MAP[error.code as keyof typeof STATUS_MAP] ?? 500;
      }
      return 500;
    }
    export const errorHandler: ErrorHandler = (error, c) => {
      const status = mapErrorToStatus(error);
      const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? crypto.randomUUID();
      const code = error instanceof SpatulaError ? error.code : ErrorCode.INTERNAL_ERROR;
      const message = status >= 500 ? 'Internal server error' : (error as Error).message;
      const details = (error instanceof SpatulaError && error.context && Object.keys(error.context).length > 0)
        ? error.context : undefined;
      if (status >= 500) {
        logger.error({ err: error, requestId, path: c.req.path }, 'unhandled error');
        captureException(error, { requestId, path: c.req.path });
      } else {
        logger.warn({ code, requestId, path: c.req.path }, (error as Error).message);
      }
      return c.json(
        { error: { code, message, requestId, ...(details ? { details } : {}) } },
        status as any,
      );
    };
    // KEEP existing NotFoundError + ConflictError as @deprecated re-exports pointing at JobNotFoundError + JobConflictError;
    // many routes still import them — delete in v2.
    ```

    Step 3: Update `apps/api/src/openapi-config.ts` `defaultHook`:
    ```typescript
    import { ErrorCode } from '@spatula/shared';
    // ... defaultHook return:
    return c.json({
      error: {
        code: ErrorCode.VALIDATION_SCHEMA,    // was 'VALIDATION_ERROR'
        message: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', '),
        requestId,
        details: { issues: result.error.issues },
      },
    }, 400);
    ```

    Step 4: Sweep all 23 route files in `<files>`. For each:
    - `grep -nE "code:\\s*['\"][A-Z_]+['\"]" {file}` to find inline literals; replace with new code string.
    - `grep -n "throw new (NotFound|Validation|Conflict|Auth|Forbidden|Quota|Storage|State|Network|Queue|Timeout|RateLimit|LLM|Crawl|Extraction|Config)Error" {file}` to find legacy throws; replace with new domain-specific subclass.
    - Where ambiguity exists (e.g., route catches a generic error and re-throws), wrap as `new InternalError(message, { context })`.

    Step 5: Write `apps/api/src/middleware/error-handler.test.ts`. Use Hono's app harness; assert envelope shape for the three cases in <behavior>.

    Step 6: Run `pnpm --filter @spatula/api test -- error-handler` and full `pnpm --filter @spatula/api typecheck` to catch missed import updates.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/api test -- error-handler && pnpm --filter @spatula/api typecheck && grep -rE "code:\\s*['\"][A-Z_]+['\"]" apps/api/src/routes/ apps/api/src/middleware/ apps/api/src/openapi-config.ts | grep -v "DOMAIN.CODE" | grep -v "\\." | (! grep -q "code: '")</automated>
  </verify>
  <acceptance_criteria>
    - `apps/api/src/middleware/error-handler.ts` imports `ErrorCode` and `STATUS_MAP` from `@spatula/shared`
    - `apps/api/src/middleware/error-handler.ts` contains the string `details` in the response object construction
    - `apps/api/src/openapi-config.ts` references `ErrorCode.VALIDATION_SCHEMA` (NOT the legacy literal `'VALIDATION_ERROR'`) — `grep -q "VALIDATION_SCHEMA\|VALIDATION\\.SCHEMA" apps/api/src/openapi-config.ts`
    - `apps/api/src/openapi-config.ts` does NOT contain `code: 'VALIDATION_ERROR'` — `! grep -q "'VALIDATION_ERROR'" apps/api/src/openapi-config.ts`
    - `apps/api/src/schemas/responses.ts` errorResponseSchema contains a `details` field — `grep -A 10 "errorResponseSchema" apps/api/src/schemas/responses.ts | grep -q "details"`
    - **Drift gate (D-07 belt+suspenders):** `grep -rhoE "code:\\s*['\"][A-Z_]+['\"]" apps/api/src/routes/ apps/api/src/middleware/ apps/api/src/openapi-config.ts | grep -v "\\." | wc -l` returns 0 (no flat legacy codes survive in the OSS surface)
    - `pnpm --filter @spatula/api test -- error-handler` passes (3+ test cases per <behavior>)
    - `pnpm --filter @spatula/api typecheck` is green
    - Implements per D-05, D-06, D-07, D-08; addresses Pitfall #2 (defaultHook sweep).
  </acceptance_criteria>
  <done>
    Every 4xx/5xx response in the OSS API now emits the canonical envelope `{ error: { code, message, requestId, details? } }` with codes from the new ErrorCode enum. defaultHook is included in the sweep. Test asserts the three behavior cases.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Add X-RateLimit-Reset header + config/rate-limits.yaml loader + per-route lookup</name>
  <files>
    apps/api/src/middleware/rate-limit.ts,
    apps/api/src/middleware/rate-limit.test.ts,
    apps/api/src/middleware/rate-limit-config.ts,
    apps/api/src/middleware/rate-limit-config.test.ts,
    config/rate-limits.yaml
  </files>
  <read_first>
    - apps/api/src/middleware/rate-limit.ts (current file — already emits 3 of 4 headers; this task adds X-RateLimit-Reset + per-route lookup)
    - packages/shared/src/index.ts (DEFAULT_RATE_LIMIT export — fallback when no route matches)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § "Claude's Discretion" rate-limits.yaml shape recommendation
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Code Examples" `config/rate-limits.yaml` shape + § "Architecture Patterns" rate-limit integration
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.3.4 (rate-limit headers)
    - Task 1 output: ErrorCode.RATE_LIMIT_EXCEEDED (the new 429 code that replaces legacy 'RATE_LIMIT_ERROR')
  </read_first>
  <behavior>
    - `rate-limit-config.ts` reads YAML from `process.env.SPATULA_RATE_LIMITS_PATH ?? './config/rate-limits.yaml'` at module load (boot-only — no hot reload for v1 per CONTEXT.md). Parses with `yaml@2.8.3` (already in deps).
    - Shape: `{ default: { requestsPerMinute, maxConcurrentJobs }, routeGroups: Record<"METHOD /api/v1/path/pattern", { requestsPerMinute, maxConcurrentJobs? }> }`. Validated against a zod schema; throws on malformed YAML (fail-loud at boot).
    - `lookupRateLimit(method: string, routePath: string): RateLimitConfig` does exact-match then `default` fallback. NO glob/wildcard matching in v1 (CONTEXT.md: "per-route-group with method overrides" — exact `METHOD /api/v1/...` keys).
    - `rate-limit.ts` middleware: compute `resetEpochSeconds = Math.floor((now + WINDOW_MS) / 1000)`. Set `c.header('X-RateLimit-Reset', resetEpochSeconds.toString())` BEFORE checking the rate-limit verdict.
    - On 429: emit envelope with `code: ErrorCode.RATE_LIMIT_EXCEEDED` (string value `'RATE_LIMIT.EXCEEDED'`), include `details: { limit, resetAt: resetEpochSeconds }`.
    - Per-route lookup: `const cfg = lookupRateLimit(c.req.method, c.req.routePath ?? c.req.path); const limit = cfg.requestsPerMinute;` — `routePath` is the matched Hono route template (e.g., `/api/v1/jobs/:id`), NOT the request URL.
    - Tests:
      - `rate-limit-config.test.ts`: loads a fixture YAML, asserts lookup hits exact match for known route, falls back to default for unknown. Asserts `SPATULA_RATE_LIMITS_PATH` overlay (write temp file, set env var, reload, assert different value).
      - `rate-limit.test.ts`: assert response headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` ALL present on success; `Retry-After` present on 429; 429 envelope code === `RATE_LIMIT.EXCEEDED`.
    - `config/rate-limits.yaml` ships with: `default.requestsPerMinute: 300` (matches `DEFAULT_RATE_LIMIT`), plus route groups for `GET /api/v1/health` (6000), `POST /api/v1/jobs` (30), `GET /api/v1/entities` (600), `POST /api/v1/admin/*` (60 — note: in v1 exact-match only, so each admin POST listed individually).
  </behavior>
  <action>
    Step 1: Create `config/rate-limits.yaml`:
    ```yaml
    # config/rate-limits.yaml — per-route rate-limit configuration (loaded once at boot)
    # Override via SPATULA_RATE_LIMITS_PATH env var (file merge: env file fully replaces this file)
    # Frozen-at-v1: shape (default + routeGroups) cannot change in 1.x; values can be overridden.

    default:
      requestsPerMinute: 300
      maxConcurrentJobs: 10

    routeGroups:
      "GET /api/v1/health":
        requestsPerMinute: 6000
      "POST /api/v1/jobs":
        requestsPerMinute: 30
        maxConcurrentJobs: 5
      "GET /api/v1/entities":
        requestsPerMinute: 600
      "POST /api/v1/admin/tenants":
        requestsPerMinute: 60
      "DELETE /api/v1/admin/tenants/{id}":
        requestsPerMinute: 30
      # ... add remaining sensitive admin paths per derive-error-codes survey
    ```

    Step 2: Write `apps/api/src/middleware/rate-limit-config.ts`:
    ```typescript
    import { readFileSync } from 'node:fs';
    import { resolve } from 'node:path';
    import { parse } from 'yaml';
    import { z } from 'zod';

    const rateLimitEntry = z.object({
      requestsPerMinute: z.number().int().positive(),
      maxConcurrentJobs: z.number().int().positive().optional(),
    });
    const rateLimitsFileSchema = z.object({
      default: rateLimitEntry,
      routeGroups: z.record(z.string(), rateLimitEntry).default({}),
    });

    export type RateLimitConfig = z.infer<typeof rateLimitEntry>;
    type RateLimitsFile = z.infer<typeof rateLimitsFileSchema>;

    let cache: RateLimitsFile | null = null;

    export function loadRateLimitsConfig(): RateLimitsFile {
      if (cache) return cache;
      const path = resolve(process.env.SPATULA_RATE_LIMITS_PATH ?? './config/rate-limits.yaml');
      const raw = readFileSync(path, 'utf-8');
      const parsed = parse(raw);
      cache = rateLimitsFileSchema.parse(parsed);
      return cache;
    }

    export function lookupRateLimit(method: string, routePath: string): RateLimitConfig {
      const cfg = loadRateLimitsConfig();
      const key = `${method.toUpperCase()} ${routePath}`;
      return cfg.routeGroups[key] ?? cfg.default;
    }

    /** Test-only — clears the loader cache so a fresh file path can be picked up. */
    export function _resetRateLimitsCacheForTests(): void { cache = null; }
    ```

    Step 3: Modify `apps/api/src/middleware/rate-limit.ts`:
    ```typescript
    import type { MiddlewareHandler } from 'hono';
    import type Redis from 'ioredis';
    import { ErrorCode } from '@spatula/shared';
    import { lookupRateLimit } from './rate-limit-config.js';

    const WINDOW_MS = 60_000;
    const RATE_LIMIT_SCRIPT = `...`; // unchanged

    export function rateLimitMiddleware(redis: Redis): MiddlewareHandler {
      return async (c, next) => {
        const tenantId = c.get('tenantId') as string | undefined;
        if (!tenantId) return next();
        const cfg = lookupRateLimit(c.req.method, c.req.routePath ?? c.req.path);
        if (cfg.requestsPerMinute === Infinity) return next();
        const now = Date.now();
        const resetEpochSeconds = Math.floor((now + WINDOW_MS) / 1000);
        // ... existing redis.eval logic ...
        c.header('X-RateLimit-Limit', cfg.requestsPerMinute.toString());
        c.header('X-RateLimit-Remaining', Math.max(0, cfg.requestsPerMinute - count).toString());
        c.header('X-RateLimit-Reset', resetEpochSeconds.toString());

        if (!accepted) {
          c.header('Retry-After', '60');
          return c.json({
            error: {
              code: ErrorCode.RATE_LIMIT_EXCEEDED,
              message: 'Rate limit exceeded',
              requestId: c.get('requestId') ?? '',
              details: { limit: cfg.requestsPerMinute, resetAt: resetEpochSeconds },
            },
          }, 429);
        }
        await next();
      };
    }
    ```

    Step 4: Write `apps/api/src/middleware/rate-limit-config.test.ts` and `apps/api/src/middleware/rate-limit.test.ts`. Use `mkdtempSync` + write a fixture YAML to exercise the env-var overlay. Use vitest `beforeEach` to call `_resetRateLimitsCacheForTests()`.

    Step 5: Run `pnpm --filter @spatula/api test -- rate-limit` and confirm green.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/api test -- rate-limit && grep -q "X-RateLimit-Reset" apps/api/src/middleware/rate-limit.ts && grep -q "SPATULA_RATE_LIMITS_PATH" apps/api/src/middleware/rate-limit-config.ts && test -f config/rate-limits.yaml && grep -q "^default:" config/rate-limits.yaml</automated>
  </verify>
  <acceptance_criteria>
    - `apps/api/src/middleware/rate-limit.ts` calls `c.header('X-RateLimit-Reset', ...)` — `grep -q "X-RateLimit-Reset" apps/api/src/middleware/rate-limit.ts` succeeds
    - `apps/api/src/middleware/rate-limit-config.ts` reads `process.env.SPATULA_RATE_LIMITS_PATH` — `grep -q "SPATULA_RATE_LIMITS_PATH" apps/api/src/middleware/rate-limit-config.ts` succeeds
    - `config/rate-limits.yaml` exists with `default:` + `routeGroups:` top-level keys
    - Rate-limit 429 emits `code: 'RATE_LIMIT.EXCEEDED'` (NOT legacy `'RATE_LIMIT_ERROR'`) — `grep -q "RATE_LIMIT_EXCEEDED\|RATE_LIMIT\\.EXCEEDED" apps/api/src/middleware/rate-limit.ts`
    - YAML loader caches result (subsequent calls don't re-read disk) — unit test asserts via spy
    - Env-var overlay works — unit test writes a temp file, sets `SPATULA_RATE_LIMITS_PATH`, calls `_resetRateLimitsCacheForTests()`, asserts new value picked up
    - All four headers present on success: unit test checks `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` exist; on 429, additionally `Retry-After`
    - Implements API-02 (4 headers) + API-03 (config file + env overlay).
  </acceptance_criteria>
  <done>
    Rate-limit middleware emits all 4 headers per spec §3.3.4; `config/rate-limits.yaml` is the per-route configuration source; `SPATULA_RATE_LIMITS_PATH` overlay works; 429 envelope uses the new ErrorCode.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Split pagination envelope into cursor (canonical) + offset (deprecated) + Deprecation/Sunset headers helper</name>
  <files>
    apps/api/src/schemas/pagination.ts,
    apps/api/src/schemas/responses.ts,
    apps/api/src/lib/deprecation-headers.ts,
    apps/api/src/lib/deprecation-headers.test.ts,
    apps/api/src/routes/entities.ts,
    apps/api/src/routes/extractions.ts,
    apps/api/src/routes/entity-sources.ts,
    apps/api/src/routes/jobs.ts,
    apps/api/src/routes/exports.ts,
    apps/api/src/routes/actions.ts
  </files>
  <read_first>
    - apps/api/src/schemas/pagination.ts (current `paginationEnvelopeSchema` mixes offset+cursor; this task splits it)
    - apps/api/src/schemas/responses.ts (current `listResponse<T>` helper; this task adds `cursorListResponse<T>` + `offsetListResponse<T>`)
    - packages/shared/src/cursor.ts (existing `encodeCursor` / `decodeCursor`; REUSE — do not modify)
    - 6 route files listed in <files> (each has a list endpoint; each needs the new envelope applied OR Deprecation header added)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § "Claude's Discretion" cursor format reuse + Deprecation/Sunset header format
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Anti-Patterns to Avoid" (mixing offset and cursor in same envelope)
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.3.5 (pagination: cursor canonical, offset deprecated, Sunset target v2.0)
    - RFC 8594 (HTTP Sunset header — `Sunset: <HTTP-date>`)
  </read_first>
  <behavior>
    - `paginationEnvelopeSchema` renamed to `legacyPaginationEnvelopeSchema` with `@deprecated` JSDoc; kept ONLY for backward-compat type unioning during the sweep — DO NOT use in new code.
    - New `cursorEnvelopeSchema<T>(itemSchema: T)` returns `z.object({ data: z.array(itemSchema), nextCursor: z.string().optional(), hasMore: z.boolean() })`.
    - New `offsetEnvelopeSchema<T>(itemSchema: T)` returns `z.object({ data: z.array(itemSchema), total: z.number(), page: z.number(), limit: z.number(), hasMore: z.boolean() })`. Marked `@deprecated`; OpenAPI description string includes "deprecated; will be removed in v2.0; use cursor pagination".
    - New `cursorListResponse<T>(itemSchema)` and `offsetListResponse<T>(itemSchema)` helpers in `responses.ts` (companions to existing `dataResponse<T>` / `listResponse<T>`).
    - New `apps/api/src/lib/deprecation-headers.ts`:
      ```typescript
      import type { Context } from 'hono';
      // Sunset target: 2027-05-01 (~12 months post-v1.0). When v2 is planned, update.
      const SUNSET_DATE = new Date('2027-05-01T00:00:00.000Z');
      const SUNSET_HTTP_DATE = SUNSET_DATE.toUTCString();
      const DEPRECATION_TODAY_HTTP = (new Date()).toUTCString();
      export function applyDeprecationHeaders(c: Context, opts?: { successorLink?: string }): void {
        c.header('Deprecation', DEPRECATION_TODAY_HTTP);    // RFC 8594 — actually deprecated "today" (i.e., at v1.0 launch)
        c.header('Sunset', SUNSET_HTTP_DATE);
        const link = opts?.successorLink ?? '</docs/compat-policy>; rel="successor-version"';
        c.header('Link', link);
      }
      ```
      Note: For v1.0, hardcoding `DEPRECATION_TODAY_HTTP` at module-load yields a build-time-frozen value. Acceptable for v1; revisit if rebuild cadence increases.
    - Tests:
      - `deprecation-headers.test.ts`: assert all three headers set on response; assert custom `successorLink` overrides default.
      - For the 6 modified routes: each currently exposes BOTH offset (`?offset=` or `?page=`) AND cursor (`?cursor=`) in the same handler via `paginationSchema`. Split so:
        - If request has `?cursor=` (and no offset): use `cursorEnvelopeSchema` shape. No Deprecation headers.
        - If request has `?offset=` or `?page=` (and no cursor): use `offsetEnvelopeSchema` shape. CALL `applyDeprecationHeaders(c)`.
        - If both: prefer cursor (legacy behavior).
      - OpenAPI registrations for these 6 routes must declare TWO response variants (one per shape) with the deprecation marker on the offset variant. Use `z.union([cursorEnvelopeSchema(...), offsetEnvelopeSchema(...)])` in the response schema OR rely on the existing `oneOf` union behavior of `@hono/zod-openapi`.
  </behavior>
  <action>
    Step 1: Rewrite `apps/api/src/schemas/pagination.ts`:
    ```typescript
    import { z } from '@hono/zod-openapi';

    export const paginationSchema = z.object({
      limit: z.coerce.number().int().min(1).default(50).transform(v => Math.min(v, 500)),
      offset: z.coerce.number().int().min(0).default(0).openapi({ deprecated: true, description: 'DEPRECATED: use cursor pagination. Removal target v2.0.' }),
      page: z.coerce.number().int().min(1).optional().openapi({ deprecated: true, description: 'DEPRECATED: use cursor pagination. Removal target v2.0.' }),
      cursor: z.string().optional().openapi({ description: 'Opaque cursor for keyset pagination. CANONICAL.' }),
      since: z.string().datetime().optional(),
    });
    export type PaginationParams = z.infer<typeof paginationSchema>;

    /** Canonical cursor-based envelope (v1 frozen). */
    export function cursorEnvelopeSchema<T extends z.ZodTypeAny>(itemSchema: T) {
      return z.object({
        data: z.array(itemSchema),
        nextCursor: z.string().optional().openapi({ description: 'Opaque cursor for the next page. Treat as opaque — do not parse.' }),
        hasMore: z.boolean(),
      });
    }

    /** @deprecated Offset-based envelope. Removal target v2.0. */
    export function offsetEnvelopeSchema<T extends z.ZodTypeAny>(itemSchema: T) {
      return z.object({
        data: z.array(itemSchema),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
        hasMore: z.boolean(),
      }).openapi({ deprecated: true });
    }

    /** @deprecated Legacy mixed envelope — DO NOT use in new code. Use cursorEnvelopeSchema or offsetEnvelopeSchema. */
    export const paginationEnvelopeSchema = z.object({
      total: z.number(),
      limit: z.number(),
      hasMore: z.boolean(),
      nextCursor: z.string().optional(),
    });
    ```

    Step 2: Add `cursorListResponse` + `offsetListResponse` helpers to `apps/api/src/schemas/responses.ts`:
    ```typescript
    import { cursorEnvelopeSchema, offsetEnvelopeSchema } from './pagination.js';
    export function cursorListResponse<T extends z.ZodTypeAny>(itemSchema: T) {
      return cursorEnvelopeSchema(itemSchema);
    }
    export function offsetListResponse<T extends z.ZodTypeAny>(itemSchema: T) {
      return offsetEnvelopeSchema(itemSchema);
    }
    ```

    Step 3: Write `apps/api/src/lib/deprecation-headers.ts` per <behavior>.

    Step 4: Write `apps/api/src/lib/deprecation-headers.test.ts`.

    Step 5: For each of the 6 routes in <files>:
    - Read the list handler.
    - Identify whether request uses `?cursor=` (route in cursor mode) or `?offset=` / `?page=` (deprecated mode).
    - Update response body construction to match the new envelope shape (drop `total` in cursor mode; keep in offset mode).
    - When offset mode: `applyDeprecationHeaders(c)` BEFORE `return c.json(...)`.
    - Update the route's OpenAPI `responses` declaration to reference `cursorListResponse(itemSchema)` or `offsetListResponse(itemSchema)` as appropriate. If a route supports BOTH (handler branches on params), use `z.union([cursorEnvelopeSchema(itemSchema), offsetEnvelopeSchema(itemSchema)])`.

    Step 6: Run `pnpm --filter @spatula/api test` to catch regressions; review any failing list-endpoint tests and update fixtures to match the new envelope shape.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/api test -- pagination deprecation-headers && grep -q "cursorEnvelopeSchema" apps/api/src/schemas/pagination.ts && grep -q "applyDeprecationHeaders" apps/api/src/lib/deprecation-headers.ts && grep -q "Sunset" apps/api/src/lib/deprecation-headers.ts && pnpm --filter @spatula/api typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `apps/api/src/schemas/pagination.ts` exports `cursorEnvelopeSchema` AND `offsetEnvelopeSchema` (both as factory functions accepting an item schema)
    - `cursorEnvelopeSchema` returns an object with `{ data, nextCursor?, hasMore }` — `grep -A 5 "cursorEnvelopeSchema" apps/api/src/schemas/pagination.ts | grep -E "data.*nextCursor"` succeeds
    - `offsetEnvelopeSchema` returns `{ data, total, page, limit, hasMore }` — visible in source via `grep`
    - `apps/api/src/lib/deprecation-headers.ts` exists and exports `applyDeprecationHeaders` — `grep -q "applyDeprecationHeaders" apps/api/src/lib/deprecation-headers.ts`
    - The helper sets THREE headers: `Deprecation`, `Sunset`, `Link` (RFC 8594 conformant) — `grep -c "c.header" apps/api/src/lib/deprecation-headers.ts` ≥ 3
    - `Sunset` value is an HTTP-date (e.g., `Mon, 01 May 2027 00:00:00 GMT`) — verified by unit test parsing the header value
    - `applyDeprecationHeaders` test asserts custom `successorLink` overrides default
    - At least 4 of the 6 list-endpoint routes (entities, extractions, jobs, exports) call `applyDeprecationHeaders` in their offset-mode branch — `grep -l "applyDeprecationHeaders" apps/api/src/routes/{entities,extractions,jobs,exports}.ts | wc -l` ≥ 4
    - No `paginationEnvelopeSchema` (legacy mixed shape) usage remains in route handlers' RESPONSE bodies — `grep -l "paginationEnvelopeSchema" apps/api/src/routes/ | wc -l` returns 0 (the schema export still exists for backward compat but no handler uses it)
    - `pnpm --filter @spatula/api typecheck` is green
    - Implements API-04 + addresses Anti-pattern "Mixing offset and cursor in same envelope".
  </acceptance_criteria>
  <done>
    Pagination envelope is split: `cursorEnvelopeSchema` is canonical, `offsetEnvelopeSchema` is `@deprecated`; offset routes emit `Deprecation` + `Sunset` + `Link` headers (RFC 8594); cursor codec from `@spatula/shared/cursor` is reused unchanged.
  </done>
</task>

</tasks>

<verification>
1. Run `pnpm --filter @spatula/shared test && pnpm --filter @spatula/api test && pnpm --filter @spatula/api typecheck` — must be green.
2. Grep gate: `grep -rhE "code:\\s*['\"][A-Z_]+['\"]" apps/api/src/routes/ apps/api/src/middleware/ apps/api/src/openapi-config.ts | grep -v "\\." | wc -l` returns 0 (no legacy flat codes survive).
3. Manual smoke: `curl -i http://localhost:3000/api/v1/jobs/nonexistent` (with auth) — response shape MUST be `{"error":{"code":"JOB.NOT_FOUND","message":"...","requestId":"..."}}` (status 404).
4. Manual smoke: same `curl` — response headers MUST contain `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
5. Manual smoke: `curl -i "http://localhost:3000/api/v1/entities?offset=0&limit=10"` — response headers MUST contain `Deprecation`, `Sunset`, `Link`. `curl -i "http://localhost:3000/api/v1/entities?cursor=eyJpZCI6Im..."` — those three headers MUST be absent.
6. `tests/private-contract/oss-surface.test.ts` must remain GREEN — symbol additions to `@spatula/shared` are additive; symbol removals (none in this plan) would trip it.
</verification>

<success_criteria>
- API-01: Every 4xx/5xx response from the OSS API matches `{ error: { code, message, requestId, details? } }` AND `code` is a value from the new `ErrorCode` const-object. Verified by unit tests + grep gate.
- API-02: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` set on every authed success; `Retry-After` set on 429. Verified by `rate-limit.test.ts`.
- API-03: `config/rate-limits.yaml` exists and is the source of per-route limits; `SPATULA_RATE_LIMITS_PATH` overlay works; boot-only reload. Verified by `rate-limit-config.test.ts`.
- API-04: Cursor envelope is `{ data, nextCursor, hasMore }` (no `total`); offset envelope is deprecated AND emits `Deprecation`+`Sunset`+`Link` headers. Verified by `deprecation-headers.test.ts` + route grep.
- Frozen enum + STATUS_MAP staged in `@spatula/shared/error-codes.ts` ready for plan 16-2 to move into `@spatula/core-types`.
- `tests/private-contract/oss-surface.test.ts` remains green (no removed symbols).
</success_criteria>

<output>
After completion, create `.planning/phases/16-api-contract-sdk-packages/16-1-SUMMARY.md` recording:
- Final ErrorCode enum size (count of codes); decisions excluded codes and why
- Which routes emit `Deprecation` headers (final list); which are pure-cursor
- Any throw sites that resisted clean mapping to a new subclass + the choice made
- Whether any legacy error subclass became unused (candidate for removal in v2)
- Grep gate evidence (output of the legacy-code grep, expected 0)
- Note: ErrorCode enum stages in `@spatula/shared` for plan 16-2 to MOVE to `@spatula/core-types`
</output>
