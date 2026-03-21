# Phase 11e: Operational Robustness — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-grade error handling, configuration validation, structured logging, and full export format coverage (Parquet, DuckDB, SQLite).

**Architecture:** Four independent workstreams that can be parallelized. (1) Error hierarchy adds `retryable` flag to `SpatulaError` and 5 new error types, migrating `InvalidTransitionError` to `StateError`, replacing generic throws in workers, and adding API error status mappings. (2) Config validation adds a Zod-based `AppConfigSchema` with fail-fast startup. (3) Logger context propagation adds `createLoggerWithContext()` and a request-context middleware. (4) Three binary exporters with `ContentStore` binary support, column-type mapper, and export worker/API changes.

**Tech Stack:** TypeScript, Vitest, Pino, Zod, Hono, Drizzle ORM, hyparquet-writer, @duckdb/node-api, better-sqlite3

---

## Prerequisites

- Phase 11a complete (migrations, repositories, E2E)
- Design spec: `docs/superpowers/specs/2026-03-21-phase-11e-operational-robustness-design.md`

## Dependency Graph

```
Task 1 (Error types)  ──> Task 2 (StateError migration) ──> Task 3 (Worker error cleanup + API handler)
Task 4 (Config validation) ── standalone
Task 5 (Logger context) ──> Task 6 (Request context middleware)
Task 7 (Content store binary) ──> Task 8 (Column mapper) ──> Task 9 (SQLite exporter) ──┐
                                                           ──> Task 10 (Parquet exporter) ├──> Task 12 (Export worker + API)
                                                           ──> Task 11 (DuckDB exporter) ──┘
```

- **Wave 1 (parallel):** Tasks 1, 4, 5, 7
- **Wave 2 (parallel):** Tasks 2, 6, 8
- **Wave 3 (parallel):** Tasks 3, 9, 10, 11
- **Wave 4:** Task 12 (needs Tasks 3, 9, 10, 11)

**File overlap note:** Tasks 3 and 6 both modify `crawl-worker.ts` and `export-worker.ts`. Task 6 (Wave 2) runs first (logger migration), then Task 3 (Wave 3) modifies the same files (error cleanup). This ordering is enforced by the wave structure — do not reorder.

## File Map

```
Created:
  apps/api/src/middleware/request-context.ts              — RequestId + context logger middleware
  apps/api/tests/unit/middleware/request-context.test.ts  — Tests for request-context middleware
  packages/core/src/exporters/column-mapper.ts            — Schema field to native column type mapping
  packages/core/src/exporters/parquet-exporter.ts         — Parquet exporter
  packages/core/src/exporters/duckdb-exporter.ts          — DuckDB exporter
  packages/core/src/exporters/sqlite-exporter.ts          — SQLite exporter
  packages/core/tests/unit/exporters/column-mapper.test.ts
  packages/core/tests/unit/exporters/parquet-exporter.test.ts
  packages/core/tests/unit/exporters/duckdb-exporter.test.ts
  packages/core/tests/unit/exporters/sqlite-exporter.test.ts

Modified:
  packages/shared/src/errors.ts                           — retryable on SpatulaError, 5 new error types
  packages/shared/src/config.ts                           — AppConfigSchema, loadConfig(), loadConfigSafe()
  packages/shared/src/logger.ts                           — createLoggerWithContext(), LOG_LEVEL validation
  packages/shared/src/index.ts                            — Export new error types (auto via wildcard)
  packages/shared/tests/errors.test.ts                    — Tests for new error types
  packages/shared/tests/config.test.ts                    — Tests for loadConfig/loadConfigSafe
  packages/shared/tests/logger.test.ts                    — Tests for createLoggerWithContext
  packages/queue/src/state-machine.ts                     — StateError replaces InvalidTransitionError
  packages/queue/src/index.ts                             — Re-export StateError
  packages/queue/src/queues.ts                            — ExportJobPayload.format widened
  packages/queue/src/workers/export-worker.ts             — Typed errors, binary branch, exporter factory
  packages/queue/src/workers/crawl-worker.ts              — Import CrawlError, NetworkError
  packages/queue/src/workers/schema-worker.ts             — Per-invocation context logger
  packages/queue/src/workers/reconciliation-worker.ts     — Per-invocation context logger
  packages/queue/tests/unit/state-machine.test.ts         — StateError migration
  packages/queue/tests/unit/job-manager.test.ts           — StateError migration
  packages/queue/tests/unit/exports.test.ts               — StateError migration
  packages/queue/tests/unit/workers/export-worker.test.ts — Binary code path tests
  packages/core/src/interfaces/content-store.ts           — storeBinary(), retrieveBinary()
  packages/core/src/interfaces/exporter.ts                — binaryData on ExportResult
  packages/core/src/exporters/index.ts                    — Re-export new exporters + column-mapper
  packages/db/src/schema/content.ts                       — binary_content column, content nullable
  packages/db/src/content-store/pg-content-store.ts       — storeBinary(), retrieveBinary()
  apps/api/src/middleware/error-handler.ts                 — New error code to HTTP status mappings
  apps/api/src/openapi-config.ts                          — Read requestId from context
  apps/api/src/app.ts                                     — Add requestContextMiddleware
  apps/api/src/types.ts                                   — Add requestId + logger to AppEnv
  apps/api/src/schemas/export-request.ts                  — Widen format enum to all 5 formats
  apps/api/src/routes/exports.ts                          — Binary content types, remove attempts:1
  apps/api/src/server.ts                                  — Call loadConfig() at startup
```

