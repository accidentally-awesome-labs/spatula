# Phase 16: API Contract Hardening + SDK Packages - Context

**Gathered:** 2026-05-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Freeze the v1 REST contract rigorously enough that a web UI can be built against it blind, and ship the three semver-stable npm packages (`@spatula/cli`, `@spatula/client`, `@spatula/core-types`) plus five no-compat-guarantee internal packages (`@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/api`, `@spatula/shared`) with npm `--provenance` publishing wired end-to-end.

**In scope:**

- Error envelope sweep + frozen error-code enum (API-01)
- Rate-limit response headers + `config/rate-limits.yaml` (API-02, API-03)
- Cursor-first pagination canonicalization + `Deprecation`/`Sunset` headers on offset (API-04)
- `GET /api/v1/openapi.json` runtime endpoint from single source-of-truth (API-05)
- `GET /.well-known/spatula-version` (API-06)
- ISO-8601 UTC timestamp sweep (API-07)
- Idempotency / webhook / experimental-tag / compat-policy documentation (API-08, API-09, API-13, API-14)
- `/api/v1/` URL versioning declaration + v2 cut plan (API-10)
- Export format stability declaration (API-11)
- `tests/contract/` suite generated from OpenAPI (API-12)
- `@spatula/core-types` package extraction (SDK-01)
- `@spatula/client` package build + ≤50 KB `size-limit` gate (SDK-02, SDK-03)
- `@spatula/cli` publish-readiness (SDK-04)
- SQLite backend benchmark + decision (SDK-05)
- Internal packages no-compat README declaration (SDK-06)
- `release-please` topology + `--provenance` + `--access public` (SDK-07)
- SDK integration test suite gated by `SPATULA_LIVE_LLM` (SDK-08)

**Pre-phase gate:** BLOCK-04 (npm `@spatula` org owned OR fallback scope chosen + documented). Gates only the release sub-plan (16-5).

**Out of scope:**

- SSE / browser auth / CORS (Phase 17)
- Security hardening + legal (Phase 18)
- Deployment runbooks (Phase 19)
- Docs site infrastructure (Phase 20)
- Contributor infra + CI topology (Phase 21)
- Launch mechanics (Phase 22)
- Reference web UI (out of OSS scope per spec §2.2)

</domain>

<decisions>
## Implementation Decisions

### Sub-Plan Decomposition (5 sub-plans)

- **D-01:** **5 sub-plans, error-envelope-first sequence**:
  1. **16-1** — Error envelope sweep + rate-limit response headers + `config/rate-limits.yaml` (covers API-01, API-02, API-03; new `X-RateLimit-Reset` header). Owns the manual audit of every `c.json({error:...})` and `SpatulaError` throw site, and reshapes existing pagination envelope `{ total, limit, hasMore, nextCursor }` → `{ data, nextCursor, hasMore }` with `Deprecation` + `Sunset` headers on offset (API-04).
  2. **16-2** — `@spatula/core-types` extract + `@spatula/client` build (covers SDK-01, SDK-02, SDK-03; emits the frozen error-code enum and `class-per-code` typed SDK errors via codegen). Includes ESLint rule blocking non-type imports from `@spatula/core-types` and `size-limit` threshold committed at `packages/client/size-limit.json`.
  3. **16-3** — `GET /api/v1/openapi.json` runtime endpoint + `GET /.well-known/spatula-version` + lazy version probe in `@spatula/client` + `docs/compat-policy.md` (covers API-05, API-06, API-14, success criterion 5).
  4. **16-4** — `tests/contract/` suite generated from OpenAPI (covers API-12, success criterion 1). Gates everything via PR CI; runs full route × status × example matrix from served `/openapi.json`. Also covers idempotency / webhook / experimental-tag / compat / timestamps documentation (API-07, API-08, API-09, API-10, API-11, API-13) since these are doc-only and naturally batch with the test suite write-up.
  5. **16-5** — Release infrastructure: `release-please` topology for 8 packages, internal-package no-compat README declarations, `@spatula/cli` publish prep, SQLite benchmark + decision committed to `docs/architecture.md`, SDK integration test suite scaffolding, dry-run publish to staging registry with `--provenance` + `--access public` (covers SDK-04, SDK-05, SDK-06, SDK-07, SDK-08, success criteria 3 + 6).
