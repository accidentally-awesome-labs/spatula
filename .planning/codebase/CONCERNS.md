# Codebase Concerns

**Analysis Date:** 2026-05-06

## Tech Debt

### Billing & SaaS Coupling (Wave 5-6 Carve-out)

**Issue:** Stripe billing, metering, and quota enforcement are deeply coupled throughout the OSS repository. Deferred to Wave 6-1 (scheduled but not yet executed).

**Files affected:**
- `apps/api/src/routes/billing.ts`
- `apps/api/src/routes/stripe-webhook.ts`
- `apps/api/src/billing/stripe-client.ts`
- `packages/shared/src/billing/tiers.ts`
- `packages/core/src/billing/quota-enforcer.ts`
- `packages/core/src/billing/billing-usage-recorder.ts`
- `packages/queue/src/metering-worker.ts`
- `packages/db/src/schema/usage-records.ts`
- `packages/queue/src/workers/crawl-worker.ts` (lines 15, 99 — quota checks)
- `packages/core/src/pipeline/export-orchestrator.ts` (line 235 — quota recording)
- `apps/api/src/app.ts` (lines 37-38, 105-117 — billing route mounting + rate limit tier loading)
- `apps/api/src/types.ts` (lines 52-54 — quotaEnforcer, usageRecordRepo, stripeClient in AppDeps)
- `apps/api/src/middleware/rate-limit.ts` (RATE_LIMIT_TIERS lookup)
- `apps/api/src/routes/admin-tenants.ts` (plan/stripeCustomerId fields, usage aggregation)
- `apps/api/src/routes/exports.ts` (quota gating)
- `packages/queue/src/job-manager.ts` (QuotaEnforcer wiring)

**Impact:**
- OSS-only server deployments carry dead Stripe code paths and unused database columns
- Rate limiting is coupled to billing tiers, making it impossible to deploy OSS without tier infrastructure
- Migration squashing (Wave 6-1 Task 12) requires moving ~10 billing migrations out of OSS baseline
- Test suites must run against billing-free version to prove OSS compliance

**Fix approach:**
- Plan: `docs/superpowers/plans/2026-04-20-wave-6-1-carveout-migration-squash.md` (not yet executed)
- Move 17 files to `spatula-saas` repo via `git filter-repo` (Task 1-11)
- Strip billing coupling from 17 remaining files in-place (Tasks 12-22)
- Add `GET /api/v1/auth/me` endpoint to replace billing endpoint for auth verification (Task 23)
- Squash Postgres migrations to v1 baseline; keep separate migration journal for SaaS (Task 24-25)
- Implement test suites to verify OSS/SaaS separation (Tasks 26-27)

**Priority:** HIGH — Blocks open-source release. Scheduled for Wave 6-1, currently deferred.

---

### Deferred Items from Waves 2-5

**Issue:** 10 items deferred from previous waves pending Wave 5-6 implementation. Most are low-risk enhancements; security item is the only high-impact deferral.

**Files & items:**

| Item | Files | Status | Deferral Reason |
|------|-------|--------|-----------------|
| Config diff recursive comparison | `packages/core/src/config/config-differ.ts:195` | Failing test stub | Recursive field comparison wasn't needed for Wave 5; Wave 5-6 Task 1 implements |
| CSS table extraction | `packages/core/src/extraction/css-extractor.ts` | Not implemented | Feature enhancement; deferred while CSS extractor matures. Wave 5-6 Task 2 implements |
| Pull command URL dedup | `apps/cli/src/commands/pull.ts` | Placeholder logic | Crawled URL history lookup unavailable until DataSource exposes task repo (Wave 5-6 Task 3) |
| Crawl history dedup in add command | `apps/cli/src/commands/add.ts` | Stub function | Depends on task repo exposure. Wave 5-6 Task 3 implements `findCompletedUrls()` |
| Security fix: HTTPS enforcement | `apps/api/src/middleware/security-headers.ts` | Missing HSTS | No HSTS/CSP headers; deferred to Wave 5-6 Task 4 |
| Security fix: Rate limit bypass via tunneling | `packages/queue/src/workers/crawl-worker.ts` | Unmitigated risk | No IP origin validation on webhook callbacks; deferred to Wave 5-6 Task 5 |
| Observability: Prometheus gauges | `packages/core/src/metrics/index.ts:46 (TODO)` | Stub implementation | Gauge registration deferred to Wave 5-6 Task 6 |
| Metrics export endpoint | `apps/api/src/routes/metrics.ts` | Not exposed | Prometheus scrape endpoint missing; Wave 5-6 Task 7 implements |
| Query caching layer | `packages/core/src/content-store/query-cache.ts` | Placeholder | Cache eviction strategy deferred; Wave 5-6 includes cache invalidation design |
| Config diff recursion TODO | `packages/core/src/config/config-differ.ts:195` | Comment present | Marked for cleanup; Wave 5-6 Task 1 removes it |

