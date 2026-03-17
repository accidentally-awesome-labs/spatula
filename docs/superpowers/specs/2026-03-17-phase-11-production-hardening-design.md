# Phase 11: Production Hardening — Design Spec

> Close implementation gaps that block a real end-to-end job run, then layer in the action execution/review system and remaining design-spec features.

## Overview

Phases 1–10 built Spatula's full feature surface: types, crawlers, extraction, schema evolution, reconciliation, orchestration, API, CLI, and export pipeline. All testing has been unit-test-only with mocked dependencies. Phase 11 closes the gaps that prevent running a real crawl job against live Postgres + Redis, then addresses remaining design-spec divergences in priority order.

Phase 11 is split into five independent sub-phases. Only 11a is a prerequisite for the others — 11b through 11e can be done in any order after 11a.

| Phase | Name | Focus | Prerequisite |
|-------|------|-------|-------------|
| **11a** | Minimal Viable E2E | DB migrations, FK fix, action persistence, distributed lock, queue config, E2E test | — |
| **11b** | Action Execution & Review | ActionExecutor, Review Queue, safety policies | 11a |
| **11c** | Real-Time & Crawl Intelligence | WebSocket, link evaluator | 11a |
| **11d** | API Hardening & DX | REST semantics, OpenAPI, tenant repo | 11a |
| **11e** | Operational Robustness | Error hierarchy, config validation, logger context, additional exporters | 11a |

---

## Phase 11a: Minimal Viable E2E

**Goal:** Run a complete job end-to-end against real Postgres + Redis — create job, crawl, extract, evolve schema, reconcile, export.

### 11a.1 Fix `schemas.jobId` Foreign Key

**File:** `packages/db/src/schema/schemas.ts` line 10

The `jobId` column is defined without a foreign key reference to the jobs table. This must be fixed before migration generation so the FK constraint is baked into the initial SQL.

Current:
```typescript
jobId: uuid('job_id').notNull(),
```

Change to:
```typescript
jobId: uuid('job_id').notNull().references(() => jobs.id),
```

**Circular FK note:** This creates a circular reference — `jobs.schemaId` references `schemas.id`, and `schemas.jobId` will reference `jobs.id`. This is safe for INSERT because `jobs.schemaId` is nullable (set after job creation). For DELETE (Phase 11d), the cascading delete must SET NULL on `jobs.schemaId` first, then delete schemas. The FK from `schemas.jobId` to `jobs.id` should use `ON DELETE CASCADE`; the FK from `jobs.schemaId` to `schemas.id` already allows NULL and the delete transaction sets it to NULL before cascading.

### 11a.2 Database Infrastructure

**New file: `docker-compose.yml`** at project root.

- Postgres 16 on port 5432 (db: `spatula`, user: `spatula`, pass: `spatula` — matches `.env.example`)
- Redis 7 on port 6379
- Named volumes for data persistence across restarts

**New file: `.env`** copied from `.env.example` with local defaults filled in.

**Migration generation:**

- Run `drizzle-kit generate` to produce SQL migrations in `packages/db/drizzle/`
- Add scripts to `packages/db/package.json`:
  - `db:generate` — runs `drizzle-kit generate` for future schema changes
  - `db:migrate` — runs `runMigrations()` against `DATABASE_URL`

### 11a.3 `ActionRepository.create()`

**File:** `packages/db/src/repositories/action-repository.ts`

The ActionRepository has `findByJob`, `findById`, `updateStatus`, and `batchUpdateStatus` — but no method to insert new actions. Schema-worker generates actions from `schemaEvolver.evolve()` and stamps them with `jobId` (schema-worker.ts lines 80–83) but never persists them.

Add a `create()` method:

```typescript
async create(input: {
  jobId: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  source: string;
  status: string;
  confidence: number;
  reasoning: string;
  stateChanges?: Record<string, unknown>;
}): Promise<{ id: string }>
```

**WorkerDeps change:** Add `actionRepo: ActionRepository` to `packages/queue/src/worker-deps.ts` — it is currently missing.