---

## Task 1: Error Hierarchy — Base Class + New Types

**Files:**
- Modify: `packages/shared/src/errors.ts`
- Test: `packages/shared/tests/errors.test.ts`

- [ ] **Step 1: Write failing tests for `retryable` flag and new error types**

Add to `packages/shared/tests/errors.test.ts`:

```typescript
import {
  SpatulaError,
  ValidationError,
  CrawlError,
  ExtractionError,
  LLMError,
  ConfigError,
  StorageError,
  QueueError,
  TimeoutError,
  RateLimitError,
  NetworkError,
  StateError,
} from '../src/errors.js';

// Add to existing SpatulaError describe block:
it('defaults retryable to false', () => {
  const err = new SpatulaError('test', 'TEST');
  expect(err.retryable).toBe(false);
});

it('supports retryable option', () => {
  const err = new SpatulaError('test', 'TEST', { retryable: true });
  expect(err.retryable).toBe(true);
});

// New describe block:
describe('new error types', () => {
  it('QueueError has correct code and is not retryable', () => {
    const err = new QueueError('job not found');
    expect(err.name).toBe('QueueError');
    expect(err.code).toBe('QUEUE_ERROR');
    expect(err.retryable).toBe(false);
  });

  it('TimeoutError has correct code and is retryable', () => {
    const err = new TimeoutError('crawl timed out');
    expect(err.name).toBe('TimeoutError');
    expect(err.code).toBe('TIMEOUT_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('RateLimitError has retryAfterMs', () => {
    const err = new RateLimitError('too many requests', { retryAfterMs: 5000 });
    expect(err.name).toBe('RateLimitError');
    expect(err.code).toBe('RATE_LIMIT_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('RateLimitError works without retryAfterMs', () => {
    const err = new RateLimitError('throttled');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('NetworkError has correct code and is retryable', () => {
    const err = new NetworkError('connection refused');
    expect(err.name).toBe('NetworkError');
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('StateError has correct code with from/to context', () => {
    const err = new StateError('Invalid transition', {
      context: { from: 'pending', to: 'completed' },
    });
    expect(err.name).toBe('StateError');
    expect(err.code).toBe('STATE_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.context).toEqual({ from: 'pending', to: 'completed' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm vitest run tests/errors.test.ts`
Expected: FAIL — `QueueError`, `TimeoutError`, etc. not exported

- [ ] **Step 3: Implement retryable flag and new error types**

Update `packages/shared/src/errors.ts`. Add `retryable?: boolean` to `SpatulaErrorOptions`. Add `readonly retryable: boolean` to `SpatulaError` class, initialized as `this.retryable = options?.retryable ?? false`. Then add the 5 new classes after `StorageError`:

- `QueueError` — code `QUEUE_ERROR`, default retryable `false`
- `TimeoutError` — code `TIMEOUT_ERROR`, default retryable `true`
- `RateLimitError` — code `RATE_LIMIT_ERROR`, default retryable `true`, extra `readonly retryAfterMs?: number`
- `NetworkError` — code `NETWORK_ERROR`, default retryable `true`
- `StateError` — code `STATE_ERROR`, default retryable `false`