**Plan:** `docs/superpowers/plans/2026-04-09-wave-5-6-deferred-items.md` (authoritatively defines scope & implementation)

**Priority:**
- **HIGH:** Security fixes (HTTPS, rate limit bypass) — currently unmitigated
- **MEDIUM:** Config diff, table extraction, dedup features — user-facing but not blocking
- **LOW:** Observability enhancements — nice-to-have

---

## Known Bugs

### Stale TODO Comments (Wave 4-4 cleanup incomplete)

**Issue:** Two TODO comments remain from Wave 4-4 "Open Source Readiness" plan, which was marked complete but these cleanups were not executed.

**Files:**
- `apps/cli/dist/commands/run.d.ts:16` — "TODO(Wave 3-5 Task 10): Structured file logging — add a Pino file transport"
- (Original source: `apps/cli/src/commands/run.ts` — actual file exists with comment)

**Trigger:** These are marked as "done" in the Wave 4-4 plan but were never removed.

**Workaround:** None needed; comments are in dist/ and not user-facing. Source file cleanup is low priority.

**Priority:** LOW — Documentation debt only, no runtime impact.

---

### Rate Limit Tier Cast Assertion

**Issue:** Unsafe type casting of tenant plan to rate limit tier without validation.

**File:** `apps/api/src/app.ts:111`

**Code:**
```typescript
c.set('rateLimitTier', (tenant as any)?.plan ?? 'free');
```

**Problem:**
- `(tenant as any)` bypasses type checking entirely
- No validation that `tenant.plan` is a valid RATE_LIMIT_TIER key
- If Stripe plan field is corrupted or missing, silently falls back to 'free', allowing free-tier users to access premium endpoints

**Trigger:** Tenant table corruption, migration failure, or external Stripe sync failure

**Impact:** Rate limiting bypass; premium features accessible to free users

**Fix approach:**
```typescript
const validTiers = new Set(['free', 'starter', 'pro', 'enterprise']);
const planTier = tenant?.plan ?? 'free';
c.set('rateLimitTier', validTiers.has(planTier) ? planTier : 'free');
```

**Priority:** MEDIUM — Security issue but mitigated by 'free' fallback; should be fixed in Wave 6-1 as part of billing carve-out.

---

## Security Considerations

### Missing HTTPS Enforcement (HSTS)

**Issue:** No HSTS (HTTP Strict-Transport-Security) or Content-Security-Policy headers. Clients can be downgraded to HTTP.

**File:** `apps/api/src/middleware/security-headers.ts`

**Current headers:** None explicitly set for HSTS

**Risk:** SSL downgrade attacks; man-in-the-middle interception of API calls and authentication tokens

**Current mitigation:** HTTPS enforced at deployment level (Vercel/reverse proxy); browser vendors implement preload lists

