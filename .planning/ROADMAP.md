# Roadmap: Spatula

## Milestones

- ✅ **v1.0 Foundation through Hosted Platform** — Phases 1–13 (shipped 2026-04-20)
- 🚧 **v1.1 Public Launch (Wave 6 / Phase 14)** — Phases 15–22 (in progress, started 2026-05-11)

---

## v1.1 Public Launch — Overview

v1.1 takes the production-grade codebase shipped at v1.0 close and turns it into a **publicly launched open-source project**: public GitHub repo, npm packages with provenance, signed multi-arch container images on GHCR, docs site live at `docs.spatula.dev`, clean OSS-vs-private-SaaS carve-out, a stable public REST contract, and web-UI **enablement** (SDK + SSE + browser OIDC) — the reference web UI itself remains a non-goal and belongs in a sibling repo or the private SaaS. Target release: `v1.0.0-rc.1` → `v1.0.0` after a 2-week public preview.

**Authoritative spec:** `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md`
**Source plan (Phase 15 only, already drafted):** `docs/superpowers/plans/2026-04-20-wave-6-1-carveout-migration-squash.md`

---

## Phases

**Phase Numbering:**

- Integer phases (1–13): v1.0 (shipped)
- Integer phases (15–22): v1.1 milestone — one per Wave 6 sub-plan (no Phase 14: that label is the milestone, not an executable phase)
- Decimal phases (e.g., 16.1): reserved for urgent insertions during execution

### v1.0 (shipped)

<details>
<summary>✅ v1.0 — Phases 1–13 (shipped 2026-04-20)</summary>

See `.planning/MILESTONES.md` for the full v1.0 wave breakdown and per-phase deliverables. v1.0 closed with ~294 test files (2,302 unit + 71 integration tests in the CLI/SQLite flow alone) and includes Wave 1–5 plus the 2026-04-20 post-review cleanup.

</details>

### v1.1 Public Launch (in progress)

- [x] **Phase 15: Carve-out & Migration Squash** — Extract billing/Stripe/metering to private `spatula-saas`; squash OSS migrations to `000_v1_baseline.sql`; ship reverse-contract test. (completed 2026-05-17)
- [x] **Phase 16: API Contract Hardening + SDK Packages** — Freeze error envelope, rate-limit headers, cursor-first pagination, runtime OpenAPI; ship `@spatula/client` + `@spatula/core-types` with npm provenance. (completed 2026-05-19)
- [x] **Phase 17: Browser Auth, SSE, CORS** — Ship `GET /api/v1/jobs/:id/events` SSE with `Last-Event-ID` resume, wildcard-subdomain CORS, Dex-OIDC local recipe, key rotation, cross-tenant isolation audit. (completed 2026-05-20)
- [ ] **Phase 18: Security Hardening & Legal** — Prompt-injection defense (≥10 adversarial fixtures vs pinned models), redaction sweep, full DSR surface; CLA, TRADEMARK, brand license, audit-CI hardening.
- [ ] **Phase 19: Deployment & Self-Host Excellence** — k8s kustomize + Render blueprint + multi-arch cosign-signed images + SBOM + backup/upgrade/reverse-proxy/hardware-sizing runbooks.
- [ ] **Phase 20: Docs Site Infrastructure + Content** — VitePress on Cloudflare Pages at `docs.spatula.dev`; auto-gen API/CLI references; WCAG 2.1 AA; OIDC cookbooks for Auth0/Keycloak/Google Workspace.
- [ ] **Phase 21: Contributor Infra + CI Topology** — CODE_OF_CONDUCT 2.1, GOVERNANCE, ROADMAP, CODEOWNERS, devcontainer, Dependabot/Renovate, preflight/unit+int/contract/e2e/audit/release/release-dry-run CI split, mock-vs-live LLM test split.
- [ ] **Phase 22: Launch Mechanics (RC → GA)** — Brand assets, pre-flip secret-scan + manual category audit gate, RC.1 cut, 2-week beta with `preview-bug` issue label, zero-Critical gate, GA cut, coordinated announcement, 72h launch-day monitoring.

---

## Dependency Graph

