---
phase: 16
slug: api-contract-sdk-packages
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-19
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `16-RESEARCH.md` § "Validation Architecture" (lines 751–818).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 2.1.0 (existing; shared across `packages/*` + `apps/*` + `tests/<suite>/`) |
| **Config files** | `tests/contract/vitest.config.ts` (NEW, sub-plan 16-4; copies `tests/private-contract/vitest.config.ts` shape); `packages/{core-types,client}/vitest.config.ts` (NEW, sub-plan 16-2) |
| **Quick run command** | `pnpm typecheck && pnpm --filter <affected-pkg> test` |
| **Full suite command** | `pnpm test && pnpm test:contract && pnpm test:carveout && pnpm test:private-contract` |
| **Estimated runtime** | Quick: ~60s · Full: ~12–15min · Contract-only: ~60–120s after Wave 0 (route count × example count) |
| **Release dry-run** | `pnpm dlx release-please release-pr --dry-run --config-file=release-please-config.json --manifest-file=.release-please-manifest.json` (sub-plan 16-5) |
| **Size-limit gate** | `pnpm --filter @spatula/client size` (sub-plan 16-2; CI gate per SDK-03) |

---

## Sampling Rate

- **After every task commit:** `pnpm typecheck && pnpm --filter <affected-pkg> test` (≤60s feedback)
- **After every sub-plan PR merge:** `pnpm test && pnpm test:contract && pnpm test:carveout && pnpm test:private-contract` (12–15min)
- **Before `/gsd:verify-work`:** Full suite green + `release-please --dry-run` clean + `pnpm --filter @spatula/client size` ≤50KB + manual checklist of all 22 reqs
- **Max feedback latency:** 60s for quick; 15min for full-suite gate

---

## Per-Task Verification Map

> Maps every phase requirement to its automated check. Plan-level Task IDs are populated by `gsd-planner` and back-filled here at execution time. `File Exists` column reflects pre-Phase-16 state.

