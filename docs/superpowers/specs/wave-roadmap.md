# Spatula Wave Roadmap

**Last updated:** 2026-04-09
**Open-source release target:** End of Wave 4

This document tracks the interleaved execution of Phase 12 (production hardening) and Phase 13 (local project-folder model). Each wave pairs server-layer work from Phase 12 with local-layer work from Phase 13, delivering working, testable increments.

**Specs:**
- Phase 12: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`
- Phase 13: `docs/superpowers/specs/2026-03-21-phase-13-project-folder-model-design.md`

---

## Status Overview

| Wave | Phase 12 (Server) | Phase 13 (Local) | Status |
|------|-------------------|------------------|--------|
| 1 | A: Infrastructure & deployment | Step 1: Extract orchestrators | **Complete** |
| 2 | D+F+J: Reliability, pipeline, local DX | Steps 2+3: SQLite + config | **Complete** (4 items deferred) |
| 3 | B+C+E: Auth, observability, performance + D/F deferred | Step 4: Pipeline runner + core CLI | **Complete** |
| 4 | G+H: API completeness, open-source readiness | Step 5: Data interaction commands | **Complete** |
| 5 | I: Hosted platform layer | Step 6: Remote operations | **Complete** |

---

## Wave 1 — Foundation (Complete)

### Phase 12A: Infrastructure & Deployment
Server lifecycle, connection pooling, CI/CD, containerization.

**Deliverables:**
- `pg.Pool` connection pooling with configurable pool size
- Graceful shutdown with 25-second timeout (API + workers)
- 6-job CI workflow (lint, typecheck, format, test, build, E2E)
- Multi-stage Dockerfiles for API, worker, CLI
- Production Docker Compose with migration service
- Worker selection via `SPATULA_WORKERS` env var

### Phase 13 Step 1: Extract Shared Pipeline Orchestrators
Refactor BullMQ workers into pure orchestrator functions in `@spatula/core`.

**Deliverables:**
- `crawl-orchestrator.ts`, `schema-orchestrator.ts`, `reconcile-orchestrator.ts`, `export-orchestrator.ts`
- BullMQ workers refactored to thin wrappers calling orchestrators
- Pipeline repo interfaces and dependency bundles in `pipeline/types.ts`

**Plans:**
- `docs/superpowers/plans/2026-03-22-wave-1a-orchestrator-extraction.md`
- `docs/superpowers/plans/2026-03-22-wave-1b-i-server-lifecycle.md`
- `docs/superpowers/plans/2026-03-23-wave-1b-ii-ci-cd-containerization.md`

---

## Wave 2 — Resilience & Local Data Layer (Complete)

### Phase 12D: Reliability & Resilience
Circuit breaker, retry strategies, dead letter queue.

**Deliverables:**
- `CircuitBreakerLLMClient` with CLOSED/OPEN/HALF_OPEN state machine
- Per-queue retry strategies (`QUEUE_JOB_OPTIONS`) with different backoff curves
- `dead_letter_queue` Postgres table with JSONB payload, ON DELETE SET NULL FKs
- `DlqRepository` with insert, findUnresolved, findById, resolve (TOCTOU-safe), countUnresolved
- `createDlqHandler()` fire-and-forget BullMQ failed event handler
- Admin DLQ API routes (list, get, retry with re-enqueue, discard)

### Phase 12F: Data Pipeline Hardening
Robots.txt, rate limiting, page budget, completion detection.

**Deliverables:**
- `RobotsTxtChecker` with per-domain cache, 1hr TTL, in-flight dedup, LRU eviction
- `DomainRateLimiter` interface + `InMemoryDomainRateLimiter` with serialized promise chain
- `PageBudget` interface + `InMemoryPageBudget`
- `CrawlCompletionChecker` (pending=0 && inProgress<=1)
- All 4 guards wired into crawl worker

### Phase 12J: Local Developer Experience
Ollama support, proxy/cookies, cost estimation, test command.

**Deliverables:**
- `OllamaClient` for local LLM inference (no retries, 120s timeout)
- `createLLMClient()` factory selecting OpenRouter/Ollama
- Proxy support in Playwright (via `newContext`) and Firecrawl (cookie-to-header)
- `estimateCost()` with per-purpose breakdown and model pricing data
- `spatula test <url>` single-page extraction command

### Phase 13 Step 2: SQLite Schema & Repository Layer
Local SQLite database mirroring Postgres.

**Deliverables:**
- 12 SQLite schema files (8 mirrored from Postgres + 4 local-only)
- `createProjectDb()` with WAL mode, foreign keys, Drizzle Kit migrations
- Schema parity test suite verifying SQLite ↔ Postgres column alignment
- CHECK constraints on enum columns, `sl_` index prefix

### Phase 13 Step 3: Config System
YAML parsing, global config, config resolution, config diff engine.

**Deliverables:**
- `parseProjectYaml()` with field shorthand expansion
- `loadGlobalConfig()` from `~/.spatula/config.yaml`
- `yamlToJobConfig()` with priority stack (defaults → global → project → CLI → env)
- `findProjectRoot()` directory walker
- `diffConfigs()` with field rename detection and URL normalization
- `ProjectConfigDiff`, `FieldChange`, `DiffImpact` types

### Phase 13 Step 2 continued: SQLite Repositories
Repository implementations and ProjectAdapter.

**Deliverables:**
- 12 SQLite repository classes implementing pipeline interfaces
- `ProjectAdapter` factory with pre-bound `projectId`
- Synthetic `JobRepository` composing from `project_meta` + `runs`
- `wrapStorageError()` utility for consistent error handling
- 65 integration tests against in-memory SQLite

**Plans:**
- `docs/superpowers/plans/2026-03-23-wave-2-1a-ollama-proxy-support.md`
- `docs/superpowers/plans/2026-03-24-wave-2-1b-cost-estimation-test-command.md`
- `docs/superpowers/plans/2026-03-24-wave-2-2a-circuit-breaker-retry.md`
- `docs/superpowers/plans/2026-03-24-wave-2-2b-pipeline-hardening.md`
- `docs/superpowers/plans/2026-03-25-wave-2-2c-dead-letter-queue.md`
- `docs/superpowers/plans/2026-03-24-wave-2-3a-sqlite-schema.md`
- `docs/superpowers/plans/2026-03-24-wave-2-3b-sqlite-repositories.md`
- `docs/superpowers/plans/2026-03-24-wave-2-4a-config-system.md`
- `docs/superpowers/plans/2026-03-24-wave-2-4b-config-diff-engine.md`

**Deferred to Wave 3:** The following Workstream D and F items were spec'd for Wave 2 but deferred because they depend on server infrastructure (Redis, admin auth) being built in Wave 3:
- Idempotency middleware with Redis-backed key store (spec 5.4)
- Worker health monitoring via Redis heartbeat + admin endpoint (spec 5.5)
- Quality score aggregation API `GET /api/v1/jobs/:id/quality` (spec 7.5)
- Confidence-based export filtering with `minQuality` parameter (spec 7.6)

---

## Wave 3 — Auth, Observability & Local Execution (Pending)

### Phase 12B: Security & Authentication
Two-tier auth, rate limiting, tenant quotas, audit logging.

**Key deliverables:**
- Pluggable `AuthProvider` interface (API key + JWT strategies)
- API key management endpoints with SHA-256 hashing, expiration, scope-based auth
- JWT validation via OIDC (Auth0, Clerk, Supabase Auth)
- 9 scope-based authorization patterns (`jobs:read`, `jobs:write`, etc.)
- Sliding-window rate limiting with Redis Lua script (free/standard/pro/enterprise tiers)
- Per-tenant resource quotas (concurrent jobs, pages, storage)
- Token-based WebSocket authentication (60-second single-use tokens)
- Append-only audit log table
- Security headers (HSTS, X-Frame-Options, etc.) + CORS configuration

**Spec:** Phase 12, Section 3

### Phase 12C: Observability & Monitoring
Metrics, tracing, error aggregation, health checks.

**Key deliverables:**
- OpenTelemetry SDK with Prometheus exporter (19 metrics: HTTP, queue, LLM, crawl, business)
- Request timing middleware (duration, method, route, status code)
- Distributed tracing with context propagation through BullMQ jobs
- Sentry integration for error aggregation (10% trace sample rate)
- LLM usage recording per-tenant/per-job with cost API (`GET /api/v1/usage`)
- Two-tier health endpoints (liveness + readiness probes)
- Bull Board queue dashboard at `/api/admin/queues`

**Spec:** Phase 12, Section 4

### Phase 12 D/F Deferred Items
Server-side features from Wave 2 that depend on Redis/auth infrastructure.

**Key deliverables:**
- Idempotency middleware: `Idempotency-Key` header with Redis-backed cache (24hr TTL) for mutating endpoints (spec 5.4)
- Worker health monitoring: Redis heartbeat every 30s per worker + `GET /api/v1/admin/workers` endpoint (spec 5.5)
- Quality score aggregation: `GET /api/v1/jobs/:id/quality` with entity count, avg quality, distribution, field completeness (spec 7.5)
- Confidence-based export filtering: `minQuality` and `fields` parameters on export creation (spec 7.6)

**Spec:** Phase 12, Sections 5.4-5.5, 7.5-7.6

### Phase 12E: Performance & Scalability
Content storage, streaming exports, query optimization, caching.

**Key deliverables:**
- `S3ContentStore` for AWS S3 / Cloudflare R2 / MinIO (implements existing `ContentStore` interface)
- Presigned download URLs for large exports
- Streaming JSON/CSV exporters via `AsyncIterable<Entity[]>` with chunked fetching
- Cursor-based entity pagination (keyset: `WHERE id > cursor ORDER BY id`)
- 4 new database indexes for common query patterns
- Redis read-through cache (`getOrFetch<T>(key, fetcher, ttlSeconds)`)
- Cursor-based pagination alongside offset pagination with opaque cursors
- Incremental fetch (`since` ISO 8601 timestamp)

**Spec:** Phase 12, Section 6

### Phase 13 Step 4: Local Execution Pipeline & Core CLI
Wire orchestrators + SQLite + config into a working local crawl.

**Key deliverables:**
- `LocalPipelineRunner` with 13-step execution flow
- In-memory priority queue, concurrency semaphore (default 5 parallel pages)
- Checkpoint/resume with Ctrl+C handler (10s drain, orphan recovery)
- Crash recovery and project lockfile (`.spatula/lock`)
- `DataSource` interface + `LocalDataSource` implementation (SQLite + EventEmitter)
- Compact progress display with `[d]` key for dashboard mode
- CLI commands: `spatula init` (wizard), `spatula run`, `spatula status`, `spatula reset`, `spatula new`
- Desktop notifications via `node-notifier`
- Structured JSON logging to `.spatula/logs/`

**Spec:** Phase 13, Section 4 + Sections 3, 10

**Decomposition:** `docs/superpowers/specs/2026-03-25-wave-3-decomposition-design.md`

**Sub-plans (7, server-first then local):**

| Sub-plan | Scope | Status |
|----------|-------|--------|
| 3-1a | Auth Core (AuthProvider, API keys, scopes, security headers, CORS) | **Complete** |
| 3-1b | Auth Advanced (JWT, rate limiting, quotas, WS auth, audit log) | **Complete** |
| 3-2 | Observability (OTel, tracing, Sentry, LLM cost, health, Bull Board) | **Complete** |
| 3-3a | Performance: Storage & Exports (S3, streaming, entity cursor) | **Complete** |
| 3-3b | Performance: Query & Caching (indexes, cursor pagination, Redis cache) | **Complete** |
| 3-4 | Deferred D/F (idempotency, worker health, quality API, export filtering) | **Complete** |
| 3-5 | Local Pipeline + Core CLI (LocalPipelineRunner, DataSource, CLI commands) | **Complete** |

**Plans:** To be written per sub-plan.

---

## Wave 4 — API Completeness & Open-Source Release (Complete)

### Phase 12G: API & CLI Completeness
Webhooks, bulk operations, diagnostics.

**Key deliverables:**
- Webhook configuration per-job with HMAC-SHA256 signing, event filtering, at-least-once delivery
- `spatula.webhooks` BullMQ queue + webhook worker
- Batch endpoints for actions and jobs (max 100 items, partial success)
- `spatula doctor` command with 9 pluggable health checks
- Request timeout middleware (30s default, 5min for exports)

**Spec:** Phase 12, Section 8

### Phase 12H: Open-Source Readiness
Licensing, documentation, community infrastructure.

**Key deliverables:**
- MIT License
- Comprehensive README (12 sections: hero, quickstart, architecture, config, CLI, API, etc.)
- CONTRIBUTING.md with workflow, code style, testing, PR process
- Auto-generated CHANGELOG via `release-please` GitHub Action
- GitHub issue/PR templates
- `docs/architecture.md` with dependency diagram, data flow, interface map
- 4 example project configurations in `examples/`

**Spec:** Phase 12, Section 9

### Phase 13 Step 5: Data Interaction Commands
CLI commands for exploring, exporting, and managing project data.

**Key deliverables:**
- `spatula explore` — Entity explorer TUI backed by `LocalDataSource`
- `spatula export` — Local export using export orchestrator (all 5 formats)
- `spatula review` — Action review TUI backed by `LocalDataSource`
- `spatula schema` — Schema viewer (fields, versions, evolution history)
- `spatula logs` — Run log viewer
- `spatula add` — Add seed URLs with dedup
- `spatula config` — Open `spatula.yaml` in `$EDITOR`
- `spatula estimate` — Cost estimation integrated with config system
- `spatula setup` — Global reconfiguration wizard

**Spec:** Phase 13, Section 7

**Decomposition:** `docs/superpowers/specs/2026-03-31-wave-4-decomposition-design.md`

**Sub-plans (4, server-first then local then docs):**

| Sub-plan | Scope | Status |
|----------|-------|--------|
| 4-1 | Server Completeness (webhooks, bulk ops, timeout, doctor) | **Complete** |
| 4-2 | CLI Foundations (hook adaptation, utility commands, CSS extractor) | **Complete** |
| 4-3 | CLI Data Commands (explore, export, review, schema, logs, dashboard) | **Complete** |
| 4-4 | Open-Source Readiness (LICENSE, README, docs, examples, templates) | **Complete** |

**This wave concludes with the open-source release.**

---

## Wave 5 — Hosted Platform & Remote Operations (Complete)

### Phase 12I: Hosted Platform Layer
Multi-tenant SaaS with billing, admin, retention.

**Key deliverables:**
- JWT-based user management via OIDC with `user_tenants` mapping + role-based access
- Stripe usage-based billing (4 tiers: Free, Starter, Pro, Enterprise)
- Hourly usage aggregation with metering across jobs, pages, LLM tokens, storage
- Quota enforcement at job start
- 11 admin API routes under `/api/v1/admin/`
- Configurable retention policies (90d completed, 30d failed, 365d audit)
- Daily cleanup worker at 03:00 UTC with batched deletes

**Spec:** Phase 12, Section 10

### Phase 13 Step 6: Remote Operations & Hosted Integration
Push/pull bridge between local projects and hosted platform.

**Key deliverables:**
- `spatula remote add/list/remove` — Remote configuration
- `spatula push` — Config upload, job creation, old job cancellation prompt
- `spatula pull` — Results download with cursor pagination, incremental pull, schema conflict resolution
- `spatula remote start/pause/resume/cancel/status/watch` — Remote job lifecycle
- `ApiDataSource` implementation wrapping existing `ApiClient`
- Remote link tracking in `project_meta`

**Spec:** Phase 13, Sections 8-9

**Decomposition:** `docs/superpowers/specs/2026-04-06-wave-5-decomposition-design.md`

**Sub-plans (6):**

| Sub-plan | Scope | Status |
|----------|-------|--------|
| 5-1 | User & Auth Foundation (user_tenants, JWT tenant resolution, cursor streaming) | **Complete** |
| 5-2 | Billing & Metering (Stripe, usage_records, quota enforcement, metering worker) | **Complete** |
| 5-3 | Admin & Retention (admin routes, cleanup worker, tenant suspension) | **Complete** |
| 5-4 | Remote Config & Push (remote add/list/remove, push, job lifecycle, ApiDataSource) | **Complete** |
| 5-5 | Pull Flow (pull command, schema conflict TUI, incremental, crash recovery, source filter) | **Complete** |
| 5-6 | Deferred Items (quota audit, add dedup, reset --keep-remote, CSS tables, pull flags) | **Complete** |

**Wave 5-6 post-review cleanup (2026-04-20):** retrospective superpowers review found 5 defects (1 Critical composite-cursor, 3 Important, 1 Minor) + pre-existing TS errors + migration orchestration root-cause. All closed in commits `9a19bc2`, `a39dc2d`, `d775ef6`, `51d088d`, `0d80b47`, `46cf144`, `a492c7f`. Plan checkboxes flipped in `e66b59e`. See the plan file's "Post-ship follow-ups" section for commit-by-commit detail.

**Plans:**
- `docs/superpowers/plans/2026-04-06-wave-5-1-user-auth-foundation.md`
- `docs/superpowers/plans/2026-04-06-wave-5-2-billing-metering.md`
- `docs/superpowers/plans/2026-04-07-wave-5-3-admin-retention.md`
- `docs/superpowers/plans/2026-04-07-wave-5-4-remote-config-push.md`
- `docs/superpowers/plans/2026-04-08-wave-5-5-pull-flow.md`
- `docs/superpowers/plans/2026-04-09-wave-5-6-deferred-items.md`

---

## Dependency Graph

```
Wave 1 (Foundation)
  ├── Phase 12A: Infrastructure
  └── Phase 13 Step 1: Extract orchestrators
        |
