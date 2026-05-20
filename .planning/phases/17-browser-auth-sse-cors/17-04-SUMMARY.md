---
phase: 17-browser-auth-sse-cors
plan: "04"
subsystem: auth
tags: [api-keys, rotation, drizzle, hono, zod-openapi, audit, grace-window]

# Dependency graph
requires:
  - phase: 17-browser-auth-sse-cors
    provides: "api_keys.supersedes + superseded_expires_at columns (plan 17-01 migration)"

provides:
  - "ApiKeyRepository.rotate() — single Drizzle transaction: new key insert + old key grace-expire"
  - "POST /api/v1/api-keys/:id/rotate route with graceSeconds clamping, scope inheritance, audit"
  - "rotateApiKeyRequestSchema + apiKeyRotatedResponseSchema (D-16 shape)"
  - "14 tests: 6 repo TDD unit tests + 8 route integration tests"

affects:
  - "17-browser-auth-sse-cors plan 07 (isolation suite — new route in OpenAPI spec)"
  - "docs/api-auth.md — rotate endpoint should be referenced"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Zero-downtime key rotation via two-key grace window (AWS IAM rotation UX)"
    - "Repository receives only key material (hash+prefix), never the raw key"
    - "StorageError message text used for error-type discrimination in route handler"
    - "Auth middleware audit events coexist with route-level audit — filter by action field in tests"

key-files:
  created:
    - packages/db/tests/unit/repositories/api-key-repository-rotate.test.ts
    - apps/api/tests/routes/api-keys-rotate.test.ts
  modified:
    - packages/db/src/repositories/api-key-repository.ts
    - apps/api/src/schemas/api-key.ts
    - apps/api/src/routes/api-keys.ts

key-decisions:
  - "Schema graceSeconds has no .max(604800) — handler clamps silently so callers receive 200 not 400 for out-of-range values (D-14 'server-clamped')"
  - "RotateApiKeyInput interface exported from api-key-repository.ts for route-layer typing"
  - "rotateKeyRoute handler does not use @ts-expect-error — Hono infers return type cleanly"
  - "Audit test filters mock calls by action field because auth middleware also emits audit events on same spy"

patterns-established:
  - "Pattern: rotate() puts raw-key generation in the route handler, passes only hash+prefix to repo (raw key never enters DB layer)"
  - "Pattern: repo.rotate() stores supersededExpiresAt on the NEW row (not the old row) so D-16 response can be constructed without a second query"

requirements-completed: [AUTH-05]

# Metrics
duration: 7min
completed: "2026-05-20"
---

# Phase 17 Plan 04: API Key Rotation Summary

**Zero-downtime API key rotation via two-key grace window: `ApiKeyRepository.rotate()` transactional method + `POST /api/v1/api-keys/:id/rotate` with scope inheritance, server-clamped grace period, and `api_key.rotated` audit event**

## Performance

- **Duration:** 7 min
- **Started:** 2026-05-20T04:17:12Z
- **Completed:** 2026-05-20T04:24:00Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- `ApiKeyRepository.rotate()` opens a single Drizzle transaction: reads original row, inserts new key (scopes verbatim, `supersedes`+`supersededExpiresAt` set), grace-expires the old key via `expiresAt = now + graceSeconds`
- `POST /api/v1/api-keys/:id/rotate` route registered alongside create/list/revoke; clamps `graceSeconds` to `0..604800`, defaults to `86400`; emits `api_key.rotated` audit with both key ids
- D-16 response shape: `{ data: { id, key, keyPrefix, scopes, expiresAt, createdAt, supersedes, supersededExpiresAt } }` — raw key shown once
- 14 tests (6 repo TDD + 8 route integration) all passing; full suite 448 tests green

## Task Commits

1. **Task 1: ApiKeyRepository.rotate() — transactional new-key + grace-expire** - `151eded` (feat + test TDD)
2. **Task 2: POST /{id}/rotate route + schema + integration tests** - `70e5d2c` (feat)

## Files Created/Modified

- `packages/db/src/repositories/api-key-repository.ts` — Added `RotateApiKeyInput` interface and `rotate()` method (70 lines)
- `packages/db/tests/unit/repositories/api-key-repository-rotate.test.ts` — 6 TDD tests (new file)
- `apps/api/src/schemas/api-key.ts` — Added `rotateApiKeyRequestSchema` + `apiKeyRotatedResponseSchema`
- `apps/api/src/routes/api-keys.ts` — Added `rotateKeyRoute` definition and handler (80 lines)
- `apps/api/tests/routes/api-keys-rotate.test.ts` — 8 integration tests (new file)

## Decisions Made

- **graceSeconds schema has no `.max(604800)`** — the plan spec says "server-clamped" which means values above the cap should be accepted and silently reduced, not rejected with 400. The handler clamps via `Math.min(Math.max(...), 604800)`. Schema only enforces `.min(0)`.
- **`RotateApiKeyInput` interface exported** — reused by the route handler for typing the `newKeyMaterial` argument.
- **No `@ts-expect-error` on `rotateKeyRoute`** — Hono's type inference resolves cleanly for the rotate handler (unlike `revokeKeyRoute` which needed it).
- **Audit test filters by `action` field** — `authMiddleware` emits its own audit events on the same `auditLogger.log` spy; filtering for `action === 'api_key.rotated'` is robust against any number of middleware audit emissions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed `.max(604800)` from `rotateApiKeyRequestSchema`**
- **Found during:** Task 2 (route integration tests — clamping test returned 400 not 200)
- **Issue:** Schema with `.max(604800)` rejected `graceSeconds: 700000` at Zod validation, returning 400 before the handler could clamp it — contradicting the plan's "server-clamped" behavior specification
- **Fix:** Removed `.max(604800)` from the Zod schema; added comment noting values above cap are server-clamped in the handler (D-14)
- **Files modified:** `apps/api/src/schemas/api-key.ts`
- **Verification:** Clamping test now passes (200 response with `supersededExpiresAt` ~7 days out)
- **Committed in:** `70e5d2c` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — schema/behavior mismatch)
**Impact on plan:** Schema intent preserved (soft enforcement via handler clamp); caller UX improved (no spurious 400 for slightly-out-of-range values).

## Issues Encountered

- Auth middleware emits audit events on the same `auditLogger.log` spy — needed to filter by `action` field in the audit test rather than asserting `toHaveBeenCalledOnce()`.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `POST /api/v1/api-keys/:id/rotate` is live and tested; AUTH-05 complete
- The route appears in the OpenAPI spec (`/api/v1/api-keys/{id}/rotate`) — plan 17-07 (isolation suite) will pick it up automatically
- `docs/api-auth.md` may want a section on rotation UX (grace window, two-key overlap) — deferred to plan 17-06 (docs)

---
*Phase: 17-browser-auth-sse-cors*
*Completed: 2026-05-20*
