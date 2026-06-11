# Phase 17: Browser Auth, SSE, CORS — Research

**Researched:** 2026-05-20
**Domain:** Server-Sent Events, Redis Streams, Hono CORS/streaming, Dex OIDC, API key rotation, cross-tenant isolation testing
**Confidence:** HIGH (code directly inspected; library types read from installed versions; official Redis docs verified)

---

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Event Buffer & Replay (AUTH-01)**

- D-01: Buffer = Redis Streams (`jobs:{jobId}:events`), `XADD MAXLEN ~ 500 * payload=<json>`, `EXPIRE 300` per-key on first add. Replay via `XRANGE jobs:{jobId}:events {LastEventId}+1 +`. Live tail via `XREAD BLOCK <keepalive_ms> STREAMS ... $`.
- D-02: Dual-publish. `packages/queue/src/events.ts::RedisEventPublisher.publish` writes to both existing pub/sub channel AND new stream (`XADD jobs:{id}:events`). WS path unchanged; SSE consumes stream only.
- D-03: SSE `id:` field = Redis stream id verbatim (`{ms}-{seq}`). Client `Last-Event-ID` passed straight into `XRANGE` as exclusive lower bound.
- D-04: Per-job retention budget: `MAXLEN ~ 500` (approx-trim) + `EXPIRE 300` on stream key, refreshed on every `XADD`. Events older than 5 min OR position 501+ are gone; synthetic `replay_truncated` event emitted when `Last-Event-ID` predates oldest available entry.
- D-05: 15 s keep-alive via SSE comment line (`:\n\n`) — keep-alive timer separate from event loop; survives `XREAD BLOCK` returning empty.

**Stream Token Reuse (AUTH-02)**

- D-06: Single shared token endpoint, dual-purpose token. Existing `POST /api/v1/ws-token` is canonical issuer. Token stored at `ws-token:{token}` (Redis) with 60 s TTL, value `{ tenantId, createdAt }`. Both WS upgrade and new SSE handler call `GETDEL` to consume it.
- D-07: OpenAPI doc update on `POST /api/v1/ws-token`: rename `summary` to "Create a single-use stream token (WebSocket or SSE)". Existing operationId preserved.

**CORS Wildcard (AUTH-03)**

- D-08: `origin` becomes a function in `apps/api/src/app.ts` cors config. Parse `CORS_ALLOWED_ORIGINS` once at boot. Wildcard entries compile to `/^https:\/\/[^./]+\.foo\.com$/` — exactly one subdomain label. Returns matching origin or `null`.
- D-09: Preflight cache stays at 86400 s. `expose-headers` extended to include `X-RateLimit-Reset` + `Retry-After`.
- D-10: Format documentation ships in `docs/api-auth.md` (new CORS section). Boot fails fast with `CORS_CONFIG_INVALID` on misconfiguration.

**Dex Local Recipe (AUTH-04, AUTH-08)**

- D-11: `examples/auth-dex/` ships as self-contained kit: `docker-compose.yml`, `config/dex.yaml`, `README.md`, `smoke/browser-flow.ts`, `smoke/m2m-flow.ts`.
- D-12: Dex storage = SQLite in the example (mounted volume).
- D-13: Static-client credentials committed to repo as `dev-only-secret-xxx` with `# DO NOT USE IN PRODUCTION` banner.

**API Key Rotation (AUTH-05)**

- D-14: Two-key grace window. `POST /api/v1/api-keys/:id/rotate` returns new raw key AND marks old key with `expiresAt = now + graceSeconds` (default 86400 s, max 604800 s). Both keys validate during grace window.
- D-15: Scope inheritance — rotated key keeps original's scopes verbatim.
- D-16: Audit + response shape: `audit.action = 'api_key.rotated'` with both ids. Response: `{ data: { id, key, keyPrefix, scopes, expiresAt, createdAt, supersedes, supersededExpiresAt } }`.

**Cross-Tenant Isolation Audit (AUTH-07)**

- D-17: Table-driven generator seeds tenants A + B with one resource per resource-type, iterates every authed route in OpenAPI spec, asserts tenant-B-token requests against A's resource path → `403` OR `404` with standard error envelope.
- D-18: Status code policy: prefer `404` over `403`. `403` reserved for scope-gated global resources.
- D-19: Reuse Phase 16 ErrorCode envelope: every assertion checks `error.code` is one of `RESOURCE_NOT_FOUND | INSUFFICIENT_SCOPE | TENANT_MISMATCH`.

**M2M OIDC (AUTH-08)**

- D-20: e2e covers full chain: Dex `client_credentials` → `createJob` via `@spatula/client` → `listJobs` → `getEntities`. Test in `tests/e2e/m2m/`.

**Docs (AUTH-06)**

- D-21: `docs/api-auth.md` is new and authoritative. Sections: auth strategies, scope catalog (CI gate vs code), token lifecycle, refresh tokens, CSRF N/A, stream tokens, CORS, M2M.

### Claude's Discretion

- Internal helper modules under `apps/api/src/sse/` mirror `apps/api/src/ws/` layout (handler.ts + buffer.ts + types.ts). Naming/internal API freely chosen.
- Test fixtures for `tests/isolation/` use existing Postgres harness shared with Phase 16 contract tests.
- SSE handler uses Hono `streamSSE` with `ReadableStream`. No server-side EventSource polyfill needed.

### Deferred Ideas (OUT OF SCOPE)

- WS deprecation (coexist at v1)
- SSE bidirectional fallback / long-poll
- Stream-token via header (EventSource shim)
- Refresh-token rotation server-side
- JWKS hot-rotation tests
- OIDC cookbooks for Auth0/Keycloak/Google Workspace (Phase 20)
- Reverse-proxy access-log token masking runbook (Phase 19)
- Native email/password auth
  </user_constraints>

<phase_requirements>

## Phase Requirements

