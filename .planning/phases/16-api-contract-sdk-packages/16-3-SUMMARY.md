---
phase: 16-api-contract-sdk-packages
plan: 3
subsystem: api-openapi-sdk
tags: [openapi, well-known, version-probe, compat-policy, ajv-2020, boot-cache, sdk-lazy-probe]

requires:
  - phase: 16-api-contract-sdk-packages
    plan: 1
    provides: ErrorCode enum + envelope shape; openapi-config.ts defaultHook emits frozen DOMAIN.CODE
  - phase: 16-api-contract-sdk-packages
    plan: 2
    provides: SpatulaClient class (I/O-free constructor — D-12 anti-pattern protection); SpatulaVersionMismatchError class in errors/base.ts; class-per-code decodeError dispatcher

provides:
  - "`apps/api/src/openapi-config.ts` gains `getCachedOpenAPISpec(app)` boot-cache helper (D-13) + `_resetOpenAPICache()` test helper"
  - "`apps/api/src/openapi-config.ts` gains `validateExamplesAtBoot(spec)` using Ajv 2020-12 (Pitfall #1) + ajv-formats; walks every response.application/json (example | examples); registers components.schemas so per-response $ref pointers resolve"
  - "`apps/api/src/routes/openapi.ts` — GET /api/v1/openapi.json subrouter serving the cached spec (API-05)"
  - "`apps/api/src/routes/well-known.ts` — GET /.well-known/spatula-version returning { version, gitSha, buildAt, supportMatrix: { minClientMajor, deprecatedClientMajors[] } } (API-06)"
  - "`apps/api/src/app.ts` mounts both new routes AFTER all other routes (load-bearing ordering — spec built only after registry is full); dev-only boot validator gated on NODE_ENV !== 'production'"
  - "`packages/client/src/version-probe.ts` — VersionProbe class with single-in-flight probePromise + verdict-vs-transport cache semantics (D-12)"
  - "`packages/client/src/client.ts` wires probe into request(); new skipVersionProbe constructor opt-out"
  - "`packages/client/src/index.ts` re-exports VersionProbe + VersionProbeOptions for advanced consumers"
  - "`docs/compat-policy.md` — 85-line authoritative compat matrix; 7 cross-links to api-errors / deprecation-policy / private-contract (API-14)"

affects: [16-4, 16-5, sdk-consumers, web-ui-enablement, third-party-tools]

tech-stack:
  added:
    - "ajv@^8.20.0 → workspace root + apps/api devDependencies (Ajv 2020-12 build for OpenAPI 3.1 dialect — Pitfall #1)"
    - "ajv-formats@^3.0.1 → workspace root + apps/api devDependencies (date-time / uri / uuid format validators required by Ajv 2020 build)"
  patterns:
    - "Boot-cache for non-trivial OpenAPI documents — module-level `let cachedSpec` populated by single `app.getOpenAPI31Document(...)` call; byte-stable across requests; downstream CDN-cacheable"
    - "Test-only reset helper (`_resetOpenAPICache()`) prefixed with `_` for in-process test isolation; not part of the public surface"
    - "Ajv 2020 + components-pre-registration: addSchema(componentSchema, '#/components/schemas/Name') before compiling per-response schemas, so local $ref pointers resolve when each response is validated in isolation"
    - "Placeholder-comment-as-insertion-point (`// PHASE-16-MOUNT-POINT-WELLKNOWN`) for atomic Task-N → Task-(N+1) handoffs where insertion ordering is load-bearing"
    - "Lazy-on-first-request probe with two-tier cache semantics: verdict (e.g. SpatulaVersionMismatchError) caches the rejected promise; transient transport error resets probePromise so the next call retries"
    - "Compiled-in `SDK_MAJOR_VERSION` constant (manual bump alongside release-please major) rather than runtime package.json read — avoids JSON-module / bundler import paths"
    - "Graceful-degrade probe: 404 / unparseable body / malformed version string → 'unknown server', does NOT throw; the major-mismatch gate fires ONLY on a successful response that disagrees"

