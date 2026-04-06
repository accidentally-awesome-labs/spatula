# Tier 5: Queue/Worker Integration & API Security Testing Design

**Status:** Draft
**Created:** 2026-04-05
**Scope:** End-to-end testing of the async job processing pipeline (BullMQ workers, export processing, webhook delivery, DLQ) and API security/middleware layer (auth providers, scopes, multi-tenant isolation, CORS, idempotency, rate limiting, error consistency).

---

## 1. Overview

Tier 4 tests API routes with stubbed workers. Tier 5 closes the two biggest remaining gaps:

- **5A: Queue/Worker Integration** — The full async pipeline: API creates job → BullMQ dispatches to workers → workers process (crawl/extract/evolve/reconcile/export) → job state transitions → webhooks fire → DLQ captures failures. Workers run in-process with mock Ollama + fixture server.
- **5B: API Middleware & Security** — Auth providers (API key with scopes), multi-tenant data isolation, CORS, idempotency, rate limiting (actual 429), error response format consistency, security headers, audit logging, OpenAPI spec validation.

**Strategy:** Both sub-specs share Docker infrastructure (Postgres + Redis) from Tier 4. 5A additionally starts BullMQ workers in-process. 5B uses `app.request()` only (no workers). They are designed and implemented separately.

---

## 2. Sub-Spec 5A: Queue/Worker Integration

### 2.1 Infrastructure

**Reuses from Tier 4:** Docker Postgres (port 5433) + Docker Redis (port 6380).

**New:** BullMQ workers started in-process via `new Worker(queueName, processor, { connection })`.

**Worker dependencies:** The `WorkerDeps` interface requires ~20 fields:
- **Real (from Postgres):** All repository instances (jobRepo, schemaRepo, entityRepo, taskRepo, extractionRepo, actionRepo, entitySourceRepo, sourceTrustRepo, exportRepo, tenantRepo, pageRepo)
- **Real (from Redis):** BullMQ queues via `createQueues({ host, port, maxRetriesPerRequest: null })`
- **Real (from Tier 2 infrastructure):** Fixture HTTP server (serves HTML pages), mock Ollama (canned LLM responses)
- **Real (local):** `LocalContentStore` pointed at temp dir, `RobotsTxtChecker`, `InMemoryDomainRateLimiter`
- **From mock Ollama:** `PageClassifier`, `StaticExtractor`, `SchemaEvolverImpl`, `DataReconcilerImpl`, `LLMLinkEvaluator`

This is essentially the Tier 2 `buildPipelineRunner` deps, but wired into BullMQ workers instead of `LocalPipelineRunner`.

### 2.2 Test Helper: `startTestWorkers()`

Creates and starts 6 BullMQ workers in-process:

```typescript
export interface TestWorkerHarness {
  workers: Worker[];
  queues: SpatulaQueues;
  fixtureServer: FixtureServer;
  mockOllama: MockOllamaServer;
  webhookReceiver: WebhookReceiver;
  closeAll(): Promise<void>;
}

export async function startTestWorkers(opts: {
  databaseUrl: string;
  redisUrl: string;
}): Promise<TestWorkerHarness>;
```

Implementation:
1. Start fixture server (from Tier 2) + mock Ollama (from Tier 2)
2. Create Postgres pool + all repository instances
3. Create Redis connection with `maxRetriesPerRequest: null`
4. Create `SpatulaQueues` via `createQueues()`
5. Build LLM components from mock Ollama (same as Tier 2 helpers)
6. Create Playwright crawler (or skip with mock if not available)
7. Start 5 workers (crawl, schema-evolution, reconciliation, export, webhook) with concurrency 1. Note: there is no separate extract worker — extraction is performed inline by the crawl worker.
8. Create webhook Worker directly (not via `createWebhookWorker()` which hardcodes backoff) with `backoff: { type: 'fixed', delay: 0 }` for fast test execution.
9. Start webhook receiver
10. Return harness with `closeAll()` that stops workers → closes queues → closes crawler → closes Redis → closes pool

