# Wave 3 Decomposition Design: Auth, Observability & Local Execution

**Status:** Approved
**Created:** 2026-03-25
**Scope:** Decompose Wave 3 into ordered, session-sized implementation sub-plans following the Wave 1/2 pattern.

---

## 1. Overview

Wave 3 covers 5 workstreams across Phase 12 (server) and Phase 13 (local):

- **Phase 12B:** Security & Authentication
- **Phase 12C:** Observability & Monitoring
- **Phase 12E:** Performance & Scalability
- **Phase 12 D/F deferred:** Idempotency, worker health, quality API, export filtering
- **Phase 13 Step 4:** Local pipeline runner + core CLI

**Strategy:** Server-first, then local. All Phase 12 work completes before Phase 13 Step 4 begins. The local pipeline (3-5) is intentionally independent of server sub-plans — it builds only on Wave 1/2 outputs.

**Baseline:** 1,342 tests across 4 packages at Wave 2 completion.

---

## 2. Sub-plan Summary

| Sub-plan | Scope | Spec Sections | Est. New Files | Order |
|----------|-------|---------------|----------------|-------|
| **3-1a** | Auth Core | 12: 3.1.1–3.1.5, 3.3, 3.7 | ~8 | 1 |
| **3-1b** | Auth Advanced | 12: 3.1.3, 3.2, 3.4–3.6 | ~8 | 2 |
| **3-2** | Observability & Monitoring | 12: 4.1–4.6 | ~10 | 3 |
| **3-3a** | Performance: Storage & Exports | 12: 6.1–6.2 | ~8 | 4 |
| **3-3b** | Performance: Query & Caching | 12: 6.3–6.5 | ~7 | 5 |
| **3-4** | Deferred D/F Items | 12: 5.4–5.5, 7.5–7.6 | ~6 | 6 |
| **3-5** | Local Pipeline + Core CLI | 13: 3, 4, 10 | ~20 | 7 |

**Execution order:**

```
3-1a → 3-1b → 3-2 → 3-3a → 3-3b → 3-4 → 3-5
```

---

## 3. Dependency Graph

```
3-1a (Auth Core)
  │  Provides: AuthProvider, scopes, auth middleware, security headers, CORS
  │
  ├──→ 3-1b (Auth Advanced)
  │      Provides: JWT, rate limiting (Redis Lua), quotas, WS auth, audit log
  │      Establishes: shared Redis client pattern
  │      │
  │      ├──→ 3-2 (Observability)
  │      │      Uses: admin scope for Bull Board
  │      │
  │      ├──→ 3-3b (Query & Caching)
  │      │      Uses: Redis client from 3-1b, entity cursor from 3-3a
  │      │      Provides: cursor pagination, RedisCache
  │      │
  │      └──→ 3-4 (Deferred D/F)
  │             Uses: Redis client, admin/jobs:read scopes,
  │             cursor pagination from 3-3b, entity indexes from 3-3b
  │
3-3a (Storage & Exports)  ← independent root, no auth dependency
  │  Provides: S3ContentStore, streaming exporters, entity cursor
  │
  └──→ 3-3b (see above, also depends on 3-1b for Redis)

3-5 (Local Pipeline + Core CLI)  ← independent root
       Uses only: Wave 1 orchestrators, Wave 2 SQLite/config/pipeline-hardening
       No dependency on any Wave 3 server sub-plan
```

**Note:** 3-3a and 3-5 are independent roots — they have no dependency on 3-1a/3-1b. 3-3a could run in parallel with 3-1b or 3-2. 3-5 could run in parallel with all server sub-plans. The linear execution order is for simplicity.

---

## 4. Sub-plan Details

### 4.1 Sub-plan 3-1a: Auth Core

**Goal:** Establish the foundational authentication layer that all subsequent server work depends on.

**Deliverables:**

