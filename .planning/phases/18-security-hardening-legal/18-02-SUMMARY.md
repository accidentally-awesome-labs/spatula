---
phase: 18-security-hardening-legal
plan: 02
subsystem: security
tags: [pino, sentry, opentelemetry, redaction, logging, secrets, jwt, stripe, bearer-token]

# Dependency graph
requires:
  - phase: 18-security-hardening-legal/18-01
    provides: Phase 18 foundation (prompt-injection defense, adversarial suite)
provides:
  - Shared redactor module in @spatula/shared with 6 secret pattern regexes
  - redactValue, redactObject, REDACT_PATHS, REDACTED_PLACEHOLDER, redactSentryEvent, RedactionSpanProcessor
  - pino createLogger wired with redact paths + redactObject formatters.log + err serializer
  - Sentry initSentry wired with beforeSend (redactSentryEvent) + beforeSendSpan (per-key redactValue)
  - OTel initTracing with RedactionSpanProcessor registered before BatchSpanProcessor
  - 4 independent per-sink test files (stdout, file, sentry, otel) in tests/shared/redaction/
  - tests/vitest.config.ts extended with shared/**/*.test.ts glob + pino alias
affects:
  - phase 18-04 (forensic endpoint — must not log raw HTML secrets)
  - phase 18-03 (DSR cascade — audit log redaction pattern established here)
  - any future phase that modifies logger.ts, sentry.ts, or tracing.ts

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-layer redaction: pino fast-redact paths (structural) + redactObject serializer (value scan backstop)"
    - "Single shared redactor module (D-12): one source of truth, all sinks import from redactor.ts"
    - "Canary-based per-sink testing: fixed set of 4 canary secrets (JWT/sk-/Bearer/Stripe) verified absent in each sink independently"
    - "OTel attribute mutation via onEnd cast-to-any: established community pattern for redaction processors"
    - "Sentry beforeSend + beforeSendSpan both wired; beforeSend covers events, beforeSendSpan covers spans"

key-files:
  created:
    - packages/shared/src/redactor.ts
    - packages/shared/src/redactor.test.ts
    - tests/shared/redaction/stdout.test.ts
    - tests/shared/redaction/file.test.ts
    - tests/shared/redaction/sentry.test.ts
    - tests/shared/redaction/otel.test.ts
  modified:
    - packages/shared/src/index.ts
    - packages/shared/src/logger.ts
    - packages/shared/src/sentry.ts
    - packages/shared/src/tracing.ts
    - tests/vitest.config.ts

key-decisions:
  - "Import SpanProcessor/Span/ReadableSpan from @opentelemetry/sdk-trace-node (re-exports from sdk-trace-base) rather than sdk-trace-base directly — sdk-trace-base is not a direct dependency of @spatula/shared"
  - "tests/vitest.config.ts converted from relative to absolute includes (tests/e2e/** → tests/shared/**) to match pattern of other test configs; pino alias added pointing to shared package's pino copy"
  - "redactObject uses recursive deep-clone (not mutation) — required since formatters.log receives the live log object; mutation would corrupt pino's internal state"
  - "RedactionSpanProcessor casts span.attributes to Record<string,unknown> for mutation — TypeScript-only ReadableSpan is typed read-only but underlying Span object IS mutable at runtime"

patterns-established:
  - "Per-sink canary testing: tests/shared/redaction/*.test.ts — each file verifies ONE sink in isolation with fixed canary secrets"
  - "Barrel export pattern: all redactor.ts exports surfaced through packages/shared/src/index.ts"

requirements-completed: [SEC-06]

# Metrics
duration: 15min
completed: 2026-05-20
---

# Phase 18 Plan 02: Shared Redactor + Per-Sink Secret Redaction Summary

**Single shared redactor module wired into all 4 log sinks (pino stdout/file, Sentry, OTel) with per-sink canary test suite proving no JWT/API-key/Bearer/Stripe secrets ever reach any sink output.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-20T11:50:00Z
- **Completed:** 2026-05-20T15:58:23Z
- **Tasks:** 3 (Task 1 TDD + Task 2 + Task 3)
- **Files modified:** 10 (4 created net-new + 6 modified)

## Accomplishments

- Built `packages/shared/src/redactor.ts` as the single redaction source of truth (D-12): 6 secret patterns (sk- keys, Bearer tokens, 3-segment JWTs, sk_live_, sk_test_, or- prefix), `redactValue`, `redactObject`, `REDACT_PATHS`, `REDACTED_PLACEHOLDER`, `redactSentryEvent`, `RedactionSpanProcessor` — all exported from the shared barrel
- Wired `createLogger` (pino) with both `redact.paths` for structural fast-redact AND `formatters.log = redactObject` backstop for unknown nesting depths (D-11 two-layer pattern), plus `err.message` serializer scanning
- Wired Sentry `initSentry` with `beforeSend → redactSentryEvent` (scrubs exception values, message, extra, contexts) and `beforeSendSpan` (scrubs per-span data string values)
- Wired OTel `initTracing` with `RedactionSpanProcessor` registered before `BatchSpanProcessor` so spans are scrubbed pre-export
- Created 4 independent per-sink test files (25 tests total) each independently proving all 4 canary secrets absent from that sink's output

## Task Commits

Each task was committed atomically:

1. **Task 1: Shared redactor module + unit tests** - `28d29e0` (feat)
2. **Task 2: Wire redactor into pino logger + OTel span processor** - `a23aaab` (feat)
3. **Task 3: Wire redactor into Sentry + per-sink redaction test suite** - `b1bf3c0` (feat)

**Plan metadata:** (docs commit below)

_Note: Task 1 was TDD — tests written first (RED), then implementation (GREEN); no separate refactor commit needed._