| Req ID | Sub-plan | Behavior | Test Type | Automated Command | File Exists | Status |
|--------|----------|----------|-----------|-------------------|-------------|--------|
| API-01 | 16-1 → 16-4 | Every 4xx/5xx response matches `{ error: { code, message, requestId, details? } }`; error codes use `DOMAIN.CODE` enum | contract + unit | `pnpm test:contract -- tests/contract/errors.test.ts` | ❌ Wave 0 | ⬜ pending |
| API-02 | 16-1 | Every success response carries `X-RateLimit-Limit/-Remaining/-Reset`; 429 carries `Retry-After` | contract + unit | `pnpm --filter @spatula/api test -- rate-limit.test.ts && pnpm test:contract -- tests/contract/headers.test.ts` | ❌ Wave 0 | ⬜ pending |
| API-03 | 16-1 | Per-route lookup from `config/rate-limits.yaml`; override via `SPATULA_RATE_LIMITS_PATH`; boot-only reload | unit | `pnpm --filter @spatula/api test -- rate-limit-config.test.ts` | ❌ Wave 0 | ⬜ pending |
| API-04 | 16-1 | Offset routes carry `Deprecation` + `Sunset` headers; cursor routes don't; envelope reshaped to `{ data, nextCursor, hasMore }` | contract | `pnpm test:contract -- tests/contract/deprecation.test.ts` | ❌ Wave 0 | ⬜ pending |
| API-05 | 16-3 | `GET /api/v1/openapi.json` returns valid OpenAPI 3.1 doc, byte-identical across calls (boot-cached) | integration | `pnpm --filter @spatula/api test -- openapi-route.test.ts` | ❌ Wave 0 | ⬜ pending |
| API-06 | 16-3 | `GET /.well-known/spatula-version` returns `{ version, gitSha, buildAt, supportMatrix }` | integration | `pnpm --filter @spatula/api test -- well-known.test.ts` | ❌ Wave 0 | ⬜ pending |
| API-07 | 16-1 → 16-4 | All timestamps in responses parse as ISO 8601 UTC (`Z` suffix) | contract | `pnpm test:contract -- tests/contract/timestamps.test.ts` | ❌ Wave 0 | ⬜ pending |
| API-08 | 16-4 | `docs/api-idempotency.md` exists with worked `Idempotency-Key` examples | manual-only | `test -f docs/api-idempotency.md && grep -q 'Idempotency-Key' docs/api-idempotency.md` | ❌ Wave 0 | ⬜ pending |
| API-09 | 16-4 | `docs/cookbook/webhooks.md` exists with HMAC-SHA256 example + 1m/5m/30m/2h/8h retry schedule | manual-only | `test -f docs/cookbook/webhooks.md && grep -q 'HMAC-SHA256' docs/cookbook/webhooks.md` | ❌ Wave 0 | ⬜ pending |
| API-10 | 16-4 | Every OpenAPI route path begins with `/api/v1/` (versioning lock) | contract | `pnpm test:contract -- tests/contract/versioning.test.ts` | ❌ Wave 0 | ⬜ pending |
| API-11 | 16-4 | `docs/architecture.md` § "Export format stability" lists 5 frozen formats | manual-only | `grep -q '5 formats frozen' docs/architecture.md` | ❌ Wave 0 | ⬜ pending |
| API-12 | 16-4 | Contract suite runs in PR CI; every route × every status × every example green | contract | `pnpm test:contract` (matrix from served `/openapi.json` via Ajv 2020) | ❌ Wave 0 | ⬜ pending |
| API-13 | 16-4 | `docs/deprecation-policy.md` exists with experimental-tag policy + `client.experimental.*` scaffolding declaration | manual-only + unit | `test -f docs/deprecation-policy.md && pnpm --filter @spatula/client test -- experimental-namespace.test.ts` | ❌ Wave 0 | ⬜ pending |
| API-14 | 16-3 | `docs/compat-policy.md` exists with full compat matrix per spec §3.2.5 | manual-only | `test -f docs/compat-policy.md && grep -q 'compat matrix' docs/compat-policy.md` | ❌ Wave 0 | ⬜ pending |
| SDK-01 | 16-2 | `@spatula/core-types` has zero runtime deps (zod as peer); ESLint rule active blocking non-type imports | unit + lint | `pnpm --filter @spatula/core-types build && pnpm lint` (rule fails if violation introduced) | ❌ Wave 0 | ⬜ pending |
| SDK-02 | 16-2 | `SpatulaClient.{createJob,listJobs,getEntities,getJobEvents}` callable + typed; class-per-code errors generated | unit | `pnpm --filter @spatula/client test -- client.test.ts` | ❌ Wave 0 | ⬜ pending |
| SDK-03 | 16-2 | `size-limit` reports `<50KB` gzipped for measured surface (esbuild ESM browser build) | CI gate | `pnpm --filter @spatula/client size` | ❌ Wave 0 | ⬜ pending |
| SDK-04 | 16-5 | `@spatula/cli` publish dry-run produces installable tarball | manual + integration | `pnpm --filter @spatula/cli pack && npm install -g ./spatula-cli-*.tgz && spatula --version` | ❌ Wave 0 | ⬜ pending |
| SDK-05 | 16-5 | `docs/architecture.md` § SQLite contains `node:sqlite` vs `better-sqlite3` benchmark numbers + decision (default remains `better-sqlite3` unless FTS5+WAL parity gate passes) | manual-only | `grep -q 'SQLite Backend Decision' docs/architecture.md` | ❌ Wave 0 | ⬜ pending |
| SDK-06 | 16-5 | Every internal package README has the no-compat notice (verbatim canonical template) | manual-only | `for f in packages/{core,db,queue,api,shared}/README.md; do grep -q 'no compat guarantee' "$f" || exit 1; done` | ❌ Wave 0 | ⬜ pending |
| SDK-07 | 16-5 | `release-please --dry-run` produces release manifests for all 8 packages with `--provenance` + `--access public`; trusted-publishing OIDC wired | CI gate | `pnpm dlx release-please release-pr --dry-run --config-file=release-please-config.json --manifest-file=.release-please-manifest.json` | ❌ Wave 0 | ⬜ pending |
| SDK-08 | 16-5 | Integration suite hits every major endpoint; mocked by default; opts in via `SPATULA_LIVE_LLM=1` | integration | `pnpm --filter @spatula/client test:integration` (default mock); `SPATULA_LIVE_LLM=1 pnpm --filter @spatula/client test:integration` (opt-in live) | ❌ Wave 0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Sub-plan 16-1 (Error envelope + rate-limit headers + cursor pagination):
- [ ] `apps/api/src/lib/deprecation-headers.ts` — `applyDeprecationHeaders()` helper
- [ ] `apps/api/src/middleware/rate-limit-config.ts` — `config/rate-limits.yaml` loader + `SPATULA_RATE_LIMITS_PATH` env-var overlay
- [ ] `config/rate-limits.yaml` — per-route limits + default fallback
- [ ] Tests: `apps/api/src/middleware/rate-limit.test.ts`, `apps/api/src/middleware/rate-limit-config.test.ts`
- [ ] `packages/shared/src/error-codes.ts` — staged frozen enum (moved to `@spatula/core-types` by 16-2)

