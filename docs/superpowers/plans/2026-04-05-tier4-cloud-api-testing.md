# Tier 4: Cloud API & Server Integration Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a modular test tier system with Docker-backed API server tests, OpenRouter LLM integration tests, and Firecrawl crawling tests — all with graceful skip when prerequisites are missing.

**Architecture:** Refactor the test orchestrator into a pluggable service manager system with declarative tier definitions. Docker Compose provides Postgres + Redis. API routes are tested via Hono's `app.request()` (no HTTP server needed). OpenRouter and Firecrawl tests use real API keys with budget caps. Each test file independently checks its prerequisites.

**Tech Stack:** TypeScript, Vitest, Docker Compose, Hono `app.request()`, `@spatula/db` Drizzle migrations, `@spatula/api` `createApp()`, OpenRouter API, Firecrawl SDK

**Spec:** `docs/superpowers/specs/2026-04-05-tier4-cloud-api-testing-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `apps/cli/scripts/services/service-manager.ts` | ServiceManager interface + ServiceRegistry class |
| `apps/cli/scripts/services/ollama-manager.ts` | Ollama lifecycle (refactored from existing) |
| `apps/cli/scripts/services/docker-manager.ts` | Docker Compose lifecycle for Postgres + Redis |
| `apps/cli/scripts/services/openrouter-manager.ts` | API key validation |
| `apps/cli/scripts/services/firecrawl-manager.ts` | API key check |
| `apps/cli/scripts/tier-registry.ts` | Declarative tier definitions |
| `apps/cli/tests/e2e/tier4/docker-compose.yml` | Postgres (5433) + Redis (6380) |
| `apps/cli/tests/e2e/tier4/.env.test.example` | API key template |
| `apps/cli/tests/e2e/tier4/helpers.ts` | createTestApp, createTenant, seedJobWithData, webhook receiver |
| `apps/cli/tests/e2e/tier4/api-lifecycle.test.ts` | 23 API route tests |
| `apps/cli/tests/e2e/tier4/openrouter-integration.test.ts` | 6 OpenRouter tests |
| `apps/cli/tests/e2e/tier4/firecrawl-integration.test.ts` | 5 Firecrawl tests |

### Modified files

| File | Change |
|------|--------|
| `apps/cli/scripts/test-tiers.ts` | Refactor to use ServiceRegistry + tier-registry |
| `apps/cli/package.json` | Add `@spatula/api` devDependency, add `test:tier4` script |

---

## Task 1: Service Manager Interface + Registry

**Files:**
- Create: `apps/cli/scripts/services/service-manager.ts`

- [ ] **Step 1: Create the service manager interface and registry**

Create `apps/cli/scripts/services/service-manager.ts` exporting:

- `ServiceStatus` interface: `{ available: boolean; version?: string; details: Record<string, unknown> }`
- `ProvisionOpts` interface: `{ autoYes: boolean }`
- `ServiceContext` interface: `{ services: Record<string, Record<string, unknown>>; autoYes: boolean; envVars: Record<string, string> }`
- `ServiceHandle` interface: `{ stop(): Promise<void>; connectionInfo: Record<string, unknown>; envVars: Record<string, string> }`
- `ServiceManager` interface: `{ name: string; dependsOn?: string[]; check(): Promise<ServiceStatus>; provision(opts: ProvisionOpts): Promise<boolean>; start(context: ServiceContext): Promise<ServiceHandle>; healthCheck(): Promise<boolean> }`
- `ServiceRegistry` class with:
  - `register(manager)` — stores by name
  - `get(name)` — retrieves or throws
  - `resolveStartOrder(names)` — topological sort via DFS on `dependsOn`
  - `startAll(names, opts)` — iterates in order, calls check → provision → start, accumulates envVars and connectionInfo, returns `{ handles, envVars, stopAll() }`

- [ ] **Step 2: Commit**

```bash
git add apps/cli/scripts/services/service-manager.ts
git commit -m "feat: add ServiceManager interface and ServiceRegistry"
```

---

## Task 2: Refactor Ollama Manager

**Files:**
- Create: `apps/cli/scripts/services/ollama-manager.ts`

- [ ] **Step 1: Create Ollama ServiceManager wrapper**

Create `apps/cli/scripts/services/ollama-manager.ts`. This class wraps the existing `createOllamaManager()` from `../ollama-manager.js` and adapts it to the `ServiceManager` interface.

Constructor accepts `{ model: string }` for model-specific operations. The `provision()` method calls `inner.ensureInstalled()`. The `start()` method calls `inner.ensureServing()` then `inner.ensureModel()`. Returns `envVars: { OLLAMA_BASE_URL: 'http://localhost:11434' }`.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/scripts/services/ollama-manager.ts
git commit -m "feat: refactor Ollama manager into ServiceManager interface"
```

