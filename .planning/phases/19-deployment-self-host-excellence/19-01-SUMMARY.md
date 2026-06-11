---
phase: 19-deployment-self-host-excellence
plan: "01"
subsystem: infra
tags: [bullmq, queue, worker, embedded, bootstrap, process-lifecycle, ioredis]

requires:
  - phase: 18-security-hardening-legal
    provides: Final OSS codebase state, full queue worker, full API server

provides:
  - "startWorker() export from @spatula/queue with WorkerHandle { shutdown() } — no process.exit in its path"
  - "Direct-execution guard (import.meta.url === pathToFileURL) so barrel import does not spawn standalone worker"
  - "apps/api/src/embedded-worker.ts — SPATULA_EMBEDDED_WORKER=1 flag-gated shim with injectable factory"
  - "apps/api/src/main.ts — real prod bootstrap composing full AppDeps, calling startServer(), conditionally co-hosting worker"
  - "dist/main.js as the CMD/startCommand target for all downstream deployment plans"

affects: [19-02, 19-05, deployment-distroless, deployment-render]

tech-stack:
  added: []
  patterns:
    - "Worker lifecycle split: startWorker() returns WorkerHandle (no exit), main() thin wrapper adds signal handlers + exit"
    - "Direct-execution guard via import.meta.url === pathToFileURL(process.argv[1]).href prevents side-effects on barrel import"
    - "Injectable factory pattern for embedded-worker shim makes unit tests possible without real BullMQ connections"
    - "process.prependListener for embedded worker drain before API shutdown — ensures jobs drain before DB pool closes"

key-files:
  created:
    - packages/queue/src/worker-entrypoint.ts (refactored — adds startWorker export + pathToFileURL guard)
    - packages/queue/tests/unit/worker-entrypoint.test.ts
    - apps/api/src/embedded-worker.ts
    - apps/api/src/embedded-worker.test.ts
    - apps/api/src/main.ts
  modified:
    - packages/queue/src/index.ts (added startWorker + WorkerHandle barrel exports)
    - apps/api/package.json (added "start": "node dist/main.js")

key-decisions:
  - "startWorker() body captures shutdown closure without process.exit; only main() wrapper calls process.exit — clean separation of lifecycle vs. process management"
  - "Direct-execution guard uses pathToFileURL (node:url) so importing for startWorker never spawns standalone worker as side-effect"
  - "Injectable factory in startEmbeddedWorker() keeps unit tests isolated from real BullMQ — real import('@spatula/queue') happens lazily only when flag is set"
  - "process.prependListener used for embedded worker drain so it fires before API's own SIGTERM handler (which closes the DB pool)"
  - "dist/main.js is the deployment target — dist/index.js remains the library barrel for programmatic import by other packages"

requirements-completed: [DEPLOY-02]

duration: 7min
completed: "2026-06-10"
---

# Phase 19 Plan 01: Worker Lifecycle Export + API Bootstrap Summary

**`startWorker()` lifecycle export from `@spatula/queue` + real `apps/api/src/main.ts` bootstrap that composes AppDeps and optionally co-hosts the BullMQ worker in-process via `SPATULA_EMBEDDED_WORKER=1`**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-06-10T17:28:35Z
- **Completed:** 2026-06-10T17:35:55Z
- **Tasks:** 2 (both TDD)
- **Files modified:** 7

## Accomplishments

- Refactored `worker-entrypoint.ts` so the worker lifecycle lives in exported `startWorker()` with a `WorkerHandle { shutdown() }` return — no `process.exit` in its path; `main()` becomes a thin standalone wrapper that retains signal handlers + exit
- Added `pathToFileURL` direct-execution guard so importing the module for `startWorker` never triggers the standalone `main()` as a side-effect
- Created `apps/api/src/embedded-worker.ts` shim gated on `SPATULA_EMBEDDED_WORKER=1` with an injectable factory for clean unit-testing
- Created `apps/api/src/main.ts` — the first real API production bootstrap; composes full `AppDeps` (DB, repos, Redis, queues, content-store, auth, audit), starts the HTTP server, and wires the embedded worker's `shutdown()` BEFORE the API's own signal path via `process.prependListener`

