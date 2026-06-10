# Requirements: Spatula v1.1 — Public Launch (Wave 6 / Phase 14)

**Defined:** 2026-05-11
**Core Value:** Turn "I want X data from these sites" into a production-quality dataset with provenance.
**Source spec:** `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md`

---

## v1 Requirements

Requirements for the v1.0.0 public launch. Each maps to one of phases 15–22. REQ-IDs follow `[CATEGORY]-[NUMBER]` from the spec.

### Pre-Launch Blockers (cross-cutting; resolved before any phase begins or before Phase 22 launch gate)

- [ ] **BLOCK-01**: `accidentally-awesome-labs/spatula-saas` private GitHub repo exists before Phase 15 carve-out PR merges.
- [ ] **BLOCK-02**: Legal entity "Accidentally Awesome Labs" is formed, OR interim-name LICENSE path is explicitly accepted and `NOTICE.md` records the future assignment.
- [ ] **BLOCK-03**: `spatula.dev` + `docs.spatula.dev` domains are owned, with DNS access for the docs-site DNS record.
- [ ] **BLOCK-04**: npm `@spatula` org is owned, or a fallback scope (e.g., `@spatulaai`, `@aalabs/spatula`) is chosen and documented before any `@spatula/*` package is published.
- [ ] **BLOCK-05**: GitHub namespace `accidentally-awesome-labs/spatula` is claimed; prior `spatulaai/*` references reconciled.
- [ ] **BLOCK-06**: USPTO TESS search for "Spatula" trademark is completed; conflict-free OR rename pre-launch.
- [ ] **BLOCK-07**: Beta invitee list (5–10 names, ≥1 non-developer) is confirmed before Phase 22 RC cut.
- [ ] **BLOCK-08**: Cloudflare Pages account + DNS for `docs.spatula.dev` are in place before Phase 20 publishes.
- [ ] **BLOCK-09**: Historical-contributor enumeration (`git log --format='%ae' | sort -u`) is committed to `.github/HISTORICAL_CONTRIBUTORS.md`; pre-sign outreach complete before public flip.

### Carve-out (Phase 15 — Wave 6-1)

- [x] **CARVE-01**: All billing / Stripe / metering files (per spec §3.1.1) are extracted into the private `spatula-saas` repo with history preserved via `git filter-repo`.
- [x] **CARVE-02**: OSS code is stripped of tier presets and Stripe coupling per spec §3.1.2 (admin tenants drop plan/stripe fields, job manager loses tier-quota lookup, rate-limit loses tier presets, admin-system metrics has no `usage_records` reference, `.env.example` has no `STRIPE_*`, OpenAPI examples and seed fixtures have no billing).
- [x] **CARVE-03**: All pre-Wave-6 migrations are squashed into a single `000_v1_baseline.sql` with billing tables absent.
- [x] **CARVE-04**: OSS Drizzle migrations live under `packages/db/drizzle/` with `migrationsTable: '__drizzle_migrations_oss'`; documented in `docs/runbooks/upgrade.md`.
- [x] **CARVE-05**: `tests/carveout/` verification suite passes — OSS-only server satisfies remote push/pull contract, tenant CRUD has no plan fields, quota enforcement is config-driven, admin metrics aggregates without `usage_records`, OpenAPI has no billing/stripe paths.
- [x] **CARVE-06**: `tests/private-contract/` reverse-contract test exists — mocked private consumer imports `@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/shared`, `@spatula/api` as `spatula-saas` does; breaks on silent removal of consumed symbols; residual-risk acknowledgment in `docs/private-contract.md`.
- [x] **CARVE-07**: `docs/architecture.md` refreshed; no billing mentions remain; dependency diagram republished.
- [x] **CARVE-08**: No-migration-downgrade policy committed to `docs/runbooks/upgrade.md`; expand-contract documented as the only schema-change path post-v1.

### API Contract Hardening (Phase 16)