**Worker integration:** After this change, schema-worker iterates over the actions returned by `schemaEvolver.evolve()`, calls `actionRepo.create()` for each one individually (with status `applied`), then batch-applies them via `applySchemaActions()` to produce the new schema version. This preserves the current batch-apply behavior while adding the audit trail. Reconciliation-worker does the same for source trust actions.

### 11a.4 Distributed Lock for Schema Evolution

**File:** `packages/queue/src/workers/schema-worker.ts`

The schema-worker's BullMQ dedup key (`schema-evolution:{jobId}:v{version}`) provides some protection, but does not prevent two workers from entering the evolution logic if they read the same schema version before either persists a new one.

**Approach:** Redis `SET NX` lock around the evolution critical section.

```
Lock key:    schema-lock:{jobId}
TTL:         30 seconds
Acquire:     Before the schemaRepo.findLatest() call
Release:     After schemaRepo.create() persists the new version, in a finally block
On failure:  Skip silently — another worker has the lock and will handle this batch
```

**New file:** `packages/queue/src/redis-lock.ts`

A small utility with `acquire(redis, key, ttl): Promise<{ acquired: boolean; token: string }>` and `release(redis, key, token): Promise<void>`. The `acquire()` call stores a random token as the lock value via `SET key token NX EX ttl`. The `release()` call uses a Lua CAS script that only deletes the key if the stored value matches the token — this prevents a worker from accidentally releasing another worker's lock if the TTL expires during a slow evolution. Workers get the Redis connection from BullMQ's existing `ConnectionOptions`.

### 11a.5 Queue Concurrency & Rate Limiting

**File:** `packages/queue/src/queues.ts`

Currently all queues are created with only `{ connection }` — no concurrency limits, rate limits, or retry configuration.

**New interface:**

```typescript
interface QueueConfig {
  crawl:           { concurrency: number; rateLimitMax: number; rateLimitDuration: number };
  extract:         { concurrency: number };
  schemaEvolution: { concurrency: number };
  reconciliation:  { concurrency: number };
  export:          { concurrency: number };
}
```

**Defaults** (used when no overrides provided):

| Queue | Concurrency | Rate Limit |
|-------|-------------|------------|
| crawl | 5 | 10 req/sec |
| extract | 3 | — |
| schemaEvolution | 1 (singleton by design) | — |
| reconciliation | 1 | — |
| export | 2 | — |

BullMQ `concurrency` is set on the **Worker**, not the Queue. Queue-level changes are `defaultJobOptions` (attempts: 3, exponential backoff). The config needs to flow to wherever workers are instantiated.

**Change to `createQueues`:** Accept optional `QueueConfig`, apply `defaultJobOptions` with retry settings. Return the config alongside queues so worker constructors can read concurrency values.

### 11a.6 E2E Integration Test

**New file:** `tests/e2e/full-pipeline.test.ts` (workspace root)

Prerequisites: Running Postgres + Redis (via docker-compose).

**Test flow:**

1. Run migrations against test database
2. Create tenant
3. Create job with 1–2 seed URLs (local HTML fixture files served by a tiny HTTP server)
4. Start job → verify crawl tasks enqueued
5. Process crawl queue manually (call `processCrawlJob` directly with real deps)
6. Verify pages stored, extractions created
7. Process schema evolution manually
8. Verify schema versioned
9. Trigger reconciliation → process reconciliation job
10. Verify entities created with provenance
11. Trigger export → process export job
12. Verify export content downloadable
13. Teardown: drop test data

**Key decisions:**

- Use real Postgres + Redis but mock the LLM client (OpenRouter) with fixture responses. Tests the full pipeline wiring without API costs or network flakiness.
- Use a dedicated test database (`spatula_test`) created and dropped per test run for isolation. The docker-compose Postgres should create both `spatula` and `spatula_test` databases on init.

---

## Phase 11b: Action Execution & Review

**Goal:** Implement the `ActionExecutor` and Review Queue so the safety policy system works — safe actions auto-apply, risky actions queue for user review.

**Prerequisite:** Phase 11a (needs `ActionRepository.create()` for persistence).

### 11b.1 ActionExecutor Implementation

**New file:** `packages/core/src/execution/action-executor-impl.ts`