1. `AuthProvider` interface + `AuthResult` type (`packages/shared/src/auth/types.ts`)
2. `ApiKeyAuthProvider` — SHA-256 hashing, lookup by hash, expiry/revocation checks
3. `NoAuthProvider` — pass-through for `AUTH_STRATEGY=none` (preserves current dev behavior)
4. `createAuthProvider()` factory — selects provider based on `AUTH_STRATEGY` env var (`none`, `api-key`, or `jwt` — JWT implemented in 3-1b)
5. `api_keys` Postgres table — Drizzle schema + migration. Columns: `id`, `tenant_id` (FK), `key_hash`, `key_prefix`, `name`, `scopes`, `expires_at`, `last_used_at`, `created_at`, `revoked_at`. Index on `key_hash` WHERE `revoked_at IS NULL`.
6. `ApiKeyRepository` (`packages/db/src/repositories/api-key-repository.ts`) — create, findByHash, listByTenant, revoke
7. Auth middleware (`apps/api/src/middleware/auth.ts`) — extracts token from `Authorization: Bearer` header, calls `provider.authenticate()`, sets `auth` and `tenantId` on Hono context. Skip-auth paths: `/health`, `/health/live`, `/health/ready`, `/api/docs`, `/api/openapi.json`.
8. `requireScope()` middleware — per-route scope enforcement for 9 scope patterns (`jobs:read`, `jobs:write`, `exports:read`, `exports:write`, `actions:read`, `actions:write`, `tenants:admin`, `keys:manage`, `admin`)
9. API key CRUD routes — `POST /api/v1/api-keys` (returns raw key once), `GET /api/v1/api-keys` (prefix + name only), `DELETE /api/v1/api-keys/:id` (soft delete via `revoked_at`). Requires `keys:manage` scope.
10. Security headers middleware — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `X-XSS-Protection: 0`, `Referrer-Policy: strict-origin-when-cross-origin`
11. CORS configuration — Hono built-in CORS with `CORS_ALLOWED_ORIGINS` env var (comma-separated, default: `http://localhost:3000`)
12. Wire into middleware chain — when `AUTH_STRATEGY != none`, `tenantMiddleware` is removed; `authMiddleware` becomes sole source of `tenantId`. `validateTenant` remains downstream.

**Existing test impact:** All 175 existing API tests must continue passing. Strategy: test environment sets `AUTH_STRATEGY=none` (overriding the production default of `api-key`) so existing tests pass unchanged. New auth-specific tests exercise auth paths explicitly.

**New env vars:** `AUTH_STRATEGY` (default: `api-key` per Phase 12 spec; test environment overrides to `none`), `CORS_ALLOWED_ORIGINS`

**Spec references:** Phase 12, sections 3.1.1–3.1.5, 3.3, 3.7

---

### 4.2 Sub-plan 3-1b: Auth Advanced

**Goal:** Higher-level auth features building on the core auth middleware from 3-1a.

**Deliverables:**

