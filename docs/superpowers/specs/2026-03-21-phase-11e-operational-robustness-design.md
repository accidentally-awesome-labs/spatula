# Phase 11e: Operational Robustness — Design Spec

> Production-grade error handling, configuration validation, structured logging, and full export format coverage.

## Overview

Phase 11e is the final sub-phase of Phase 11 (Production Hardening). It addresses four independent areas that collectively bring Spatula from functional prototype to operationally sound:

1. **Error Hierarchy Refactoring** — typed errors with retryability, replacing generic throws
2. **Centralized Config Validation** — Zod-based startup validation for all environment variables
3. **Logger Context Propagation** — per-request/per-job structured logging with automatic context fields
4. **Additional Exporters** — Parquet, DuckDB, SQLite export with binary content store support

**Prerequisite:** Phase 11a (migrations, repositories, E2E).

**Relationship to parent spec:** This spec refines and supersedes the Phase 11e section in `docs/superpowers/specs/2026-03-17-phase-11-production-hardening-design.md`. Changes from the parent: expanded `AppConfigSchema` to include `server` config (port/host) and `logging.nodeEnv`; switched Parquet dependency from `hyparquet` to `hyparquet-writer`; switched DuckDB dependency from `duckdb`/`duckdb-async` to `@duckdb/node-api`; corrected DuckDB export flow; added `retryable` flag to error hierarchy; added gap fixes for API schema validation, content store CHECK constraints, and request context middleware.

---

## 11e.1 Error Hierarchy Refactoring

### Base Class Enhancement

Add `retryable` to `SpatulaError` in `packages/shared/src/errors.ts`:

```typescript
export interface SpatulaErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
  retryable?: boolean; // default false
}
```

`SpatulaError` gains a `readonly retryable: boolean` property set from options. Existing subclasses are unaffected (default `false`).

### New Error Types

| Type | Code | Default `retryable` | When Thrown |
|------|------|---------------------|------------|
| `QueueError` | `QUEUE_ERROR` | `false` | Job enqueue failures, invalid job state in workers, missing job/schema lookups |
| `TimeoutError` | `TIMEOUT_ERROR` | `true` | Crawl timeouts, LLM call timeouts |
| `RateLimitError` | `RATE_LIMIT_ERROR` | `true` | LLM provider 429s, domain crawl throttling. Carries optional `retryAfterMs` field |
| `NetworkError` | `NETWORK_ERROR` | `true` | DNS failures, connection refused, SSL errors |
| `StateError` | `STATE_ERROR` | `false` | Invalid job state transitions |

`RateLimitError` extends `SpatulaError` with an additional `retryAfterMs?: number` property. Constructor signature: `new RateLimitError(message: string, options?: SpatulaErrorOptions & { retryAfterMs?: number })`. The `retryAfterMs` is a first-class constructor parameter (not buried in `context`) because callers need direct access for backoff logic.

### InvalidTransitionError Migration

`StateError` in `packages/shared/src/errors.ts` replaces `InvalidTransitionError` in `packages/queue/src/state-machine.ts`.

- `StateError` stores `from` and `to` in the `context` field: `new StateError('Invalid transition', { context: { from, to } })`
- Update `state-machine.ts` to import `StateError` from `@spatula/shared`
- Update `packages/queue/src/index.ts` to re-export `StateError` instead of `InvalidTransitionError`
- Update test files (`state-machine.test.ts`, `job-manager.test.ts`, `exports.test.ts`) that reference `InvalidTransitionError`

### Worker Error Cleanup

**export-worker.ts** — Replace 4 `throw new Error(...)`:

| Current Message | New Error Type | Retryable |
|----------------|---------------|-----------|
| `'Job not found'` | `QueueError` | No |
| `'Job is not completed...'` | `QueueError` | No |
| `'No schema found for job'` | `QueueError` | No |
| `'Export too large: ...'` | `ValidationError` | No |

**crawl-worker.ts** — Import `CrawlError` from `@spatula/shared` (exists but not imported). Wrap crawler failures as `CrawlError`, network-level failures as `NetworkError`.

**Export route retry fix** — Remove `attempts: 1` override in `apps/api/src/routes/exports.ts` export enqueue call. Exports inherit the queue default of `attempts: 3` with exponential backoff.

### API Error Handler Mapping

Add to `apps/api/src/middleware/error-handler.ts`:

| Error Type | HTTP Status |
|-----------|-------------|
| `QueueError` | 503 Service Unavailable |
| `TimeoutError` | 504 Gateway Timeout |
| `RateLimitError` | 429 Too Many Requests |
| `NetworkError` | 502 Bad Gateway |
| `StateError` | 409 Conflict |

Existing mappings (`ValidationError` → 400, `NotFoundError` → 404, `ConflictError` → 409) remain unchanged. Note: both `StateError` and `ConflictError` map to HTTP 409, but they carry different error codes in the response body (`STATE_ERROR` vs `CONFLICT`), allowing clients to distinguish them. `ConflictError` is for general resource conflicts (e.g., duplicate creation); `StateError` is specifically for invalid state machine transitions.

---

## 11e.2 Centralized Config Validation

### Config Schema

Expand `packages/shared/src/config.ts` with a Zod schema:

```typescript
const AppConfigSchema = z.object({
  database: z.object({
    url: z.string().url(),
  }),
  redis: z.object({
    url: z.string().min(1).default('redis://localhost:6379'),
  }),
  openrouter: z.object({
    apiKey: z.string().min(1),
  }),
  firecrawl: z.object({
    apiKey: z.string().optional(),
  }),
  server: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    host: z.string().default('0.0.0.0'),
  }),
  logging: z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  }),
});
```

### Env Var Mapping

Explicit mapping from environment variables to schema paths:

| Schema Path | Env Var |
|------------|---------|
| `database.url` | `DATABASE_URL` |
| `redis.url` | `REDIS_URL` |
| `openrouter.apiKey` | `OPENROUTER_API_KEY` |
| `firecrawl.apiKey` | `FIRECRAWL_API_KEY` |
| `server.port` | `PORT` |
| `server.host` | `HOST` |
| `logging.level` | `LOG_LEVEL` |
| `logging.nodeEnv` | `NODE_ENV` |

### Load Functions

- **`loadConfig(): AppConfig`** — Parses env vars, validates, throws `ConfigError` on failure. The error message lists all validation issues at once so developers can fix everything in one pass.
- **`loadConfigSafe(): { config: AppConfig } | { errors: string[] }`** — Non-throwing variant for CLI/diagnostic use.

### Existing Helpers

`getEnvOrThrow` and `getEnvOrDefault` remain for code that only needs a single env var (e.g., test helpers reading `TEST_DATABASE_URL`). They serve a different purpose: ad hoc lookups vs. structured startup validation.

### Integration Points

- **`apps/api/src/server.ts`** — Call `loadConfig()` at the top of `startServer()`, before creating the Hono app or connecting to DB/Redis. Pass the validated config to `createApp()` and worker bootstrap.
- **Worker bootstrap** — Workers call `loadConfig()` at startup. The config object flows into `WorkerDeps` construction, replacing scattered `process.env` reads.
- **Test environments** — Tests that set `process.env` directly before calling code continue to work. `loadConfig()` reads `process.env` at call time, not at import time.

### Exclusions

- Does not replace `QueueConfig` (concurrency/rate limits) — that is runtime config passed to `createQueues()`, not env-based.
- Does not add config file support (YAML/TOML) — env vars are the single source of truth per the 12-factor pattern.

---

## 11e.3 Logger Context Propagation

### Context-Aware Logger Factory

Add to `packages/shared/src/logger.ts`:

```typescript
export function createLoggerWithContext(
  name: string,
  context: { tenantId?: string; jobId?: string; requestId?: string },
): pino.Logger;
```

Creates a Pino child logger via `createLogger(name).child(context)`. Every log line from the child automatically includes the context fields.

### LOG_LEVEL Validation

`createLogger()` validates `process.env.LOG_LEVEL` against Pino's valid levels (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). If invalid, throws `ConfigError` listing valid options. Catches typos like `LOG_LEVEL=verbose` at startup.

### Request Context Middleware

**New file:** `apps/api/src/middleware/request-context.ts`

A Hono middleware that runs first in the chain (before error handler):

1. Reads `x-request-id` header or generates `crypto.randomUUID()`
2. Creates a context logger via `createLoggerWithContext('api', { requestId })`
3. Sets `requestId` and `logger` on the Hono context
4. Sets `x-request-id` response header for client correlation

### Middleware Chain Update

**File:** `apps/api/src/app.ts`

Updated order:

1. `requestContextMiddleware` (NEW — generates requestId + context logger)
2. `honoLogger()` (existing — Hono's built-in request logging)
3. `errorHandler` (existing — now reads requestId from context instead of generating it)

The error handler changes from generating requestId inline to reading it from context:

```typescript
// Before
const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
// After
const requestId = c.get('requestId');
```

Same change in `openapi-config.ts`.

### Worker Logger Integration

Each worker changes from module-level logger to per-invocation context logger:

```typescript
// Before (module-level)
const logger = createLogger('export-worker');

// After (per-invocation)
const logger = createLoggerWithContext('export-worker', {
  jobId: data.jobId,
  tenantId: data.tenantId,
});
```

Affects 4 worker files: `crawl-worker.ts`, `schema-worker.ts`, `reconciliation-worker.ts`, `export-worker.ts`. Module-level `createLogger` calls are removed.

### Exclusions

- Does not add request/response timing middleware — that is observability scope, not context propagation.
- Does not propagate requestId into workers — API requests and background workers are separate execution contexts. Workers get `jobId`/`tenantId` context instead.
- Does not change logger output format — Pino's JSON output with added context fields is sufficient.

---

## 11e.4 Additional Exporters

### Content Store Binary Support

**Interface change** in `packages/core/src/interfaces/content-store.ts`:

```typescript
export interface ContentStore {
  store(key: string, content: string): Promise<string>;
  retrieve(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
  storeBinary(key: string, data: Uint8Array): Promise<string>;
  retrieveBinary(ref: string): Promise<Uint8Array | null>;
}
```

`Uint8Array` over Node.js `Buffer` for Bun compatibility per design doc.

**Schema migration** in `packages/db/src/schema/content.ts`:

- Add `binary_content bytea` column (nullable)
- Make existing `content text` column nullable

After migration, each row has either `content` (text) or `binary_content` (binary) populated, never both. This invariant is enforced at the database level with a CHECK constraint:

```sql
CHECK (content IS NOT NULL OR binary_content IS NOT NULL)
CHECK (NOT (content IS NOT NULL AND binary_content IS NOT NULL))
```

**PgContentStore** — Add `storeBinary()` and `retrieveBinary()` methods. Same key/ref pattern as text methods (`pg://{uuid}`).

### ExportResult Enhancement

Add `binaryData` to `ExportResult` in `packages/core/src/interfaces/exporter.ts`:

```typescript
export const ExportResult = z.object({
  format: ExportFormat,
  entityCount: z.number(),
  filePath: z.string().optional(),
  data: z.unknown().optional(),
  binaryData: z.instanceof(Uint8Array).optional(),
  generatedAt: z.coerce.date(),
});
```

Text exporters set `data`. Binary exporters set `binaryData`. Never both. Note: `z.instanceof(Uint8Array)` works for runtime validation within a single process but would fail across serialization boundaries. This is acceptable because `ExportResult` is only constructed and consumed within the export-worker process (exporter → worker → content store).

### Column Mapper

**New file:** `packages/core/src/exporters/column-mapper.ts`

Maps `FieldDefinition.type` (8 types) to native column types:

| Field Type | Parquet | DuckDB | SQLite |
|-----------|---------|--------|--------|
| `string` | `UTF8` | `VARCHAR` | `TEXT` |
| `number` | `DOUBLE` | `DOUBLE` | `REAL` |
| `boolean` | `BOOLEAN` | `BOOLEAN` | `INTEGER` |
| `url` | `UTF8` | `VARCHAR` | `TEXT` |
| `currency` | `DOUBLE` | `DECIMAL(19,4)` | `REAL` |
| `enum` | `UTF8` | `VARCHAR` | `TEXT` |
| `array` | `UTF8` (JSON) | `VARCHAR` (JSON) | `TEXT` (JSON) |
| `object` | `UTF8` (JSON) | `VARCHAR` (JSON) | `TEXT` (JSON) |

Nested types (`array`, `object`) serialize as JSON strings — true nested Parquet structs add substantial complexity for minimal benefit in a web scraping context. Note: `currency` maps to `DOUBLE`/`REAL` for Parquet and SQLite, which is IEEE 754 floating point (lossy for currency). DuckDB uses `DECIMAL(19,4)` which is precise. This is acceptable for the web scraping use case where currency values are extracted as approximate data, not financial ledger entries.

Exports `mapSchema(schema: SchemaDefinition, target: 'parquet' | 'duckdb' | 'sqlite')` returning `{ name, nativeType, nullable }[]`.

### Parquet Exporter

**New file:** `packages/core/src/exporters/parquet-exporter.ts`

**Dependency:** `hyparquet-writer` — pure JS, no native bindings. Avoids platform-specific build issues. Note: `hyparquet` itself is read-only (parser only); the separate `hyparquet-writer` package provides `parquetWriteBuffer()` for creating Parquet files. Add `hyparquet` as well if read-back verification is needed in tests.

Flow:
1. Map schema fields via column-mapper
2. Flatten entities into row arrays
3. Serialize nested types as JSON strings
4. Write to Parquet via `parquetWriteBuffer()` from `hyparquet-writer`
5. Return `ExportResult` with `binaryData: Uint8Array`

### DuckDB Exporter

**New file:** `packages/core/src/exporters/duckdb-exporter.ts`

**Dependency:** `@duckdb/node-api` — the official DuckDB "Neo" Node.js client with native async/promise support. The older `duckdb` + `duckdb-async` packages are deprecated and will not receive updates past DuckDB 1.4.x.

Flow:
1. Create a temp file path via `os.tmpdir()` + `crypto.randomUUID()` + `.duckdb`
2. Open a file-backed DuckDB instance at the temp path (not in-memory — we need the file)
3. Create table using column-mapper types
4. Insert entities via parameterized statements (batched, 500 rows per batch)
5. Close the DuckDB connection (flushes to disk)
6. Read the temp file into `Uint8Array` via `fs.readFile()`
7. Delete the temp file in a `finally` block (`fs.rm()`) to prevent leaks on worker crashes
8. Return `ExportResult` with `binaryData: Uint8Array`

Note: `EXPORT DATABASE` was considered but rejected — it exports CSV/Parquet files to a directory, not a `.duckdb` file. The file-backed approach produces a portable `.duckdb` database directly.

### SQLite Exporter

**New file:** `packages/core/src/exporters/sqlite-exporter.ts`

**Dependency:** `better-sqlite3` — synchronous API, fastest SQLite binding for Node.js. Note: unlike `hyparquet-writer` (pure JS), both `better-sqlite3` and `@duckdb/node-api` have native C/C++ bindings requiring compilation. This is acceptable because no pure-JS alternatives exist that perform adequately for these formats, and both packages are widely used with reliable prebuilt binaries for common platforms.

Flow:
1. Create in-memory database via `new Database(':memory:')`
2. Create table using column-mapper types
3. Insert entities via prepared statement in a transaction (batched, using `better-sqlite3`'s transaction helper)
4. Serialize to binary via `.serialize()` → `Buffer` → `Uint8Array`
5. Close database
6. Return `ExportResult` with `binaryData: Uint8Array`

### Export Worker Changes

**File:** `packages/queue/src/workers/export-worker.ts`

1. **Format type widening** — `ExportJobPayload.format` changes from `'json' | 'csv'` to the `ExportFormat` type from `@spatula/core` (already includes all 5).

2. **Exporter factory** — New function `getExporter(format: ExportFormat): Exporter`. Simple switch/map, no class hierarchy.

3. **Binary store branch** — After exporter returns `ExportResult`:
   - If `result.binaryData` → `contentStore.storeBinary(key, result.binaryData)`
   - If `result.data` → stringify and `contentStore.store(key, content)` (existing path)

4. **File size** — Binary: `result.binaryData.byteLength`. Text: `Buffer.byteLength(content, 'utf-8')` (existing).

### Export Download Endpoint

**File:** `apps/api/src/routes/exports.ts`

Update download route with format-aware content types:

| Format | Content-Type | Extension |
|--------|-------------|-----------|
| `json` | `application/json` | `.json` |
| `csv` | `text/csv` | `.csv` |
| `parquet` | `application/vnd.apache.parquet` | `.parquet` |
| `duckdb` | `application/octet-stream` | `.duckdb` |
| `sqlite` | `application/vnd.sqlite3` | `.sqlite` |

Binary formats use `contentStore.retrieveBinary(ref)`. Text formats use existing `contentStore.retrieve(ref)`.

### Export Route Retry Fix

Remove `attempts: 1` override in export enqueue call. Exports inherit queue default of `attempts: 3` with exponential backoff.

---

## File Map

### Created

| File | Purpose |
|------|---------|
| `apps/api/src/middleware/request-context.ts` | RequestId generation + context logger middleware |
| `packages/core/src/exporters/parquet-exporter.ts` | Apache Parquet exporter |
| `packages/core/src/exporters/duckdb-exporter.ts` | DuckDB exporter |
| `packages/core/src/exporters/sqlite-exporter.ts` | SQLite exporter |
| `packages/core/src/exporters/column-mapper.ts` | Schema field → native column type mapping |

### Modified

| File | Changes |
|------|---------|
| `packages/shared/src/errors.ts` | `retryable` on SpatulaError, 5 new error types |
| `packages/shared/src/config.ts` | `AppConfigSchema`, `loadConfig()`, `loadConfigSafe()` |
| `packages/shared/src/logger.ts` | `createLoggerWithContext()`, LOG_LEVEL validation |
| `packages/queue/src/state-machine.ts` | Replace `InvalidTransitionError` with `StateError` import |
| `packages/queue/src/index.ts` | Re-export `StateError` |
| `packages/queue/src/workers/export-worker.ts` | Typed errors, binary store branch, exporter factory, format widening |
| `packages/queue/src/workers/crawl-worker.ts` | Import and use `CrawlError`, `NetworkError` |
| `packages/queue/src/queues.ts` | `ExportJobPayload.format` widened to `ExportFormat` |
| `apps/api/src/schemas/export-request.ts` | Widen format enum from `['json', 'csv']` to all 5 formats |
| `packages/core/src/interfaces/content-store.ts` | `storeBinary()`, `retrieveBinary()` |
| `packages/core/src/interfaces/exporter.ts` | `binaryData` on `ExportResult` |
| `packages/db/src/content-store/pg-content-store.ts` | `storeBinary()`, `retrieveBinary()` implementations |
| `packages/db/src/schema/content.ts` | `binary_content bytea` column, `content` nullable |
| `apps/api/src/middleware/error-handler.ts` | New error type → HTTP status mappings, read requestId from context |
| `apps/api/src/openapi-config.ts` | Read requestId from context |
| `apps/api/src/app.ts` | Add `requestContextMiddleware` to chain |
| `apps/api/src/routes/exports.ts` | Binary content types, remove `attempts: 1`, format widening |
| `apps/api/src/server.ts` | Call `loadConfig()` at startup |
| `packages/core/src/exporters/index.ts` | Re-export new exporters and column-mapper |
| `packages/shared/src/index.ts` | Export new error types |

### Dependencies Added

| Package | Version | Purpose |
|---------|---------|---------|
| `hyparquet-writer` | latest | Pure JS Parquet file writer |
| `hyparquet` | latest | Parquet reader (for test verification) |
| `@duckdb/node-api` | latest | Official DuckDB Neo Node.js client |
| `better-sqlite3` | latest | SQLite Node.js bindings (native) |
| `@types/better-sqlite3` | latest | TypeScript types |

---

## Testing Strategy

Each section has independent test coverage:

- **Error hierarchy:** Unit tests for each new error type (retryable flag, context, code). Update existing `state-machine.test.ts`, `job-manager.test.ts`, and `exports.test.ts` for `StateError` migration.
- **Config validation:** Unit tests for `loadConfig()` and `loadConfigSafe()` — valid env, missing required, invalid formats, defaults.
- **Logger context:** Unit tests for `createLoggerWithContext()` verifying child logger fields. Integration test for request-context middleware.
- **Exporters:** Unit tests for each exporter with a small entity set — verify output is valid Parquet/DuckDB/SQLite by reading it back (using `hyparquet` for Parquet read-back, `@duckdb/node-api` for DuckDB read-back, `better-sqlite3` for SQLite read-back). Unit tests for column-mapper covering all 8 field types. Integration tests for binary content store round-trip (`storeBinary` → `retrieveBinary`). Update existing `export-worker.test.ts` to cover the binary code path (the `binaryData` branch in the worker).

---

## Out of Scope

- Request/response timing middleware (observability, not context propagation)
- Config file support (YAML/TOML) — env vars only per 12-factor pattern
- S3/R2 content store (separate future work)
- Streaming exports for datasets beyond 50,000 entities
- Nested Parquet struct/list types (JSON serialization is sufficient)
- `QueueConfig` changes (runtime config, not env-based)