- [x] **API-01**: All 4xx/5xx responses conform to `{ error: { code, message, requestId, details? } }`; the error-code enum is exported from `@spatula/core-types`, frozen at v1, additive-only in 1.x.
- [x] **API-02**: Every auth'd route sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on success; `Retry-After` on 429.
- [x] **API-03**: Per-route rate-limit config lives in `config/rate-limits.yaml`, replaces tier presets, and is overridable by self-hosters.
- [x] **API-04**: Cursor-first pagination is canonical (`{ data, nextCursor, hasMore }`); offset (`?page=`, `?limit=`) is marked `deprecated: true` in OpenAPI with `Deprecation` + `Sunset` headers; removal target v2.0.
- [x] **API-05**: `GET /api/v1/openapi.json` serves the OpenAPI spec at runtime from the single source-of-truth used by the build (no drift).
- [x] **API-06**: `GET /.well-known/spatula-version` returns version + git-sha + support-matrix snapshot.
- [x] **API-07**: All API timestamps are ISO 8601 UTC; no unix-epoch values remain in any response.
- [x] **API-08**: Idempotency on POST/PATCH/DELETE creating state is documented in `docs/api-idempotency.md` with worked examples (functionality already shipped in Wave 3-4).
- [x] **API-09**: Webhook retry schedule (1m, 5m, 30m, 2h, 8h → DLQ) is documented in `docs/cookbook/webhooks.md` alongside HMAC-SHA256 verification example and dedup pattern.
- [x] **API-10**: All public routes live under `/api/v1/`; versioning-in-URL convention is documented; v2 cut plan committed.
- [x] **API-11**: Export format stability is declared — JSON/CSV/Parquet/SQLite/DuckDB shapes including provenance metadata are frozen at v1; documented.
- [x] **API-12**: OpenAPI contract tests in `tests/contract/` cover every route, every error status code, every OpenAPI example (examples must validate against their schemas); CI runs them on every PR.
- [x] **API-13**: `experimental:` tag policy is documented in `docs/deprecation-policy.md` (6-month max lifetime, graduate-or-remove, `client.experimental.*` namespace, `Deprecation`+`Sunset` headers on removal).
- [x] **API-14**: `docs/compat-policy.md` defines the SDK↔server↔core-types compat matrix per spec §3.2.5 (major-compat-within-major, mismatch error classes, 12-month support window).

### SDK Packages (Phase 16, shipped together with API contract work)

- [x] **SDK-01**: `@spatula/core-types` package exists with type-only exports, zod schemas, `JobConfig`, `FieldDef`, action types, error-code enum, zero runtime deps (zod peer), ESLint rule preventing non-type imports.
- [x] **SDK-02**: `@spatula/client` package exists — `SpatulaClient` class + typed errors keyed to error-code enum, fetch-based, browser+Node compatible, ESM-only, `sideEffects: false`, explicit `exports` field.
- [x] **SDK-03**: `@spatula/client` measured bundle (`import { SpatulaClient, createJob, listJobs, getEntities }`, esbuild `--bundle --minify --format=esm --platform=browser`) is <50 KB gzipped; enforced by `size-limit` in CI.
- [x] **SDK-04**: `@spatula/cli` is publish-ready — `bin`, `publishConfig.access=public`, dual ESM+CJS build, `files` allowlist (not `.npmignore`), `engines: { node: ">=22" }`, Playwright browsers installed via `spatula setup` (no postinstall).
- [x] **SDK-05**: SQLite-backend decision is benchmarked first task of Phase 16 (`node:sqlite` vs `better-sqlite3`); decision + numbers committed to `docs/architecture.md`; default stays `better-sqlite3` unless all three gates (feature parity for WAL+FTS, zero perf regression, non-experimental status) pass.
- [x] **SDK-06**: Internal packages (`@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/api`, `@spatula/shared`) are publish-ready with explicit "no compat guarantee at TS API level" notice in each package README per spec §3.2.4.
- [x] **SDK-07**: Release workflow publishes all eight packages with `--provenance` and `--access public` for the public ones; published packages dry-run cleanly.
- [x] **SDK-08**: SDK integration test suite hits every major endpoint (`createJob`, `listJobs`, `getEntities`, `getJobEvents`, etc.) and is gated by `SPATULA_LIVE_LLM` env var; mocked by default for contributor forks.

