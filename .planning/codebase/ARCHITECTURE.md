# Architecture

**Analysis Date:** 2026-05-06

## Pattern Overview

**Overall:** Layered, interface-driven pipeline architecture with pure business logic decoupled from HTTP/queue concerns.

**Key Characteristics:**

- Pure core library (`@spatula/core`) with zero HTTP/CLI/queue dependencies — all orchestrators are pure async functions
- Dual orchestration modes: BullMQ/Redis (server/API) and in-process (CLI local mode)
- Action-based execution model: 52 action types (25 pipeline + 30 config) drive schema evolution, reconciliation, and data manipulation
- Tenant-aware from day one; stateless workers allow horizontal scaling
- Pluggable interfaces for crawlers, extracters, content stores, and LLM clients
- Three-layer consolidation pipeline: synonym detection → normalization → entity reconciliation
- Provenance-tracked output: every field carries metadata about extraction source, normalization, merging, and inference

## Layers

**@spatula/core (Pure Business Logic):**

- Purpose: Stateless, framework-agnostic crawl/extract/evolve/reconcile/export pipeline logic
- Location: `packages/core/src/`
- Contains: Orchestrators, action executors, reconcilers, type definitions, extractors, LLM routing, consolidation logic
- Depends on: Zod for validation, interfaces for crawlers/extractors/stores
- Used by: `@spatula/queue` (via workers), `@spatula/api` (indirectly via routes), `@spatula/cli` (via LocalPipelineRunner)

**@spatula/queue (Job Orchestration & Workers):**

- Purpose: BullMQ-based job queue management, worker implementations, retry logic, rate limiting, quota enforcement
- Location: `packages/queue/src/`
- Contains: Queue definitions, worker entry points (crawl/extract/schema/reconciliation/export workers), job state machine, webhook sender, DLQ handler
- Depends on: BullMQ, Redis, @spatula/core orchestrators, @spatula/db repositories
- Used by: `@spatula/api` server to enqueue jobs, worker containers to process jobs

**@spatula/db (Data Persistence):**

- Purpose: PostgreSQL and SQLite repositories, schema definitions, content storage abstractions
- Location: `packages/db/src/`
- Contains: Drizzle ORM repositories (JobRepository, ExtractionRepository, EntityRepository, etc.), PostgreSQL schemas, SQLite project DB (for local mode), content store implementations (S3, local, PgContentStore)
- Depends on: Drizzle ORM, PostgreSQL driver, SQLite driver, @spatula/shared types
- Used by: @spatula/queue workers (fetch/store data), @spatula/api routes (read/write), @spatula/cli local mode (SQLite)

**@spatula/shared (Cross-Cutting):**

- Purpose: Logging, error types, authentication, rate-limiting tiers, billing, observability, webhook types
- Location: `packages/shared/src/`
- Contains: Logger with context, error classes (CrawlError, NetworkError, StateError), auth quota system, audit logging, Sentry/tracing, metrics
- Used by: All other packages

**@spatula/api (HTTP Server):**

- Purpose: REST API with Hono, multi-tenant support, auth providers, middleware chains
- Location: `apps/api/src/`
- Contains: Route handlers (jobs, schemas, extractions, entities, actions, exports, admin routes), middleware (auth, validation, rate-limit, error handling, request context), OpenAPI documentation
- Depends on: @spatula/core, @spatula/queue, @spatula/db, Hono, Zod
- Entry point: `apps/api/src/index.ts` → `createApp()` and `startServer()`

**@spatula/cli (Command-Line Interface):**

- Purpose: Conversational CLI with Ink TUI, local project management, multi-mode interaction (conversational, dashboard, review, explorer)
- Location: `apps/cli/src/`
- Contains: Commands (init, push, status, export, schema, add), local project adapter, WebSocket communication, Ink components (dashboard, review, explorer)
- Depends on: @spatula/core (LocalPipelineRunner), @spatula/db (SQLite project DB), Ink (React TUI), API client for remote mode
- Modes: Conversational (initial setup), Dashboard (progress monitoring), Review (approve/reject actions), Explorer (results navigation)

## Data Flow

**Crawl Phase (Stateless Task Processing):**

1. API or CLI enqueues CrawlJob to BullMQ queue or in-process PriorityQueue
2. Worker/orchestrator calls `processCrawlTask()` from @spatula/core
3. Steps within task:
   - Fetch URL via pluggable Crawler (Playwright or Firecrawl)
   - Hash content (SHA-256) for deduplication
   - Store HTML in ContentStore (S3, local filesystem, or database)
   - Classify page via PageClassifier (using LLM with category awareness)
   - Extract structured data via Extractor (LLM-powered with fallback to heuristics)
   - Evaluate links via LinkEvaluator (relevance scoring, priority assignment)
   - Check if schema evolution should trigger based on extraction count
