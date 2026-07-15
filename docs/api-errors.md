# Spatula API errors

> Frozen v1 error-code enum + envelope reference. The authoritative source is `packages/core-types/src/errors/codes.ts`; `@accidentally-awesome-labs/spatula-shared` re-exports it for backward compatibility.

## Envelope

Every 4xx/5xx response from `/api/v1/*` matches the v1 frozen shape:

```json
{
  "error": {
    "code": "DOMAIN.CODE",
    "message": "Human-readable message",
    "requestId": "uuid",
    "details": { "...": "context-specific payload (4xx only; scrubbed on 5xx)" }
  }
}
```

- `code` follows `DOMAIN.CODE` (`^[A-Z_]+\.[A-Z_]+$`). The enum is **FROZEN at v1**: additive-only across 1.x; renaming/removing/repurposing requires v2.
- `message` is human-readable English. SDK consumers SHOULD branch on `code`, NOT on `message` text.
- `requestId` echoes the per-request UUID assigned by `requestContextMiddleware` — paste this into a support ticket for fastest triage.
- `details` is a free-form `Record<string, unknown>` populated on 4xx with context (e.g., `{ jobId }`, `{ limit, resetAt }`). On 5xx, the field is scrubbed (omitted entirely) to avoid leaking internals.

## Enum reference

| Code                        | HTTP | Typical condition                                            | `details` shape                                |
| --------------------------- | ---- | ------------------------------------------------------------ | ---------------------------------------------- |
| `JOB.NOT_FOUND`             | 404  | Path-resolved job ID not in current tenant                   | `{ jobId }`                                    |
| `JOB.CONFLICT`              | 409  | State transition rejected (e.g., cancel a completed job)     | `{ jobId, currentStatus }`                     |
| `JOB.INVALID_STATE`         | 409  | Operation requires a different job state                     | `{ jobId, currentStatus, requiredStatus }`     |
| `EXTRACTION.QUOTA_EXCEEDED` | 429  | Tenant quota exceeded for extractions                        | `{ quota, used, resetAt }`                     |
| `EXTRACTION.FAILED`         | 422  | LLM extraction rejected or off-schema after retry            | `{ extractionId, reason }`                     |
| `SCHEMA.NOT_FOUND`          | 404  | Schema version not found for job                             | `{ schemaId }`                                 |
| `SCHEMA.VERSION_CONFLICT`   | 409  | Schema evolution conflict                                    | `{ jobId, existingVersion, attemptedVersion }` |
| `ENTITY.NOT_FOUND`          | 404  | Entity ID not in current tenant                              | `{ entityId }`                                 |
| `EXPORT.NOT_FOUND`          | 404  | Export ID not found                                          | `{ exportId }`                                 |
| `EXPORT.FAILED`             | 422  | Export job failed during materialization                     | `{ exportId, reason }`                         |
| `AUTH.INVALID_TOKEN`        | 401  | Provided Bearer token is invalid or expired                  | `{}`                                           |
| `AUTH.MISSING_TOKEN`        | 401  | Request lacks `Authorization` header                         | `{}`                                           |
| `AUTH.INSUFFICIENT_SCOPE`   | 403  | Token authenticated but lacks required scope                 | `{ required, granted[] }`                      |
| `TENANT.NOT_FOUND`          | 404  | Tenant ID resolved from token does not exist                 | `{ tenantId }`                                 |
| `RATE_LIMIT.EXCEEDED`       | 429  | Per-route rate limit hit                                     | `{ limit, resetAt }`                           |
| `QUOTA.EXCEEDED`            | 429  | Per-tenant quota hit                                         | `{ quota, used, resetAt }`                     |
| `VERSION.MISMATCH`          | 426  | SDK major ≠ server major (RFC 7231 §6.5.15 Upgrade Required) | `{ sdkMajor, serverMajor }`                    |
| `VALIDATION.SCHEMA`         | 400  | Request body fails zod schema validation                     | `{ issues[] }`                                 |
| `VALIDATION.PARAMS`         | 400  | Query/path/header params fail validation                     | `{ issues[] }`                                 |
| `IDEMPOTENCY.KEY_CONFLICT`  | 409  | Same `Idempotency-Key` reused with different body            | `{ idempotencyKey, originalRequestId }`        |
| `WEBHOOK.SIGNATURE_INVALID` | 401  | Webhook HMAC signature failed verification                   | `{}`                                           |
| `INTERNAL.ERROR`            | 500  | Generic server error                                         | `{}`                                           |
| `INTERNAL.TIMEOUT`          | 504  | Upstream operation timed out                                 | `{}`                                           |
| `INTERNAL.QUEUE`            | 503  | Background queue temporarily unavailable                     | `{}`                                           |
| `INTERNAL.NETWORK`          | 502  | Upstream service unreachable                                 | `{}`                                           |

**Total: 25 codes across 14 domains.**

## Admin-resource discriminator

Three admin-only resources (DLQ entries, API keys, Actions) have no dedicated v1 domain in the frozen enum. The server returns `JOB.NOT_FOUND` (the closest 404) with a `details.resource` discriminator so callers can branch without enum growth:

```json
{
  "error": {
    "code": "JOB.NOT_FOUND",
    "message": "Action not found",
    "requestId": "...",
    "details": { "resource": "action", "actionId": "..." }
  }
}
```

This is deliberate (rejected expanding the enum mid-sweep — additive-only would still cost three new codes for three rarely-used admin endpoints).

## SDK integration

The `@accidentally-awesome-labs/spatula-client` package ships **26 class-per-code typed error subclasses** (one per enum entry) generated from this enum. Consumers `instanceof` against `SpatulaApiError` (base) or a specific subclass (e.g., `JobNotFoundError`, `RateLimitExceededError`):

```typescript
import { SpatulaClient, RateLimitExceededError } from '@accidentally-awesome-labs/spatula-client';

try {
  await client.createJob({ name: 'crawl-1' });
} catch (err) {
  if (err instanceof RateLimitExceededError) {
    await sleep(err.context?.resetAt - Date.now());
  } else {
    throw err;
  }
}
```

Unknown codes fall back to the base `SpatulaApiError` (forward-compatible — clients can be older than the server within the same major).

## Cross-references

- `docs/compat-policy.md` — SDK ↔ server ↔ core-types compat matrix.
- `docs/api-idempotency.md` — `Idempotency-Key` worked examples.
- `docs/deprecation-policy.md` — experimental-tag + Deprecation/Sunset policy.
- `packages/core-types/src/errors/codes.ts` — canonical source.
- `apps/api/src/middleware/error-handler.ts` — server-side envelope construction.
