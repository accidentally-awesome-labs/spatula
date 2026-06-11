# Phase 16: API Contract Hardening + SDK Packages — Research

**Researched:** 2026-05-19
**Domain:** OpenAPI contract hardening, npm SDK packaging, monorepo release engineering
**Confidence:** HIGH

## Summary

Phase 16 is the largest phase in v1.1 (22 requirement IDs, 8–10 active sessions). The technical surface area is well-bounded because CONTEXT.md already locked 16 decisions including sub-plan decomposition (5 sub-plans), error-code naming style (`DOMAIN.CODE`), OpenAPI generation strategy (generate-once-at-boot), and contract-test architecture (matrix generated from `/openapi.json`). Research focused on validating the **current 2026 APIs** of every library the plan depends on — `@hono/zod-openapi`, `release-please`, `size-limit`, `ajv`, `node:sqlite`, npm trusted-publishing — because each moved in 2025 and recall-based decisions would fail on contact with the actual tooling.

The stack is fully nailed down: `@hono/zod-openapi@^0.19.10` already in repo exposes `getOpenAPI31Document()` returning a plain serializable object (perfect for the boot-cache pattern in D-13); `release-please@17.6.0` supports manifest mode with the `linked-versions` plugin for the `@spatula/core-types` ↔ `@spatula/client` exact-peer-dep lockstep; `size-limit@12.1.0` + `@size-limit/esbuild@12.1.0` declare the 50KB gzipped budget via `packages/client/size-limit.json`; `ajv@8.20.0` with `ajv/dist/2020` import natively handles the OpenAPI 3.1 draft-2020-12 dialect for the contract-test schema validation; npm trusted-publishing with `id-token: write` permission has been GA since 2025-07-31 and automatically generates provenance without an `--provenance` flag (though the flag is still accepted).

The SQLite decision is the **only unresolved gate**: `node:sqlite` exited the `--experimental-sqlite` flag in Node 22.5+ and is now Stability 1.2 (Release candidate) in Node 25.7+, BUT **FTS5 is NOT compiled in** on any Node release through current LTS. Since FTS5 parity is one of the three gates spec §3.2.3 requires for the switch, this single missing feature flips the default to **stay on `better-sqlite3@12.10.0`**. The benchmark in sub-plan 16-5 will confirm and document, but the outcome is already research-decidable.

**Primary recommendation:** Execute the 5-sub-plan sequence locked in CONTEXT.md D-01 with **no library substitutions**. Use `@hono/zod-openapi.getOpenAPI31Document()` for the boot-cache (D-13), `ajv` with `Ajv/dist/2020` import for contract validation (D-14, D-16), `release-please` `linked-versions` plugin for the SDK lockstep, and `@size-limit/esbuild` with `gzip: true` for the 50KB CI gate. The SQLite swap **does not happen this phase** — document the benchmark and rationale in `docs/architecture.md`.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Sub-Plan Decomposition (5 sub-plans, error-envelope-first sequence)**

- **D-01:** 5 sub-plans:
  1. **16-1** — Error envelope sweep + rate-limit response headers + `config/rate-limits.yaml` (API-01, API-02, API-03; new `X-RateLimit-Reset` header). Owns manual audit of every error-throw site. Reshapes pagination envelope `{ total, limit, hasMore, nextCursor }` → `{ data, nextCursor, hasMore }` with `Deprecation` + `Sunset` headers on offset (API-04).
  2. **16-2** — `@spatula/core-types` extract + `@spatula/client` build (SDK-01, SDK-02, SDK-03). Emits frozen error-code enum and class-per-code typed SDK errors via codegen. ESLint rule blocking non-type imports from `@spatula/core-types`. `size-limit` threshold at `packages/client/size-limit.json`.
  3. **16-3** — `GET /api/v1/openapi.json` runtime endpoint + `GET /.well-known/spatula-version` + lazy version probe in `@spatula/client` + `docs/compat-policy.md` (API-05, API-06, API-14, success criterion 5).
  4. **16-4** — `tests/contract/` suite generated from OpenAPI (API-12, success criterion 1). Gates everything via PR CI; runs full route × status × example matrix from served `/openapi.json`. Also covers idempotency / webhook / experimental-tag / compat / timestamps documentation (API-07, API-08, API-09, API-10, API-11, API-13).
  5. **16-5** — Release infrastructure: `release-please` topology for 8 packages, internal-package no-compat READMEs, `@spatula/cli` publish prep, SQLite benchmark + decision committed to `docs/architecture.md`, SDK integration test suite scaffolding, dry-run publish to staging registry with `--provenance` + `--access public` (SDK-04..08, success criteria 3 + 6).
- **D-02:** **One PR per sub-plan.** Each sub-plan = own branch (`feat/wave-6-2-{NN}-{slug}`) + own PR + merge-commit. Different from Phase 15's single-PR pattern.
- **D-03:** **BLOCK-04 gates only sub-plan 16-5.** Sub-plans 16-1..16-4 proceed without BLOCK-04 resolution.
- **D-04:** **Sequencing locked:** 16-1 → 16-2 → 16-3 → 16-4 → 16-5.

**Error-Code Enum Design**

- **D-05:** **`DOMAIN.CODE` category-prefixed naming.** Examples: `JOB.NOT_FOUND`, `EXTRACTION.QUOTA_EXCEEDED`, `AUTH.INVALID_TOKEN`, `RATE_LIMIT.EXCEEDED`, `VERSION.MISMATCH`, `VALIDATION.SCHEMA`.
- **D-06:** **Clean-slate enum derived from OpenAPI route surface.** Sub-plan 16-1 enumerates every route in the `@hono/zod-openapi` registry, identifies every intended 4xx/5xx, then writes a fresh canonical enum. Every throw site rewritten.
- **D-07:** **Full route audit + contract tests enforce drift.** Belt AND suspenders.
- **D-08:** **`details` field shape: free-form `Record<string, unknown>`.** Envelope is `{ error: { code, message, requestId, details? } }`. Envelope frozen at v1; `details` content evolves freely per error site.

**Public Packages**

- **D-09:** **`@spatula/core-types` boundary: types + zod + enums only.** No runtime helpers, builder functions, constants, factory functions. Zero runtime deps; zod as peer.
- **D-10:** **ESLint rule blocks all non-type imports from `@spatula/core-types`.**
- **D-11:** **SDK typed errors: class-per-code, all extend `SpatulaApiError`.** `QuotaExceededError`, `JobNotFoundError`, `ValidationError`, etc. Auto-generated via codegen at `packages/client/scripts/gen-error-classes.ts` → `packages/client/src/errors/generated.ts` (committed output). CI verifies regen produces identical output via `git diff --exit-code`.
- **D-12:** **Version probe: lazy on first request.** `SpatulaClient` constructor returns immediately with zero I/O. First API call awaits `GET /.well-known/spatula-version`, caches for client lifetime, throws `SpatulaVersionMismatchError` on major mismatch BEFORE the actual request fires.

**OpenAPI Source-of-Truth + Contract Tests**

- **D-13:** **OpenAPI runtime: generate-once-at-boot + cache.** App boot calls `app.getOpenAPI31Document(...)` exactly once on the existing `OpenAPIHono` registry, freezes the JSON document in memory; `GET /api/v1/openapi.json` serves the cached document.
- **D-14:** **Drift detection: contract tests roundtrip.** `tests/contract/` fetches live `/api/v1/openapi.json` from a running test server, then for every `(route, response-status, example)` tuple: hits the route, validates the response body against the OpenAPI schema using `ajv` compiled from the served JSON Schema.
- **D-15:** **Contract test structure: generated from OpenAPI tree.** Test runner reads `/openapi.json` at suite boot, iterates every `(path, method, responses[status], examples[])` tuple, generates a test case per tuple via `describe.each` + `it.each`. One generator file drives the entire matrix.
- **D-16:** **Example validation: `ajv` at app boot in dev.** App boot in `NODE_ENV !== 'production'` extracts every example from the OpenAPI tree, compiles each schema with `ajv`, validates the example body against the schema. Fails boot if any example is off-schema. Skip in `NODE_ENV=production`.

### Claude's Discretion

- `config/rate-limits.yaml` shape — recommendation: per-route-group with method overrides; file merge via `SPATULA_RATE_LIMITS_PATH` env var; boot-only reload for v1.
- `release-please` topology — recommendation: single `release-please-config.json` at repo root with `release-please-manifest.json`; grouped releases for `@spatula/core-types` ↔ `@spatula/client` via `linked-versions` config.
- SQLite benchmark gate timing — sub-plan 16-5 runs `node:sqlite` vs `better-sqlite3` benchmark as first task. Planner decides whether to fold a possible swap into 16-5 or split into 16-6.
- `experimental:` tag policy machinery — Phase 16 ships **documented policy** + `client.experimental.*` namespace **scaffolding** (empty proxy on `SpatulaClient`). No `Deprecation`/`Sunset` header emission machinery until first experimental surface ships in Phase 18.
- Cursor format/algorithm — already partially built (Wave 3-3b composite `(entity_id, extraction_id)` cursor). Planner reuses existing cursor codec; no new format. Document cursor opacity contract in OpenAPI descriptions.
- `Deprecation` + `Sunset` header format for offset pagination — recommend RFC 8594 `Sunset: <HTTP-date>`, `Deprecation: <HTTP-date>`, `Link: </docs/cursor-pagination>; rel="successor-version"`. Sunset target: v2.0 GA (~12 months post-v1.0).
- Internal-package no-compat notice format — single canonical template repeated verbatim at top of each internal package's README; `package.json` `description` field includes the warning.
- Codegen pipeline for error classes — `scripts/gen-error-classes.ts` reads enum from `@spatula/core-types`, writes `packages/client/src/errors/generated.ts`. Committed output. CI verifies via regen + `git diff --exit-code`.