The `ActionExecutor` interface (already defined in `interfaces/action-executor.ts`) has three methods: `execute()`, `rollback()`, `preview()`.

**Safety policy map** (static mapping from action type to default policy):

| Policy | Action Types |
|--------|-------------|
| `always_auto` | classify_page, enqueue_links, hint_entity_match, update_enum_map, flag_anomaly, generate_documentation |
| `auto_above_threshold` | add_field, modify_field, set_normalization_rule, define_category, assign_category_fields, match_entities, set_source_trust, reprocess_extraction |
| `batch_review` | merge_fields, rename_field, split_field, group_fields, resolve_conflict, infer_value, correct_value, split_entities |
| `always_review` | remove_field, recommend_table_structure, derive_field |

**User-configurable approval presets:**

| Preset | Behavior |
|--------|----------|
| `trust_ai` | Everything auto-applies |
| `balanced` (default) | Use the policy map above |
| `cautious` | `auto_above_threshold` becomes `batch_review` |
| `manual` | Everything requires review |

For `auto_above_threshold`, the executor checks the action's `confidence` against a configurable threshold (default 0.7). Above → auto-apply. Below → defer to review queue.

**Domain dispatch:**

The executor delegates to domain-specific appliers:

| Action Category | Delegated To | Status |
|----------------|--------------|--------|
| Schema (7 types) | `applySchemaActions()` | Partially exists — `evolution/schema-action-applier.ts` handles 5 of 7 |
| Normalization (2) | `applySchemaActions()` | Exists — handled in same reducer |
| Category (2) | `applyCategoryActions()` | New |
| Crawl (3) | No-op — produced inline by workers | N/A |
| Reconciliation (6) | `applyReconciliationActions()` | New |
| Reprocessing (1) | Enqueue reprocessing jobs | New |
| Finalization (4) | `applyFinalizationActions()` | New |

**Schema-action-applier gap:** The existing `applySchemaActions()` handles `add_field`, `remove_field`, `modify_field`, `rename_field`, `merge_fields`, `set_normalization_rule`, and `update_enum_map`. It does **not** handle `split_field` or `group_fields` — these fall through to the default case and are silently skipped. As part of 11b, add `split_field` and `group_fields` cases to the applier:

- `split_field`: Remove the source field, insert the target fields at the same position, using `splitLogic` and `examples` as documentation (the actual data re-extraction happens via `reprocess_extraction`).
- `group_fields`: Remove the source fields, create a new object-typed field with the specified mapping, update `objectFields` on the new field definition.

**New domain applier files:**

- `packages/core/src/execution/category-applier.ts` — Updates schema with category metadata. `define_category` adds to a categories list, `assign_category_fields` maps fields to categories.

- `packages/core/src/execution/reconciliation-applier.ts` — Mutates entity data. `resolve_conflict` updates a field value + provenance. `infer_value` adds a field with provenance type `inferred`. `correct_value` overwrites + records correction. `match_entities` and `split_entities` modify entity-extraction linkage.

- `packages/core/src/execution/finalization-applier.ts` — `recommend_table_structure` and `derive_field` store metadata on the schema/job. `flag_anomaly` writes an anomaly record. `generate_documentation` triggers the existing `DocumentationGenerator`.

**Constructor dependencies:**

```typescript
class DefaultActionExecutor implements ActionExecutor {
  constructor(
    private actionRepo: ActionRepository,
    private schemaRepo: SchemaRepository,
    private entityRepo: EntityRepository,
    private reviewQueue: ReviewQueue,
    private approvalPreset: ApprovalPreset = 'balanced',
    private confidenceThreshold: number = 0.7,
  )
}
```

**`execute()` flow:**

1. Resolve policy: `safetyPolicyMap[action.type]` adjusted by `approvalPreset`
2. If `always_auto` or confidence above threshold → apply immediately
3. If `batch_review` or `always_review` → push to review queue, return `{ status: 'deferred' }`
4. On apply: call domain applier, collect state changes, persist action with status `applied`
5. On defer: persist action with status `pending_review`
6. Return `ActionResult`