| ID      | Description                                                                                                                                           | Research Support                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-01 | `GET /api/v1/jobs/:id/events` SSE endpoint with monotonic `id`, `Last-Event-ID` resume, 5-min ring buffer, 15 s keep-alive, required response headers | Redis Streams XADD/XRANGE/XREAD verified; Hono `streamSSE` signature confirmed; header auto-set vs manual confirmed              |
| AUTH-02 | Single-use stream-token via `?token=`, `POST /api/v1/ws-token` dual-purpose, 60 s TTL                                                                 | Existing `GETDEL` pattern confirmed in `server.ts:137`; ws-token route confirmed reusable                                        |
| AUTH-03 | CORS: explicit-list + wildcard-subdomain origins; preflight cache; `CORS_ALLOWED_ORIGINS` documented                                                  | Hono `cors()` function-form origin signature confirmed from installed source; return type confirmed                              |
| AUTH-04 | `examples/auth-dex/` zero-config recipe, `docker compose up` produces working Dex IDP                                                                 | Docker + Compose confirmed available; Dex v2.45.1 confirmed; minimal config patterns verified                                    |
| AUTH-05 | `POST /api/v1/api-keys/:id/rotate` zero-downtime rotation with grace window                                                                           | DB schema confirmed; `supersedes` column MISSING (migration required); grace = update `expiresAt` on old key                     |
| AUTH-06 | `docs/api-auth.md` authoritative scope list, refresh-token IDP clause, CSRF N/A clause                                                                | `DEFAULT_API_KEY_SCOPES` source confirmed; `AUTH_SCOPES` enum confirmed; no CI gate yet                                          |
| AUTH-07 | `tests/isolation/` cross-tenant audit suite over every authed route                                                                                   | Phase 16 Ajv+http.Server harness confirmed reusable; OpenAPI enumeration pattern confirmed; error code gaps found (see findings) |
| AUTH-08 | M2M OIDC `client_credentials` validated e2e against Dex                                                                                               | `JwtAuthProvider` verified; `user_tenants` claims-mapping path confirmed; Playwright v1.58.2 available in pnpm store             |

</phase_requirements>

---

## Summary

Phase 17 extends an existing, well-structured Hono/Redis/Postgres API. The core infrastructure is in excellent shape for this work: Hono 4.12.7 ships `streamSSE` with abort handling; ioredis 5.10.0 exposes full Redis Streams commands (XADD/XRANGE/XREAD); the Phase 16 contract test harness (Ajv2020 + Node http.Server) is ready to reuse for isolation tests; and Playwright 1.58.2 is already installed in the pnpm store for the browser and M2M smoke tests.

The main implementation work is: (1) adding `XADD` to `RedisEventPublisher.publish` alongside the existing `PUBLISH` call; (2) writing the SSE handler in `apps/api/src/sse/` that replays from stream then tails with `XREAD BLOCK`; (3) upgrading CORS origin to a function; (4) adding a `supersedes` column to `api_keys` via a migration and writing the rotate endpoint; (5) writing the table-driven isolation test generator; and (6) building `examples/auth-dex/` from a straightforward Dex docker-compose template.

Three gaps require attention before planning: (a) the `api_keys` table has no `supersedes` / `supersededAt` columns — a Drizzle migration is required; (b) CONTEXT.md D-19 references error codes `RESOURCE_NOT_FOUND`, `INSUFFICIENT_SCOPE`, `TENANT_MISMATCH` which do not exist in the current frozen ErrorCode enum (`@spatula/core-types`) — the isolation tests must use the actual codes `AUTH.INSUFFICIENT_SCOPE` and the appropriate `*.NOT_FOUND` variants, OR new codes are added (additive-only policy allows this); (c) `CORS_CONFIG_INVALID` is not in the ErrorCode enum — it is a boot-time panic, not an HTTP error code, so it can be a thrown `Error` rather than a `SpatulaError`.

**Primary recommendation:** Sequence as five sub-plans: (1) SSE buffer + dual-publish infrastructure; (2) SSE HTTP handler + stream-token reuse + rate-limit entry; (3) CORS wildcard function + docs/api-auth.md; (4) API key rotation (migration + route); (5) isolation audit suite + Dex recipe + M2M e2e.

---

## Standard Stack

### Core (already installed, verified from pnpm store)

| Library           | Version     | Purpose                                      | Why Standard                                                                          |
| ----------------- | ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| hono              | 4.12.7      | HTTP framework + SSE streaming               | Already in project; `streamSSE` helper ships with it                                  |
| ioredis           | 5.10.0      | Redis client incl. Streams API               | Already in project; XADD/XRANGE/XREAD typed                                           |
| jose              | 6.2.2       | JWT/JWKS verify (already in JwtAuthProvider) | Already in project                                                                    |
| @hono/zod-openapi | 0.19.10     | Route registration + OpenAPI spec generation | Already in project; new routes drop in cleanly                                        |
| drizzle-orm       | (workspace) | DB schema + migrations                       | Already in project; column additions via new migration file                           |
| playwright        | 1.58.2      | Browser OIDC smoke + M2M flow test           | Already in pnpm store (apps/cli dep); needs `playwright install` for browser binaries |

### Supporting (new additions)

| Library     | Version | Purpose                                            | When to Use                                                                                     |
| ----------- | ------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| eventsource | 4.1.0   | EventSource polyfill for `@spatula/client` in Node | SDK `getJobEvents` SSE streaming method (Phase 17 converts from non-streaming stub to real SSE) |

**Note:** `eventsource@4.1.0` (MIT, 1 dep) is available on npm. Its gzipped size is approximately 3 KB — well within the `@spatula/client` 50 KB gzipped budget. The browser `EventSource` API is native, so this dep is Node-only conditional import (dynamic `import()` guarded by `typeof window === 'undefined'`).

### Alternatives Considered

| Instead of                  | Could Use                             | Tradeoff                                                                                                                 |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Redis Streams (XADD/XRANGE) | In-memory ring buffer                 | In-memory fails across replicas; Redis Streams already available                                                         |
| `streamSSE` from hono       | `c.body(new ReadableStream(...))` raw | `streamSSE` handles abort, header setup, and SSE frame format; raw body gives more control but requires more boilerplate |
| Dex SQLite storage          | Dex Postgres storage                  | Postgres is more realistic but requires sidecar; SQLite boots in <10 s on a clean Mac (AUTH-04 criterion)                |

---

## Architecture Patterns

### Recommended Project Structure