1. `JwtAuthProvider` — OIDC-compliant JWT validation using `jose` library. JWKS caching, `iss`/`aud`/`exp` claim validation. Extracts `sub` (userId), `tenant_id` (custom claim), `scopes`. Registered in `createAuthProvider()` factory for `AUTH_STRATEGY=jwt`.
2. Sliding-window rate limiting middleware (`apps/api/src/middleware/rate-limit.ts`) — Redis Lua script for atomic check-and-increment. 4 tiers:
   - `free`: 60 req/min, 2 concurrent jobs
   - `standard`: 300 req/min, 10 concurrent jobs
   - `enterprise`: 1500 req/min, 50 concurrent jobs
   - `unlimited`: no limits (internal/admin)
   - Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` (on 429 only)
   - Key pattern: `ratelimit:{tenantId}:{window}`
   - Tier determined from `tenants.quotas.rateLimitTier`, not from auth token
3. Tenant resource quotas — `quotas` JSONB column on `tenants` table (migration). Default: `{ maxConcurrentJobs: 2, maxPagesPerJob: 5000, maxEntitiesPerExport: 50000, maxStorageMb: 1000, rateLimitTier: "free" }`. Enforcement at 4 points:
   - `JobManager.startJob()` — concurrent job count
   - Crawl worker — page count against `maxPagesPerJob`
   - Export worker — entity count (already enforces `MAX_EXPORT_ENTITIES`, make per-tenant)
   - Content store — `storage_bytes_used` column on `tenants` for tracking, incremented on store, decremented on delete. Initial implementation instruments `PgContentStore` only; 3-3a wires the same tracking into `S3ContentStore`.
4. WebSocket token auth — `POST /api/v1/ws-token` endpoint (requires valid auth). Returns single-use token stored in Redis (`ws-token:{token}`, value: `{ tenantId, expiresAt }`, 60s TTL). WS upgrade handler validates token, extracts tenantId, deletes token. Legacy `?tenantId=` query param removed when `AUTH_STRATEGY != none`.
5. Audit logging — `audit_log` Postgres table + migration. Columns: `id`, `tenant_id`, `actor_id`, `actor_type`, `action`, `resource_type`, `resource_id`, `metadata` (JSONB), `ip_address`, `created_at`. Indexes: `idx_audit_tenant_time`, `idx_audit_action_time`. `AuditLogger` service with fire-and-forget writes via `setImmediate`. Events: `auth.login_success`, `auth.login_failure`, `api_key.created`, `api_key.revoked`, `job.created`, `job.started`, `job.cancelled`, `job.deleted`, `export.requested`, `export.downloaded`, `tenant.updated`, `tenant.quota_exceeded`.
6. Shared Redis client — establish the `ioredis` client pattern added to `AppDeps`. BullMQ has its own internal connection; this shared client is for rate limiting, WS tokens, and later features (idempotency, cache, worker health). Configured via existing `REDIS_URL`.

**New env vars:** `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_JWKS_URL`

**Spec references:** Phase 12, sections 3.1.3, 3.2, 3.4–3.6

---

### 4.3 Sub-plan 3-2: Observability & Monitoring

**Goal:** Full observability stack — metrics, tracing, error aggregation, cost tracking, health checks, and queue dashboard.

**Deliverables:**

1. OpenTelemetry metrics setup (`packages/shared/src/metrics.ts`) — `MeterProvider` with `PrometheusExporter` on port 9464 (separate from API port). 19 metrics with `{ tenantId, jobId }` labels where applicable:
   - **API (3):** `http_request_duration_ms` (histogram), `http_requests_total` (counter), `http_active_connections` (up-down counter)
   - **Queue (3):** `queue_job_duration_ms` (histogram), `queue_jobs_total` (counter), `queue_depth` (observable gauge)
   - **LLM (3):** `llm_tokens_used` (counter), `llm_request_duration_ms` (histogram), `llm_cost_usd` (counter)
   - **Crawl (3):** `pages_processed_total` (counter), `page_crawl_duration_ms` (histogram), `entities_created_total` (counter)
   - **Business (3):** `active_jobs` (observable gauge), `tenant_count` (observable gauge), `export_size_bytes` (histogram)
   - **Circuit breaker (2):** Wire existing `CircuitBreakerLLMClient` stubs from Wave 2 to real OTel instruments: `circuit_breaker_state` (gauge), `circuit_breaker_rejections_total` (counter)
   - All OTel setup is opt-in — no-ops when env vars are not configured.
2. Request timing middleware (`apps/api/src/middleware/timing.ts`) — records duration, method, route path, status code. Tracks active connections via up-down counter. Positioned early in middleware chain (before auth) to capture full request duration.
3. Distributed tracing (`packages/shared/src/tracing.ts`) — `NodeTracerProvider` with `BatchSpanProcessor`, OTLP exporter. Auto-instruments HTTP (incoming + outgoing), Postgres queries, Redis commands. BullMQ context propagation: producer injects active context into `job.data._traceContext`, consumer extracts parent context and creates child span.
4. Sentry integration (`packages/shared/src/sentry.ts`) — `@sentry/node` init with DSN, environment, sample rate. Integration points: API error handler (5xx), worker failed job handlers, LLM unexpected response errors.
5. LLM cost tracking — `llm_usage` Postgres table + migration. Columns: `id`, `tenant_id` (FK, `ON DELETE CASCADE`), `job_id` (FK, `ON DELETE SET NULL` — survives job deletion), `model`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost_usd`, `purpose`, `created_at`. Indexes: `idx_llm_usage_tenant_time` on `(tenant_id, created_at DESC)`, `idx_llm_usage_job` partial index on `(job_id) WHERE job_id IS NOT NULL`. `LlmUsageRepository` (`packages/db/src/repositories/llm-usage-repository.ts`) with insert and aggregation queries. Instrument `OpenRouterClient` to record usage after each call (both DB write and Prometheus counter increment).
6. Cost API endpoint — `GET /api/v1/usage?period=30d` returning aggregated LLM usage for authenticated tenant: total tokens/cost, breakdown by model, by purpose, by job. Requires `jobs:read` scope.
7. Two-tier health checks:
   - `GET /health/live` — lightweight, confirms process is running (200 always)
   - `GET /health/ready` — parallel checks via `Promise.allSettled`: Postgres (`SELECT 1`), Redis (`PING`), BullMQ (`getJobCounts()`). Returns 200 with `status: "ok"` or 503 with `status: "degraded"` and per-check breakdown.