**`preview()` flow:**

Run the domain applier in dry-run mode (clone state, apply, diff). Return `ActionPreview` with `wouldChange`, `riskLevel`, `requiresApproval`.

**`rollback()` flow:**

Look up action by ID, verify it was `applied`. Apply inverse state change (reverse the `stateChanges` array). Update action status to `rolled_back`. Only supported for schema actions initially (the applier is a pure reducer, so inverse is straightforward). Reconciliation rollbacks throw `Error('not supported')` for v1.

### 11b.2 Review Queue

**New file:** `packages/core/src/execution/review-queue.ts`

A logical queue (not a BullMQ queue) that bridges the executor with the CLI Review Mode and API action endpoints.

**Interface:**

```typescript
interface ReviewQueue {
  enqueue(action: PipelineAction, preview: ActionPreview): Promise<void>;
  getPending(jobId: string, options?: { type?: string; limit?: number }): Promise<PendingAction[]>;
  approve(actionId: string, reviewedBy: string): Promise<ActionResult>;
  reject(actionId: string, reviewedBy: string, reason: string): Promise<void>;
  approveAll(jobId: string, reviewedBy: string): Promise<ActionResult[]>;
}
```

**Implementation:** `DefaultReviewQueue`

Backed by `ActionRepository`:

- `enqueue()` → `actionRepo.create()` with status `pending_review`, stores `ActionPreview` in payload
- `getPending()` → `actionRepo.findByJob()` filtered by status `pending_review`
- `approve()` → `actionRepo.updateStatus()` to `approved`, then calls the domain applier directly (not through `ActionExecutor.execute()`, which would create a circular dependency). The ReviewQueue holds references to the same domain appliers the executor uses, but does not hold a reference to the executor itself. After applying, updates status to `applied`.
- `reject()` → `actionRepo.updateStatus()` to `rejected` with reason
- `approveAll()` → iterates pending actions, applying each individually (approve + apply + update status). If one fails mid-batch, already-applied actions remain `applied` and the failed action stays `approved` — callers can retry. This is intentionally not atomic: partial progress is better than all-or-nothing for a batch of independent actions.

**Integration points:**

The existing API action routes (`POST /actions/:aid/approve`, `/reject`, `/approve-all`) already have the right shape — they call through the ReviewQueue instead of directly updating status. The CLI Review Mode already fetches pending actions and calls these API endpoints.

### 11b.3 Worker Integration

After 11b, workers can optionally route actions through the `ActionExecutor`:

- **Schema-worker:** Currently calls `applySchemaActions()` directly. After 11b, passes actions to `ActionExecutor.execute()` which checks policies first. `always_auto` or high-confidence actions still auto-apply. Lower-confidence ones (e.g., `merge_fields`) get deferred.

- **Reconciliation-worker:** Currently calls `reconciler.reconcile()` which returns entities directly. The reconciliation actions are implicit inside the reconciler. Full integration would require the reconciler to emit actions explicitly rather than applying internally — this is a larger refactor noted as a future improvement. For 11b, the executor handles reconciliation actions that come through the API (manual corrections), not the automated pipeline.

---

## Phase 11c: Real-Time & Crawl Intelligence

**Goal:** Push-based real-time updates for the CLI dashboard, and intelligent link prioritization during crawling.

**Prerequisite:** Phase 11a.

### 11c.1 WebSocket Support

**New files:**

- `apps/api/src/ws/upgrade.ts` — WebSocket upgrade handler for Hono
- `apps/api/src/ws/job-progress.ts` — Job-scoped connection manager
- `apps/api/src/ws/types.ts` — Message type definitions

**Endpoint:** `GET /ws/jobs/:id/progress` → WebSocket upgrade

**Message types (server → client):**

```typescript
type WSMessage =
  | { type: 'crawl_progress'; data: { pagesFound: number; pagesCrawled: number; pagesExtracted: number } }
  | { type: 'task_completed'; data: { taskId: string; url: string; classification: string } }
  | { type: 'schema_evolved'; data: { version: number; fieldsAdded: string[]; fieldsMerged: string[] } }
  | { type: 'action_pending'; data: { actionId: string; type: string; confidence: number } }
  | { type: 'job_status_changed'; data: { from: string; to: string } }
  | { type: 'entity_created'; data: { entityId: string; name: string } }
  | { type: 'error'; data: { message: string } }
```

