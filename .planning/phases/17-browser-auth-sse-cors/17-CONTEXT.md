# Phase 17: Browser Auth, SSE, CORS - Context

**Gathered:** 2026-05-19
**Status:** Ready for planning
**Mode:** `--auto` (user requested no clarifying questions — reasonable defaults selected and logged inline)

<domain>
## Phase Boundary

Ship the web-UI-enablement gap on the **auth + streaming** side so a browser client driven by OIDC (Dex local recipe) can subscribe to live job events via SSE, reconnect cleanly via `Last-Event-ID`, rotate keys without downtime, and never see another tenant's data.

**In scope (REQUIREMENTS.md):**

- `GET /api/v1/jobs/:id/events` SSE endpoint — monotonic `id`, `Last-Event-ID` resume, 5-min replay buffer, 15 s keep-alive, `X-Accel-Buffering: no` + `Cache-Control: no-cache` + `Content-Type: text/event-stream` (AUTH-01)
- Single-use stream-token flow extended to SSE via `?token=`; `POST /api/v1/ws-token` issues tokens valid for either WS or SSE; 60 s TTL (AUTH-02)
- CORS: explicit-list + wildcard-subdomain origins (`https://*.spatula.dev`); preflight cache; `CORS_ALLOWED_ORIGINS` format documented (AUTH-03)
- `examples/auth-dex/` — `docker compose up` produces a working OIDC IDP that the browser smoke client targets without env surgery (AUTH-04)
- `POST /api/v1/api-keys/:id/rotate` — zero-downtime rotation with grace window (AUTH-05)
- `docs/api-auth.md` — authoritative scope list; explicit "refresh-tokens-are-IDP's-job" + "CSRF-N/A for Bearer auth" sections (AUTH-06)
- `tests/isolation/` — exhaustive cross-tenant audit suite over every authed route (AUTH-07)
- M2M OIDC `client_credentials` flow validated e2e against Dex (AUTH-08)

**Out of scope:**

- Security hardening (prompt-injection, redaction, DSR) — Phase 18
- Legal/CLA/trademark — Phase 18
- Deployment runbooks (k8s, render, cosign, runbook for reverse-proxy token-masking) — Phase 19
- Docs site infrastructure — Phase 20 (Phase 17 ships only the `*.md` files it owns)
- Reference web UI itself — non-goal (sibling repo / private SaaS)
- WS deprecation — both WS and SSE coexist at v1; no WS removal in 1.x

**Pre-phase gate:** None (Phase 16 deliverables are the only hard dependency: error envelope, version probe, scope inventory — all complete).

</domain>

<decisions>
## Implementation Decisions

### Event Buffer & Replay (AUTH-01)

- **D-01:** Buffer = **Redis Streams** (`jobs:{jobId}:events`), `XADD MAXLEN ~ 500 * payload=<json>`, `EXPIRE 300` per-key on first add. Replay via `XRANGE jobs:{jobId}:events {LastEventId}+1 +`. Live tail via `XREAD BLOCK <keepalive_ms> STREAMS ... $`.
  - _Why:_ Survives multi-replica (any worker can serve any client), native monotonic id `{ms}-{seq}`, MAXLEN trims memory automatically, EXPIRE handles dead jobs. In-memory ring fails the moment we run >1 API replica. Already have `ioredis`.
- **D-02:** **Dual-publish.** `packages/queue/src/events.ts::RedisEventPublisher.publish` writes to **both** the existing pub/sub channel (`channelForJob`) **and** the new stream (`XADD jobs:{id}:events`). WS path keeps subscribing; SSE consumes the stream only.
  - _Why:_ Zero regression for existing WS (`apps/api/src/ws/job-progress.ts`), and SSE gets a single coherent storage model (live + replay from one source). No second worker process needed.
- **D-03:** **SSE `id:` field = Redis stream id verbatim** (`{ms}-{seq}`). Client's `Last-Event-ID` header is passed straight into `XRANGE` as the exclusive lower bound.
  - _Why:_ Server-generated, monotonic, free. Avoids a custom counter + atomic-INCR round trip per event.