8. Bull Board queue dashboard — `@bull-board/api` + `@bull-board/hono`. Mount at `/api/admin/queues`. Requires `admin` scope (from 3-1a). Registers the 5 existing queues (crawl, schema-evolution, reconciliation, export, extract) with `BullMQAdapter`. The 6th queue (`webhooks`) is added in Wave 4 (Workstream G).

**New env vars:** `OTEL_EXPORTER_ENDPOINT`, `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE` (default: 0.1)

**Spec references:** Phase 12, sections 4.1–4.6

---

### 4.4 Sub-plan 3-3a: Performance — Storage & Exports

**Goal:** Object storage for content and streaming export pipeline.

**Deliverables:**

1. `S3ContentStore` (`packages/core/src/content-store/s3-content-store.ts`) — implements existing `ContentStore` interface using `@aws-sdk/client-s3`. All 5 interface methods: `store` (→ `text/{key}`), `storeBinary` (→ `binary/{key}`), `retrieve`, `retrieveBinary`, `delete`. Compatible with AWS S3, Cloudflare R2, MinIO.
2. `createContentStore()` factory — selects `PgContentStore` (default) or `S3ContentStore` based on `CONTENT_STORE` env var.
3. `getDownloadUrl()` optional method — added to `ContentStore` interface. `S3ContentStore` implements it using `@aws-sdk/s3-request-presigner`. `PgContentStore` does not (method is optional on interface).
4. `supportsPresignedUrls()` type guard — used by export download endpoint for 302 redirect vs. stream-through decision.
5. `StreamingJsonExporter` — accepts `AsyncIterable<Entity[]>`, produces `ReadableStream<Uint8Array>`. Writes opening bracket, comma-separated batches, closing bracket.
6. `StreamingCsvExporter` — same input interface. Writes header row from first batch schema, then data rows progressively.
7. `EntityRepository.findByJobCursor()` — keyset pagination: `WHERE id > cursor ORDER BY id LIMIT batch`. Plus `fetchEntitiesCursor()` async generator yielding `Entity[]` batches.
8. Export orchestrator adaptation — modify `processExport()` from Wave 1 to use `fetchEntitiesCursor()` instead of loading all entities. Branch on format: JSON/CSV use streaming pipeline, Parquet/SQLite/DuckDB use chunked-fetch-then-materialize (still reduces peak memory).
9. Export download endpoint update — if `supportsPresignedUrls(contentStore)`, return 302 redirect. Otherwise stream as before.

**Coexistence with existing exporters:** The streaming exporters are new classes alongside existing `JsonExporter`/`CsvExporter`. Format dispatch in the export orchestrator selects the appropriate implementation.

**New env vars:** `CONTENT_STORE` (default: `postgres`), `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`

**Spec references:** Phase 12, sections 6.1–6.2

---

### 4.5 Sub-plan 3-3b: Performance — Query & Caching

**Goal:** Query-layer performance — indexes, cursor pagination, caching, incremental fetch.

**Deliverables:**

1. Database indexes migration — `CREATE INDEX IF NOT EXISTS` for 5 new indexes:
   - `idx_entities_job_tenant` on `entities(job_id, tenant_id)`
   - `idx_extractions_job` on `extractions(job_id, tenant_id)`
   - `idx_extractions_page` on `extractions(page_id)`
   - `idx_exports_job` on `exports(job_id, tenant_id)`
   - `idx_content_store_key` on `content_store(key)`
   - Extend existing `entities_job_quality_idx` to `(job_id, quality_score DESC, id ASC)` for keyset query support