- **D-02:** **One PR per sub-plan.** Each sub-plan = own branch (`feat/wave-6-2-{NN}-{slug}`) + own PR + merge-commit. **Different from Phase 15's single-PR pattern** because Phase 16 is 2–3× larger (22 reqs vs 8) and the sub-plans are more independent. Smaller review surfaces; some sub-plans can be reviewed in parallel.
- **D-03:** **BLOCK-04 gates only sub-plan 16-5.** Sub-plans 16-1 through 16-4 proceed without BLOCK-04 resolution. Server-side error sweep, package source code, OpenAPI runtime, and contract tests all land on the OSS repo without publishing anything. Only the `release-please` dry-run + provenance publish in 16-5 requires the npm `@spatula` org (or documented fallback scope).
- **D-04:** **Sequencing locked:** 16-1 → 16-2 → 16-3 → 16-4 → 16-5. Rationale: the frozen error-code enum lives in `@spatula/core-types` (16-2) but the **clean-slate enum design** (D-06) needs the OpenAPI route registry from the existing `@hono/zod-openapi` inline registrations as its source enumeration. Sub-plan 16-1 therefore performs the audit and emits the canonical enum into `packages/shared` as a staging location; 16-2 moves it into `@spatula/core-types`. Server sweep (16-1) updates routes; 16-4 gates against the resulting shape.

### Error-Code Enum Design (API-01)

- **D-05:** **Category-prefixed naming style: `DOMAIN.CODE`.** Examples: `JOB.NOT_FOUND`, `EXTRACTION.QUOTA_EXCEEDED`, `AUTH.INVALID_TOKEN`, `RATE_LIMIT.EXCEEDED`, `VERSION.MISMATCH`, `VALIDATION.SCHEMA`. Self-documenting categories prevent collisions as the enum grows under additive-only 1.x policy. Does NOT match the current flat convention (`NOT_FOUND`, `VALIDATION_ERROR`) — sweep migrates every site.
- **D-06:** **Source-of-truth migration: clean-slate, derived from OpenAPI route surface.** Sub-plan 16-1 enumerates every route in the existing `@hono/zod-openapi` registry, identifies every intended 4xx/5xx for each route, then writes a fresh canonical enum (no copy-paste from current ~12 ad-hoc codes in `error-handler.ts`). Every `c.json({error:...})` site + `SpatulaError` throw is rewritten to use the new enum. Rationale: avoids legacy-string baggage in a frozen-forever enum; ensures coverage maps 1:1 against the contract.
- **D-07:** **Full route audit + contract tests enforce drift.** Sub-plan 16-1 visits every route and every throw site to bring each into envelope conformance. Sub-plan 16-4 contract tests then gate against drift. Belt AND suspenders — highest confidence for v1.0 freeze.
- **D-08:** **`details` field shape: free-form `Record<string, unknown>`.** Envelope is `{ error: { code, message, requestId, details? } }`. The envelope itself is frozen at v1; the `details` content evolves freely per error site (validation errors populate `{ field, issues[] }`; quota errors populate `{ limit, remaining, resetAt }`; etc.). NOT a per-code typed discriminated union — that would require every new code to define a new TS type and tightly couple server + client at the type level.

### Public Packages: `@spatula/core-types` + `@spatula/client`

- **D-09:** **`@spatula/core-types` boundary: types + zod + enums only.** Includes: TypeScript interface declarations, zod schemas, error-code enum (D-05), action-type enum (52 actions), status enums, `JobConfig` / `FieldDef` / `ExtractionResult` shapes as types. **Excludes:** runtime helpers, builder functions, constants, factory functions. Zero runtime deps; zod as peer dep. Matches spec §3.2.2 wording verbatim ("type-only exports + zod schemas").
- **D-10:** **ESLint rule: block all non-type imports from `@spatula/core-types`.** Custom rule (implemented via `no-restricted-imports` with type-import detection, or a small `@spatula-internal/eslint-plugin`) enforces consumer-side discipline. Forbids `import { foo } from '@spatula/core-types'` unless `foo` is a type. Ensures the zero-runtime-deps promise holds at the consumer boundary.
- **D-11:** **SDK typed errors: class-per-code, all extend `SpatulaApiError`.** `QuotaExceededError`, `JobNotFoundError`, `ValidationError`, `VersionMismatchError`, etc. Each subclass has typed `.code`, `.details`, `.requestId`, `.status`. Auto-generated via codegen step (16-2) from the frozen enum in `@spatula/core-types`. Users get `if (err instanceof QuotaExceededError) { ... }` ergonomics with IDE narrowing. Codegen script lives in `packages/client/scripts/gen-error-classes.ts` (planner names exactly).
- **D-12:** **Version probe: lazy on first request.** `SpatulaClient` constructor returns immediately with zero I/O. First API call awaits `GET /.well-known/spatula-version`, caches result for the client lifetime, throws `SpatulaVersionMismatchError` on major mismatch BEFORE the actual request fires. Subsequent calls use cached result. Pro: no constructor I/O surprises; browser-friendly; spec wording "on instantiation" satisfied because the throw happens on first request which is the first observable side-effect of using the instance.

