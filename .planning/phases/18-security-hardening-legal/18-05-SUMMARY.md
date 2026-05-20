---
phase: 18-security-hardening-legal
plan: 05
subsystem: security / forensic-provenance
tags: [forensic, dlq, content-store, admin-api, sdk, openapi, experimental]
dependency_graph:
  requires: [18-01, 18-02]
  provides: [forensic-archiver, admin-forensic-endpoint, sdk-experimental-forensic]
  affects: [packages/core, apps/api, packages/client, packages/shared]
tech_stack:
  added: []
  patterns:
    - Forensic blob archival under forensic/ key prefix in ContentStore
    - suspicious_extraction DLQ record with metadata-only payload (no raw HTML)
    - OpenAPIHono createRoute with x-spatula-experimental extension
    - Proxy-based experimental namespace with one live surface (forensic)
key_files:
  created:
    - packages/core/src/extraction/forensic-archiver.ts
    - packages/core/src/extraction/forensic-archiver.test.ts
    - apps/api/src/routes/admin-forensic.ts
    - apps/api/src/routes/admin-forensic.test.ts
    - packages/shared/src/auth/types.test.ts
    - packages/client/src/experimental/forensic.ts
    - packages/client/src/experimental/forensic.test.ts
  modified:
    - packages/core/src/extraction/static-extractor.ts
    - packages/core/src/extraction/index.ts
    - packages/core/src/index.ts
    - apps/api/src/app.ts
    - packages/shared/src/auth/types.ts
    - packages/client/src/experimental/index.ts
    - packages/client/src/client.ts
    - packages/client/tests/unit/experimental-namespace.test.ts
    - docs/api-auth.md
decisions:
  - forensic-archiver uses injected dlqWriter structural interface to avoid @spatula/core importing @spatula/db
  - DLQ payload carries only metadata (extractionId, forensicRef, reason, scanFlags) — never raw HTML
  - Forensic endpoint reads suspicious_extraction DLQ records via dlqRepo.findUnresolved — no ContentStore listing required
  - admin:forensic:read scope mounted inside existing /api/v1/admin/* requireScope('admin') guard — callers need admin superset or admin:forensic:read AND admin
  - Offset-based cursor (base64url-encoded JSON) for forensic pagination — DLQ findUnresolved already supports limit/offset
  - createExperimentalNamespace now accepts transport parameter; forensic surface lazily initialized on first access
metrics:
  duration: 16 minutes
  completed_date: 2026-05-20
  tasks: 3
  files: 16
---

# Phase 18 Plan 05: Forensic Provenance + Experimental SDK Surface Summary

Forensic provenance wired end-to-end: suspicious extractions and off-schema retries archive raw HTML under `forensic/` key prefix in the ContentStore and write a `suspicious_extraction` DLQ entry (metadata only — no raw HTML in DLQ payload). The `GET /api/v1/admin/forensic/extractions` endpoint returns forensic records with 15-minute signed-URL contentRefs and cursor-first pagination, guarded by the new `admin:forensic:read` scope (tagged `x-spatula-experimental: true` in OpenAPI). The SDK exposes this surface via `client.experimental.forensic.listExtractions()`.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Forensic archiver + StaticExtractor wiring | 1a42073 | forensic-archiver.ts, forensic-archiver.test.ts, static-extractor.ts, extraction/index.ts, core/index.ts |
| 2 | admin:forensic:read scope + forensic endpoint + OpenAPI experimental | adb17dc | admin-forensic.ts, admin-forensic.test.ts, auth/types.ts, auth/types.test.ts, app.ts, api-auth.md |
| 3 | SDK client.experimental.forensic.* surface | df76455 | forensic.ts, forensic.test.ts, experimental/index.ts, client.ts, experimental-namespace.test.ts |

## Verification Results

- `pnpm --filter @spatula/core run test` — 94 passed, 1 skipped (1025 assertions)
- `pnpm --filter @spatula/api run test` — 60 passed (454 assertions)
- `pnpm --filter @spatula/client run test` — 6 passed (46 assertions)
- `pnpm --filter @spatula/core build` — exits 0
- `pnpm --filter @spatula/api build` — exits 0
- `pnpm --filter @spatula/client build` — exits 0

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated stale experimental-namespace test**
- **Found during:** Task 3 (GREEN phase)
- **Issue:** `tests/unit/experimental-namespace.test.ts` checked for error message `/zero experimental surfaces/` — a literal string from the old v1.0 "empty namespace" implementation. Plan 18-05 explicitly ships one experimental surface (forensic), changing the error message.
- **Fix:** Updated test to assert `toThrow(/not available/)` and added test case confirming `forensic` prop does NOT throw.
- **Files modified:** `packages/client/tests/unit/experimental-namespace.test.ts`
- **Commit:** df76455

### Design Decisions Made During Execution

**admin:forensic:read scope placement:** The existing `/api/v1/admin/*` wildcard guard uses `requireScope('admin')`. Forensic routes are mounted INSIDE that guard, meaning callers need `admin` scope (the inner `requireScope('admin:forensic:read')` then passes via the superset check). A caller with ONLY `admin:forensic:read` and not `admin` would be rejected by the outer guard. This matches the plan's "admin-only, least-privilege" intent from Open Question 3 — the forensic endpoint is strictly admin-tier.

**Forensic endpoint data source:** The plan says "reads forensic blobs by iterating content-store keys under the `forensic/` prefix". The `ContentStore` interface has no `listKeys` method. Implemented via `dlqRepo.findUnresolved({ queueName: 'suspicious_extraction', tenantId })` instead — the DLQ records contain `forensicRef` in their payloads, making the DLQ the natural metadata index for forensic records. This is equivalent in function and avoids adding a `listKeys` API to ContentStore.

**Cursor encoding:** Used simple offset-based cursor (base64url JSON `{ offset: N }`) because `dlqRepo.findUnresolved` accepts `limit/offset` natively. The `encodeCursor`/`decodeCursor` utilities from `@spatula/shared/cursor.ts` require UUIDs which don't apply here.

## Known Stubs

None — all forensic functionality is wired end-to-end.

## Self-Check: PASSED

All key files confirmed present on disk. All three task commits confirmed in git log.
- forensic-archiver.ts: FOUND
- admin-forensic.ts: FOUND  
- forensic.ts (client): FOUND
- auth/types.test.ts: FOUND
- commit 1a42073: FOUND
- commit adb17dc: FOUND
- commit df76455: FOUND