2. Cursor encoding/decoding utility (`packages/shared/src/cursor.ts`) — `encodeCursor()`/`decodeCursor()` helpers for base64-encoded `{id, sortValue}` objects. Shared across all paginated endpoints.
3. Cursor-based pagination — `?cursor=<opaque>` query parameter alongside existing offset/limit (backwards-compatible). Tiebreaker: `id` always included as secondary sort. Response envelope adds `nextCursor` and `hasMore` to existing `pagination` object.
4. Repository cursor methods — `findByCursor()` variants for `ExtractionRepository`, `ActionRepository`, `ExportRepository` (complementing `EntityRepository.findByJobCursor()` from 3-3a).
5. Apply cursor pagination to 4 endpoints: `/entities`, `/extractions`, `/actions`, `/exports`.
6. Incremental fetch — `?since=<ISO 8601>` parameter on the same 4 endpoints. Filters to records with `updated_at` after the given timestamp. **Migration required:** None of the 4 Postgres tables (`entities`, `extractions`, `actions`, `exports`) currently have `updated_at` columns. This deliverable includes: (a) migration adding `updated_at TIMESTAMPTZ DEFAULT now()` to all 4 tables, (b) index on `updated_at` for each table, (c) application-level writes to set `updated_at` on mutations (not DB triggers, to match the Drizzle ORM pattern), (d) the `?since=` query parameter.
7. `RedisCache` class (`packages/db/src/cache.ts`) — `getOrFetch<T>(key, fetcher, ttlSeconds)` and `invalidate(pattern)` (uses `SCAN` + `DEL`, not `KEYS`). Uses shared Redis client from 3-1b.
8. Wire cache to 4 hot paths:
   - `schema:{jobId}:current` — 30s TTL, invalidated on schema evolution
   - `job:{jobId}:config` — 60s TTL, invalidated on job update
   - `tenant:{tenantId}:quotas` — 300s TTL, invalidated on tenant update
   - `entity-count:{jobId}` — 10s TTL, invalidated on entity creation
9. Cache invalidation integration — `cache.invalidate()` calls at write points in relevant repositories/services.

**Spec references:** Phase 12, sections 6.3–6.5

---

### 4.6 Sub-plan 3-4: Deferred D/F Items

**Goal:** Four features deferred from Wave 2 that depend on Redis and auth infrastructure.

**Deliverables:**

1. Idempotency middleware (`apps/api/src/middleware/idempotency.ts`) — for `POST`/`PATCH` routes with `Idempotency-Key` header. Redis store: key `idempotency:{tenantId}:{key}`, value `{ statusCode, body, createdAt }`, 24hr TTL. Flow: check Redis → if hit, return cached response → if miss, proceed then cache. Opt-in (no overhead without header).
2. Worker health monitoring:
   - Heartbeat writer in `worker-entrypoint.ts` — `setInterval` every 30s. Key: `worker:heartbeat:{workerId}`, value: `{ workerId, queues, pid, uptime, activeJobs }`, TTL: 60s. Worker ID: `{hostname}-{pid}`. Cleanup on graceful shutdown.
   - `GET /api/v1/admin/workers` endpoint — scans `worker:heartbeat:*` keys, flags workers missing >60s as unhealthy. Requires `admin` scope.
3. Quality score aggregation API — `GET /api/v1/jobs/:id/quality` returning: entity count, average quality score, quality distribution (histogram buckets), field completeness (per-field fill rate). Computed via aggregation query on `entities` table (no new tables). Requires `jobs:read` scope.
4. Confidence-based export filtering — extend `POST /api/v1/exports` with optional `minQuality: number` and `fields: string[]` parameters. `minQuality` adds `WHERE quality_score >= :minQuality` to entity cursor query. `fields` filters output across all 5 export formats (JSON, CSV, Parquet, SQLite, DuckDB). Composes with streaming exports from 3-3a. Requires `exports:write` scope.

**Independence note:** All 4 items are independent of each other within this sub-plan (share Redis dependency but no inter-item dependencies). Good candidate for parallel task execution.

**Spec references:** Phase 12, sections 5.4–5.5, 7.5–7.6

---

### 4.7 Sub-plan 3-5: Local Pipeline Runner + Core CLI

**Goal:** Wire orchestrators (Wave 1), SQLite repos (Wave 2), and config system (Wave 2) into a working local crawl with CLI commands.