---

## Task 3: Docker Manager + Compose File

**Files:**
- Create: `apps/cli/scripts/services/docker-manager.ts`
- Create: `apps/cli/tests/e2e/tier4/docker-compose.yml`

- [ ] **Step 1: Create docker-compose.yml**

Create `apps/cli/tests/e2e/tier4/docker-compose.yml` with:
- Postgres 16-alpine on port 5433, healthcheck via `pg_isready`, tmpfs for data (RAM disk)
- Redis 7-alpine on port 6380, healthcheck via `redis-cli ping`
- Both with configurable ports via env vars (`TEST_POSTGRES_PORT`, `TEST_REDIS_PORT`)

- [ ] **Step 2: Create Docker service managers**

Create `apps/cli/scripts/services/docker-manager.ts` with two classes:

**`DockerPostgresManager`**: Uses `execFileSync` (not `exec`) for all Docker commands to avoid shell injection. The `start()` method:
1. Generates random project name `spatula-test-<8-char-random>`
2. Runs `docker compose -p <name> -f <compose-path> up -d postgres` via `execFileSync('docker', ['compose', '-p', name, '-f', path, 'up', '-d', 'postgres'])`
3. Polls Docker health status every 1s, 30s timeout
4. Runs `runMigrations(connectionString)` from `@spatula/db`
5. Returns `envVars: { DATABASE_URL: 'postgres://spatula:spatula_test@localhost:5433/spatula_test' }`

**`DockerRedisManager`**: Same pattern but for Redis. The `start()` method flushes database 1 (not default 0) via ioredis `SELECT 1` + `FLUSHDB`. Returns `envVars: { REDIS_URL: 'redis://localhost:6380/1' }`.

Both share a `isDockerAvailable()` helper that checks `docker info` + `docker compose version` via `execFileSync`.

**Security note:** All subprocess calls use `execFileSync` (not `exec`) to prevent shell injection. Arguments are passed as arrays, not interpolated strings.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/scripts/services/docker-manager.ts apps/cli/tests/e2e/tier4/docker-compose.yml
git commit -m "feat: add Docker service managers for Postgres and Redis"
```

---

## Task 4: OpenRouter + Firecrawl Managers + .env.test.example

**Files:**
- Create: `apps/cli/scripts/services/openrouter-manager.ts`
- Create: `apps/cli/scripts/services/firecrawl-manager.ts`
- Create: `apps/cli/tests/e2e/tier4/.env.test.example`

- [ ] **Step 1: Create OpenRouter manager**

Simple key-check manager. `check()` returns `{ available: !!process.env.OPENROUTER_API_KEY }`. `start()` validates the key with a `fetch` to `https://openrouter.ai/api/v1/models`. Returns `envVars: { OPENROUTER_API_KEY }`.

- [ ] **Step 2: Create Firecrawl manager**

Same pattern. `check()` returns `{ available: !!process.env.FIRECRAWL_API_KEY }`. `start()` returns `envVars: { FIRECRAWL_API_KEY }`.

- [ ] **Step 3: Create .env.test.example**

