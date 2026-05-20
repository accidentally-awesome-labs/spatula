---
phase: 17-browser-auth-sse-cors
plan: 02
subsystem: api-sse
tags: [sse, redis-streams, auth, streaming, dual-publish]
dependency_graph:
  requires: [17-01]
  provides: [SSE-endpoint, SSE-replay-buffer, SSE-stream-token, dual-publish]
  affects: [17-07-isolation-tests, apps/api/src/sse, packages/queue/src/events]
tech_stack:
  added: [hono/streaming streamSSE, Redis Streams XADD/XRANGE/XREAD BLOCK]
  patterns:
    - dual-publish pub/sub + XADD in independent try/catch blocks
    - dedicated ioredis connection per SSE client (XREAD BLOCK isolation)
    - exclusive lower bound XRANGE (id) for Last-Event-ID resume
    - auth-middleware skip-list + scope-guard exemption for EventSource-compatible auth
    - timeout middleware 0 = no-timeout sentinel for SSE connections
key_files:
  created:
    - packages/queue/src/events.ts (modified — dual-publish)
    - apps/api/src/sse/types.ts
    - apps/api/src/sse/buffer.ts
    - apps/api/src/sse/handler.ts
    - apps/api/src/routes/job-events.ts
    - apps/api/tests/sse/job-events.test.ts
    - apps/api/tests/sse/stream-token.test.ts
  modified:
    - packages/queue/tests/unit/events.test.ts
    - apps/api/src/app.ts
    - apps/api/src/middleware/auth.ts
    - apps/api/src/middleware/timeout.ts
    - apps/api/src/routes/ws-token.ts
    - apps/api/src/sse/handler.test.ts
decisions:
  - "XADD args use string '500' (not number 500) — RESEARCH Pitfall 4 runtime validation"
  - "Dedicated ioredis connection per SSE client (XREAD BLOCK monopolizes connection)"
  - "SSE route registered on main app (not sub-router) with full path /api/v1/jobs/{id}/events to appear in OpenAPI spec"
  - "Scope guard bypassed via SSE_PATH_RE regex wrapper (cleanest fix without restructuring existing guard chain)"
  - "timeout middleware 0 = no-timeout (explicit guard added: if (timeoutMs === 0) return next())"
  - "RESOURCE_NOT_FOUND required @spatula/core-types rebuild (dist was stale)"
metrics:
  duration_minutes: 21
  completed_date: "2026-05-20"
  tasks_completed: 3
  files_created_or_modified: 12
---

# Phase 17 Plan 02: SSE Infrastructure + Stream Token — Summary