**Architecture: Redis Pub/Sub.**

Workers must not know about WebSocket connections. Two options were considered:

- **Option A: Redis Pub/Sub.** Workers publish to `spatula:events:{jobId}`. API subscribes per WebSocket client.
- **Option B: BullMQ progress events.** Limited to single progress value per job — too restrictive for typed messages.

**Decision: Option A.** Redis Pub/Sub gives typed JSON messages with no BullMQ coupling, using infrastructure already in place.

**Implementation:**

- `packages/queue/src/events.ts` — `publishJobEvent(redis, jobId, event)` helper used by workers at key pipeline points (after crawl, after extraction, after schema evolution, on status change)
- `apps/api/src/ws/job-progress.ts` — On WebSocket connect, validate tenant owns jobId, subscribe to Redis channel, forward events as JSON messages. On disconnect, unsubscribe and clean up.
- Hono WebSocket via `@hono/node-ws` adapter (the Node.js-specific package — the built-in `hono/ws` targets Deno/Bun/Cloudflare Workers)
- Heartbeat ping every 30s to detect stale connections

**CLI integration:**

- New hook: `apps/cli/src/hooks/useWebSocket.ts`
- Dashboard mode switches from `useJobPolling` (3s HTTP) to `useWebSocket` when available, with polling as fallback if WebSocket connection fails
- No changes to store shape — WebSocket hook dispatches the same store actions that polling does

### 11c.2 Link Evaluator

**New file:** `packages/core/src/link-evaluation/evaluator.ts`

**Interface:**

```typescript
interface LinkEvaluator {
  evaluate(
    links: ExtractedLink[],
    jobContext: { description: string; seedDomains: string[]; currentDepth: number; maxDepth: number },
    schema: SchemaDefinition,
  ): Promise<EvaluatedLink[]>;
}
```

`EvaluatedLink` extends the raw link with:

```typescript
{
  relevanceScore: number;       // 0-1
  expectedContent: 'single_entry' | 'listing' | 'pagination' | 'category' | 'unknown';
  priority: 'high' | 'medium' | 'low';
  reasoning: string;
}
```

**Implementation:** `LLMLinkEvaluator`

- Uses the **fast model tier** (Haiku/Flash) per the LLM Intelligence Map
- Batches links (up to 20 per LLM call) to reduce API costs
- Prompt includes: job description, seed domains, current schema fields, link URLs + anchor text
- Returns scored links; crawl worker filters by `relevanceScore > 0.3` and enqueues with LLM-assigned priority

**Crawl worker integration:**

Currently the crawl-worker's link-handling section extracts links and enqueues all of them with no priority scoring (default BullMQ ordering). After this change:

1. `LinkExtractor` extracts raw links (existing)
2. `LinkEvaluator` scores them (new)
3. Only links above threshold enqueued, with LLM-assigned priority
4. Produces `EnqueueLinksAction` objects matching the existing action type's payload shape

**WorkerDeps change:** Add `linkEvaluator: LinkEvaluator` to `packages/queue/src/worker-deps.ts`.

---

## Phase 11d: API Hardening & Developer Experience

**Goal:** Align API with REST conventions, add OpenAPI docs, enable programmatic tenant management.

**Prerequisite:** Phase 11a.

### 11d.1 REST Semantics Cleanup

**File:** `apps/api/src/routes/jobs.ts`

**PATCH endpoint for job control:**

Currently separate POST routes exist for `/pause`, `/resume`, `/cancel`, `/start`, `/reconcile`. Add a single idiomatic endpoint:

```
PATCH /api/v1/jobs/:id
Body: { "action": "start" | "pause" | "resume" | "cancel" | "reconcile" }
```

Existing POST routes remain as aliases for backwards compatibility.

**DELETE endpoint:**

```
DELETE /api/v1/jobs/:id
```

