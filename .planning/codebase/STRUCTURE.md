# Codebase Structure

**Analysis Date:** 2026-05-06

## Directory Layout

```
spatula/
├── apps/                    # Application entry points (HTTP API, CLI)
│   ├── api/                 # Hono HTTP API server
│   │   ├── src/
│   │   │   ├── index.ts             # Exports: createApp(), startServer()
│   │   │   ├── app.ts               # Hono app factory with middleware chain
│   │   │   ├── server.ts            # HTTP server startup
│   │   │   ├── types.ts             # AppDeps, AppEnv interfaces
│   │   │   ├── auth/                # Auth strategy implementations
│   │   │   ├── middleware/          # HTTP middleware (auth, validate, rate-limit, error-handle)
│   │   │   ├── routes/              # API endpoint handlers (23 route files)
│   │   │   ├── schemas/             # Zod validation schemas for requests/responses
│   │   │   └── openapi-config.ts    # OpenAPI/Swagger configuration
│   │   ├── tests/                   # API integration tests
│   │   └── package.json
│   │
│   └── cli/                 # Command-line interface (Ink TUI)
│       ├── src/
│       │   ├── commands/            # CLI commands (init, add, push, export, etc.)
│       │   ├── components/          # Ink React components (dashboard, review, explorer)
│       │   ├── hooks/               # React hooks (WebSocket, polling, entity filter)
│       │   ├── lib/                 # Utilities (schema-diff, yaml-fields)
│       │   ├── api/                 # API client for remote mode
│       │   ├── local-project.ts     # Local project management
│       │   └── notifications.ts     # Toast/notification system
│       ├── tests/                   # CLI tests
│       └── package.json
│
├── packages/                # Shared libraries
│   ├── core/                # Pure business logic (orchestrators, extractors, reconcilers)
│   │   ├── src/
│   │   │   ├── index.ts             # Main export barrel
│   │   │   ├── types/               # Type definitions (actions, schema, reconciliation, etc.)
│   │   │   ├── interfaces/          # Plugin interfaces (Crawler, Extractor, ContentStore, etc.)
│   │   │   ├── pipeline/            # Orchestrators (crawl, schema, reconciliation, export)
│   │   │   │   ├── crawl-orchestrator.ts        # Pure crawl task logic
│   │   │   │   ├── schema-orchestrator.ts       # Schema evolution logic
│   │   │   │   ├── reconcile-orchestrator.ts    # Entity consolidation
│   │   │   │   ├── export-orchestrator.ts       # Data export formatting
│   │   │   │   ├── local-pipeline-runner.ts     # In-process orchestration (CLI)
│   │   │   │   ├── types.ts                     # Repository interface definitions
│   │   │   │   └── pipeline-events.ts           # Event emission for monitoring
│   │   │   ├── extraction/          # Static + LLM-based extraction logic
│   │   │   ├── reconciliation/      # Three-layer consolidation (synonym → normalize → merge)
│   │   │   ├── evolution/           # Schema mutation recommendation logic
│   │   │   ├── execution/           # Action execution + approval workflow
│   │   │   ├── llm/                 # LLM clients (OpenRouter, Ollama) + routing
│   │   │   ├── crawlers/            # Crawler implementations + page budget
│   │   │   ├── exporters/           # Format-specific serialization (JSON, CSV, Parquet, DuckDB)
│   │   │   ├── content-store/       # Content storage abstraction (S3, local, database)
│   │   │   ├── config/              # Config parsing + diffing
│   │   │   ├── cost/                # Token/cost estimation
│   │   │   ├── billing/             # Billing-related logic
│   │   │   ├── diagnostics/         # Error diagnosis utilities
│   │   │   └── link-evaluation/     # Link relevance scoring
│   │   ├── tests/                   # Unit tests (vitest)
│   │   └── package.json
│   │
│   ├── queue/               # Job queue (BullMQ/Redis)
│   │   ├── src/
│   │   │   ├── index.ts             # Main export barrel
│   │   │   ├── queues.ts            # Queue definitions + job data types
│   │   │   ├── workers/             # Job processors (crawl, schema, reconciliation, export)
│   │   │   ├── job-manager.ts       # Job lifecycle management
│   │   │   ├── state-machine.ts     # Job state validation
│   │   │   ├── webhook-sender.ts    # Webhook delivery
│   │   │   ├── dlq-handler.ts       # Dead-letter queue management
│   │   │   ├── trace-context.ts     # OpenTelemetry trace propagation
│   │   │   ├── worker-heartbeat.ts  # Worker alive signal + health
│   │   │   ├── worker-deps.ts       # Worker dependency injection
│   │   │   └── redis-lock.ts        # Distributed locking for schema evolution
│   │   ├── tests/                   # Queue tests
│   │   └── package.json
│   │
│   ├── db/                  # Data persistence (PostgreSQL + SQLite)
│   │   ├── src/
│   │   │   ├── index.ts             # Main export barrel
│   │   │   ├── schema/              # PostgreSQL Drizzle schema definitions
│   │   │   ├── repositories/        # Data access objects (Job, Extraction, Entity, etc.)
│   │   │   ├── project-db/          # SQLite local database (for CLI mode)
│   │   │   │   ├── connection.ts            # SQLite DB factory
│   │   │   │   ├── adapter.ts              # ProjectAdapter for LocalPipelineRunner
│   │   │   │   ├── repositories/           # SQLite repos (mirror PostgreSQL repos)
│   │   │   │   └── schemas.ts              # SQLite schema definitions
│   │   │   ├── content-store/       # Content storage (S3, local filesystem, database)
│   │   │   ├── cache.ts             # Redis caching layer
│   │   │   └── connection.ts        # PostgreSQL/SQLite connection factories
│   │   ├── drizzle/                 # PostgreSQL migrations
│   │   ├── drizzle-sqlite/          # SQLite migration scripts
│   │   ├── tests/                   # Database tests
│   │   └── package.json
│   │
│   └── shared/              # Cross-cutting utilities
│       ├── src/
│       │   ├── index.ts             # Main export barrel
│       │   ├── logger.ts            # Pino-based structured logging
│       │   ├── errors.ts            # Error classes (CrawlError, NetworkError, StateError)
│       │   ├── config.ts            # Environment + config helpers
│       │   ├── utils.ts             # General-purpose utilities
│       │   ├── metrics.ts           # Prometheus metrics
│       │   ├── sentry.ts            # Error tracking integration
│       │   ├── tracing.ts           # OpenTelemetry setup
│       │   ├── cursor.ts            # Pagination cursor encoding/decoding
│       │   ├── webhook-types.ts     # Webhook event type definitions
│       │   ├── auth/                # Authentication + authorization
│       │   │   ├── quotas.ts               # Quota enforcement (billing)
│       │   │   ├── audit-logger.ts        # Audit trail logging
│       │   │   ├── rate-limit-tiers.ts    # Rate limiting tiers
│       │   │   └── types.ts               # Auth types (Tenant, User, Scope)
│       │   ├── billing/              # Billing/plan logic
│       │   └── types/               # Shared type definitions
│       ├── tests/                   # Shared lib tests
│       └── package.json
│
├── tests/                   # E2E and integration tests
│   ├── e2e/                 # End-to-end tests (Vitest)
│   │   ├── fixtures/        # Test data fixtures
│   │   └── vitest.config.ts
│   └── ...
│
├── docs/                    # Documentation
│   ├── plans/               # Implementation phases (Wave specs, design docs)
│   ├── superpowers/         # Design reviews and specifications
│   └── ...
│
├── examples/                # Example projects (ecommerce, news, real-estate, quickstart)
│   ├── ecommerce/
│   ├── news/
│   ├── real-estate/
│   └── quickstart/
│
├── scripts/                 # Utility scripts
│   └── ...
│
├── .planning/codebase/      # GSD codebase mapping documents
│   ├── ARCHITECTURE.md      # Architecture patterns and layers
│   ├── STRUCTURE.md         # Directory structure and organization
│   ├── STACK.md             # Technology stack
│   ├── INTEGRATIONS.md      # External service integrations
│   ├── CONVENTIONS.md       # Coding conventions
│   ├── TESTING.md           # Testing patterns
│   └── CONCERNS.md          # Technical debt and issues
│
├── .github/workflows/       # CI/CD pipelines (GitHub Actions)
├── .turbo/                  # Turbo cache metadata
│
├── turbo.json               # Turborepo configuration (build tasks, caching)
├── package.json             # Root workspace configuration (pnpm workspaces)
├── tsconfig.json            # TypeScript base configuration
├── eslint.config.mjs        # ESLint configuration
├── .prettierrc               # Prettier formatting config
│
├── Dockerfile.api           # Docker image for API server
├── Dockerfile.cli           # Docker image for CLI
├── Dockerfile.worker        # Docker image for queue workers
├── docker-compose.yml       # Local development environment
├── docker-compose.prod.yml  # Production deployment (multi-container)
│
└── LICENSE, README.md, etc.
```