**Recommendation:**
1. Add HSTS header in security-headers middleware: `Strict-Transport-Security: max-age=31536000; includeSubDomains`
2. Add CSP header: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`
3. Add X-Frame-Options: `X-Frame-Options: DENY`
4. Wave 5-6 deferred items Task 4 addresses this

**Priority:** MEDIUM — Mitigated by infrastructure; should be hardened at application layer.

---

### Rate Limit Bypass via Webhook Tunneling

**Issue:** No IP origin validation on webhook callbacks. Attackers can bypass rate limiting by making authenticated requests appear to originate from webhook processing paths.

**File:** `packages/queue/src/workers/crawl-worker.ts` (webhook job handling)

**Affected flows:**
- Job status webhooks processed by cleanup-worker
- Export completion webhooks (if enabled)

**Risk:** An attacker with valid auth can trigger high-volume crawl jobs via webhook callbacks, which are not metered through rate limiting middleware

**Current mitigation:** None

**Fix approach:**
1. Validate webhook origin IP against allowlist (configured per tenant or default)
2. Implement webhook signature verification (HMAC-SHA256 of job payload)
3. Log webhook source IPs and flag suspicious patterns
4. Wave 5-6 deferred items Task 5 addresses this

**Priority:** MEDIUM — Requires valid auth; unauthenticated attackers cannot exploit. Should be hardened.

---

### S3 Credentials in AppDeps

**Issue:** S3 access credentials are passed through `AppDeps` and available to all routes with access to deps.

**File:** `packages/core/src/content-store/s3-content-store.ts:18`

**Code:**
```typescript
interface S3Config {
  accessKeyId?: string;
  secretAccessKey?: string;
}
```

**Risk:**
- If a route is compromised or logs deps, credentials are exposed
- No per-tenant credential isolation; all tenants share one S3 bucket
- Credentials visible in error traces if S3 client fails

**Current mitigation:**
- Credentials sourced from environment variables only (not logs)
- S3Client wrapped; credentials not directly accessible in code

**Recommendation:**
1. Use IAM role/IRSA (EC2/Kubernetes) instead of long-lived keys
2. Rotate S3 credentials quarterly; log all rotations
3. Implement per-tenant S3 bucket partitions with per-tenant IAM roles (multi-tenancy hardening)
4. Never log AppDeps in error handlers

**Priority:** LOW-MEDIUM — Mitigated by environment-only sourcing; infrastructure-level risk.

---

### API Key Storage in Database

**Issue:** API keys are hashed before storage, but no rotation policy or expiration.

**File:** `packages/db/src/repositories/api-key-repository.ts`

**Risk:**
- Compromised API key valid indefinitely
- No audit trail of key usage
- Mass-generation attack possible if key creation rate-limiting not enforced

**Current mitigation:**
- Keys hashed with bcrypt
- Lookup by hash only (not plaintext comparison)

**Recommendation:**
1. Implement key expiration (default 90 days, configurable per tenant)
2. Add `lastUsedAt` timestamp to track stale keys
3. Log all key creation, rotation, and usage
4. Implement auto-disable for keys unused >30 days
5. Add `maxUses` limit per key (optional)

**Priority:** LOW — Hashing mitigates; nice-to-have hardening for enterprise deployment.

---

## Performance Bottlenecks

### Large Test Files (Potential Slow Test Suites)

**Issue:** Several test files exceed 1500 lines, suggesting slow test execution or incomplete suite organization.

**Files:**
- `apps/cli/tests/unit/commands/pull.test.ts` (1655 lines) — pull command tests
- `apps/cli/tests/integration/data-commands.test.ts` (1013 lines) — data integration
- `packages/queue/tests/unit/workers/crawl-worker.test.ts` (971 lines) — crawl worker
- `packages/db/tests/unit/project-db/repositories.test.ts` (855 lines) — DB repository tests
- `packages/core/tests/unit/config/config-executor.test.ts` (854 lines) — config execution

**Symptom:** `pnpm test` may take >5-10 minutes; no visible per-test timing

**Cause:** No test sharding or parallelization per file; many redundant mocks/fixtures

**Impact:**
- Slow feedback loop during development
- CI pipeline takes 10-15 minutes for full test suite
- Hard to identify slow individual tests

**Improvement path:**
1. Run `vitest --reporter=verbose` to identify slowest tests
2. Extract common mocks to shared fixtures in `tests/fixtures/`
3. Use `vitest.bench()` for performance-critical paths
4. Shard test execution across multiple workers: `vitest --threads --maxThreads=4`
5. Consider splitting large test files into focused suites (e.g., pull.test.ts → pull-{source,dest,conflict}.test.ts)

**Priority:** LOW — Acceptable for current project size; becomes critical if test suite grows >3000 lines.

---

### LocalPipelineRunner Semaphore (In-Memory Concurrency)

**Issue:** In-memory semaphore used for local crawl concurrency; no spillover to disk or queue when memory pressure occurs.

**File:** `packages/core/src/pipeline/local-pipeline-runner.ts:26`

**Pattern:** `Semaphore` class manages crawl concurrency with configurable `maxConcurrent` (default 5). If system has >100MB content to crawl, memory usage can spike.

**Risk:**
- OOM (out-of-memory) crash if crawled content exceeds available heap
- No backpressure signal to pause crawling
- Content stored in memory before SQLite persists

**Current mitigation:**
- LocalPipelineRunner is for local CLI only; remote jobs use BullMQ
- Default concurrency is conservative (5 concurrent crawls)
- Content flushed to SQLite after each task

**Improvement path:**
1. Implement memory pressure detection: monitor `process.memoryUsage().heapUsed`
2. If heap > 80% capacity, auto-reduce semaphore (reduce maxConcurrent dynamically)
3. Add warning logs when memory pressure detected
4. Document recommended `--concurrency` flag for memory-constrained environments
5. Add `--dry-run --memory-check` flag to estimate crawl memory footprint

**Priority:** LOW — Local mode only; affects power-users on constrained machines. Remote mode scales properly via BullMQ.

---

## Fragile Areas

### Configuration Executor with JSON Deserialization

**Issue:** Config execution involves deserializing job config from JSON without schema validation in critical paths.

**File:** `packages/core/src/config/config-executor.ts:550`

**Pattern:**
```typescript
const fieldValue = jobConfig.fields.find(f => f.name === fieldName);
// No type guard that fieldValue matches FieldDefinition schema
```

**Why fragile:**
- If `jobConfig` JSON from database has malformed field objects, silent failures or type errors occur
- No validation of field type enum ('string' | 'array' | 'object' | ...)
- Nested objects (arrayItemType, objectFields) not validated recursively

**Safe modification:**
1. Add Zod/Yup schema validation at config load time: `configSchema.parse(jobConfig)`
2. Validate in `config-executor.ts:load()` before any field access
3. Log validation errors with full JSON dump for debugging

**Priority:** MEDIUM — Type safety issue; doesn't cause crashes but can cause unexpected behavior with corrupted configs.

---

### ExportOrchestrator Quota Enforcement Without Atomic Transaction

**Issue:** Quota is checked and recorded separately; in-between quota can be exceeded if two exports run concurrently.

**File:** `packages/core/src/pipeline/export-orchestrator.ts:235`

**Code:**
```typescript
// Line 235: Check quota
if (deps.quotaEnforcer && !await deps.quotaEnforcer.check(...)) {
  return { status: 'rejected', reason: 'quota_exceeded' };
}
// ... export runs ...
// Later: Record usage (UNRELATED CALL)
deps.quotaEnforcer.recordUsage(...).catch(...);
```

**Risk:** Two exports can both pass the quota check, then both record usage, exceeding tenant quota

**Trigger:** High concurrency; same tenant with multiple export jobs in flight

**Safe modification:**
1. Combine check + record into single atomic operation: `quotaEnforcer.checkAndRecord()`
2. Or: Use distributed lock (Redis or DB) around check+record pair
3. Or: Defer quota recording to Job completion handler (single write path)

**Priority:** MEDIUM — Risk is real but mitigated by low default export concurrency (1 per job). Should be fixed.

---

### Database Pool Management in Worker Entrypoint

**Issue:** Database pool is created at worker startup but never explicitly closed on graceful shutdown in some paths.

**File:** `packages/queue/src/worker-entrypoint.ts:50, 295`

**Code:**
```typescript
// Line 50: Pool created
const { db, pool } = createDatabasePool();

