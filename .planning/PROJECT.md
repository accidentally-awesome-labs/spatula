# Spatula

## What This Is

Spatula is an AI-powered web crawling platform: users describe in plain language what data they want, provide seed URLs, and get a clean, unified, production-ready dataset. It runs as a hosted multi-tenant API plus a local-first CLI (Ink TUI) with push/pull between the two.

## Core Value

Turn "I want X data from these sites" into a production-quality dataset with provenance — without writing extractors, schemas, or reconciliation code.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ **Pure core engine** — `@spatula/core` orchestrators (crawl/schema/reconcile/export) with zero HTTP/queue knowledge — Wave 1
- ✓ **Action-based execution model** — 52 action types (25 pipeline + 30 config) with safety policies and review queue — Phases 1–6
- ✓ **Pluggable crawlers** — Playwright + Firecrawl behind a `Crawler` interface — Phase 2
- ✓ **LLM-powered extraction with smart routing** — OpenRouter + Ollama, three-tier model routing (fast/primary/smart), circuit breaker — Phases 3, Wave 2
- ✓ **Intelligent schema evolution** — batched, distributed-locked, category-aware field relevance — Phase 6
- ✓ **Three-layer reconciliation** — synonym detection → normalization → entity reconciliation with provenance — Phase 7
- ✓ **Storage layer** — Postgres (production) + SQLite (local), `ContentStore` interface with S3/Postgres/local backends — Phase 4, Wave 3-3a
- ✓ **Job orchestration** — BullMQ workers (crawl, extract, schema, reconciliation, export), retries, DLQ, rate limiting, page budget, robots.txt — Phase 5, Wave 2
- ✓ **REST API** — Hono server with multi-tenant routing, OpenAPI, WebSockets, Bull Board admin — Phase 8, Wave 3
- ✓ **Auth + tenancy** — pluggable AuthProvider (NoAuth/API key/JWT-OIDC), 9 scopes, sliding-window rate limiting, per-tenant quotas, audit log — Wave 3-1a/3-1b
- ✓ **Observability** — OpenTelemetry (Prometheus + traces), Sentry, LLM usage/cost API, two-tier health checks — Wave 3-2
- ✓ **Performance** — S3 content store, streaming JSON/CSV/Parquet exports, cursor-based pagination, Redis read-through cache — Wave 3-3a/3-3b
- ✓ **Idempotency + worker health + quality API** — `Idempotency-Key` middleware, Redis heartbeats, `/jobs/:id/quality`, `minQuality` export filter — Wave 3-4
- ✓ **Local execution mode** — `LocalPipelineRunner` (in-process priority queue + semaphore), SQLite project DB, project lockfile, crash recovery — Wave 3-5
- ✓ **Conversational + dashboard + review + explorer CLI** — Ink TUI: init / run / status / reset / review / explore / dashboard — Phase 9a/9b/9c, Wave 3/4
- ✓ **Webhooks + bulk ops + doctor** — HMAC-signed webhooks, batch action/job endpoints, `spatula doctor` 9-check diagnostics — Wave 4-1
- ✓ **Open-source release readiness** — MIT license, CONTRIBUTING, SECURITY, README (12 sections), `release-please`, examples, GitHub templates — Wave 4-4
- ✓ **Hosted platform layer** — JWT/OIDC users, `user_tenants`, Stripe usage-based billing (Free/Starter/Pro/Enterprise), hourly metering, 11 admin routes, retention policies, daily cleanup worker — Wave 5-1/5-2/5-3
- ✓ **Remote operations** — `spatula remote/push/pull` with config upload, cursor-paginated incremental pull, schema conflict resolution TUI, crash recovery, run-record cleanup — Wave 5-4/5-5
- ✓ **Wave-5 deferred items** — `spatula add` history dedup, CSS table extraction, `reset --keep-remote`, `ApiDataSource`, audit logging for quota events, OpenRouter cost extraction, observable gauges — Wave 5-6
- ✓ **OSS carve-out & migration squash** — Section A billing/Stripe/metering extracted to private `accidentally-awesome-labs/spatula-saas` with preserved history (`git filter-repo`); Section B coupling stripped across 5 packages; new `GET /api/v1/auth/me` replaces CLI's `/billing/subscription` probe; pre-Wave-6 migrations squashed to `0000_v1_baseline.sql` under `__drizzle_migrations_oss`; forward + reverse-contract test suites (`tests/carveout/`, `tests/private-contract/`) wired into PR CI; pg_dump equivalence gate; no-migration-downgrade + expand-contract policies committed to `docs/runbooks/upgrade.md` — Phase 15 (PR #1)
- ✓ **Browser auth + SSE + CORS** — SSE job-event stream `GET /api/v1/jobs/:id/events` (Redis Streams dual-publish, `Last-Event-ID` resume, 5-min replay buffer, 15s keep-alive, `replay_truncated` signal) with single-use `?token=` stream tokens; function-form CORS with single-label wildcard-subdomain support; zero-config Dex OIDC example kit (`examples/auth-dex/`, `docker compose up`); zero-downtime API key rotation with two-key grace window (`POST /api/v1/api-keys/:id/rotate`); authoritative `docs/api-auth.md`; OpenAPI-driven cross-tenant isolation audit suite (`tests/isolation/`); M2M `client_credentials` e2e against Dex; `@spatula/client` `subscribeJobEvents` SSE method — Phase 17
- ✓ **Security hardening + legal** — prompt-injection defense (7 mitigations in `StaticExtractor`: `<UNTRUSTED_CONTENT>` sentinel wrapping, hardened system prompt, one stricter retry, field allowlist, free-text length caps, output-content scanner) + 10 adversarial HTML fixtures vs pinned models on a path-triggered + daily-cron live-LLM CI lane; one shared `@spatula/shared` redactor wired across all four log sinks (stdout, file, Sentry, OTel) with per-sink tests; forensic provenance (`forensic:true` archival + `suspicious_extraction` DLQ + `GET /api/v1/admin/forensic/extractions` experimental endpoint + `client.experimental.forensic.*`); full DSR surface (async cascade tenant-delete BullMQ worker — idempotent + fail-loud, audit redact-in-place + tombstone — `DELETE`/import admin routes, `spatula admin tenant delete|export|import` CLI, deletion + portability e2e round-trips); hardened `audit.yml` (OSV + license allowlist + gitleaks/trufflehog) + Dependabot/Renovate + auto-generated `THIRD_PARTY_NOTICES.md`; legal docset (LICENSE copyright, TRADEMARK, brand license, versioned CLA via cla-assistant.io, SECURITY.md, README disclaimer, abuse-contact User-Agent) — Phase 18