### Deferred Ideas (OUT OF SCOPE)

- **CLI migration to `@spatula/client`** — Phase 16 uses `@spatula/client` only for the version-probe check during `spatula doctor`. Full migration deferred to v1.2 or Phase 22 polish.
- **Webhook delivery rebuild** — Phase 16 only **documents** existing implementation in `docs/cookbook/webhooks.md` (API-09). Any gaps from spec wording noted in cookbook; rebuild deferred to Phase 18 or v1.2.
- **Idempotency replay test suite expansion** — API-08 is doc-only. Spot-check existing replay in sub-plan 16-4; don't expand.
- **OpenAPI client codegen for non-TS languages** — DEFER-02 covers Python/Java/Go SDKs as community-welcome.
- **Cursor pagination format documentation in `docs/api-cursor.md`** — standalone doc deferred unless Phase 20 docs site needs it.
- **`experimental:` tag header emission machinery** — first experimental surface ships in Phase 18.
- **Internal-package version-bump automation for `spatula-saas`** — out of scope here.
  </user_constraints>

<phase_requirements>

## Phase Requirements

| ID     | Description                                                                                                                                         | Research Support                                                                                                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API-01 | 4xx/5xx envelope `{ error: { code, message, requestId, details? } }`; enum exported from `@spatula/core-types`, frozen at v1                        | Existing `errorResponseSchema` in `apps/api/src/schemas/responses.ts:131` already 3/4 fields — add optional `details: z.record(z.unknown()).optional()`. Existing `SpatulaError` base class in `packages/shared/src/errors.ts` is the throw-site primitive. |
| API-02 | `X-RateLimit-Limit` + `-Remaining` + `-Reset` on success; `Retry-After` on 429                                                                      | Existing rate-limit middleware emits 3 of 4 headers; only `X-RateLimit-Reset` (epoch seconds = `Math.floor((now + WINDOW_MS) / 1000)`) is missing. One-line addition.                                                                                       |
| API-03 | Per-route rate-limit config in `config/rate-limits.yaml`; overridable                                                                               | YAML loader: `yaml@2.8.3` already in deps. Path: load at app boot via env-var with fallback to `./config/rate-limits.yaml`.                                                                                                                                 |
| API-04 | Cursor-first canonical; offset `deprecated: true` in OpenAPI + `Deprecation`/`Sunset` headers; removal target v2.0                                  | Existing cursor codec at `packages/shared/src/cursor.ts` reused. RFC 8594 header format verified. Wave 3-3b composite cursor `(entity_id, extraction_id)` already working in `entity-sources.ts`.                                                           |
| API-05 | `GET /api/v1/openapi.json` from same source-of-truth as build                                                                                       | `@hono/zod-openapi.getOpenAPI31Document()` returns plain JS object (verified). Boot-cache via module-level `let cachedSpec` in `apps/api/src/openapi-config.ts`.                                                                                            |
| API-06 | `GET /.well-known/spatula-version` returns version + git-sha + support-matrix snapshot                                                              | Standard `/.well-known/` route. Version from `package.json` via JSON-module import (Node 22 supports). Git-sha injected via build-time env (`GIT_SHA` from CI).                                                                                             |
| API-07 | All API timestamps ISO 8601 UTC; no unix epoch                                                                                                      | Existing schemas use `z.string()` for `createdAt`/`startedAt`/`completedAt`. Audit for any `.timestamp()` or numeric timestamps. PostgreSQL `timestamp with time zone` already serializes ISO 8601 via `pg` driver.                                         |
| API-08 | `docs/api-idempotency.md` documents existing Wave 3-4 functionality                                                                                 | Doc-only; spot-check existing `Idempotency-Key` middleware. Cookbook structure: pattern from `docs/superpowers/plans/*.md` precedent.                                                                                                                       |
| API-09 | `docs/cookbook/webhooks.md` with retry schedule + HMAC-SHA256 + dedup pattern                                                                       | Doc-only; webhook delivery code exists at `packages/queue/src/webhook-sender.ts`. Reference existing implementation in cookbook.                                                                                                                            |
| API-10 | All public routes under `/api/v1/`; v2 cut plan committed                                                                                           | Existing routes already mounted at `/api/v1/*`. Doc: `docs/compat-policy.md` § "URL versioning".                                                                                                                                                            |
| API-11 | Export format stability declaration (JSON/CSV/Parquet/SQLite/DuckDB + provenance)                                                                   | Doc-only declaration. Existing exporters at `packages/core/src/exporters/`.                                                                                                                                                                                 |
| API-12 | `tests/contract/` covers every route × every error status × every example; CI on every PR                                                           | `ajv@8.20.0` with `Ajv/dist/2020` import (verified). New test config follows `tests/private-contract/vitest.config.ts` shape.                                                                                                                               |
| API-13 | `experimental:` tag policy in `docs/deprecation-policy.md`                                                                                          | Doc-only at v1.0 (zero experimental surfaces). `client.experimental.*` namespace scaffolding (empty proxy) ships in 16-2.                                                                                                                                   |
| API-14 | `docs/compat-policy.md` per spec §3.2.5                                                                                                             | New doc. Source: spec §3.2.5 verbatim with elaboration. Linked from every package README.                                                                                                                                                                   |
| SDK-01 | `@spatula/core-types` with type-only exports, zod, enums, zero runtime deps                                                                         | New `packages/core-types/` directory. Mirror `packages/shared/`'s vitest.config + tsconfig shape. zod as peer dep `>=3.22.0 <5.0.0`. `engines.node: ">=22"`.                                                                                                |
| SDK-02 | `@spatula/client` with `SpatulaClient` class + typed errors; ESM-only; `sideEffects: false`; explicit `exports`                                     | New `packages/client/`. Fetch-based. Reuses request/response logic pattern from `apps/cli/src/api/spatula-api-client.ts`. exports field maps `"."` to types + import entry.                                                                                 |
| SDK-03 | `<50KB gzipped` for `{SpatulaClient, createJob, listJobs, getEntities}` esbuild ESM browser; CI via `size-limit`                                    | `size-limit@12.1.0` + `@size-limit/esbuild@12.1.0` verified. Config at `packages/client/size-limit.json`. CI script: `pnpm --filter @spatula/client size`.                                                                                                  |
| SDK-04 | `@spatula/cli` publish-ready: `bin`, `publishConfig.access=public`, dual ESM+CJS, files allowlist, `engines: {node: ">=22"}`                        | Existing `apps/cli/package.json` needs: add `publishConfig`, switch from `.npmignore` (if present) to `files` allowlist, add dual-CJS build pipeline. Playwright via `spatula setup` (no postinstall).                                                      |
| SDK-05 | `node:sqlite` vs `better-sqlite3` benchmark; default stays `better-sqlite3` unless 3 gates pass (WAL+FTS parity, zero regression, non-experimental) | **Decision already research-decidable: FTS5 NOT compiled in `node:sqlite` on any Node release through current LTS. Stays `better-sqlite3@12.10.0`.** Document in `docs/architecture.md`.                                                                    |
| SDK-06 | Internal packages publish-ready with no-compat README notice                                                                                        | Template verbatim from spec §3.2.4. Apply to all 5 internal package READMEs.                                                                                                                                                                                |
| SDK-07 | Release workflow publishes all 8 packages with `--provenance` and `--access public`                                                                 | `release-please@17.6.0` + `googleapis/release-please-action@v4` (already in repo). npm trusted publishing GA 2025-07-31 — `id-token: write` permission, no NPM_TOKEN needed.                                                                                |
| SDK-08 | SDK integration test suite hits every major endpoint; gated by `SPATULA_LIVE_LLM`; mocks by default                                                 | Pattern: `packages/client/tests/integration/`. vitest config copies `tests/e2e/` shape with `passWithNoTests: true`. Gating via `process.env.SPATULA_LIVE_LLM === '1'`.                                                                                     |

</phase_requirements>

## Standard Stack

### Core (already in repo — VERSION VERIFIED)

| Library             | Version | Purpose                                       | Why Standard                                                                                                      |
| ------------------- | ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@hono/zod-openapi` | 0.19.10 | OpenAPI 3.1 generation from Zod registrations | Already wired; `getOpenAPI31Document()` returns serializable JSON. Single source-of-truth.                        |
| `hono`              | 4.12.7  | HTTP framework                                | Already wired; supports `ErrorHandler`, `MiddlewareHandler`, custom headers via `c.header()`.                     |
| `zod`               | 3.24.0  | Schema validation + type inference            | Already wired; peer dep for both `@spatula/core-types` and `@spatula/client` (`>=3.22.0 <5.0.0` window per spec). |
| `yaml`              | 2.8.3   | `config/rate-limits.yaml` parsing             | Already in deps for `spatula.yaml`. Reuse for rate-limit config.                                                  |
| `better-sqlite3`    | 12.10.0 | SQLite driver (project-db, content-store)     | **Stays at v1.0** per SQLite gate analysis below. FTS5 compiled in by default.                                    |
| `pino`              | 9.6.0   | Structured logging                            | Already wired; logs request-id correlation.                                                                       |
| `vitest`            | 2.1.0   | Test runner                                   | Already wired across all suites. `tests/contract/` follows established `vitest.config.ts` shape.                  |

### New (introduce in this phase — VERSION VERIFIED via npm registry on 2026-05-19)

| Library                        | Version | Purpose                                           | When to Use                                                                                                                                          |
| ------------------------------ | ------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ajv`                          | 8.20.0  | JSON Schema 2020-12 validation for contract tests | `tests/contract/` validates `(route, status, example)` tuples. Import via `Ajv from 'ajv/dist/2020'` for native draft-2020-12 (OpenAPI 3.1 dialect). |
| `ajv-formats`                  | 3.0.1   | Format validators (`date-time`, `uri`, `uuid`)    | Required peer for `ajv` 2020 build to validate ISO 8601 timestamps, UUIDs in responses.                                                              |
| `size-limit`                   | 12.1.0  | Bundle size budget CI gate                        | `packages/client/size-limit.json` enforces `<50KB gzipped` for the measured surface.                                                                 |
| `@size-limit/esbuild`          | 12.1.0  | esbuild adapter for size-limit                    | Required to measure the exact `--bundle --minify --format=esm --platform=browser` config per spec.                                                   |
| `@size-limit/preset-small-lib` | 12.1.0  | All-in-one preset for small library bundles       | Convenience: pulls in `@size-limit/esbuild` + `@size-limit/file` + sensible defaults.                                                                |