// Line 295: Pool closed in finally block
} finally {
  await pool.end();
}
```

**Observation:** Pool closing IS implemented correctly in finally block. No actual issue here; included for completeness. The code is safe.

**Priority:** NONE — Already handled correctly.

---

## Scaling Limits

### Single Redis Instance (No Cluster)

**Issue:** Redis is a single instance (redis://localhost:6379). No clustering or replication for HA.

**File:** `.env.example:36`

**Limits:**
- Single point of failure; if Redis down, all job queues stop
- No horizontal scaling of cache/lock operations
- 16GB memory limit (typical VM) caps total queue size + cache

**Trigger:** Production deployment with >100 concurrent jobs, or Redis crashes

**Current capacity:**
- BullMQ can queue ~10k jobs in memory (depends on job size)
- Redis lock operations block while waiting for lock release
- Rate limiter uses Redis counters; 10k concurrent users = 10k keys

**Scaling path:**
1. Deploy Redis Cluster (3+ nodes) for HA and horizontal scaling
2. Implement Redis Sentinel for automatic failover
3. Use Redis connection pooling (already done via ioredis)
4. Monitor Redis memory usage; implement LRU eviction policy
5. Implement circuit-breaker for Redis failures (fallback to in-memory queue for local mode)

**Priority:** MEDIUM — Not urgent for MVP; required for production scale (>1M jobs/day).

---

### SQLite Project Database (Local-Only Scaling)

**Issue:** Local SQLite project databases have no concurrent write guarantees. Writes are serialized; multiple workers on same project conflict.

**File:** `packages/db/src/project-db/connection.ts`

**Problem:**
- SQLite does not support concurrent writers (PRAGMA journal_mode=WAL mitigates but doesn't eliminate)
- CLI local mode is fine (single-threaded)
- Remote mode uses Postgres (proper concurrency)

**Trigger:** Unlikely in practice since project-db is local-only; remote jobs use Postgres. Mixing local+remote jobs on same project can cause lock contention.

**Current mitigation:**
- Local mode is single-process (CLI only)
- Remote mode uses Postgres (no SQLite concurrency issues)
- Project lock acquired before any operation

**Priority:** LOW — By design (local vs remote separation). No action needed.

---

## Dependencies at Risk

### OpenRouter API Outage (LLM Provider)

**Risk:** If OpenRouter (default LLM provider) is unavailable, all extraction and reconciliation halts.

**Impact:** 90% of functionality depends on LLM (extraction, schema evolution, reconciliation, link evaluation, conflict resolution)

**Current mitigation:**
- Ollama provider as fallback (local LLM, slower)
- Circuit breaker on LLM client (`packages/core/src/llm/circuit-breaker.ts`)
- Fallback to non-LLM extraction (CSS-only, limited)

**Scaling path:**
1. Support multiple LLM providers with auto-failover (Anthropic, Google, OpenAI)
2. Implement LLM provider load balancing
3. Cache LLM responses for common patterns (entity matching, normalization)
4. Implement sync local LLM fallback (e.g., Mistral 7B)

**Priority:** MEDIUM — Single point of failure; should diversify providers.

---

### Drizzle ORM Migration Lock Contention

**Issue:** Drizzle migrations run sequentially with a global lock. If multiple API instances start simultaneously, migration lock contention occurs.

**File:** `packages/db/src/migrate.ts`

**Risk:** Migration failures or timeout if >2 API instances start concurrently during deployment rolling restart

**Trigger:** Kubernetes rolling deployment; both old and new pods try to acquire migration lock

**Current mitigation:**
- Lock timeout is generous (30s default)
- Only OSS API migrates (SaaS will have separate DB)

**Scaling path:**
1. Use Drizzle's distributed lock feature (requires external coordination service)
2. Or: Separate migration job that runs before API deployment
3. Or: Accept eventual consistency and skip migration on lock timeout (not recommended)

**Priority:** LOW-MEDIUM — Not urgent for current scale; becomes issue at 10+ API instances.

---

## Missing Critical Features

### No Query Caching for Entities

**Issue:** Every entity query hits the database. No caching layer for expensive queries.

**Files:**
- `packages/db/src/repositories/entity-repository.ts` (no cache wrapper)
- `apps/api/src/routes/entities.ts` (queries entities directly)

**Problem:** Complex filters on 1M+ entities are slow without caching

**Blocks:** High-performance entity browsing; query times >5s for large result sets

**Fix approach:**
1. Wrap EntityRepository with a cache adapter in `packages/core/src/content-store/query-cache.ts`
2. Implement TTL-based cache (1-5 minutes for read-only queries)
3. Add cache invalidation on entity update/insert
4. Wave 5-6 deferred items include partial cache design

**Priority:** MEDIUM — Not blocking MVP; important for scale (>100k entities).

---

### No Structured Logging to File

**Issue:** Logs are stdout only; no persistent file logging for audit or debugging.

**File:** `apps/cli/dist/commands/run.d.ts:16` — TODO comment references this deferral

**Problem:**
- No log history after process exits
- Hard to debug batch jobs or remote jobs (logs lost in Vercel logs)
- No structured JSON logging for log aggregation

**Current mitigation:** Pino logger supports file transport but not wired

**Fix approach:**
1. Add Pino file transport in `apps/cli/src/commands/run.ts`
2. Implement log rotation (max 100MB, keep 10 files = 1GB logs)
3. Store logs in `.spatula/logs/` with timestamps
4. Implement `spatula logs --follow` command to tail files
5. Wave 5-6 deferred items Task 6 includes observability enhancements

**Priority:** LOW — Nice-to-have; stdout logging sufficient for MVP.

---

## Test Coverage Gaps

### Limited Coverage for Migration Safety

**Issue:** No dedicated test suite for Drizzle migration safety. Missing tests for:
- Backfilling data during schema changes
- Rollback safety (down migrations)
- Data type conversions (e.g., string → integer)
- Concurrent migration handling

**Files:**
- `packages/db/drizzle/*.sql` (no automated validation)
- `packages/db/tests/` (no migration-specific tests)

**Risk:** Silent data loss during migration; can corrupt production data

**Trigger:** Complex migration added without testing; e.g., `ALTER TABLE ... DROP COLUMN`

**Safe approach:**
1. Add `tests/migrations/` directory with migration test suite
2. Implement `before/after` snapshot tests for each migration
3. Test rollback (apply migration, then rollback, verify data integrity)
4. Automate migration testing in CI: spin up test DB, apply all migrations, validate schema
5. Require migration review before merge

**Priority:** HIGH — Data integrity risk; should be implemented before next migration.

---

### No E2E Tests for Carve-out Separation

**Issue:** Wave 6-1 (billing carve-out) requires proving OSS-only server still works. Missing test suite for this.

**Files:** None yet; planned in Wave 6-1 Tasks 26-27

**Coverage gap:** No tests verify that:
- Billing routes 404 correctly (not 500)
- Non-billing endpoints work without Stripe client
- Rate limiting works without billing tier lookup
- Private surfaces do NOT appear in OSS deployments

**Fix approach:** Wave 6-1 plan includes:
- `tests/carveout/` — test OSS-only server (billing mocked/disabled)
- `tests/private-contract/` — test private consumer TS types match SaaS API

**Priority:** HIGH for Wave 6-1 execution; currently deferred but essential before release.

---

## Type Safety Issues

### `as any` Casts in Tests (13 occurrences)

**Issue:** Test files use `as any` to bypass type checking. Patterns:
- `mockRepo as any` (entity-cursor.test.ts)
- `S3Client as any` (s3-content-store.test.ts)
- `(tenant as any)?.plan` (app.ts, production code)
- `(err as any).name` (s3-content-store.test.ts)

**Files:**
- `packages/core/tests/unit/pipeline/entity-cursor.test.ts:13` — 3 occurrences
- `packages/core/tests/unit/content-store/s3-content-store.test.ts:31, 73` — 2 occurrences
- `packages/core/tests/unit/llm/openrouter-client.test.ts:18` — 1 occurrence
- `apps/api/src/app.ts:111` — **production code, high risk**

**Problem:**
- Production code cast (`app.ts:111`) masks type errors
- Test casts hide mock correctness; test may pass but fail in production

**Safe approach:**
1. Production: Replace `(tenant as any)?.plan` with proper type guard (see "Rate Limit Tier Cast Assertion" above)
2. Tests: Use proper type definitions; e.g., `mockRepo: Partial<EntityRepository>` instead of `as any`
3. Enable stricter TSConfig: `noImplicitAny: true`, `noUncheckedIndexedAccess: true`

**Priority:** MEDIUM — Type safety debt; should be cleaned up incrementally.

---

## Deferred Implementation Status Summary

| Deferral | Task | Plan | Status | Blocker? |
|----------|------|------|--------|----------|
| Config diff recursion | 1 | Wave 5-6 | Planned | No |
| CSS table extraction | 2 | Wave 5-6 | Planned | No |
| URL dedup (pull) | 3 | Wave 5-6 | Planned | No |
| HTTPS enforcement | 4 | Wave 5-6 | Planned | Yes |
| Rate limit bypass fix | 5 | Wave 5-6 | Planned | Yes |
| Prometheus gauges | 6 | Wave 5-6 | Planned | No |
| Metrics endpoint | 7 | Wave 5-6 | Planned | No |
| Billing carve-out | All | Wave 6-1 | Not yet started | **YES** |
| Migration squashing | 12 | Wave 6-1 | Not yet started | **YES** |
| OSS/SaaS test suites | 26-27 | Wave 6-1 | Not yet started | **YES** |

**Critical blockers for release:**
1. **Wave 6-1 billing carve-out** — Required before public launch (cannot ship Stripe code in OSS)
2. **Security fixes (HTTPS, rate limit bypass)** — Wave 5-6 Tasks 4-5
3. **Migration squashing** — Wave 6-1 Task 12 (cleanup v1 baseline)

---

*Concerns audit: 2026-05-06*