### OpenAPI Source-of-Truth + Contract Tests

- **D-13:** **OpenAPI runtime: generate-once-at-boot + cache.** App boot calls `app.getOpenAPI31Document(...)` exactly once on the existing `OpenAPIHono` registry, freezes the JSON document in memory, and `GET /api/v1/openapi.json` serves the cached document. Zero per-request CPU cost. The single source-of-truth is the live Zod registrations across `apps/api/src/routes/*.ts` — drift impossible by construction.
- **D-14:** **Drift detection: contract tests roundtrip.** `tests/contract/` fetches the live `/api/v1/openapi.json` from a running test server, then for every `(route, response-status, example)` tuple: hits the route, validates the response body against the OpenAPI schema using `ajv` (compiled from the served JSON Schema). Catches both spec drift (schema wrong) and runtime drift (handler returns wrong shape) in one suite. No separate committed `openapi-snapshot.json`.
- **D-15:** **Contract test structure: generated from OpenAPI tree.** Test runner reads the served `/openapi.json` at suite boot, iterates every `(path, method, responses[status], examples[])` tuple, generates a test case per tuple via `describe.each` + `it.each`. Adding a new route auto-adds test coverage. One generator file (e.g., `tests/contract/generated.test.ts`) drives the entire matrix. Matches success criterion 1 wording ("every route, every 4xx/5xx code, every OpenAPI example") mechanically.
- **D-16:** **Example validation: `ajv` at app boot in dev.** App boot in `NODE_ENV !== 'production'` extracts every example from the OpenAPI tree, compiles each schema with `ajv`, validates the example body against the schema. Fails boot if any example is off-schema. Cheap (one-shot at startup), zero runtime cost in prod (skip in `NODE_ENV=production`), catches drift before deploy. Same validation also re-runs in `tests/contract/` as part of D-14 belt-and-suspenders.

### Claude's Discretion (planner / researcher decide)

- **`config/rate-limits.yaml` shape** — granularity (per method+path, per route-group, hierarchical inheritance), override mechanism (env-var layering, file merge, both), default fallback when route unmatched, hot-reload vs boot-only. Recommendation: per-route-group with method overrides; file merge via `SPATULA_RATE_LIMITS_PATH` env var pointing at a layered overlay; boot-only reload for v1.
- **`release-please` topology for 8 packages** — single repo-level config vs per-package configs; how exact-peer-dep lockstep between `@spatula/core-types` and `@spatula/client` is enforced through release-please (component grouping or post-release script). Recommendation: single `release-please-config.json` at repo root with `release-please-manifest.json`; grouped releases for the locked-peer-dep pair via `linked-versions` config.
- **SQLite benchmark gate timing** — sub-plan 16-5 runs the `node:sqlite` vs `better-sqlite3` benchmark as its first task. Scope: WAL transactions + FTS5 + existing query patterns from `LocalDataSource`. If switch criteria all pass (feature parity + zero regression + non-experimental), spec budgets +3 sessions which would push Phase 16 to 11–13 sessions; planner decides whether to fold the swap into 16-5 or split into 16-6.
- **`experimental:` tag policy machinery** (API-13) — spec §3.3.11 states v1.0 ships with **zero experimental surfaces** (policy is dormant at launch). Phase 18 introduces the first experimental surface (forensic-extractions admin endpoint). Decision: Phase 16 ships the **documented policy** in `docs/deprecation-policy.md` + the `client.experimental.*` namespace **scaffolding** (empty proxy on `SpatulaClient`) so Phase 18 can drop endpoints into it without an SDK release. No `Deprecation` / `Sunset` header emission machinery until first experimental surface ships.
- **Cursor format/algorithm** — already partially built (Wave 3-3b composite `(entity_id, extraction_id)` cursor per PROJECT.md Key Decisions). Planner reuses existing cursor codec; no new format. Document cursor opacity contract in `docs/api-cursor.md` or inline in OpenAPI description.
- **`Deprecation` + `Sunset` header format for offset pagination** — recommend RFC 8594 `Sunset: <HTTP-date>`, `Deprecation: <HTTP-date>`, `Link: </docs/cursor-pagination>; rel="successor-version"`. Sunset target: v2.0 GA (~12 months post-v1.0, exact date set when v2 is planned).
- **Internal-package no-compat notice format** — single canonical template repeated verbatim at the top of each internal package's README, plus `package.json` `description` field includes the warning. Planner drafts the template.
- **Codegen pipeline for error classes** — sub-plan 16-2 contains a `scripts/gen-error-classes.ts` script that reads the enum from `@spatula/core-types` and writes `packages/client/src/errors/generated.ts`. Committed output (not generated at build time) so SDK consumers see the classes in source. CI verifies regen produces identical output.