```
Phase 15 (Carve-out)
    │
    ▼
Phase 16 (API Contract + SDK)        ← biggest; unblocks most downstream
    │
    ├──▶ Phase 17 (Browser Auth + SSE + CORS)
    │        │   needs error envelope frozen (early in 16)
    │        ▼
    │    Phase 18 (Security + Legal)
    │        partial parallel with 17; uses error envelope for security errors
    │
    ├──▶ Phase 19 (Deploy + Runbooks)
    │        needs 16 release-workflow outputs (rate-limits.yaml, OpenAPI artifact)
    │
    └──▶ Phase 20 (Docs Site)
              needs OpenAPI from 16 for auto-gen API reference
              │
              ▼
         Phase 21 (Contributor Infra + CI)
              consumes CLA from 18; depends on 16 CI topology
              │
              ▼
         Phase 22 (Launch: brand + RC → GA)
              gates on ALL of 15–21 acceptance-verified
```

**Honest parallelism (per spec §4):** 2 streams peak, not 5. Once Phase 16 freezes the error-envelope contract (early), Phase 17 design + Phase 18 threat-model work and Phase 20 content authoring can run in a parallel editor window. Integration points still wait for upstream completion. Phase 21 is mostly serial on Phase 20 (CI must wire the docs-site build job). Phase 22 is strictly downstream.

---

## Phase Details

### Phase 15: Carve-out & Migration Squash

**Goal**: OSS-only server has zero Stripe/billing/metering surface area; pre-Wave-6 migrations collapse into a single baseline; the contract the private `spatula-saas` repo will consume is locked down with a reverse-contract test.
**Depends on**: Nothing (entry phase). v1.0 codebase + Wave-5 cleanup is the substrate.
**Requirements**: CARVE-01, CARVE-02, CARVE-03, CARVE-04, CARVE-05, CARVE-06, CARVE-07, CARVE-08
**Pre-phase gate**: BLOCK-01 (`accidentally-awesome-labs/spatula-saas` private GitHub repo exists before the carve-out PR merges).
**Success Criteria** (what must be TRUE):

1. `tests/carveout/` passes end-to-end against an OSS-only server: remote push/pull, tenant CRUD without plan fields, config-driven quota enforcement, admin metrics aggregation with no `usage_records` reference, OpenAPI shape with no billing/stripe paths.
2. `tests/private-contract/` passes — a mocked private consumer importing `@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/shared`, `@spatula/api` exactly as `spatula-saas` does breaks the build when a consumed export is silently removed; `docs/private-contract.md` records residual-risk acknowledgments (SQL FK breakage, runtime-behavior drift, RLS/trigger changes).
3. Fresh `pnpm db:migrate` on an empty Postgres applies exactly `000_v1_baseline.sql` (under `__drizzle_migrations_oss`); no billing tables exist in the resulting schema; pre-Wave-6 dev DBs documented as wipe-and-reseed in `docs/runbooks/upgrade.md`.
4. `git grep -i 'stripe\|billing\|usage_records\|plan: '` returns zero hits under `apps/api/`, `packages/db/`, `packages/queue/`, `.env.example`, and OpenAPI seed fixtures; `docs/architecture.md` republished with the new dependency diagram and zero billing mentions.
5. No-migration-downgrade policy and expand-contract-only schema-change rule are committed to `docs/runbooks/upgrade.md` and referenced from the carve-out PR description.
   **Plans:** 6/6 plans complete
   Plans:

- [x] 15-01-PLAN.md — BLOCK-01 verify + pre-cut snapshot + coupling re-grep + feature branch
- [x] 15-02-PLAN.md — Filter-repo move of Section A files → spatula-saas (history preserved) + OSS deletion
- [x] 15-03-PLAN.md — Strip in-place coupling across 5 packages + new GET /api/v1/auth/me + CLI rewire
- [x] 15-04-PLAN.md — Migration squash to 0000_v1_baseline.sql + \_\_drizzle_migrations_oss + pg_dump equivalence gate
- [x] 15-05-PLAN.md — Forward tests/carveout/ + reverse tests/private-contract/ (TS surface + SQL schema lint) + PR CI wiring
- [x] 15-06-PLAN.md — docs/architecture.md refresh + docs/private-contract.md + docs/runbooks/upgrade.md + final grep gate + open PR (merge-commit)
      **Estimated effort**: 3 active sessions

### Phase 16: API Contract Hardening + SDK Packages

