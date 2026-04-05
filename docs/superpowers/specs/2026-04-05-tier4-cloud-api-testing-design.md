# Tier 4: Cloud API & Server Integration Testing Design

**Status:** Draft
**Created:** 2026-04-05
**Scope:** End-to-end testing of cloud service integrations (OpenRouter, Firecrawl) and API server routes with real Postgres + Redis. Also includes a modular refactoring of the test tier orchestration system.

---

## 1. Overview

Tiers 1-3 cover all local code paths. Tier 4 tests the remaining blind spots:
- **API server routes** — Full job lifecycle through Hono routes with real Postgres + Redis (zero integration testing today)
- **OpenRouter** — Real LLM completions validating prompt parsing and JSON mode compliance
- **Firecrawl** — Real cloud crawling validating HTML quality and link extraction

**Strategy:** Docker Compose for Postgres + Redis. Hono's `app.request()` for API route testing (no HTTP server needed). Real API keys for OpenRouter/Firecrawl with budget caps. Each test file independently checks prerequisites and skips gracefully when missing.

**Prerequisites skip independently:** API tests need Docker. OpenRouter tests need an API key. Firecrawl tests need an API key. You can run any subset.

---

## 2. Modular Service Manager Architecture

### 2.1 Interface

```typescript
export interface ServiceStatus {
  available: boolean;
  version?: string;
  details: Record<string, unknown>;
}

export interface ProvisionOpts {
  autoYes: boolean;
}

export interface ServiceContext {
  services: Record<string, Record<string, unknown>>;
  autoYes: boolean;
  envVars: Record<string, string>;
}

export interface ServiceHandle {
  stop(): Promise<void>;
  connectionInfo: Record<string, unknown>;
  envVars: Record<string, string>;
}

export interface ServiceManager {
  name: string;
  dependsOn?: string[];
  check(): Promise<ServiceStatus>;
  provision(opts: ProvisionOpts): Promise<boolean>;
  start(context: ServiceContext): Promise<ServiceHandle>;
  healthCheck(): Promise<boolean>;
}
```

### 2.2 Service Registry

```typescript
export class ServiceRegistry {
  register(manager: ServiceManager): void;
  get(name: string): ServiceManager;
  resolveStartOrder(serviceNames: string[]): string[];
  async startAll(names: string[], opts: ProvisionOpts): Promise<{
    handles: Map<string, ServiceHandle>;
    envVars: Record<string, string>;
    stopAll(): Promise<void>;
  }>;
}
```

`startAll` performs topological sort on `dependsOn`, starts independent services in parallel, accumulates `connectionInfo` and `envVars` from each handle, passes context to dependent services.

### 2.3 Service Managers

| Manager | `dependsOn` | What It Does | `envVars` Provided |
|---------|-------------|-------------|-------------------|
| `ollama` | — | Existing Ollama lifecycle (check/install/pull/serve) | `OLLAMA_BASE_URL` |
| `docker-postgres` | — | Docker Compose up Postgres on 5433, run Drizzle migrations | `DATABASE_URL`, `TEST_DATABASE_URL` |
| `docker-redis` | — | Docker Compose up Redis on 6380, `SELECT 1` + `FLUSHDB` | `REDIS_URL` |
| `openrouter` | — | Check API key from env/.env.test, validate via `GET /api/v1/models` | `OPENROUTER_API_KEY` |
| `firecrawl` | — | Check API key from env/.env.test | `FIRECRAWL_API_KEY` |

Note: No `api-server` service manager. The API app is imported directly in test files using Hono's `app.request()` test helper, which runs the full middleware chain without starting an HTTP server.

### 2.4 Tier Registry (Declarative)

```typescript
interface TierDefinition {
  name: string;
  description: string;
  extends?: string;
  services: string[];
  globs: string[];
  budgetCap?: number;
  skipIfMissing?: boolean;
}

const TIERS: Record<string, TierDefinition> = {
  '1': {
    name: 'Local',
    description: 'Unit + integration + E2E (no external deps)',
    services: [],
    globs: ['tests/unit', 'tests/integration', 'tests/e2e/contracts-*', 'tests/e2e/resource-*', 'tests/e2e/workflow*', 'tests/e2e/tui-*'],
  },
  '2': {
    name: 'Mock LLM',
    description: 'Tier 1 + mock Ollama pipeline tests',
    extends: '1',
    services: [],
    globs: ['tests/e2e/tier2/pipeline-mock-*', 'tests/e2e/tier2/pipeline-errors*', 'tests/e2e/tier2/conversation*'],
  },
  '3': {
    name: 'Real LLM',
    description: 'Tier 2 + real Ollama',
    extends: '2',
    services: ['ollama'],
    globs: ['tests/e2e/tier2/pipeline-real-*'],
  },
  '4': {
    name: 'Cloud APIs + Server',
    description: 'Tier 3 + OpenRouter + Firecrawl + API server',
    extends: '3',
    services: ['ollama', 'docker-postgres', 'docker-redis', 'openrouter', 'firecrawl'],
    globs: ['tests/e2e/tier4/'],
    budgetCap: 0.50,
    skipIfMissing: true,
  },
  ci: {
    name: 'CI',
    description: 'Deterministic tests only (Tier 2)',
    extends: '2',
    services: [],
    globs: [],
  },
  binary: {
    name: 'CLI Binary',
    description: 'CLI subprocess tests',
    services: [],
    globs: ['tests/e2e/cli-binary*'],
  },
};
```