### Folded Todos

None — `gsd-tools todo match-phase 16` returned zero matches.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Wave 6 / Phase 14 design spec (authoritative for all v1.1 phases)

- `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md` — full v1.1 design.
  - §2.1 Goals (item 2: web-UI enablement)
  - §2.3 Success Criteria
  - §3.2 New Packages (npm-publishable) — `@spatula/client`, `@spatula/core-types`, `@spatula/cli`
  - §3.2.4 Internal packages no-compat declaration (template)
  - §3.2.5 SDK ↔ server ↔ core-types compat matrix (full policy)
  - §3.3.1 New endpoints (`/openapi.json`, `/.well-known/spatula-version`)
  - §3.3.3 Error envelope (exact JSON shape; "frozen at v1; additive-only in 1.x")
  - §3.3.4 Rate-limit headers (4 headers; `config/rate-limits.yaml` overrides)
  - §3.3.5 Pagination (cursor-first canonical; offset deprecated)
  - §3.3.6 Idempotency (already implemented; this wave documents)
  - §3.3.7 Timestamps (ISO 8601 UTC)
  - §3.3.8 Webhook contract
  - §3.3.9 API versioning (`/api/v1/`; v2 cut plan)
  - §3.3.10 Export format stability
  - §3.3.11 `experimental:` tag policy
  - §3.6 Release Artifacts (npm `--provenance`, internal-package no-compat policy)
  - §3.2.3 SQLite backend decision (`node:sqlite` vs `better-sqlite3` gates)

### Roadmap + requirements

- `.planning/ROADMAP.md` §"Phase 16: API Contract Hardening + SDK Packages" — goal, 6 success criteria, BLOCK-04 pre-phase gate, depends-on chain.
- `.planning/REQUIREMENTS.md` API-01..API-14 (14 API requirements) + SDK-01..SDK-08 (8 SDK requirements) — 22 acceptance items planner must check off.
- `.planning/PROJECT.md` — vision, principles, internal-vs-public-package compat policy, key decisions log.
- `.planning/STATE.md` — pre-launch blocker statuses (BLOCK-04 still open as of 2026-05-18), pending decisions register (SQLite driver).

### Prior phase context (carry-forward decisions)

- `.planning/phases/15-carveout-migration-squash/15-CONTEXT.md` — Phase 15 decisions that bind Phase 16:
  - D-08 merge-commit strategy (Phase 16 changes to one-PR-per-sub-plan per D-02 above)
  - Two-journal Drizzle model (`__drizzle_migrations_oss` vs `__drizzle_migrations_saas`) locked
  - `DEFAULT_RATE_LIMIT` collapse — per-route customization explicitly deferred to Phase 16 (now D-02 sub-plan 16-1)
  - `GET /api/v1/auth/me` shape (no `{data}` envelope; top-level fields) is precedent for Phase 16 auth-me-style endpoints

### Codebase maps (current architecture state)

- `.planning/codebase/ARCHITECTURE.md` — module boundaries, will be refreshed post-Phase-16 with new `@spatula/core-types` + `@spatula/client` packages.
- `.planning/codebase/STRUCTURE.md` — package layout (`packages/{core,db,queue,shared}` + `apps/{api,cli}`); Phase 16 adds `packages/{core-types,client}` and `tests/contract/`.
- `.planning/codebase/CONVENTIONS.md` — ESM-only TypeScript, `.js` extensions on relative imports, vitest config patterns, commit message style (`feat(carveout):` precedent → `feat(api-contract):` or `feat(sdk):` for Phase 16).
- `.planning/codebase/TESTING.md` — existing test patterns (`tests/e2e/`, `tests/carveout/`, `tests/private-contract/`); new `tests/contract/` follows same shape.
- `.planning/codebase/STACK.md` — Turborepo + pnpm; Hono API; Drizzle; BullMQ; vitest; `@hono/zod-openapi`.
- `.planning/codebase/CONCERNS.md` — known issues that may surface during sweep.
- `.planning/codebase/INTEGRATIONS.md` — external integrations (OpenRouter, Ollama, Stripe-now-private, Sentry, OTel).