**Completion polling helper:**
```typescript
export async function waitForJobStatus(
  jobRepo: JobRepository,
  jobId: string,
  tenantId: string,
  targetStatuses: string[],
  timeoutMs: number = 60_000,
): Promise<string>;
```
Polls every 500ms until job reaches one of `targetStatuses`, throws on timeout.

**Note on `isValidCrawlUrl()`:** This function only filters child links discovered during crawling, NOT seed URLs. `JobManager.startJob()` enqueues seed URLs directly to BullMQ without calling `isValidCrawlUrl()`. The fixture server's localhost URL will be crawled as the seed URL without issues. Child links from the fixture pages pointing to localhost will be filtered out — this is acceptable for testing (the seed pages themselves are crawled).

### 2.3 Tests (23)

**Job Lifecycle (5):**

| # | Test | Assertion |
|---|------|-----------|
| 1 | Create job via API → start → workers begin processing | Poll job status until 'running'. Verify crawl queue has pending jobs. |
| 2 | Job completes after all pages crawled and reconciled | Poll until status 'completed'. Verify `totalPages > 0` in job stats. |
| 3 | Entities created by workers visible via entity API | After completion, `GET /api/v1/jobs/{id}/entities` returns entities with mergedData. |
| 4 | Schema discovered by workers visible via schema API | `GET /api/v1/jobs/{id}/schema` returns schema with fields beyond user-defined. |
| 5 | Pause job → worker stops → resume → continues | Start job, poll until running, pause (PATCH), verify status 'paused', resume (PATCH), poll until completed. |

**Export Processing (3):**

| # | Test | Assertion |
|---|------|-----------|
| 6 | Create export via API → worker processes → completed | POST export, poll export status until 'completed', verify entityCount > 0. |
| 7 | Download completed export returns file content | GET download endpoint returns non-empty content with correct content-type. |
| 8 | Export with min-quality filter produces fewer entities | Create export with `minQuality: 0.8`, verify entityCount < total. |

**Webhook Delivery (3):**

| # | Test | Assertion |
|---|------|-----------|
| 9 | Job with webhook config → job completes → receiver gets POST | Create job with `webhooks: { url, events: ['job.completed'] }`, complete job, `webhookReceiver.waitForRequest()`. |
| 10 | Webhook event has correct type and data | Verify `body.type === 'job.completed'`, `body.data.jobId` matches, `body.data.entityCount > 0`. |
| 11 | Webhook has `X-Spatula-Signature` with secret | Create job with webhook secret, verify receiver request has `X-Spatula-Signature` header, verify HMAC-SHA256 matches. |

**Dead Letter Queue (3):**

| # | Test | Assertion |
|---|------|-----------|
| 12 | Job that fails all retries appears in DLQ | **Note:** The crawl worker catches all errors and returns normally — BullMQ never sees a failure for crawl jobs. Instead, test DLQ with a dedicated test worker: create a minimal BullMQ worker on a test queue that deliberately throws on every invocation. After retry exhaustion (configure 1 attempt), verify the DLQ handler inserts an entry. Then `GET /admin/dlq` returns the entry. This tests the DLQ plumbing without depending on production workers failing. |
| 13 | DLQ retry re-enqueues to original queue | POST `/admin/dlq/:id/retry` → entry status becomes 'resolved' (resolution: 'retried'), job re-appears in queue. |
| 14 | DLQ discard marks as resolved | POST `/admin/dlq/:id/discard` → entry resolution is 'discarded'. |

**State Machine (3):**

| # | Test | Assertion |
|---|------|-----------|
| 15 | Invalid state transition rejected | Try to transition completed job to 'running' → error response. |
| 16 | Cancel running job → workers stop | Start job, cancel via API, verify status 'cancelled', no new crawl tasks processed after cancel. |
| 17 | Concurrent job quota enforced | Start 2 jobs (default quota = 2), try to start 3rd → rejected with quota error. |

**Graceful Shutdown (2):**