**Adding future tiers:** Create a new service manager file in `scripts/services/`, add one entry to the tier registry, create test files. No changes to the orchestrator.

### 2.5 Orchestrator Flow

```
parse args (--tier, --model, --yes, --timeout, --budget-cap)
  → resolve tier definition (walk extends chain, merge globs)
  → collect all required services (deduplicated)
  → for each service (topological order):
      check → provision (if needed, with confirmation) → start
  → collect env vars from all service handles
  → run vitest with merged globs + injected env vars
  → for each service (reverse order): stop
  → print summary (tests, time, cost if applicable)
```

SIGINT/SIGTERM handlers ensure cleanup runs on interruption.

### 2.6 `.env.test` Loading

A simple line parser (no `dotenv` dependency) loads `.env.test` at the start of the orchestrator:

```typescript
function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .reduce((acc, line) => {
      const [key, ...rest] = line.split('=');
      acc[key.trim()] = rest.join('=').trim();
      return acc;
    }, {} as Record<string, string>);
}
```

Env vars from process.env take precedence over `.env.test` (CI secrets override local file).

---

## 3. Docker Compose

### `tests/e2e/tier4/docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "${TEST_POSTGRES_PORT:-5433}:5432"
    environment:
      POSTGRES_DB: spatula_test
      POSTGRES_USER: spatula
      POSTGRES_PASSWORD: spatula_test
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spatula -d spatula_test"]
      interval: 2s
      timeout: 5s
      retries: 10
    tmpfs:
      - /var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "${TEST_REDIS_PORT:-6380}:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 5s
      retries: 10
```

- **Ports 5433/6380** avoid conflicts with local installations
- **tmpfs** for Postgres — RAM disk, instant teardown
- **Alpine images** — minimal size, fast pull
- **Configurable ports** via env vars for flexibility
- **Dynamic project name** — `docker compose -p spatula-test-<random>` prevents collisions

### Docker Manager Implementation

**`docker-postgres` manager:**
1. Check: `docker compose ps` → is postgres healthy?
2. Provision: `docker compose pull` if images missing
3. Start:
   - `docker compose -p spatula-test-<id> -f <compose-path> up -d postgres`
   - Poll `docker inspect` for healthy status, timeout 30s
   - Run Drizzle migrations against `postgres://spatula:spatula_test@localhost:5433/spatula_test`
   - Return `envVars: { DATABASE_URL: 'postgres://spatula:spatula_test@localhost:5433/spatula_test' }`
4. Stop: `docker compose -p <id> down` (no `-v` by default; `--clean` flag for `-v`)

**`docker-redis` manager:**
1. Start:
   - `docker compose -p <id> -f <compose-path> up -d redis`
   - Poll healthcheck, timeout 15s
   - Connect with `ioredis`, `SELECT 1`, `FLUSHDB` (flush only database 1, never default 0)
   - Return `envVars: { REDIS_URL: 'redis://localhost:6380/1' }` (note: `/1` selects database 1)
2. Stop: `docker compose -p <id> down`

**Docker availability:** Check both `docker info` and `docker compose version`. Try `docker compose` first, fall back to `docker-compose` (v1).

**Compose version compatibility:** Try `docker compose` (v2 plugin) first, fall back to `docker-compose` (v1 binary).

---

## 4. API Server Testing

### Approach

Use Hono's `app.request()` test helper — runs the full middleware chain (auth, tenant validation, rate limiting, deps injection) without starting an HTTP server. The API app is imported directly in the test file.

### Dependency Injection

The API app needs real Postgres and Redis connections. The test helper `createTestApp()`:
1. Reads `DATABASE_URL` and `REDIS_URL` from env (set by orchestrator)
2. Creates real Drizzle + ioredis instances
3. Imports/builds the Hono app with real deps
4. Returns `{ app, cleanup() }`

### Tenant Isolation