### Existing code surfaces (sub-plan 16-1 audit targets)

- `apps/api/src/middleware/error-handler.ts` — current envelope `{ error: { code, message, requestId } }` (missing `details`); `mapErrorToStatus` has ~12 ad-hoc codes (`NOT_FOUND`, `VALIDATION_ERROR`, `AUTH_ERROR`, `FORBIDDEN`, `CONFLICT`, `QUEUE_ERROR`, `TIMEOUT_ERROR`, `RATE_LIMIT_ERROR`, `QUOTA_EXCEEDED`, `NETWORK_ERROR`, `STATE_ERROR`, default `INTERNAL_ERROR`).
- `apps/api/src/middleware/rate-limit.ts` — currently emits `X-RateLimit-Limit` + `X-RateLimit-Remaining` + `Retry-After`. **Missing `X-RateLimit-Reset` (epoch seconds)** required by API-02 + spec §3.3.4.
- `apps/api/src/openapi-config.ts` — `OpenAPIHono` factory with `defaultHook` returning the error envelope on validation failure; will host the generate-once-at-boot logic for D-13.
- `apps/api/src/schemas/responses.ts` — `errorResponseSchema` (current shape, needs `details?` added per D-08); `dataResponse` / `listResponse` helpers (need cursor-pagination wrapper added per spec §3.3.5).
- `apps/api/src/schemas/pagination.ts` — current envelope `{ total, limit, hasMore, nextCursor }` mixes cursor + offset; sub-plan 16-1 reshapes to `{ data, nextCursor, hasMore }` canonical (drops `total` from cursor-mode; keeps for deprecated offset-mode with `Deprecation` + `Sunset` headers).
- `apps/api/src/routes/*.ts` — every route handler enumerated for sweep + contract-test generation.
- `packages/shared/src/index.ts` — `SpatulaError`, `DEFAULT_RATE_LIMIT`; staging location for new error-code enum before 16-2 moves it to `@spatula/core-types`.
- `packages/core/src/**` — extraction targets for `@spatula/core-types` (type-only exports, zod schemas, action-type enum, JobConfig / FieldDef shapes).

### Docs created during this phase

- `docs/api-errors.md` — frozen error-code enum reference (NEW; sub-plan 16-2).
- `docs/compat-policy.md` — SDK ↔ server ↔ core-types matrix per spec §3.2.5 (NEW; sub-plan 16-3).
- `docs/deprecation-policy.md` — experimental-tag policy, 6-month max lifetime, `client.experimental.*` namespace contract (NEW; sub-plan 16-4).
- `docs/api-idempotency.md` — worked examples of `Idempotency-Key` (NEW; sub-plan 16-4; functionality already shipped Wave 3-4).
- `docs/cookbook/webhooks.md` — HMAC-SHA256 verification + retry schedule (1m, 5m, 30m, 2h, 8h → DLQ) + dedup pattern (NEW; sub-plan 16-4).
- `docs/architecture.md` §SQLite — `node:sqlite` vs `better-sqlite3` benchmark + decision (UPDATED; sub-plan 16-5).
- `config/rate-limits.yaml` — per-route limits replacing tier presets (NEW; sub-plan 16-1).
- `packages/client/size-limit.json` — 50KB threshold (NEW; sub-plan 16-2).
- `packages/core-types/README.md`, `packages/client/README.md`, `packages/cli/README.md` — public-package READMEs (NEW or UPDATED; sub-plans 16-2, 16-5).
- Internal-package READMEs (`packages/{core,db,queue,api,shared}/README.md`) — no-compat notice (UPDATED; sub-plan 16-5).

### Reverse-contract anchor (do not break)

- `docs/private-contract.md` — 5-package surface that `spatula-saas` consumes. Phase 16's `@spatula/api` changes (createApp factory shape) must not silently break this contract; `tests/private-contract/` from Phase 15 catches at PR time.
- `tests/private-contract/oss-surface.test.ts` — already runs in CI; sub-plan 16-2 changes to `@spatula/core` (extracting types out to `@spatula/core-types`) must keep this green via either re-export shim or coordinated `spatula-saas` update.