### Browser Auth, SSE, CORS (Phase 17)

- [x] **AUTH-01**: `GET /api/v1/jobs/:id/events` SSE endpoint streams job status, progress, schema actions, entity counts with monotonic `id`s, `Last-Event-ID` resume, 5-minute per-job ring buffer, 15s keep-alive, `X-Accel-Buffering: no` + `Cache-Control: no-cache` + `Content-Type: text/event-stream`.
- [x] **AUTH-02**: Single-use stream-token flow (`?token=`) extends to SSE, matching the existing WS pattern; `POST /api/v1/ws-token` returns tokens usable for either; tokens are 60-second TTL.
- [x] **AUTH-03**: CORS supports both explicit-list and wildcard-subdomain origins (e.g., `https://*.spatula.dev`); preflight cache configured; `CORS_ALLOWED_ORIGINS` format documented.
- [x] **AUTH-04**: `examples/auth-dex/` ships a zero-config local OIDC recipe — `docker compose up` produces a working Dex IDP that a browser smoke client can use to log in.
- [x] **AUTH-05**: `POST /api/v1/api-keys/:id/rotate` enables zero-downtime key rotation.
- [x] **AUTH-06**: `docs/api-auth.md` is the authoritative scope list; explicitly documents "refresh-tokens-are-IDP-job" and "CSRF-N/A for Bearer auth".
- [x] **AUTH-07**: Cross-tenant isolation audit suite (`tests/isolation/`) verifies tenant A cannot read tenant B via any route — jobs, entities, extractions, actions, exports, admin where applicable.
- [x] **AUTH-08**: M2M OIDC (client_credentials) is validated in an e2e test against Dex.

### Security Hardening (Phase 18)