### Already configured (no changes needed)

| Library                            | Version | Status                                                                                                                                                                                  |
| ---------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-please`                   | 17.6.0  | `release-please-config.json` and `.release-please-manifest.json` already at repo root with 7 packages. Sub-plan 16-5 adds `core-types` + `client` and inserts `linked-versions` plugin. |
| `googleapis/release-please-action` | v4      | Workflow at `.github/workflows/release-please.yml` already wired.                                                                                                                       |

### Alternatives Considered (and rejected)

| Instead of                           | Could Use                                           | Tradeoff                                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@hono/zod-openapi`                  | `hono-openapi` (rhinobase fork)                     | Already on `@hono/zod-openapi`; switching costs > value. Both feature-compatible.                                                                                                                          |
| `ajv`                                | `zod` directly for response validation              | `zod` schemas are the source of truth, but **contract tests validate against the serialized OpenAPI**, not against the in-process Zod tree — testing the JSON-as-served. `ajv` is the right tool for that. |
| `size-limit`                         | `bundlephobia` / custom esbuild script              | `size-limit` is the canonical CI tool for this; `andresz1/size-limit-action` provides PR comments.                                                                                                         |
| `node:sqlite` (Node builtin)         | Stay on `better-sqlite3`                            | FTS5 not compiled in `node:sqlite` through current Node releases — **fails spec §3.2.3 gate #1**. Stay on `better-sqlite3@12.10.0`.                                                                        |
| Class-per-code typed errors          | Single `SpatulaApiError` with `.code` discriminator | Class-per-code (D-11) enables `if (err instanceof QuotaExceededError)` IDE narrowing. Spec §3.2.5 wording requires this.                                                                                   |
| Per-request OpenAPI doc              | Boot-cached doc (D-13)                              | Per-request wastes CPU + breaks CDN cacheability. Boot-cache is byte-identical across requests.                                                                                                            |
| `release-please` per-package configs | Single root config with `linked-versions` plugin    | Per-package configs lose the SDK ↔ core-types lockstep guarantee. Single root config + `linked-versions` plugin is the canonical pattern.                                                                  |

**Installation:**

```
# In sub-plan 16-2 — @spatula/client dev deps
pnpm --filter @spatula/client add -D \
  size-limit@^12.1.0 \
  @size-limit/esbuild@^12.1.0 \
  @size-limit/preset-small-lib@^12.1.0

# In sub-plan 16-4 — tests/contract/ deps (root devDependencies)
pnpm add -Dw ajv@^8.20.0 ajv-formats@^3.0.1
```

**Version verification:** All versions above confirmed against npm registry via `npm view` on 2026-05-19. Re-verify with `pnpm outdated` at sub-plan kick-off.

## Architecture Patterns

### Recommended Project Structure (additions only)

```
spatula/
├── apps/api/
│   └── src/
│       ├── openapi-config.ts        # MODIFIED — add cached getOpenAPI31Document() call at boot
│       ├── routes/
│       │   ├── openapi.ts           # NEW (sub-plan 16-3) — serves cached /api/v1/openapi.json
│       │   └── well-known.ts        # NEW (sub-plan 16-3) — serves /.well-known/spatula-version
│       ├── middleware/
│       │   ├── error-handler.ts     # MODIFIED — DOMAIN.CODE enum + details passthrough
│       │   └── rate-limit.ts        # MODIFIED — X-RateLimit-Reset + per-route lookup
│       ├── schemas/
│       │   ├── responses.ts         # MODIFIED — errorResponseSchema gets details optional field
│       │   └── pagination.ts        # MODIFIED — split into cursor + offset envelopes
│       └── lib/
│           └── deprecation-headers.ts  # NEW — applyDeprecationHeaders() helper for offset routes
├── packages/
│   ├── core-types/                  # NEW (sub-plan 16-2)
│   │   ├── src/
│   │   │   ├── index.ts             # Barrel: re-exports all type-only + zod schemas + enums
│   │   │   ├── errors/
│   │   │   │   └── codes.ts         # FROZEN error-code enum (DOMAIN.CODE convention)
│   │   │   ├── schemas/             # Zod schemas (JobConfig, FieldDef, etc.) lifted from @spatula/core
│   │   │   ├── enums/               # Action types, status enums, scope enums
│   │   │   └── api/                 # Request/response shape interfaces (mirror apps/api/schemas)
│   │   ├── package.json             # peer: zod>=3.22; no runtime deps; engines.node>=22; sideEffects:false
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── README.md
│   └── client/                      # NEW (sub-plan 16-2)
│       ├── src/
│       │   ├── index.ts             # exports SpatulaClient + typed errors + helpers
│       │   ├── client.ts            # SpatulaClient class (fetch-based)
│       │   ├── errors/
│       │   │   ├── base.ts          # SpatulaApiError, SpatulaVersionMismatchError, FeatureUnavailableError
│       │   │   └── generated.ts     # CODEGEN OUTPUT — class-per-code (committed; CI verifies regen)
│       │   ├── version-probe.ts     # Lazy-on-first-request probe (D-12)
│       │   ├── experimental/        # Empty namespace scaffolding (Phase 18 fills)
│       │   └── methods/             # createJob, listJobs, getEntities, etc.
│       ├── tests/
│       │   ├── unit/                # SpatulaClient unit tests with fetch mocked
│       │   └── integration/         # SDK-08 — gated by SPATULA_LIVE_LLM
│       ├── scripts/
│       │   └── gen-error-classes.ts # Reads enum from @spatula/core-types, writes errors/generated.ts
│       ├── size-limit.json          # 50KB gzip budget for {SpatulaClient,createJob,listJobs,getEntities}
│       ├── package.json             # exports field, sideEffects:false, engines.node>=22, peer:zod>=3.22
│       ├── tsconfig.json
│       └── README.md
├── tests/
│   └── contract/                    # NEW (sub-plan 16-4)
│       ├── generated.test.ts        # Test matrix driver (reads /openapi.json, generates describe.each)
│       ├── errors.test.ts           # Error-envelope conformance gate
│       ├── deprecation.test.ts      # Sunset/Deprecation headers on offset routes
│       ├── examples.test.ts         # OpenAPI examples validate against their own schemas
│       ├── fixtures/                # Pre-seeded entities for non-trivial example matches
│       ├── helpers/
│       │   ├── ajv-setup.ts         # Ajv 2020 + ajv-formats configured once
│       │   └── server-harness.ts    # Spawn API + capture port (copies tests/carveout pattern)
│       ├── vitest.config.ts
│       └── README.md
├── config/
│   └── rate-limits.yaml             # NEW (sub-plan 16-1) — per-route-group config
├── docs/
│   ├── api-errors.md                # NEW (sub-plan 16-2) — frozen enum reference
│   ├── compat-policy.md             # NEW (sub-plan 16-3) — SDK↔server↔core-types matrix
│   ├── deprecation-policy.md        # NEW (sub-plan 16-4) — experimental-tag policy
│   ├── api-idempotency.md           # NEW (sub-plan 16-4) — worked examples
│   ├── cookbook/
│   │   └── webhooks.md              # NEW (sub-plan 16-4)
│   └── architecture.md              # MODIFIED (sub-plan 16-5) — SQLite decision section
└── release-please-config.json       # MODIFIED (sub-plan 16-5) — add core-types + client; add linked-versions plugin
```

### Pattern 1: OpenAPI generate-once-at-boot + cache (D-13)

**What:** Build the OpenAPI document ONCE at server startup, freeze the resulting JSON object in memory, serve cached bytes on every `/api/v1/openapi.json` request.

**When to use:** Any time the document is non-trivial in size (`>100KB`) and the registry is fully populated at boot.

**Example sketch** (pseudocode — verified against the `@hono/zod-openapi` README signature):

```
// apps/api/src/openapi-config.ts
import { OpenAPIHono } from '@hono/zod-openapi';

let cachedSpec: object | null = null;

export function getCachedOpenAPISpec(app) {
  if (cachedSpec) return cachedSpec;
  cachedSpec = app.getOpenAPI31Document(
    {
      openapi: '3.1.0',
      info: { title: 'Spatula API', version: process.env.SPATULA_VERSION ?? '1.0.0' },
      servers: [{ url: '/api/v1' }],
    },
    { unionPreferredType: 'oneOf' }, // generator options forwarded to @asteasolutions/zod-to-openapi
  );
  return cachedSpec;
}
```