### Runbooks (touched, not created in this phase)

- `docs/runbooks/upgrade.md` — no-migration-downgrade + expand-contract policies from Phase 15; Phase 16 does NOT modify migration tracking but the SQLite-driver swap (if SDK-05 gates pass) is a runtime change worth a one-line entry.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **`OpenAPIHono` from `@hono/zod-openapi`** (`apps/api/src/openapi-config.ts`) — already builds a route registry from inline `app.openapi(...)` calls per route. Reused as the single source-of-truth for D-13 (generate-once-at-boot) and D-15 (contract test generation).
- **`errorResponseSchema`** (`apps/api/src/schemas/responses.ts`) — existing zod definition that frontends and tests can already consume; sub-plan 16-1 adds the optional `details` field and updates `code` from `string` to `z.nativeEnum(ErrorCode)` once 16-2 moves the enum to `@spatula/core-types`.
- **`SpatulaError`** (`packages/shared/src/errors.ts` — implied from `error-handler.ts` import) — base class for all server-side typed errors; sub-plan 16-1 introduces subclasses keyed to the new `DOMAIN.CODE` enum (e.g., `JobNotFoundError extends SpatulaError`).
- **`DEFAULT_RATE_LIMIT`** (`packages/shared`) — Phase 15 collapsed the tier presets to this single export. Sub-plan 16-1 keeps `DEFAULT_RATE_LIMIT` as the fallback for unmatched routes while introducing per-route overrides via `config/rate-limits.yaml`.
- **`@hono/zod-openapi` `defaultHook`** (`apps/api/src/openapi-config.ts`) — already returns the error envelope on validation failure; sub-plan 16-1 ensures it emits the new envelope shape (with `details?` and `DOMAIN.CODE` enum value).
- **Vitest config patterns** (`apps/api/vitest.config.ts`, `tests/carveout/vitest.config.ts`, `tests/private-contract/vitest.config.ts`) — new `tests/contract/vitest.config.ts` copies the established shape; the generated test file pattern (`describe.each` + `it.each`) is standard vitest usage.
- **Turborepo task graph** — `pnpm test`, `pnpm build` already topo-aware; new `tests/contract/` plugs into `turbo test` filter; new `packages/core-types` + `packages/client` plug into the build graph automatically once `package.json` is added.
- **CI workflow files** (`.github/workflows/ci.yml`, `release.yml`, `release-please.yml`) — sub-plan 16-4 adds `tests/contract/` to the existing PR CI pipeline; sub-plan 16-5 extends `release.yml` with `--provenance` flags and adds a `release-dry-run.yml` per spec §3.5 directory tree.
- **`release-please-config.json` (NEW)** — repo has `release-please.yml` workflow already (per CONCERNS.md / STATE.md); sub-plan 16-5 introduces the monorepo manifest mode for the 8 packages.

### Established Patterns

- **ESM-only TypeScript** (`"type": "module"` across all packages) — `@spatula/core-types` + `@spatula/client` both inherit; `@spatula/client` is ESM-only by spec §3.2.1; `@spatula/cli` is dual ESM+CJS per spec §3.2.3 and SDK-04 (existing pattern, since CLI consumers may use `require()` in legacy scripts).
- **`.js` extensions on relative imports** — convention across all packages; both new packages comply.
- **OpenAPI inline registration via `app.openapi(...)`** — every route in `apps/api/src/routes/*.ts` already calls `app.openapi(routeDefinition, handler)`. Sub-plan 16-3 reuses this registry; sub-plan 16-4 enumerates it for contract test generation.
- **`@hono/zod-openapi` `defaultHook`** for validation-error envelope — existing pattern; sub-plan 16-1 ensures the new envelope shape is emitted consistently from both the `defaultHook` and the route handlers.
- **Tenant-scoped middleware ordering** (`tenant` → `auth` → `rate-limit` → handler) — preserved; rate-limit middleware update for `X-RateLimit-Reset` is a pure additive header change.
- **Per-tenant rate limiting via Redis sliding window Lua script** (`apps/api/src/middleware/rate-limit.ts`) — existing primitive; sub-plan 16-1 layers per-route lookup against `config/rate-limits.yaml` ON TOP OF the existing per-tenant primitive.
- **`tests/carveout/` + `tests/private-contract/` topology** — Phase 15 precedent for top-level `tests/<suite>/` dirs with their own `vitest.config.ts`; `tests/contract/` follows identical shape.