| # | Test | Assertion |
|---|------|-----------|
| 18 | Worker close mid-job → finishes current, no orphans | Start job, wait for 1 crawl task to begin processing, call `worker.close()`, verify the in-progress task completes, no tasks left with `in_progress` status. |
| 19 | Config diff re-run → only new URLs crawled | Complete a job, add a new seed URL to the config, re-create and start a new job, verify only the new URL is crawled (check fixture server request log). |

**Infrastructure Verification (3):**

| # | Test | Assertion |
|---|------|-----------|
| 20 | WebSocket token endpoint returns valid token | `POST /api/v1/ws-token` → 200, token string present, verify token key exists in Redis with correct TTL. |
| 21 | Worker heartbeat present in Redis | After starting workers, check Redis for heartbeat key matching `worker:heartbeat:*`. Verify it contains queue list and timestamp. |
| 22 | Audit log entries for job lifecycle | After job create/start/cancel, query audit log table, verify entries exist with correct `action` values (job.created, job.started, job.cancelled). |

**Database Migration (1):**

| # | Test | Assertion |
|---|------|-----------|
| 23 | Migration preserves existing data | Insert test data directly via SQL, run `runMigrations()` again (idempotent), verify data is still present and queryable. |

### 2.4 DLQ Testing Strategy

The crawl worker catches all errors internally and never throws — BullMQ retry/DLQ mechanisms are bypassed for crawl jobs. To test the DLQ plumbing, the test creates a dedicated test BullMQ worker on a temporary queue (`spatula.test-dlq`) with a processor that deliberately `throw new Error('test failure')`. Configure the queue with `attempts: 1` (no retries). When the job fails, the DLQ handler inserts an entry. This verifies the full DLQ flow (handler → database → admin API) without depending on any production worker's error behavior.

**Note:** This may also indicate a production concern — if crawl workers silently swallow all errors, BullMQ's retry mechanism is never used for crawl failures. This is a separate investigation, not a testing concern.

---

## 3. Sub-Spec 5B: API Middleware & Security

### 3.1 Infrastructure

**Reuses from Tier 4:** Docker Postgres + Redis, `createTestApp()` helper.

**New:** The `createTestApp()` helper needs to accept an auth strategy parameter:

```typescript
export async function createTestApp(opts?: {
  authStrategy?: 'none' | 'api-key';
}): Promise<TestApp | null>;
```

For `auth-strategy: 'api-key'`, the helper must provide a real `ApiKeyRepository` and create the app with `AUTH_STRATEGY=api-key`. The auth middleware will then validate bearer tokens against the database.

**API Key Bootstrap Sequence (chicken-and-egg):** The `/api/v1/api-keys` route requires `keys:manage` scope, but you need a key to authenticate. Solution:
1. Create tenant via `POST /api/v1/tenants` (unauthenticated — auth middleware skips this path)
2. Insert the first API key directly into the database via `apiKeyRepo.create({ tenantId, keyHash: sha256(rawKey), keyPrefix: rawKey.slice(0,8), name: 'test-admin', scopes: ['admin'] })`
3. Use that raw key value as `Authorization: Bearer <key>` in subsequent requests

The 5B helpers should provide `createApiKeyDirectly(db, tenantId, scopes)` which handles hashing and insertion, returning `{ rawKey, keyId }`.

For multi-tenant tests, two separate tenants are created, each with their own API key.

**No workers needed** — all tests use `app.request()`.

### 3.2 Tests (33)

**API Key Authentication (4):**

| # | Test | Assertion |
|---|------|-----------|
| 1 | Create API key → returns key string and id | POST `/api/v1/api-keys` with admin auth → 201, response has `key` and `id` fields. |
| 2 | Authenticate with valid API key | GET `/api/v1/jobs` with `Authorization: Bearer <key>` → 200, `x-tenant-id` not required (derived from key). |
| 3 | Authenticate with revoked key → 401 | Delete key via API, then use it → 401. |
| 4 | Authenticate with malformed token → 401 | `Authorization: Bearer garbage123` → 401 with error format. |

**Scope Enforcement (4):**