- **D-04:** **Per-job retention budget:** `MAXLEN ~ 500` (approx-trim) + `EXPIRE 300` on the stream key, refreshed on every `XADD`. Events older than 5 min OR position 501+ are gone; client that lost more than that restarts from `current` and the SSE handler emits a synthetic `replay_truncated` event with the oldest available id so the client can react.
  - _Why:_ Matches spec §3.3.2 exactly. `~` approx-MAXLEN is much cheaper than exact. Truncation signal lets clients invalidate their local cache.
- **D-05:** **15 s keep-alive** via SSE comment line (`:\n\n`) — keep-alive timer separate from event loop; survives `XREAD BLOCK` returning empty.

### Stream Token Reuse (AUTH-02)

- **D-06:** **Single shared token endpoint, dual-purpose token.** Existing `POST /api/v1/ws-token` is the canonical issuer. Token stored at `ws-token:{token}` (Redis) with 60 s TTL, value `{ tenantId, createdAt }`. Both WS upgrade (`server.ts:130-150`) and the new SSE handler call `GETDEL` to consume it.
  - _Why:_ Single-use semantics already correct (existing `GETDEL`). Endpoint name preserved per spec §3.3.2. No new route; no new schema.
- **D-07:** **OpenAPI doc update** on `POST /api/v1/ws-token`: rename `summary` to "Create a single-use stream token (WebSocket or SSE)" and add an `events` example showing `EventSource('/api/v1/jobs/:id/events?token=...')`. Existing operationId preserved (no SDK breaking change).

### CORS Wildcard (AUTH-03)

- **D-08:** **`origin` becomes a function** in `apps/api/src/app.ts` cors config. Parse `CORS_ALLOWED_ORIGINS` once at boot into two arrays: `exact: string[]` and `patterns: RegExp[]`. Wildcard entries (`https://*.foo.com`) compile to `/^https:\/\/[^./]+\.foo\.com$/` — exactly one subdomain label, no nested wildcards, no protocol mixing. Function returns the matching origin string or `null`.
  - _Why:_ Hono's `cors()` already supports `origin: (origin, c) => string | null`. Pre-compile to avoid per-request regex cost. Single-label wildcard mirrors AWS/Cloudflare semantics and avoids `*.spatula.dev` matching `evil.spatula.dev.attacker.com`.
