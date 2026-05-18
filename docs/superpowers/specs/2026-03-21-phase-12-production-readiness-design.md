# Phase 12: Production Readiness & Platform Launch

**Status:** Draft
**Created:** 2026-03-21
**Depends on:** Phases 1-11e (all complete or in progress)
**Scope:** Close every gap between current state and a deployable, secure, observable, open-source-ready platform with a hosted offering.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Workstream A: Infrastructure & Deployment](#2-workstream-a--infrastructure--deployment)
3. [Workstream B: Security & Authentication](#3-workstream-b--security--authentication)
4. [Workstream C: Observability & Monitoring](#4-workstream-c--observability--monitoring)
5. [Workstream D: Reliability & Resilience](#5-workstream-d--reliability--resilience)
6. [Workstream E: Performance & Scalability](#6-workstream-e--performance--scalability)
7. [Workstream F: Data Pipeline Hardening](#7-workstream-f--data-pipeline-hardening)
8. [Workstream G: API & CLI Completeness](#8-workstream-g--api--cli-completeness)
9. [Workstream H: Open-Source Readiness](#9-workstream-h--open-source-readiness)
10. [Workstream I: Hosted Platform Layer](#10-workstream-i--hosted-platform-layer)
11. [Workstream J: Local Developer Experience](#11-workstream-j--local-developer-experience)
12. [Dependency Graph](#12-dependency-graph)
13. [Testing Strategy](#13-testing-strategy)
14. [Migration & Rollout](#14-migration--rollout)

---

## 1. Overview

### 1.1 Current State

Spatula has a mature core engine spanning 10+ phases: pluggable crawlers (Playwright + Firecrawl), LLM-powered extraction with model routing, schema evolution with distributed locking, three-layer data reconciliation, a REST API with OpenAPI 3.1 + Swagger UI, a four-mode CLI TUI, and export to five formats (JSON, CSV, Parquet, SQLite, DuckDB). The architecture is interface-driven, action-based, and multi-tenant from day one.

### 1.2 Gap Summary

The core data pipeline is strong. The gaps are in the **operational wrapper** -- the infrastructure, security, observability, and developer experience layers that turn a well-architected library into a deployable product. This spec addresses 60 gaps across 10 workstreams.

### 1.3 Target Deployment Model

**Hybrid (Model D):** Open-source core with a hosted offering on top.

- Open-source: MIT-licensed core packages (`@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/shared`), API, and CLI
- Hosted: multi-tenant SaaS with auth, billing, usage metering, admin panel

### 1.4 Workstream Independence

Each workstream can be implemented and tested independently, though some have ordering constraints (see section 11 Dependency Graph). Workstreams A-F harden the open-source core. Workstreams G-I add the hosted layer and community infrastructure.

---

## 2. Workstream A -- Infrastructure & Deployment

### 2.1 CI/CD Pipeline

**Problem:** No automated quality gates. Tests, lint, type-checking, and builds are manual-only.

**Design:** GitHub Actions with three workflows.

#### 2.1.1 CI Workflow (`.github/workflows/ci.yml`)

Triggers on push to `main` and all PRs.

**Jobs (parallel where possible):**

| Job            | Steps                                                                 | Runs on                                        |
| -------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| `lint`         | pnpm install, `turbo run lint`                                        | ubuntu-latest                                  |
| `typecheck`    | pnpm install, `turbo run typecheck`                                   | ubuntu-latest                                  |
| `format-check` | pnpm install, `pnpm format:check`                                     | ubuntu-latest                                  |
| `test-unit`    | pnpm install, `turbo run test`                                        | ubuntu-latest                                  |
| `test-e2e`     | pnpm install, docker-compose up -d, wait-for-healthy, `pnpm test:e2e` | ubuntu-latest (services: postgres:16, redis:7) |
| `build`        | pnpm install, `turbo run build`                                       | ubuntu-latest                                  |

**Caching:** pnpm store (`~/.pnpm-store`) and Turborepo cache (`.turbo`).

**Required checks for merge:** All 6 jobs must pass.

#### 2.1.2 Release Workflow (`.github/workflows/release.yml`)

Triggers on git tags matching `v*`.

**Steps:**

1. Run full CI (reuse ci.yml as called workflow)
2. Build Docker images (API, worker, CLI)
3. Push to GitHub Container Registry (`ghcr.io/spatula/api`, `ghcr.io/spatula/worker`, `ghcr.io/spatula/cli`)
4. Create GitHub Release with auto-generated changelog from conventional commits

#### 2.1.3 Dependency Audit (`.github/workflows/audit.yml`)

Weekly cron + on lockfile changes.

**Steps:** `pnpm audit --audit-level=high` -- fails on high/critical vulnerabilities.

### 2.2 Application Dockerfiles

**Problem:** Only postgres and redis are containerized. The Node.js apps have no Dockerfiles.

**Design:** Three multi-stage Dockerfiles sharing a common base pattern.

#### 2.2.1 `Dockerfile.api`

```dockerfile
# Stage 1: Install all dependencies (dev + prod for build)
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# Stage 2: Production dependencies only
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod

# Stage 3: Runtime — preserves full monorepo directory structure
FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -g 1001 -S spatula && adduser -S spatula -u 1001
# Copy full node_modules tree (preserves pnpm workspace symlinks)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /app/packages/queue/node_modules ./packages/queue/node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
# Copy built output preserving directory structure
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/queue/dist ./packages/queue/dist
COPY --from=build /app/packages/queue/package.json ./packages/queue/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/package.json ./
USER spatula
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
```

**Note:** The monorepo directory structure must be preserved exactly so that pnpm workspace symlinks and Node.js module resolution work correctly. Each package's `dist/` and `package.json` are copied individually to maintain the `packages/<name>/dist` path structure that `node_modules/@spatula/*` symlinks resolve to.

#### 2.2.2 `Dockerfile.worker`

Same build stages. Runtime stage runs a new `worker-entrypoint.ts` (see section 2.4).

**Key differences:**

- No `EXPOSE` (workers do not serve HTTP)
- `CMD ["node", "packages/queue/dist/worker-entrypoint.js"]`

#### 2.2.3 `Dockerfile.cli`

Lighter image -- no database/redis runtime deps needed (CLI talks to API).

**Base:** `node:22-alpine`
**Entry:** `CMD ["node", "apps/cli/dist/index.js"]`
**Note:** CLI image is for CI/scripting use. Interactive TUI use runs locally via `npx @spatula/cli`.

### 2.3 Graceful Shutdown

**Problem:** No SIGTERM/SIGINT handlers. Kubernetes sends SIGTERM, waits 30s, then SIGKILL. Currently: mid-flight requests drop, BullMQ jobs become orphaned "active" until lock TTL expires, WebSocket clients disconnect without notice.

#### 2.3.1 API Server Shutdown (`apps/api/src/server.ts`)

Add `setupGracefulShutdown(server, deps)` that:

1. Sets `isShuttingDown = true` to reject new connections
2. Closes WebSocket connections with code 1001 (Going Away)
3. Quits Redis subscriber
4. Ends database pool
5. Calls `process.exit(0)`

Listens on both `SIGTERM` and `SIGINT`.

**Drain timeout:** 25 seconds (leaves 5s buffer before k8s SIGKILL at 30s). If connections do not drain in 25s, force exit.

#### 2.3.2 Worker Shutdown (`packages/queue/src/worker-entrypoint.ts`)

BullMQ `Worker.close()` is the correct method -- it finishes the current job, releases the lock, and stops picking up new jobs. This prevents orphaned jobs.

On SIGTERM/SIGINT:

1. Call `Worker.close()` on all worker instances (via `Promise.allSettled`)
2. Quit Redis connection
3. End database pool
4. Close crawler instance
5. `process.exit(0)`

### 2.4 Worker Entry Point

**Problem:** Workers are exported as process functions but there is no main entry point that registers them with BullMQ and manages lifecycle.

**New file:** `packages/queue/src/worker-entrypoint.ts`

Creates BullMQ Worker instances for each queue, wires up WorkerDeps via DI, handles shutdown.

```typescript
const workers = [
  new Worker(QUEUE_NAMES.CRAWL, processCrawlJob, {
    connection,
    concurrency: config.crawl.concurrency,
  }),
  new Worker(QUEUE_NAMES.SCHEMA_EVOLUTION, processSchemaEvolutionJob, {
    connection,
    concurrency: 1,
  }),
  new Worker(QUEUE_NAMES.RECONCILIATION, processReconciliationJob, { connection, concurrency: 1 }),
  new Worker(QUEUE_NAMES.EXPORT, processExportJob, {
    connection,
    concurrency: config.export.concurrency,
  }),
];
```

**Configuration:** Worker types to run are selectable via `SPATULA_WORKERS` env var (comma-separated). Default: all. This allows deploying crawl-heavy workers separately from export workers.

### 2.5 Extract Shared Pipeline Orchestrators (Recommended)

**Problem:** The BullMQ workers contain significant business logic interleaved with queue-specific concerns — content dedup, page classification, schema evolution batching, link evaluation, error classification. This logic is tightly coupled to BullMQ/Redis and cannot be reused by Phase 13's local execution pipeline.

**Design:** Extract pure orchestration functions into `@spatula/core`:

```
packages/core/src/pipeline/
  crawl-orchestrator.ts       # Content dedup, classify, extract, evaluate links
  schema-orchestrator.ts      # Batch check, evolve, apply actions, version bump
  reconcile-orchestrator.ts   # Load extractions, reconcile, store entities
  export-orchestrator.ts      # Validate, dispatch format, write output
```

Each orchestrator accepts repositories and core services via dependency injection — no BullMQ/Redis references. The existing workers become thin wrappers: parse job data, call orchestrator, update job status.

**Why in Phase 12:** This refactoring improves server-mode code quality regardless of Phase 13 (cleaner separation of concerns, easier testing). Since Workstream A already refactors workers for graceful shutdown (section 2.3) and the entry point (section 2.4), extracting orchestrators at the same time is natural and efficient. If Phase 13 is executed in parallel (see section 12, Dependency Graph), this unblocks Phase 13 Step 1.

**If deferred:** Becomes Phase 13 Step 1 instead. No impact on Phase 12 functionality.

### 2.6 Connection Pooling

**Problem:** `packages/db/src/connection.ts` creates a single `pg` client. Under concurrent API requests or parallel workers, this becomes a bottleneck and single point of failure.

**Change:** Replace `drizzle({ connection: { connectionString } })` with an explicit `pg.Pool`:

```typescript
import { Pool } from 'pg';

export function createDatabasePool(connectionString?: string): { db: Database; pool: Pool } {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) throw new StorageError('DATABASE_URL is required', { code: 'STORAGE_ERROR' });

  const pool = new Pool({
    connectionString: url,
    max: parseInt(process.env.DB_POOL_MAX || '20', 10),
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}
```

**New env vars:**

- `DB_POOL_MAX` -- maximum connections (default: 20 for API, 5 for workers)
- `DB_POOL_IDLE_TIMEOUT` -- idle connection timeout in ms (default: 30000)

**Impact:** `pool` is returned alongside `db` so shutdown handlers can call `pool.end()`.

**AppDeps update:** Add `dbPool: Pool` to `AppDeps` (in `apps/api/src/types.ts`) and `WorkerDeps` (in `packages/queue/src/worker-deps.ts`). All call sites that construct these deps objects must be updated:

- `apps/api/src/index.ts` -- where `AppDeps` is assembled before `startServer()`
- `packages/queue/src/worker-entrypoint.ts` -- where `WorkerDeps` is assembled
- All test files that construct mock `AppDeps` -- add `dbPool` as a mock/stub

The `depsMiddleware` in `apps/api/src/middleware/deps.ts` already passes the full `AppDeps` to context; no change needed there once `dbPool` is added to the `AppDeps` type.

### 2.7 Production Docker Compose

**New file:** `docker-compose.prod.yml`

Extends existing `docker-compose.yml` with application services:

- `api` service: builds from `Dockerfile.api`, ports 3000, depends on healthy postgres + redis, 2 replicas
- `worker` service: builds from `Dockerfile.worker`, depends on healthy postgres + redis, 2 replicas
- `migrate` service: one-shot init container (restart: none), runs migrations before app starts

**Design decisions:**

- `migrate` runs as a one-shot init container (restart: none)
- API and worker scale independently
- Both depend on healthy postgres + redis before starting
- `.env` file for secrets (production would use Docker secrets or vault)

### 2.8 Database Backup Strategy

**For self-hosted:** Document `pg_dump` cron pattern in deployment guide.

**For hosted:** Managed Postgres (e.g., Supabase, RDS, Neon) handles WAL archiving and PITR. No custom backup code needed -- this is an operational runbook item, not application code.

---

## 3. Workstream B -- Security & Authentication

### 3.1 Authentication Architecture

**Problem:** The API is completely open. `x-tenant-id` is a trust-based header -- any client can claim any tenant identity.

**Design:** Two-layer auth supporting both the open-source and hosted models.

#### 3.1.1 Auth Strategy Selection

**Open-source deployments:** API key authentication (simple, stateless, no external dependencies).

**Hosted offering:** JWT tokens issued by an identity provider (supports SSO, session management, token refresh).

Both strategies implement a common `AuthProvider` interface:

```typescript
interface AuthResult {
  tenantId: string;
  userId: string;
  scopes: string[]; // e.g., ['jobs:read', 'jobs:write', 'admin']
}

interface AuthProvider {
  authenticate(request: HonoRequest): Promise<AuthResult>;
}
```

**Configuration:** `AUTH_STRATEGY` env var -- `api-key` (default), `jwt`, or `none` (development).

#### 3.1.2 API Key Authentication

**Database table:** `api_keys`

```sql
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL,            -- SHA-256 hash of the key
  key_prefix VARCHAR(8) NOT NULL,    -- First 8 chars for identification
  name VARCHAR(255) NOT NULL,        -- Human-readable label
  scopes TEXT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
```

**Key format:** `sk_live_{32-char-random}` (total 40 chars). Only the hash is stored; the raw key is shown once at creation.

**Auth flow:**

1. Client sends `Authorization: Bearer sk_live_...`
2. Middleware computes SHA-256 of key
3. Looks up `api_keys` by hash WHERE `revoked_at IS NULL` AND (`expires_at IS NULL` OR `expires_at > now()`)
4. Returns `{ tenantId, userId: key.id, scopes }` or 401

**Endpoints:**

- `POST /api/v1/api-keys` -- create key (returns raw key once)
- `GET /api/v1/api-keys` -- list keys (prefix + name only, never hash)
- `DELETE /api/v1/api-keys/:id` -- revoke key (soft delete via `revoked_at`)

#### 3.1.3 JWT Authentication (Hosted)

**Provider:** Configurable -- supports any OIDC-compliant provider (Auth0, Clerk, Supabase Auth, custom).

**Configuration:**

```
AUTH_STRATEGY=jwt
JWT_ISSUER=https://auth.spatula.dev
JWT_AUDIENCE=https://api.spatula.dev
JWT_JWKS_URL=https://auth.spatula.dev/.well-known/jwks.json
```

**Auth flow:**

1. Client sends `Authorization: Bearer <jwt>`
2. Middleware validates signature using cached JWKS
3. Validates `iss`, `aud`, `exp` claims
4. Extracts `sub` (userId) and `tenant_id` (custom claim) and `scopes`
5. Returns `AuthResult` or 401

**Library:** `jose` (lightweight, no native deps, supports EdDSA + RS256).

#### 3.1.4 Auth Middleware Integration

**New middleware:** `apps/api/src/middleware/auth.ts`

Wraps the `AuthProvider` interface. Extracts token from `Authorization` header, calls `provider.authenticate()`, sets `auth` and `tenantId` on the Hono context.

**Middleware chain update (app.ts):**

```
requestContext -> logger -> errorHandler -> authMiddleware -> depsMiddleware -> validateTenant -> routes
```

**Tenant middleware transition:**

- When `AUTH_STRATEGY=none`: The existing `tenantMiddleware` (header-based `x-tenant-id` extraction) remains active. No `authMiddleware` is applied. This is the current behavior and preserves backward compatibility for local development.
- When `AUTH_STRATEGY=api-key` or `jwt`: `tenantMiddleware` is **removed** from the middleware chain entirely. The `authMiddleware` is the sole source of `tenantId` (derived from API key lookup or JWT claims). The `x-tenant-id` header is **ignored** to prevent impersonation. This is a breaking change for API clients — see section 13.5 for migration guidance.

**Skip auth paths:** `/health`, `/health/live`, `/health/ready`, `/api/docs`, `/api/openapi.json`

#### 3.1.5 Scope-Based Authorization

Scopes follow the pattern `resource:action`:

| Scope           | Allows                                        |
| --------------- | --------------------------------------------- |
| `jobs:read`     | List/get jobs, schemas, extractions, entities |
| `jobs:write`    | Create/start/pause/cancel jobs                |
| `exports:read`  | List/download exports                         |
| `exports:write` | Trigger exports                               |
| `actions:read`  | List pending actions                          |
| `actions:write` | Approve/reject actions                        |
| `tenants:admin` | Manage tenant settings                        |
| `keys:manage`   | Create/revoke API keys                        |
| `admin`         | Full admin access (system-wide)               |

**Default scopes for new API keys:** `['jobs:read', 'jobs:write', 'exports:read', 'exports:write', 'actions:read', 'actions:write']`

**Enforcement:** `requireScope('jobs:write')` middleware per route.

### 3.2 Rate Limiting

**Problem:** No request-level throttling. A single client can saturate the API or trigger excessive LLM costs.

**Design:** Sliding-window rate limiting backed by Redis.

#### 3.2.1 Rate Limit Tiers

| Tier         | Requests/min | Concurrent Jobs | Applies to     |
| ------------ | ------------ | --------------- | -------------- |
| `free`       | 60           | 2               | Default        |
| `standard`   | 300          | 10              | Paid plans     |
| `enterprise` | 1500         | 50              | Enterprise     |
| `unlimited`  | --           | --              | Internal/admin |

**Storage:** Redis sorted sets with sliding window algorithm.

**Key pattern:** `ratelimit:{tenantId}:{window}` with ZRANGEBYSCORE for window queries.

#### 3.2.2 Rate Limit Middleware

**New middleware:** `apps/api/src/middleware/rate-limit.ts`

Uses a Redis Lua script for atomic sliding window counting — all operations execute in a single roundtrip with no TOCTOU race between count check and accept/reject decision:

```lua
-- rate_limit.lua: atomic sliding window rate limiter
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  return {0, count}  -- rejected
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(window / 1000) + 1)
return {1, count + 1}  -- accepted, new count
```

The Lua script returns `{accepted, currentCount}`. The middleware uses this to set response headers.

**Response headers (all responses):**

- `X-RateLimit-Limit` -- max requests per window
- `X-RateLimit-Remaining` -- requests remaining
- `Retry-After` -- seconds until reset (on 429 only)

### 3.3 CORS Configuration

**Problem:** No CORS headers. Browser-based clients are blocked entirely.

**Design:** Use Hono's built-in CORS middleware with configurable origins.

**New env var:** `CORS_ALLOWED_ORIGINS` -- comma-separated list of allowed origins. Default: `http://localhost:3000`.

**Configuration:**

- `allowMethods`: GET, POST, PUT, PATCH, DELETE, OPTIONS
- `allowHeaders`: Authorization, Content-Type, X-Request-Id
- `exposeHeaders`: X-RateLimit-Limit, X-RateLimit-Remaining, X-Request-Id
- `maxAge`: 86400
- `credentials`: true

### 3.4 Tenant Resource Quotas

**Problem:** One tenant can consume all crawl/LLM/export capacity.

**Design:** Per-tenant quotas stored in the `tenants` table.

**Schema extension (tenants table):**

```sql
ALTER TABLE tenants ADD COLUMN quotas JSONB NOT NULL DEFAULT '{
  "maxConcurrentJobs": 2,
  "maxPagesPerJob": 5000,
  "maxEntitiesPerExport": 50000,
  "maxStorageMb": 1000,
  "rateLimitTier": "free"
}';
```

**Enforcement points:**

- `JobManager.startJob()` -- check concurrent job count against `maxConcurrentJobs`
- Crawl worker -- check page count against `maxPagesPerJob` (see section 7.2)
- Export worker -- already enforces MAX_EXPORT_ENTITIES; make configurable per-tenant
- Content store -- track storage bytes per tenant, reject when over `maxStorageMb`

### 3.5 WebSocket Authentication

**Problem:** Browsers cannot set custom headers on WebSocket upgrade. Current fallback (`?tenantId=` query param) is unauthenticated.

**Design:** Token-based WebSocket auth.

**Flow:**

1. Client calls `POST /api/v1/ws-token` (authenticated) -- returns a short-lived token (60s TTL, single-use)
2. Client connects to `ws://host/ws/jobs/:id/progress?token=<ws-token>`
3. Server validates token from Redis, extracts tenantId, deletes token (single-use)
4. Proceeds with existing `JobProgressManager.addClient()` flow

**Token storage:** Redis key `ws-token:{token}` with value `{ tenantId, expiresAt }` and 60s TTL.

**Critical: Remove legacy bypass.** When `AUTH_STRATEGY` is not `none`, the existing `?tenantId=` query parameter fallback in `server.ts` must be removed. Only token-based WebSocket auth is allowed in authenticated mode. The `?tenantId=` path remains available only when `AUTH_STRATEGY=none` (local development).

### 3.6 Audit Logging

**Problem:** No record of authentication events, API key lifecycle, or admin actions.

**Design:** Append-only `audit_log` table.

```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  actor_id TEXT NOT NULL,             -- userId or api_key id
  actor_type VARCHAR(20) NOT NULL,    -- 'user', 'api_key', 'system'
  action VARCHAR(100) NOT NULL,       -- e.g., 'job.created', 'api_key.revoked'
  resource_type VARCHAR(50),          -- e.g., 'job', 'api_key', 'tenant'
  resource_id TEXT,
  metadata JSONB DEFAULT '{}',
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_time ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_action_time ON audit_log(action, created_at DESC);  -- system-level queries (e.g., all auth failures)
```

**Events logged:**

- `auth.login_success`, `auth.login_failure`
- `api_key.created`, `api_key.revoked`
- `job.created`, `job.started`, `job.cancelled`, `job.deleted`
- `export.requested`, `export.downloaded`
- `tenant.updated`, `tenant.quota_exceeded`

**Implementation:** `AuditLogger` service injected into middleware and route handlers. Writes are fire-and-forget (non-blocking) via `setImmediate` to avoid slowing requests.

### 3.7 Security Headers

**Design:** Add standard security headers via Hono middleware on all responses:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-XSS-Protection: 0` (disabled per OWASP recommendation; CSP preferred)
- `Referrer-Policy: strict-origin-when-cross-origin`

---

## 4. Workstream C -- Observability & Monitoring

### 4.1 Metrics Collection

**Problem:** No way to measure request latency, queue depth, LLM cost, crawl throughput, or error rates.

**Design:** OpenTelemetry SDK with Prometheus exporter.

#### 4.1.1 Metrics Library

**Packages:** `@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-prometheus`

**New file:** `packages/shared/src/metrics.ts`

Creates a `MeterProvider` with `PrometheusExporter` on port 9464.

**Metrics defined:**

API metrics:

- `http_request_duration_ms` (histogram)
- `http_requests_total` (counter)
- `http_active_connections` (up-down counter)

Queue metrics:

- `queue_job_duration_ms` (histogram)
- `queue_jobs_total` (counter)
- `queue_depth` (observable gauge)

LLM metrics:

- `llm_tokens_used` (counter)
- `llm_request_duration_ms` (histogram)
- `llm_cost_usd` (counter)

Crawl metrics:

- `pages_processed_total` (counter)
- `page_crawl_duration_ms` (histogram)
- `entities_created_total` (counter)

Business metrics:

- `active_jobs` (observable gauge)
- `tenant_count` (observable gauge)
- `export_size_bytes` (histogram)

**Labels (attributes) on all metrics:** `{ tenantId, jobId }` where applicable.

#### 4.1.2 Request Timing Middleware

**New middleware:** `apps/api/src/middleware/timing.ts`

Wraps each request to record duration, method, route path, and status code. Tracks active connections via up-down counter.

#### 4.1.3 Prometheus Endpoint

Expose `/metrics` on a separate port (9464, default for Prometheus exporter) -- not on the main API port, to avoid auth requirements and accidental public exposure.

### 4.2 Distributed Tracing

**Problem:** Request to API to queue to worker to LLM chains are invisible. Cannot diagnose slow jobs or cross-service latency.

**Design:** OpenTelemetry tracing with context propagation through BullMQ.

#### 4.2.1 Trace Provider

**Packages:** `@opentelemetry/sdk-trace-node`, `@opentelemetry/auto-instrumentations-node`

**New file:** `packages/shared/src/tracing.ts`

Initializes `NodeTracerProvider` with `BatchSpanProcessor` exporting to OTLP endpoint. Auto-instruments HTTP (incoming + outgoing), Postgres queries, and Redis commands.

**Env var:** `OTEL_EXPORTER_ENDPOINT` -- OTLP collector URL.

#### 4.2.2 BullMQ Context Propagation

BullMQ does not natively support trace context. Propagate manually:

**Producer side (enqueue):** Inject active context into job data as `_traceContext` field.

**Consumer side (worker):** Extract parent context from `job.data._traceContext` and create child span.

This links API request traces to worker processing traces end-to-end.

### 4.3 Error Aggregation

**Problem:** Errors are only in log files. No alerting, no grouping, no trend analysis.

**Design:** Sentry integration via `@sentry/node`.

**New file:** `packages/shared/src/sentry.ts`

Initializes Sentry with DSN, environment, and configurable sample rate.

**Integration points:**

- API error handler: `Sentry.captureException(err)` for 5xx errors
- Worker error handlers: capture failed job errors with job context
- LLM client: capture unexpected response format errors

**New env vars:** `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE` (default: 0.1)

### 4.4 LLM Cost Tracking

**Problem:** OpenRouter charges per token but usage is not recorded per-tenant or per-job. Cannot price the hosted offering or detect cost anomalies.

**Design:** Instrument the `OpenRouterClient` to record token usage.

#### 4.4.1 Token Usage Recording

After each LLM call, emit a usage record containing:

- `tenantId`, `jobId`, `model`
- `promptTokens`, `completionTokens`, `totalTokens`
- `costUsd` (from OpenRouter response headers)
- `purpose` (extraction, classification, schema_evolution, reconciliation, link_evaluation)

**New table:** `llm_usage`

```sql
CREATE TABLE llm_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,  -- nullable: survives job cleanup
  model VARCHAR(100) NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd NUMERIC(10, 6) NOT NULL,
  purpose VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_llm_usage_tenant_time ON llm_usage(tenant_id, created_at DESC);
CREATE INDEX idx_llm_usage_job ON llm_usage(job_id) WHERE job_id IS NOT NULL;
```

**FK design:** `job_id` is nullable with `ON DELETE SET NULL` so LLM usage records (365-day retention) survive job deletion by the cleanup worker. `tenant_id` uses `ON DELETE CASCADE` since usage records are meaningless without a tenant. The `idx_llm_usage_job` index is partial (WHERE NOT NULL) to avoid indexing orphaned rows.

**Metrics emission:** Each usage record also increments `llm_tokens_used` and `llm_cost_usd` Prometheus counters.

#### 4.4.2 Cost API Endpoint

```
GET /api/v1/usage?period=30d
```

Returns aggregated LLM usage for the authenticated tenant:

```json
{
  "data": {
    "period": { "start": "2026-02-19T00:00:00Z", "end": "2026-03-21T00:00:00Z" },
    "totalTokens": 1250000,
    "totalCostUsd": 4.23,
    "byModel": { "anthropic/claude-3-haiku": { "tokens": 800000, "costUsd": 0.8 } },
    "byPurpose": { "extraction": { "tokens": 500000, "costUsd": 2.1 } },
    "byJob": [{ "jobId": "...", "tokens": 125000, "costUsd": 0.42 }]
  }
}
```

### 4.5 Deep Health Checks

**Problem:** `/health` returns `{ status: "ok" }` without checking DB, Redis, or queue health. Load balancers can route to unhealthy instances.

**Design:** Two health endpoints.

#### 4.5.1 Liveness Probe (`GET /health/live`)

Lightweight -- confirms the process is running and can handle HTTP:

```json
{ "status": "ok" }
```

Used by k8s `livenessProbe`. No dependency checks (avoids cascade restarts).

#### 4.5.2 Readiness Probe (`GET /health/ready`)

Checks all dependencies in parallel via `Promise.allSettled`:

- Postgres: `SELECT 1`
- Redis: `PING`
- BullMQ: `getJobCounts()`

**Response codes:**

- **200** when all checks pass: `{ "status": "ok", "checks": { "database": "ok", "redis": "ok", "queue": "ok" } }`
- **503** when any check fails: `{ "status": "degraded", "checks": { "database": "ok", "redis": "fail", "queue": "ok" } }`

The `degraded` status always maps to HTTP 503 so that load balancers and k8s readinessProbe correctly remove the instance from rotation.

Used by k8s `readinessProbe` -- removes instance from load balancer if dependencies are down.

### 4.6 Queue Dashboard

**Problem:** No visibility into queue state without Redis CLI.

**Design:** Integrate Bull Board.

**Packages:** `@bull-board/api` + `@bull-board/hono`

**Mount point:** `/api/admin/queues` (requires `admin` scope)

Registers all 6 queues (crawl, extract, schema-evolution, reconciliation, export, webhooks) with `BullMQAdapter` and mounts via `HonoAdapter`.

---

## 5. Workstream D -- Reliability & Resilience

### 5.1 Dead Letter Queue

**Problem:** Failed jobs retry 3 times (current BullMQ config), then are marked as failed and eventually removed (`removeOnFail: { count: 5000 }`). No post-mortem analysis possible after removal.

**Design:** BullMQ failed event handler + a DLQ table.

#### 5.1.1 DLQ Table

```sql
CREATE TABLE dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name VARCHAR(100) NOT NULL,
  job_id VARCHAR(255) NOT NULL,        -- BullMQ job ID
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  spatula_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,  -- survives job cleanup
  payload JSONB NOT NULL,
  error_message TEXT,
  error_stack TEXT,
  attempts INTEGER NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,            -- NULL until manually resolved
  resolution TEXT                      -- 'retried', 'discarded', 'fixed'
);
CREATE INDEX idx_dlq_unresolved ON dead_letter_queue(queue_name, failed_at DESC)
  WHERE resolved_at IS NULL;
```

**FK design:** Both `tenant_id` and `spatula_job_id` use `ON DELETE SET NULL` so that DLQ records survive job and tenant cleanup. DLQ entries contain the full `payload` JSONB, so they remain useful for post-mortem even after the source job is deleted.

#### 5.1.2 Failed Job Handler

Each BullMQ Worker gets a `failed` event handler. When `job.attemptsMade >= job.opts.attempts`, insert the job data into the DLQ table for post-mortem analysis.

#### 5.1.3 DLQ API Endpoints

```
GET    /api/v1/admin/dlq              -- list unresolved DLQ entries (paginated)
POST   /api/v1/admin/dlq/:id/retry    -- re-enqueue the original job
POST   /api/v1/admin/dlq/:id/discard  -- mark as resolved with resolution='discarded'
```

### 5.2 Circuit Breaker for LLM Calls

**Problem:** When OpenRouter is degraded, all workers block on retry loops simultaneously, saturating connections and delaying all jobs.

**Design:** Circuit breaker pattern wrapping `OpenRouterClient`.

#### 5.2.1 Circuit Breaker Implementation

**New file:** `packages/core/src/llm/circuit-breaker.ts`

**States:** `CLOSED` (normal) -> `OPEN` (failing, reject all) -> `HALF_OPEN` (testing recovery)

**Configuration:**

- `failureThreshold`: Failures before opening (default: 5)
- `resetTimeoutMs`: Time in OPEN before trying HALF_OPEN (default: 30,000)
- `halfOpenMaxAttempts`: Successful calls needed to close (default: 2)

**Behavior:**

- `CLOSED`: Passes calls through. Counts consecutive failures. Opens after `failureThreshold` consecutive failures.
- `OPEN`: Immediately rejects with `LLMError('Circuit breaker open', { retryable: true })`. After `resetTimeoutMs`, transitions to HALF_OPEN.
- `HALF_OPEN`: Allows `halfOpenMaxAttempts` calls through. If all succeed, closes. If any fail, re-opens.

**Wrapping:** `CircuitBreakerLLMClient` implements `LLMClient` interface, delegates to inner client through the breaker.

**Multi-process note:** This is a per-process circuit breaker. In a multi-worker deployment, each process tracks its own failure count independently. This is acceptable because: (a) each worker has its own connection to OpenRouter and may experience failures independently, and (b) a Redis-backed shared breaker would add latency to every LLM call. If all workers hit the same OpenRouter outage, they will each trip independently within `failureThreshold` calls.

**Metrics:** Emits `circuit_breaker_state` gauge and `circuit_breaker_rejections_total` counter.

### 5.3 Queue-Level Retry with Backoff

**Current state:** BullMQ jobs are configured with `attempts: 3, backoff: { type: 'exponential', delay: 2000 }` in `DEFAULT_JOB_OPTIONS`. This is correct.

**Enhancement:** Make retry behavior per-queue, with different strategies for different failure modes:

- Crawl queue: 3 attempts, exponential backoff starting at 5s (crawl failures often transient)
- Schema evolution queue: 2 attempts, fixed 10s delay (lock contention: flat retry)
- Export queue: 2 attempts, exponential backoff starting at 3s

### 5.4 Idempotency Keys

**Problem:** Retried API requests (e.g., network timeout on `POST /api/v1/exports`) can create duplicates.

**Design:** Optional `Idempotency-Key` header for mutating endpoints.

#### 5.4.1 Idempotency Store

Redis-based with 24-hour TTL.

**Key:** `idempotency:{tenantId}:{key}`
**Value:** `{ statusCode, body, createdAt }`
**TTL:** 86400 seconds (24 hours)

#### 5.4.2 Idempotency Middleware

For non-GET requests with an `Idempotency-Key` header:

1. Check Redis for cached response
2. If found, return cached response (same status code + body)
3. If not found, proceed with request, then cache the response

**Applied to:** `POST` and `PATCH` routes only.

### 5.5 Worker Health Monitoring

**Problem:** If a worker process crashes silently, no one knows until jobs stop processing.

**Design:** Worker heartbeat via Redis.

Each worker writes a heartbeat every 30s:

- Key: `worker:heartbeat:{workerId}`
- Value: `{ workerId, queues, pid, uptime, activeJobs }`
- TTL: 60s

**Health check endpoint (`GET /api/v1/admin/workers`):**
Scans `worker:heartbeat:*` keys. Workers missing heartbeat for >60s are flagged as unhealthy.

---

## 6. Workstream E -- Performance & Scalability

### 6.1 S3/R2 Content Store

**Problem:** Content store is Postgres-backed (text + binary columns). Large exports stored as BLOBs in Postgres cause table bloat, slow backups, and limit practical export size.

**Design:** Pluggable `S3ContentStore` implementing the existing `ContentStore` interface.

#### 6.1.1 Implementation

**New file:** `packages/core/src/content-store/s3-content-store.ts`

Implements all 5 methods of the `ContentStore` interface:

- `store(key, content)` -- uploads text to `text/{key}`
- `storeBinary(key, data)` -- uploads binary to `binary/{key}`
- `retrieve(ref)` -- downloads text content
- `retrieveBinary(ref)` -- downloads binary content
- `delete(ref)` -- removes object

**Package:** `@aws-sdk/client-s3` (lightweight, does not pull in full AWS SDK).

**Compatible with:** AWS S3, Cloudflare R2, MinIO, any S3-compatible store.

#### 6.1.2 Configuration

**New env vars:**

- `CONTENT_STORE` -- `postgres` (default) or `s3`
- `S3_BUCKET` -- bucket name
- `S3_REGION` -- AWS region
- `S3_ENDPOINT` -- for R2/MinIO
- `S3_ACCESS_KEY_ID` -- credentials
- `S3_SECRET_ACCESS_KEY` -- credentials

**Factory function:** `createContentStore(config)` returns the appropriate implementation based on `CONTENT_STORE` env var.

#### 6.1.3 Presigned Download URLs

For large exports, avoid proxying through the API.

**Interface extension:** Add an optional `getDownloadUrl` method to the `ContentStore` interface:

```typescript
interface ContentStore {
  store(key: string, content: string): Promise<string>;
  retrieve(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
  storeBinary(key: string, data: Uint8Array): Promise<string>;
  retrieveBinary(ref: string): Promise<Uint8Array | null>;
  getDownloadUrl?(ref: string, expiresInSeconds?: number): Promise<string>; // NEW, optional
}
```

`S3ContentStore` implements `getDownloadUrl` using `@aws-sdk/s3-request-presigner`. `PgContentStore` does not implement it (method is optional on the interface).

**Type guard for the export download endpoint:**

```typescript
function supportsPresignedUrls(store: ContentStore): store is ContentStore & {
  getDownloadUrl: (ref: string, expiresIn?: number) => Promise<string>;
} {
  return typeof (store as any).getDownloadUrl === 'function';
}
```

**Export download endpoint:** If `supportsPresignedUrls(contentStore)`, return a 302 redirect to the presigned URL. Otherwise, stream through the API as before. This preserves the interface-driven design without `instanceof` checks.

### 6.2 Streaming Exports

**Problem:** Export worker loads all entities into memory, runs the exporter, then stores the result. For 50k entities with complex schemas, this can OOM.

**Design:** Stream-based export pipeline for JSON and CSV. Binary formats (Parquet, SQLite, DuckDB) continue to materialize in-memory but with chunked entity fetching.

#### 6.2.1 Streaming JSON/CSV Exporters

New `StreamingJsonExporter` and `StreamingCsvExporter` that accept `AsyncIterable<Entity[]>` (batched entity stream) and produce `ReadableStream<Uint8Array>`.

#### 6.2.2 Entity Cursor

Replace offset-based entity fetching in export worker with a cursor-based async generator:

```typescript
async function* fetchEntitiesCursor(
  entityRepo: EntityRepository,
  jobId: string,
  tenantId: string,
  batchSize = 500,
): AsyncIterable<Entity[]> {
  let cursor: string | undefined;
  while (true) {
    const batch = await entityRepo.findByJobCursor(jobId, tenantId, batchSize, cursor);
    if (batch.entities.length === 0) break;
    yield batch.entities;
    cursor = batch.nextCursor;
  }
}
```

**New repository method:** `EntityRepository.findByJobCursor(jobId, tenantId, limit, cursor?)` using keyset pagination (`WHERE id > cursor ORDER BY id LIMIT batch`).

### 6.3 Database Indexing Strategy

**Problem:** Drizzle migrations create tables with PKs and FKs, but no explicit indexes for common query patterns.

**Design:** Add indexes for every frequently-queried path.

**New migration with the following indexes.**

Note: Several indexes already exist in the Drizzle schema from earlier phases (`crawl_tasks_job_status_idx`, `crawl_tasks_job_depth_idx`, `actions_job_status_idx`, `jobs_tenant_status_idx`, `jobs_tenant_created_idx`, `raw_pages_content_hash_idx`, `entities_job_quality_idx`). The migration must use `CREATE INDEX IF NOT EXISTS` for all indexes, and only the **truly new** indexes are listed here:

```sql
-- Entity queries: tenant-scoped lookups (new — existing index covers job_id+quality but not tenant_id)
CREATE INDEX IF NOT EXISTS idx_entities_job_tenant ON entities(job_id, tenant_id);

-- Extraction queries (new)
CREATE INDEX IF NOT EXISTS idx_extractions_job ON extractions(job_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_extractions_page ON extractions(page_id);

-- Export queries (new)
CREATE INDEX IF NOT EXISTS idx_exports_job ON exports(job_id, tenant_id);

-- Content store lookups (new)
CREATE INDEX IF NOT EXISTS idx_content_store_key ON content_store(key);
```

The following indexes already exist in the Drizzle schema and do NOT need to be re-created:

- `crawl_tasks_job_status_idx` on `crawl_tasks(job_id, status)`
- `crawl_tasks_job_depth_idx` on `crawl_tasks(job_id, depth)`
- `actions_job_status_idx` on `actions(job_id, status)`
- `jobs_tenant_status_idx` on `jobs(tenant_id, status)`
- `jobs_tenant_created_idx` on `jobs(tenant_id, created_at DESC)`
- `raw_pages_content_hash_idx` on `pages(content_hash)`
- `entities_job_quality_idx` on `entities(job_id, quality_score)`

### 6.4 Redis Caching Layer

**Problem:** Every API request hits Postgres directly, even for data that changes infrequently (schemas, job configs).

**Design:** Read-through cache for hot paths.

**New file:** `packages/db/src/cache.ts`

`RedisCache` class with `getOrFetch<T>(key, fetcher, ttlSeconds)` and `invalidate(pattern)` methods.

**Cached paths:**

| Key Pattern                | TTL  | Invalidated On   |
| -------------------------- | ---- | ---------------- |
| `schema:{jobId}:current`   | 30s  | Schema evolution |
| `job:{jobId}:config`       | 60s  | Job update       |
| `tenant:{tenantId}:quotas` | 300s | Tenant update    |
| `entity-count:{jobId}`     | 10s  | Entity creation  |

### 6.5 Cursor-Based Pagination

**Problem:** Offset pagination degrades on large datasets. `OFFSET 10000` requires scanning 10,000 rows to skip.

**Design:** Support both offset (backwards-compatible) and cursor pagination.

**Query parameter:** `?cursor=<opaque>` (base64-encoded `{id, sortValue}`)

**Tiebreaker requirement:** Cursor pagination must always include `id` as a secondary sort to ensure stable ordering. For example, entity listing sorted by `quality_score DESC` must use `ORDER BY quality_score DESC, id ASC` with cursor condition `WHERE (quality_score, id) < (:cursorScore, :cursorId)`. The existing `entities_job_quality_idx` on `(job_id, quality_score)` should be extended to `(job_id, quality_score DESC, id ASC)` for efficient keyset queries.

**Response envelope extension:**

```json
{
  "data": [],
  "pagination": {
    "total": 15234,
    "limit": 50,
    "hasMore": true,
    "nextCursor": "eyJpZCI6Ijk4NzYiLCJzb3J0IjoiMjAyNi0wMy0yMSJ9"
  }
}
```

**Incremental fetch parameter:** Add an optional `since` query parameter (ISO 8601 timestamp) that filters to records created or updated after the given time. This enables Phase 13's incremental pull flow, where only new entities since the last pull are fetched:

```
GET /api/v1/jobs/:id/entities?cursor=<opaque>&limit=100&since=2026-03-21T14:32:00Z
```

**Applied to:** `/entities`, `/extractions`, `/actions`, `/exports`

---

## 7. Workstream F -- Data Pipeline Hardening

### 7.1 robots.txt Compliance

**Problem:** Crawlers do not check robots.txt. This is a legal/ethical risk and can get the platform blocked by target sites.

**Design:** Per-domain robots.txt fetching and caching, integrated into the crawl workflow.

#### 7.1.1 Robots.txt Checker

**New file:** `packages/core/src/crawlers/robots-txt.ts`

**Library:** `robots-parser` (lightweight, well-tested).

`RobotsTxtChecker` class with:

- `isAllowed(url, userAgent)` -- fetches and caches robots.txt per origin (1-hour cache), returns boolean
- `getCrawlDelay(origin, userAgent)` -- returns Crawl-Delay value if specified

User agent: `SpatulaBot/1.0`

#### 7.1.2 Crawler Integration

**CrawlOptions extension:** Add `respectRobotsTxt: z.boolean().default(true)` to the existing `CrawlOptions` schema.

**Crawl worker check:** Before crawling each URL, check `robotsChecker.isAllowed(url)`. If blocked, mark task as `skipped` and return.

#### 7.1.3 CrawlTask Status Usage

The `crawl_task_status` enum already includes `skipped` (added in Phase 11). Use this existing status for robots.txt-blocked URLs and maxPages-limited URLs. No migration needed for this.

### 7.2 Crawl Budget Enforcement (maxPages)

**Problem:** `maxPages` is defined in `JobConfig.crawl.maxPages` but never enforced at crawl-worker level. A job can crawl indefinitely within `maxDepth`.

**Design:** Atomic page counter in Redis, checked before each crawl.

**Implementation in crawl-worker:**

1. `INCR` the key `job:{jobId}:page-count`
2. If count exceeds `config.crawl.maxPages`, decrement (rollback), mark task as `skipped`, return
3. Set 7-day TTL on first use (cleanup after job completes)

**Why Redis, not Postgres?** Multiple crawl workers run concurrently. Redis `INCR` is atomic and lock-free -- Postgres would require `SELECT FOR UPDATE` or advisory locks.

### 7.3 Per-Domain Politeness

**Problem:** No per-domain request throttling. Rapid crawling can overwhelm target sites and trigger IP blocks.

**Design:** Domain-level rate limiting in the crawl worker.

#### 7.3.1 Domain Rate Limiter

**New file:** `packages/core/src/crawlers/domain-rate-limiter.ts`

`DomainRateLimiter` class backed by Redis. Uses `SETEX` with domain key to enforce minimum delay between requests to the same domain.

Default delay: 1 request/second per domain. Respects `Crawl-Delay` from robots.txt if available.

**Configuration:** `CRAWL_DEFAULT_DELAY_MS` env var (default: 1000).

#### 7.3.2 Integration

Crawl worker calls `domainRateLimiter.waitForSlot(url, crawlDelay)` before each request. This awaits until the domain slot is available, ensuring politeness.

### 7.4 Crawl Completion Heuristic

**Problem:** No automatic detection of "we have crawled everything relevant." Jobs require manual stop or hit maxPages/maxDepth.

**Design:** Heuristic-based completion detection in the crawl worker.

#### 7.4.1 Completion Signals

A job is considered "naturally complete" when ALL of these hold:

1. **No pending crawl tasks** -- all enqueued tasks are completed, skipped, or failed
2. **No in-progress crawl tasks** -- no active workers processing for this job (accounting for the current task being the last one)

#### 7.4.2 Completion Check

After each crawl task completes, query `taskRepo.getJobStats(jobId)` for counts by status. If `pending === 0` and `inProgress <= 1` (current task is the last), trigger auto-reconciliation via `jobManager.triggerReconciliation(jobId, tenantId)`.

### 7.5 Data Quality Score Aggregation

**Problem:** Individual entities have `qualityScore` but there is no job-level quality overview.

**Design:** Computed on-demand via SQL aggregation.

**New endpoint:** `GET /api/v1/jobs/:id/quality`

Returns:

- `entityCount`, `averageQuality`
- `distribution` (excellent >= 0.9, good >= 0.7, fair >= 0.5, poor < 0.5)
- `fieldCompleteness` (per-field fill rate)

**Implementation:** Single SQL query with `avg()`, `count() FILTER (WHERE ...)`, and per-field JSON aggregation. No materialized table needed.

### 7.6 Confidence-Based Export Filtering

**Problem:** Cannot filter exports to "only high-quality entities."

**Design:** Add optional parameters to export creation:

- `minQuality: z.number().min(0).max(1).optional()` -- minimum quality score filter
- `fields: z.array(z.string()).optional()` -- subset of fields to include

**Export worker:** Adds `WHERE quality_score >= :minQuality` to entity query when provided.

---

## 8. Workstream G -- API & CLI Completeness

### 8.1 Webhook Support

**Problem:** Clients must poll or maintain WebSocket connections to know when jobs complete.

**Design:** Configurable webhook URLs per job.

#### 8.1.1 Webhook Configuration

Extend `JobConfig` with optional `webhooks` field:

- `url` -- webhook endpoint (required URL)
- `secret` -- HMAC signing secret (optional, min 16 chars)
- `events` -- array of event types to subscribe to (default: `['job.completed', 'job.failed']`)

Available events: `job.completed`, `job.failed`, `job.cancelled`, `export.completed`, `action.pending`

#### 8.1.2 Webhook Delivery

**New file:** `packages/queue/src/webhook-sender.ts`

`WebhookSender` class that:

1. Serializes the event as JSON
2. Signs with HMAC-SHA256 if secret provided (sets `X-Spatula-Signature` header)
3. POSTs to the webhook URL with 10s timeout
4. On failure, retries up to 3 times with exponential backoff (1min, 5min, 30min) via a dedicated `spatula.webhooks` BullMQ queue

**Delivery guarantee:** At-least-once.

**Queue wiring:** Add `WEBHOOK: 'spatula.webhooks'` to `QUEUE_NAMES` in `packages/queue/src/queues.ts`. Update `createQueues()` and `SpatulaQueues` interface to include the webhook queue. Add a webhook worker to `worker-entrypoint.ts`. Update Bull Board registration (section 4.6) to include all 6 queues.

#### 8.1.3 Webhook Event Payload

```json
{
  "id": "evt_abc123",
  "type": "job.completed",
  "timestamp": "2026-03-21T12:00:00Z",
  "data": {
    "jobId": "...",
    "tenantId": "...",
    "status": "completed",
    "entityCount": 1523,
    "duration": 3600
  }
}
```

### 8.2 Bulk Operations

**Design:** Add batch endpoints for common operations.

```
POST /api/v1/actions/batch     -- { action: 'approve'|'reject', ids: string[] }
POST /api/v1/jobs/batch        -- { action: 'cancel'|'delete', ids: string[] }
```

**Limits:** Max 100 items per batch. Returns per-item results with partial success support:

```json
{
  "data": {
    "succeeded": ["id1", "id2"],
    "failed": [{ "id": "id3", "error": "Job not found" }]
  }
}
```

### 8.3 CLI Setup Wizard (`spatula init`)

> **Status: Completed in Wave 2** — Phase 13 Step 3 (Config System) implemented `spatula init` as part of the local project-folder model.

**Deferred to Phase 13.** Phase 13 introduces a comprehensive project-folder model where `spatula init` creates a `spatula.yaml` project file and `~/.spatula/config.yaml` global config through an interactive wizard. Building a separate server-setup wizard here would be immediately replaced.

For the Phase 12 open-source release, server setup is documented in the README quickstart (Workstream H, section 9.2): copy `.env.example`, configure, `docker-compose up`, run migrations. This is standard for self-hosted open-source projects.

### 8.4 CLI Diagnostics (`spatula doctor`)

**New command:** `apps/cli/src/commands/doctor.ts`

**Checks:**

1. `.env` exists and has required keys
2. Postgres is reachable (connection test)
3. Redis is reachable (PING)
4. API server is reachable (`GET /health/ready`)
5. Migrations are up to date (compare applied vs available)
6. Node.js version >= 22
7. Docker is available (for local dev)
8. LLM provider reachable (Ollama: `GET /api/tags`, OpenRouter: key validation)
9. Playwright browsers installed (if configured as default crawler)

Outputs pass/fail per check with clear status indicators.

**Designed for extension:** The doctor command uses a pluggable check registry:

```typescript
interface HealthCheck {
  name: string;
  category: 'system' | 'server' | 'project';
  run(): Promise<{ status: 'pass' | 'fail' | 'warn'; message: string }>;
}
```

Phase 12 registers `system` and `server` checks. Phase 13 adds `project` checks (SQLite integrity, orphaned tasks, missing page files, pending review actions) without modifying the Phase 12 code. The doctor command runs all registered checks for applicable categories based on context (always runs `system`, runs `server` if `.env` exists, runs `project` if `spatula.yaml` exists).

### 8.5 Config File Support

> **Status: Completed in Wave 2** — Phase 13 Step 3 (Config System) implemented `spatula.yaml` as the project configuration format.

**Deferred to Phase 13.** Phase 13 introduces `spatula.yaml` as the primary project configuration format with user-friendly field names (`depth` instead of `crawl.maxDepth`, field shorthand syntax). Building a separate YAML format here that uses internal `JobConfig` names would create two competing formats. The Phase 13 `spatula.yaml` format subsumes this feature — projects can be pushed to the hosted server via `spatula push`.

### 8.6 API Request Timeout

**Problem:** Long-running DB queries or hung connections block indefinitely.

**Design:** Hono middleware with configurable request timeout.

**Default:** 30 seconds. Export download endpoint gets a longer timeout (5 minutes). Returns 504 on timeout.

---

## 9. Workstream H -- Open-Source Readiness

### 9.1 License

**Decision:** MIT License.

**Rationale:** Maximum adoption for the open-source core. The hosted offering differentiates via managed infrastructure, not licensing restrictions. MIT is the most permissive widely-recognized license, encouraging both individual and corporate adoption.

**File:** `LICENSE` in project root.

### 9.2 README

**File:** `README.md` in project root.

**Sections:**

1. **Hero** -- one-line description + badge row (CI, license, npm version)
2. **What is Spatula?** -- 3-sentence elevator pitch
3. **Features** -- bullet list of core capabilities
4. **Quickstart** -- 5-step setup (prerequisites, clone, init, start, first crawl)
5. **Architecture Overview** -- Mermaid diagram showing packages, data flow
6. **Configuration** -- table of env vars with descriptions and defaults
7. **CLI Usage** -- command reference with examples
8. **API Reference** -- link to Swagger UI (`/api/docs`)
9. **Export Formats** -- table of supported formats with features
10. **Development** -- how to run tests, lint, build
11. **Contributing** -- link to CONTRIBUTING.md
12. **License** -- MIT

### 9.3 CONTRIBUTING.md

**Sections:**

1. **Getting Started** -- fork, clone, install, run tests
2. **Development Workflow** -- branch naming, commit conventions (conventional commits)
3. **Code Style** -- refer to eslint + prettier configs
4. **Testing** -- where to add tests, how to run unit/e2e
5. **Pull Request Process** -- PR template, required checks, review process
6. **Architecture Guide** -- link to design doc, explain package boundaries
7. **Reporting Issues** -- bug report template, feature request template

### 9.4 CHANGELOG

**Strategy:** Auto-generated from conventional commits using `release-please` (Google's release automation, well-suited for monorepos with conventional commit messages).

**Workflow:** `release-please` GitHub Action runs on push to `main`, creates/updates a release PR with changelog entries, and publishes a GitHub Release when merged. Integrates with the existing release workflow (section 2.1.2).

### 9.5 GitHub Issue & PR Templates

**Files:**

- `.github/ISSUE_TEMPLATE/bug_report.md` -- steps to reproduce, expected vs actual
- `.github/ISSUE_TEMPLATE/feature_request.md` -- use case, proposed solution
- `.github/PULL_REQUEST_TEMPLATE.md` -- checklist (tests, lint, docs)

### 9.6 Architecture Documentation

**File:** `docs/architecture.md`

**Contents:**

- Package dependency diagram (Mermaid)
- Data flow diagram: seed URL to crawl to extract to evolve schema to reconcile to export
- Interface map: which interfaces exist and who implements them
- Action type taxonomy: pipeline vs config actions
- LLM usage map: where AI is called and which model tier

### 9.7 Example Configurations

**Directory:** `examples/`

```
examples/
  quickstart/
    spatula.yaml              -- simple single-site crawl
    docker-compose.yml    -- self-contained with all services
  ecommerce/
    spatula.yaml              -- multi-site product catalog
  news/
    spatula.yaml              -- news article aggregation
  real-estate/
    spatula.yaml              -- property listing extraction
```

Each example includes a `README.md` with expected output and explanation.

---

## 10. Workstream I -- Hosted Platform Layer

### 10.1 User Management

**Problem:** No signup, login, or user lifecycle for the hosted offering.

**Design:** Delegate to a managed auth provider (Supabase Auth, Auth0, or Clerk) rather than building custom auth.

#### 10.1.1 Auth Provider Integration

The hosted frontend (web app, out of scope for this spec) handles:

- Signup/login UI
- Password reset
- Email verification
- SSO (Google, GitHub)

The API only validates JWTs via the JWT strategy from section 3.1.3 -- it does not manage users directly.

#### 10.1.2 User-Tenant Mapping

**New table:** `user_tenants`

```sql
CREATE TABLE user_tenants (
  user_id TEXT NOT NULL,            -- From auth provider (sub claim)
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  role VARCHAR(20) NOT NULL DEFAULT 'member',  -- 'owner', 'admin', 'member'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX idx_user_tenants_user ON user_tenants(user_id);
```

**JWT tenant resolution:** On login, look up user's tenants. If single tenant, auto-select. If multiple, include in token or let user choose.

### 10.2 Billing & Usage Metering

**Problem:** Cannot charge customers without tracking usage.

**Design:** Stripe integration with usage-based billing.

#### 10.2.1 Billing Model

| Dimension        | Free      | Starter | Pro       | Enterprise |
| ---------------- | --------- | ------- | --------- | ---------- |
| Jobs/month       | 5         | 50      | 500       | Unlimited  |
| Pages/month      | 1,000     | 10,000  | 100,000   | Custom     |
| LLM tokens/month | 100K      | 1M      | 10M       | Custom     |
| Storage          | 100MB     | 1GB     | 10GB      | Custom     |
| Export formats   | JSON, CSV | All     | All       | All        |
| API rate limit   | 60/min    | 300/min | 1,500/min | Custom     |
| Support          | Community | Email   | Priority  | Dedicated  |

#### 10.2.2 Metering Infrastructure

**Package:** `stripe` npm package.

Usage events reported to Stripe via `subscriptionItems.createUsageRecord`.

**Reporting frequency:** Hourly aggregation via a cron job (BullMQ repeatable job).

**Local metering table:** `usage_records`

```sql
CREATE TABLE usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dimension VARCHAR(50) NOT NULL,    -- 'pages', 'llm_tokens', 'storage_bytes', 'jobs'
  quantity BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  reported_to_stripe BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_tenant_period ON usage_records(tenant_id, period_start, dimension);
```

**FK design:** `ON DELETE CASCADE` -- if a tenant is deleted, their usage records are deleted with them. Usage data is not useful without a tenant context.

#### 10.2.3 Billing Endpoints

```
GET  /api/v1/billing/subscription    -- current plan, usage, limits
GET  /api/v1/billing/invoices        -- past invoices (from Stripe)
POST /api/v1/billing/portal          -- redirect to Stripe Customer Portal
```

#### 10.2.4 Quota Enforcement

Before job start, check usage against plan limits. Throw `ValidationError` with code `QUOTA_EXCEEDED` if any dimension exceeds the plan.

### 10.3 Admin Panel

**Problem:** No way for platform operators to manage tenants, view system health, or intervene in stuck jobs.

**Design:** Admin API endpoints (admin web UI is out of scope for this spec -- can be built with any frontend framework consuming these endpoints).

#### 10.3.1 Admin API Routes

All prefixed with `/api/v1/admin/` and require `admin` scope.

```
GET    /admin/tenants               -- list all tenants with usage stats
GET    /admin/tenants/:id           -- tenant detail with quota usage
PATCH  /admin/tenants/:id           -- update quotas, plan, status
GET    /admin/jobs                  -- list all jobs across tenants
POST   /admin/jobs/:id/force-cancel -- force-cancel stuck job
GET    /admin/system/health         -- detailed system health
GET    /admin/system/metrics        -- key metrics summary
GET    /admin/dlq                   -- dead letter queue (section 5.1.3)
GET    /admin/workers               -- worker health (section 5.5)
```

### 10.4 Data Retention & Cleanup

**Problem:** Old jobs, pages, entities, and content accumulate forever. No TTL, no archival.

**Design:** Configurable retention policies with automated cleanup.

#### 10.4.1 Retention Policy

**Default retention periods:**

| Data Type                 | Default Retention | Configurable Per-Tenant |
| ------------------------- | ----------------- | ----------------------- |
| Completed jobs + entities | 90 days           | Yes                     |
| Failed jobs               | 30 days           | Yes                     |
| Raw pages                 | 30 days           | Yes                     |
| Exports                   | 30 days           | Yes                     |
| Audit logs                | 365 days          | No                      |
| LLM usage records         | 365 days          | No                      |
| DLQ entries               | 90 days           | No                      |

#### 10.4.2 Cleanup Worker

**New repeatable BullMQ job:** Runs daily at 03:00 UTC.

For each tenant:

1. Delete completed jobs older than retention period (cascades to entities, extractions, pages, exports)
2. Delete content store entries not referenced by any active export
3. Log cleanup statistics

**Safety:** Cleanup runs in batches (100 records per delete) to avoid long-running transactions.

**FK ordering:** The cleanup worker must account for new Phase 12 tables that reference `jobs`:

- `llm_usage.job_id` uses `ON DELETE SET NULL` -- handled automatically by Postgres
- `dead_letter_queue.spatula_job_id` uses `ON DELETE SET NULL` -- handled automatically by Postgres
- `audit_log.tenant_id` uses nullable reference -- no job FK, no conflict

No explicit pre-deletion step is needed because all new job-referencing FKs use `ON DELETE SET NULL`. The existing `deleteWithData()` cascade path in `JobRepository` will work without modification.

#### 10.4.3 Tenant Configuration Extension

Extend tenant config with optional `retention` object:

- `completedJobsDays` (min: 7, default: 90)
- `failedJobsDays` (min: 7, default: 30)
- `rawPagesDays` (min: 7, default: 30)
- `exportsDays` (min: 7, default: 30)

---

## 11. Workstream J -- Local Developer Experience

### 11.1 Overview

The platform's crawl/scrape pipeline has infrastructure and cost barriers that create friction for local open-source users. Every crawl currently requires an OpenRouter API key (paid), and the crawler options are either Playwright (400MB+ browser download) or Firecrawl (paid API key). There is no way to test extraction on a single page without starting a full job, and no visibility into costs before committing to a crawl.

This workstream adds four features that make the local developer experience dramatically smoother.

### 11.2 Local LLM Support (Ollama)

**Problem:** `OPENROUTER_API_KEY` is a hard requirement. Every crawl incurs per-token costs via OpenRouter. Developers experimenting with Spatula must sign up for a paid service before they can extract a single field.

**Design:** Add Ollama as an alternative LLM provider, enabling fully local, free, offline LLM-powered extraction.

#### 11.2.1 Ollama Client

**New file:** `packages/core/src/llm/ollama-client.ts`

The existing `LLMClient` interface is provider-agnostic:

```typescript
interface LLMClient {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}
```

`OllamaClient` implements this interface by calling Ollama's REST API:

```typescript
export class OllamaClient implements LLMClient {
  constructor(private options: OllamaClientOptions) {}

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const response = await fetch(`${this.options.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
        options: {
          temperature: request.temperature ?? 0.1,
          num_predict: request.maxTokens ?? 4096,
        },
        format: request.jsonMode ? 'json' : undefined,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    });

    if (!response.ok) {
      throw new LLMError(`Ollama request failed: ${response.status}`, {
        context: { status: response.status, model: request.model },
      });
    }

    const data = await response.json();
    return {
      content: data.message.content,
      model: data.model,
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      finishReason: data.done ? 'stop' : 'length',
    };
  }
}
```

**Types:**

```typescript
interface OllamaClientOptions {
  baseUrl: string; // Default: 'http://localhost:11434'
  timeoutMs?: number; // Default: 120000 (local models are slower)
}
```

**No retries:** Ollama runs locally -- network errors mean the server is down, not transient. Fail immediately with a clear error message rather than retrying.

#### 11.2.2 LLM Provider Factory

**New file:** `packages/core/src/llm/llm-factory.ts`

```typescript
export function createLLMClient(config: AppConfig): LLMClient {
  const provider = config.llm.provider;

  switch (provider) {
    case 'openrouter':
      return new OpenRouterClient({
        apiKey: config.openrouter.apiKey,
        baseUrl: config.openrouter.baseUrl,
      });

    case 'ollama':
      return new OllamaClient({
        baseUrl: config.llm.ollamaBaseUrl ?? 'http://localhost:11434',
        timeoutMs: config.llm.ollamaTimeoutMs,
      });

    default:
      throw new ConfigError(`Unknown LLM provider: ${provider}`);
  }
}
```

#### 11.2.3 Model Tier Mapping

The `resolveModel()` function in `model-router.ts` maps `LLMTask` to a model string. With Ollama, the user specifies a single model (most local setups run one model at a time), and the router uses it for all tiers:

```typescript
// When LLM_PROVIDER=ollama, all tasks use the configured model
// (no tier differentiation — local models are typically one-size)
export function resolveModel(config: LLMConfig, task: LLMTask): string {
  const override = config.modelOverrides?.[task];
  return override ?? config.primaryModel;
}
```

No change to `resolveModel` is needed -- the user sets `LLM_PRIMARY_MODEL=llama3.2` and all tasks use it. Task-specific overrides still work if the user runs multiple Ollama models.

**Recommended local models:**

| Use Case             | Model         | Size | Quality                            |
| -------------------- | ------------- | ---- | ---------------------------------- |
| Fast experimentation | `llama3.2:3b` | 2GB  | Good for classification, link eval |
| Balanced             | `llama3.2:8b` | 5GB  | Good for extraction                |
| Best local quality   | `qwen2.5:32b` | 18GB | Approaches cloud quality           |

#### 11.2.4 Configuration

**New env vars:**

| Variable            | Default                              | Required  | Notes                              |
| ------------------- | ------------------------------------ | --------- | ---------------------------------- |
| `LLM_PROVIDER`      | `openrouter`                         | No        | `openrouter` or `ollama`           |
| `OLLAMA_BASE_URL`   | `http://localhost:11434`             | If ollama | Ollama server address              |
| `OLLAMA_TIMEOUT_MS` | `120000`                             | No        | Higher default for local inference |
| `LLM_PRIMARY_MODEL` | `anthropic/claude-sonnet-4-20250514` | No        | Overrides `LLMConfig.primaryModel` |

**Validation:**

- When `LLM_PROVIDER=openrouter`: `OPENROUTER_API_KEY` is required (existing behavior)
- When `LLM_PROVIDER=ollama`: `OPENROUTER_API_KEY` is not required. On startup, the factory verifies Ollama is reachable (`GET /api/tags`) and the configured model is available, throwing `ConfigError` with actionable message if not:

```
ConfigError: Ollama model 'llama3.2' not found.
Available models: mistral:7b, codellama:13b
Run: ollama pull llama3.2
```

#### 11.2.5 Quality Expectations

Local LLMs produce lower-quality extractions than cloud models. The spec does not attempt to paper over this -- instead, the CLI should surface it clearly:

- On job start with `LLM_PROVIDER=ollama`, log: `Using local LLM (llama3.2). Extraction quality may be lower than cloud models.`
- The `spatula doctor` command (section 8.4) should check Ollama availability when `LLM_PROVIDER=ollama` and report the model size

### 11.3 Single-Page Test Command

**Problem:** Developers iterating on extraction schemas must create a full job (tenant, queue, workers, DB) to see results from a single URL. The feedback loop is measured in minutes, not seconds.

**Design:** A `spatula test` command that runs a single-page crawl + extraction inline, bypassing the entire queue/worker/database pipeline.

#### 11.3.1 Command Interface

```bash
spatula test <url> [options]

Options:
  --schema <path>       Path to schema YAML/JSON file (optional)
  --crawler <type>      Crawler type: playwright, firecrawl, http (default: playwright)
  --format <type>       Output format: json, table, raw (default: table)
  --show-html           Print preprocessed HTML instead of extraction
  --show-links          Print evaluated links with relevance scores
  --model <model>       Override LLM model for this test
  --no-llm              Skip LLM extraction, use static extractor only
```

**New file:** `apps/cli/src/commands/test.ts`

#### 11.3.2 Execution Flow

The test command runs entirely in-process. No API server, no Redis, no queue, no database:

```
1. Create LLM client (from env: OpenRouter or Ollama)
2. Create crawler (from --crawler flag or config)
3. Crawl the single URL
4. Preprocess HTML (cheerio-based, same as production)
5. Classify page type (via LLM, unless --no-llm)
6. If schema provided:
   a. Extract fields using schema (via LLM or static extractor)
   b. Display extracted data
7. If no schema provided:
   a. LLM discovers fields automatically (schema=discovery mode)
   b. Display discovered schema + extracted data
8. If --show-links: evaluate and display scored links
9. Close crawler, exit
```

**Key design principle:** Reuse the exact same core library functions (`htmlPreprocessor`, `pageClassifier`, `staticExtractor`, `schemaToPrompt`) that the production pipeline uses. The test command is not a separate extraction engine -- it's the same engine without the orchestration layer.

#### 11.3.3 Output Formats

**Table format (default):**

```
  Spatula Test: https://example.com/product/xm5
  ──────────────────────────────────────────────
  Crawled in 1.2s (45KB, text/html)
  Classification: product_page (0.94)
  Model: llama3.2:8b via Ollama

  Extracted Fields
  ┌─────────────┬──────────────────────────────┬────────────┐
  │ Field       │ Value                        │ Confidence │
  ├─────────────┼──────────────────────────────┼────────────┤
  │ title       │ Sony WH-1000XM5              │ 0.98       │
  │ price       │ $348.00                      │ 0.95       │
  │ description │ Industry-leading noise ca... │ 0.91       │
  │ rating      │ 4.7                          │ 0.88       │
  │ image_url   │ https://example.com/img/x... │ 0.97       │
  └─────────────┴──────────────────────────────┴────────────┘

  Unmapped Content (potential fields)
   • "In stock" → availability (string)
   • "Free shipping over $50" → shipping_info (string)
```

**JSON format (`--format json`):** Machine-readable output for piping to `jq` or scripts:

```json
{
  "url": "https://example.com/product/xm5",
  "crawl": { "statusCode": 200, "responseTimeMs": 1200, "contentLength": 45000 },
  "classification": { "type": "product_page", "confidence": 0.94 },
  "extraction": {
    "fields": { "title": "Sony WH-1000XM5", "price": "$348.00" },
    "confidence": { "title": 0.98, "price": 0.95 },
    "unmapped": [{ "text": "In stock", "suggestedField": "availability" }]
  },
  "model": { "provider": "ollama", "model": "llama3.2:8b" }
}
```

**Raw format (`--show-html`):** Prints the preprocessed HTML (after cheerio cleanup) for debugging selectors.

#### 11.3.4 No-LLM Mode

When `--no-llm` is passed:

- Skip page classification (treat page as generic)
- Require `--schema` with CSS selectors defined per field
- Use `StaticExtractor` only (no LLM calls)
- Zero API keys needed, zero cost

This makes `spatula test` usable with zero external dependencies for developers who know their target DOM.

#### 11.3.5 Dependencies

The test command imports directly from `@spatula/core` (crawlers, extractors, LLM client). It does NOT import from `@spatula/db`, `@spatula/queue`, or `@spatula/api`. This means:

- No database connection needed
- No Redis connection needed
- No API server running needed
- Runs in <2 seconds for a single page

### 11.4 Proxy & Session Support

**Problem:** Many scraping targets require proxy rotation or authenticated sessions. The current `CrawlOptions` has no proxy, cookie, or session support, limiting real-world usefulness for local developers.

**Design:** Extend `CrawlOptions` and the crawler implementations to support proxies and cookies.

#### 11.4.1 CrawlOptions Extension

Extend the existing Zod schema in `packages/core/src/interfaces/crawler.ts`:

```typescript
export const CrawlOptions = z.object({
  // Existing fields
  timeout: z.number().default(30000),
  waitForSelector: z.string().optional(),
  headers: z.record(z.string()).optional(),
  userAgent: z.string().optional(),
  respectRobotsTxt: z.boolean().default(true), // Added in Workstream F

  // New: Proxy configuration
  proxy: z
    .object({
      url: z.string(), // e.g., 'http://proxy:8080' or 'socks5://proxy:1080'
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),

  // New: Cookie injection
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string().default('/'),
        httpOnly: z.boolean().default(false),
        secure: z.boolean().default(false),
      }),
    )
    .optional(),
});
```

#### 11.4.2 CrawlResult Metadata Extension

Update the `metadata` object in `CrawlResult` to capture proxy usage:

```typescript
metadata: z.object({
  crawledAt: z.coerce.date(),
  responseTimeMs: z.number(),
  contentLength: z.number(),
  crawlerType: z.enum(['playwright', 'firecrawl']),
  proxyUsed: z.boolean().default(false),             // NEW
}),
```

#### 11.4.3 Playwright Crawler Integration

Playwright natively supports proxies and cookies. The `PlaywrightCrawler` implementation changes:

**Proxy:** Passed to `browser.launch()`:

```typescript
const browser = await chromium.launch({
  proxy: options.proxy
    ? {
        server: options.proxy.url,
        username: options.proxy.username,
        password: options.proxy.password,
      }
    : undefined,
});
```

**Cookies:** Set on the browser context before navigation:

```typescript
if (options.cookies?.length) {
  const context = await browser.newContext();
  await context.addCookies(
    options.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
    })),
  );
  page = await context.newPage();
}
```

#### 11.4.4 Firecrawl Crawler Integration

Firecrawl's API supports headers but not direct proxy configuration (it runs its own infrastructure). Cookies are passed via the `headers` option as a `Cookie` header:

```typescript
if (options.cookies?.length) {
  const cookieHeader = options.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  headers['Cookie'] = cookieHeader;
}
```

**Proxy note:** Firecrawl does not support user-provided proxies -- it uses its own IP pool. If `options.proxy` is set with `crawlerType: 'firecrawl'`, log a warning: `Proxy configuration is ignored for Firecrawl crawler (uses built-in IP rotation).`

#### 11.4.5 Job Config Extension

Add proxy and cookie configuration to `JobConfig` for full crawl jobs:

```typescript
const CrawlConfig = z.object({
  maxDepth: z.number().min(0).max(10).default(2),
  maxPages: z.number().min(1).default(1000),
  concurrency: z.number().min(1).max(20).default(5),
  crawlerType: z.enum(['playwright', 'firecrawl']).default('playwright'),

  // New
  proxy: z
    .object({
      url: z.string(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string().default('/'),
      }),
    )
    .optional(),
});
```

**YAML config file support** (section 8.5):

```yaml
crawl:
  maxDepth: 3
  crawlerType: playwright
  proxy:
    url: socks5://127.0.0.1:1080
  cookies:
    - name: session_id
      value: abc123
      domain: .example.com
```

#### 11.4.6 Security Consideration

Proxy credentials and cookie values are sensitive. When stored in `JobConfig`:

- They are persisted in the `jobs.config` JSONB column
- They are visible via `GET /api/v1/jobs/:id`

**Mitigation:** Proxy credentials and cookie values should be redacted in API responses. Add a `redactSensitiveConfig(config)` utility that replaces `proxy.password` and `cookies[].value` with `"[REDACTED]"` before returning job details. The full values are only used internally by the crawl worker.

### 11.5 Cost Estimation

**Problem:** Developers have no visibility into how much a crawl job will cost before starting it. LLM calls happen at 6+ decision points per page, and costs vary by model and page count. This creates fear-of-the-unknown that discourages experimentation.

**Design:** A `spatula estimate` command and an API endpoint that predict crawl cost based on job configuration.

#### 11.5.1 Cost Model

LLM cost estimation uses average token counts per call type, derived from empirical measurement:

```typescript
const AVG_TOKENS_PER_CALL: Record<string, { prompt: number; completion: number }> = {
  pageRelevance: { prompt: 800, completion: 100 },
  extraction: { prompt: 2000, completion: 1500 },
  linkEvaluation: { prompt: 1500, completion: 300 }, // per batch of 20 links
  schemaEvolution: { prompt: 3000, completion: 1000 },
  entityMatching: { prompt: 1500, completion: 500 },
  conflictResolution: { prompt: 1000, completion: 300 },
  qualityAudit: { prompt: 2000, completion: 500 },
  documentation: { prompt: 1000, completion: 2000 },
};
```

**Per-model pricing (fetched or configured):**

```typescript
const MODEL_PRICING: Record<string, { promptPer1M: number; completionPer1M: number }> = {
  'anthropic/claude-sonnet-4-20250514': { promptPer1M: 3.0, completionPer1M: 15.0 },
  'anthropic/claude-3-haiku-20240307': { promptPer1M: 0.25, completionPer1M: 1.25 },
  'anthropic/claude-opus-4-20250514': { promptPer1M: 15.0, completionPer1M: 75.0 },
  // Ollama models
  'ollama/*': { promptPer1M: 0, completionPer1M: 0 },
};
```

#### 11.5.2 Estimation Algorithm

```typescript
interface CostEstimate {
  estimatedPages: number;
  llmCallBreakdown: Record<string, { calls: number; tokens: number; costUsd: number }>;
  totalTokens: number;
  totalCostUsd: number;
  confidence: 'low' | 'medium' | 'high';
  warnings: string[];
}

function estimateCost(config: JobConfig): CostEstimate {
  const pages = Math.min(config.crawl.maxPages, estimatePageCount(config));
  const model = config.llm?.primaryModel ?? 'anthropic/claude-sonnet-4-20250514';
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['anthropic/claude-sonnet-4-20250514'];

  // Per-page LLM calls
  const callsPerPage = {
    pageRelevance: 1,
    extraction: 0.7, // ~70% of pages are extractable
    linkEvaluation: 0.05, // 1 batch call per ~20 links
  };

  // Per-job LLM calls (not per-page)
  const jobLevelCalls = {
    schemaEvolution: Math.ceil(pages / (config.schemaEvolution?.batchSize ?? 10)),
    entityMatching: 1,
    conflictResolution: 1,
    qualityAudit: 1,
    documentation: 1,
  };

  // ... calculate per-call-type costs, sum totals
}
```

**`estimatePageCount(config)`:** Heuristic based on `maxDepth` and `maxPages`:

- `maxDepth=0`: 1 page (seed URLs only)
- `maxDepth=1`: `min(seeds * 20, maxPages)` (typical link fan-out)
- `maxDepth=2+`: `maxPages` (assume the limit will be hit)

**Confidence levels:**

- `high`: `maxDepth <= 1` (predictable page count)
- `medium`: `maxDepth == 2` and `maxPages <= 500`
- `low`: `maxDepth >= 3` or `maxPages > 1000` (wide crawl, unpredictable)

#### 11.5.3 CLI Command

```bash
spatula estimate --config spatula.yaml
```

**Output:**

```
  Spatula Cost Estimate
  ─────────────────────
  Estimated pages: ~250 (maxDepth: 2, maxPages: 500)
  Model: anthropic/claude-sonnet-4-20250514 via OpenRouter
  Confidence: medium

  LLM Call Breakdown
  ┌────────────────────┬───────┬──────────┬──────────┐
  │ Purpose            │ Calls │ Tokens   │ Cost     │
  ├────────────────────┼───────┼──────────┼──────────┤
  │ Page relevance     │ 250   │ 225,000  │ $0.07    │
  │ Extraction         │ 175   │ 612,500  │ $0.45    │
  │ Link evaluation    │ 13    │ 23,400   │ $0.01    │
  │ Schema evolution   │ 25    │ 100,000  │ $0.08    │
  │ Reconciliation     │ 3     │ 6,900    │ $0.01    │
  │ Documentation      │ 1     │ 3,000    │ $0.00    │
  ├────────────────────┼───────┼──────────┼──────────┤
  │ Total              │ 467   │ 970,800  │ $0.62    │
  └────────────────────┴───────┴──────────┴──────────┘

  ⚠ Confidence: medium — actual cost may vary by 2-3x
     depending on page content and link density.

  Using Ollama? Estimated cost: $0.00
  Run: LLM_PROVIDER=ollama spatula new
```

**New file:** `apps/cli/src/commands/estimate.ts`

#### 11.5.4 API Endpoint

```
POST /api/v1/jobs/estimate
Body: JobConfig (same schema as job creation)
Response: CostEstimate
```

This allows programmatic cost checks before submitting jobs. The endpoint does not create a job -- it only computes the estimate.

#### 11.5.5 Cost Estimation Library

**New file:** `packages/core/src/cost/estimator.ts`

Contains the `estimateCost(config)` function. Shared by both the CLI command and the API endpoint. Lives in `@spatula/core` (no HTTP/CLI dependencies).

---

## 12. Dependency Graph

```
Workstream A (Infrastructure)
  |-- Workstream B (Security)      <- needs deploy infra
  |-- Workstream C (Observability) <- needs deploy infra
  |-- Workstream D (Reliability)   <- needs deploy infra
  |-- Workstream E (Performance)   <- needs deploy infra
  |-- Workstream F (Pipeline)      <- needs A only (Redis for domain rate limiter)
  |-- Workstream G (API/CLI)       <- needs A for CI
  |-- Workstream H (Open Source)   <- needs A-F substantially complete
  |   |-- Workstream I (Hosted)    <- needs B (auth) + C (observability)
  |-- Workstream J (Local DX)      <- no hard dependencies, can start immediately
```

Note: Workstream F (Pipeline) depends only on A (infrastructure), not on E (Performance). Robots.txt, crawl budget, and per-domain politeness require only Redis (provided by A). This allows ethical crawling features to ship early.

Note: Workstream J (Local DX) has no dependencies on other workstreams. It extends `@spatula/core` interfaces and adds CLI commands -- both are independent of infrastructure, security, or observability work. It can be started in parallel with A or even before it.

**Recommended implementation order:**

1. **A + J** -- Infrastructure & Local DX (parallelizable; J unblocks early adoption, A unblocks everything else)
2. **B + C + D** -- Security, Observability, Reliability (parallelizable)
3. **E + F** -- Performance, Pipeline (parallelizable)
4. **G** -- API & CLI Completeness (after core is hardened)
5. **H** -- Open-Source Readiness (after core is hardened)
6. **I** -- Hosted Platform (after auth + observability)

### 11.1 Minimum Viable Open-Source Release

For an initial open-source release, the minimum required workstreams are:

**Phase 12 workstreams:**

- **A** (fully) -- CI/CD, Dockerfiles, graceful shutdown, connection pooling, orchestrator extraction
- **B** (API key auth, rate limiting, CORS only) -- skip JWT, billing scopes
- **C** (metrics, health checks only) -- skip Sentry, skip tracing initially
- **D** (DLQ, circuit breaker, crawl budget) -- core reliability
- **F** (robots.txt, crawl completion, politeness) -- ethical crawling
- **G** (doctor only) -- `spatula init` and config file support deferred to Phase 13
- **H** (fully) -- LICENSE, README, CONTRIBUTING, examples
- **J** (fully) -- Ollama support, test command, cost estimation, proxy/session support

**Phase 13 steps (executed in parallel with Phase 12):**

- **Step 1** -- Extract orchestrators (if not done in Phase 12 Workstream A)
- **Step 2** -- SQLite schema + repository layer
- **Step 3** -- Config system (YAML parser, global config, config diff engine)
- **Step 4** -- Local pipeline runner + core CLI (`spatula init`, `spatula run`, `spatula status`)
- **Step 5** -- Data interaction commands (`spatula explore`, `spatula export`, `spatula review`)

This yields a platform with BOTH deployment models from day one:

- **Self-hosted server mode** for production (Postgres + Redis + BullMQ)
- **Local project-folder mode** for development (`spatula init` -> `spatula run`)

### 11.2 Recommended Interleaving with Phase 13

Phase 12 and Phase 13 parallelize naturally because they touch different layers:

| Wave  | Phase 12 (server layer)                                 | Phase 13 (local layer)                     |
| ----- | ------------------------------------------------------- | ------------------------------------------ |
| **1** | A: CI/CD, Dockerfiles, shutdown, pooling, orchestrators | Step 1: Extract orchestrators (shared)     |
| **2** | D + F + J: circuit breaker, robots.txt, Ollama, proxy   | Steps 2 + 3: SQLite schema + config system |
| **3** | B + C + E: auth, observability, performance             | Step 4: Pipeline runner + core CLI         |
| **4** | G + H: webhooks, bulk ops, LICENSE, README              | Step 5: Data commands                      |
| **5** | I: billing, admin, data retention                       | Step 6: Remote ops (push/pull)             |

Phase 12 modifies server code (`apps/api`, `packages/queue` workers, middleware). Phase 13 adds new local code (`packages/db/project-db`, `packages/core/pipeline`, new CLI commands). Minimal file overlap — the orchestrator extraction in Wave 1 is the shared prerequisite.

The open-source release targets the end of Wave 4, including Phase 13 Steps 1-5. Phase 13 Step 6 (remote operations) and Phase 12 Workstream I (hosted platform) follow in Wave 5.

---

## 13. Testing Strategy

### 13.1 New Test Categories

| Category                | What's Tested                             | Tool                                |
| ----------------------- | ----------------------------------------- | ----------------------------------- |
| **Integration (DB)**    | Repositories against real Postgres        | Vitest + testcontainers             |
| **Integration (Redis)** | Rate limiter, cache, circuit breaker      | Vitest + testcontainers             |
| **Contract**            | CLI to API request/response shapes        | Vitest + OpenAPI schema validation  |
| **Load**                | API throughput, queue saturation          | k6 scripts                          |
| **Security**            | Auth bypass, injection, header validation | Vitest + custom security test suite |

### 13.2 Integration Test Infrastructure

**New file:** `tests/integration/setup.ts`

Uses `@testcontainers/postgresql` and `@testcontainers/redis` for ephemeral containers per test run. Runs migrations, provides fresh DB per test suite. No shared state between test runs.

### 13.3 Load Test Scripts

**Directory:** `tests/load/`

- `api-smoke.js` -- k6: 50 VUs, 30s, basic endpoint health
- `crawl-throughput.js` -- k6: simulate 10 concurrent jobs
- `export-stress.js` -- k6: trigger exports with large entity sets

### 13.4 Security Test Suite

**Directory:** `tests/security/`

- `auth-bypass.test.ts` -- missing/invalid/expired tokens
- `tenant-isolation.test.ts` -- cross-tenant data access attempts
- `rate-limit.test.ts` -- verify rate limiting kicks in
- `input-validation.test.ts` -- SQL injection, XSS in stored fields
- `header-security.test.ts` -- verify security headers present

### 13.5 Workstream J Tests

**Directory:** `packages/core/tests/unit/llm/`

- `ollama-client.test.ts` -- mock Ollama REST API, test request formatting, error handling, timeout, model-not-found error
- `llm-factory.test.ts` -- test provider selection, config validation, Ollama reachability check
- `circuit-breaker.test.ts` -- (existing) extend to test with Ollama client wrapping

**Directory:** `packages/core/tests/unit/cost/`

- `estimator.test.ts` -- test cost calculation with various configs, model pricing, page count heuristics, confidence levels, Ollama zero-cost path

**Directory:** `apps/cli/tests/unit/commands/`

- `test.test.ts` -- test single-page command with mocked crawler and LLM client, test `--no-llm` mode, test output formats (json, table), test `--show-links` and `--show-html` flags
- `estimate.test.ts` -- test CLI output formatting, test with various job configs

**Directory:** `packages/core/tests/unit/crawlers/`

- `playwright-crawler-proxy.test.ts` -- test proxy options passed to `browser.launch()`, test cookie injection on context
- `firecrawl-crawler-proxy.test.ts` -- test cookie-to-header conversion, test proxy warning log

**Integration test:**

- `tests/integration/ollama-extraction.test.ts` -- optional test (skipped if Ollama not running) that runs a real extraction against a local fixture HTML file using a local model. Gated by `OLLAMA_INTEGRATION_TEST=true` env var.

---

## 14. Migration & Rollout

### 14.1 Database Migrations

This spec introduces 6 new tables and 1 table modification requiring a Drizzle migration:

**New tables:**

1. `api_keys` (section 3.1.2)
2. `audit_log` (section 3.6)
3. `llm_usage` (section 4.4.1)
4. `dead_letter_queue` (section 5.1.1)
5. `usage_records` (section 10.2.2)
6. `user_tenants` (section 10.1.2)

**Table modifications:**

1. `tenants` -- add `quotas` JSONB column (section 3.4)

**Note:** `crawl_task_status` enum already includes `skipped` from Phase 11. No enum migration needed.

**Index additions:** 4 new indexes (section 6.3), plus indexes on new tables

**Migration strategy:** Single Drizzle migration file. Additive only -- no destructive changes. Existing data unaffected. Safe to run on a live database.

### 14.2 Environment Variable Additions

| Variable                    | Default                              | Required         | Workstream |
| --------------------------- | ------------------------------------ | ---------------- | ---------- |
| `AUTH_STRATEGY`             | `none`                               | No               | B          |
| `JWT_ISSUER`                | --                                   | If jwt           | B          |
| `JWT_AUDIENCE`              | --                                   | If jwt           | B          |
| `JWT_JWKS_URL`              | --                                   | If jwt           | B          |
| `CORS_ALLOWED_ORIGINS`      | `http://localhost:3000`              | No               | B          |
| `DB_POOL_MAX`               | `20`                                 | No               | A          |
| `DB_POOL_IDLE_TIMEOUT`      | `30000`                              | No               | A          |
| `CONTENT_STORE`             | `postgres`                           | No               | E          |
| `S3_BUCKET`                 | --                                   | If s3            | E          |
| `S3_REGION`                 | --                                   | If s3            | E          |
| `S3_ENDPOINT`               | --                                   | If s3 (R2/MinIO) | E          |
| `S3_ACCESS_KEY_ID`          | --                                   | If s3            | E          |
| `S3_SECRET_ACCESS_KEY`      | --                                   | If s3            | E          |
| `SENTRY_DSN`                | --                                   | No               | C          |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1`                                | No               | C          |
| `OTEL_EXPORTER_ENDPOINT`    | --                                   | No               | C          |
| `CRAWL_DEFAULT_DELAY_MS`    | `1000`                               | No               | F          |
| `SPATULA_WORKERS`           | `all`                                | No               | A          |
| `STRIPE_SECRET_KEY`         | --                                   | If hosted        | I          |
| `STRIPE_WEBHOOK_SECRET`     | --                                   | If hosted        | I          |
| `LLM_PROVIDER`              | `openrouter`                         | No               | J          |
| `OLLAMA_BASE_URL`           | `http://localhost:11434`             | If ollama        | J          |
| `OLLAMA_TIMEOUT_MS`         | `120000`                             | No               | J          |
| `LLM_PRIMARY_MODEL`         | `anthropic/claude-sonnet-4-20250514` | No               | J          |

### 14.3 New Package Dependencies

| Package                                     | Version  | Workstream | Purpose                           |
| ------------------------------------------- | -------- | ---------- | --------------------------------- |
| `jose`                                      | ^6.x     | B          | JWT validation (lightweight)      |
| `@aws-sdk/client-s3`                        | ^3.x     | E          | S3/R2 content store               |
| `@aws-sdk/s3-request-presigner`             | ^3.x     | E          | Presigned download URLs           |
| `robots-parser`                             | ^3.x     | F          | robots.txt parsing                |
| `@opentelemetry/sdk-metrics`                | ^1.x     | C          | Metrics collection                |
| `@opentelemetry/exporter-prometheus`        | ^0.x     | C          | Prometheus export                 |
| `@opentelemetry/sdk-trace-node`             | ^1.x     | C          | Distributed tracing               |
| `@opentelemetry/auto-instrumentations-node` | ^0.x     | C          | Auto-instrumentation              |
| `@sentry/node`                              | ^9.x     | C          | Error aggregation                 |
| `@bull-board/api`                           | ^6.x     | C          | Queue dashboard                   |
| `@bull-board/hono`                          | ^6.x     | C          | Hono adapter for Bull Board       |
| `stripe`                                    | ^18.x    | I          | Billing integration               |
| `@testcontainers/postgresql`                | ^10.x    | Testing    | Integration test containers       |
| `@testcontainers/redis`                     | ^10.x    | Testing    | Integration test containers       |
| `k6`                                        | (system) | Testing    | Load testing (installed globally) |

### 14.4 Backward Compatibility

All changes are additive. No breaking changes to existing:

- API endpoints (new endpoints only, existing unchanged)
- Database schema (new columns have defaults, new tables are independent)
- Configuration (new env vars have sensible defaults, `AUTH_STRATEGY=none` preserves current behavior)
- CLI commands (new commands only, existing unchanged)

**Open-source upgrade path:** Users on older versions can update and run `pnpm db:migrate`. No manual intervention required.

### 14.5 Auth Migration Path

Switching `AUTH_STRATEGY` from `none` to `api-key` is a **breaking change** for all existing API clients (CLI, test scripts, E2E tests, any integration using `x-tenant-id` header).

**Migration steps:**

1. Deploy with `AUTH_STRATEGY=none` (current behavior preserved)
2. Create API keys for each tenant via `POST /api/v1/api-keys` (works with header-based auth)
3. Distribute API keys to all clients
4. Update CLI to send `Authorization: Bearer <key>` (the `--api-key` flag or `SPATULA_API_KEY` env var)
5. Update E2E tests to use API keys
6. Switch `AUTH_STRATEGY=api-key` and redeploy
7. Verify all clients authenticate correctly

**Dual-mode transition (optional):** If a zero-downtime migration is needed, implement a temporary `AUTH_STRATEGY=dual` mode that accepts both `Authorization: Bearer` and `x-tenant-id` header, logging a deprecation warning for header-based auth. Remove dual mode after transition.

### 14.6 AppConfigSchema Extension

All new env vars listed in section 13.2 must be added to `AppConfigSchema` in `packages/shared/src/config.ts` so that `loadConfig()` fails fast on misconfiguration. The extended schema adds these optional groups:

```typescript
auth: z.object({
  strategy: z.enum(['none', 'api-key', 'jwt']).default('none'),
  jwtIssuer: z.string().optional(),
  jwtAudience: z.string().optional(),
  jwtJwksUrl: z.string().url().optional(),
}).default({}),
cors: z.object({
  allowedOrigins: z.string().default('http://localhost:3000'),
}).default({}),
pool: z.object({
  max: z.coerce.number().int().min(1).max(100).default(20),
  idleTimeoutMs: z.coerce.number().int().min(1000).default(30000),
}).default({}),
contentStore: z.object({
  type: z.enum(['postgres', 's3']).default('postgres'),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
  s3Endpoint: z.string().optional(),
}).default({}),
observability: z.object({
  sentryDsn: z.string().optional(),
  sentryTracesSampleRate: z.coerce.number().min(0).max(1).default(0.1),
  otelEndpoint: z.string().optional(),
}).default({}),
workers: z.object({
  enabled: z.string().default('all'),  // comma-separated or 'all'
}).default({}),
crawl: z.object({
  defaultDelayMs: z.coerce.number().int().min(0).default(1000),
}).default({}),
llm: z.object({
  provider: z.enum(['openrouter', 'ollama']).default('openrouter'),
  primaryModel: z.string().default('anthropic/claude-sonnet-4-20250514'),
  ollamaBaseUrl: z.string().default('http://localhost:11434'),
  ollamaTimeoutMs: z.coerce.number().int().min(1000).default(120000),
}).default({}),
```

**Validation rules:**

- When `auth.strategy === 'jwt'`: `jwtIssuer`, `jwtAudience`, and `jwtJwksUrl` are required
- When `contentStore.type === 's3'`: `s3Bucket` is required; `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` env vars are required (validated outside Zod via AWS SDK credential chain)
- When `llm.provider === 'openrouter'`: `OPENROUTER_API_KEY` is required (existing behavior)
- When `llm.provider === 'ollama'`: `OPENROUTER_API_KEY` is not required; startup verifies Ollama is reachable

---

## Appendix A: New Files Summary

| Path                                                   | Workstream | Purpose                                                          |
| ------------------------------------------------------ | ---------- | ---------------------------------------------------------------- |
| `.github/workflows/ci.yml`                             | A          | CI pipeline                                                      |
| `.github/workflows/release.yml`                        | A          | Release + Docker push                                            |
| `.github/workflows/audit.yml`                          | A          | Dependency audit                                                 |
| `Dockerfile.api`                                       | A          | API container                                                    |
| `Dockerfile.worker`                                    | A          | Worker container                                                 |
| `Dockerfile.cli`                                       | A          | CLI container                                                    |
| `docker-compose.prod.yml`                              | A          | Production compose                                               |
| `packages/queue/src/worker-entrypoint.ts`              | A          | Worker lifecycle                                                 |
| `apps/api/src/middleware/auth.ts`                      | B          | Auth middleware                                                  |
| `apps/api/src/middleware/rate-limit.ts`                | B          | Rate limiting                                                    |
| `apps/api/src/middleware/timing.ts`                    | C          | Request timing                                                   |
| `packages/shared/src/metrics.ts`                       | C          | Metrics collection                                               |
| `packages/shared/src/tracing.ts`                       | C          | Distributed tracing                                              |
| `packages/shared/src/sentry.ts`                        | C          | Error aggregation                                                |
| `packages/core/src/llm/circuit-breaker.ts`             | D          | Circuit breaker                                                  |
| `packages/core/src/content-store/s3-content-store.ts`  | E          | S3 content store                                                 |
| `packages/db/src/cache.ts`                             | E          | Redis cache                                                      |
| `packages/core/src/crawlers/robots-txt.ts`             | F          | robots.txt compliance                                            |
| `packages/core/src/crawlers/domain-rate-limiter.ts`    | F          | Per-domain politeness                                            |
| `packages/core/src/pipeline/crawl-orchestrator.ts`     | A          | Shared crawl logic (if orchestrator extraction done in Phase 12) |
| `packages/core/src/pipeline/schema-orchestrator.ts`    | A          | Shared schema evolution logic                                    |
| `packages/core/src/pipeline/reconcile-orchestrator.ts` | A          | Shared reconciliation logic                                      |
| `packages/core/src/pipeline/export-orchestrator.ts`    | A          | Shared export logic                                              |
| `packages/queue/src/webhook-sender.ts`                 | G          | Webhook delivery                                                 |
| `apps/cli/src/commands/doctor.ts`                      | G          | Diagnostics (extensible for Phase 13)                            |
| `LICENSE`                                              | H          | MIT license                                                      |
| `README.md`                                            | H          | Project documentation                                            |
| `CONTRIBUTING.md`                                      | H          | Contributor guide                                                |
| `docs/architecture.md`                                 | H          | Architecture docs                                                |
| `examples/quickstart/`                                 | H          | Example configs                                                  |
| `tests/integration/setup.ts`                           | Testing    | Testcontainers setup                                             |
| `tests/load/*.js`                                      | Testing    | k6 load tests                                                    |
| `tests/security/*.test.ts`                             | Testing    | Security tests                                                   |
| `packages/core/src/llm/ollama-client.ts`               | J          | Ollama LLM provider                                              |
| `packages/core/src/llm/llm-factory.ts`                 | J          | LLM provider factory                                             |
| `packages/core/src/cost/estimator.ts`                  | J          | Cost estimation library                                          |
| `apps/cli/src/commands/test.ts`                        | J          | Single-page test command                                         |
| `apps/cli/src/commands/estimate.ts`                    | J          | Cost estimation command                                          |

## Appendix B: Modified Files Summary

| Path                                                  | Workstream | Change                                                                                              |
| ----------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `packages/db/src/connection.ts`                       | A          | Pool-based connections                                                                              |
| `apps/api/src/server.ts`                              | A          | Graceful shutdown                                                                                   |
| `apps/api/src/app.ts`                                 | A, B, C    | Middleware chain updates                                                                            |
| `packages/shared/src/config.ts`                       | A, B, C, E | AppConfigSchema extension (section 13.6)                                                            |
| `apps/api/src/types.ts`                               | A          | Add `dbPool: Pool` to AppDeps                                                                       |
| `packages/queue/src/worker-deps.ts`                   | A          | Add `dbPool: Pool` to WorkerDeps                                                                    |
| `packages/core/src/interfaces/crawler.ts`             | F          | `respectRobotsTxt` option                                                                           |
| `packages/core/src/llm/openrouter-client.ts`          | C          | Token usage recording                                                                               |
| `packages/queue/src/queues.ts`                        | D, G       | Per-queue retry config, add WEBHOOK queue                                                           |
| `packages/core/src/interfaces/content-store.ts`       | E          | Add optional `getDownloadUrl` method                                                                |
| `apps/api/src/ws/job-progress.ts`                     | B          | Remove `?tenantId=` fallback when auth active                                                       |
| `packages/queue/src/workers/crawl-worker.ts`          | A, F       | Refactor to thin wrapper (if orchestrator extraction), maxPages, robots.txt, politeness, completion |
| `packages/queue/src/workers/schema-worker.ts`         | A          | Refactor to thin wrapper (if orchestrator extraction)                                               |
| `packages/queue/src/workers/reconciliation-worker.ts` | A          | Refactor to thin wrapper (if orchestrator extraction)                                               |
| `packages/queue/src/workers/export-worker.ts`         | A, E, F    | Refactor to thin wrapper (if orchestrator extraction), streaming, quality filter                    |
| `apps/api/src/routes/exports.ts`                      | E          | Presigned URL redirects                                                                             |
| `.env.example`                                        | All        | New variables documented                                                                            |
| `docker-compose.yml`                                  | A          | Network config for prod                                                                             |
| `packages/core/src/interfaces/crawler.ts`             | J          | Add proxy + cookies to CrawlOptions                                                                 |
| `packages/core/src/crawlers/playwright-crawler.ts`    | J          | Proxy and cookie support                                                                            |
| `packages/core/src/crawlers/firecrawl-crawler.ts`     | J          | Cookie-to-header conversion                                                                         |
| `packages/core/src/types/job.ts`                      | J          | Add proxy + cookies to CrawlConfig                                                                  |
| `packages/core/src/llm/model-router.ts`               | J          | Works as-is (no changes, but documented)                                                            |
| `packages/shared/src/config.ts`                       | J          | Add LLM provider config to AppConfigSchema                                                          |
| `apps/api/src/routes/jobs.ts`                         | J          | Redact proxy credentials in responses                                                               |