**Goal**: Make the v1 REST contract rigorous enough that a web UI can be built against it blind; ship the three semver-stable npm packages (`@spatula/cli`, `@spatula/client`, `@spatula/core-types`) plus five no-compat-guarantee internal packages, with provenance publishing wired end-to-end.
**Depends on**: Phase 15 (clean OSS surface required before contract freeze).
**Requirements**: API-01, API-02, API-03, API-04, API-05, API-06, API-07, API-08, API-09, API-10, API-11, API-12, API-13, API-14, SDK-01, SDK-02, SDK-03, SDK-04, SDK-05, SDK-06, SDK-07, SDK-08
**Pre-phase gate**: BLOCK-04 (npm `@spatula` org owned OR explicit fallback scope documented before any `@spatula/*` package is published).
**Success Criteria** (what must be TRUE):

1. `tests/contract/` runs in CI on every PR and passes — every route, every 4xx/5xx code conforming to `{ error: { code, message, requestId, details? } }`, every OpenAPI example validates against its schema, deprecation/sunset headers present on offset-paginated routes.
2. `size-limit` CI guard reports `@spatula/client` (gzipped bundle for `SpatulaClient + createJob + listJobs + getEntities`, built with `esbuild --bundle --minify --format=esm --platform=browser`) at ≤50 KB; threshold committed in `packages/client/size-limit.json`.
3. `release-please` dry-run publishes all eight packages (3 public + 5 internal) cleanly to a staging registry with `--provenance` and `--access public` flags applied per spec §3.6.
4. SDK integration smoke (`packages/client/tests/integration/`) hits every major endpoint (`createJob`, `listJobs`, `getEntities`, `getJobEvents`, etc.) and passes; the suite is mocked by default and opts in via `SPATULA_LIVE_LLM=1`.
5. `GET /api/v1/openapi.json` and `GET /.well-known/spatula-version` are live and the SDK runs a version probe on instantiation that emits a `SpatulaVersionMismatchError` on major mismatch (verified by integration test); `docs/compat-policy.md` is committed.
6. SQLite backend decision is committed to `docs/architecture.md` with `node:sqlite` vs `better-sqlite3` benchmark numbers; default remains `better-sqlite3` unless WAL+FTS parity, zero-regression, and non-experimental gates all pass.

**Plans:** 5/5 plans complete
Plans:
- [x] 16-1-PLAN.md — Error envelope sweep + rate-limit headers + cursor-first pagination + offset deprecation (API-01..API-04)
- [x] 16-2-PLAN.md — @spatula/core-types extract + @spatula/client build + class-per-code typed errors via codegen + size-limit + ESLint type-only-import rule (SDK-01..SDK-03)
- [x] 16-3-PLAN.md — GET /api/v1/openapi.json boot-cached + GET /.well-known/spatula-version + lazy version probe + docs/compat-policy.md (API-05, API-06, API-14)
- [x] 16-4-PLAN.md — tests/contract/ suite generated from served /openapi.json via Ajv2020 + idempotency/webhook/experimental-tag/versioning/timestamps/export-format docs (API-07..API-13)
- [x] 16-5-PLAN.md — Release infrastructure: BLOCK-04 verify + release-please monorepo manifest + linked-versions + trusted publishing OIDC + provenance + internal-package no-compat READMEs + @spatula/cli publish prep + SQLite benchmark + SDK integration smoke suite (SDK-04..SDK-08)
**Estimated effort**: 8–10 active sessions
**UI hint**: yes

### Phase 17: Browser Auth, SSE, CORS

**Goal**: Close the web-UI-enablement gap on the auth + streaming side — a browser client running through Dex OIDC can subscribe to live job events, reconnect cleanly after disconnect, and never see tenant B's data.
**Depends on**: Phase 16 (needs frozen error envelope + version probe + scope list).
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-07, AUTH-08
**Success Criteria** (what must be TRUE):

1. A Playwright browser smoke client in `tests/e2e/browser/` performs the full chain — OIDC login via Dex → `POST /api/v1/ws-token` → SSE subscribe on `GET /api/v1/jobs/:id/events?token=` → mid-stream disconnect → reconnect with `Last-Event-ID` → resume from buffered events — without manual intervention.
2. `tests/isolation/` proves tenant A cannot read tenant B via any route — jobs, entities, extractions, actions, exports, admin where applicable — every assertion is `403` or `404` with the standard error envelope (no leaked tenant data in messages or details).
3. M2M OIDC `client_credentials` flow against Dex passes an e2e test that creates a job and lists entities via the SDK with a service-token JWT.
4. `examples/auth-dex/` boots with `docker compose up` and produces a working IDP that the browser smoke client targets without environment surgery; `CORS_ALLOWED_ORIGINS` accepts both explicit-list and `https://*.spatula.dev` wildcard forms (verified by request matrix).
5. `POST /api/v1/api-keys/:id/rotate` rotates a key without dropping in-flight requests; `docs/api-auth.md` is the authoritative scope list with explicit "refresh tokens are IDP's job" and "CSRF N/A for Bearer auth" sections.