| # | Test | Assertion |
|---|------|-----------|
| 5 | Key with `jobs:read` → GET jobs succeeds | 200 |
| 6 | Key with `jobs:read` → POST jobs rejected | 403 with "requires jobs:write" |
| 7 | Key with `admin` scope → all endpoints succeed | Admin bypasses all scope checks. |
| 8 | Key with empty scopes → all write endpoints rejected | 403 on every write endpoint. |

**Multi-Tenant Isolation (3):**

| # | Test | Assertion |
|---|------|-----------|
| 9 | Tenant A data invisible to Tenant B | Create job in A, list jobs from B → empty. |
| 10 | Tenant A job → Tenant B GET by ID → 404 | Cross-tenant job access returns not found. |
| 11 | Tenant A action → Tenant B approve → 404 | Cross-tenant action modification returns not found. |

**CORS (3):**

| # | Test | Assertion |
|---|------|-----------|
| 12 | Preflight from allowed origin → correct headers | OPTIONS request with `Origin: http://localhost:3000` → `Access-Control-Allow-Origin` present. |
| 13 | Preflight from disallowed origin → no ACAO header | OPTIONS with `Origin: https://evil.com` → no `Access-Control-Allow-Origin`. |
| 14 | Response exposes rate limit and request-id headers | Check `Access-Control-Expose-Headers` includes `X-RateLimit-Limit`, `X-Request-Id`. |

**Idempotency (4):**

| # | Test | Assertion |
|---|------|-----------|
| 15 | POST with `Idempotency-Key` → 201 | First call creates resource normally. |
| 16 | Same key again → cached 201 (no duplicate created) | Second call returns same response, list shows only 1 resource. |
| 17 | Same key, different body → cached response (body ignored) | Third call with different body returns original cached response. |
| 18 | Idempotency only applies to POST/PATCH | DELETE with `Idempotency-Key` header → key is ignored (middleware skips non-POST/PATCH methods). Same DELETE again → executes normally (404 since resource was deleted). Verifies the middleware's method filter. |

**Rate Limiting (2):**

| # | Test | Assertion |
|---|------|-----------|
| 19 | 61 rapid requests → 61st returns 429 | Free tier = 60/min. Send 61 GETs. Last response has status 429, `Retry-After: 60`, `X-RateLimit-Remaining: 0`. |
| 20 | Rate limit per-tenant | Tenant A hits limit, Tenant B still succeeds. |

**Error Response Consistency (5):**

| # | Test | Assertion |
|---|------|-----------|
| 21 | 400 validation error format | POST job with invalid body → `{ error: { code: 'VALIDATION_ERROR', message: '...' } }`. |
| 22 | 404 not found format | GET nonexistent job → `{ error: { code: 'NOT_FOUND', message: '...' } }`. |
| 23 | 409 conflict format | DLQ discard on already-resolved entry → `{ error: { code: '...', message: '...' } }`. |
| 24 | 500 unhandled exception format | Stub a repo method to throw, make request → `{ error: { code: 'INTERNAL_ERROR', message: '...' } }`. |
| 25 | POST with wrong Content-Type | Send `Content-Type: text/plain` → 400 or 415. |

**Pagination Edge Cases (2):**

| # | Test | Assertion |
|---|------|-----------|
| 26 | Zero or negative limit → 400 | GET `/api/v1/jobs?limit=0` → validation error. |
| 27 | Offset beyond total → 200 with empty data | GET with large offset → `{ data: [], total: N }` where N is actual count. |

**Security Headers & Request ID (2):**