### Active

<!-- Current scope. Building toward these. -->

## Current Milestone: v1.1 Public Launch (Wave 6 / Phase 14)

**Goal:** Ship Spatula v1.0.0 as a public OSS project — public GitHub repo, npm packages with provenance, signed multi-arch container images on GHCR, docs site live at `docs.spatula.dev`, clean OSS-vs-private-SaaS carve-out, stable public REST contract, web-UI enablement (SDK + SSE + browser OIDC) in place.

**Target features (8 phases, 15–22; spec: `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md`):**

- Carve-out billing/Stripe/metering → private `spatula-saas` repo; squash OSS migrations to `000_v1_baseline.sql`; reverse-contract test
- API contract hardening: error envelope, rate-limit headers, cursor-first pagination, OpenAPI runtime endpoint, frozen error codes
- SDK packages: `@spatula/client` (<50KB gzipped) + `@spatula/core-types`; SDK ↔ server compat matrix; npm `--provenance` publishing
- Browser auth + SSE (`GET /api/v1/jobs/:id/events` with Last-Event-ID resume) + CORS + Dex OIDC recipe + cross-tenant isolation audit
- Security hardening: prompt-injection defense + ≥10 adversarial fixtures vs pinned models, secret/PII redaction across all sinks, full DSR (delete/export/rectify) surface
- Legal: CLA via cla-assistant.io, TRADEMARK + brand-license (non-MIT), CONTRIBUTOR enumeration, README legal disclaimer, abuse-contact User-Agent
- Deployment: k8s kustomize, Render blueprint, multi-arch cosign-signed container images + SBOM, distroless bases, backup-restore + upgrade + reverse-proxy + hardware-sizing runbooks
- Docs: VitePress on Cloudflare Pages, WCAG 2.1 AA, auto-gen API ref from OpenAPI, auto-gen CLI ref from yargs, OIDC cookbooks (Auth0/Keycloak/Google Workspace)
- Contributor infra: CODE_OF_CONDUCT (Contributor Covenant 2.1), GOVERNANCE, ROADMAP, CODEOWNERS, dependabot/renovate, GH Discussions, devcontainer, CI topology (preflight/unit+int/contract/e2e/audit/release/release-dry-run), mock-vs-live LLM test split
- Launch mechanics: brand assets, pre-flip secret-scan + manual category audit gate, RC.1 cut, 2-week beta with public `preview-bug` issue label, zero-Critical gate, GA cut, coordinated announcement (blog/HN/PH/X/LinkedIn), 72h launch-day monitoring with status page