**One-liner:** SSE endpoint at GET /api/v1/jobs/{id}/events with dual-publish (Redis pub/sub + XADD streams), Last-Event-ID XRANGE replay, XREAD BLOCK tail, GETDEL single-use token auth, and @hono/zod-openapi createRoute registration in OpenAPI spec.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Dual-publish to Redis Stream in RedisEventPublisher | c2f3b59 | packages/queue/src/events.ts, events.test.ts |
| 2 | Build SSE module — types, buffer, handler | f54d62a | apps/api/src/sse/*.ts, handler.test.ts |
| 3 | Register SSE createRoute, mount, fix auth+timeout | 5dfb16c | routes/job-events.ts, app.ts, auth.ts, timeout.ts, ws-token.ts, tests/sse/*.ts |

## Verification Evidence

- `pnpm --filter @spatula/queue test`: **17 test files, 146 tests — all pass**
- `pnpm --filter @spatula/api exec vitest run src/sse/ tests/sse/`: **3 test files, 23 tests — all pass**
- `pnpm --filter @spatula/api exec vitest run` (full suite): **55 test files, 414 tests — all pass** (no regression)
- `pnpm --filter @spatula/api build`: clean TypeScript compile (zero errors)
- SSE path appears in `/api/v1/openapi.json` at `paths['/api/v1/jobs/{id}/events']` with `operationId: streamJobEvents` — confirmed by integration test
- `X-Accel-Buffering: no` + `Content-Type: text/event-stream` + `Cache-Control: no-cache` set on SSE response — confirmed by integration test
- Token is single-use (GETDEL): second connect with same token returns 401 — confirmed by integration test
- Job-not-found for tenant returns 404 — confirmed by integration test
- SSE path bypasses `requireScope('jobs:read')` — confirmed by integration test
- Redis-backed integration tests (XRANGE exclusive bound, replay_truncated, keepalive) require a live Redis — noted as needing a running Redis for `src/sse/handler.test.ts` real-Redis path; unit-tested via fake redis in-memory implementation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocker] RESOURCE_NOT_FOUND code not in built dist**
- **Found during:** Task 3 — `error TS2339: Property 'RESOURCE_NOT_FOUND' does not exist`
- **Issue:** `@spatula/core-types` source had `RESOURCE_NOT_FOUND` but the `dist/` was stale (not rebuilt since Phase 17-01 added it)
- **Fix:** Rebuilt `@spatula/core-types` and `@spatula/shared` (`pnpm --filter @spatula/core-types build && pnpm --filter @spatula/shared build`)
- **Files modified:** packages/core-types/dist/, packages/shared/dist/ (built outputs)
- **Commit:** 5dfb16c (included in Task 3 commit)

**2. [Rule 1 - Bug] Hono scope guard intercepting SSE before handler runs**
- **Found during:** Task 3 — all SSE requests returning 403 from `requireScope('jobs:read')`
- **Issue:** `app.get('/api/v1/jobs/*', requireScope)` is a handler that runs for ALL GET requests matching that wildcard, even if a more specific route was registered first. The SSE path matched `/api/v1/jobs/*` and `c.get('auth')` was undefined (SSE path is on auth skip-list) causing `requireScope` to throw 403.
- **Fix:** Wrapped the wildcard scope guard with a `SSE_PATH_RE` regex check that calls `next()` for the SSE path (exemption pattern). The exemption is internal to app.ts and does not break any other routes.
- **Files modified:** apps/api/src/app.ts
- **Commit:** 5dfb16c

**3. [Rule 1 - Bug] SSE route registered on sub-router with relative path caused 404**
- **Found during:** Task 3 — after fixing the scope guard issue, SSE requests returned 404
- **Issue:** Initial approach used `app.route('/api/v1', jobEventsRoutes(deps))` with `createRoute({ path: '/jobs/{id}/events' })`. The sub-router mounting doubled the path. In Hono, the `app.request('/api/v1/jobs/id/events')` was not matched.
- **Fix:** Changed to `app.openapi(jobEventsRoute, handler)` on the main app with the full path `/api/v1/jobs/{id}/events`. The OpenAPI spec correctly includes the route at that full path (plan 17-07 reads `servers[0].url + path` to get the full URL).
- **Files modified:** apps/api/src/routes/job-events.ts, apps/api/src/app.ts
- **Commit:** 5dfb16c

**4. [Rule 2 - Missing functionality] `redis.eval` missing from mock — rate-limit middleware crash**
- **Found during:** Task 3 integration tests — all `POST /api/v1/ws-token` returning 500
- **Issue:** `rateLimitMiddleware` calls `redis.eval` (Lua script) for rate limiting. All test mock Redis objects were missing `eval`. The 500 was obscured by the generic error handler.
- **Fix:** Added `eval: vi.fn().mockResolvedValue([100, 50, Date.now() + 60000])` to all test mock redis objects in `job-events.test.ts` and `stream-token.test.ts`.
- **Files modified:** apps/api/tests/sse/job-events.test.ts, apps/api/tests/sse/stream-token.test.ts
- **Commit:** 5dfb16c

**5. [Rule 1 - Bug] Timeout middleware `0` not treated as "no-timeout"**
- **Found during:** Task 3 code review (plan requirement)
- **Issue:** `setTimeout(fn, 0)` fires immediately; without an explicit guard, setting `timeoutMs = 0` for the SSE path would terminate connections instantly.
- **Fix:** Added `if (timeoutMs === 0) return next()` guard before the `setTimeout` call in `timeout.ts`.
- **Files modified:** apps/api/src/middleware/timeout.ts
- **Commit:** 5dfb16c

### Out-of-Scope Deferred Items

None.

## Known Stubs

None — the SSE handler is fully wired. The XREAD BLOCK loop is live; the dedicated Redis connection is created. The keepalive timer runs at 15s intervals. No placeholder data flows to UI rendering.

## Self-Check: PASSED