- [x] **SEC-01**: Prompt-injection defense ships per spec §3.7.2 — role separation (HTML always in `user` role), hardened system prompt with anti-injection boilerplate, `<UNTRUSTED_CONTENT>` sentinel wrapping, Zod-validated outputs with one stricter retry on off-schema, field allowlist, per-field free-text length caps, structured-output scanner for prompt-echo / field-name-leakage / cap-hits.
- [x] **SEC-02**: ≥10 adversarial HTML fixtures live in `packages/core/src/extraction/__tests__/fixtures/adversarial/` covering all 10 attack classes from spec §3.7.2.8; suite runs against pinned models `openrouter/anthropic/claude-3-5-sonnet-20240620` + `ollama/llama3.1:8b-instruct-q4_0`; pins committed to `pinned-models.ts`.
- [x] **SEC-03**: Quarterly corpus-refresh process is documented; `.github/ISSUE_TEMPLATE/adversarial-fixture.md` accepts community submissions.
- [x] **SEC-04**: When suspicious-extraction or off-schema-retry fires, raw HTML is archived in content store with `forensic:true` tag, retained 1 year OR until tenant deletion (DSR-delete cascades to forensic blobs); extraction request/response logged to DLQ with kind `suspicious_extraction`; redaction rules apply.
- [x] **SEC-05**: `GET /api/v1/admin/forensic/extractions` ships as the v1 sole experimental surface — `admin:forensic:read` scope, signed-URL `contentRef` (15-min TTL, no inline HTML), cursor pagination per API-04, rate-limit per API-02; marked `x-spatula-experimental: true` in OpenAPI; exposed via `client.experimental.forensic.*`.
- [x] **SEC-06**: Secret/PII redaction sweep covers all log sinks (stdout, file, Sentry, OTel); redaction test suite proves known-sensitive strings (API keys, JWTs, `Authorization` / `Cookie` headers, OpenRouter keys, Stripe-pattern strings) never appear in any sink output.
- [x] **SEC-07**: `docs/security-model.md` documents the full threat model (§3.7.1), mitigations matrix (§3.7.2), user responsibilities, known limits (§3.7.4), and reporting process for new adversarial patterns.
- [x] **SEC-08**: `docs/privacy.md` declares zero phone-home + zero-telemetry boundary (operator-configured Sentry/OTel are operator's endpoints), and spells out self-hoster controller obligations (DPAs, DSR SLA, breach notification) per spec §3.8 / §7-19.
- [x] **SEC-09**: Full DSR surface ships — `spatula admin tenant delete --tenant <id>` + `DELETE /api/v1/admin/tenants/:id` cascade to entities, raw_pages, content-store blobs, audit-log redaction, forensic blobs; `spatula admin tenant export --tenant <id> --format jsonl` produces a re-importable dump; rectification SQL + admin paths documented.
- [x] **SEC-10**: `tests/e2e/dsr/deletion/` round-trip (create tenant → seed data → delete → assert empty) and `tests/e2e/dsr/portability/` (tenant dump → re-import → parity) pass.
- [x] **SEC-11**: `audit.yml` CI hardened — OSV scan, license allowlist (no GPL/AGPL), gitleaks + trufflehog full-history secret scan.
- [x] **SEC-12**: Dependabot and Renovate configs exist and are wired to monitor production deps.

### Legal & Brand (Phase 18, shipped with security)

- [x] **LEGAL-01**: `LICENSE` copyright line reads `Copyright (c) 2026 Accidentally Awesome Labs` OR interim-name fallback (`Copyright (c) 2026 <Individual Name>`) is in place with `NOTICE.md` recording the assignment-on-entity-formation plan.
- [x] **LEGAL-02**: `TRADEMARK.md` defines the trademark policy per spec §3.9 (forks may not use Spatula name/logo in project name/domain/marketing; "based on Spatula" attribution allowed; unmodified official release may use the name).
- [x] **LEGAL-03**: `brand/LICENSE-BRAND.md` explicitly states brand assets are NOT under MIT — "All rights reserved. Use per TRADEMARK.md."
- [x] **LEGAL-04**: `THIRD_PARTY_NOTICES.md` is auto-generated via pinned `license-checker-rseidelsohn` (invoked by `pnpm run generate:notices`); regenerated on every release cut.
- [x] **LEGAL-05**: `SECURITY.md` audited — vulnerability disclosure process, GPG key, response SLA documented.
- [x] **LEGAL-06**: CLA wired via `cla-assistant.io`; CLA text versioned in `.github/CLA.md` with `version` in frontmatter; re-sign-on-text-change policy documented in `CONTRIBUTING.md`.
- [x] **LEGAL-07**: README displays a prominent legal disclaimer banner — MIT, target-site ToS responsibility, robots.txt honored by default with override at user risk.
- [x] **LEGAL-08**: Default User-Agent identifies as `Spatula/<version> (+https://spatula.dev/abuse)` (or interim domain if `spatula.dev` not yet owned).

### Deployment & Self-Host Excellence (Phase 19)

- [ ] **DEPLOY-01**: `deploy/k8s/` kustomize base + dev/prod overlays exist for api, worker, migrate job; postgres + redis referenced as external in prod overlay; applies cleanly to a `kind` cluster.
- [x] **DEPLOY-02**: `render.yaml` at repo root deploys the stack on a Render free-tier account.
- [ ] **DEPLOY-03**: Container images for api/worker/migrate/cli are multi-arch (`linux/amd64` + `linux/arm64`) via buildx; distroless base for api/worker/migrate; Debian-slim for cli.
- [ ] **DEPLOY-04**: All container images are `cosign`-signed; SBOM (cyclonedx-json) is attached to each GitHub release; signatures verify on `cosign verify` in a fresh-machine smoke test.
- [ ] **DEPLOY-05**: `docs/runbooks/backup-restore.md` covers pg_dump + content-store + Redis reconciliation; backup→restore round-trip in `tests/e2e/backup/` passes; time-to-restore estimates documented.
- [ ] **DEPLOY-06**: `docs/runbooks/upgrade.md` defines the version-to-version migration template and the no-downgrade policy.
- [ ] **DEPLOY-07**: `docs/runbooks/reverse-proxy.md` ships nginx recipe (tested end-to-end with token-in-URL log masking); traefik + caddy stubs labeled "not first-party tested."
- [ ] **DEPLOY-08**: `docs/support-matrix.md` documents min versions (Node 22+, Postgres 14+, Redis 7+, macOS/Linux/WSL); min-version CI matrix passes.
- [ ] **DEPLOY-09**: `docs/runbooks/hardware-sizing.md` includes a measured baseline table (1k-page crawl timings on defined hardware, LLM cost per page per model).
- [ ] **DEPLOY-10**: `tests/upgrade/` seeds a v1.0 DB, applies v1.x migrations, and verifies the runtime — governs the expand-contract policy.
- [ ] **DEPLOY-11**: `tests/config/` verifies a v1.0 `spatula.yaml` parses on the v1.1 runtime (config-migration test).

### Docs Site (Phase 20)

- [ ] **DOCS-01**: VitePress source lives in `docs/site/` and deploys to `docs.spatula.dev` via Cloudflare Pages.
- [ ] **DOCS-02**: API reference is auto-generated from OpenAPI via `docs/site/scripts/build-api-ref.ts` on every push to `main`.
- [ ] **DOCS-03**: CLI reference is auto-generated from yargs definitions.
- [ ] **DOCS-04**: Cookbook covers webhooks, llm-costs, ollama-caveats, oidc-auth0, oidc-keycloak, oidc-google-workspace.
- [ ] **DOCS-05**: axe-core a11y check runs in CI on every docs build; site meets WCAG 2.1 AA on all routes; known exceptions in `docs/site/a11y.md`.
- [ ] **DOCS-06**: `lychee` or `linkinator` dead-link check runs in CI and fails the build on broken anchors.
- [ ] **DOCS-07**: Plausible (or Umami) cookieless analytics is enabled and disclosed in `docs/privacy.md`.
- [ ] **DOCS-08**: README "Differentiation" section names Firecrawl / ScrapingBee / Apify / Crawl4AI and explains Spatula's three-axis difference (self-hostable, entity+provenance default, Ollama offline).
- [ ] **DOCS-09**: At least one OIDC cookbook (Auth0/Keycloak/Google Workspace) is tested against a real tenant before launch.
- [ ] **DOCS-10**: All new docs from spec §3.5 exist: `privacy.md`, `deprecation-policy.md`, `support-matrix.md`, `security-model.md`, `api-errors.md`, `api-idempotency.md`, `api-auth.md`, `compat-policy.md`, `private-contract.md`.

### Contributor Infra & CI Topology (Phase 21)

- [ ] **CONTRIB-01**: `CODE_OF_CONDUCT.md` adopts Contributor Covenant 2.1.
- [ ] **CONTRIB-02**: `GOVERNANCE.md` documents the maintainer model honestly (solo today; bus-factor mitigation; admin-access recovery for repo / npm / GHCR / DNS).
- [ ] **CONTRIB-03**: `ROADMAP.md` lists v1.x themes + release-cadence intent (as-needed patches, monthly-ish minors); explicitly notes Helm chart as v1.1 target.
- [ ] **CONTRIB-04**: `CODEOWNERS` routes path-based reviews.
- [ ] **CONTRIB-05**: `.github/FUNDING.yml` exists.
- [ ] **CONTRIB-06**: GitHub Discussions is enabled with seeded categories.
- [ ] **CONTRIB-07**: Issue templates audited; `question`, `RFC`, `adversarial-fixture` templates added.
- [ ] **CONTRIB-08**: `good-first-issue` + `help-wanted` labels exist; `docs/contributing/how-to-claim.md` documents the workflow.
- [ ] **CONTRIB-09**: `.devcontainer/devcontainer.json` boots cleanly in Codespaces with all deps preinstalled + husky/lint-staged pre-commit hooks; runs full unit suite end-to-end.
- [ ] **CONTRIB-10**: CI topology in place per spec §6 — preflight (~2 min), unit+integration (~10–12 min), contract (~3 min), e2e (~15 min), audit (daily + push), release (on tag), release-dry-run (on main push, non-blocking).
- [ ] **CONTRIB-11**: Test suite mock-vs-live split — mocks default so contributor-fork CI passes without an OpenRouter key; `SPATULA_LIVE_LLM=1` opts in; live-LLM jobs run only on main-branch CI.
- [ ] **CONTRIB-12**: `adopters.md` placeholder exists.

### Launch Mechanics (Phase 22)

- [ ] **LAUNCH-01**: Brand assets ship — logo (SVG + PNG), favicon, OpenGraph social card, color palette, GitHub repo social preview; assets under `brand/` covered by `brand/LICENSE-BRAND.md`.
- [ ] **LAUNCH-02**: GitHub repo settings configured before public flip — branch protection on `main`, required checks (preflight + unit+int + contract), squash-merge-only, optional commit signing for maintainers.
- [ ] **LAUNCH-03**: Release workflow polished — `release.yml` runs cosign sign, attaches SBOM, publishes npm with `--provenance`, updates CHANGELOG via release-please.
- [ ] **LAUNCH-04**: Announcement kit drafted before RC — blog post, Hacker News post, X/Twitter thread, Product Hunt listing, LinkedIn post.
- [ ] **LAUNCH-05**: `docs/runbooks/incident-response.md` documents who responds, Critical SLA (24h), postmortem template, CI secret rotation plan, status-page operation.
- [ ] **LAUNCH-06**: Pre-flip secret-scan gate — `trufflehog` + `gitleaks` full-history scan AND manual category audit (`.env*` history, test DB dumps, snapshot HTML, auth fixtures, log-output files); both required; `docs/runbooks/secret-scan-audit.md` documents the procedure reproducibly.
- [ ] **LAUNCH-07**: `docs/runbooks/user-journey-baseline.md` defines the 10-min fresh-machine baseline (M-series MacBook, 16GB RAM, Docker Desktop 4.x, Node 22 via nvm, OpenRouter key pre-exported, 100Mbps+ residential).
- [ ] **LAUNCH-08**: 10-min user-journey timed walkthrough passes on the defined baseline before GA.
- [ ] **LAUNCH-09**: `v1.0.0-rc.1` tag is cut; release workflow publishes npm + GHCR + cosign + SBOM successfully.
- [ ] **LAUNCH-10**: `docs/runbooks/post-publish-smoke.md` post-publish verification passes against `rc.1` artifacts — fresh-machine `npm install` + `docker pull` + `cosign verify` + 3 canned flows (`spatula doctor`, local crawl, push/pull round-trip).
- [ ] **LAUNCH-11**: Repo is flipped public after all pre-flip gates pass.
- [ ] **LAUNCH-12**: Beta invitees exercise push/pull, web-UI mock, self-host during the 2-week RC window; public GH Issues use `preview-bug` label + a pinned tracking issue.
- [ ] **LAUNCH-13**: Cross-sub-plan integration test matrix is green — OIDC login via Dex → SSE subscribe → SDK call → pull flow → completes cleanly.
- [ ] **LAUNCH-14**: Zero-Critical gate cleared — 2 weeks with no Critical issues (data loss, RCE, auth bypass, data corruption, PII leak); patch + `rc.2` cycle if not, with reset window.
- [ ] **LAUNCH-15**: `v1.0.0` tag is cut; release workflow republishes; post-publish smoke passes against GA artifacts.
- [ ] **LAUNCH-16**: Docs site `latest` redirects update within 1 hour of GA tag; npm `latest` tag updated.
- [ ] **LAUNCH-17**: Announcement goes live coordinated same-day across blog, HN, PH, X, LinkedIn.
- [ ] **LAUNCH-18**: Status page (e.g., static `status.spatula.dev`) is live and linked from README before launch day.
- [ ] **LAUNCH-19**: 72-hour launch-day active monitoring — any Critical triaged within 24h; first weekly patch posted if fixes landed.
- [ ] **LAUNCH-20**: Launch retrospective is published 72h after GA.

---

## v2 Requirements

Acknowledged but explicitly deferred per spec §2.2 — surface in a later milestone, not in v1.1 phases.

### Tooling & Distribution

- **DEFER-01**: First-party Helm chart (community chart welcome in v1.x; first-party targeted v1.1 — promised in `ROADMAP.md`).
- **DEFER-02**: Python / Java / Go SDKs (community-welcome, not first-party).
- **DEFER-03**: Public plugin API + plugin loader.

### Features

- **DEFER-04**: Scheduled / recurring crawls (users cron `spatula run` themselves at v1).
- **DEFER-05**: Incremental re-crawl of changed-since-last-run pages.
- **DEFER-06**: Reference web UI app (belongs in sibling repo or private SaaS, not OSS).
- **DEFER-07**: Native email/password auth (OIDC-only; users bring their own IDP).
- **DEFER-08**: i18n / non-English translations.

### Platform

- **DEFER-09**: Multi-region / data-residency features.
- **DEFER-10**: Native Windows shell (WSL only).
- **DEFER-11**: Load / perf / soak benchmarks beyond the measured baseline.
- **DEFER-12**: Self-hosted CI runners.
- **DEFER-13**: Reproducible builds.

## Out of Scope

Hard exclusions for v1.1; reasons recorded.

| Feature                                               | Reason                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Reference web UI in OSS repo                          | Spec §2.2 — belongs in sibling repo / private SaaS. Web-UI **enablement** (SDK, OpenAPI, SSE, browser OIDC) ships; UI itself does not. |
| Stripe billing / usage metering / tier presets in OSS | Carved out to private `spatula-saas` repo per spec §3.1 — commercial-revenue machinery is not OSS.                                     |
| Email/password auth                                   | OIDC-only at v1; self-hosters bring their own IDP. Avoids password-storage burden.                                                     |
| Per-file copyright headers                            | LICENSE at root is sufficient (spec §2.2).                                                                                             |
| Reference Slack/Discord chat integration              | Out of OSS scope; community can build via webhooks.                                                                                    |
| Telemetry / phone-home                                | Privacy promise; zero-telemetry declared in `docs/privacy.md`.                                                                         |
| `cmd` / PowerShell native support                     | WSL only; not a v1 priority.                                                                                                           |
| CLI a11y showcase beyond `NO_COLOR` + terminal-size   | Resource constraint; docs site IS held to WCAG 2.1 AA.                                                                                 |

## Traceability

| Requirement    | Phase               | Status  |
| -------------- | ------------------- | ------- |
| BLOCK-01       | Phase 15 (gate)     | Pending |
| BLOCK-02       | Phase 18 / Phase 22 | Pending |
| BLOCK-03       | Phase 20 (gate)     | Pending |
| BLOCK-04       | Phase 16 (gate)     | Pending |
| BLOCK-05       | Phase 22 (gate)     | Pending |
| BLOCK-06       | Phase 18 / Phase 22 | Pending |
| BLOCK-07       | Phase 22 (gate)     | Pending |
| BLOCK-08       | Phase 20 (gate)     | Pending |
| BLOCK-09       | Phase 18 / Phase 22 | Pending |
| CARVE-01..08   | Phase 15            | Pending |
| API-01..14     | Phase 16            | Pending |
| SDK-01..08     | Phase 16            | Pending |
| AUTH-01..08    | Phase 17            | Pending |
| SEC-01..12     | Phase 18            | Pending |
| LEGAL-01..08   | Phase 18            | Pending |
| DEPLOY-01..11  | Phase 19            | Pending |
| DOCS-01..10    | Phase 20            | Pending |
| CONTRIB-01..12 | Phase 21            | Pending |
| LAUNCH-01..20  | Phase 22            | Pending |

**Coverage:**

- v1 requirements: 120 total (9 BLOCK + 8 CARVE + 14 API + 8 SDK + 8 AUTH + 12 SEC + 8 LEGAL + 11 DEPLOY + 10 DOCS + 12 CONTRIB + 20 LAUNCH)
- Mapped to phases: 120
- Unmapped: 0 ✓

---

_Requirements defined: 2026-05-11_
_Last updated: 2026-05-11 after initial definition (derived from Wave 6 spec)_