key-files:
  created:
    - "apps/api/src/routes/openapi.ts (GET /api/v1/openapi.json subrouter — serves cached spec)"
    - "apps/api/src/routes/openapi.test.ts (12 test cases — cache stability + spec shape + validator)"
    - "apps/api/src/routes/well-known.ts (GET /.well-known/spatula-version — root-level sibling of /api/v1)"
    - "apps/api/src/routes/well-known.test.ts (5 test cases — frozen 4-key payload + env override + ISO fallback)"
    - "packages/client/src/version-probe.ts (VersionProbe class — D-12 lazy probe + verdict-vs-transport cache)"
    - "packages/client/tests/unit/version-probe.test.ts (13 test cases — probe semantics + client integration)"
    - "docs/compat-policy.md (85-line compat matrix + 12-month window + probe behavior + frozen wire shapes — API-14)"
  modified:
    - "apps/api/src/openapi-config.ts (+115 lines: cachedSpec + getCachedOpenAPISpec + _resetOpenAPICache + validateExamplesAtBoot)"
    - "apps/api/src/app.ts (+15 lines: openapiRoute + wellKnownRoute mounts; dev-only boot validator)"
    - "apps/api/vitest.config.ts (include `src/**/*.test.ts` so route tests co-located with sources are picked up)"
    - "apps/api/package.json (+ajv +ajv-formats devDeps)"
    - "package.json + pnpm-lock.yaml (workspace-root ajv + ajv-formats devDeps)"
    - "packages/client/src/client.ts (probe field + request() awaits ensure() + skipVersionProbe option)"
    - "packages/client/src/index.ts (re-export VersionProbe + VersionProbeOptions)"
    - "packages/client/tests/unit/client.test.ts (existing tests now pass skipVersionProbe: true; mockResolvedValue → mockImplementation for tests that fire the request path repeatedly)"

key-decisions:
  - "Validator pre-registers spec.components.schemas as Ajv schemas before compiling each response schema in isolation — fixes $ref resolution against the OpenAPI document root. Without this, 38 of 38 response-schema compiles fail with `can't resolve reference #/components/schemas/X from id #`."
  - "Validator wraps the per-response compile in try/catch so a single schema compile error doesn't abort the entire walk — reports each failure with route+status context instead of failing fast on the first one"
  - "Test file colocation (src/routes/openapi.test.ts alongside openapi.ts) required broadening vitest config `include` pattern; chosen over a tests/unit/routes/openapi.test.ts placement because the plan's `<files>` block specified the colocated path"
  - "VersionProbe caches a REJECTED promise on SpatulaVersionMismatchError (the verdict is sticky) but RESETS probePromise on any other rejection (transient transport failures shouldn't disable the client). Per CONTEXT.md D-12 'caches result for client lifetime' interpreted as 'caches the VERDICT'."
  - "404 from /.well-known/spatula-version treated as 'unknown server' — probe degrades gracefully so the SDK can talk to non-Spatula servers in tests and older Spatula releases that don't expose the endpoint. The major-mismatch gate fires ONLY on a successful response that disagrees."
  - "SDK_MAJOR_VERSION compiled in as a module-level const (currently 0 for the 0.x pre-release series). Manual bump procedure documented in client.ts JSDoc — release-please bumping the package version triggers a developer-facing TODO to update this constant on the 1.0 cut."
  - "Existing client.test.ts tests had to be migrated from mockResolvedValue to mockImplementation + skipVersionProbe — Response bodies can only be read once, and the same mocked Response can't service both the probe and the subsequent request when both flow through the test's single fetchMock"

requirements-completed: [API-05, API-06, API-14]

duration: 13min
completed: 2026-05-19
---

# Phase 16 Plan 3: OpenAPI Runtime + Version Probe + Compat Policy Summary