Mount handler at `/api/v1/openapi.json` returning `c.json(getCachedOpenAPISpec(rootApp))`. Call `getCachedOpenAPISpec(app)` once after every route is registered.

Source: `@hono/zod-openapi` README — `getOpenAPI31Document(config, options?)` — verified via WebFetch on github.com/honojs/middleware/packages/zod-openapi.

### Pattern 2: Contract test matrix driver (D-15)

**What:** A single `describe.each` + `it.each` driver enumerates `(path, method, status, example)` tuples from the served OpenAPI doc and asserts response shape via Ajv 2020-12.

**Key elements:**

- `import Ajv2020 from 'ajv/dist/2020.js'` — native draft-2020-12 build (matches OpenAPI 3.1 dialect)
- `addFormats(ajv)` — required for `date-time`, `uuid`, `uri` format checks in responses
- Walk `openapiDoc.paths[*][*].responses[*].content['application/json'].{schema, examples}` to enumerate tuples
- For each tuple: compile `schema` once; assert example value validates; for 2xx tuples additionally hit the live route via `fetch()` and assert response body validates
- Path params resolved via a per-test fixture map (seeded UUIDs)

**File layout:**

- `tests/contract/generated.test.ts` — matrix driver
- `tests/contract/helpers/ajv-setup.ts` — single Ajv 2020 instance shared across files
- `tests/contract/helpers/server-harness.ts` — boots API + captures port; copies the established `tests/carveout/fixtures/server.ts` Node-builtin http.Server adapter pattern (Phase 15 decision, avoids needing `@hono/node-server` at workspace root)

Source: ajv.js.org/options.html#draft-2020-12 + cross-verified via WebSearch (metatech.dev OpenAPI 3.0→3.1 migration guide).

### Pattern 3: `release-please` linked-versions for SDK lockstep

**What:** Two packages (`@spatula/core-types` + `@spatula/client`) must publish at the same major version always, so the exact-peer-dep contract from spec §3.2.5 holds.

**Config snippet:**

```
// release-please-config.json (modifications shown)
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".":                  { "release-type": "node", "component": "spatula" },
    "packages/core-types": { "release-type": "node", "component": "core-types" },
    "packages/client":     { "release-type": "node", "component": "client" },
    "packages/core":       { "release-type": "node", "component": "core" },
    "packages/db":         { "release-type": "node", "component": "db" },
    "packages/queue":      { "release-type": "node", "component": "queue" },
    "packages/shared":     { "release-type": "node", "component": "shared" },
    "apps/api":            { "release-type": "node", "component": "api" },
    "apps/cli":            { "release-type": "node", "component": "cli" }
  },
  "plugins": [
    { "type": "node-workspace", "updatePeerDependencies": true, "merge": false },
    { "type": "linked-versions",
      "groupName": "sdk-public",
      "components": ["core-types", "client"]
    }
  ]
}
```

The `node-workspace` plugin with `updatePeerDependencies: true` keeps `peerDependencies` in sync when the linked group bumps. `merge: false` disables the workspace plugin's internal merging so `linked-versions` controls the version-pinning.

Source: googleapis/release-please `docs/manifest-releaser.md` (verified via WebFetch) + GitHub issue #1075.

### Pattern 4: `size-limit` config for ESM browser bundle

**Config snippet:**

```
// packages/client/size-limit.json
[
  {
    "name": "SpatulaClient + 3 methods (ESM browser)",
    "path": "dist/index.js",
    "import": "{ SpatulaClient, createJob, listJobs, getEntities }",
    "limit": "50 kB",
    "gzip": true,
    "esbuild": {
      "format": "esm",
      "platform": "browser",
      "target": ["es2022"],
      "bundle": true,
      "minify": true,
      "treeShaking": true
    }
  }
]
```

Companion `package.json` excerpts:

```
{
  "name": "@spatula/client",
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=22" },
  "publishConfig": { "access": "public", "provenance": true },
  "peerDependencies": {
    "@spatula/core-types": "0.x",
    "zod": ">=3.22.0 <5.0.0"
  },
  "size-limit": "./size-limit.json"
}
```

Source: `@size-limit/esbuild` npm package readme + verified via WebFetch on github.com/ai/size-limit.

### Pattern 5: npm Trusted Publishing with provenance (SDK-07)

**What:** OIDC-based publishing from GitHub Actions; no NPM_TOKEN needed; provenance attestations auto-generated.

**Workflow snippet (release.yml additions for sub-plan 16-5):**

```
jobs:
  publish-npm:
    runs-on: ubuntu-latest
    needs: ci
    permissions:
      contents: read
      id-token: write           # REQUIRED for trusted publishing + provenance
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.15.4 }
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: npm install -g npm@latest    # npm 11.5.1+ required for trusted publishing GA
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Publish @spatula/core-types
        run: pnpm --filter @spatula/core-types publish --provenance --access public --no-git-checks
      - name: Publish @spatula/client
        run: pnpm --filter @spatula/client publish --provenance --access public --no-git-checks
      - name: Publish @spatula/cli
        run: pnpm --filter @spatula/cli publish --provenance --access public --no-git-checks
      # Internal packages — also --access public so spatula-saas can install them.
      - name: Publish @spatula/core
        run: pnpm --filter @spatula/core publish --provenance --access public --no-git-checks
      # ... repeat for db, queue, api, shared
```

**Pre-publish trust setup (one-time, in npm web UI):**

For each public package: npm package settings → "Trusted publishers" → Add GitHub Actions publisher:

- Organization: `accidentally-awesome-labs`
- Repository: `spatula`
- Workflow filename: `release.yml`
- Environment name: (leave blank or set `production`)

Sources: docs.npmjs.com/trusted-publishers + github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available.

### Pattern 6: Lazy version probe (D-12)

**What:** Zero-I/O constructor; first request triggers a single `/.well-known/spatula-version` fetch; cache the promise for the client's lifetime.

**Algorithm sketch:**

1. `SpatulaClient` constructor stores `baseUrl`, `fetcher` (defaults to global `fetch`), api key. No I/O.
2. A `VersionProbe` class holds `probePromise: Promise<void> | null`.
3. `probe.ensure()` — if `probePromise` is set, return it. Otherwise fire one fetch to `${baseUrl}/.well-known/spatula-version`. Parse `version` field. If `serverMajor !== SDK_MAJOR_VERSION`, throw `SpatulaVersionMismatchError`. Cache the promise.
4. If the probe throws, attach a `.catch()` that resets `probePromise = null` so the next request can retry.
5. `SpatulaClient.request()` awaits `probe.ensure()` before the actual request fires.

Note: SSR-safe (no constructor I/O); browser-friendly; never blocks on Promise.race if the server doesn't respond — that's a separate timeout concern handled in `request()`.

### Anti-Patterns to Avoid

- **Per-request OpenAPI generation.** `OpenAPIHono.getOpenAPI31Document()` walks the Zod tree; calling it on every `/openapi.json` request burns CPU and breaks downstream CDN caching. Cache at boot.
- **`ajv` (default v8 build) for OpenAPI 3.1 schemas.** Default Ajv defaults to draft-07; OpenAPI 3.1 uses draft-2020-12. Import via `ajv/dist/2020` to get native 2020-12 support, otherwise `$dynamicRef`/`$dynamicAnchor`/etc. silently no-op.
- **Constructor I/O in `SpatulaClient`.** Breaks SSR (Next.js Server Components, Remix loaders) where module evaluation runs at build/render. Lazy on first request (D-12).
- **Generated-at-build-time error classes.** Spec D-11 mandates committed codegen output (`packages/client/src/errors/generated.ts`); `grep class JobNotFoundError` must find a real source file. CI verifies regen produces identical output via `git diff --exit-code`.
- **`--access public` only on tag releases.** npm scoped packages default to `restricted`; the FIRST publish must set `--access public` (or be set via `publishConfig.access` in `package.json` — preferred since it travels with the package).
- **Mixing offset and cursor in the same response envelope.** Current `paginationEnvelopeSchema` does this (`{ total, limit, hasMore, nextCursor }`). Sub-plan 16-1 splits it: `cursorEnvelopeSchema = { data, nextCursor, hasMore }` and `offsetEnvelopeSchema = { data, total, page, limit, hasMore }` — routes opt into one or the other.
- **Throwing `SpatulaVersionMismatchError` synchronously from constructor.** Breaks browser usage where the SDK might be tree-shaken into a non-reachable path. Always async-gate on first request.

## Don't Hand-Roll