### Integration Points

- **`apps/api/src/openapi-config.ts`** — owns `OpenAPIHono` factory; gains `getOpenAPI31Document` caching call at boot, exposes cached document to a new route handler in `apps/api/src/routes/openapi.ts` (NEW; sub-plan 16-3) mounted at `/api/v1/openapi.json`.
- **`apps/api/src/app.ts`** — mounts new `/api/v1/openapi.json` route + new `/.well-known/spatula-version` route (sub-plan 16-3); error-handler middleware ordering unchanged.
- **`apps/api/src/middleware/rate-limit.ts`** — gains `X-RateLimit-Reset` header (epoch seconds = `now + WINDOW_MS / 1000` rounded); gains per-route lookup against `config/rate-limits.yaml` loaded at boot (sub-plan 16-1).
- **`apps/api/src/middleware/error-handler.ts`** — gains `details` field passthrough; gains category-prefixed enum (`DOMAIN.CODE`); `mapErrorToStatus` rewritten to switch on enum values (sub-plan 16-1).
- **`apps/api/src/schemas/responses.ts`** — `errorResponseSchema` gains optional `details`; new `cursorListResponse<T>` helper added; existing `listResponse<T>` deprecated with JSDoc pointing at cursor variant (sub-plan 16-1).
- **`apps/api/src/schemas/pagination.ts`** — `paginationEnvelopeSchema` split into `cursorEnvelopeSchema` (canonical) + `offsetEnvelopeSchema` (deprecated); routes opt into one or the other; offset routes set `Deprecation` + `Sunset` headers via a small `applyDeprecationHeaders()` helper (sub-plan 16-1).
- **`apps/api/src/routes/*.ts`** — every route handler audited (sub-plan 16-1): error throw sites updated to use new enum + subclasses; offset-mode routes annotated with deprecation headers.
- **`apps/cli/src/api/client.ts`** — eventually migrates from raw fetch to `@spatula/client`; full migration is **out of scope for Phase 16** (raised as deferred idea). For Phase 16, CLI uses `@spatula/client` only for the version-probe check during `spatula doctor`; full migration is a v1.2 cleanup item.
- **`packages/core/src/index.ts`** — re-exports of types + zod schemas + enums become re-exports from `@spatula/core-types` (sub-plan 16-2); existing public-API consumers (`@spatula/api`, `@spatula/queue`) update imports accordingly; ESLint rule (D-10) enforces from the consumer side.
- **`packages/db/src/schema/*.ts`** — Drizzle schemas don't move into `@spatula/core-types`; they stay in `@spatula/db` since they have runtime side effects (table object construction). Types derived from schemas (`typeof tenants.$inferSelect`) can be re-exported through `@spatula/core-types` as `type Tenant = ...` if needed by SDK consumers.
- **`packages/queue/src/worker-deps.ts`** — no surface change; workers don't directly consume `@spatula/core-types` (they consume `@spatula/core` runtime).

### Constraints

- **Frozen at v1 (additive-only in 1.x):** Error-code enum, error envelope shape, cursor pagination shape, rate-limit header set, OpenAPI route surface, export format shapes (JSON/CSV/Parquet/SQLite/DuckDB). Every Phase-16 design decision must hold for the full v1 lifetime — there is no "fix in v1.1" escape hatch.
- **Internal packages no compat guarantee at TS-API level** per spec §3.2.4; Phase 16 extracts public-API surface into `@spatula/core-types` precisely to give that one package the compat guarantee.
- **`@spatula/client` measured surface ≤50 KB gzipped** for `import { SpatulaClient, createJob, listJobs, getEntities }` built with `esbuild --bundle --minify --format=esm --platform=browser`. CI gate via `size-limit`. Bundle additions in Phase 17/18 (SSE client, experimental namespace) eat into this budget.
- **BLOCK-04** must be cleared before sub-plan 16-5 publishes; if `@spatula` org is unavailable, fallback scope choice is documented in `packages/*/package.json` + `docs/compat-policy.md` § package-naming.
- **`tests/private-contract/` from Phase 15** must stay green across the type-extraction in sub-plan 16-2 — either via re-export shim in `@spatula/core` or coordinated `spatula-saas` mocked-consumer update.
- **No experimental surfaces at v1.0** per spec §3.3.11 — Phase 16 ships the policy doc + namespace scaffolding but the first experimental endpoint lands in Phase 18 (forensic-extractions).

</code_context>