```
apps/api/src/
├── sse/
│   ├── handler.ts       # Hono route handler: GETDEL token, XRANGE replay, XREAD tail, keepalive
│   ├── buffer.ts        # RedisStreamBuffer class: xadd, xrange, xread, expire helpers
│   └── types.ts         # SSEEvent type, replay_truncated event type
├── routes/
│   └── api-keys.ts      # Extended: rotate route added alongside create/list/revoke
├── auth/
│   └── jwt-provider.ts  # Unchanged (JwtAuthProvider already handles JWKS + user_tenants)
examples/
└── auth-dex/
    ├── docker-compose.yml
    ├── config/
    │   └── dex.yaml      # Static clients: browser (PKCE) + M2M (client_credentials)
    ├── README.md
    └── smoke/
        ├── browser-flow.ts   # Playwright: OIDC login → SSE subscribe → disconnect → reconnect
        └── m2m-flow.ts       # client_credentials → createJob → listJobs → getEntities
tests/
├── isolation/
│   ├── generator.ts     # Table-driven OpenAPI route enumeration + cross-tenant assertions
│   ├── fixtures.ts      # Seed helpers (extend seedTenantAndKey from tests/contract/)
│   ├── isolation.test.ts
│   └── vitest.config.ts
└── e2e/
    └── m2m/
        └── m2m-flow.test.ts  # AUTH-08: client_credentials e2e against Dex
docs/
└── api-auth.md           # New (AUTH-06, D-21)
packages/
└── db/
    └── drizzle/
        └── 0001_api_key_rotation.sql  # Adds supersedes + superseded_expires_at columns
```

### Pattern 1: Hono SSE Handler with Redis Stream Replay + Tail

**What:** On connection, consume single-use token via `GETDEL`, validate job ownership, replay buffered events via `XRANGE`, then tail live events via `XREAD BLOCK` loop. Keep-alive comment lines emitted on a separate timer.

**When to use:** Any SSE endpoint needing replay from a durable buffer.