## Directory Purposes

**apps/**

- Contains production applications (API server, CLI).
- Each app is independently buildable/deployable via Turbo.
- API: multi-tenant HTTP service; CLI: conversational TUI for local/remote modes.

**packages/**

- Shared libraries published as npm packages (or internal monorepo packages).
- Core: stateless business logic reusable by API, CLI, workers.
- Queue: BullMQ orchestration (server-mode only).
- Db: PostgreSQL/SQLite data layer with repositories + content stores.
- Shared: utilities, logging, auth, observability.

**tests/e2e/**

- Full end-to-end test suite: API + workers + database.
- Uses Vitest with fixtures for test data.
- Spawns Docker containers (Postgres, Redis, queue workers) if needed.

**docs/plans/**

- Implementation phase plans (Wave 1–5, Wave 6+).
- Design decisions, acceptance criteria, review findings.
- Link: `docs/plans/2026-03-06-spatula-design.md` is the master design doc.

**.planning/codebase/**

- GSD codebase mapping documents (this directory).
- Consumed by `/gsd:plan-phase` and `/gsd:execute-phase` for consistent code generation.

## Key File Locations

**Entry Points:**

- **API:** `apps/api/src/index.ts` — `createApp(deps)` and `startServer()` exports
- **CLI:** Commands in `apps/cli/src/commands/` (init, add, push, export, schema, etc.)
- **Core Library:** `packages/core/src/index.ts` — Re-exports all public modules
- **Queue Workers:** `packages/queue/src/workers/` — Four worker files (crawl, schema, reconciliation, export)
- **Database:** `packages/db/src/index.ts` — Repository + connection factories

**Configuration:**

- **Auth:** `apps/api/src/auth/factory.ts` — AUTH_STRATEGY env var selects provider
- **Rate Limiting:** `@spatula/shared` defines tiers in `packages/shared/src/auth/rate-limit-tiers.ts`
- **Queues:** `packages/queue/src/queues.ts` — Queue names, retry policies, job data types
- **Billing:** `packages/shared/src/billing/` — Plan tiers, usage tracking
- **LLM Routing:** `packages/core/src/llm/model-router.ts` — Fast/primary/smart tier strategy

**Core Logic:**

- **Crawl Orchestration:** `packages/core/src/pipeline/crawl-orchestrator.ts` (pure function)
- **Schema Evolution:** `packages/core/src/pipeline/schema-orchestrator.ts`
- **Reconciliation:** `packages/core/src/pipeline/reconcile-orchestrator.ts` (three-layer consolidation)
- **Export:** `packages/core/src/pipeline/export-orchestrator.ts` (format serialization)
- **Local Pipeline:** `packages/core/src/pipeline/local-pipeline-runner.ts` (in-process CLI mode)
- **Actions:** `packages/core/src/types/actions.ts` (52 action type definitions)
- **Extraction:** `packages/core/src/extraction/` (static + LLM-based extraction)

**Testing:**

- **Core Tests:** `packages/core/tests/`
- **API Tests:** `apps/api/tests/`
- **Queue Tests:** `packages/queue/tests/`
- **DB Tests:** `packages/db/tests/`
- **E2E Tests:** `tests/e2e/`

## Naming Conventions

**Files:**

- **Orchestrators:** `*-orchestrator.ts` (e.g., `crawl-orchestrator.ts`)
- **Workers:** `*-worker.ts` (e.g., `crawl-worker.ts`)
- **Repositories:** `*-repository.ts` (e.g., `job-repository.ts`)
- **Middleware:** `*.ts` in `middleware/` (e.g., `auth.ts`, `error-handler.ts`)
- **Routes:** `*routes.ts` in `routes/` (e.g., `jobs.ts` exports `jobRoutes()`)
- **Components:** `*.tsx` with PascalCase (e.g., `Dashboard.tsx`)
- **Hooks:** `use*.ts` (e.g., `useWebSocket.ts`)
- **Schemas:** `*-schema.ts` or `*-request.ts` (e.g., `job.ts` in `schemas/`)
- **Types:** `*.ts` in `types/` directory (e.g., `actions.ts`, `schema.ts`)
- **Interfaces:** `*.ts` or embedded in files (e.g., `action-executor.ts`)
- **Tests:** `*.test.ts` or `*.spec.ts` co-located with source

**Directories:**

- **Feature directories:** Plural noun (e.g., `extractors/`, `crawlers/`, `routes/`, `middleware/`)
- **Type directories:** Plural noun (e.g., `types/`, `interfaces/`, `schemas/`, `repositories/`)
- **Utility directories:** Plural noun (e.g., `utils/`, `helpers/`, `lib/`)

**Functions/Exports:**

- **Pure orchestrators:** `process*Task()` or `process*()` (e.g., `processCrawlTask()`, `processSchemaEvolution()`)
- **Factory functions:** `create*()` (e.g., `createApp()`, `createDatabase()`)
- **Constructors/Classes:** PascalCase (e.g., `JobRepository`, `LocalPipelineRunner`, `DefaultActionExecutor`)
- **Utility functions:** camelCase (e.g., `isValidCrawlUrl()`, `shouldTriggerSchemaEvolution()`)

**Variables/Types:**

- **Types:** PascalCase (e.g., `CrawlTaskInput`, `ActionResult`, `SchemaDefinition`)
- **Zod schemas:** camelCase ending in `Schema` (e.g., `createJobSchema`, `jobResponseSchema`)
- **Enums:** PascalCase (e.g., `ActionSource`, `ActionStatus`, `SafetyPolicy`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `QUEUE_NAMES`, `MAX_RETRIES`, `DRAIN_TIMEOUT_MS`)

## Where to Add New Code

**New Pipeline Feature (e.g., quality audit phase):**

1. **Type definitions:** `packages/core/src/types/quality.ts` (input, output, action types)
2. **Interface:** `packages/core/src/interfaces/quality-auditor.ts` (plug-in interface)
3. **Implementation:** `packages/core/src/quality/` (business logic)
4. **Orchestrator:** `packages/core/src/pipeline/quality-orchestrator.ts` (pure function)
5. **Worker:** `packages/queue/src/workers/quality-worker.ts` (job processor)
6. **Repo extension:** `packages/db/src/repositories/*-repository.ts` (if needed for persistence)
7. **Route:** `apps/api/src/routes/quality.ts` (if user-facing API endpoint)
8. **Tests:** Co-locate in `packages/core/tests/quality.test.ts`, etc.

**New API Endpoint:**

1. **Route handler:** Create file in `apps/api/src/routes/` (e.g., `features.ts`)
2. **Request schema:** Add to `apps/api/src/schemas/` (Zod validation)
3. **Response schema:** Reuse from `apps/api/src/schemas/responses.ts` (dataResponse, errorResponse)
4. **Register in app:** Import and `app.route('/api/v1/features', featureRoutes())` in `apps/api/src/app.ts`
5. **Tests:** `apps/api/tests/features.test.ts`

**New Command (CLI):**

1. **Command file:** `apps/cli/src/commands/my-command.ts` (export default or named function)
2. **Command registration:** Update CLI entry point to discover command
3. **Local mode:** Extends `LocalProject` if needs local state
4. **Remote mode:** Uses `ApiClient` to call API endpoints
5. **Hooks/Components:** If interactive (Ink TUI), add to `apps/cli/src/hooks/` and `apps/cli/src/components/`

**New Shared Utility:**

- Simple utils: `packages/shared/src/utils.ts`
- Domain-specific: Create file in `packages/shared/src/` (e.g., `audit-logger.ts`, `rate-limit-tiers.ts`)
- Always export from `packages/shared/src/index.ts`

**New Repository/Entity Type:**

1. **PostgreSQL schema:** `packages/db/src/schema/` (Drizzle table definition)
2. **SQLite schema:** `packages/db/src/schema-sqlite/` (mirror for local mode)
3. **PostgreSQL repo:** `packages/db/src/repositories/my-entity-repository.ts`
4. **SQLite repo:** `packages/db/src/project-db/repositories/my-entity-repository.ts`
5. **Export from:** `packages/db/src/index.ts`

## Special Directories

**node_modules/:**

- Purpose: All npm dependencies, auto-generated by pnpm
- Generated: Yes
- Committed: No

**dist/, .turbo/:**

- Purpose: Build outputs and Turbo cache
- Generated: Yes
- Committed: No

**.env files:**

- Location: `.env` (local), `.env.example` (committed template)
- Purpose: Environment configuration (API keys, database URLs, auth config)
- Committed: No (secrets ignored in .gitignore)

**drizzle/, drizzle-sqlite/:**

- Purpose: Drizzle ORM migration files for PostgreSQL and SQLite
- Generated: Via `drizzle-kit generate`
- Committed: Yes (migrations are part of version control)

**examples/:**

- Purpose: Real-world example projects (ecommerce scraping, news aggregation, real-estate listings)
- Helps users understand how to structure crawl jobs for different domains
- Each contains: `spatula.yaml` (job config), seed URLs, expected schema

---

_Structure analysis: 2026-05-06_