**Pre-launch blockers (status as of 2026-05-18; see spec §7):**

- [x] `accidentally-awesome-labs/spatula-saas` private repo created — cleared 2026-05-17 (Phase 15 Wave 1, BLOCK-01)
- [ ] Legal entity formed (or interim-name fallback explicitly accepted)
- [ ] `spatula.dev` + `docs.spatula.dev` domains owned
- [ ] npm `@spatula` org owned (or fallback chosen)
- [x] GitHub `accidentally-awesome-labs/spatula` namespace claimed — cleared 2026-05-18 (Phase 15 Wave 6, BLOCK-05 pulled forward from Phase 22 to unblock PR #1)
- [ ] Trademark "Spatula" USPTO search done; conflict-free
- [ ] Beta invitees lined up (5–10 names, ≥1 non-developer)
- [ ] Cloudflare Pages account + DNS for docs site
- [ ] OpenRouter CI secret rotation plan committed

**Key constraints from spec:**

- Reference web UI is **non-goal** — belongs in sibling repo or private SaaS; this milestone ships **web-UI enablement** (SDK, OpenAPI, SSE, browser OIDC), not the UI itself
- Internal packages (`@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/api`, `@spatula/shared`) carry **no compat guarantee**; only `@spatula/cli`, `@spatula/client`, `@spatula/core-types` follow strict semver
- v1.0 ships with **zero experimental surfaces** except the forensic-extractions admin endpoint (§3.7.3); future experimentals governed by deprecation policy (6-month max lifetime)
- Two separate Drizzle migration folders + tracking tables (`__drizzle_migrations_oss`, `__drizzle_migrations_saas`) — no shared journal
- Spec-budget: ~36–38 active sessions + 2-week RC + 3-day launch ≈ 10 weeks wall-clock; budget at least one `rc.2` cycle

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- **Visual scrape-builder UI** — out of scope for v1.0; CLI + API are the primary interfaces. Web dashboard is post-launch.
- **Custom non-LLM scraping rules language** — replaced by action-based config + LLM-driven schema evolution.
- **Per-page schema evolution** — replaced by batched evaluation under distributed lock to eliminate races and reduce LLM cost.
- **Hardcoded worker counts** — replaced by config-driven, per-tenant resource quotas.
- **Hosted-only deployment** — local-first via SQLite + LocalPipelineRunner is a first-class mode, not just a debug option.

## Context

- **Origin design doc:** `docs/plans/2026-03-06-spatula-design.md` (approved 2026-03-06).
- **Wave roadmap:** `docs/superpowers/specs/wave-roadmap.md` tracks Phase 12 (server) × Phase 13 (local) interleave through Waves 1–5.
- **Codebase mapping:** `.planning/codebase/{STACK,ARCHITECTURE,STRUCTURE,CONVENTIONS,INTEGRATIONS,TESTING,CONCERNS}.md` — generated 2026-05-06.
- **Wave 6 / Phase 14 — public-launch design spec** exists at `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md`; Wave 6-1 carve-out + migration squash plan exists at `docs/superpowers/plans/2026-04-20-wave-6-1-carveout-migration-squash.md`. Neither has been executed yet.
- **Test footprint at v1.0 close:** ~294 test files across 5 packages, 2,302 unit + 71 integration tests in CLI flow alone.
- **Stack snapshot:** TypeScript monorepo (pnpm + Turborepo), Hono API, Drizzle (Postgres + SQLite), BullMQ, Ink CLI, OpenRouter + Ollama, Playwright + Firecrawl, OpenTelemetry, Stripe.

## Constraints

- **Tech stack:** TypeScript only across core, API, CLI, workers — Single-language monorepo eliminates context-switch tax and lets types flow end-to-end.
- **Language model:** OpenRouter as primary, Ollama as local fallback — Multi-model from day one; smart routing tier (fast/primary/smart) controls cost.
- **Database:** Postgres 16 production, SQLite (better-sqlite3) for local-mode projects — JSONB and CHECK constraints; SQLite migration parity tested.
- **Queue:** BullMQ + Redis 7 today; orchestrators must remain pure so Temporal/Inngest can swap in — Reliability bar rises with multi-tenancy.
- **Tenancy:** Every table, query, and queue scoped by `tenant_id` — Single-tenant tooling cannot retroactively become safe; multi-tenant is the floor.
- **Workers:** Stateless, all state in Postgres/Redis — Horizontal scale and replaceability.
- **Local-first parity:** Anything users can do via the hosted API must also work via `spatula run` against SQLite — Open-source story depends on this.
- **Open-source:** MIT license, public roadmap, no proprietary lock-ins in core — Wave 4 shipped on this premise.

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision                                                                                   | Rationale                                                                                                                              | Outcome                 |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Pure orchestrators in `@spatula/core` (no BullMQ/HTTP imports)                             | Lets the CLI run the same pipeline in-process via `LocalPipelineRunner`, and lets BullMQ be replaced later                             | ✓ Good                  |
| Action-based execution (52 typed actions) over imperative state mutation                   | Auditable, reviewable, replayable, and gives the LLM a constrained surface to recommend changes                                        | ✓ Good                  |
| Three-tier LLM routing (fast / primary / smart) via `model-router.ts`                      | Cost control without sacrificing quality on hard tasks                                                                                 | ✓ Good                  |
| Batched schema evolution under distributed lock                                            | Eliminates race conditions and cuts LLM cost vs per-page evolution                                                                     | ✓ Good                  |
| `ContentStore` interface with Postgres/Local/S3 implementations                            | Lets dev/local stay simple while production swaps to S3/R2 without code changes                                                        | ✓ Good                  |
| Single Hono API + tenant scoping baked into every middleware                               | Multi-tenancy retrofit later would have been worse than the up-front cost                                                              | ✓ Good                  |
| Ink (React for terminals) for the CLI                                                      | Conversational + dashboard + review + explorer modes share components and state                                                        | ✓ Good                  |
| Stripe usage-based billing instead of seat-based                                           | Aligns price with actual crawl/LLM cost per tenant                                                                                     | ✓ Good                  |
| `DataSource` interface (`LocalDataSource` SQLite, `ApiDataSource` HTTP)                    | One CLI codebase, two execution modes; pull-flow and explorer reuse the same adapter                                                   | ✓ Good                  |
| Composite `(entity_id, extraction_id)` cursor for `EntitySourceRepository.findByJobCursor` | Single-column cursor dropped rows when an `entityId`'s sources split across a page boundary (Wave 5-6 post-review)                     | ✓ Good                  |
| `release-please` for changelog automation                                                  | One-click public releases without hand-written CHANGELOG drift                                                                         | — Pending (post-launch) |
| Wave 6 (public launch) carve-out + migration squash planned but unexecuted                 | Squashing migrations before first public version cleans the on-disk schema; carve-out separates internal infra from public OSS surface | — Pending               |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):

1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):

1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

_Last updated: 2026-05-20 after completing Phase 18 (Security Hardening & Legal) — prompt-injection defense (7 mitigations) + 10 adversarial fixtures vs pinned models, shared redactor across all 4 log sinks, full DSR delete/export/import surface with idempotent fail-loud cascade, forensic provenance, audit-CI hardening, and the complete legal docset. All 20 SEC/LEGAL requirements verified (20/20); the verifier initially found 2 documentation gaps (SEC-07 security-model.md, SEC-08 privacy.md) which were closed in commit 8e268d9 before phase completion. Two human checkpoints resolved during execution: USPTO TESS trademark search confirmed conflict-free, cla-assistant.io GitHub App installed. Follow-ups tracked for the Phase 22 public flip: cla-assistant.io first-PR runtime check + replace the SECURITY.md GPG public-key placeholder._