**Plans:** 7/7 plans complete
Plans:
- [x] 17-01-PLAN.md — Wave 0 foundations: api_keys rotation migration + RESOURCE.NOT_FOUND ErrorCode + rate-limits.yaml entries + test scaffolds
- [x] 17-02-PLAN.md — SSE: Redis-stream dual-publish + sse/ handler (replay, tail, keepalive) + route mount + ws-token doc (AUTH-01, AUTH-02)
- [x] 17-03-PLAN.md — CORS wildcard-subdomain origin matcher + docs/api-auth.md authoritative auth doc + scope-sync gate (AUTH-03, AUTH-06)
- [x] 17-04-PLAN.md — API key rotation: ApiKeyRepository.rotate() + POST /api-keys/:id/rotate route with two-key grace window (AUTH-05)
- [x] 17-05-PLAN.md — examples/auth-dex/ zero-config local Dex OIDC kit + boot checkpoint (AUTH-04)
- [x] 17-06-PLAN.md — @spatula/client SSE getJobEvents method + Playwright browser OIDC+SSE reconnect e2e (AUTH-01, AUTH-02, AUTH-04)
- [x] 17-07-PLAN.md — tests/isolation/ OpenAPI-driven cross-tenant audit suite + M2M client_credentials e2e (AUTH-07, AUTH-08)
**Estimated effort**: 4 active sessions
**UI hint**: yes

### Phase 18: Security Hardening & Legal

**Goal**: Production-grade security posture (prompt-injection defense, full redaction, full DSR surface) plus the legal scaffolding (CLA, trademark policy, brand license, copyright line) that lets the repo flip public without lingering ambiguity.
**Depends on**: Phase 16 (error envelope frozen → security errors use it; experimental-tag policy is the home for forensic-extractions endpoint). Partial parallel with Phase 17 (threat-model authoring can begin early).
**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-06, SEC-07, SEC-08, SEC-09, SEC-10, SEC-11, SEC-12, LEGAL-01, LEGAL-02, LEGAL-03, LEGAL-04, LEGAL-05, LEGAL-06, LEGAL-07, LEGAL-08
**Pre-phase gate**: BLOCK-02 (legal entity formed OR interim-name LICENSE path explicitly accepted with `NOTICE.md` recording the future assignment); BLOCK-06 (USPTO TESS search for "Spatula" complete, conflict-free OR rename); BLOCK-09 (`.github/HISTORICAL_CONTRIBUTORS.md` committed; pre-sign outreach started).
**Success Criteria** (what must be TRUE):

1. The adversarial-fixture suite in `packages/core/src/extraction/__tests__/fixtures/adversarial/` (≥10 fixtures covering all 10 attack classes from spec §3.7.2.8) is green against the pinned models `openrouter/anthropic/claude-3-5-sonnet-20240620` and `ollama/llama3.1:8b-instruct-q4_0` on the live-LLM CI lane; pins live in `pinned-models.ts`.
2. The redaction test suite in `tests/shared/redaction/` proves known-sensitive strings (API keys, JWTs, `Authorization`/`Cookie` headers, OpenRouter keys, Stripe-pattern strings) never appear in any sink — stdout, file logs, Sentry payloads, OTel exporter output — verified for each sink independently.
3. DSR round-trips pass — `tests/e2e/dsr/deletion/` (create tenant → seed data → delete → assert zero rows + zero content-store blobs + redacted audit-log traces + cascaded forensic blobs) and `tests/e2e/dsr/portability/` (tenant dump → re-import → field-level parity) both green.
4. `GET /api/v1/admin/forensic/extractions` returns metadata with 15-min-TTL signed URLs (no inline HTML), is marked `x-spatula-experimental: true` in OpenAPI, and is reachable from the SDK only via `client.experimental.forensic.*`; an integration test exercises a tagged forensic blob round-trip.
5. `audit.yml` runs OSV scan + license allowlist (no GPL/AGPL) + gitleaks + trufflehog full-history scan on every push and on a daily cron; a deliberate test-credential PR is blocked by the secret-scan gate.
6. The legal docset is committed and links cleanly — `LICENSE` with correct copyright line (or interim-name fallback + `NOTICE.md`), `TRADEMARK.md`, `brand/LICENSE-BRAND.md` ("All rights reserved. Use per TRADEMARK.md."), `THIRD_PARTY_NOTICES.md` (auto-generated via pinned `license-checker-rseidelsohn`), `SECURITY.md`, `.github/CLA.md` (versioned), README legal disclaimer banner, and a default User-Agent of `Spatula/<version> (+https://spatula.dev/abuse)`.
   **Plans**: TBD
   **Estimated effort**: 5 active sessions