**Boot-cached `GET /api/v1/openapi.json` (D-13) + sibling `GET /.well-known/spatula-version` (frozen 4-key payload) + dev-mode boot-time example validator using Ajv 2020 (D-16 + Pitfall #1) + lazy SDK version probe with verdict-vs-transport cache semantics (D-12) + 85-line `docs/compat-policy.md` covering the SDK ↔ server ↔ core-types matrix.**

## Performance

- **Duration:** ~13 minutes
- **Started:** 2026-05-19T15:09:00Z
- **Completed:** 2026-05-19T15:22:00Z
- **Tasks:** 4
- **Files created:** 7
- **Files modified:** 8

## Accomplishments

- `GET /api/v1/openapi.json` serves the boot-cached OpenAPI 3.1 document from a single `app.getOpenAPI31Document(...)` call. Two consecutive requests return byte-identical bodies; downstream CDNs / proxies / contract-test consumers can cache aggressively.
- Dev-mode boot-time example validator catches off-schema OpenAPI examples BEFORE any request handler fires — fails fast in `NODE_ENV !== 'production'` so off-schema examples surface in CI / `pnpm dev`, but never blocks production cold-starts.
- Ajv 2020-12 build wired correctly via `import Ajv2020 from 'ajv/dist/2020.js'` per the research's Pitfall #1 (default Ajv defaults to draft-07; OpenAPI 3.1 uses draft-2020-12). `addFormats(ajv)` registers `date-time`, `uri`, `uuid` validators.
- `GET /.well-known/spatula-version` ships at the root path (not under `/api/v1`) per RFC 8615. Returns the v1-frozen four-key payload: `{ version, gitSha, buildAt, supportMatrix: { minClientMajor, deprecatedClientMajors } }`. For v1.0: `minClientMajor = 1`, `deprecatedClientMajors = []`.
- Lazy version probe in `@spatula/client` fires on first `request()`; constructor stays I/O-free for SSR / Next.js Server Components / Remix loaders. On major-version disagreement throws `SpatulaVersionMismatchError` BEFORE the user's actual request fires.
- Probe cache semantics: verdict cached (mismatch never re-fetches); transient transport error resets the promise so the next call retries. 404 / unparseable body / malformed version string degrade gracefully — the SDK talks fine to non-Spatula servers in tests.
- `skipVersionProbe: true` constructor option for tests, mocked servers, offline scenarios.
- `docs/compat-policy.md` authored at 85 lines, mirroring the tone of `docs/private-contract.md`. Cross-linked to `api-errors.md`, `deprecation-policy.md`, `private-contract.md` (7 references total). Covers compat matrix, major-compat-within-major, mismatch error classes, probe behavior, 12-month support window, frozen wire shapes, experimental surfaces pointer, may-rely-on / may-not-rely-on lists.
- All 391 api tests + 29 client tests + 0 contract tests (out of scope for this plan) green.

## Task Commits

Each task was committed atomically (per-task envelope-shape regression detectable via `git bisect`):

1. **Task 1: Boot-cache OpenAPI document + serve at GET /api/v1/openapi.json + dev-mode example validator** — `79271f3`
   `feat(16-3): boot-cache OpenAPI 3.1 spec + dev-mode example validator`
2. **Task 2: GET /.well-known/spatula-version + handler returning version + git-sha + support-matrix** — `1912241`
   `feat(16-3): add GET /.well-known/spatula-version + support matrix`
3. **Task 3: Lazy version probe in @spatula/client — first-request gated, throws SpatulaVersionMismatchError on major mismatch** — `fdc74ae`
   `feat(16-3): add lazy version probe in @spatula/client (D-12)`
4. **Task 4: Write docs/compat-policy.md — SDK ↔ server ↔ core-types compatibility matrix per spec §3.2.5** — `faf7499`
   `docs(16-3): add compat-policy.md (SDK ↔ server ↔ core-types matrix)`

## OpenAPI runtime measurements

- **Number of OpenAPI paths served:** 32
- **`/api/v1/openapi.json` body size:** 36.5 kB raw (un-gzipped JSON). Well under the typical 100 kB threshold below which CDN edge-caching is cheap.
- **`/.well-known/spatula-version` body size:** ~210 bytes — trivially CDN-cacheable.
- **Number of OpenAPI examples validated at boot:** 0 (zero of the current 32 routes carry explicit `.openapi({ example })` annotations on their response schemas). The validator is wired and proven correct against synthetic fixtures (see openapi.test.ts), but the existing route handlers haven't added examples yet — plan 16-4 (contract tests) will surface coverage gaps that motivate adding examples.
- **`/.well-known/spatula-version` sample payload** (with defaults):
  ```json
  {
    "version": "0.0.0-dev",
    "gitSha": "unknown",
    "buildAt": "2026-05-19T15:22:37.072Z",
    "supportMatrix": { "minClientMajor": 1, "deprecatedClientMajors": [] }
  }
  ```

## Boot-time example validation: failures encountered + how fixed

**Initial run: 38 schema compile errors.** Every per-response schema referenced `#/components/schemas/X` (Tenant, ApiKey, Job, SchemaVersion, Extraction, Entity, Action, Export, Error, EntityListItem, ApiKeyCreated) — but Ajv was compiling each response schema in ISOLATION, so the local `$ref` pointers couldn't resolve against the OpenAPI document root.

**Fix (Rule 1 – Bug):** The validator now pre-registers every entry in `spec.components.schemas` with Ajv via `ajv.addSchema(componentSchema, '#/components/schemas/Name')` BEFORE compiling per-response schemas. Result: 0 errors. Wrapped each compile in try/catch so a single bad schema doesn't abort the walk — each failure is reported with route+status context.

This was caught by the boot validator itself: my initial commit ran `createApp(...)` in 93 existing tests and tripped on the first off-schema reference. The fix went in alongside Task 1 before any merge.

## Version probe behavior on a degraded network

Verified by unit tests in `version-probe.test.ts`:

- **404 from `/.well-known/spatula-version`** → probe returns silently; `request()` proceeds normally. The SDK can talk to non-Spatula servers or older Spatula releases that don't expose `/.well-known`. Verified by `treats 404 from /.well-known as "unknown server" — does NOT throw`.
- **Unparseable body (e.g., `Content-Type: text/plain`, body `"not json"`)** → probe returns silently. Verified by `treats unparseable body as "unknown server" — does NOT throw`.
- **Malformed version string (e.g., `"not-a-version"`)** → probe returns silently (can't parse a major number). Verified by `treats malformed version string (non-semver) as "unknown server" — does NOT throw`.
- **Transport-level reject (e.g., `TypeError: network blip`)** → probePromise reset; next `.ensure()` retries with a fresh fetch. Verified by `on transient transport error, probePromise is reset — second .ensure() retries (2 fetches)`.
- **Major-version mismatch (server: 1.0.0, SDK: 0.x)** → throws `SpatulaVersionMismatchError`; second `.ensure()` re-throws the SAME error WITHOUT a second fetch (verdict cached). Verified by `caches the verdict — two .ensure() calls when mismatched throw the SAME error and only ONE fetch fires`.

## Cross-link evidence — docs/compat-policy.md

```
$ grep -cE 'api-errors|deprecation-policy|private-contract' docs/compat-policy.md
7
```

7 cross-references across the three sibling docs (well above the >= 3 acceptance threshold). The doc opens with a >- block listing the three siblings, then references each at the appropriate semantic point throughout the body.

## Note: contract tests (API-12) in plan 16-4

Plan 16-4 will consume `/api/v1/openapi.json` (this plan's API-05 output) as the source-of-truth for its full route × status × example matrix. The boot-cache (D-13) ensures the contract test sees a stable spec across test runs in the same process. Plan 16-4 also brings the same Ajv 2020-12 instance pattern — the workspace-root `ajv` + `ajv-formats` deps installed in Task 1 of this plan satisfy plan 16-4's runtime requirements without duplicate install.

The 0-examples count is a real coverage gap that plan 16-4's contract test matrix WILL flag — driving the addition of `.openapi({ example: ... })` annotations to existing routes as a backfill task during 16-4.

## Decisions Made

See `key-decisions` in the frontmatter — extracted to STATE.md.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Example validator's per-response Ajv compile failed on every $ref pointer**
- **Found during:** Task 1 (initial `pnpm --filter @spatula/api test` after wiring `validateExamplesAtBoot` into app.ts boot)
- **Issue:** Every per-response schema in the OpenAPI doc references `#/components/schemas/X` (Tenant, ApiKey, Error, …). Compiling each response schema in isolation with `ajv.compile(json.schema)` had no way to resolve those $ref pointers — Ajv reported `can't resolve reference #/components/schemas/X from id #` for all 38 response schemas, blocking every test that called `createApp(...)`.
- **Fix:** Before walking responses, pre-register every entry of `spec.components.schemas` with `ajv.addSchema(componentSchema, '#/components/schemas/Name')`. Then per-response compiles resolve their `$ref`s correctly. Also wrapped the per-response compile in try/catch so a single bad schema reports + the walk continues instead of failing fast.
- **Files modified:** `apps/api/src/openapi-config.ts`
- **Verification:** 38 errors → 0 errors. All 391 api tests pass.
- **Committed in:** `79271f3` (Task 1)

**2. [Rule 1 - Bug] Existing client.test.ts tests broke when probe path consumed the Response body**
- **Found during:** Task 3 (`pnpm --filter @spatula/client test` after adding probe to request())
- **Issue:** Two existing tests (`returns parsed JSON on 2xx` + `sets the Authorization header on every request`) used `mockResolvedValue(new Response(...))` — meaning the SAME Response instance is returned for every `fetchMock()` call. With the new probe path firing BEFORE the API request, the probe consumed the Response body first; the actual API request then got the same Response and tried to read the (already-consumed) body → `TypeError: Body is unusable: Body has already been read`.
- **Fix:** Migrated the two tests to `mockImplementation(() => new Response(...))` so each call gets a fresh Response. Also passed `skipVersionProbe: true` so the tests exercise only the request path (matching their original intent). Other existing tests that already used `mockImplementation` were updated to also pass `skipVersionProbe: true` for consistency.
- **Files modified:** `packages/client/tests/unit/client.test.ts`
- **Verification:** All 29 client tests pass.
- **Committed in:** `fdc74ae` (Task 3)

**3. [Rule 3 - Blocking] vitest config did not include `src/**/*.test.ts`**
- **Found during:** Task 1 (first `pnpm --filter @spatula/api test -- src/routes/openapi.test.ts` invocation)
- **Issue:** The plan placed test files alongside their sources (`apps/api/src/routes/openapi.test.ts`, `well-known.test.ts`). The existing vitest config only had `include: ['tests/**/*.test.ts']`, so the new tests were silently skipped.
- **Fix:** Broadened `include` to `['tests/**/*.test.ts', 'src/**/*.test.ts']`. Pre-existing tests under `tests/unit/**` continue to be collected.
- **Files modified:** `apps/api/vitest.config.ts`
- **Verification:** 391 api tests (was 374 in plan 16-1) — net +17 from this plan's new tests minus 0 regressions.
- **Committed in:** `79271f3` (Task 1)

**4. [Rule 3 - Blocking] Ajv import shape — package default-export interop**
- **Found during:** Task 1 (initial TS compile of openapi-config.ts)
- **Issue:** `ajv@8.20.0` ships its 2020 build with CommonJS-style export semantics; depending on `esModuleInterop` + bundler resolution, `import Ajv2020 from 'ajv/dist/2020.js'` may bind to a `{ default: AjvClass }` wrapper or directly to the class. Same for `ajv-formats`.
- **Fix:** At call-site, accept both shapes: `const Ajv: any = (Ajv2020 as any).default ?? Ajv2020;` and `const addFmts: any = (addFormats as any).default ?? addFormats;`. Cheap defensive coercion; future-proof against package shape changes.
- **Files modified:** `apps/api/src/openapi-config.ts`
- **Verification:** All tests pass without import-resolution errors.
- **Committed in:** `79271f3` (Task 1)

---

**Total deviations:** 4 (2 Rule 1, 2 Rule 3)
**Impact on plan:** All four were necessary for correctness. Deviation #1 made the boot validator actually usable (it would otherwise reject every real OpenAPI doc with components). Deviation #2 cleaned up a pre-existing test fragility surfaced by the new probe path. Deviations #3 and #4 were tooling realities (vitest include glob + Ajv default-export interop) not captured in the plan but required to actually run the new tests.

## Issues Encountered

- **Vercel-plugin skill auto-injections (`vercel-functions`, `next-forge`, `bootstrap`, `next-upgrade`, `nextjs`) fired on every Read of `package.json`, `apps/api/**`, and on `pnpm build`.** Same false-positive pattern noted in plan 16-1 + 16-2 summaries. Spatula is a Hono-based standalone Node.js server (not Vercel serverless), ESM-only npm packages (not Vercel-deployed apps), not Next.js. All recommendations were noted and disregarded.

- **Parallel plan-16-4 agent committed `9546336` (`feat(16-4): scaffold tests/contract suite ...`) between Tasks 2 and 3 of this plan.** The two plans don't conflict (16-4 only touches `tests/contract/*`; 16-3 only touches `apps/api/src/routes/{openapi,well-known}.*`, `apps/api/src/{openapi-config,app}.ts`, `packages/client/**`, `docs/compat-policy.md`). No file overlaps; both branches commit cleanly to main. Visible only as an extra `git log` entry in the interleaved history.

## User Setup Required

None — no new environment variables required at v1.0 launch. Optional dev-time env vars:
- `SPATULA_VERSION` — exposed in `/.well-known/spatula-version` `.version` field (defaults to `'0.0.0-dev'`)
- `GIT_SHA` — exposed as `.gitSha` (defaults to `'unknown'`); CI sets `GIT_SHA=${GITHUB_SHA}` during the build job (added in plan 16-5's release workflow)
- `BUILD_AT` — exposed as `.buildAt` (defaults to `new Date().toISOString()` at boot — i.e. process-start time, not actual build time, which is fine for `pnpm dev`)

## Next Phase Readiness

- **Plan 16-4 ready:** `/api/v1/openapi.json` is the contract-test data source; boot-cache (D-13) ensures it's byte-stable across runs. Ajv 2020 + ajv-formats are already in workspace devDeps. The 0-examples coverage gap is documented above as an explicit backfill item.
- **Plan 16-5 ready:** the dev-only boot validator gates on `NODE_ENV !== 'production'`, so production cold-starts are unaffected (no Ajv compile work). SDK version-probe behavior is locked at v0 → SDK_MAJOR_VERSION constant in `client.ts` carries a JSDoc note pointing to the v1.0.0 bump procedure.
- **No blockers** for plan 16-4 (contract tests) or 16-5 (release infra). Both can start in parallel.

---
*Phase: 16-api-contract-sdk-packages*
*Plan: 3*
*Completed: 2026-05-19*

## Self-Check: PASSED

All 7 created files exist on disk; all 4 task commits present in `git log`. Verification gates green:
- @spatula/api: 391/391 tests pass (was 374 at plan 16-1 close; +5 well-known + 12 openapi)
- @spatula/client: 29/29 tests pass (+ 13 new version-probe cases on top of plan 16-2's 16)
- size-limit gate (plan 16-2 carry-forward): -92 B / 50 kB — still well under budget after probe wiring
- codegen drift gate (plan 16-2 carry-forward): `pnpm gen:errors && git diff --exit-code` clean (25 classes)
- docs/compat-policy.md: 85 lines, 7 cross-links, contains all required acceptance phrases (compat matrix, SpatulaVersionMismatchError, FeatureUnavailableError, 12 months, skipVersionProbe)