Sub-plan 16-2 (`@spatula/core-types` + `@spatula/client`):
- [ ] `packages/core-types/` — `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/{index.ts,errors/codes.ts,schemas/*.ts}`, `README.md`
- [ ] `packages/client/` — `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/{index.ts,client.ts,errors/{base.ts,generated.ts}}`, `README.md`
- [ ] `packages/client/scripts/gen-error-classes.ts` — codegen reading `@spatula/core-types` enum → `packages/client/src/errors/generated.ts` (committed output; CI runs `pnpm gen:errors && git diff --exit-code`)
- [ ] `packages/client/size-limit.json` — 50KB threshold with `@size-limit/esbuild`
- [ ] `.eslintrc` / flat-config rule blocking non-type imports from `@spatula/core-types` (use `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true`)
- [ ] `packages/core-types/tests/`, `packages/client/tests/` — unit suites
- [ ] Re-export shim or coordinated `spatula-saas` update so `tests/private-contract/oss-surface.test.ts` stays green

Sub-plan 16-3 (`/openapi.json` + `/.well-known/spatula-version` + version probe + compat policy):
- [ ] `apps/api/src/routes/openapi.ts` — `GET /api/v1/openapi.json` (boot-cached via `getOpenAPI31Document()`)
- [ ] `apps/api/src/routes/well-known.ts` — `GET /.well-known/spatula-version`
- [ ] `packages/client/src/version-probe.ts` — lazy one-shot probe with `SpatulaVersionMismatchError` on major mismatch
- [ ] `docs/compat-policy.md` — full SDK ↔ server ↔ core-types matrix per spec §3.2.5
- [ ] Tests: `apps/api/src/routes/openapi-route.test.ts`, `apps/api/src/routes/well-known.test.ts`, `packages/client/tests/version-probe.test.ts`