| # | Test | Assertion |
|---|------|-----------|
| 28 | Security headers present | Any response has `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. |
| 29 | `X-Request-Id` header present | Any response has `X-Request-Id` with a UUID-like value. |

**Audit Logging (2):**

| # | Test | Assertion |
|---|------|-----------|
| 30 | Successful auth → `auth.login_success` audit entry | After authenticated request, query audit log table for the event. |
| 31 | Failed auth → `auth.login_failure` audit entry | After 401 response, query audit log for failure event with IP address. |

**Tenant Header Validation (1):**

| # | Test | Assertion |
|---|------|-----------|
| 32 | Empty or invalid UUID in `x-tenant-id` → 400/401 | `x-tenant-id: ''` and `x-tenant-id: not-a-uuid` both rejected. |

**OpenAPI Spec (1):**

| # | Test | Assertion |
|---|------|-----------|
| 33 | `/api/openapi.json` returns valid spec | Response is valid JSON with `paths` object containing all registered route paths. Spot-check: `/api/v1/jobs` path exists with GET and POST operations. |

---

## 4. File Structure

```
apps/cli/tests/e2e/tier5/
  tier5a/
    helpers.ts                          ← startTestWorkers, waitForJobStatus, completion polling
    job-lifecycle.test.ts               ← Tests 1-5 (job create/complete/entities/schema/pause-resume)
    export-processing.test.ts           ← Tests 6-8 (export via worker)
    webhook-delivery.test.ts            ← Tests 9-11 (webhook via queue)
    dlq.test.ts                         ← Tests 12-14 (dead letter queue)
    state-machine.test.ts               ← Tests 15-17 (transitions, cancel, quota)
    worker-lifecycle.test.ts            ← Tests 18-22 (shutdown, re-run, ws-token, heartbeat, audit)
    migration.test.ts                   ← Test 23 (migration preserves data)
  tier5b/
    helpers.ts                          ← createTestAppWithAuth, createApiKey, createTenantPair
    auth-and-scopes.test.ts             ← Tests 1-8 (API key auth + scope enforcement)
    multi-tenant.test.ts                ← Tests 9-11 (tenant isolation)
    cors.test.ts                        ← Tests 12-14 (CORS headers)
    idempotency.test.ts                 ← Tests 15-18 (idempotency middleware)
    rate-limiting.test.ts               ← Tests 19-20 (429 + per-tenant)
    error-consistency.test.ts           ← Tests 21-25 (error formats)
    pagination-and-headers.test.ts      ← Tests 26-29 (pagination, security headers, request-id)
    audit-and-validation.test.ts        ← Tests 30-33 (audit logging, tenant header, OpenAPI)