Template file with comments explaining each key.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/scripts/services/openrouter-manager.ts apps/cli/scripts/services/firecrawl-manager.ts apps/cli/tests/e2e/tier4/.env.test.example
git commit -m "feat: add OpenRouter and Firecrawl service managers"
```

---

## Task 5: Tier Registry + Orchestrator Refactoring

**Files:**
- Create: `apps/cli/scripts/tier-registry.ts`
- Modify: `apps/cli/scripts/test-tiers.ts`

- [ ] **Step 1: Create tier registry**

Create `apps/cli/scripts/tier-registry.ts` with:
- `TierDefinition` interface: `{ name, description, extends?, services, globs, budgetCap?, skipIfMissing? }`
- `TIERS` record with entries for tiers 1-4, ci, binary, all
- `resolveGlobs(tierKey)` — walks extends chain, merges globs
- `resolveServices(tierKey)` — walks extends chain, deduplicates services

- [ ] **Step 2: Refactor test-tiers.ts**

Rewrite to use ServiceRegistry + tier-registry:
1. Parse args (same CLI interface: `--tier`, `--model`, `--yes`, `--timeout`)
2. Load `.env.test` via simple line parser (no `dotenv` dependency)
3. Resolve tier → services + globs
4. Create ServiceRegistry, register all 5 managers
5. Call `registry.startAll(services, { autoYes })`
6. Run vitest with resolved globs + injected env vars
7. `stopAll()` in finally block
8. Print summary

Preserve existing SIGINT/SIGTERM handlers.

- [ ] **Step 3: Verify backward compatibility**

Run: `cd /Users/salar/Projects/spatula/apps/cli && npx tsx scripts/test-tiers.ts --tier=1`
Expected: All Tier 1 tests pass (same behavior as before).

Run: `npx tsx scripts/test-tiers.ts --tier=2`
Expected: All Tier 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/scripts/tier-registry.ts apps/cli/scripts/test-tiers.ts
git commit -m "refactor: modular test orchestrator with ServiceRegistry and tier-registry"
```

---

## Task 6: Tier 4 Test Helpers + devDependency

**Files:**
- Create: `apps/cli/tests/e2e/tier4/helpers.ts`
- Modify: `apps/cli/package.json`

- [ ] **Step 1: Add @spatula/api devDependency**

In `apps/cli/package.json`, add `"@spatula/api": "workspace:*"` to `devDependencies`.
Run `pnpm install` to update lockfile.

- [ ] **Step 2: Create Tier 4 test helpers**

Create `apps/cli/tests/e2e/tier4/helpers.ts` exporting:

**`createTestApp()`**: Constructs the Hono app with real Postgres repos + stubbed workers:
- Real: `dbPool`, all repository instances (`jobRepo`, `schemaRepo`, `entityRepo`, etc.), `tenantRepo`
- Stubbed: `jobManager` (mock createJob/startJob/etc.), `exportQueue` (mock add), `contentStore` (mock store/retrieve/delete)
- Sets `AUTH_STRATEGY=none` in env before creating app
- Returns `{ app, pool, cleanup() }` or `null` if `DATABASE_URL` not set

**`createTenant(app, name?)`**: POST to `/api/v1/tenants`, returns `{ tenantId }`.

**`authHeaders(tenantId)`**: Returns `{ 'x-tenant-id': tenantId, 'Content-Type': 'application/json' }`.

**`seedJobWithData(pool, tenantId)`**: Inserts a completed job, schema v1, 5 entities, 2 pending actions directly in Postgres. Returns `{ jobId, schemaId, entityIds, actionIds }`.

**`startWebhookReceiver()`**: HTTP server on port 0 collecting POSTs. Returns `{ port, requests, close(), waitForRequest(timeout?) }`.