Wave 2 (Resilience + Local Data)
  ├── Phase 12 D+F+J: Reliability, pipeline, local DX (core items)
  ├── Phase 13 Step 2: SQLite schema + repos
  └── Phase 13 Step 3: Config system
        |
Wave 3 (Auth + Observability + Local Execution)
  ├── Phase 12 B+C+E: Auth, observability, performance
  ├── Phase 12 D/F deferred: Idempotency, worker health, quality API, export filtering
  └── Phase 13 Step 4: Pipeline runner + core CLI
        |
Wave 4 (API Completeness + Open-Source Release)  ← RELEASE TARGET
  ├── Phase 12 G+H: Webhooks, bulk ops, docs, licensing
  └── Phase 13 Step 5: Data interaction commands
        |
Wave 5 (Hosted Platform)
  ├── Phase 12I: Billing, admin, retention
  └── Phase 13 Step 6: Remote operations
```

Phase 12 touches server code (`apps/api`, `packages/queue`). Phase 13 adds local code (`packages/db/project-db`, `packages/core/pipeline`, CLI commands). Minimal file overlap — the orchestrator extraction in Wave 1 is the shared prerequisite.

---

## Test Counts (as of Wave 5 completion)

| Package | Test Files |
|---------|-----------|
| `@spatula/core` | 90 |
| `@spatula/db` | 29 |
| `@spatula/queue` | 18 |
| `@spatula/shared` | 10 |
| `@spatula/api` | 49 |
| `@spatula/cli` | 97 |
| `tests/e2e` | 1 |
| **Total** | **294** |