Sub-plan 16-4 (Contract tests + docs):
- [ ] `tests/contract/vitest.config.ts` — copies `tests/private-contract/vitest.config.ts` shape
- [ ] `tests/contract/helpers/ajv-setup.ts` — **MUST `import Ajv2020 from 'ajv/dist/2020'`** (NOT default Ajv; pitfall #1 in 16-RESEARCH.md)
- [ ] `tests/contract/helpers/server-harness.ts` — boots API + captures port (copy `tests/carveout/fixtures/server.ts`)
- [ ] `tests/contract/generated.test.ts` — matrix driver iterating served `/openapi.json` via `describe.each` + `it.each`
- [ ] `tests/contract/{errors,headers,deprecation,timestamps,versioning}.test.ts` — explicit per-REQ suites
- [ ] `docs/api-errors.md`, `docs/api-idempotency.md`, `docs/cookbook/webhooks.md`, `docs/deprecation-policy.md`
- [ ] `docs/architecture.md` § "Export format stability" edit
- [ ] `.github/workflows/ci.yml` — add `pnpm test:contract` to PR CI
- [ ] `apps/api/src/openapi-config.ts` — add boot-time example validation when `NODE_ENV !== 'production'`
- [ ] `packages/client/src/experimental.ts` — empty proxy scaffolding for `client.experimental.*` namespace

Sub-plan 16-5 (Release infra + SQLite + CLI publish + SDK integration):
- [ ] `release-please-config.json` — manifest mode + `linked-versions` for `@spatula/core-types` ↔ `@spatula/client` lockstep + `node-workspace` plugin with `"merge": false` (pitfall #3 in 16-RESEARCH.md)
- [ ] `.release-please-manifest.json` — initial versions per package
- [ ] `.github/workflows/release.yml` — `id-token: write` job permission, switch to `npm publish --provenance --access public`, remove `NPM_TOKEN` references after trusted-publishing setup
- [ ] `.github/workflows/release-dry-run.yml` — PR-time dry run
- [ ] BLOCK-04 verification step: confirm npm `@spatula` org owned OR commit fallback scope decision to `packages/*/package.json` + `docs/compat-policy.md`
- [ ] `packages/{core,db,queue,api,shared}/README.md` — no-compat notice header (canonical template)
- [ ] `packages/cli/README.md` + `packages/client/README.md` + `packages/core-types/README.md` — public-package READMEs
- [ ] `docs/architecture.md` § "SQLite Backend Decision" — benchmark methodology + `node:sqlite` FTS5 gap finding (pre-decided per 16-RESEARCH §State of the Art); decision: stay on `better-sqlite3@12.10.0`
- [ ] `packages/client/tests/integration/{create-job,list-jobs,get-entities,get-job-events,version-probe}.test.ts` — SDK-08 suite (mocked default; live via `SPATULA_LIVE_LLM=1`)
- [ ] Benchmark scripts: `packages/db/bench/sqlite-comparison.ts` (one-shot, output committed to docs only)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `docs/api-idempotency.md` reads as accurate, complete worked examples | API-08 | Doc-only ("functionality already shipped Wave 3-4"); read-through gate, not behavior gate | Author reads doc end-to-end; runs the curl examples against a local server; confirms `Idempotency-Key` reuse returns cached `201` |
| `docs/cookbook/webhooks.md` retry schedule matches existing implementation | API-09 | Cookbook describes existing primitive; gap acknowledgment, not new code | Author cross-references `packages/queue/src/webhook-*` retry schedule against doc table |
| `docs/deprecation-policy.md` clearly establishes `client.experimental.*` contract | API-13 | Policy doc — no behavior at v1.0 (zero experimental surfaces ship) | Author confirms doc explains 6-month max lifetime + scaffold purpose + Phase 18 first-surface plan |
| `docs/compat-policy.md` matrix is correct + spec §3.2.5-aligned | API-14 | Matrix is a contract description, not testable behavior | Author cross-references the published matrix against `package.json` `dependencies` + the spec |
| `docs/architecture.md` SQLite section reads honestly about FTS5 gap | SDK-05 | Benchmark+decision doc | Author confirms numbers committed, decision rationale matches Phase-16-research finding (FTS5 absent in `node:sqlite`) |
| Internal-package no-compat README notice readability | SDK-06 | Notice is canonical template — easy to grep-verify; hard to assess readability | Author scans each rendered README on GitHub preview |
| BLOCK-04 resolution before 16-5 publish step | SDK-07 | Pre-phase gate; either `@spatula` org owned (verified by `npm org ls @spatula`) OR fallback scope documented | Author runs `npm org ls @spatula` OR commits fallback decision to docs + package.json |
| `release-please-config.json` `linked-versions` actually produces lockstep bumps on a synthetic PR | SDK-07 | Easier to validate by inducing a test bump than by reading config | Author triggers a dry-run PR that bumps `@spatula/core-types` and confirms `@spatula/client` bumps to same version |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies (back-filled at plan time)
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (above lists)
- [ ] No watch-mode flags in CI invocations
- [ ] Feedback latency < 60s for quick, < 15min for gate
- [ ] `nyquist_compliant: true` set in frontmatter (after gsd-checker confirms)

**Approval:** pending (will sign after gsd-plan-checker confirms plan-level coverage)
