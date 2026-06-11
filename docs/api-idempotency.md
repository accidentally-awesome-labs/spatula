# Idempotency keys

> Documented in Phase 16 plan 16-4; functionality already implemented in Wave 3-4. See `apps/api/src/middleware/idempotency.ts`.

## What it solves

Networks lose responses. Without idempotency keys, a retry of a successful `POST /api/v1/jobs` could create a duplicate job. With them, the server detects the replay and returns the SAME response the original request produced.

## Scope

| Method   | Idempotency-Key honored?                                                 |
| -------- | ------------------------------------------------------------------------ |
| `GET`    | n/a — inherently idempotent                                              |
| `HEAD`   | n/a — inherently idempotent                                              |
| `POST`   | yes                                                                      |
| `PATCH`  | yes                                                                      |
| `DELETE` | not honored at v1.0 (DELETE is inherently idempotent per HTTP semantics) |
| `PUT`    | not used in v1 surface                                                   |

## How it works

Send a request with `Idempotency-Key: <opaque-string>`. The server:

1. Records the (tenantId, key, request-hash) tuple in Redis with a 24-hour TTL.
2. On replay with the SAME key + body → returns the cached 2xx response.
3. On replay with the SAME key + DIFFERENT body → returns `409 IDEMPOTENCY.KEY_CONFLICT`.
4. After 24 hours → key is forgotten; the same key is now free to reuse for a fresh request.

Keys are scoped per-tenant. Cross-tenant key collisions are impossible.

## Worked examples

### 1. Same key + same body → cached response

```bash
curl -X POST https://api.spatula.dev/api/v1/jobs \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: 7f3a-1234-5678-90ab" \
  -H "Content-Type: application/json" \
  -d '{"name":"crawl-1","seedUrls":["https://example.com"]}'

# → 201 Created
# { "id": "job_abc...", "name": "crawl-1", "status": "pending", ... }

# Replay the EXACT same request (network hiccup, client retry, etc.):
curl -X POST https://api.spatula.dev/api/v1/jobs \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: 7f3a-1234-5678-90ab" \
  -H "Content-Type: application/json" \
  -d '{"name":"crawl-1","seedUrls":["https://example.com"]}'

# → 201 Created     (cached — NOT a new job)
# { "id": "job_abc...", ... }     # SAME id, byte-identical body
```

### 2. Same key + different body → 409 IDEMPOTENCY.KEY_CONFLICT

```bash
# Reuse the key from example 1 with a DIFFERENT payload:
curl -X POST https://api.spatula.dev/api/v1/jobs \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: 7f3a-1234-5678-90ab" \
  -H "Content-Type: application/json" \
  -d '{"name":"crawl-DIFFERENT","seedUrls":["https://other.example.com"]}'

# → 409 Conflict
# {
#   "error": {
#     "code": "IDEMPOTENCY.KEY_CONFLICT",
#     "message": "Idempotency key reused with different body",
#     "requestId": "...",
#     "details": { "idempotencyKey": "7f3a-1234-5678-90ab", "originalRequestId": "..." }
#   }
# }
```

The conflict response surfaces `originalRequestId` so you can correlate with the original successful request in your logs.

### 3. Different key → fresh request

```bash
# A genuinely new request — different key:
curl -X POST https://api.spatula.dev/api/v1/jobs \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: 9b8c-2222-3333-4444" \
  -H "Content-Type: application/json" \
  -d '{"name":"crawl-2","seedUrls":["https://example2.com"]}'

# → 201 Created
# { "id": "job_def...", ... }     # New job; different id
```

## SDK usage

The `@spatula/client` SDK accepts `idempotencyKey` as an option on every mutating method:

```typescript
import { SpatulaClient } from '@spatula/client';

const client = new SpatulaClient({
  baseUrl: 'https://api.spatula.dev',
  apiKey: process.env.SPATULA_API_KEY,
});

const job = await client.createJob(
  { name: 'crawl-1', seedUrls: ['https://example.com'] },
  { idempotencyKey: '7f3a-1234-5678-90ab' },
);
```

If you don't supply a key, the SDK does NOT generate one automatically — by design. The caller knows the operation's semantic identity better than the SDK does.

## TTL and storage

- Keys live 24 hours in Redis.
- Beyond TTL the same key may produce a fresh request.
- Tenants share the same Redis instance but are namespaced — `idempotency:{tenantId}:{key}`.

## Recommended key format

UUIDv4 is the standard recommendation. The server treats keys as opaque strings (max 255 bytes) — generating UUIDs gives you collision-free keys without coordination.

```typescript
import { randomUUID } from 'node:crypto';
const idempotencyKey = randomUUID();
```

## Failure modes

| Server behavior                | Client should…                                               |
| ------------------------------ | ------------------------------------------------------------ |
| Key length > 255 bytes         | `400 VALIDATION.PARAMS` — fix the key                        |
| Redis unavailable              | Request is processed normally (idempotency is best-effort)   |
| `409 IDEMPOTENCY.KEY_CONFLICT` | Stop retrying; the prior request and the current one diverge |
| `2xx` cached replay            | Treat as the original response — same id, same side effects  |

## Cross-references

- `docs/api-errors.md` — `IDEMPOTENCY.KEY_CONFLICT` definition.
- `docs/compat-policy.md` — server-side idempotency-key contract is frozen at v1.
- `apps/api/src/middleware/idempotency.ts` — implementation.