- **D-09:** **Preflight cache stays at 86400 s** (already set). `expose-headers` extended to include `X-RateLimit-Reset` + `Retry-After` (Phase 16 added these but they're not in `exposeHeaders`).
- **D-10:** **Format documentation** ships in `docs/api-auth.md` (new CORS section) — not a separate `docs/cors.md`. Includes 3 worked examples (single origin, list, wildcard-subdomain), explicit "no `*` allowed" rule, and exit code if mis-configured (boot fails fast with `CORS_CONFIG_INVALID`).
  - _Why:_ Operators reading auth docs are the same people configuring CORS; one doc per surface.

### Dex Local Recipe (AUTH-04, AUTH-08)

- **D-11:** **`examples/auth-dex/` ships as a self-contained kit:** `docker-compose.yml` (Dex + Postgres optional sidecar for state-of-the-art realism — start with SQLite for simplicity), `config/dex.yaml` (static config with one connector + two static-clients: one for browser code flow + PKCE, one for M2M `client_credentials`), `README.md` (zero-config walkthrough), `smoke/browser-flow.ts` (Playwright that drives the browser OIDC dance end-to-end), `smoke/m2m-flow.ts` (curl-equivalent for AUTH-08).
- **D-12:** **Dex storage = SQLite** in the example (mounted volume); not Postgres. Reason: `docker compose up` produces a working IDP in <10 s on a clean Mac, which is the AUTH-04 acceptance criterion. Realistic Postgres setup belongs in the Auth0/Keycloak/Google cookbooks (Phase 20).
- **D-13:** **Static-client credentials are committed to the repo as `dev-only-secret-xxx`** with a banner `# DO NOT USE IN PRODUCTION` in the dex config. Documented in `examples/auth-dex/README.md`.

### API Key Rotation (AUTH-05)

- **D-14:** **Two-key grace window** — `POST /api/v1/api-keys/:id/rotate` returns a freshly-generated raw key (shown once, same pattern as create), AND marks the **old key** with `expiresAt = now + graceSeconds` (default 86400 s = 24 h, request override `0..604800`, server-clamped). Both keys validate during the grace window. After grace expires, the old key 401s like any other expired key.
  - _Why:_ Matches AWS IAM rotation UX — clients adopt new key, verify, then let the old one age out. Zero-downtime by construction. Configurable grace lets ops crank to 7 d for client populations that rotate slowly.
- **D-15:** **Scope inheritance** — rotated key keeps the original's scopes verbatim. Can't elevate via rotate. The rotate path is **not** a key-edit path. Renaming or rescoping is still create+revoke.
- **D-16:** **Audit + response shape:** rotation emits `audit.action = 'api_key.rotated'` with both ids; response is `{ data: { id: <new>, key, keyPrefix, scopes, expiresAt, createdAt, supersedes: <oldId>, supersededExpiresAt } }`.

### Cross-Tenant Isolation Audit (AUTH-07)

- **D-17:** **Table-driven generator** seeds tenants A + B with one resource per resource-type (job, entity, extraction, action, export, api-key, schema, dlq-entry, audit-log row, content-store blob, etc.), then iterates over **every authed route in the OpenAPI spec** (the same source Phase 16's contract tests use) and asserts: tenant-B-token requests against A's resource path → `403` OR `404` with the standard error envelope, no leaked tenant data in `message` or `details`.
  - _Why:_ Generating from OpenAPI guarantees coverage as routes are added — no "we forgot to add an isolation test for the new endpoint" failure mode. Reuses Phase 16's Ajv + http.Server harness (`tests/contract/`).
- **D-18:** **Status code policy:** prefer `404` (treat cross-tenant access as "doesn't exist") over `403` (confirms existence). `403` reserved for routes where the resource is global but the action is scope-gated (e.g., admin-only). Test asserts whichever the route declares is the one returned.
- **D-19:** **Reuse Phase 16 ErrorCode envelope:** every assertion checks `error.code` is one of `RESOURCE_NOT_FOUND | INSUFFICIENT_SCOPE | TENANT_MISMATCH`. Catches accidental envelope drift.

### M2M OIDC client_credentials (AUTH-08)

- **D-20:** **e2e covers full chain:** Dex `client_credentials` token → `createJob` via `@spatula/client` → `listJobs` → `getEntities`. Test lives in `tests/e2e/m2m/`. Reuses Dex from `examples/auth-dex/`. JWT `aud` + `iss` validated against AUTH provider; tenant resolution via `user_tenants` claims-mapping path that's already in `JwtAuthProvider`.

### Docs (AUTH-06)

- **D-21:** `docs/api-auth.md` is **new and authoritative** — supersedes scattered scope mentions in package READMEs. Sections (fixed): "Authentication strategies" (NoAuth / API key / JWT-OIDC), "Scope catalog" (table generated from `packages/shared/src/auth/types.ts::DEFAULT_API_KEY_SCOPES` + admin scopes; CI gate that the doc table matches code), "Token lifecycle" (incl. rotation + grace window), "Refresh tokens — IDP's job" subsection, "CSRF — N/A for Bearer auth" subsection, "Stream tokens (WS + SSE)" subsection, "CORS" subsection (see D-10), "M2M (client_credentials)" subsection.

### Claude's Discretion

- Internal helper modules under `apps/api/src/sse/` mirror `apps/api/src/ws/` layout (handler.ts + buffer.ts + types.ts). Naming/internal API freely chosen.
- Test fixtures for `tests/isolation/` use the existing Postgres harness shared with Phase 16 contract tests — no new DB infra.
- SSE handler implementation language: Hono `c.body(stream)` with `ReadableStream`. No `EventSource` polyfill needed server-side.

### Folded Todos

None — `todo match-phase 17` returned 0 matches.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Spec (source of truth)

- `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md` §3.3.2 (SSE design — buffer size, keep-alive, X-Accel-Buffering, token-in-URL log-leak mitigation, single-use TTL) — **the authoritative SSE contract**
- `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md` §3.4 (auth surface for OIDC browser flow — JWT, JWKS rotation, CORS wildcard, M2M, CSRF-N/A, refresh-token-IDP-job)
- `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md` §6-3 (Phase 17 sub-plan deliverables + acceptance)

### Project Planning

- `.planning/REQUIREMENTS.md` AUTH-01..AUTH-08 (acceptance criteria)
- `.planning/ROADMAP.md` "Phase 17: Browser Auth, SSE, CORS" (goal, depends-on, success criteria)
- `.planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md` — error envelope policy, ErrorCode enum location, scope inventory, version probe pattern (Phase 17 must consume, not redefine)

### Existing Code (to extend, mirror, or fix)

- `apps/api/src/ws/job-progress.ts` — WS event-distribution pattern that SSE mirrors (clients map, tenant filter, safeSend, heartbeat)
- `apps/api/src/routes/ws-token.ts` — token issuer (reused as-is; OpenAPI doc only)
- `apps/api/src/server.ts:94-175` — WS upgrade + `redis.getdel` single-use token consume pattern (SSE replicates this exact shape)
- `apps/api/src/app.ts:70-95` — current CORS config (extend with wildcard via function-form `origin`)
- `apps/api/src/auth/jwt-provider.ts` — JWKS verify path; OIDC code-flow tokens land here
- `apps/api/src/auth/api-key-provider.ts` — scope/expiry semantics that rotate path must preserve
- `apps/api/src/routes/api-keys.ts` — create/list/revoke (rotate slots in alongside)
- `packages/queue/src/events.ts` — `RedisEventPublisher.publish` (dual-publish to streams added here)
- `packages/shared/src/auth/types.ts` (`DEFAULT_API_KEY_SCOPES`) — scope source-of-truth for `docs/api-auth.md` table
- `config/rate-limits.yaml` — add `GET /api/v1/jobs/{id}/events` + `POST /api/v1/api-keys/{id}/rotate` entries
- `tests/contract/` — Ajv + http.Server harness reused for `tests/isolation/`

### Codebase Maps (background)

- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONVENTIONS.md`, `.planning/codebase/TESTING.md` — generated 2026-05-06; still authoritative for layout

### Docs Output (this phase creates)

- `docs/api-auth.md` (new — see D-21)
- `examples/auth-dex/README.md` (new — see D-11)
- `docs/cookbook/oidc-dex.md` — _deferred to Phase 20_ (Auth0/Keycloak/Google triad lives there)

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **`RedisEventPublisher`** (`packages/queue/src/events.ts`) — already Redis-backed; add `XADD` alongside `PUBLISH`. One function, one PR-sized change.
- **WS single-use token consume** (`server.ts:138`) — uses `redis.getdel('ws-token:{token}')` atomically. Copy-paste into the SSE handler verbatim.
- **`JobProgressManager`** — tenant filtering already lives in `handleRedisMessage` (`entry.tenantId !== event.tenantId` skip). SSE handler applies the same filter on stream replay + tail.
- **Hono `cors()` origin function** — accepts `(origin, c) => string | null`. No fork of Hono cors middleware needed.
- **`@hono/zod-openapi` `createRoute` pattern** — every route in `apps/api/src/routes/` follows it. New SSE + rotate routes drop in cleanly; OpenAPI auto-updates.
- **Phase 16 Ajv harness in `tests/contract/`** — reusable for `tests/isolation/` (OpenAPI-driven enumeration).

### Established Patterns

- **Single-use tokens use Redis `GETDEL`** — atomic consume, prevents replay. Stick to it for SSE.
- **Error envelope** — every 4xx/5xx goes through `apps/api/src/middleware/error-handler.ts` and emits `{ error: { code, message, requestId, details? } }`. Phase 17 routes throw `SpatulaError` subclasses from `@spatula/core-types`; never hand-roll error responses.
- **Scope enforcement** — `app.<method>('/path', requireScope('domain:action'))` registered before the route handler. SSE handler needs `jobs:read`; rotate needs `api_keys:write` (verify scope name in `DEFAULT_API_KEY_SCOPES`).
- **OpenAPI is single-source** — `GET /api/v1/openapi.json` serves runtime spec from build source. SSE + rotate routes must register an `@hono/zod-openapi` `createRoute` so they appear in the spec and pick up Phase 16's contract tests.

### Integration Points

- **`apps/api/src/app.ts`** — register `app.route('/api/v1/jobs/:id/events', sseRoutes())` near the existing WS-token mount (line ~162); register `app.route('/api/v1/api-keys/:id/rotate', ...)` near `apiKeyRoutes`.
- **`apps/api/src/server.ts`** — SSE handler can mount in `app.ts` (no WebSocket-style upgrade needed; pure HTTP). Keep `server.ts` WS-specific.
- **`packages/queue/src/events.ts`** — single touch point for the dual-publish change; all event sites already use `RedisEventPublisher`.
- **`@spatula/client`** — SDK gains a `getJobEvents(jobId, { onEvent, lastEventId? })` method; under the hood `EventSource` in browser, polyfilled `eventsource` in Node. Size-limit budget still applies — verify `EventSource` polyfill cost (~3 KB gzipped, acceptable inside the <50 KB cap).

</code_context>

<specifics>
## Specific Ideas

- **Stream key naming:** `jobs:{jobId}:events` (matches existing `channelForJob` convention `jobs:{jobId}:progress` — pick distinct suffix to avoid colliding with pub/sub channel namespace).
- **`replay_truncated` synthetic event:** emitted _exactly once_ on SSE connection when `Last-Event-ID` is older than the oldest entry in the stream. Type: `replay_truncated`, data: `{ requestedId, oldestAvailableId }`. Client UI shows "live data — earlier events lost". Spec §3.3.2 says "events older than 5 min are lost (client restarts from current)" — the synthetic event is the polite way to signal that.
- **Grace window cap = 7 days** (`604800`) for `rotate` — longer windows hide compromised keys. Document the cap.
- **CORS wildcard format = "exactly one label substitution"**. `https://*.spatula.dev` matches `https://app.spatula.dev` and `https://docs.spatula.dev`, NOT `https://foo.bar.spatula.dev`. Single-label-only is the AWS API Gateway convention.

</specifics>

<deferred>
## Deferred Ideas

- **WS deprecation** — both WS and SSE coexist at v1; revisit at v2 cut (~12 months post-GA). SSE wins for read-only dashboards; WS stays for bidirectional CLI workflows.
- **Server-Sent Events bidirectional fallback** (long-poll resume on EventSource unavailable) — browser support is universal; skip.
- **Stream-token via header instead of query param** — would require fetch-based EventSource shim in SDK; out of scope for v1 (spec §3.3.2 explicitly accepts the query-param tradeoff).
- **Refresh-token rotation server-side** — DEFER-07 / OIDC-only stance; spec §3.4. Documented, not implemented.
- **JWKS hot-rotation tests** — works correctly via `jose.createRemoteJWKSet` default TTL; explicit test deferred unless a real rotation issue surfaces.
- **OIDC cookbooks for Auth0 / Keycloak / Google Workspace** — Phase 20 (DOCS-04, DOCS-09). Phase 17 ships only the Dex example (AUTH-04).
- **Reverse-proxy access-log token masking runbook** — Phase 19 (DEPLOY-07, `docs/runbooks/reverse-proxy.md`). Phase 17 just documents that the masking exists.
- **Native email/password auth** — DEFER-07. Out forever (OIDC-only).
- **Reviewed Todos (not folded):** none.

</deferred>

---

_Phase: 17-browser-auth-sse-cors_
_Context gathered: 2026-05-19_