**Dependencies (all from Wave 1/2, not from Wave 3 server sub-plans):**
- Wave 1: `crawl-orchestrator`, `schema-orchestrator`, `reconcile-orchestrator`, `export-orchestrator`
- Wave 2: `ProjectAdapter` (SQLite repos), `parseProjectYaml`, `resolveConfig`, `diffConfigs`, `RobotsTxtChecker`, `InMemoryDomainRateLimiter`, `InMemoryPageBudget`, `CrawlCompletionChecker`, `CircuitBreakerLLMClient`, `estimateCost()`

#### Core Pipeline

1. **`LocalPipelineRunner`** (`packages/core/src/pipeline/local-pipeline-runner.ts`) — 13-step execution flow:
   1. Load & resolve config (`spatula.yaml` + global + CLI flags + env vars)
   2. Open SQLite DB (WAL mode)
   3. Acquire project lock (`.spatula/run.lock`, PID-based). `--force` flag to take over stale locks (PID no longer running).
   4. Crash recovery — reset `in_progress` tasks to `pending`, preserve `attempts` counter
   5. Config diff against last run snapshot — apply reactions:
      - New seed URLs → enqueue as new crawl tasks
      - Schema fields added → flag pages for re-extraction
      - Schema fields removed → drop from future extractions
      - Proxy/cookies changed → retry failed tasks
      - `robots.txt` toggled off → re-enqueue skipped tasks
      - Reconciliation strategy changed → force full reconciliation
      - Show summary with re-extraction cost estimate (via `estimateCost()`), prompt for confirmation
   6. Determine work (pending tasks + flagged pages + pending review actions reminder)
   7. Re-extraction pass — re-extract flagged pages using HTML from `.spatula/pages/`. Missing page files: re-crawl those pages instead.
   8. Crawl + extract loop — per-task: robots.txt check → domain rate limit → page budget → crawl → content dedup → save HTML → store page metadata → classify → extract → evaluate links → record LLM usage → commit task status. Per-task retry: up to 3 attempts with exponential backoff (2s, 4s, 8s), then mark `failed`. Circuit breaker for LLM errors.
   9. Schema evolution (batched) — auto-approved actions applied, manual-review actions queued for `spatula review`
   10. Reconciliation — full for <5000 entities, incremental for >=5000. Override via `--full-reconcile`/`--incremental`.
   11. Auto-export (if `export.autoExport: true`) → `.spatula/exports/{timestamp}-{format}/`
   12. Run summary — pages, entities, fields, errors, cost, pending actions. Notifications (desktop + webhook).
   13. Release lock, close DB
2. **Run record lifecycle** — create/update records in `runs` SQLite table (Wave 2). Status transitions: `started` → `paused`/`completed`/`failed`.
3. **In-memory priority queue** — tasks ordered by `priority_score` (link relevance), equal scores breadth-first by depth
4. **Concurrency semaphore** — configurable (default 5), limits parallel page processing via `Promise.allSettled` batches
5. **In-memory domain rate limiter** — `InMemoryDomainRateLimiter` (Wave 2 interface)
6. **In-memory page budget** — `InMemoryPageBudget` (Wave 2 interface)
7. **Project lockfile** (`.spatula/run.lock`) — PID-based, stale lock detection, `--force` takeover
8. **Checkpoint/resume** — Ctrl+C handler: 10s drain timeout, marks in-flight tasks as `pending`, saves run as `paused`, releases lock. Prints: `Paused at 347/2000 pages. Run 'spatula run' to continue.`

#### DataSource Abstraction

9. **`DataSource` interface** (`packages/core/src/interfaces/data-source.ts`) — unified interface: `getEntities`, `getEntity`, `searchEntities`, `getSchema`, `getSchemaVersions`, `getActions`, `approveAction`, `rejectAction`, `getStatus`, `createExport`, `getExport`, `downloadExport`, `getDocumentation`, optional `subscribe()`
10. **`LocalDataSource`** — wraps `ProjectAdapter` + `EventEmitter` from pipeline runner
11. **`ApiDataSource`** — deferred to Wave 5. Only the `DataSource` interface is delivered in 3-5; the remote implementation wrapping `ApiClient` + WebSocket is built when remote operations are implemented.
12. **CLI hook adaptation** — refactor `useJobPolling`, `useEntityData`, `useEntityFilter`, `useExport` to accept `DataSource` instead of `ApiClient`

#### CLI Commands