### Phase 19: Deployment & Self-Host Excellence

**Goal**: Self-hoster gets a first-class experience across docker-compose, k8s, and PaaS — supply-chain-signed images, working runbooks, and a measured hardware-sizing baseline.
**Depends on**: Phase 16 (release workflow outputs: rate-limits.yaml path, OpenAPI artifact, version manifest). Can run partially parallel with Phase 18.
**Requirements**: DEPLOY-01, DEPLOY-02, DEPLOY-03, DEPLOY-04, DEPLOY-05, DEPLOY-06, DEPLOY-07, DEPLOY-08, DEPLOY-09, DEPLOY-10, DEPLOY-11
**Success Criteria** (what must be TRUE):

1. `kubectl apply -k deploy/k8s/overlays/dev` produces a healthy api + worker + migrate-job set on a fresh `kind` cluster (with external Postgres + Redis stubs) and `spatula doctor` returns all 9 checks green from inside the cluster.
2. `render.yaml` at the repo root spins up the full stack on a Render free-tier account from a freshly-cloned commit, reachable on the assigned URL.
3. `cosign verify` succeeds on all four container images (api/worker/migrate/cli) on `linux/amd64` AND `linux/arm64` from a fresh-machine smoke test; the matching SBOM (cyclonedx-json) is attached to the corresponding GitHub release.
4. `tests/e2e/backup/` performs a `pg_dump` + content-store snapshot, restores into a fresh environment, and asserts row-count + content-hash parity; `tests/upgrade/` seeds a v1.0 DB and applies v1.x migrations with the runtime verifying cleanly; `tests/config/` parses a v1.0 `spatula.yaml` on the v1.1 runtime.
5. The runbook set is committed and exercised — `backup-restore.md`, `upgrade.md`, `reverse-proxy.md` (nginx tested end-to-end with token-in-URL log masking verified in access logs; traefik + caddy carry "not first-party tested" disclaimer), `hardware-sizing.md` (with measured 1k-page baselines), and `support-matrix.md` (Node 22+, Postgres 14+, Redis 7+, macOS/Linux/WSL — min-version CI matrix green).
   **Plans**: TBD
   **Estimated effort**: 5 active sessions

### Phase 20: Docs Site Infrastructure + Content

**Goal**: `docs.spatula.dev` is live, indexable, accessible, and auto-regenerates its API + CLI references from source on every push to `main`.
**Depends on**: Phase 16 (OpenAPI spec is the source-of-truth for auto-gen).
**Requirements**: DOCS-01, DOCS-02, DOCS-03, DOCS-04, DOCS-05, DOCS-06, DOCS-07, DOCS-08, DOCS-09, DOCS-10
**Pre-phase gate**: BLOCK-03 (`spatula.dev` + `docs.spatula.dev` owned with DNS access); BLOCK-08 (Cloudflare Pages account + DNS for docs site in place).
**Success Criteria** (what must be TRUE):

1. `docs.spatula.dev` serves the VitePress build over HTTPS from Cloudflare Pages; the deploy pipeline auto-triggers on push to `main` and the API reference is regenerated from `docs/site/scripts/build-api-ref.ts` against the live OpenAPI artifact.
2. The docs-CI build reports zero violations from `axe-core` across all routes (or only entries explicitly catalogued in `docs/site/a11y.md`) — WCAG 2.1 AA gate green.
3. `lychee` (or `linkinator`) dead-link check runs on every docs build and fails the build on broken internal anchors or external 4xx/5xx.
4. The cookbook set is published — webhooks, llm-costs, ollama-caveats, oidc-auth0, oidc-keycloak, oidc-google-workspace — and at least one OIDC cookbook is verified against a real tenant of that IDP before launch.
5. All new docs from spec §3.5 exist and resolve from the docs nav — `privacy.md`, `deprecation-policy.md`, `support-matrix.md`, `security-model.md`, `api-errors.md`, `api-idempotency.md`, `api-auth.md`, `compat-policy.md`, `private-contract.md` — and the README "Differentiation" section names Firecrawl / ScrapingBee / Apify / Crawl4AI with the three-axis comparison.
   **Plans**: TBD
   **Estimated effort**: 4 active sessions
   **UI hint**: yes