```typescript
// Source: Hono 4.12.7 installed source + ioredis 5.10.0 types
import { streamSSE } from 'hono/streaming';

// Route handler (simplified):
export const sseHandler = createRoute({ method: 'get', path: '/{id}/events', ... });

router.openapi(sseHandler, async (c) => {
  const jobId = c.req.param('id');
  const token = c.req.query('token');
  const lastEventId = c.req.header('last-event-id') ?? c.req.query('lastEventId');

  // Consume single-use token (mirrors server.ts:137)
  const tokenData = await deps.redis.getdel(`ws-token:${token}`);
  if (!tokenData) throw new AuthInvalidTokenError('Invalid or expired stream token');
  const { tenantId } = JSON.parse(tokenData);

  // Validate job ownership
  const job = await deps.jobRepo.findById(jobId, tenantId);
  if (!job) throw new SpatulaError('Job not found', ErrorCode.JOB_NOT_FOUND);

  // X-Accel-Buffering: no must be set manually (streamSSE auto-sets Content-Type + Cache-Control)
  c.header('X-Accel-Buffering', 'no');

  return streamSSE(c, async (stream) => {
    // 1. Replay from buffer
    const startId = lastEventId ? `(${lastEventId}` : '-';
    const replayed = await deps.redis.xrange(`jobs:${jobId}:events`, startId, '+');

    if (lastEventId && replayed.length === 0) {
      // Check if stream exists at all; if so, send replay_truncated
      const oldest = await deps.redis.xrange(`jobs:${jobId}:events`, '-', '+', 'COUNT', 1);
      if (oldest.length > 0) {
        await stream.writeSSE({
          event: 'replay_truncated',
          data: JSON.stringify({ requestedId: lastEventId, oldestAvailableId: oldest[0][0] }),
          id: oldest[0][0],
        });
      }
    }

    for (const [id, fields] of replayed) {
      if (stream.aborted) break;
      await stream.writeSSE({ data: parseFields(fields), id });
    }

    // 2. Keepalive + live tail
    let cursor = replayed.length > 0 ? replayed[replayed.length - 1][0] : '$';
    const keepaliveMs = 15_000;

    while (!stream.aborted) {
      const result = await deps.redis.xread(
        'BLOCK', keepaliveMs,
        'STREAMS', `jobs:${jobId}:events`, cursor,
      );

      if (result === null) {
        // Timeout = keepalive comment
        if (!stream.aborted) await stream.write(':\n\n');
        continue;
      }

      const [[, entries]] = result;
      for (const [id, fields] of entries) {
        if (stream.aborted) break;
        await stream.writeSSE({ data: parseFields(fields), id });
        cursor = id;
      }
    }
  });
});
```

**Key implementation detail:** `streamSSE` in Hono 4.12.7 auto-sets `Content-Type: text/event-stream` and `Cache-Control: no-cache`. It does NOT set `X-Accel-Buffering: no` — that must be set manually via `c.header()` before the `streamSSE` call. The abort signal is NOT auto-wired on Node.js (only Bun gets the special `isOldBunVersion()` path in the Hono source). The `stream.aborted` property must be polled in the loop, or `stream.onAbort()` used for cleanup.

**Abort handling for Node.js:** The `c.req.raw.signal` is the request abort signal. Wire it explicitly:

```typescript
return streamSSE(c, async (stream) => {
  c.req.raw.signal.addEventListener('abort', () => stream.abort());
  // ... rest of handler
});
```

### Pattern 2: Dual-Publish in RedisEventPublisher

**What:** Add `XADD` alongside the existing `PUBLISH` call. Both are fire-and-forget inside try/catch to prevent event failures from crashing workers.

```typescript
// Source: packages/queue/src/events.ts (current code + extension pattern)
async publish(jobId: string, event: Omit<JobEvent, 'timestamp'>): Promise<void> {
  const full: JobEvent = { ...event, timestamp: Date.now() };
  const payload = JSON.stringify(full);
  const streamKey = `jobs:${jobId}:events`;

  try {
    // Existing pub/sub (WS path)
    await this.redis.publish(channelForJob(jobId), payload);
  } catch (err) {
    logger.warn({ jobId, type: event.type, err }, 'failed to publish event to pub/sub');
  }

  try {
    // New: Redis Stream (SSE path) — XADD MAXLEN ~ 500 * payload <json>
    await this.redis.xadd(streamKey, 'MAXLEN', '~', 500, '*', 'payload', payload);
    // EXPIRE refreshed on every write (EXPIRE does NOT auto-refresh on XADD)
    await this.redis.expire(streamKey, 300);
  } catch (err) {
    logger.warn({ jobId, type: event.type, err }, 'failed to publish event to stream');
  }
}
```

### Pattern 3: CORS Origin Function

**What:** Replace `origin: allowedOrigins` (string array) with `origin: (origin, c) => string | null`. Pre-compile patterns at boot; fail fast if config is invalid.

```typescript
// Source: Hono 4.12.7 cors middleware source (confirmed from installed file)
// Signature: origin: (origin: string, c: Context) => Promise<string | undefined | null> | string | undefined | null

function buildOriginMatcher(raw: string): { exact: Set<string>; patterns: RegExp[] } | null {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const exact = new Set<string>();
  const patterns: RegExp[] = [];

  for (const part of parts) {
    if (part.includes('*')) {
      // Single-label wildcard only: https://*.foo.com
      const escaped = part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '[^./]+');
      patterns.push(new RegExp(`^${escaped}$`));
    } else {
      exact.add(part);
    }
  }
  return { exact, patterns };
}

// In createApp():
const rawOrigins = getEnvOrDefault('CORS_ALLOWED_ORIGINS', 'http://localhost:3000');
const matcher = buildOriginMatcher(rawOrigins);
if (!matcher) {
  // Boot-time failure — not a SpatulaError, just a thrown Error
  throw new Error('CORS_CONFIG_INVALID: CORS_ALLOWED_ORIGINS is empty or malformed');
}

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (matcher.exact.has(origin)) return origin;
      for (const pattern of matcher.patterns) {
        if (pattern.test(origin)) return origin;
      }
      return null;
    },
    // ... existing options + add X-RateLimit-Reset and Retry-After to exposeHeaders
    exposeHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-Request-Id',
      'Retry-After',
    ],
  }),
);
```

**Confirmed behavior from Hono cors source:** The function is called with `(origin, c)` where `c` is the Hono Context. If the function returns `null` or `undefined`, no `Access-Control-Allow-Origin` header is set (preflight returns 204 without that header = browser blocks the request). This is the correct cross-origin block behavior.

### Pattern 4: API Key Rotation

**What:** `POST /api/v1/api-keys/:id/rotate` in a single Drizzle transaction: (1) read original key's scopes, (2) insert new key, (3) set `expiresAt = now + graceSeconds` on original. Return both ids.

```typescript
// Transaction pattern (mirrors existing create pattern in api-key-repository.ts)
const [oldKey, newKey] = await db.transaction(async (tx) => {
  // Read original
  const [orig] = await tx
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)));
  if (!orig)
    throw new SpatulaError('Not found', ErrorCode.JOB_NOT_FOUND, {
      context: { resource: 'api_key' },
    });
  if (orig.revokedAt) throw new SpatulaError('Key already revoked', ErrorCode.JOB_INVALID_STATE);

  // Create new key inheriting scopes
  const { raw, hash, prefix } = generateApiKey();
  const [newK] = await tx
    .insert(apiKeys)
    .values({
      tenantId,
      keyHash: hash,
      keyPrefix: prefix,
      name: orig.name + ' (rotated)',
      scopes: orig.scopes,
      supersedes: orig.id, // <-- new column (requires migration)
    })
    .returning();

  // Grace-expire old key
  const graceUntil = new Date(Date.now() + graceSeconds * 1000);
  const [oldK] = await tx
    .update(apiKeys)
    .set({ expiresAt: graceUntil })
    .where(eq(apiKeys.id, keyId))
    .returning();

  return [oldK, newK];
});
```

### Anti-Patterns to Avoid

- **Don't create a separate Redis subscriber for SSE.** The WS path uses a subscriber connection (`deps.redisSubscriber`) for pub/sub. SSE reads from streams, which does not require a subscriber connection — use the regular `deps.redis` connection.
- **Don't poll with `XREAD COUNT 1 STREAMS key $` in a tight loop.** The `BLOCK <ms>` parameter is essential to avoid busy-waiting. Without it, the loop consumes 100% CPU.
- **Don't mount SSE route via `server.ts` like WS.** SSE is pure HTTP (no upgrade handshake). Mount it in `app.ts` like all other routes, not in `server.ts`.
- **Don't forget `c.header('X-Accel-Buffering', 'no')` before `streamSSE`.** Hono does not set this automatically. Reverse proxies (nginx) buffer SSE responses by default without this header.
- **Don't set `XADD ... id` as `*` string — pass it as a positional arg.** In ioredis, the auto-id argument `'*'` is a plain string in the variadic args: `redis.xadd(key, 'MAXLEN', '~', 500, '*', fieldName, fieldValue)`. Do not wrap in quotes or stringify further.
- **Don't use `c.req.query('token')` with `requireScope` guard on SSE.** The scope check runs before the SSE handler body. Token is in query param, not the `Authorization` header — the `authMiddleware` would reject the request before you can read the token. The SSE route must use a custom auth bypass or be registered on a path that handles token-auth in-handler (like the WS upgrade does in `server.ts`).

---

## Don't Hand-Roll

| Problem                        | Don't Build                                    | Use Instead                                                  | Why                                                                   |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| SSE frame formatting           | Custom `data:`, `id:`, `event:` string builder | `stream.writeSSE({ data, id, event })` from `hono/streaming` | Handles multiline data, CRLF, field ordering                          |
| JWT/JWKS verify                | Custom JWKS fetch + RS256/ES256 decode         | `createRemoteJWKSet` + `jwtVerify` from `jose`               | Already in `JwtAuthProvider`; handles key rotation, cache TTL         |
| EventSource polyfill           | Custom fetch-based SSE parser                  | `eventsource@4.1.0` npm package                              | WhatWG/W3C compliant; handles reconnect + Last-Event-ID automatically |
| Cross-tenant route enumeration | Maintain a manual route list                   | Iterate `openapi.json` paths at test boot                    | OpenAPI-driven = zero drift as routes are added                       |
| PKCE code verifier/challenge   | Custom S256 SHA256 base64url                   | Playwright browser context handles it natively               | Browser does PKCE; Playwright drives the browser                      |

---

## Runtime State Inventory

This is NOT a rename/refactor phase. Runtime state inventory section is SKIPPED (no string replacement scope).

---

## Environment Availability

| Dependency     | Required By                | Available                 | Version       | Fallback                                           |
| -------------- | -------------------------- | ------------------------- | ------------- | -------------------------------------------------- |
| Redis          | SSE buffer, stream token   | ✓                         | 8.6.3 (local) | —                                                  |
| Docker         | `examples/auth-dex/`       | ✓                         | 29.3.0        | —                                                  |
| Docker Compose | `examples/auth-dex/`       | ✓                         | v5.1.0        | —                                                  |
| Node.js        | All                        | ✓                         | v26.0.0       | —                                                  |
| Playwright     | Browser smoke + M2M e2e    | ✓ (in pnpm store, 1.58.2) | 1.58.2        | Must run `playwright install` for browser binaries |
| PostgreSQL     | API tests, isolation suite | ✓ (via TEST_DATABASE_URL) | —             | —                                                  |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:**

- Playwright browser binaries: present in pnpm store but `playwright install` must be run before browser tests execute. Wave 0 of the browser smoke plan must include this step. CI must also run `playwright install`.

---

## Common Pitfalls

### Pitfall 1: `XREAD BLOCK` Holds the Redis Connection

**What goes wrong:** `XREAD BLOCK 15000 STREAMS key $` blocks the ioredis connection for up to 15 s. If the same connection is shared with the rest of the API, all other Redis operations (auth, rate-limit) stall.

**Why it happens:** ioredis multiplexes commands on one connection; a blocking command monopolizes it.

**How to avoid:** Use a **dedicated subscriber Redis client** for SSE blocking reads, the same pattern already used for WS (`deps.redisSubscriber` separate from `deps.redis`). Create a per-request ioredis connection OR share a pool-style pattern. Simplest: create one ioredis connection per SSE connection, destroy it on `stream.aborted`.

**Warning signs:** Other API routes returning 503/timeout while SSE clients are connected.

### Pitfall 2: Auth Middleware Blocks `?token=` Before SSE Handler Runs

**What goes wrong:** `authMiddleware` intercepts all `/api/*` routes and looks for `Authorization: Bearer` header. EventSource clients cannot set custom headers; they use `?token=` query param. If auth middleware does not special-case this path, the SSE request gets a 401 before the handler can consume the token.

**Why it happens:** `requireScope('jobs:read')` on `GET /api/v1/jobs/*` runs before the route handler body.

**How to avoid:** Two options:

1. Register the SSE route BEFORE the `requireScope` middleware, and perform token auth inside the handler (mirrors the WS pattern in `server.ts` which runs outside `authMiddleware`).
2. Extend `authMiddleware` to accept `?token=` on SSE-flagged paths and validate it against Redis there.

Option 1 is simpler and consistent with the WS pattern. The SSE route should be mounted in `app.ts` but the auth path must bypass `requireScope` middleware. Look at how `server.ts` mounts the WS route completely outside the auth chain — mirror that exact separation.

**Warning signs:** SSE requests returning `401 AUTH.MISSING_TOKEN` immediately.

### Pitfall 3: EXPIRE Does NOT Auto-Refresh on XADD

**What goes wrong:** Setting `EXPIRE 300` once at stream creation means events added 4 minutes later expire 1 minute after that — not 5 minutes from the last event.

**Why it happens:** Redis `XADD` does not extend the TTL of the key. The TTL is a separate metadata counter.

**How to avoid:** Call `await redis.expire(streamKey, 300)` after every `XADD`. This is a confirmed Redis behavior (verified against official docs). The EXPIRE call is fast (O(1)) and acceptable in the publish hot path.

**Warning signs:** Reconnecting clients getting `replay_truncated` for jobs still actively running.

### Pitfall 4: ioredis XADD with MAXLEN ~ Requires String Arguments

**What goes wrong:** `redis.xadd(key, 'MAXLEN', '~', 500, ...)` where `500` is passed as a number — ioredis accepts `RedisValue` which includes numbers, but the `~` token and field names must be strings. Passing the wrong types causes runtime parse errors.

**Why it happens:** The ioredis XADD signature is variadic (`...args: RedisValue[]`) with no compile-time validation of the MAXLEN subcommand structure.

**How to avoid:** Use explicit string conversion: `redis.xadd(key, 'MAXLEN', '~', '500', '*', 'payload', jsonString)`. Test with a live Redis in unit/integration tests.

### Pitfall 5: ErrorCode Enum Mismatch in Isolation Tests (D-19)

**What goes wrong:** CONTEXT.md D-19 specifies isolation test assertions check for `RESOURCE_NOT_FOUND | INSUFFICIENT_SCOPE | TENANT_MISMATCH`. None of these strings exist in the frozen `ErrorCode` enum in `@spatula/core-types`.

**Why it happens:** The CONTEXT.md was written using descriptive labels, not the actual `DOMAIN.CODE` values.

**How to avoid:** Map to actual enum values:

- `RESOURCE_NOT_FOUND` → use the resource-specific code: `JOB.NOT_FOUND`, `ENTITY.NOT_FOUND`, `EXPORT.NOT_FOUND`, `SCHEMA.NOT_FOUND` — OR — add a new `RESOURCE.NOT_FOUND` code (additive-only policy allows it)
- `INSUFFICIENT_SCOPE` → `AUTH.INSUFFICIENT_SCOPE` (exists)
- `TENANT_MISMATCH` → no current code; routes return 404 with `JOB.NOT_FOUND` for cross-tenant access (D-18 says prefer 404). No new code needed if D-18 is correctly implemented.

**Recommendation for planner:** Add `RESOURCE_NOT_FOUND: 'RESOURCE.NOT_FOUND'` to the ErrorCode enum as an additive v1.x addition, mapped to 404. Routes doing cross-tenant resource lookups throw this. Isolation tests assert exactly this code. This is cleaner than asserting per-resource-type codes in a generic cross-tenant suite.

### Pitfall 6: Hono SSE + timeout middleware conflict

**What goes wrong:** The existing `timeoutMiddleware` in `app.ts` has a `defaultMs: 30_000` timeout. SSE connections are long-lived (minutes). After 30 s, the timeout middleware closes the connection.

**Why it happens:** Timeout middleware wraps all `/api/*` responses with an abort timer.

**How to avoid:** Add SSE path to the `overrides` map in the timeout middleware call:

```typescript
app.use(
  '*',
  timeoutMiddleware({
    defaultMs: 30_000,
    overrides: {
      '/api/v1/exports/:exportId/download': 300_000,
      '/api/v1/jobs/:id/events': 0, // 0 = no timeout for SSE (or a very large value)
    },
  }),
);
```

Verify that `timeoutMiddleware` respects a `0` value as "no timeout". If not, use a very large value (e.g., `3_600_000` = 1 hour) or a special sentinel.

### Pitfall 7: Browser EventSource 6-Connection Limit

**What goes wrong:** Browser's HTTP/1.1 EventSource connections are limited to 6 per origin. If users open multiple tabs with live job subscriptions, connections queue or fail.

**Why it happens:** Standard browser HTTP/1.1 connection limit applies to EventSource.

**How to avoid (server-side):** Document the limit in `docs/api-auth.md`. With HTTP/2 (enabled by reverse proxies like nginx with TLS), the limit disappears — multiplexed over one TCP connection. Note: the local development server (no TLS) uses HTTP/1.1. For Phase 17, document the limitation; mitigation (HTTP/2) is a Phase 19 reverse-proxy concern.

### Pitfall 8: `supersedes` Column — Migration Required

**What goes wrong:** The rotate endpoint response (D-16) includes `supersedes: <oldId>`. The `api_keys` table has no `supersedes` column. Attempting to insert a value for a nonexistent column throws a Postgres error.

**Why it happens:** The schema was designed before the rotate feature was specced.

**How to avoid:** Wave 0 of the rotate plan must include a Drizzle migration file adding:

- `supersedes uuid REFERENCES api_keys(id)` (nullable, self-referential FK)
- Update `ApiKeyRepository.create` to accept optional `supersedes` field
- Update Drizzle schema file `packages/db/src/schema/api-keys.ts`

---

## Code Examples

### Redis Streams XADD with MAXLEN (ioredis 5.10.0)

```typescript
// Source: ioredis 5.10.0 RedisCommander.d.ts (variadic args pattern)
// XADD key MAXLEN ~ 500 * field value
await redis.xadd(
  'jobs:abc123:events', // key
  'MAXLEN',
  '~',
  '500', // trim to ~500 entries (approx, cheaper than exact)
  '*', // auto-generate id (returns '{ms}-{seq}' string)
  'payload', // field name
  JSON.stringify(event), // field value
);
// Returns: '1748123456789-0' (the generated stream id)

// Refresh TTL separately (XADD does NOT extend TTL automatically)
await redis.expire('jobs:abc123:events', 300);
```

### Redis Streams XRANGE for replay (exclusive lower bound)

```typescript
// Source: Redis docs (verified) - exclusive lower bound uses '(' prefix
// Redis 6.2+ supports '(' prefix for exclusive range; Redis 7+ is standard in new deployments
// ioredis xrange(key, start, end) — start can be '(lastId' for exclusive

// First connection (no Last-Event-ID): replay from beginning
const events = await redis.xrange('jobs:abc123:events', '-', '+');

// Reconnection with Last-Event-ID = '1748123456789-0':
// Use exclusive lower bound '(' prefix (Redis 6.2+)
const events = await redis.xrange('jobs:abc123:events', '(1748123456789-0', '+');
// Returns entries strictly AFTER that id
```

### Redis Streams XREAD BLOCK for live tail

```typescript
// Source: ioredis 5.10.0 RedisCommander.d.ts
// Returns null on timeout (no new events); returns array on new events

const result = await redis.xread(
  'BLOCK',
  15_000, // block up to 15 seconds
  'STREAMS',
  'jobs:abc123:events',
  '$', // '$' = only new events from this moment on
  // After replay: use last-replayed-id as cursor
);
// result === null → timeout → emit keepalive comment
// result === [[key, [[id, [fieldName, fieldValue, ...]], ...]]] → new events
```

### Hono streamSSE with abort handling (Node.js)

```typescript
// Source: Hono 4.12.7 streaming/sse.d.ts + verified abort handling
import { streamSSE } from 'hono/streaming';

// streamSSE auto-sets: Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive
// Must set manually: X-Accel-Buffering: no

c.header('X-Accel-Buffering', 'no');
return streamSSE(
  c,
  async (stream) => {
    // Wire abort signal for Node.js (Bun gets this automatically, Node does not)
    c.req.raw.signal.addEventListener('abort', () => {
      if (!stream.closed) stream.abort();
    });

    stream.onAbort(() => {
      // Cleanup: close dedicated redis connection, clear keepalive timer
      dedicatedRedis.quit().catch(() => {});
      clearInterval(keepaliveTimer);
    });

    // SSE comment = keepalive (no `id:` or `data:`, invisible to clients)
    // stream.write(':\n\n') sends a raw comment line
    const keepaliveTimer = setInterval(async () => {
      if (!stream.aborted) await stream.write(':\n\n');
    }, 15_000);

    // ... replay + tail loop ...
  },
  async (err, stream) => {
    // onError: log + emit error event
    logger.error({ err }, 'SSE stream error');
    await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: err.message }) });
  },
);
```

### Hono cors() function-form (Hono 4.12.7)

```typescript
// Source: Hono 4.12.7 middleware/cors/index.d.ts (read from installed file)
// Return type: string | undefined | null (null/undefined = block; string = echo back)

cors({
  origin: (origin: string, c: Context): string | null => {
    if (exactSet.has(origin)) return origin;
    for (const re of patterns) {
      if (re.test(origin)) return origin;
    }
    return null; // blocks cross-origin request
  },
  exposeHeaders: [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-Request-Id',
    'Retry-After', // D-09 additions
  ],
  maxAge: 86400,
  credentials: true,
});
```

### Dex minimal config.yaml (SQLite, static clients)

```yaml
# examples/auth-dex/config/dex.yaml
# Source: dex/docker-compose.yaml at master · dexidp/dex (GitHub) + canonical Dex docs
issuer: http://localhost:5556/dex

storage:
  type: sqlite3
  config:
    file: /data/dex.db

web:
  http: 0.0.0.0:5556

oauth2:
  skipApprovalScreen: true
  responseTypes:
    - code

connectors:
  - type: mockCallback # or: type: local with staticPasswords
    id: mock
    name: Mock

staticClients:
  # Browser client: PKCE authorization_code flow
  - id: spatula-browser
    name: Spatula Browser
    redirectURIs:
      - http://localhost:3000/callback
    public: true # No client secret for PKCE flows

  # M2M client: client_credentials
  - id: spatula-m2m
    name: Spatula M2M
    secret: dev-only-secret-m2m # DO NOT USE IN PRODUCTION
    redirectURIs: []

enablePasswordDB: true
staticPasswords:
  - email: dev@example.com
    hash: '$2a$10$...' # bcrypt of "password"
    username: devuser
    userID: '00000000-0000-0000-0000-000000000001'
```

**Dex JWT claims shape (verified from Dex v2.x docs):**

```json
{
  "iss": "http://localhost:5556/dex",
  "sub": "Cg0xMjM0NTY3ODkwEgRtb2Nr", // opaque subject (not the static userID directly)
  "aud": ["spatula-browser"],
  "exp": 1748200000,
  "iat": 1748196400,
  "email": "dev@example.com",
  "email_verified": true,
  "name": "devuser",
  "preferred_username": "devuser"
}
```

**Critical:** Dex does not embed a custom `tenant_id` claim. The `JwtAuthProvider` maps `payload.sub` → `user_tenants` table via `userTenantRepo.findByUserId(result.userId)`. The `sub` is Dex's opaque connector-scoped ID, not the static `userID`. The M2M client_credentials flow sets `sub` to the `client_id` (i.e., `spatula-m2m`). This means: for M2M tests, `user_tenants` must have a row for `userId = 'spatula-m2m'` pre-seeded, OR the auto-create-tenant path in `auth.ts:56-82` handles it (it does — new JWT users get a tenant auto-provisioned).

### @spatula/client getJobEvents SSE streaming (Phase 17 upgrade)

```typescript
// packages/client/src/methods/get-job-events.ts — Phase 17 replaces stub with real SSE
// Node: import { EventSource } from 'eventsource' (dynamic import to avoid browser bundle bloat)
// Browser: native window.EventSource

export function subscribeJobEvents(
  client: SpatulaClient,
  jobId: string,
  options: {
    onEvent: (event: JobEvent) => void;
    onError?: (err: Event) => void;
    lastEventId?: string;
    token: string; // single-use stream token from POST /api/v1/ws-token
  },
): () => void /* unsubscribe */ {
  const url = new URL(`${client.baseUrl}/api/v1/jobs/${jobId}/events`);
  url.searchParams.set('token', options.token);
  if (options.lastEventId) url.searchParams.set('lastEventId', options.lastEventId);

  const es = new EventSource(url.toString());
  es.onmessage = (e) => options.onEvent(JSON.parse(e.data));
  if (options.onError) es.onerror = options.onError;

  return () => es.close();
}
```

---

## State of the Art

| Old Approach                                                     | Current Approach                                                | When Changed            | Impact                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Redis XRANGE `{id}+1` exclusive bound (manual `ms+1` arithmetic) | Redis 6.2+: `(id` prefix for native exclusive bound             | Redis 6.2 (2021)        | No more integer arithmetic on stream ids; cleaner syntax       |
| Hono CORS string array `origin: []`                              | Hono 4.x: `origin: (origin, c) => string \| null` function form | Hono 3.x+               | Dynamic per-request origin matching; enables wildcard patterns |
| Separate SSE polling endpoint                                    | `streamSSE` with persistent connection + Last-Event-ID          | Standard since Hono 3.x | Native reconnect; browser handles retry automatically          |
| EventSource v3 (`node-eventsource`)                              | `eventsource@4.x` (WhatWG/W3C compliant)                        | 2024                    | Standard API; auto-manages `Last-Event-ID` on reconnect        |

**Deprecated/outdated:**

- `EventSource` from `node-eventsource` or `eventsource@2.x/3.x`: use `eventsource@4.1.0`
- Hono CORS with `origin: string[]` for dynamic matching: use function form instead

---

## Open Questions

1. **CORS_CONFIG_INVALID error code — enum or thrown Error?**
   - What we know: `CORS_CONFIG_INVALID` is not in the frozen ErrorCode enum. It is a boot-time failure, not an HTTP response.
   - What's unclear: Should it be added to ErrorCode (for consistency) or thrown as a plain `Error`?
   - Recommendation: Plain `Error` thrown at boot with message `'CORS_CONFIG_INVALID: ...'`. Boot failures are not HTTP responses and don't need the error envelope.

2. **Isolation test error codes: add RESOURCE.NOT_FOUND or assert per-resource codes?**
   - What we know: D-19 references `RESOURCE_NOT_FOUND` which doesn't exist. Routes currently throw `JOB.NOT_FOUND`, `ENTITY.NOT_FOUND`, etc. for tenant-mismatch lookups.
   - Recommendation: Add `RESOURCE_NOT_FOUND: 'RESOURCE.NOT_FOUND'` (additive, 404) to ErrorCode enum. Routes doing cross-tenant resource access throw this. Cleaner for isolation test assertions.

3. **SSE route placement: inside or outside authMiddleware chain?**
   - What we know: WS upgrade lives entirely in `server.ts` outside the auth/requireScope middleware. SSE is pure HTTP.
   - Recommendation: Mount SSE handler in `app.ts` but BEFORE the `requireScope('jobs:read')` lines. Add explicit token-only auth path inside the handler, mirroring the WS pattern.

4. **Dedicated Redis connection per SSE connection or shared pool?**
   - What we know: `XREAD BLOCK` blocks the connection. Current architecture has `deps.redis` (shared) and `deps.redisSubscriber` (subscriber, for WS pub/sub).
   - Recommendation: Create a new ioredis connection inside the SSE handler, destroyed on disconnect. This is the simplest approach; one connection per active SSE client. At 100 concurrent SSE clients this is 100 Redis connections — acceptable for v1 scale. Document the connection-per-client model.

---

## Validation Architecture

### Test Framework

| Property           | Value                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Framework          | Vitest v2.1.0                                                                                                                         |
| Config file        | `tests/contract/vitest.config.ts` (reused); `tests/isolation/vitest.config.ts` (new); `tests/e2e/vitest.config.ts` (extended for m2m) |
| Quick run command  | `pnpm --filter @spatula/api test` (unit) or `vitest run --config tests/contract/vitest.config.ts`                                     |
| Full suite command | `vitest run --config tests/isolation/vitest.config.ts && vitest run --config tests/e2e/vitest.config.ts`                              |

### Phase Requirements → Test Map

| Req ID  | Behavior                                                                                          | Test Type        | Automated Command                                            | File Exists? |
| ------- | ------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------ | ------------ |
| AUTH-01 | SSE replay from Last-Event-ID; keepalive comment; correct headers                                 | integration      | `vitest run tests/isolation/vitest.config.ts`                | ❌ Wave 0    |
| AUTH-01 | `replay_truncated` synthetic event when Last-Event-ID too old                                     | unit             | `vitest run apps/api/src/sse/handler.test.ts`                | ❌ Wave 0    |
| AUTH-02 | Single-use token consumed by GETDEL; 60 s TTL; dual WS+SSE use                                    | integration      | `vitest run tests/contract/vitest.config.ts`                 | ❌ Wave 0    |
| AUTH-03 | CORS wildcard origin function matches `https://app.spatula.dev` not `https://foo.bar.spatula.dev` | unit             | `vitest run apps/api/src/app.test.ts` (or co-located)        | ❌ Wave 0    |
| AUTH-03 | CORS preflight returns 204 with correct expose-headers                                            | integration      | `vitest run tests/contract/vitest.config.ts`                 | ❌ Wave 0    |
| AUTH-04 | `docker compose up` in `examples/auth-dex/` produces working IDP                                  | e2e/manual       | `pnpm smoke:dex` (manual)                                    | ❌ Wave 0    |
| AUTH-04 | Playwright browser-flow: OIDC login → SSE subscribe → disconnect → reconnect                      | e2e              | `vitest run tests/e2e/browser/vitest.config.ts`              | ❌ Wave 0    |
| AUTH-05 | Rotate creates new key; old key still validates during grace window                               | integration      | `vitest run tests/contract/vitest.config.ts`                 | ❌ Wave 0    |
| AUTH-05 | Old key 401s after grace window expires                                                           | integration      | Time-sensitive; use DB-direct expiresAt manipulation in test | ❌ Wave 0    |
| AUTH-06 | `docs/api-auth.md` scope table matches `DEFAULT_API_KEY_SCOPES`                                   | CI gate (script) | `pnpm check:docs` (new script)                               | ❌ Wave 0    |
| AUTH-07 | Tenant B token → Tenant A resource → 404 with RESOURCE.NOT_FOUND                                  | integration      | `vitest run tests/isolation/vitest.config.ts`                | ❌ Wave 0    |
| AUTH-07 | Every authed route in OpenAPI spec is covered by isolation matrix                                 | integration      | Same isolation suite (generator validates coverage)          | ❌ Wave 0    |
| AUTH-08 | Dex client_credentials → JWT → createJob → listJobs → getEntities                                 | e2e              | `vitest run tests/e2e/m2m/vitest.config.ts`                  | ❌ Wave 0    |

### Sampling Rate

- **Per task commit:** `pnpm --filter @spatula/api test` (unit tests, no infra required)
- **Per wave merge:** `vitest run --config tests/contract/vitest.config.ts` + `vitest run --config tests/isolation/vitest.config.ts` (requires Postgres + Redis)
- **Phase gate:** Full suite green + browser e2e + M2M e2e before `/gsd:verify-work`

### Wave 0 Gaps

All test files are new. Required before implementation:

- [ ] `tests/isolation/vitest.config.ts` — mirrors `tests/contract/vitest.config.ts`; adds `@spatula/queue` alias
- [ ] `tests/isolation/fixtures.ts` — extends `seedTenantAndKey` from `tests/contract/helpers/server-harness.ts` with resource seeding per type
- [ ] `tests/isolation/generator.ts` — OpenAPI-driven route enumeration; cross-tenant assertion logic
- [ ] `tests/isolation/isolation.test.ts` — imports generator, boots server, runs matrix
- [ ] `tests/e2e/m2m/m2m-flow.test.ts` — AUTH-08 e2e (requires running Dex + API + Postgres + Redis)
- [ ] `tests/e2e/browser/vitest.config.ts` + `browser-flow.test.ts` — AUTH-04 Playwright smoke
- [ ] `apps/api/src/sse/handler.test.ts` — unit tests for replay logic, replay_truncated, keepalive
- [ ] Framework install: `playwright install chromium` — required before browser e2e tests run; add to CI workflow and `README.md` dev setup

---

## Sources

### Primary (HIGH confidence)

- Hono 4.12.7 installed source (`node_modules/.pnpm/hono@4.12.7/`) — SSE helper, cors middleware, StreamingApi, abort behavior
- ioredis 5.10.0 installed types (`RedisCommander.d.ts`) — XADD/XRANGE/XREAD/EXPIRE signatures
- `apps/api/src/` codebase — direct inspection of server.ts, app.ts, ws-token.ts, api-keys.ts, jwt-provider.ts, api-key-provider.ts
- `packages/queue/src/events.ts` — dual-publish change site confirmed
- `packages/shared/src/auth/types.ts` — `DEFAULT_API_KEY_SCOPES` and `AUTH_SCOPES` confirmed
- `packages/core-types/src/errors/codes.ts` — ErrorCode enum values confirmed; RESOURCE_NOT_FOUND gap identified
- `packages/db/src/schema/api-keys.ts` + `drizzle/0000_v1_baseline.sql` — `supersedes` column confirmed absent
- `tests/contract/helpers/server-harness.ts` + `ajv-setup.ts` — isolation test harness reuse confirmed

### Secondary (MEDIUM confidence)

- Redis official docs (https://redis.io/docs/latest/commands/xrange/) — exclusive `(` lower bound syntax confirmed (Redis 6.2+)
- Redis official docs (https://redis.io/docs/latest/commands/expire/) — EXPIRE does NOT auto-refresh on XADD confirmed
- Dex GitHub releases (https://github.com/dexidp/dex/releases) — v2.45.1 confirmed latest
- Hono GitHub issue #2068 — Node.js `onAbort` behavior for SSE confirmed; `c.req.raw.signal` abort wiring pattern
- npm `eventsource@4.1.0` — WhatWG/W3C compliant; MIT; 1 dependency

### Tertiary (LOW confidence)

- WebSearch for Dex docker-compose minimal config — basic structure corroborated against GitHub and community guides; actual YAML validated against Dex spec in canonical refs

---

## Project Constraints (from CLAUDE.md)

No `CLAUDE.md` found in the project root. No additional project-level directives to enforce beyond what is in CONTEXT.md.

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — versions read directly from installed pnpm store and package.json
- Architecture: HIGH — code inspected directly; patterns mirror existing WS implementation exactly
- Pitfalls: HIGH — abort behavior verified from Hono source; EXPIRE behavior verified from Redis docs; schema gaps confirmed from migration SQL
- Validation architecture: HIGH — test harness structure read from existing contract test files

**Research date:** 2026-05-20
**Valid until:** 2026-06-20 (Hono patch releases may change streaming behavior; pin to 4.12.7)
