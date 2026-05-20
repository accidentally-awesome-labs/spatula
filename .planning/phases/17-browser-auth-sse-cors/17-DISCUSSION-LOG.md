# Phase 17: Browser Auth, SSE, CORS - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-19
**Phase:** 17-browser-auth-sse-cors
**Mode:** `--auto` (user requested no clarifying questions — Claude selected the recommended option for every gray area)
**Areas discussed:** SSE buffer storage, Stream-token reuse, CORS wildcard implementation, Dex example shape, API-key rotation semantics, Cross-tenant isolation audit, M2M OIDC, Docs scope

---

## SSE Event Buffer & Replay (AUTH-01 → D-01..D-05)

| Option | Description | Selected |
|---|---|---|
| Redis Streams (`XADD MAXLEN ~ 500`, `XRANGE` for replay, `XREAD BLOCK` for live tail) | Native monotonic ids, multi-replica safe, MAXLEN auto-trim, single source of truth for buffer + tail | ✓ |
| In-memory per-process ring buffer + existing pub/sub for live | Simplest code; fails the moment >1 API replica runs (different buffers per worker) — kills `Last-Event-ID` resume across reconnects routed to a different worker | |
| Redis LIST + atomic INCR counter | LPUSH/LRANGE works but needs custom monotonic-id source (extra INCR per event); no native time-windowed trim | |

**User's choice:** Redis Streams (auto-selected).
**Notes:** Existing `RedisEventPublisher` (`packages/queue/src/events.ts`) is the single touch point. Dual-publish (pub/sub + stream) keeps WS path unchanged. SSE `id:` field = Redis stream id verbatim. `replay_truncated` synthetic event emitted when `Last-Event-ID` falls outside the 500-event / 5-min window.

---

## Stream Token Reuse (AUTH-02 → D-06..D-07)

| Option | Description | Selected |
|---|---|---|
| Reuse `POST /api/v1/ws-token`, single token valid for either WS or SSE (single-use `GETDEL`, 60 s TTL) | Spec §3.3.2 explicitly says "endpoint name preserved" — no new route; no SDK breaking change | ✓ |
| New `POST /api/v1/sse-token` mirror endpoint | Two paths, two code paths, two OpenAPI surface bumps for zero behavioral gain | |
| Switch to short-lived signed JWT (no Redis round trip) | Requires new signing key infra; loses single-use property; spec says single-use | |

**User's choice:** Reuse `POST /api/v1/ws-token` (auto-selected).
**Notes:** Existing `GETDEL` consume pattern at `apps/api/src/server.ts:138` ports verbatim to SSE handler.

---

## CORS Wildcard Implementation (AUTH-03 → D-08..D-10)

| Option | Description | Selected |
|---|---|---|
| Hono `cors({ origin: (origin, c) => ... })` function form, pre-compile patterns at boot | Native Hono support; zero extra deps; per-request cost = single regex test | ✓ |
| Hand-roll CORS middleware replacing Hono's | Reinvents wheel; loses Hono's preflight handling | |
| Allow `*` for development | Spec disallows; rejected | |

**User's choice:** Hono `cors()` with origin function (auto-selected).
**Notes:** Wildcard syntax = exactly one subdomain label (`https://*.spatula.dev` → `^https:\/\/[^./]+\.spatula\.dev$`). Documented in `docs/api-auth.md`.

---

## Dex Local Recipe (AUTH-04, AUTH-08 → D-11..D-13)

| Option | Description | Selected |
|---|---|---|
| Full self-contained kit (`docker-compose.yml` + SQLite-storage Dex + browser smoke + M2M smoke) | Matches AUTH-04 + AUTH-08 acceptance in one example; `<10 s` boot | ✓ |
| Dex + curl-only walkthrough; no Playwright | AUTH-01 acceptance requires Playwright e2e — would need a second example | |
| Postgres-backed Dex | More "realistic" but slow boot; saved for Phase 20 cookbooks | |

**User's choice:** Full kit, SQLite storage (auto-selected).
**Notes:** Dev-only secrets committed; banner in `examples/auth-dex/README.md`.

---

## API Key Rotation Semantics (AUTH-05 → D-14..D-16)

| Option | Description | Selected |
|---|---|---|
| Two-key grace window, configurable 0..7 d, default 24 h | Matches AWS IAM rotation UX; zero-downtime by construction; scope inherited | ✓ |
| Immediate cutover (old key 401s instantly on rotate) | Forces atomic ops handoff; one slow client → outage | |
| Background-job-driven rotation with notification webhook | Over-engineered for v1; webhooks already cover key.rotated audit event | |

**User's choice:** Two-key grace window (auto-selected).
**Notes:** Cap = 7 d. Rotation cannot change scopes. Audit emits `api_key.rotated` with both ids.

---

## Cross-Tenant Isolation Audit (AUTH-07 → D-17..D-19)

| Option | Description | Selected |
|---|---|---|
| OpenAPI-driven table generator over every authed route (reuses Phase 16 contract harness) | Coverage guaranteed as routes are added; zero "we forgot this endpoint" failure mode | ✓ |
| Hand-written per-route isolation tests | Always falls behind; coverage rots | |
| Property-based fuzz over routes + tenants | Slow; can miss specific routes; deterministic seeding gives clearer failures | |

**User's choice:** OpenAPI-driven generator (auto-selected).
**Notes:** Status code policy = prefer `404` over `403` (don't confirm existence). Error envelope code asserted ∈ `{RESOURCE_NOT_FOUND, INSUFFICIENT_SCOPE, TENANT_MISMATCH}`.

---

## M2M OIDC client_credentials (AUTH-08 → D-20)

| Option | Description | Selected |
|---|---|---|
| Reuse Dex static-client with `grantTypes: [client_credentials]`; e2e drives full SDK chain | Single Dex container covers both browser code-flow + M2M; one example, two acceptance criteria | ✓ |
| Separate IdP (e.g., Hydra) for M2M | Two containers to maintain in `examples/`; no benefit | |

**User's choice:** Reuse Dex (auto-selected).
**Notes:** Test lives in `tests/e2e/m2m/`. Uses existing `JwtAuthProvider` JWKS path.

---

## Docs Scope (AUTH-06 → D-21)

| Option | Description | Selected |
|---|---|---|
| Single authoritative `docs/api-auth.md` with all subsections (auth strategies, scopes, tokens, CSRF, CORS, M2M) | One source of truth; CI gate against scope-table drift | ✓ |
| Split into `docs/auth.md`, `docs/cors.md`, `docs/scopes.md` | Three files, three places to fall out of sync | |

**User's choice:** Single `docs/api-auth.md` (auto-selected).
**Notes:** Auth0/Keycloak/Google Workspace cookbooks deferred to Phase 20 (DOCS-04, DOCS-09).

---

## Claude's Discretion

- Internal `apps/api/src/sse/` module layout (handler.ts + buffer.ts + types.ts)
- SSE handler implementation language (Hono `c.body(stream)` with `ReadableStream`)
- Test fixture reuse from Phase 16 contract harness

## Deferred Ideas

- WS deprecation (revisit v2)
- Stream-token via header instead of query (out of scope)
- Refresh-token rotation server-side (OIDC-only stance — IDP's job)
- JWKS hot-rotation explicit tests
- OIDC cookbooks (Phase 20)
- Reverse-proxy access-log token-masking runbook (Phase 19)
- Native email/password auth (DEFER-07 — out forever)