Each follows the existing subclass pattern (e.g., `ValidationError`). For the retryable-by-default types, use `{ ...options, retryable: options?.retryable ?? true }` so callers can override.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm vitest run tests/errors.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add packages/shared/src/errors.ts packages/shared/tests/errors.test.ts
git commit -m "feat(shared): add retryable flag to SpatulaError and 5 new error types"
```

---

## Task 2: StateError Migration

**Files:**
- Modify: `packages/queue/src/state-machine.ts`
- Modify: `packages/queue/src/index.ts`
- Modify: `packages/queue/tests/unit/state-machine.test.ts`
- Modify: `packages/queue/tests/unit/job-manager.test.ts`
- Modify: `packages/queue/tests/unit/exports.test.ts`

**Depends on:** Task 1

- [ ] **Step 1: Update state-machine.ts to use StateError**

Remove the `InvalidTransitionError` class definition (lines 3-11). Add import: `import { StateError } from '@spatula/shared';`. Update the `transition` method to throw `new StateError(\`Invalid job state transition: ${from} → ${to}\`, { context: { from, to } })`.

- [ ] **Step 2: Update index.ts re-export**

In `packages/queue/src/index.ts` line 2, change:
```typescript
// Before
export { JobStateMachine, InvalidTransitionError } from './state-machine.js';
// After
export { JobStateMachine } from './state-machine.js';
export { StateError } from '@spatula/shared';
```

- [ ] **Step 3: Update test files**

In `packages/queue/tests/unit/state-machine.test.ts`: replace `InvalidTransitionError` import with `StateError` from `@spatula/shared`. Update assertions to check `instanceof StateError`, `error.code === 'STATE_ERROR'`, and `error.context` contains `{ from, to }`.

In `packages/queue/tests/unit/job-manager.test.ts`: same replacement.

In `packages/queue/tests/unit/exports.test.ts`:
- Line 7: Change to verify `InvalidTransitionError` is no longer exported: remove the `expect(mod.InvalidTransitionError).toBeDefined()` assertion (or replace with `expect(mod.JobStateMachine).toBeDefined()` which is already tested).
- Line 39: `expect(root.InvalidTransitionError).toBeDefined()` becomes `expect(root.StateError).toBeDefined()` (StateError is re-exported from `@spatula/shared` via the root index).

- [ ] **Step 4: Run all queue package tests**

Run: `cd packages/queue && pnpm vitest run`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add packages/queue/src/state-machine.ts packages/queue/src/index.ts packages/queue/tests/unit/state-machine.test.ts packages/queue/tests/unit/job-manager.test.ts packages/queue/tests/unit/exports.test.ts
git commit -m "refactor(queue): migrate InvalidTransitionError to StateError from @spatula/shared"
```

---

## Task 3: Worker Error Cleanup + API Error Handler

**Files:**
- Modify: `packages/queue/src/workers/export-worker.ts:16-43`
- Modify: `packages/queue/src/workers/crawl-worker.ts:197-202`
- Modify: `apps/api/src/middleware/error-handler.ts:24-33`
- Modify: `apps/api/src/routes/exports.ts:80`
- Test: `packages/queue/tests/unit/workers/export-worker.test.ts`

**Depends on:** Task 2

- [ ] **Step 1: Update export-worker.ts with typed errors**

Add imports: `QueueError, ValidationError` from `@spatula/shared`. Replace 4 generic `throw new Error(...)`:
- Line 20 `'Job not found'` becomes `new QueueError('Job not found', { context: { exportId, jobId } })`
- Line 24 `'Job is not completed...'` becomes `new QueueError(..., { context: { exportId, jobId, status: jobStatus } })`
- Line 33 `'No schema found'` becomes `new QueueError(..., { context: { exportId, jobId } })`
- Line 43 `'Export too large'` becomes `new ValidationError(..., { context: { exportId, jobId, total, max: MAX_EXPORT_ENTITIES } })`

- [ ] **Step 2: Update crawl-worker.ts error wrapping**

Add imports: `CrawlError, NetworkError` from `@spatula/shared`. In catch block (line 197), wrap unknown errors as `CrawlError`:

```typescript
} catch (error) {
  const wrappedError = error instanceof CrawlError || error instanceof NetworkError
    ? error
    : new CrawlError('Crawl job failed', { cause: error as Error, context: { taskId, url } });
  logger.error({ taskId, url, error: wrappedError }, 'crawl job failed');
  await deps.taskRepo.updateStatus(taskId, tenantId, 'failed').catch((e) => {
    logger.error({ taskId, error: e }, 'failed to mark task as failed');
  });
}
```

- [ ] **Step 3: Add new status mappings to API error handler**

In `apps/api/src/middleware/error-handler.ts`, add 5 cases to `mapErrorToStatus()` switch before `default`:

```typescript
case 'QUEUE_ERROR': return 503;
case 'TIMEOUT_ERROR': return 504;
case 'RATE_LIMIT_ERROR': return 429;
case 'NETWORK_ERROR': return 502;
case 'STATE_ERROR': return 409;
```

- [ ] **Step 4: Remove `attempts: 1` from export enqueue**

In `apps/api/src/routes/exports.ts` line 80, change `{ attempts: 1, removeOnComplete: true, removeOnFail: true }` to `{ removeOnComplete: true, removeOnFail: true }`.

- [ ] **Step 5: Add tests for new error-handler mappings**

In `apps/api/tests/unit/middleware/error-handler.test.ts`, add tests for the 5 new mappings:

```typescript
import { QueueError, TimeoutError, RateLimitError, NetworkError, StateError } from '@spatula/shared';