## Files Created/Modified

- `packages/shared/src/redactor.ts` — Core redactor: 6 secret patterns + redactValue/redactObject/REDACT_PATHS/REDACTED_PLACEHOLDER + redactSentryEvent + RedactionSpanProcessor
- `packages/shared/src/redactor.test.ts` — 25 unit tests (TDD): per-pattern positive + clean cases, nested/array/null objects, non-mutation guard
- `packages/shared/src/index.ts` — Added barrel exports for all 6 redactor.ts exports
- `packages/shared/src/logger.ts` — Added redact option + formatters.log + err serializer to createLogger
- `packages/shared/src/sentry.ts` — Added beforeSend + beforeSendSpan hooks to initSentry
- `packages/shared/src/tracing.ts` — Added RedactionSpanProcessor before BatchSpanProcessor in initTracing
- `tests/shared/redaction/stdout.test.ts` — Per-sink test (pino → in-memory Writable stream), 6 tests
- `tests/shared/redaction/file.test.ts` — Per-sink test (pino → temp file with cleanup), 5 tests
- `tests/shared/redaction/sentry.test.ts` — Per-sink test (redactSentryEvent), 6 tests
- `tests/shared/redaction/otel.test.ts` — Per-sink test (RedactionSpanProcessor.onEnd), 8 tests
- `tests/vitest.config.ts` — Extended include glob to `tests/shared/**/*.test.ts`; added pino alias

## Decisions Made

- **Import from sdk-trace-node not sdk-trace-base**: `@opentelemetry/sdk-trace-base` is not a direct dep of `@spatula/shared`; `sdk-trace-node` re-exports all the same types including `SpanProcessor`, `Span`, `ReadableSpan`. Importing from the available package avoids adding a new direct dependency.
- **pino alias in tests/vitest.config.ts**: pino is not hoisted to the workspace root (monorepo isolation), so tests in `tests/shared/redaction/` cannot `import pino` without an alias. Added alias pointing to `packages/shared/node_modules/pino/pino.js` — mirrors the carry-forward pattern from Phase 15/16 for similar root-level test-only concerns.
- **tests/vitest.config.ts converted to absolute include paths**: The original config used relative paths (`e2e/**/*.test.ts`) which only worked when `cd tests/` before running. Changed to `tests/e2e/**/*.test.ts` + `tests/shared/**/*.test.ts` to match the pattern of every other test config in the repo.
- **redactObject deep-clones before walking**: `formatters.log` receives the live pino log object; mutating it in-place would corrupt pino's internal state. The recursive clone ensures the original object is never modified.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Import @opentelemetry/sdk-trace-node instead of sdk-trace-base**
- **Found during:** Task 2 (build step)
- **Issue:** `tsc` error TS2307 — `@opentelemetry/sdk-trace-base` cannot be found; it's an indirect dep (via sdk-trace-node) but not a direct dep of @spatula/shared
- **Fix:** Changed import in `redactor.ts` to use `@opentelemetry/sdk-trace-node` which re-exports all the required types (`SpanProcessor`, `Span`, `ReadableSpan`)
- **Files modified:** `packages/shared/src/redactor.ts`
- **Verification:** `pnpm --filter @spatula/shared build` exits 0
- **Committed in:** `a23aaab` (Task 2 commit)

**2. [Rule 3 - Blocking] Fixed Sentry type cast for redactSentryEvent**
- **Found during:** Task 3 (build step)
- **Issue:** `tsc` error TS2352 — Sentry's `ErrorEvent` type doesn't overlap sufficiently with `Record<string, unknown>` for a single cast
- **Fix:** Used double cast (`as unknown as typeof event`) to bridge the type gap safely
- **Files modified:** `packages/shared/src/sentry.ts`
- **Verification:** `pnpm --filter @spatula/shared build` exits 0
- **Committed in:** `b1bf3c0` (Task 3 commit)

**3. [Rule 3 - Blocking] Fixed tests/vitest.config.ts for root-relative execution**
- **Found during:** Task 3 (test execution step)
- **Issue:** Original `include: ['e2e/**/*.test.ts']` and relative `__dirname` alias resolved incorrectly when running `pnpm exec vitest run --config tests/vitest.config.ts` from project root; tests weren't found
- **Fix:** Converted to absolute-from-project-root includes (`tests/e2e/**/*.test.ts`, `tests/shared/**/*.test.ts`) and added `const root = resolve(__dirname, '..')` to properly resolve aliases from any CWD
- **Files modified:** `tests/vitest.config.ts`
- **Verification:** All 4 sink test files found and 25 tests pass
- **Committed in:** `b1bf3c0` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (all Rule 3 — blocking issues)
**Impact on plan:** All fixes necessary for compilation and test execution. No scope creep.

## Issues Encountered

None beyond the 3 auto-fixed blocking issues above.

## User Setup Required

None — no external service configuration required. All secrets are redacted at the sink level; no new env vars or dashboard config needed.

## Next Phase Readiness

- SEC-06 fully satisfied: one shared redactor, all 4 sinks wired, per-sink tests independently prove no raw secret reaches any sink
- `redactSentryEvent` and `RedactionSpanProcessor` are available via `@spatula/shared` barrel for any future phase needing additional sink coverage
- Phase 18-03 (DSR cascade) can use `createLogger` knowing all log output from the delete worker is already redacted
- Phase 18-04 (forensic endpoint) can log safely knowing any accidentally-logged forensic content is scrubbed before reaching Sentry/OTel

## Known Stubs

None — all exports are fully implemented and verified.

---
*Phase: 18-security-hardening-legal*
*Completed: 2026-05-20*