4. Task result enqueues child crawl tasks (for discovered links) and extract tasks (for classified pages)

**Schema Evolution Phase:**

1. After N extractions reach threshold, SchemaEvolutionJob is enqueued
2. Worker calls `processSchemaEvolution()` from @spatula/core
3. LLM analyzes extracted samples, recommends schema mutations (add/remove/merge/split fields)
4. Actions are persisted to database with confidence + reasoning
5. Safety policy determines auto-apply vs. pending review
6. Batch distributed lock prevents concurrent schema evolution on same job

**Reconciliation Phase:**

1. After crawl complete (or manually triggered), ReconciliationJob is enqueued
2. Worker calls `processReconciliation()` from @spatula/core
3. Three-layer consolidation:
   - **Layer 1: Synonym Detection** — EntityMatcher groups extractions by similar values (e.g., "John" vs "john" same entity)
   - **Layer 2: Normalization** — ValueNormalizer applies field-specific rules (trim, lowercase, date parsing)
   - **Layer 3: Entity Reconciliation** — Conflict resolver merges field values, source trust evaluator ranks conflicting sources, gap filler infers missing values
4. Every merged field retains provenance: which extraction(s) contributed, normalization applied, merge logic used
5. Entities stored in EntityRepository with quality scores

**Export Phase:**

1. ExportJob enqueued with format (JSON, CSV, Parquet, SQLite, DuckDB)
2. Worker calls `processExport()` from @spatula/core
3. Exporter iterates entities via cursor-based pagination (supports minQuality filtering, field selection, provenance inclusion)
4. Output written to ContentStore with metadata (entity count, file size)

**State Management:**

- **Job state machine:** pending → running → paused → reconciling → exporting → completed/failed
- **Task state machine:** pending → in_progress → completed/failed/skipped
- **Action state machine:** pending_review → approved/rejected → applied/rolled_back
- **Entity state:** created during reconciliation, immutable; exported with provenance
- **Schema state:** versioned; each version has parent ID for rollback traceability

## Key Abstractions

**Orchestrators (Pure Functions):**

- `processCrawlTask()` — `packages/core/src/pipeline/crawl-orchestrator.ts`
  - Pure: takes CrawlTaskInput + CrawlOrchestratorDeps, returns CrawlTaskResult
  - No queue knowledge; caller decides how to enqueue child tasks
  - Handles: crawling, dedup, classification, extraction, link evaluation, evolution trigger

- `processSchemaEvolution()` — `packages/core/src/pipeline/schema-orchestrator.ts`
  - Analyzes extractions, generates schema action recommendations
  - Payload: jobId, tenantId, extractionIds
  - Returns: actions with confidence + reasoning

- `processReconciliation()` — `packages/core/src/pipeline/reconcile-orchestrator.ts`
  - Consolidates extractions into entities
  - Three-layer consolidation, provenance tracking
  - Returns: entity count, quality stats, errors

- `processExport()` — `packages/core/src/pipeline/export-orchestrator.ts`
  - Iterates entities, applies format-specific serialization
  - Supports cursor pagination, quality filtering, field selection

**LocalPipelineRunner (In-Process Alternative):**

- Location: `packages/core/src/pipeline/local-pipeline-runner.ts`
- Orchestrates entire pipeline without BullMQ; uses in-memory PriorityQueue + Semaphore
- Used by CLI for local development mode
- Implements crash recovery, project locking, run records

**LLM Routing (Smart Model Selection):**

- Location: `packages/core/src/llm/model-router.ts`
- Three-tier strategy: fast (e.g., GPT-4o mini), primary (e.g., GPT-4o), smart (e.g., Claude Opus for complex tasks)
- Routes classification, extraction, schema evolution, reconciliation to appropriate model based on task complexity
- Tracks usage for billing

**Action Model (Execution via Approval Workflow):**

- Location: `packages/core/src/execution/action-executor-impl.ts`
- 52 action types: 25 pipeline (schema mutations, normalization rules, reconciliation decisions) + 30 config (crawl settings, seed URLs, field definitions)
- Each action has: id, type, payload, confidence, reasoning, status (pending_review/approved/applied/rejected/rolled_back)
- Safety policies govern auto-apply: always_auto, auto_above_threshold, always_review, batch_review
- Review queue supports user approval with comments before apply

**Data Source Interface (Abstraction for Local/Remote):**