### Phase 21: Contributor Infra + CI Topology

**Goal**: An external contributor can clone the repo on a fresh machine, open it in a devcontainer, and submit a green PR in under 20 minutes — and the CI topology behind that PR runs the right jobs at the right cadence.
**Depends on**: Phase 20 (CI topology must wire the docs-site build job and the CLA bot needs to comment on PRs that include doc changes); Phase 18 (CLA + adversarial-fixture template ship there).
**Requirements**: CONTRIB-01, CONTRIB-02, CONTRIB-03, CONTRIB-04, CONTRIB-05, CONTRIB-06, CONTRIB-07, CONTRIB-08, CONTRIB-09, CONTRIB-10, CONTRIB-11, CONTRIB-12
**Success Criteria** (what must be TRUE):

1. `.devcontainer/devcontainer.json` opens cleanly in GitHub Codespaces with all deps preinstalled; the full unit-test suite runs to green inside the container; husky + lint-staged pre-commit hooks fire on a sample commit.
2. The CI topology runs as specified in spec §6 — preflight (~2 min) blocks PRs fast, unit+integration (~10–12 min) blocks merge, contract (~3 min) gates the OpenAPI surface, e2e (~15 min) runs on `main` + tags, audit runs daily + on push, release runs on tag, release-dry-run runs on every `main` push as a non-blocking parallel job (~5–10 min).
3. Mock-vs-live LLM test split works as documented — a contributor fork without an `OPENROUTER_API_KEY` secret sees green CI on a no-op PR; setting `SPATULA_LIVE_LLM=1` on a `main`-branch run executes the live-LLM suite; the live-LLM lane never runs on fork PRs.
4. GitHub Discussions is enabled with seeded categories; issue templates include `bug`, `feature`, `question`, `RFC`, `adversarial-fixture`; `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `GOVERNANCE.md` (with honest solo-maintainer bus-factor section + admin-access recovery for repo/npm/GHCR/DNS), `ROADMAP.md` (v1.x themes + Helm-chart-as-v1.1 target), `CODEOWNERS`, and `.github/FUNDING.yml` all resolve.
5. `good-first-issue` + `help-wanted` labels exist with at least one tagged issue each and `docs/contributing/how-to-claim.md` documents the claim workflow.
   **Plans**: TBD
   **Estimated effort**: 3 active sessions

### Phase 22: Launch Mechanics (RC → GA)

**Goal**: Spatula `v1.0.0` is publicly tagged, npm-published with provenance, GHCR-signed, announced same-day across blog/HN/PH/X/LinkedIn, and actively monitored for the first 72 hours.
**Depends on**: ALL prior phases (15–21) acceptance-verified. Strictly the last phase.
**Requirements**: LAUNCH-01, LAUNCH-02, LAUNCH-03, LAUNCH-04, LAUNCH-05, LAUNCH-06, LAUNCH-07, LAUNCH-08, LAUNCH-09, LAUNCH-10, LAUNCH-11, LAUNCH-12, LAUNCH-13, LAUNCH-14, LAUNCH-15, LAUNCH-16, LAUNCH-17, LAUNCH-18, LAUNCH-19, LAUNCH-20
**Pre-phase gate**: BLOCK-05 (`accidentally-awesome-labs/spatula` GitHub namespace claimed; `spatulaai/*` references reconciled); BLOCK-07 (beta invitee list of 5–10 names with ≥1 non-developer confirmed). Re-validates: BLOCK-02 (entity status), BLOCK-06 (USPTO conflict-free), BLOCK-09 (historical-contributor outreach complete).
**Success Criteria** (what must be TRUE):

1. The pre-flip gate passes — `trufflehog` + `gitleaks` full-history scan AND manual category audit (`.env*` history, test DB dumps, snapshot HTML, auth fixtures, log-output files) both clean and recorded against the reproducible checklist in `docs/runbooks/secret-scan-audit.md`; only after that gate does the repo flip public.
2. `v1.0.0-rc.1` is tagged and the release workflow publishes npm (with `--provenance`) + GHCR (multi-arch, cosign-signed) + SBOM successfully; the post-publish smoke (`docs/runbooks/post-publish-smoke.md`) passes on a fresh M-series MacBook — `npm install @spatula/cli@1.0.0-rc.1`, `docker pull ghcr.io/.../spatula-api:1.0.0-rc.1`, `cosign verify` for all four images, and 3 canned flows (`spatula doctor`, local crawl, push/pull round-trip).
3. The 10-min user-journey timed walkthrough passes on the baseline defined in `docs/runbooks/user-journey-baseline.md` (M-series MacBook, 16GB RAM, Docker Desktop 4.x, Node 22 via nvm, OpenRouter key pre-exported, 100Mbps+ residential) — from `git clone` to first entities in the local DB in ≤10 minutes wall-clock.
4. The cross-sub-plan integration matrix is green — OIDC login via Dex → SSE subscribe → SDK call → push/pull round-trip → completes cleanly in a single run.
5. The zero-Critical gate clears — 2 weeks after the RC.1 cut with no Critical issues open (data loss, RCE, auth bypass, data corruption, PII leak); if not, an `rc.2` cycle runs and the 2-week window resets per spec §4.1 contingency.
6. `v1.0.0` is tagged, post-publish smoke re-passes against GA artifacts, docs site `latest` redirects update within 1 hour, npm `latest` is set, the announcement goes live coordinated same-day across blog/HN/PH/X/LinkedIn, the status page at `status.spatula.dev` is reachable and linked from README, and a launch retrospective is published 72h after GA.
   **Plans**: TBD
   **Estimated effort**: 2 active sessions (pre-RC) + 2 weeks RC (active monitoring) + 1 session (GA cut) + 1 session (launch day) + 72h monitoring. Budget at least one `rc.2` cycle per spec §4.1 contingency note.

---

## Coverage Summary

**v1.1 requirements:** 120 total

- 9 BLOCK-\* (cross-cutting pre-phase gates; mapped to the phases they unblock)
- 8 CARVE-\* → Phase 15
- 14 API-_ + 8 SDK-_ → Phase 16
- 8 AUTH-\* → Phase 17
- 12 SEC-_ + 8 LEGAL-_ → Phase 18
- 11 DEPLOY-\* → Phase 19
- 10 DOCS-\* → Phase 20
- 12 CONTRIB-\* → Phase 21
- 20 LAUNCH-\* → Phase 22

**Mapped to phases:** 120 / 120 ✓
**Orphans:** 0
**v2 / Out-of-Scope:** Not appearing in any phase (per spec §2.2 and REQUIREMENTS.md Out-of-Scope table).

Authoritative requirement → phase mapping lives in `.planning/REQUIREMENTS.md` "Traceability" table.

---

## Progress

**Execution Order:** 15 → 16 → 17 → 18 → 19 → 20 → 21 → 22
(17/19/20 may partial-parallel after 16; 18 may partial-parallel with 17; see Dependency Graph.)

| Phase                                     | Milestone | Plans Complete | Status      | Completed  |
| ----------------------------------------- | --------- | -------------- | ----------- | ---------- |
| 1–13                                      | v1.0      | (collapsed)    | Complete    | 2026-04-20 |
| 15. Carve-out & Migration Squash          | v1.1      | 6/6            | Complete    | 2026-05-18 |
| 16. API Contract Hardening + SDK Packages | v1.1      | 5/5 | Complete    | 2026-05-19 |
| 17. Browser Auth, SSE, CORS               | v1.1      | 7/7 | Complete    | 2026-05-20 |
| 18. Security Hardening & Legal            | v1.1      | 0/TBD          | Not started | -          |
| 19. Deployment & Self-Host Excellence     | v1.1      | 0/TBD          | Not started | -          |
| 20. Docs Site Infrastructure + Content    | v1.1      | 0/TBD          | Not started | -          |
| 21. Contributor Infra + CI Topology       | v1.1      | 0/TBD          | Not started | -          |
| 22. Launch Mechanics (RC → GA)            | v1.1      | 0/TBD          | Not started | -          |

**Status legend:**

- `Not started` — Haven't begun
- `In progress` — Currently working
- `Complete` — Done (add completion date)
- `Deferred` — Pushed to later (with reason)

---

_Roadmap created: 2026-05-12_
_Milestone v1.1 — Public Launch (Wave 6 / Phase 14)_