Cascading delete in a single transaction. Due to the circular FK between `jobs.schemaId → schemas.id` and `schemas.jobId → jobs.id` (see 11a.1), the delete must first SET NULL on `jobs.schemaId`, then delete in FK dependency order: entity_sources → entities → extractions → raw_pages → crawl_tasks → actions → schemas → exports → content store entries → job. Implemented in a new `JobRepository.deleteWithData(jobId, tenantId)` method.

### 11d.2 Pagination Consistency

**File:** `apps/api/src/schemas/job.ts` — Add `offset` to `listJobsQuerySchema`:

```typescript
offset: z.coerce.number().int().min(0).default(0)
```

**File:** `apps/api/src/routes/extractions.ts` — Refactor inline extraction query to use the shared `paginationSchema` from `schemas/pagination.ts` (which already has `limit` and `offset`), extended with `schemaVersion`.

### 11d.3 OpenAPI Documentation

**Approach:** `@hono/zod-openapi` — generates specs directly from existing Zod validation schemas.

**Changes:**

- Refactor route definitions to use `createRoute()` from `@hono/zod-openapi`. Each route gets request/response schemas attached. Handler logic stays the same.
- New file: `apps/api/src/openapi.ts` — generates OpenAPI 3.1 spec from all registered routes
- New endpoint: `GET /api/docs` — Swagger UI via `@hono/swagger-ui`
- New endpoint: `GET /api/openapi.json` — raw spec for client generation

### 11d.4 Tenant Repository

**New file:** `packages/db/src/repositories/tenant-repository.ts`

```typescript
class TenantRepository {
  create(input: { name: string; config?: Record<string, unknown> }): Promise<{ id: string }>;
  findById(id: string): Promise<Tenant | null>;
  update(id: string, changes: { name?: string; config?: Record<string, unknown> }): Promise<Tenant>;
}
```

**New API endpoints:**

```
POST   /api/v1/tenants          — Create tenant
GET    /api/v1/tenants/:id      — Get tenant
PATCH  /api/v1/tenants/:id      — Update tenant config
```

Currently the tenant header (`x-tenant-id`) is trusted blindly. The tenant repo enables validation that the tenant actually exists, which the tenant middleware can check.

---

## Phase 11e: Operational Robustness

**Goal:** Production-grade error handling, configuration, logging, and export format coverage.

**Prerequisite:** Phase 11a.

### 11e.1 Error Hierarchy Refactoring

**File:** `packages/shared/src/errors.ts`

Add missing error types extending `SpatulaError`:

| New Type | Purpose |
|----------|---------|
| `QueueError` | Queue processing failures (workers, job lifecycle) |
| `TimeoutError` | Crawl timeouts, LLM timeouts |
| `RateLimitError` | LLM rate limiting, crawl rate limiting |
| `NetworkError` | Connection failures to external services |
| `StateError` | Invalid state transitions |

**Migration:** Move `InvalidTransitionError` from `packages/queue/src/state-machine.ts` into shared as `StateError extends SpatulaError`. The current `InvalidTransitionError` stores `from` and `to` properties — the new `StateError` preserves these via the `context` field that `SpatulaError` already supports: `new StateError('Invalid transition', 'STATE_INVALID_TRANSITION', { context: { from, to } })`. Update state-machine.ts to import from `@spatula/shared`.

**Worker error cleanup:** Replace generic `throw new Error(...)` calls in queue workers:

- `export-worker.ts` lines 20, 24, 33, 43 → `QueueError`
- `crawl-worker.ts` does not currently use `CrawlError` — add typed error handling (the `CrawlError` class exists in `@spatula/shared` but is not imported by the worker)
- Verify `schema-worker.ts` uses `LLMError` (already exists)

**API error handler update** (`apps/api/src/middleware/error-handler.ts`):

| Error Type | HTTP Status |
|-----------|-------------|
| `QueueError` | 503 Service Unavailable |
| `TimeoutError` | 504 Gateway Timeout |
| `RateLimitError` | 429 Too Many Requests |
| `NetworkError` | 502 Bad Gateway |
| `StateError` | 409 Conflict |

### 11e.2 Centralized Config Validation