- Location: `packages/core/src/interfaces/data-source.ts`
- Decouples entity/extraction queries from storage mechanism
- LocalDataSource: SQLite (CLI local mode)
- RemoteDataSource: API calls (CLI remote mode)
- Supports pagination, filtering, event streaming

## Entry Points

**API Server:**

- Location: `apps/api/src/index.ts`
- Exports: `createApp(deps)` → Hono app, `startServer()` → HTTP listener
- Instantiates with: db pool, Redis, queues, repositories, auth provider
- Routes: /api/v1/jobs, /api/v1/schemas, /api/v1/extractions, /api/v1/entities, /api/v1/actions, /api/v1/exports, admin routes, OpenAPI docs
- Middleware stack (order matters): request context, timing, logger, security headers, timeout, CORS, auth, tenant validation, rate limiting, idempotency

**CLI:**

- Entry: `npx spatula` (via Ink)
- Commands: init, add, push, schema, status, test-url, export, config, reset, logs, doctor, estimate, remote
- Modes: conversational (Ink inline prompts), dashboard (live progress), review (approve actions), explorer (navigate results)
- Uses LocalPipelineRunner for local execution; API client for remote

**Workers:**

- Crawl worker: `packages/queue/src/workers/crawl-worker.ts` — processes CrawlJobData
- Extract worker: Implicit (crawl orchestrator calls extractor inline)
- Schema worker: `packages/queue/src/workers/schema-worker.ts` — processes SchemaEvolutionJobData
- Reconciliation worker: `packages/queue/src/workers/reconciliation-worker.ts` — processes ReconciliationJobData
- Export worker: `packages/queue/src/workers/export-worker.ts` — processes ExportJobPayload

## Error Handling

**Strategy:** Type-safe error boundaries with recovery paths.

**Patterns:**

- **Network errors** (CrawlError, NetworkError) — caught in workers, logged, task marked failed or skipped depending on retry policy
- **Validation errors** (Zod parsing) — caught at route/worker entry, returned to client with details
- **Database errors** — caught in repositories, wrapped with context (jobId, tenantId), logged with structured fields
- **LLM errors** (quota, rate limit, model unavailable) — circuit breaker in `packages/core/src/llm/circuit-breaker.ts` falls back to secondary model or heuristics
- **State errors** (StateError from @spatula/shared) — thrown when action violates job state machine (e.g., pause already-paused job)
- **Quota errors** — caught in workers, tasks skipped, event published for user notification
- **DLQ fallback** — jobs that fail after retries pushed to dead-letter queue; admin can inspect, remediate, or re-enqueue

## Cross-Cutting Concerns

**Logging:**

- Framework: Pino-based logger from @spatula/shared
- Pattern: Create context logger with jobId, tenantId, taskId
- Example: `const logger = createLoggerWithContext('crawl-orchestrator', { jobId, tenantId }); logger.debug({...}, 'message')`
- Files: `packages/shared/src/logger.ts`

**Validation:**

- Framework: Zod schemas
- Entry points: API routes validate request bodies; orchestrators validate payloads
- Files: Schema definitions in `packages/core/src/types/` and `apps/api/src/schemas/`

**Authentication:**

- Pluggable providers: NoAuthProvider (dev), JWT, API Key
- Factory pattern: `apps/api/src/auth/factory.ts` instantiates based on AUTH_STRATEGY env var
- Middleware: `apps/api/src/middleware/auth.ts` extracts identity, enforces scopes
- Audit logging: `@spatula/shared` AuditLogger tracks user actions for compliance

**Multi-Tenancy:**

- Tenant ID extracted from JWT claims or API key tenant
- Every query/write includes tenantId for isolation
- Rate limiting per tenant plan (free/pro/enterprise)
- Repositories enforce tenant scoping in WHERE clauses

**Observability:**

- Metrics: Prometheus via @spatula/shared (job counts, worker durations, queue depths)
- Tracing: OpenTelemetry via @spatula/shared for distributed tracing across workers
- Error tracking: Sentry via @spatula/shared for exception aggregation
- Health checks: `/health` and deep health checks (db, redis, queue connectivity)

**Rate Limiting:**

- Per-tenant, per-API-endpoint tiers (free: 100 req/min, pro: 1000 req/min)
- Implemented in middleware via Redis sliding window counters
- File: `apps/api/src/middleware/rate-limit.ts`

**Idempotency:**

- POST/PATCH requests with Idempotency-Key header
- Result cached in Redis for 24 hours
- Prevents duplicate job creation on network retry
- File: `apps/api/src/middleware/idempotency.ts`

---

_Architecture analysis: 2026-05-06_