```

### Modified files

| File | Change |
|------|--------|
| `apps/cli/tests/e2e/tier4/helpers.ts` | Accept optional `authStrategy` parameter in `createTestApp()` |
| `apps/cli/scripts/tier-registry.ts` | Add Tier 5A and 5B definitions |
| `apps/cli/package.json` | Add `@spatula/queue` as devDependency; add `test:tier5a`, `test:tier5b`, `test:tier5` scripts |
| `packages/queue/src/index.ts` | Export `createWebhookWorker` (currently not exported from barrel) |

---

## 5. Tier Registry Updates

```typescript
'5a': {
  name: 'Queue/Worker Integration',
  description: 'Tier 4 + BullMQ workers processing jobs end-to-end',
  extends: '4',
  services: ['ollama', 'docker-postgres', 'docker-redis'],
  globs: ['tests/e2e/tier5/tier5a/'],
},
'5b': {
  name: 'API Security & Middleware',
  description: 'Tier 4 + auth providers, scopes, CORS, idempotency, rate limiting',
  extends: '4',
  services: ['docker-postgres', 'docker-redis'],
  globs: ['tests/e2e/tier5/tier5b/'],
},
'5': {
  name: 'Full Server Integration',
  description: 'All Tier 5 tests (5A + 5B)',
  extends: '4',
  services: ['ollama', 'docker-postgres', 'docker-redis'],
  globs: ['tests/e2e/tier5/'],
},
```

---

## 6. Test Counts and Runtime

| Sub-spec | File | Tests | Needs Workers | Est. Runtime |
|----------|------|-------|--------------|-------------|
| **5A** | job-lifecycle.test.ts | 5 | Yes | ~30s |
| **5A** | export-processing.test.ts | 3 | Yes | ~15s |
| **5A** | webhook-delivery.test.ts | 3 | Yes | ~10s |
| **5A** | dlq.test.ts | 3 | Yes | ~15s |
| **5A** | state-machine.test.ts | 3 | Yes | ~10s |
| **5A** | worker-lifecycle.test.ts | 5 | Yes | ~20s |
| **5A** | migration.test.ts | 1 | No | ~3s |
| **5B** | auth-and-scopes.test.ts | 8 | No | ~5s |
| **5B** | multi-tenant.test.ts | 3 | No | ~3s |
| **5B** | cors.test.ts | 3 | No | ~2s |
| **5B** | idempotency.test.ts | 4 | No | ~3s |
| **5B** | rate-limiting.test.ts | 2 | No | ~5s |
| **5B** | error-consistency.test.ts | 5 | No | ~3s |
| **5B** | pagination-and-headers.test.ts | 4 | No | ~2s |
| **5B** | audit-and-validation.test.ts | 4 | No | ~3s |
| | **Total** | **56** | | **~130s** |

**Combined with previous tiers:**

| Tier | Tests | Cumulative |
|------|-------|-----------|
| 1 | 514 | 514 |
| 2 | 43 | 557 |
| 3 | 6 | 563 |
| 4 | 34 | 597 |
| 5A | 23 | 620 |
| 5B | 33 | 653 |
| Binary | 18 | 671 |

---

## 7. Infrastructure Notes

### Worker Configuration for Tests

- All workers: concurrency 1 (predictable ordering)
- Webhook worker: zero-delay retry (`backoff: { type: 'fixed', delay: 0 }`) for fast test execution
- Crawl worker: mock Ollama for LLM, fixture server for HTML pages
- `isValidCrawlUrl()` blocks localhost — seed tasks directly via `taskRepo.enqueue()` instead of relying on `JobManager.startJob()` to enqueue seeds

### Completion Polling

All async tests use polling with timeout:
```typescript
await waitForJobStatus(jobRepo, jobId, tenantId, ['completed', 'failed'], 60_000);
```
Poll interval: 500ms. Timeout: 60s (configurable).

### Redis Cleanup

`FLUSHDB` on database 1 (test database) in `beforeAll` of each test file. This prevents stale BullMQ jobs from previous runs from interfering.

### Auth Strategy Switching

5B tests need `AUTH_STRATEGY=api-key` while 5A tests use `AUTH_STRATEGY=none`. Since auth strategy is read from env in `createApp()`, the helpers set `process.env.AUTH_STRATEGY` before creating the app. Each test file creates its own app instance, so there's no cross-file contamination.

### DLQ Testing: `/crash` Route

The fixture server gets a new route:
```
GET /crash → 200, Content-Type: application/octet-stream, body: binary garbage
```
The crawl worker fetches this, the HTML parser throws on the binary content, the worker fails, retries exhaust, entry lands in DLQ.

### Rate Limit Testing

The rate limit test sends 61 sequential requests. At free tier (60/min), the 61st should return 429. The test must use a single tenant's auth headers for all 61 requests. To avoid polluting other tests, this test uses its own tenant.

### Multi-Tenant Test Setup

Create two tenants (A and B), each with their own API key. Seed data in A. Verify B cannot access A's data. Both tenants use `AUTH_STRATEGY=api-key` auth.

### Audit Log Querying

Audit events are written asynchronously via `setImmediate()`. Tests must wait briefly (100ms) after the request before querying the audit log table to ensure the async write completes.

### JWT Testing: Deferred

JWT auth testing is deferred. It requires generating key pairs, running a JWKS endpoint, and signing tokens. The auth middleware code path is the same for all providers — the API key tests cover the pipeline. JWT-specific behavior (JWKS fetching, token claims) is better tested as a unit test of `JwtAuthProvider`.

---

## 8. Service Manager Additions

No new service managers needed. Tier 5A uses `ollama` + `docker-postgres` + `docker-redis` (all existing). Tier 5B uses `docker-postgres` + `docker-redis` only.

The `startTestWorkers()` helper is test-file-level infrastructure (not a service manager) because it depends on test-specific configuration (mock Ollama, fixture server) that varies per test.