| Problem                                   | Don't Build                               | Use Instead                                                                                                        | Why                                                                                                                                                                                     |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON Schema validation for contract tests | Custom recursive shape walker             | `ajv` (draft-2020-12 build) + `ajv-formats`                                                                        | OpenAPI 3.1 uses draft-2020-12 with `$dynamicRef`, conditional `if/then/else`, `prefixItems`. Hand-rolling = months of bugs.                                                            |
| OpenAPI doc generation from Zod           | Custom Zod-walker → JSON Schema converter | `@hono/zod-openapi.getOpenAPI31Document()`                                                                         | Already in repo. Walks the registry, applies `unionPreferredType`, handles refs. The whole point of `@hono/zod-openapi`.                                                                |
| Monorepo version bumping + changelog      | Hand-edit `package.json` + `CHANGELOG.md` | `release-please` (already in repo)                                                                                 | Conventional-commits parsing, multi-package coordination, `linked-versions` plugin for lockstep. Already wired.                                                                         |
| Bundle size measurement                   | Custom `du -h dist/index.js`              | `size-limit` + `@size-limit/esbuild`                                                                               | Measures the BUNDLED + MINIFIED + GZIPPED size, not raw file size. Handles tree-shaking via `import: "{ x, y }"`. PR comments via `size-limit-action`.                                  |
| npm provenance attestations               | Custom sigstore signing script            | `npm publish --provenance` with `id-token: write` permission                                                       | OIDC trust handshake + sigstore attestation is npm-built-in since 2023; GA for trusted publishing since 2025-07-31. Zero custom code.                                                   |
| Idempotency-Key replay                    | Add new middleware                        | Existing Wave 3-4 implementation                                                                                   | Already shipped; sub-plan 16-4 only documents it (API-08).                                                                                                                              |
| HMAC-SHA256 webhook signing               | Add new signing code                      | Existing `packages/queue/src/webhook-sender.ts`                                                                    | Already shipped; sub-plan 16-4 only documents it (API-09).                                                                                                                              |
| Cursor encoding/decoding                  | New cursor format                         | Existing `packages/shared/src/cursor.ts`                                                                           | `encodeCursor`/`decodeCursor` already handle base64url + UUID validation + composite payloads. Reuse.                                                                                   |
| YAML config parsing                       | Custom YAML parser                        | Existing `yaml@2.8.3` dependency                                                                                   | Already used for `spatula.yaml`. Reuse for `config/rate-limits.yaml`.                                                                                                                   |
| ESLint rule blocking non-type imports     | Whole custom ESLint plugin                | `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true` + existing `consistent-type-imports` rule | Standard ESLint pattern — see "Code Examples" below. Avoid building a full `@spatula-internal/eslint-plugin` for a single rule.                                                         |
| Boot-time example validation              | Custom shape-walker over examples         | Reuse the `tests/contract/` `ajv` setup, gated by `NODE_ENV !== 'production'`                                      | One `Ajv` instance, two consumers (boot and tests).                                                                                                                                     |
| Reverse-contract test for type extraction | New test suite                            | Existing `tests/private-contract/oss-surface.test.ts`                                                              | Already exists from Phase 15; sub-plan 16-2 extends it to assert `@spatula/core-types` re-exports preserve the `@spatula/core` surface (or `@spatula/core` re-exports from core-types). |