**File:** `packages/shared/src/config.ts`

Add a structured config system alongside the existing `getEnvOrThrow`/`getEnvOrDefault` helpers:

```typescript
const AppConfigSchema = z.object({
  openrouter: z.object({ apiKey: z.string().min(1) }),
  database: z.object({ url: z.string().url() }),
  redis: z.object({ url: z.string().min(1) }),
  firecrawl: z.object({ apiKey: z.string().optional() }),
  logging: z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export function loadConfig(): AppConfig;
export function loadConfigSafe(): { config: AppConfig } | { errors: string[] };
```

`loadConfig()` loads from environment, validates, and throws on missing required values with a clear message listing all issues. `loadConfigSafe()` is the non-throwing variant.

API server and worker bootstrap call `loadConfig()` at startup for fail-fast behavior.

### 11e.3 Logger Context Propagation

**File:** `packages/shared/src/logger.ts`

Add context-aware logger factory:

```typescript
export function createLoggerWithContext(
  name: string,
  context: { tenantId?: string; jobId?: string; requestId?: string },
): pino.Logger;
```

Creates a Pino child logger with context fields included in every log line.

**Integration:**

- **API middleware:** Generate `requestId` (UUID) at request entry, create context logger, pass via Hono context. Move request ID generation upstream from error handler.
- **Workers:** Each invocation creates context logger with `{ jobId, tenantId }` from job data. Replace module-level `createLogger('crawl-worker')` with per-invocation `createLoggerWithContext('crawl-worker', { jobId, tenantId })`.

**LOG_LEVEL validation:** Validate against Pino's valid levels on logger creation; throw `ConfigError` for invalid values.

### 11e.4 Additional Exporters

**New files:**

- `packages/core/src/exporters/parquet-exporter.ts`
- `packages/core/src/exporters/duckdb-exporter.ts`
- `packages/core/src/exporters/sqlite-exporter.ts`

All implement the existing `Exporter` interface.

| Exporter | Dependency | Output | Use Case |
|----------|-----------|--------|----------|
| Parquet | `parquet-wasm` or `hyparquet` | Binary `.parquet` | Analytics (DuckDB, Pandas, Spark) |
| DuckDB | `duckdb` (Node.js bindings) | Binary `.duckdb` | Immediate SQL querying |
| SQLite | `better-sqlite3` | Binary `.sqlite` | Most portable format |

**Shared utility:** `packages/core/src/exporters/column-mapper.ts` — maps `SchemaDefinition` field types to native column types for each target format.

**ExportWorker:** Add format → exporter factory mapping, similar to `CrawlerFactory`. Also update `ExportJobPayload` in `packages/queue/src/queues.ts` — the `format` field is currently typed as `'json' | 'csv'` and must be widened to `'json' | 'csv' | 'parquet' | 'duckdb' | 'sqlite'` (or import the `ExportFormat` type from `@spatula/core/interfaces/exporter` which already includes all 5 formats).

**Content store binary support:**

Parquet, DuckDB, and SQLite produce binary output. The current `PgContentStore` stores text only.

**Decision:** Add `storeBinary(key: string, data: Uint8Array)` and `retrieveBinary(key: string): Promise<Uint8Array | null>` to the `ContentStore` interface. Use `Uint8Array` instead of Node.js `Buffer` for runtime portability (Bun compatibility per design doc). Implementation in `PgContentStore`: add a `binary_content bytea` column to the existing `content_store` table (nullable). The existing `content text` column must also be made nullable in the same migration — currently it is `NOT NULL`, which would prevent inserting binary-only rows. After this migration, each row has either `content` (text exports) or `binary_content` (binary exports) populated, never both. The `storeBinary` method writes to `binary_content`; `retrieveBinary` reads from it. Existing text methods remain unchanged.

---

## Out of Scope

The following items are not addressed in any Phase 11 sub-phase:

- Separate extract worker (extraction remains bundled in crawl worker)
- Automatic crawl-completion detection (reconciliation trigger remains manual/external)
- Per-tenant resource quotas beyond queue concurrency
- Frontend web application
- Temporal/Inngest migration
- S3/R2 content store implementation