it('maps QueueError to 503', () => { /* throw new QueueError('test'), verify status 503 */ });
it('maps TimeoutError to 504', () => { /* throw new TimeoutError('test'), verify status 504 */ });
it('maps RateLimitError to 429', () => { /* throw new RateLimitError('test'), verify status 429 */ });
it('maps NetworkError to 502', () => { /* throw new NetworkError('test'), verify status 502 */ });
it('maps StateError to 409', () => { /* throw new StateError('test'), verify status 409 */ });
```

Follow the existing test pattern in the file for throwing errors through Hono and asserting response status.

- [ ] **Step 6: Run tests**

Run: `cd packages/queue && pnpm vitest run`
Run: `cd apps/api && pnpm vitest run`
Expected: All PASS

- [ ] **Step 7: Commit**

```
git add packages/queue/src/workers/export-worker.ts packages/queue/src/workers/crawl-worker.ts apps/api/src/middleware/error-handler.ts apps/api/src/routes/exports.ts apps/api/tests/unit/middleware/error-handler.test.ts
git commit -m "feat(errors): replace generic throws with typed errors, add API error status mappings"
```

---

## Task 4: Centralized Config Validation

**Files:**
- Modify: `packages/shared/src/config.ts`
- Test: `packages/shared/tests/config.test.ts`

**Standalone — no dependencies**

- [ ] **Step 1: Write failing tests for loadConfig and loadConfigSafe**

Add to `packages/shared/tests/config.test.ts`:

```typescript
import { loadConfig, loadConfigSafe } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

describe('loadConfig', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns validated config when all required env vars set', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test-123');
    const config = loadConfig();
    expect(config.database.url).toBe('postgresql://localhost:5432/spatula');
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.openrouter.apiKey).toBe('sk-test-123');
    expect(config.server.port).toBe(3000);
    expect(config.logging.level).toBe('info');
  });

  it('throws ConfigError listing all issues when required vars missing', () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => loadConfig()).toThrow(ConfigError);
    try { loadConfig(); } catch (e) {
      expect((e as ConfigError).message).toContain('DATABASE_URL');
      expect((e as ConfigError).message).toContain('OPENROUTER_API_KEY');
    }
  });

  it('applies defaults for optional fields', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    const config = loadConfig();
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.logging.nodeEnv).toBe('development');
  });

  it('coerces PORT to number', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    vi.stubEnv('PORT', '8080');
    expect(loadConfig().server.port).toBe(8080);
  });
});