**`isDockerAvailable()`**: Checks `docker info` + `docker compose version`.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/package.json apps/cli/tests/e2e/tier4/helpers.ts pnpm-lock.yaml
git commit -m "feat: add Tier 4 test helpers with createTestApp and real Postgres deps"
```

---

## Task 7: API Lifecycle Tests

**Files:**
- Create: `apps/cli/tests/e2e/tier4/api-lifecycle.test.ts`

23 tests using `app.request()`. Skip all if `DATABASE_URL` not set.

- [ ] **Step 1: Create the test file**

**Setup:** `beforeAll` calls `createTestApp()` and `createTenant()`. Each test uses `ctx.skip()` if app is null.

**Test groups (23 total):**

Tenant & Auth (2): bootstrap creates tenant (201), missing header rejected

Job CRUD (5): create (201), list, get, start (patch), delete (204 + subsequent 404)

Schema & Entities (3): get schema, list entities (paginated), get entity detail — uses `seedJobWithData()` for pre-existing data

Actions (3): list pending, approve single, batch approve

Export (2): create export (201), get export status

Webhook (2): delivery on event (use webhook receiver), signature header present

Health & Admin (2): GET /health (200), GET /health/ready (200 with checks)

Extractions, Usage, API Keys (3): list extractions, get usage, API key CRUD

Rate Limiting (1): headers present on authenticated requests

Each test:
1. Calls `app.request(path, { method, headers: authHeaders(tenantId), body? })`
2. Checks status code
3. Parses JSON body
4. Asserts on response shape

- [ ] **Step 2: Run tests**

Run: `cd /Users/salar/Projects/spatula/apps/cli && ./node_modules/.bin/vitest run tests/e2e/tier4/api-lifecycle.test.ts`
Expected: All skip (no Docker) or pass (if Docker running).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/e2e/tier4/api-lifecycle.test.ts
git commit -m "test: add 23 API lifecycle tests with real Postgres via app.request()"
```

---

## Task 8: OpenRouter Integration Tests

**Files:**
- Create: `apps/cli/tests/e2e/tier4/openrouter-integration.test.ts`

6 tests. Skip if `OPENROUTER_API_KEY` not set.

- [ ] **Step 1: Create the test file**

Uses `createLLMClient({ provider: 'openrouter', openrouter: { apiKey } })` from `@spatula/core`.
Model: `google/gemini-2.5-flash` (cheapest).

Tests:
1. API key valid — raw fetch to `https://openrouter.ai/api/v1/models` → 200
2. Simple completion — complete("Say hello in one word") → has content
3. JSON mode — complete(jsonMode: true, "Return {greeting}") → parses as JSON
4. Classification prompt — actual PageClassifier system prompt + HTML → parses via Zod
5. Extraction prompt — actual StaticExtractor system prompt + HTML + schema → parses via Zod
6. Token usage — promptTokens > 0, completionTokens > 0

Logs cost after all tests.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/tests/e2e/tier4/openrouter-integration.test.ts
git commit -m "test: add 6 OpenRouter integration tests with real API key"
```

---

## Task 9: Firecrawl Integration Tests

**Files:**
- Create: `apps/cli/tests/e2e/tier4/firecrawl-integration.test.ts`

5 tests. Skip if `FIRECRAWL_API_KEY` not set.

- [ ] **Step 1: Create the test file**

Uses `CrawlerFactory.create({ type: 'firecrawl', firecrawlApiKey })` from `@spatula/core`.
Target: `https://books.toscrape.com/` (stable test site).

Tests:
1. Crawl simple page — HTML contains 'Books to Scrape', status 200
2. Extracts links — links array has entries with `url` field
3. Returns metadata — responseTimeMs > 0, contentLength > 0, crawlerType 'firecrawl'
4. Handles 404 — throws CrawlError or returns 404 status
5. Compare with Playwright (conditional) — crawl same page with both, compare titles. Skip if Playwright unavailable.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/tests/e2e/tier4/firecrawl-integration.test.ts
git commit -m "test: add 5 Firecrawl integration tests with real API key"
```

---

## Task 10: Package.json Scripts + Integration Verification

**Files:**
- Modify: `apps/cli/package.json`

- [ ] **Step 1: Add test:tier4 script**

Add to `apps/cli/package.json` scripts:
```json
"test:tier4": "tsx scripts/test-tiers.ts --tier=4"
```

- [ ] **Step 2: Verify no regression on existing tiers**

Run: `pnpm test:tier1` → all pass
Run: `pnpm test:tier2` → all pass
Run: `pnpm test:ci` → all pass

- [ ] **Step 3: Run Tier 4 (graceful skip expected)**

Run: `pnpm test:tier4 -- --yes`
Expected: API tests skip (no Docker), OpenRouter tests skip (no key), Firecrawl tests skip (no key).

- [ ] **Step 4: Type check**

Run: `pnpm --filter cli exec -- tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/package.json
git commit -m "feat: add test:tier4 script and complete Tier 4 infrastructure"
```
