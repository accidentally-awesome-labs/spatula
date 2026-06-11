---
phase: 17-browser-auth-sse-cors
plan: 03
subsystem: auth
tags: [cors, hono, wildcard-origin, api-key, jwt, sse, documentation, ci-gate]

# Dependency graph
requires:
  - phase: 17-browser-auth-sse-cors
    plan: 01
    provides: 'Test scaffolding (tests/cors/.gitkeep, tests/docs/.gitkeep)'

provides:
  - 'apps/api/src/lib/cors-origin.ts: buildOriginMatcher() — parses CORS_ALLOWED_ORIGINS into exact set + single-label wildcard regexes using [^./]+ for suffix-attack prevention'
  - 'apps/api/src/app.ts: function-form CORS origin using buildOriginMatcher; CORS_CONFIG_INVALID boot-fail; extended exposeHeaders (X-RateLimit-Reset + Retry-After)'
  - 'apps/api/tests/cors/origin-matrix.test.ts: 8-case request matrix integration test (exact, wildcard, two-label reject, suffix-attack reject, unlisted, exposeHeaders, max-age, boot-fail)'
  - 'docs/api-auth.md: authoritative auth+scope+CORS documentation (8 sections, D-21)'
  - 'apps/api/tests/docs/api-auth-scope-sync.test.ts: CI gate — doc scope table vs AUTH_SCOPES source of truth'

affects: [17-05, 17-07, 20-docs, any-phase-referencing-CORS-config]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - 'CORS function-form origin: parse CORS_ALLOWED_ORIGINS once at boot into exact Set + RegExp[] rather than passing string array to cors()'
    - 'Single-label wildcard regex: [^./]+ substitution for * — prevents both multi-label (foo.bar.domain.com) and suffix attacks (evil.domain.com.attacker.com)'
    - 'Boot-time panic for misconfiguration: throw plain Error (not SpatulaError) before any HTTP handling begins'
    - 'SCOPE_TABLE_START/END HTML comment markers for CI gate parsing'

key-files:
  created:
    - apps/api/src/lib/cors-origin.ts
    - apps/api/src/lib/cors-origin.test.ts
    - apps/api/tests/cors/origin-matrix.test.ts
    - docs/api-auth.md
    - apps/api/tests/docs/api-auth-scope-sync.test.ts
  modified:
    - apps/api/src/app.ts

key-decisions:
  - 'buildOriginMatcher returns null (not throws) on bad config; caller throws Error — keeps the helper pure and testable'
  - "Single-label wildcard: escape * first (include in metachar set), then replace \\* with [^./]+ — both steps are required; omitting * from the escape set was the root cause of the initial failing test"
  - 'Scope-table CI gate reads doc via filesystem (readFileSync) not HTTP — decouples from server boot; test is plain Vitest unit test'
  - 'import.meta.dirname used for monorepo root resolution in CI gate — avoids __dirname issues in ESM'

patterns-established:
  - 'CORS origin matcher: function-form origin in Hono cors() is the correct pattern for dynamic matching'
  - 'CI doc-sync gate: HTML comment markers delimit table region; first backtick-quoted column cell is the scope name'

requirements-completed: [AUTH-03, AUTH-06]

# Metrics
duration: 15min
completed: 2026-05-20
---

# Phase 17 Plan 03: CORS Wildcard + Auth Docs Summary

**Hono CORS upgraded to function-form with single-label wildcard regex, boot-time misconfiguration panic, and authoritative docs/api-auth.md with CI scope-sync gate (26 new tests)**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-20T00:09:00Z
- **Completed:** 2026-05-20T00:14:00Z
- **Tasks:** 3 completed
- **Files modified:** 6 (5 created, 1 modified)

## Accomplishments

- Replaced `origin: string[]` CORS config with a function-form matcher built on `buildOriginMatcher()` — supports exact origins and `https://*.domain.com` single-label wildcards, rejects multi-label and suffix-attack origins
- Extended `exposeHeaders` to include `X-RateLimit-Reset` and `Retry-After` (D-09); added `CORS_CONFIG_INVALID` boot-time panic on empty or bare-`*` config (D-10)
- Wrote `docs/api-auth.md` — 8 sections covering all auth strategies, full 9-scope catalog with CI-parseable markers, rotation grace window (86400s / 604800s cap), refresh-token IDP clause, CSRF N/A rationale, stream tokens, CORS format, M2M client_credentials
- Created a CI sync gate (`api-auth-scope-sync.test.ts`) that fails if the doc scope table drifts from `AUTH_SCOPES` in code