13. **`spatula init`** — setup wizard. First-time: global config (LLM provider, Ollama detection, crawler, politeness) + project. Returning user: project only. Writes `spatula.yaml` + creates `.spatula/` directory structure (`pages/`, `exports/`, `cache/robots/`, `logs/`). Note: `spatula setup` (global config editor) is deferred to Wave 4 (Step 5), matching the Phase 13 spec's step boundaries.
14. **`spatula run`** — invokes `LocalPipelineRunner`. Compact progress display: progress bar, page/entity/field counts, current URL, speed, cost, errors. Keybindings: `[d]` dashboard, `[q]` quit, `[space]` pause/resume.
15. **`spatula status`** — project status: last run, pages/entities, pending actions, schema fields, storage breakdown (pages/DB/exports sizes per Section 10.4).
16. **`spatula reset`** — clears `.spatula/` state, preserves `spatula.yaml`. Flags: `--keep-exports`, `--keep-entities` for selective reset.
17. **`spatula new`** — conversational mode (existing Phase 9a LLM dialogue) adapted to write `spatula.yaml` instead of creating API job. Falls back to `spatula init` if no LLM configured.
18. **Dashboard mode** — press `[d]` during `spatula run` to expand to full multi-panel TUI (existing Dashboard components fed by `LocalDataSource`). `[q]`/`Esc` returns to compact view.

#### Supporting Infrastructure

19. **`PipelineEvents` emitter** — events: `task:completed`, `entity:created`, `schema:evolved`, `action:pending`, `progress`. Bridges pipeline runner to `LocalDataSource.subscribe()`.
20. **Structured JSON logging** — Pino-based, writes to `.spatula/logs/{timestamp}.log`. Same format as server mode.
21. **Desktop notifications** — `node-notifier` for run completion/failure (when `notify.desktop: true`). Silent skip for CI (`process.env.CI`), Docker, headless environments.
22. **Webhook notifications** — simple HTTP POST to `notify.webhook` URL on completion/failure events (no queue, no retry, no HMAC — distinct from server webhook infrastructure in Wave 4).
23. **Local content store** — file-based, writes raw HTML to `.spatula/pages/{id}.html`. Implements `ContentStore` interface for local mode.

**Spec references:** Phase 13, sections 3, 4, 10

---

## 5. Cross-Cutting Concerns

### 5.1 Middleware Chain Ordering

Multiple sub-plans add middleware. The target chain after all Wave 3 work:

```
requestContext → timing (3-2) → logger → securityHeaders (3-1a) → cors (3-1a) →
errorHandler → authMiddleware (3-1a) → rateLimiter (3-1b) → idempotency (3-4) →
depsMiddleware → validateTenant → routes
```

Each sub-plan slots its middleware into this chain. Earlier sub-plans should leave comment markers or ordered middleware registration to guide later additions.

### 5.2 Existing API Test Impact

Adding auth middleware (3-1a) affects all 175 existing API tests. Strategy: test environment sets `AUTH_STRATEGY=none` (overriding the production default of `api-key`), preserving current behavior. New auth-specific tests exercise auth paths explicitly. No existing test needs auth header changes.

### 5.3 AppDeps Growth

Wave 3 adds significant services to `AppDeps` (in `apps/api/src/types.ts`):

| Sub-plan | New AppDeps fields |
|----------|-------------------|
| 3-1a | `authProvider: AuthProvider` |
| 3-1b | `redis: Redis`, `auditLogger: AuditLogger` |
| 3-2 | `meter: Meter`, `tracer: Tracer`, `llmUsageRepo: LlmUsageRepository` |
| 3-3a | `contentStore: ContentStore` (replaces direct `PgContentStore`) |
| 3-3b | `cache: RedisCache` |

Each sub-plan updates the `AppDeps` type and its construction in `apps/api/src/index.ts`.

### 5.4 Environment Variables

Wave 3 introduces ~15 new env vars. Each sub-plan documents its own variables (listed in sections above). A consolidated `.env.example` update should happen at Wave 3 completion.

### 5.5 OpenAPI/Swagger Updates

New endpoints from 3-1a (api-keys), 3-1b (ws-token), 3-2 (usage, health), 3-4 (admin/workers, quality, export filtering params) all require OpenAPI spec updates. Each sub-plan updates the OpenAPI docs for its endpoints.