**Key insight:** Phase 16 is **97% wiring of already-vetted libraries**. The unique surface area (new code that doesn't exist in any library) is: (1) the error-code enum's `DOMAIN.CODE` discipline + codegen mapping, (2) the `config/rate-limits.yaml` schema + loader, (3) the contract-test matrix-driver layout, (4) the `client.experimental.*` empty-namespace scaffolding. Everything else is composition.

## Runtime State Inventory

| Category                                 | Items Found                                                                                                                                                                                                                                                                                  | Action Required                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Stored data**                          | **None** — Phase 16 is server-source-code + new packages + docs. No data records keyed by anything Phase 16 changes.                                                                                                                                                                         | None.                                                                                                                          |
| **Live service config**                  | **None** — npm `@spatula` org will be created (BLOCK-04) but Phase 16 does not store live external state pre-publish.                                                                                                                                                                        | BLOCK-04 must clear before sub-plan 16-5; documented as pre-phase gate.                                                        |
| **OS-registered state**                  | **None** — no Task Scheduler, launchd, systemd, pm2 entries touched.                                                                                                                                                                                                                         | None.                                                                                                                          |
| **Secrets/env vars**                     | `SPATULA_RATE_LIMITS_PATH` (NEW env var, optional, defaults to `./config/rate-limits.yaml`). `GIT_SHA` build-time env (CI-only, for `/.well-known/spatula-version`). Existing `OPENROUTER_API_KEY` consumed by SDK-08 integration suite under `SPATULA_LIVE_LLM=1`. **No secret rotations.** | Document new env vars in `.env.example`. CI sets `GIT_SHA=${GITHUB_SHA}` in build job.                                         |
| **Build artifacts / installed packages** | After publish (sub-plan 16-5): `node_modules/@spatula/core-types/`, `node_modules/@spatula/client/` (new) appear in consumer installs. Internal package version bumps from `0.0.1` → `1.0.0` (or `1.0.0-rc.1` for trial publish).                                                            | Document in `docs/runbooks/upgrade.md` (existing file). Stale `node_modules/` in dev machines auto-resolve via `pnpm install`. |

**The canonical question (per researcher protocol):** _After every file in the repo is updated, what runtime systems still have the old string cached, stored, or registered?_

Answer: **Nothing meaningful.** Phase 16 doesn't rename any persistent identifier. The closest thing to "runtime state" is the npm registry itself (new package names appear), and that's covered by BLOCK-04 + the staging-registry dry-run in sub-plan 16-5.

## Environment Availability

| Dependency         | Required By                               | Available                       | Version                                       | Fallback                                                                         |
| ------------------ | ----------------------------------------- | ------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| Node.js            | All build + test + publish                | ✓                               | 22.x in repo `.nvmrc` / CI matrix             | — (hard requirement)                                                             |
| pnpm               | Monorepo install + filter commands        | ✓                               | 9.15.4 (per root `package.json`)              | — (hard requirement)                                                             |
| PostgreSQL         | Contract tests need a live API server     | ✓                               | 16 (docker-compose)                           | — (existing dev workflow)                                                        |
| Redis              | API server boot requires connection       | ✓                               | 7 (docker-compose)                            | — (existing dev workflow)                                                        |
| esbuild            | `@size-limit/esbuild` brings transitively | ✓                               | (transitive via `@size-limit/esbuild@12.1.0`) | — (no direct install needed)                                                     |
| npm 11.5.1+        | Trusted publishing + provenance           | ⚠️ Node 22 LTS bundles npm 10.x | (CI must install latest)                      | — (CI step `npm install -g npm@latest` before publish job)                       |
| `act` (CI replay)  | Optional local rehearsal of release.yml   | ✗                               | —                                             | Push to a `feat/wave-6-2-05-release-dryrun` branch to test on GH Actions runners |
| GitHub OIDC        | npm trusted publishing                    | ✓                               | (cloud)                                       | — (configured one-time on npm side per package, then automatic)                  |
| npm `@spatula` org | Sub-plan 16-5 publish                     | **✗ (BLOCK-04)**                | —                                             | Fallback scope `@spatulaai` or `@aalabs/spatula` per BLOCK-04 contingency        |

**Missing dependencies with no fallback:** None blocking sub-plans 16-1 → 16-4. Sub-plan 16-5 blocks on BLOCK-04.

**Missing dependencies with fallback:**

- npm `@spatula` org — if unavailable at 16-5 kick-off, choose `@spatulaai` or `@aalabs/spatula` per CONTEXT.md and STATE.md. Update all 8 `package.json` `name` fields + cross-references in docs.

**npm version note:** Trusted publishing GA requires **npm CLI 11.5.1+**. Node 22 LTS bundles npm 10.x. Sub-plan 16-5's publish job MUST add an explicit `npm install -g npm@latest` step (or use `actions/setup-node@v4` with a `node-version` that bundles npm 11+, e.g., Node 24+). Document this in the release workflow.

## Common Pitfalls

### Pitfall 1: `ajv` draft mismatch silently no-ops modern JSON Schema features

**What goes wrong:** `import Ajv from 'ajv'` (default v8 import) gives you a draft-07 instance. Schemas extracted from an OpenAPI 3.1 doc use draft-2020-12 features (`$dynamicRef`, `prefixItems`, `if/then/else`, `dependentSchemas`). Ajv silently ignores unknown keywords — your validator returns `true` for invalid data.

**Why it happens:** Ajv supports multiple drafts but you opt-in per-build. Default v8 build = draft-07. The 2020-12 build lives at `ajv/dist/2020`.

**How to avoid:** Always `import Ajv2020 from 'ajv/dist/2020.js'` in `tests/contract/` and in the boot-time example validator. Pair with `ajv-formats` for `date-time`, `uuid`, `uri`.

**Warning signs:** Contract test passes locally but a known-bad example response doesn't fail; `ajv.compile(schema)` doesn't throw on a draft-2020-12-only feature.

### Pitfall 2: `@hono/zod-openapi` `defaultHook` runs BEFORE the route handler, error envelope must match the new shape

**What goes wrong:** Sub-plan 16-1 rewrites every error response in route handlers to use the new `DOMAIN.CODE` enum. But validation errors are emitted by `defaultHook` in `apps/api/src/openapi-config.ts:6-21`, which CURRENTLY emits `code: 'VALIDATION_ERROR'`. Forgetting to update `defaultHook` → contract test fails on validation-error envelopes.

**Why it happens:** Route handlers are the obvious sweep target; the middleware-shaped `defaultHook` is easy to miss.

**How to avoid:** Add `apps/api/src/openapi-config.ts` to the explicit sweep checklist in sub-plan 16-1. Contract test in sub-plan 16-4 asserts validation-error responses also conform.

**Warning signs:** Local `pnpm test:carveout` passes; `pnpm test:contract` fails on `validation` test cases with "code mismatch: VALIDATION_ERROR vs VALIDATION.SCHEMA".

### Pitfall 3: `release-please` `node-workspace` plugin double-bumps when combined with `linked-versions`

**What goes wrong:** `node-workspace` plugin bumps a package because its peer-dep updated; `linked-versions` plugin then sees two components with different versions and bumps the lower one. Result: an unintended patch bump cascade.

**Why it happens:** Both plugins run in the same pipeline; their effects compose unexpectedly.

**How to avoid:** Set `"merge": false` on `node-workspace` so `linked-versions` controls final version selection. Run `release-please` in dry-run mode (`--dry-run` flag) before merging to `main`.

**Warning signs:** Release-PR shows version bumps for packages that had no commits since last release. Fix by re-running with `--dry-run` and adjusting plugin order.

Source: googleapis/release-please#1750 + #1075 discussions; manifest-releaser.md.

### Pitfall 4: npm trusted publishing requires `id-token: write` AT THE JOB LEVEL, not workflow-level

**What goes wrong:** Publish job fails with "OIDC token not found". Permissions block was set at workflow-level but the publishing job inherits the default (which excludes `id-token`).

**Why it happens:** GitHub Actions `permissions` is hierarchical; job-level overrides workflow-level. The default is `permissions: read` if not specified.

**How to avoid:** Set `permissions: { id-token: write, contents: read }` AT THE PUBLISH JOB level explicitly. Don't rely on workflow-level inheritance.

**Warning signs:** Publish step errors with "no auth method available" or "trusted publisher not configured" even though npm settings show the publisher correctly.

Source: docs.npmjs.com/trusted-publishers + verified via philna.sh/blog/2026/01/28.

### Pitfall 5: `size-limit` measures the IMPORTED surface, not the package's published surface

**What goes wrong:** `size-limit` reports 32KB; user installs SDK and bundles their app — bundle grows by 95KB because they also imported `client.experimental.*` or transitive types from `@spatula/core-types`.

**Why it happens:** The `import: "{ SpatulaClient, createJob, listJobs, getEntities }"` line tells `size-limit` to **measure only what those imports pull in**. It doesn't measure the package's full export surface. Spec §3.2.1 explicitly defines the measured surface, so this is correct-by-design, but the README of `@spatula/client` MUST say so unambiguously to prevent user complaints.

**How to avoid:** In `packages/client/README.md`, document the measured surface verbatim and link to `packages/client/size-limit.json`. Add a separate `size-limit` entry for the full barrel import as a SECONDARY (non-gating) measurement so the actual upper bound is visible.

**Warning signs:** User issue "you say 50KB but my bundle grew 130KB"; that user imported the whole module surface.

### Pitfall 6: Codegen output drift between local dev and CI

**What goes wrong:** Developer edits `packages/core-types/src/errors/codes.ts` (adds a new code) but forgets to run `pnpm --filter @spatula/client codegen`. CI's `git diff --exit-code` after regen catches it — but only after a full `pnpm install + pnpm build` cycle in CI burns ~3 min before failing.

**Why it happens:** Codegen is opt-in via a script; developers forget.

**How to avoid:** Wire codegen into pre-commit via husky/lint-staged in sub-plan 16-2. Pre-commit hook: `pnpm --filter @spatula/client codegen && git add packages/client/src/errors/generated.ts`. If the file changed after running codegen, the commit picks it up.

**Warning signs:** PRs fail the `verify-codegen` CI step despite the author thinking they updated the codes file.

### Pitfall 7: `node:sqlite` benchmark gives false-positive parity (you don't know what you don't know)

**What goes wrong:** Sub-plan 16-5 benchmark measures CRUD throughput on `node:sqlite` vs `better-sqlite3`, finds no regression, switches the driver. Later: a feature using FTS5 (full-text search over crawled content) fails silently because `node:sqlite` doesn't have FTS5 compiled in.

**Why it happens:** Benchmarks measure what they measure. Missing-feature gates are different from perf gates.

**How to avoid:** **Spec §3.2.3 gate #1 (feature parity for WAL + FTS) must be checked FIRST before any perf gate.** Sub-plan 16-5 first task: enumerate every SQLite extension/feature used in the codebase (grep for `pragma`, `fts5`, `loadExtension`), then verify each is supported by `node:sqlite`. If FTS5 fails → benchmark is moot, decision is "stay on `better-sqlite3`", document.

**Warning signs:** None in the benchmark itself; symptom is a runtime `SqliteError: no such module: fts5` after switch.

Verified: nodejs.org/api/sqlite.html documents `loadExtension` (requires `allowExtension: true`) and stability 1.2 (Release Candidate) — but does NOT document FTS5 compiled in. WebSearch confirms FTS5 explicitly absent on Node 22.x and Node 23.x builds. Decision is research-decidable: **stay on `better-sqlite3`**.

## Code Examples

### Error-handler middleware (sub-plan 16-1, modified shape per D-05, D-08)

Sketch of the `errorHandler` rewrite. Pattern:

1. Define `STATUS_MAP: Record<ErrorCode, number>` mapping every `DOMAIN.CODE` value to HTTP status.
2. New error subclasses (e.g., `JobNotFoundError`) pass the matching `DOMAIN.CODE` string to `SpatulaError` base constructor.
3. `mapErrorToStatus()` does `if (error instanceof SpatulaError && error.code in STATUS_MAP) return STATUS_MAP[error.code]`; default 500.
4. `errorHandler` reads `error.context` (already supported by `SpatulaError` per `packages/shared/src/errors.ts:5`) and passes it through as `details` in the response envelope when present.
5. 5xx responses log via `pino` + `captureException`; 4xx log as `warn`.

Existing file: `apps/api/src/middleware/error-handler.ts:54-85`. Modifications keep the existing flow; only the envelope shape and the code → status map are extended.

### Rate-limit middleware (sub-plan 16-1, adds `X-RateLimit-Reset` + per-route lookup)

Modifications to `apps/api/src/middleware/rate-limit.ts`:

1. Add a new module `apps/api/src/middleware/rate-limit-config.ts` that loads `config/rate-limits.yaml` once at boot (path from `SPATULA_RATE_LIMITS_PATH` env, fallback to `./config/rate-limits.yaml`). Returns `Record<string, RateLimitConfig>` keyed by route key.
2. In `rateLimitMiddleware`, look up tier by `${c.req.method} ${c.req.routePath}`, fall back to `'default'` key, fall back to `DEFAULT_RATE_LIMIT`.
3. Compute `resetEpochSeconds = Math.floor((now + WINDOW_MS) / 1000)`.
4. Set headers via `c.header()` — add `X-RateLimit-Reset: resetEpochSeconds.toString()` alongside the existing `X-RateLimit-Limit` and `X-RateLimit-Remaining`.
5. On 429, set `Retry-After: '60'` and return the `RATE_LIMIT.EXCEEDED` envelope shape with `details: { limit, resetAt: resetEpochSeconds }`.

The existing Redis-Lua sliding-window primitive (the `RATE_LIMIT_SCRIPT` invoked via `redis.eval(...)`) is unchanged.

### `config/rate-limits.yaml` shape (sub-plan 16-1, planner-recommended schema)

```
# config/rate-limits.yaml
# Per-route rate-limit configuration. Loaded once at boot.
# Override via SPATULA_RATE_LIMITS_PATH env var.

# Default fallback when no exact-route or route-group match.
default:
  requestsPerMinute: 300
  maxConcurrentJobs: 10

# Route-group templates — match c.req.routePath patterns.
routeGroups:
  "GET /api/v1/health":
    requestsPerMinute: 6000        # high-frequency probes from load balancers
  "POST /api/v1/jobs":
    requestsPerMinute: 30          # creation gate
    maxConcurrentJobs: 5
  "GET /api/v1/entities":
    requestsPerMinute: 600         # high-read endpoint
  "POST /api/v1/admin/*":
    requestsPerMinute: 60          # admin tighter
```

### ESLint rule blocking non-type imports from `@spatula/core-types` (D-10)

```
// eslint.config.mjs (additions for sub-plan 16-2)
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  // ... existing config
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tsparser },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      // Existing rules ...
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // NEW: forbid value imports from core-types; type-only imports are allowed.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@spatula/core-types',
              allowTypeImports: true,
              message:
                '@spatula/core-types is type-only. Use `import type { X }` or move runtime values to @spatula/core / @spatula/shared.',
            },
          ],
        },
      ],
    },
  },
];
```

Source: typescript-eslint docs on `no-restricted-imports` `allowTypeImports` option.

### `/.well-known/spatula-version` route (sub-plan 16-3)

```
// apps/api/src/routes/well-known.ts (NEW)
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

const versionResponse = z.object({
  version: z.string().openapi({ example: '1.0.0' }),
  gitSha: z.string().openapi({ example: 'a1b2c3d4' }),
  buildAt: z.string().datetime().openapi({ example: '2026-05-19T14:32:00.000Z' }),
  supportMatrix: z.object({
    minClientMajor: z.number().openapi({ example: 1 }),
    deprecatedClientMajors: z.array(z.number()).openapi({ example: [] }),
  }),
}).openapi('SpatulaVersion');

export function wellKnownRoutes() {
  const app = new OpenAPIHono();
  app.openapi(
    createRoute({
      method: 'get',
      path: '/.well-known/spatula-version',
      tags: ['system'],
      summary: 'Server version + compat support matrix',
      responses: {
        200: {
          description: 'Server version metadata',
          content: { 'application/json': { schema: versionResponse } },
        },
      },
    }),
    (c) => c.json({
      version: process.env.SPATULA_VERSION ?? '0.0.0-dev',
      gitSha: process.env.GIT_SHA ?? 'unknown',
      buildAt: process.env.BUILD_AT ?? new Date().toISOString(),
      supportMatrix: { minClientMajor: 1, deprecatedClientMajors: [] },
    }),
  );
  return app;
}
```

## State of the Art

| Old Approach                                   | Current Approach                                                                | When Changed                   | Impact                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `NPM_TOKEN` long-lived secret in `release.yml` | OIDC trusted publishing with `id-token: write`                                  | 2025-07-31 (GA)                | One-time setup on npm web UI; no token rotation; provenance automatic.               |
| `--provenance` required for attestations       | Automatic when published via trusted publisher                                  | 2025-07-31                     | Flag still works as override; under trusted-publisher path, attestation is implicit. |
| Ajv default v8 import for OpenAPI              | `ajv/dist/2020` import for native draft-2020-12                                 | Ajv 8.12+ (2023)               | OpenAPI 3.1 schemas validate correctly; `$dynamicRef`, `prefixItems` resolved.       |
| `release-please` per-package configs (v2/3)    | Single root config with `manifest mode` + plugins                               | release-please 14+ (2024)      | One config file, atomic releases for linked groups.                                  |
| `npm publish --access=public` per-publish flag | `"publishConfig": { "access": "public" }` in `package.json`                     | npm 5+ (2017)                  | Travels with package, can't forget on CLI. Sub-plan 16-2 + 16-5 sets per-package.    |
| Hand-rolled OpenAPI doc construction           | `OpenAPIHono.getOpenAPI31Document()` from Zod registrations                     | @hono/zod-openapi 0.17+ (2024) | Already in repo; single source-of-truth.                                             |
| `--experimental-sqlite` flag for `node:sqlite` | Stable in Node 22.5+ (no flag); Release Candidate (Stability 1.2) in Node 25.7+ | Node 22.5.0 / Node 25.7.0      | Available without flag in Node 22 LTS. **FTS5 STILL NOT compiled in.**               |

**Deprecated/outdated:**

- **`paginationEnvelopeSchema` shape `{ total, limit, hasMore, nextCursor }`** (mixes offset + cursor) — sub-plan 16-1 splits into `cursorEnvelopeSchema` (canonical) + `offsetEnvelopeSchema` (deprecated).
- **Flat error codes `NOT_FOUND`/`VALIDATION_ERROR`** — sub-plan 16-1 sweeps to `DOMAIN.CODE` (`JOB.NOT_FOUND`, `VALIDATION.SCHEMA`, etc.).
- **`RATE_LIMIT_TIERS` tier presets** — Phase 15 already collapsed to `DEFAULT_RATE_LIMIT`; Phase 16 replaces with `config/rate-limits.yaml`.

## Open Questions

1. **Should the `apps/api` and `apps/cli` packages also be in the `linked-versions` group with `core-types` + `client`?**
   - What we know: spec §3.2.5 requires `client` ↔ `core-types` lockstep at exact peer-dep. `cli` is independent semver. `api` is server-side, lockstepped only by REST contract not by package version.
   - What's unclear: whether the **server binary's version** should track `core-types`/`client` for simpler operator mental model.
   - Recommendation: **No** — keep `api`/`cli` independent. Operators don't see `core-types`; lockstep only the two packages where peer-dep makes it observable.

2. **How does sub-plan 16-2 handle the existing `@spatula/core` re-exports that `tests/private-contract/oss-surface.test.ts` pins?**
   - What we know: `oss-surface.test.ts` imports `* as core` and pins `processCrawlTask`, etc. Those are runtime functions, not types — they stay in `@spatula/core`. Types extracted to `@spatula/core-types` will be re-exported through `@spatula/core` for backward compat.
   - What's unclear: whether sub-plan 16-2 also adds a `oss-surface.test.ts` line asserting `core-types` re-exports.
   - Recommendation: Sub-plan 16-2 extends `oss-surface.test.ts` with one additional describe block: `describe('@spatula/core-types extract preserves @spatula/core type surface', ...)` — asserts that a small set of types `import type { JobConfig, ActionType, ErrorCode } from '@spatula/core'` still resolves (via re-export from core-types).

3. **`@spatula/cli` dual ESM+CJS — which bundler?**
   - What we know: Spec §3.2.3 + SDK-04 require dual ESM+CJS. CLI currently builds ESM-only via `tsc`.
   - What's unclear: Use `tsup` (Rollup-based), `esbuild` direct, or `unbuild`? All viable.
   - Recommendation: **`tsup`** for the CLI publish build. It's the canonical tool for "ESM + CJS + types" dual builds, used widely, ~5 min wiring. Document the swap-in in sub-plan 16-5 prep.

4. **Should `tests/contract/` run against a real Postgres + Redis, or use mocked deps?**
   - What we know: `tests/carveout/forward.test.ts` already runs against real Postgres + Redis via the existing docker-compose. Same infra reuse.
   - What's unclear: Whether `tests/contract/` should be self-contained (slower, but no flake risk from shared infra).
   - Recommendation: **Real infra**, reuse `tests/carveout/fixtures/server.ts` pattern. The contract test's value is testing the SERVED bytes from a live server — not in-process Hono routes.

## Validation Architecture

### Test Framework

| Property           | Value                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Framework          | Vitest 2.1.0                                                                                                |
| Config file        | `tests/contract/vitest.config.ts` (NEW, copies `tests/private-contract/vitest.config.ts` shape)             |
| Quick run command  | `pnpm test:contract` (root script added in sub-plan 16-4)                                                   |
| Full suite command | `pnpm test` (root turbo task; includes contract + unit + integration via `pnpm --filter '@spatula/*' test`) |

### Phase Requirements → Test Map

| Req ID | Behavior                                                                                              | Test Type            | Automated Command                                                                                     | File Exists?                   |
| ------ | ----------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| API-01 | Every 4xx/5xx response matches `{ error: { code, message, requestId, details? } }` shape              | contract             | `pnpm test:contract -- tests/contract/errors.test.ts`                                                 | ❌ Wave 0 (sub-plan 16-4)      |
| API-02 | Every success response carries `X-RateLimit-Limit/-Remaining/-Reset`; 429 carries `Retry-After`       | contract + unit      | `pnpm --filter @spatula/api test -- rate-limit.test.ts && pnpm test:contract -- headers.test.ts`      | ❌ Wave 0                      |
| API-03 | Per-route lookup from `config/rate-limits.yaml`; override via `SPATULA_RATE_LIMITS_PATH`              | unit                 | `pnpm --filter @spatula/api test -- rate-limit-config.test.ts`                                        | ❌ Wave 0                      |
| API-04 | Offset routes carry `Deprecation` + `Sunset` headers; cursor routes don't                             | contract             | `pnpm test:contract -- tests/contract/deprecation.test.ts`                                            | ❌ Wave 0                      |
| API-05 | `GET /api/v1/openapi.json` returns a valid OpenAPI 3.1 doc, identical across calls (cached)           | integration          | `pnpm --filter @spatula/api test -- openapi-route.test.ts`                                            | ❌ Wave 0                      |
| API-06 | `GET /.well-known/spatula-version` returns shape with `version`, `gitSha`, `buildAt`, `supportMatrix` | integration          | `pnpm --filter @spatula/api test -- well-known.test.ts`                                               | ❌ Wave 0                      |
| API-07 | All timestamps in responses parse as ISO 8601 UTC                                                     | contract             | `pnpm test:contract -- tests/contract/timestamps.test.ts`                                             | ❌ Wave 0                      |
| API-08 | `docs/api-idempotency.md` exists with worked examples                                                 | manual-only          | `test -f docs/api-idempotency.md && grep -q 'Idempotency-Key' docs/api-idempotency.md`                | ❌ Wave 0 (doc creation)       |
| API-09 | `docs/cookbook/webhooks.md` exists with HMAC-SHA256 example + retry schedule                          | manual-only          | `test -f docs/cookbook/webhooks.md && grep -q 'HMAC-SHA256' docs/cookbook/webhooks.md`                | ❌ Wave 0 (doc creation)       |
| API-10 | Every OpenAPI route path begins with `/api/v1/`                                                       | contract             | `pnpm test:contract -- tests/contract/versioning.test.ts`                                             | ❌ Wave 0                      |
| API-11 | `docs/architecture.md` § "Export format stability" exists and lists 5 formats                         | manual-only          | `grep -q '5 formats frozen' docs/architecture.md`                                                     | ❌ Wave 0 (doc edit)           |
| API-12 | Contract suite runs in PR CI; every route × every status × every example green                        | contract             | `pnpm test:contract`                                                                                  | ❌ Wave 0 (the whole suite)    |
| API-13 | `docs/deprecation-policy.md` exists with experimental-tag policy                                      | manual-only          | `test -f docs/deprecation-policy.md && grep -q 'experimental' docs/deprecation-policy.md`             | ❌ Wave 0 (doc creation)       |
| API-14 | `docs/compat-policy.md` exists with compat matrix                                                     | manual-only          | `test -f docs/compat-policy.md && grep -q 'compat matrix' docs/compat-policy.md`                      | ❌ Wave 0 (doc creation)       |
| SDK-01 | `@spatula/core-types` has zero runtime deps; ESLint rule active                                       | unit + lint          | `pnpm --filter @spatula/core-types build && pnpm lint`                                                | ❌ Wave 0 (new package)        |
| SDK-02 | `SpatulaClient.createJob/listJobs/getEntities/getJobEvents` are callable and typed                    | unit                 | `pnpm --filter @spatula/client test -- client.test.ts`                                                | ❌ Wave 0 (new package)        |
| SDK-03 | `size-limit` reports `<50KB gzipped` for the measured surface                                         | CI gate              | `pnpm --filter @spatula/client size`                                                                  | ❌ Wave 0                      |
| SDK-04 | `@spatula/cli` publish dry-run produces an installable tarball                                        | manual + integration | `pnpm --filter @spatula/cli pack && npm install -g ./spatula-cli-*.tgz && spatula --version`          | ❌ Wave 0 (publish prep)       |
| SDK-05 | `docs/architecture.md` § SQLite contains benchmark numbers + decision                                 | manual-only          | `grep -q 'SQLite Backend Decision' docs/architecture.md`                                              | ❌ Wave 0                      |
| SDK-06 | Every internal package README has the no-compat notice                                                | manual-only          | `for f in packages/{core,db,queue,api,shared}/README.md; do grep -q 'no compat guarantee' "$f"; done` | ❌ Wave 0                      |
| SDK-07 | `release-please --dry-run` produces release manifests for all 8 packages with `--provenance`          | CI gate              | `pnpm dlx release-please --dry-run --config=release-please-config.json`                               | ❌ Wave 0 (release.yml update) |
| SDK-08 | Integration suite exercises every major endpoint; mocked by default; live via `SPATULA_LIVE_LLM=1`    | integration          | `pnpm --filter @spatula/client test:integration`                                                      | ❌ Wave 0 (new suite)          |

### Sampling Rate

- **Per task commit:** `pnpm typecheck && pnpm --filter <affected-pkg> test` (~1 min)
- **Per wave merge (sub-plan PR):** `pnpm test && pnpm test:contract && pnpm test:carveout && pnpm test:private-contract` (~12-15 min)
- **Phase gate:** Full suite green + `release-please --dry-run` clean + `pnpm --filter @spatula/client size` green + manual checklist of all 22 reqs

### Wave 0 Gaps

- [ ] `tests/contract/vitest.config.ts` — new test suite (sub-plan 16-4)
- [ ] `tests/contract/generated.test.ts` — matrix driver (sub-plan 16-4)
- [ ] `tests/contract/errors.test.ts` — REQ-API-01 conformance (sub-plan 16-4)
- [ ] `tests/contract/deprecation.test.ts` — REQ-API-04 conformance (sub-plan 16-4)
- [ ] `tests/contract/timestamps.test.ts` — REQ-API-07 conformance (sub-plan 16-4)
- [ ] `tests/contract/versioning.test.ts` — REQ-API-10 conformance (sub-plan 16-4)
- [ ] `tests/contract/helpers/ajv-setup.ts` — Ajv 2020 + ajv-formats wiring (sub-plan 16-4)
- [ ] `tests/contract/helpers/server-harness.ts` — spawn API + capture port (copy `tests/carveout/fixtures/server.ts` pattern; sub-plan 16-4)
- [ ] `packages/core-types/` directory + `package.json`/`tsconfig.json`/`vitest.config.ts` (sub-plan 16-2)
- [ ] `packages/core-types/src/errors/codes.ts` — frozen enum (sub-plan 16-2 — staged in `packages/shared` in 16-1 then moved)
- [ ] `packages/client/` directory + full package skeleton (sub-plan 16-2)
- [ ] `packages/client/scripts/gen-error-classes.ts` — codegen (sub-plan 16-2)
- [ ] `packages/client/size-limit.json` — 50KB budget (sub-plan 16-2)
- [ ] `packages/client/tests/integration/` — REQ-SDK-08 suite (sub-plan 16-5)
- [ ] `config/rate-limits.yaml` — per-route config (sub-plan 16-1)
- [ ] `apps/api/src/middleware/rate-limit-config.ts` — YAML loader (sub-plan 16-1)
- [ ] `apps/api/src/routes/openapi.ts` — `/api/v1/openapi.json` (sub-plan 16-3)
- [ ] `apps/api/src/routes/well-known.ts` — `/.well-known/spatula-version` (sub-plan 16-3)
- [ ] `apps/api/src/lib/deprecation-headers.ts` — `applyDeprecationHeaders()` helper (sub-plan 16-1)
- [ ] `docs/api-errors.md`, `docs/compat-policy.md`, `docs/deprecation-policy.md`, `docs/api-idempotency.md`, `docs/cookbook/webhooks.md` (sub-plans 16-2..16-4)
- [ ] `release-please-config.json` updates: add `core-types` + `client` packages + `linked-versions` plugin (sub-plan 16-5)
- [ ] `.github/workflows/release.yml` updates: add `id-token: write`, switch to `--provenance --access public`, drop NPM_TOKEN (sub-plan 16-5)

## Project Constraints (from CLAUDE.md)

No `./CLAUDE.md` exists at the repo root. Project-wide instructions come from:

- **`.planning/codebase/CONVENTIONS.md`** — ESM-only TypeScript, `.js` extensions on relative imports, named exports only, vitest with `globals: true` in packages and `globals: false` in tests/e2e, Prettier (semi + single quotes + 100 line width), ESLint v9 flat config with `consistent-type-imports` already in error mode. **All Phase 16 new files MUST follow these.**
- **`.planning/codebase/TESTING.md`** — tests co-located with source for unit; `tests/<suite>/` for cross-cutting; vitest config patterns established.
- **`.planning/STATE.md`** — pending decisions register: legal entity, npm org, GitHub namespace, domain availability, **SQLite driver decision (Phase 16)**.

**Memory note (`/Users/salar/.claude/projects/.../memory/MEMORY.md`):**

- User preference: "Production-quality per phase (tested, documented, hardened before next phase)" — every sub-plan ships with its own tests + docs; no "we'll fix it in 17" debt.
- Phase 15 progress note: "BLOCK-01 cleared. Public repo at `accidentally-awesome-labs/spatula`. Private SaaS at `accidentally-awesome-labs/spatula-saas`."

## Sources

### Primary (HIGH confidence)

- `@hono/zod-openapi` README — `getOpenAPI31Document()` API surface (https://github.com/honojs/middleware/tree/main/packages/zod-openapi)
- npm trusted publishing GA announcement — OIDC + provenance flow (https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)
- npm docs — trusted publishers + provenance setup (https://docs.npmjs.com/trusted-publishers, https://docs.npmjs.com/generating-provenance-statements/)
- Node.js SQLite documentation — stability status + extension loading (https://nodejs.org/api/sqlite.html)
- Ajv documentation — draft-2020-12 build + ajv-formats (https://ajv.js.org/options.html, https://ajv.js.org/packages/ajv-formats.html)
- `release-please` manifest-releaser docs — linked-versions plugin syntax (https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- `size-limit` README — esbuild plugin config + gzip option (https://github.com/ai/size-limit)
- RFC 8594 — Sunset HTTP header field (https://datatracker.ietf.org/doc/html/rfc8594)
- Existing codebase files — `apps/api/src/middleware/error-handler.ts`, `apps/api/src/middleware/rate-limit.ts`, `apps/api/src/openapi-config.ts`, `apps/api/src/schemas/responses.ts`, `apps/api/src/schemas/pagination.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/cursor.ts`, `packages/shared/src/auth/rate-limit-tiers.ts`, `tests/private-contract/oss-surface.test.ts`, `tests/private-contract/vitest.config.ts`, `release-please-config.json`, `.github/workflows/release.yml`
- npm registry version check via `npm view <pkg> version` for `@hono/zod-openapi` (1.4.0 latest; repo uses 0.19.10), `release-please` (17.6.0), `size-limit` (12.1.0), `ajv` (8.20.0), `ajv-formats` (3.0.1), `better-sqlite3` (12.10.0)

### Secondary (MEDIUM confidence — WebSearch cross-verified with official sources)

- npm trusted publishing operational guide (https://philna.sh/blog/2026/01/28/trusted-publishing-npm/)
- OpenAPI 3.0 → 3.1 migration guide for AJV (https://www.metatech.dev/blog/2025-08-04-openapi-3-0-to-3-1-migration-json-schema-alignment-guide)
- `node:sqlite` 10 features post (https://blog.logrocket.com/node-js-24-features/)
- `release-please` v4 action best-practice cautions (https://danwakeem.medium.com/beware-the-release-please-v4-github-action-ee71ff9de151)

### Tertiary (LOW confidence — flagged for sub-plan-level validation)

- `node:sqlite` FTS5 omission — multiple unofficial issue tickets and `dev.to` posts; the conclusion (FTS5 not compiled in) is unambiguous from Node.js source, but verifying by running `db.exec('CREATE VIRTUAL TABLE fts USING fts5(content)')` against `node:sqlite` in sub-plan 16-5 benchmark first task is the definitive check.
- `release-please` `linked-versions` interaction with `node-workspace`'s `updatePeerDependencies` — derived from issue threads; sub-plan 16-5 dry-run gates this empirically.

## Metadata

**Confidence breakdown:**

- Standard stack: **HIGH** — every library has been verified against npm registry version + official docs.
- Architecture: **HIGH** — all patterns (boot-cache, lazy probe, codegen, linked-versions, size-limit) are documented in primary sources with code examples lifted from those sources.
- Pitfalls: **HIGH** — every pitfall is sourced from a specific library docs section or community issue thread, not speculation.
- SQLite decision: **HIGH** — `node:sqlite` lacks FTS5 (confirmed by Node.js source code search + multiple corroborating community reports). Decision is "stay on `better-sqlite3`" with high certainty before the benchmark even runs.
- BLOCK-04 fallback scope: **MEDIUM** — exact fallback names (`@spatulaai`, `@aalabs/spatula`) suggested in CONTEXT but not pre-verified for availability. Sub-plan 16-5 first task verifies.

**Research date:** 2026-05-19
**Valid until:** 2026-06-19 (30 days for stable libraries; re-verify `node:sqlite` status + `release-please` plugin behavior if Phase 16 stretches past that — Node release cadence is the highest-risk dimension).