## Task Commits

1. **Task 1: CORS origin matcher + app.ts rewrite** - `404c364` (feat + TDD)
2. **Task 2: CORS request-matrix integration test** - `5d798c3` (test)
3. **Task 3: docs/api-auth.md + scope sync CI gate** - `5b6791c` (feat)

## Files Created/Modified

- `apps/api/src/lib/cors-origin.ts` — `buildOriginMatcher()` with [^./]+ wildcard regex; returns null on empty/bare-`*` config
- `apps/api/src/lib/cors-origin.test.ts` — 14 unit tests (exact, wildcard, security boundaries, null paths)
- `apps/api/src/app.ts` — CORS block rewritten: function-form origin, CORS_CONFIG_INVALID throw, exposeHeaders extended
- `apps/api/tests/cors/origin-matrix.test.ts` — 8 integration tests against createApp() with injected env
- `docs/api-auth.md` — Authoritative auth documentation (8 sections, D-21 compliant)
- `apps/api/tests/docs/api-auth-scope-sync.test.ts` — CI gate: doc scope table vs AUTH_SCOPES (4 assertions)

## Decisions Made

- **Escape `*` in metachar set before replacing**: The initial implementation omitted `*` from the `.replace(/[.+?^${}()|[\]\\]/g, ...)` character class. Since `*` was unescaped, the replace step `replace('\\*', '[^./]+')` found no match and the wildcard was left as a regex quantifier (`*` = zero-or-more of preceding), causing `https://app.spatula.dev` to not match. Fix: include `*` in the escape set (`/[*+.?^${}()|[\]\\]/g`), then replace the resulting `\*` with `[^./]+`.
- **plain Error, not SpatulaError, for boot-fail**: CORS_CONFIG_INVALID is not an HTTP response — it's a process startup error. Using a plain `Error` (not `SpatulaError`) keeps the boot error out of the HTTP error envelope machinery.
- **`buildOriginMatcher` returns null vs throws**: By returning null instead of throwing, the helper stays pure and is trivially testable for the null case. The caller (`createApp`) is responsible for the throw — consistent with the "validate config at the boundary" pattern.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Regex metachar set missing `*` — wildcard tests failing**

- **Found during:** Task 1 (TDD GREEN phase)
- **Issue:** The escape regex `/[.+?^${}()|[\]\\]/g` did not include `*`. When `https://*.spatula.dev` was processed, the `*` character was left raw in the string. The subsequent `replace('\\*', '[^./]+')` found no `\*` to replace — so the pattern remained `https://*.spatula.dev` (with a raw `*`), which in a regex means "zero or more `/`", causing `https://app.spatula.dev` to not match.
- **Fix:** Added `*` to the escape character class: `/[*+.?^${}()|[\]\\]/g`. After this, `*` is escaped to `\*` and then correctly replaced with `[^./]+`.
- **Files modified:** `apps/api/src/lib/cors-origin.ts`
- **Verification:** `pnpm --filter @spatula/api exec vitest run src/lib/cors-origin.test.ts` — 14/14 pass
- **Committed in:** `404c364` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — Bug)
**Impact on plan:** Required fix for correctness of the core wildcard regex. Caught by TDD RED→GREEN cycle exactly as intended.

## Issues Encountered

None beyond the wildcard regex bug above (caught in TDD cycle, resolved inline).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- AUTH-03 and AUTH-06 complete: CORS and auth documentation are ready
- `docs/api-auth.md` is the authoritative reference for Phase 17 onward
- CI scope-sync gate is wired in `pnpm --filter @spatula/api exec vitest run tests/docs/`
- Plans 17-04 (API key rotation) and 17-07 (isolation audit) can proceed independently

---

_Phase: 17-browser-auth-sse-cors_
_Completed: 2026-05-20_

## Self-Check: PASSED

- FOUND: apps/api/src/lib/cors-origin.ts
- FOUND: apps/api/src/lib/cors-origin.test.ts
- FOUND: apps/api/tests/cors/origin-matrix.test.ts
- FOUND: docs/api-auth.md
- FOUND: apps/api/tests/docs/api-auth-scope-sync.test.ts
- FOUND: .planning/phases/17-browser-auth-sse-cors/17-03-SUMMARY.md
- FOUND commit: 404c364 (Task 1 — cors-origin.ts + app.ts)
- FOUND commit: 5d798c3 (Task 2 — origin-matrix.test.ts)
- FOUND commit: 5b6791c (Task 3 — api-auth.md + scope-sync gate)