Each test file creates its own tenant via `POST /api/v1/tenants` (bootstrap endpoint, no auth required). All subsequent requests include the tenant's API key. This ensures test files don't interfere with each other's data.

### Data Seeding for Schema/Entity Tests

Some tests need pre-existing data (entities, schema, actions) without running the full pipeline. The test helper seeds data directly in Postgres via the Drizzle instance returned by `createTestApp()`.

### Worker-Dependent Features

BullMQ workers are NOT started in Tier 4. Features that require job processing (export generation, reconciliation) are tested at the API route level only:
- `POST /export` → 201 (creates record with status 'pending')
- `GET /export/{id}` → 200 (returns metadata)
- Actual export processing is covered by Tier 1/2 tests of `processExport()`

### WebSocket Testing

For the single WebSocket test, start the Hono app on a random port temporarily:
```typescript
const server = serve({ fetch: app.fetch, port: 0 });
const port = (server.address() as AddressInfo).port;
// Connect WebSocket client to ws://localhost:${port}/ws/...
// Verify connection + message format
server.close();
```

---

## 5. Test Files

### 5.1 `helpers.ts` — Shared utilities

Exports:
- `createTestApp()` — imports Hono app, creates real DB/Redis connections, returns `{ app, db, cleanup() }`
- `createTenant(app)` — bootstraps tenant, returns `{ tenantId, apiKey }`
- `authHeaders(tenantId, apiKey)` — builds auth header object
- `seedJobWithData(db, tenantId)` — inserts a job, schema, entities, and actions directly in Postgres for tests that need pre-existing data
- `startWebhookReceiver()` — tiny HTTP server collecting webhook POSTs
- `isDockerAvailable()` — checks `docker info` + `docker compose version`

### 5.2 `api-lifecycle.test.ts` — 20 tests

Skip if `DATABASE_URL` not set (Docker not running).

**Tenant & Auth (2):**

| Test | Assertion |
|------|-----------|
| Bootstrap creates tenant and returns API key | POST /api/v1/tenants → 201, has tenantId + apiKey |
| Unauthorized request rejected | GET /api/v1/jobs without auth → 401 |

**Job CRUD (5):**

| Test | Assertion |
|------|-----------|
| Create job | POST /api/v1/jobs → 201, has id + status 'created' |
| List jobs | GET /api/v1/jobs → 200, array contains created job |
| Get job details | GET /api/v1/jobs/{id} → 200, matches config |
| Start job | PATCH /api/v1/jobs/{id} { action: 'start' } → 200, status changes |
| Delete job | DELETE /api/v1/jobs/{id} → 200/204, subsequent GET → 404 |

**Schema & Entities (3):**

Seed data directly via DB before these tests.

| Test | Assertion |
|------|-----------|
| Get schema | GET /api/v1/jobs/{id}/schema → 200, has definition with fields |
| List entities (paginated) | GET /api/v1/jobs/{id}/entities?limit=2 → 200, has data + total |
| Get entity detail | GET /api/v1/jobs/{id}/entities/{entityId} → 200, has mergedData |

**Actions (3):**

| Test | Assertion |
|------|-----------|
| List pending actions | GET /api/v1/jobs/{id}/actions?status=pending_review → 200, array |
| Approve action | POST /api/v1/jobs/{id}/actions/{actionId}/approve → 200, status changes |
| Batch actions | POST /api/v1/actions/batch { action: 'approve', ids: [...] } → 200, partial success |

**Export (2):**

| Test | Assertion |
|------|-----------|
| Create export | POST /api/v1/jobs/{id}/export { format: 'json' } → 201, has exportId |
| Get export status | GET /api/v1/jobs/{id}/export/{exportId} → 200, has status |

**Webhook (2):**

| Test | Assertion |
|------|-----------|
| Webhook delivered on job event | Create job with webhook URL → trigger event via DB → receiver got POST |
| Webhook includes signature | Receiver request has `X-Spatula-Signature` when secret configured |

**Health & Admin (2):**

| Test | Assertion |
|------|-----------|
| Health endpoint | GET /health → 200 |
| Deep health | GET /health/deep → 200, shows db + redis status |

**Rate Limiting (1):**

| Test | Assertion |
|------|-----------|
| Rate limit headers present | Authenticated request → response has `X-RateLimit-Limit`, `X-RateLimit-Remaining` |

### 5.3 `openrouter-integration.test.ts` — 6 tests

Skip if `OPENROUTER_API_KEY` not set. Uses `google/gemini-2.5-flash` ($0.15/1M tokens).