<specifics>
## Specific Ideas

- **Category-prefixed enum naming (`DOMAIN.CODE`)** — chosen because the frozen-forever lifetime + additive-only 1.x policy makes collision avoidance more valuable than typing brevity. Categories observed during analysis: `JOB`, `EXTRACTION`, `SCHEMA`, `RECONCILIATION`, `ENTITY`, `EXPORT`, `AUTH`, `TENANT`, `RATE_LIMIT`, `QUOTA`, `VERSION`, `VALIDATION`, `IDEMPOTENCY`, `WEBHOOK`, `INTERNAL`.
- **Clean-slate enum derivation from OpenAPI surface (D-06)** — sub-plan 16-1's audit task literally walks the `@hono/zod-openapi` registry programmatically, lists every route's possible 4xx/5xx, then a human-curation step writes the canonical enum. Avoids the temptation to copy-paste legacy strings. The walk script lives in `scripts/derive-error-codes.ts` (planner names exactly).
- **Codegen for SDK error classes (D-11)** — committed output (not build-time generated) so SDK consumers grep `class QuotaExceededError` and find a real source file. CI runs the codegen + `git diff --exit-code` to catch drift.
- **Lazy version probe (D-12)** — first-request semantics specifically chosen so `SpatulaClient` is usable in browser-side server-rendered contexts (SSR / RSC) where constructor I/O would break hydration.
- **OpenAPI generate-once-at-boot (D-13)** — preferred over per-request because the document is large (~200KB JSON for a mature surface) and serializing on every probe wastes CPU; also makes the served document byte-identical across requests, which simplifies CDN caching downstream.
- **Example validation at boot in dev (D-16)** — running this in dev only (not prod) is a deliberate trade: example drift in prod doesn't affect users (examples are docs, not code paths), but blocking deploy on bad examples gives the author immediate feedback. Same checks re-run in CI via `tests/contract/`.

</specifics>

<deferred>
## Deferred Ideas

- **CLI migration to `@spatula/client`** — the CLI currently uses raw fetch in `apps/cli/src/api/client.ts`. Full migration to `@spatula/client` is out of scope for Phase 16 (would expand sub-plan 16-2 by ~3 sessions). Phase 16 uses `@spatula/client` only for the version-probe check during `spatula doctor`. Full migration deferred to a v1.2 cleanup phase or folded into Phase 22 polish if time permits.
- **Webhook delivery rebuild** — spec §3.3.8 describes a desired webhook contract (HMAC-SHA256 + 5-attempt retry schedule + dedup). Phase 16 only **documents** the existing implementation in `docs/cookbook/webhooks.md` (API-09); any gaps between current code and spec wording are noted in the cookbook but rebuild is deferred to Phase 18 or v1.2 if the gap is wider than docs can paper over.
- **Idempotency replay test suite expansion** — API-08 is doc-only ("functionality already shipped in Wave 3-4"). Spot-check the existing replay behavior in sub-plan 16-4 but don't expand the suite unless a contract test fails.
- **OpenAPI client codegen for non-TS languages** — DEFER-02 covers Python/Java/Go SDKs as community-welcome. Phase 16 does NOT publish auto-gen specs targeting `openapi-generator-cli` consumers. The `/openapi.json` endpoint is itself the artifact; community can run codegen against it.
- **Cursor pagination format documentation in `docs/api-cursor.md`** — Wave 3-3b composite cursor is opaque to consumers. Phase 16 documents the opacity contract (consumers treat cursor as opaque string, don't parse) in OpenAPI descriptions; standalone `docs/api-cursor.md` deferred unless docs site Phase 20 needs it.
- **`experimental:` tag header emission machinery** — Phase 16 ships the policy doc + `client.experimental.*` namespace scaffolding, but the `Deprecation` + `Sunset` header emission (for when an experimental graduates or is removed) doesn't land until the first experimental surface ships in Phase 18.
- **Internal-package version-bump automation for `spatula-saas`** — coordination with the private repo's CI to pick up pre-release `v1.x.x-next.N` tags is described in spec §3.1.6 + §8.2. Phase 16 publishes pre-release tags on every `main` push (release-please dry-run); the **consuming-side** automation in `spatula-saas` is out of scope here.

### Reviewed Todos (not folded)

None — `gsd-tools todo match-phase 16` returned no matches; nothing to defer.

</deferred>

---

_Phase: 16-api-contract-sdk-packages_
_Context gathered: 2026-05-19_
</content>
</invoke>