describe('loadConfigSafe', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns config on success', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    const result = loadConfigSafe();
    expect('config' in result).toBe(true);
  });

  it('returns errors on failure', () => {
    vi.stubEnv('DATABASE_URL', '');
    const result = loadConfigSafe();
    expect('errors' in result).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm vitest run tests/config.test.ts`
Expected: FAIL — `loadConfig` and `loadConfigSafe` not exported

- [ ] **Step 3: Implement config validation**

Expand `packages/shared/src/config.ts`. Keep existing `getEnvOrThrow`/`getEnvOrDefault`. Add `z` import from `zod`, define `AppConfigSchema` per the spec, add `buildRawConfig()` that reads `process.env` with the env var mapping, add `loadConfig()` that calls `safeParse` and throws `ConfigError` on failure (listing all issues), and `loadConfigSafe()` that returns `{ config }` or `{ errors }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm vitest run tests/config.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add packages/shared/src/config.ts packages/shared/tests/config.test.ts
git commit -m "feat(shared): add Zod-based centralized config validation"
```

---

## Task 5: Logger Context Propagation

**Files:**
- Modify: `packages/shared/src/logger.ts`
- Test: `packages/shared/tests/logger.test.ts`

**Standalone — no dependencies**

- [ ] **Step 1: Write failing tests**

Add to `packages/shared/tests/logger.test.ts`:

Note: The existing test file already imports `createLogger`. Add `createLoggerWithContext` to that import and add a `ConfigError` import:

```typescript
import { createLogger, createLoggerWithContext } from '../src/logger.js';
import { ConfigError } from '../src/errors.js';

describe('createLoggerWithContext', () => {
  it('creates a child logger with context fields', () => {
    const logger = createLoggerWithContext('test', { jobId: 'job-1', tenantId: 'tenant-1' });
    expect(logger).toBeDefined();
    const bindings = logger.bindings();
    expect(bindings.jobId).toBe('job-1');
    expect(bindings.tenantId).toBe('tenant-1');
  });

  it('omits undefined context fields', () => {
    const logger = createLoggerWithContext('test', { requestId: 'req-1' });
    const bindings = logger.bindings();
    expect(bindings.requestId).toBe('req-1');
    expect(bindings.jobId).toBeUndefined();
  });
});

describe('LOG_LEVEL validation', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('throws ConfigError for invalid LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'verbose');
    expect(() => createLogger('test')).toThrow(ConfigError);
  });

  it('accepts valid LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    const logger = createLogger('test');
    expect(logger.level).toBe('debug');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm vitest run tests/logger.test.ts`
Expected: FAIL — `createLoggerWithContext` not exported, LOG_LEVEL validation missing

- [ ] **Step 3: Implement**

Update `packages/shared/src/logger.ts`:
- Add `import { ConfigError } from './errors.js'`
- Define `VALID_LEVELS` array
- In `createLogger()`, validate `LOG_LEVEL` against `VALID_LEVELS` before using it; throw `ConfigError` if invalid
- Add `createLoggerWithContext(name, context)` that calls `createLogger(name).child(definedEntries)` where undefined values are filtered out

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm vitest run tests/logger.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add packages/shared/src/logger.ts packages/shared/tests/logger.test.ts
git commit -m "feat(shared): add createLoggerWithContext and LOG_LEVEL validation"
```

---

## Task 6: Request Context Middleware + Worker Logger Migration

**Files:**
- Create: `apps/api/src/middleware/request-context.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/middleware/error-handler.ts:40`
- Modify: `apps/api/src/openapi-config.ts:8`
- Modify: `packages/queue/src/workers/export-worker.ts:1,8`
- Modify: `packages/queue/src/workers/crawl-worker.ts:1,7`
- Modify: `packages/queue/src/workers/schema-worker.ts`
- Modify: `packages/queue/src/workers/reconciliation-worker.ts`

**Depends on:** Task 5

- [ ] **Step 1: Add requestId and logger to AppEnv**

In `apps/api/src/types.ts`, add to the `Variables` interface:

```typescript
requestId: string;
logger: import('@spatula/shared').Logger;
```

- [ ] **Step 2: Create request-context middleware**

Create `apps/api/src/middleware/request-context.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';
import { createLoggerWithContext } from '@spatula/shared';
import type { AppEnv } from '../types.js';

export const requestContextMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  const logger = createLoggerWithContext('api', { requestId });

  c.set('requestId', requestId);
  c.set('logger', logger);
  c.header('x-request-id', requestId);

  await next();
};
```

- [ ] **Step 3: Wire middleware into app.ts**

In `apps/api/src/app.ts`:
- Add import: `import { requestContextMiddleware } from './middleware/request-context.js';`
- Insert `app.use('*', requestContextMiddleware);` as the first middleware, before `honoLogger()`

- [ ] **Step 4: Update error-handler.ts to read requestId from context**

In `apps/api/src/middleware/error-handler.ts` line 40, change:
```typescript
// Before
const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
// After
const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? crypto.randomUUID();
```

The fallback chain handles edge cases where error handler runs before the middleware.

- [ ] **Step 5: Update openapi-config.ts to read requestId from context**

In `apps/api/src/openapi-config.ts` line 8, same change:
```typescript
const requestId = c.get('requestId') ?? c.req.header('x-request-id') ?? crypto.randomUUID();
```

- [ ] **Step 6: Migrate 4 worker loggers to per-invocation context loggers**

In each worker file, remove the module-level `const logger = createLogger(...)` line. Add `createLoggerWithContext` import from `@spatula/shared`. Create the logger at the top of the process function:

- `export-worker.ts`: `const logger = createLoggerWithContext('export-worker', { jobId: data.jobId, tenantId: data.tenantId });`
- `crawl-worker.ts`: `const logger = createLoggerWithContext('crawl-worker', { jobId, tenantId });`
- `schema-worker.ts`: `const logger = createLoggerWithContext('schema-worker', { jobId: data.jobId, tenantId: data.tenantId });`
- `reconciliation-worker.ts`: `const logger = createLoggerWithContext('reconciliation-worker', { jobId: data.jobId, tenantId: data.tenantId });`

- [ ] **Step 7: Write test for request-context middleware**

Create `apps/api/tests/unit/middleware/request-context.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestContextMiddleware } from '../../../src/middleware/request-context.js';

describe('requestContextMiddleware', () => {
  it('generates requestId and sets response header', async () => {
    const app = new Hono();
    app.use('*', requestContextMiddleware);
    app.get('/test', (c) => c.json({ requestId: c.get('requestId') }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toBeDefined();
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('uses x-request-id header when provided', async () => {
    const app = new Hono();
    app.use('*', requestContextMiddleware);
    app.get('/test', (c) => c.json({ requestId: c.get('requestId') }));

    const res = await app.request('/test', {
      headers: { 'x-request-id': 'custom-id-123' },
    });
    const body = await res.json();
    expect(body.requestId).toBe('custom-id-123');
  });
});
```

- [ ] **Step 8: Run tests**

Run: `cd apps/api && pnpm vitest run`
Run: `cd packages/queue && pnpm vitest run`
Expected: All PASS

- [ ] **Step 9: Commit**

```
git add apps/api/src/middleware/request-context.ts apps/api/tests/unit/middleware/request-context.test.ts apps/api/src/app.ts apps/api/src/types.ts apps/api/src/middleware/error-handler.ts apps/api/src/openapi-config.ts packages/queue/src/workers/export-worker.ts packages/queue/src/workers/crawl-worker.ts packages/queue/src/workers/schema-worker.ts packages/queue/src/workers/reconciliation-worker.ts
git commit -m "feat: add request-context middleware, migrate worker loggers to per-invocation context"
```

---

## Task 7: Content Store Binary Support

**Files:**
- Modify: `packages/core/src/interfaces/content-store.ts`
- Modify: `packages/db/src/schema/content.ts`
- Modify: `packages/db/src/content-store/pg-content-store.ts`

**Standalone — no dependencies**

- [ ] **Step 1: Update ContentStore interface**

Add `storeBinary` and `retrieveBinary` methods to `packages/core/src/interfaces/content-store.ts`:

```typescript
export interface ContentStore {
  store(key: string, content: string): Promise<string>;
  retrieve(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
  storeBinary(key: string, data: Uint8Array): Promise<string>;
  retrieveBinary(ref: string): Promise<Uint8Array | null>;
}
```

- [ ] **Step 2: Update content store DB schema**

In `packages/db/src/schema/content.ts`:
- Add imports: `customType`, `check` from `drizzle-orm/pg-core`, `sql` from `drizzle-orm`
- Define a `bytea` custom type
- Make `content` nullable (remove `.notNull()`)
- Add `binaryContent: bytea('binary_content')` column (nullable)
- Add two CHECK constraints: one ensuring at least one column is non-null, one preventing both from being non-null

- [ ] **Step 3: Generate migration**

Run: `cd packages/db && pnpm db:generate`
Expected: New migration SQL file in `packages/db/drizzle/`

- [ ] **Step 4: Implement storeBinary and retrieveBinary in PgContentStore**

Add two methods to `packages/db/src/content-store/pg-content-store.ts`:

`storeBinary(key, data)` — same pattern as `store()` but writes to `binaryContent` column. Returns `pg://{id}`.

`retrieveBinary(ref)` — same pattern as `retrieve()` but reads `binaryContent`. Returns `Uint8Array | null` (null if not found or if column is null).

Also update `retrieve()` to handle nullable `content`: check `!row || !row.content` before returning.

- [ ] **Step 5: Run existing tests**

Run: `cd packages/db && pnpm vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```
git add packages/core/src/interfaces/content-store.ts packages/db/src/schema/content.ts packages/db/src/content-store/pg-content-store.ts packages/db/drizzle/
git commit -m "feat(db): add binary content store support with CHECK constraints"
```

---

## Task 8: Column Mapper

**Files:**
- Create: `packages/core/src/exporters/column-mapper.ts`
- Create: `packages/core/tests/unit/exporters/column-mapper.test.ts`

**Depends on:** Task 7 (loosely — can start in parallel)

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/unit/exporters/column-mapper.test.ts` with tests covering all 8 field types for all 3 targets (sqlite, duckdb, parquet). Verify correct native types and nullable flags.

Key assertions:
- `string` maps to `TEXT`/`VARCHAR`/`UTF8`
- `currency` maps to `REAL`/`DECIMAL(19,4)`/`DOUBLE`
- `boolean` maps to `INTEGER` (sqlite), `BOOLEAN` (duckdb/parquet)
- `array`/`object` map to text types (JSON serialized)
- `required: true` fields are `nullable: false`

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm vitest run tests/unit/exporters/column-mapper.test.ts`
Expected: FAIL — file not found

- [ ] **Step 3: Implement column mapper**

Create `packages/core/src/exporters/column-mapper.ts` with:
- `ExportTarget` type: `'parquet' | 'duckdb' | 'sqlite'`
- `ColumnDef` interface: `{ name, nativeType, nullable }`
- `TYPE_MAP` constant: maps each of 8 field types to native types per target
- `mapSchema(schema, target)` function: maps `schema.fields` to `ColumnDef[]`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run tests/unit/exporters/column-mapper.test.ts`
Expected: All PASS

- [ ] **Step 5: Add `binaryData` to ExportResult**

This is done here (not in Task 9) so that Tasks 9, 10, and 11 can run truly in parallel. In `packages/core/src/interfaces/exporter.ts`, add `binaryData: z.instanceof(Uint8Array).optional()` to the `ExportResult` Zod schema, between `data` and `generatedAt`.

- [ ] **Step 6: Run tests to verify nothing breaks**

Run: `cd packages/core && pnpm vitest run`
Expected: All PASS

- [ ] **Step 7: Commit**

```
git add packages/core/src/exporters/column-mapper.ts packages/core/tests/unit/exporters/column-mapper.test.ts packages/core/src/interfaces/exporter.ts
git commit -m "feat(core): add column-mapper and binaryData on ExportResult"
```

---

## Task 9: SQLite Exporter

**Files:**
- Create: `packages/core/src/exporters/sqlite-exporter.ts`
- Create: `packages/core/tests/unit/exporters/sqlite-exporter.test.ts`

**Depends on:** Task 8

- [ ] **Step 1: Install dependency**

Run: `cd packages/core && pnpm add better-sqlite3 && pnpm add -D @types/better-sqlite3`

- [ ] **Step 2: Write failing test**

Create `packages/core/tests/unit/exporters/sqlite-exporter.test.ts`. Test:
- Exports entities to valid SQLite binary (`result.binaryData` is `Uint8Array`)
- Read back with `better-sqlite3` from buffer: `new Database(Buffer.from(result.binaryData!))`
- Verify row count, column values, null handling, JSON serialization for array/object fields
- Check `result.format === 'sqlite'` and `result.entityCount`

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/exporters/sqlite-exporter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement SQLite exporter**

Create `packages/core/src/exporters/sqlite-exporter.ts`:
- Import `Database` from `better-sqlite3`, `mapSchema` from column-mapper
- Create in-memory DB, create table with mapped columns, insert entities in a transaction
- Serialize with `db.serialize()`, convert `Buffer` to `Uint8Array`
- Return `ExportResult` with `binaryData` and `format: 'sqlite'`
- Close DB in `finally` block

Entity value mapping: `null`/`undefined` become SQL NULL, objects become `JSON.stringify()`, booleans become `1`/`0`, everything else passed as-is.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run tests/unit/exporters/sqlite-exporter.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```
git add packages/core/src/exporters/sqlite-exporter.ts packages/core/tests/unit/exporters/sqlite-exporter.test.ts
git commit -m "feat(core): add SQLite exporter with binary output"
```

---

## Task 10: Parquet Exporter

**Files:**
- Create: `packages/core/src/exporters/parquet-exporter.ts`
- Create: `packages/core/tests/unit/exporters/parquet-exporter.test.ts`

**Depends on:** Task 8

- [ ] **Step 1: Install dependencies**

Run: `cd packages/core && pnpm add hyparquet-writer hyparquet`

- [ ] **Step 2: Write failing test**

Create `packages/core/tests/unit/exporters/parquet-exporter.test.ts`. Test:
- Export small entity set to Parquet
- Verify `result.binaryData` is `Uint8Array` with non-zero length
- Read back with `hyparquet`'s `parquetRead` to verify valid Parquet file
- Check `result.format === 'parquet'` and `result.entityCount`

Note: The `hyparquet`/`hyparquet-writer` APIs may differ from what the test assumes. Consult the package README and adjust the test accordingly. The critical assertion is that the output is valid Parquet.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/exporters/parquet-exporter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement Parquet exporter**

Create `packages/core/src/exporters/parquet-exporter.ts`:
- Import `parquetWriteBuffer` from `hyparquet-writer`, `mapSchema` from column-mapper
- Build column-oriented data: for each column, extract values from all entities
- Serialize nested types (array/object) as JSON strings
- Call `parquetWriteBuffer({ columns })` — check the actual API signature from the package docs
- Return `ExportResult` with `binaryData: new Uint8Array(buffer)` and `format: 'parquet'`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run tests/unit/exporters/parquet-exporter.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```
git add packages/core/src/exporters/parquet-exporter.ts packages/core/tests/unit/exporters/parquet-exporter.test.ts
git commit -m "feat(core): add Parquet exporter with hyparquet-writer"
```

---

## Task 11: DuckDB Exporter

**Files:**
- Create: `packages/core/src/exporters/duckdb-exporter.ts`
- Create: `packages/core/tests/unit/exporters/duckdb-exporter.test.ts`

**Depends on:** Task 8

- [ ] **Step 1: Install dependency**

Run: `cd packages/core && pnpm add @duckdb/node-api`

- [ ] **Step 2: Write failing test**

Create `packages/core/tests/unit/exporters/duckdb-exporter.test.ts`. Test:
- Export entities, verify `binaryData` is `Uint8Array`
- Write binary to temp file, open with `DuckDBInstance.create(path)`, query `SELECT count(*) FROM entities`, verify row count
- Clean up temp file in `finally`

Note: The `@duckdb/node-api` API may differ. Consult docs for `DuckDBInstance.create()`, `connection.run()`, and result iteration patterns. Adjust test accordingly.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/exporters/duckdb-exporter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement DuckDB exporter**

Create `packages/core/src/exporters/duckdb-exporter.ts`:
- Create temp file path with `os.tmpdir()` + `crypto.randomUUID()` + `.duckdb`
- Open file-backed DuckDB instance
- Create table, insert in batches of 500 with parameterized statements
- Close connection and instance (flushes to disk)
- Read temp file with `fs.readFile()`, convert to `Uint8Array`
- Delete temp file (and `.wal` file) in `finally` block
- Return `ExportResult` with `binaryData` and `format: 'duckdb'`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run tests/unit/exporters/duckdb-exporter.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```
git add packages/core/src/exporters/duckdb-exporter.ts packages/core/tests/unit/exporters/duckdb-exporter.test.ts
git commit -m "feat(core): add DuckDB exporter with @duckdb/node-api"
```

---

## Task 12: Export Worker Integration + API Changes

**Files:**
- Modify: `packages/core/src/exporters/index.ts`
- Modify: `packages/queue/src/queues.ts:44`
- Modify: `packages/queue/src/workers/export-worker.ts`
- Modify: `apps/api/src/schemas/export-request.ts:4`
- Modify: `apps/api/src/routes/exports.ts:96-121`
- Modify: `apps/api/src/server.ts:13`
- Test: `packages/queue/tests/unit/workers/export-worker.test.ts`

**Depends on:** Tasks 3, 9, 10, 11

- [ ] **Step 1: Update exporters/index.ts re-exports**

Add to `packages/core/src/exporters/index.ts`:

```typescript
export { SqliteExporter } from './sqlite-exporter.js';
export { ParquetExporter } from './parquet-exporter.js';
export { DuckDBExporter } from './duckdb-exporter.js';
export { mapSchema } from './column-mapper.js';
export type { ColumnDef, ExportTarget } from './column-mapper.js';
```

- [ ] **Step 2: Widen ExportJobPayload.format type**

In `packages/queue/src/queues.ts` line 44, change `format: 'json' | 'csv'` to `format: 'json' | 'csv' | 'parquet' | 'duckdb' | 'sqlite'`.

- [ ] **Step 3: Widen API export request schema**

In `apps/api/src/schemas/export-request.ts` line 4, change `z.enum(['json', 'csv'])` to `z.enum(['json', 'csv', 'parquet', 'duckdb', 'sqlite'])`.

- [ ] **Step 4: Write failing test for binary export path**

Add to `packages/queue/tests/unit/workers/export-worker.test.ts`:

```typescript
it('uses storeBinary for sqlite format', async () => {
  const deps = createMockDeps();
  deps.contentStore.storeBinary = vi.fn().mockResolvedValue('pg://binary-ref');
  const payload = { ...defaultPayload, format: 'sqlite' as const };
  await processExportJob(payload, deps);
  expect(deps.contentStore.storeBinary).toHaveBeenCalled();
  expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
    expect.anything(), expect.anything(),
    expect.objectContaining({ status: 'completed', contentRef: 'pg://binary-ref' }),
  );
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd packages/queue && pnpm vitest run tests/unit/workers/export-worker.test.ts`
Expected: FAIL — sqlite format not handled

- [ ] **Step 6: Update export-worker.ts with exporter factory and binary branch**

Update imports to include all 5 exporter classes. Add `getExporter(format)` factory function. Replace the hardcoded `format === 'csv' ? new CsvExporter() : new JsonExporter()` with `getExporter(format)`.

After exporter returns result, branch on `result.binaryData`:
- If present: call `deps.contentStore.storeBinary(key, result.binaryData)`, use `result.binaryData.byteLength` for fileSize
- Otherwise: existing text path (stringify for JSON envelope, store as text)

- [ ] **Step 7: Update export download route for binary formats**

In `apps/api/src/routes/exports.ts`, update the download handler:
- Add `CONTENT_TYPES` map for all 5 formats
- Add `binaryFormats` set for parquet/duckdb/sqlite
- For binary: call `deps.contentStore.retrieveBinary(ref)`, return raw bytes
- For text: existing `deps.contentStore.retrieve(ref)` path

- [ ] **Step 8: Add loadConfig() to API server startup**

In `apps/api/src/server.ts`, import `loadConfig` from `@spatula/shared`. At the top of `startServer()`, call `const config = loadConfig()` and use `port ?? config.server.port` for the server port.

- [ ] **Step 9: Run all tests**

Run: `pnpm -r vitest run`
Expected: All packages pass

- [ ] **Step 10: Commit**

```
git add packages/core/src/exporters/index.ts packages/queue/src/queues.ts packages/queue/src/workers/export-worker.ts packages/queue/tests/unit/workers/export-worker.test.ts apps/api/src/schemas/export-request.ts apps/api/src/routes/exports.ts apps/api/src/server.ts
git commit -m "feat: integrate binary exporters into export worker and API"
```

---

## Post-Implementation

- [ ] **Run full test suite:** `pnpm -r vitest run` — all packages pass
- [ ] **Run TypeScript check:** `pnpm -r tsc --noEmit` — no type errors
- [ ] **Run linter:** `pnpm -r lint` — no lint errors