## Task Commits

Each task was committed atomically:

1. **Task 1: Refactor worker-entrypoint to export startWorker() lifecycle handle** - `280db73` (feat + test)
2. **Task 2: API standalone bootstrap (main.ts) + embedded-worker shim** - `4d365fd` (feat + test)

## Files Created/Modified

- `packages/queue/src/worker-entrypoint.ts` — Added `startWorker()` export + `WorkerHandle` interface + `pathToFileURL` direct-execution guard; `main()` reduced to thin wrapper
- `packages/queue/src/index.ts` — Added `startWorker` and `WorkerHandle` barrel exports
- `packages/queue/tests/unit/worker-entrypoint.test.ts` — 3 TDD tests: resolves handle, shutdown no-exit, signal handlers present
- `apps/api/src/embedded-worker.ts` — `startEmbeddedWorker(factory?)` gated on `SPATULA_EMBEDDED_WORKER=1`; injectable factory for testability
- `apps/api/src/embedded-worker.test.ts` — 4 TDD tests: flag-off null, non-"1" null, flag-on calls factory once, handle shutdown invokable
- `apps/api/src/main.ts` — Real prod bootstrap: `buildAppDeps()` + `startServer()` + optional `startEmbeddedWorker()` with prependListener drain
- `apps/api/package.json` — Added `"start": "node dist/main.js"` convenience script

## Decisions Made

- `process.prependListener` used for the embedded worker drain (vs. `process.on`) — ensures the worker flushes in-flight jobs before `executeShutdown` closes the DB pool
- Injectable factory (`startWorkerFn?` parameter) on `startEmbeddedWorker` avoids real BullMQ/Redis connections in unit tests while letting production default lazily import from `@spatula/queue`
- TypeScript type error in `S3_ENDPOINT` config: `getEnvOrDefault` requires a `string` default — fixed by using spread + `process.env.S3_ENDPOINT` conditional instead

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript type error: getEnvOrDefault requires string default, not undefined**

- **Found during:** Task 2 (main.ts bootstrap creation)
- **Issue:** Plan's S3 config snippet used `getEnvOrDefault('S3_ENDPOINT', undefined)` but `getEnvOrDefault` signature is `(key: string, defaultValue: string): string` — tsc error on build
- **Fix:** Replaced with `...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {})` conditional spread, which correctly omits the field when unset
- **Files modified:** `apps/api/src/main.ts`
- **Verification:** `pnpm --filter @spatula/api build` exits 0 after fix
- **Committed in:** `4d365fd` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — type mismatch bug in plan snippet)
**Impact on plan:** Minor fix to plan-provided code snippet; no scope change.

## Issues Encountered

None beyond the auto-fixed type error above.

## User Setup Required

None — no external service configuration required for this plan.

## Next Phase Readiness

- Plan 02 (distroless image): `apps/api/dist/main.js` is now the correct `CMD` target instead of `dist/index.js`
- Plan 05 (Render blueprint): `startCommand: node dist/main.js` and `SPATULA_EMBEDDED_WORKER=1` env var is the single-service pattern
- All downstream plans can import `startWorker` from `@spatula/queue` for embedded use without standalone process.exit side-effects

---

_Phase: 19-deployment-self-host-excellence_
_Completed: 2026-06-10_

## Self-Check: PASSED

- packages/queue/src/worker-entrypoint.ts: FOUND
- packages/queue/src/index.ts: FOUND
- packages/queue/tests/unit/worker-entrypoint.test.ts: FOUND
- apps/api/src/embedded-worker.ts: FOUND
- apps/api/src/embedded-worker.test.ts: FOUND
- apps/api/src/main.ts: FOUND
- apps/api/dist/main.js: FOUND
- Commit 280db73: FOUND
- Commit 4d365fd: FOUND