| Test | What | Assertion |
|------|------|-----------|
| API key is valid | GET /api/v1/models | 200, models array not empty |
| Simple completion | complete("Say hello") | Has content, usage.totalTokens > 0 |
| JSON mode | complete(jsonMode: true, "Return {greeting: string}") | Content parses as valid JSON |
| Classification prompt | Actual PageClassifier system prompt + sample HTML | Parses into ClassificationResponse Zod schema |
| Extraction prompt | Actual StaticExtractor system prompt + HTML + schema | Parses into LLMExtractionResponse Zod schema |
| Token usage accuracy | Check usage fields from all calls | promptTokens > 0, completionTokens > 0, total = prompt + completion |

Cost tracking: log total tokens + estimated cost after all tests.

### 5.4 `firecrawl-integration.test.ts` — 5 tests

Skip if `FIRECRAWL_API_KEY` not set. Uses `https://books.toscrape.com` (stable scraping test site).

| Test | What | Assertion |
|------|------|-----------|
| Crawl simple page | crawl('https://books.toscrape.com/') | HTML contains 'Books to Scrape', status 200 |
| Extracts links | Same crawl result | links array contains book URLs |
| Returns metadata | Same crawl result | responseTimeMs > 0, contentLength > 0, crawlerType = 'firecrawl' |
| Handles 404 | crawl('/nonexistent') | Throws CrawlError or returns 404 status |
| Compare with Playwright | Crawl same page with both | Both return HTML with same title. Skip if Playwright unavailable |

---

## 6. File Structure

```
apps/cli/
  scripts/
    services/
      service-manager.ts         ← Interface + ServiceRegistry class
      ollama-manager.ts          ← Refactored from existing (implements ServiceManager)
      docker-manager.ts          ← Docker Compose lifecycle for Postgres + Redis
      openrouter-manager.ts      ← API key check + validation call
      firecrawl-manager.ts       ← API key check
    tier-registry.ts             ← Declarative tier definitions
    test-tiers.ts                ← Orchestrator (refactored to use registry + managers)
    ollama-manager.ts            ← Deprecated (replaced by services/ollama-manager.ts)
  tests/e2e/tier4/
    docker-compose.yml           ← Postgres + Redis
    .env.test.example            ← API key template
    helpers.ts                   ← createTestApp, createTenant, seedJobWithData, webhook receiver
    api-lifecycle.test.ts        ← 20 tests
    openrouter-integration.test.ts  ← 6 tests
    firecrawl-integration.test.ts   ← 5 tests
```

---

## 7. Test Counts and Runtime

| File | Tests | Requires | Est. Runtime |
|------|-------|----------|-------------|
| api-lifecycle.test.ts | 20 | Docker (Postgres + Redis) | ~10s |
| openrouter-integration.test.ts | 6 | OPENROUTER_API_KEY | ~15s |
| firecrawl-integration.test.ts | 5 | FIRECRAWL_API_KEY | ~20s |
| **Total** | **31** | | ~45s |

Each requirement is independent. Tests skip gracefully when prerequisites are missing.

**Combined with previous tiers:**

| Tier | Tests | Cumulative |
|------|-------|-----------|
| 1 | 514 | 514 |
| 2 | 43 | 557 |
| 3 | 6 | 563 |
| 4 | 31 | 594 |
| Binary | 18 | 612 |

---

## 8. Infrastructure Notes

### Docker Container Naming

Dynamic project name prevents collisions: `docker compose -p spatula-test-<short-random>`.

### Teardown

`docker compose down` by default (fast re-run). `--clean` flag for `docker compose down -v` (remove volumes, full reset).

### Redis Safety

Use `SELECT 1` + `FLUSHDB` — only flush database 1, never the default database 0. Connection URL includes `/1`: `redis://localhost:6380/1`.

### OpenRouter Budget Cap

After test run, calculate cost from token counts:
```
tokens * (price_per_1M / 1_000_000)
```
Log: `"OpenRouter: 6 calls, ~3,200 tokens, ~$0.001 (google/gemini-2.5-flash)"`.
If accumulated cost exceeds `budgetCap`, print warning (don't abort — tests already ran).

### Firecrawl Rate Limits

Tests run sequentially (not parallel crawls). Target: 3-5 pages on `https://books.toscrape.com`. Free tier (500 credits/month) is sufficient.

### CI Compatibility

- GitHub Actions has Docker pre-installed — compose file works without modification
- CI secrets provide `OPENROUTER_API_KEY` and `FIRECRAWL_API_KEY`
- CI env var `CI=true` auto-confirms all prompts

### Modular Extension Pattern

Adding a future tier (e.g., Tier 5 for S3):
1. Create `scripts/services/s3-manager.ts` implementing `ServiceManager`
2. Add entry to `tier-registry.ts`
3. Create `tests/e2e/tier5/` with test files
4. No changes to orchestrator
