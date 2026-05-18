# Coding Conventions

**Analysis Date:** 2026-05-06

## Naming Patterns

**Files:**

- Kebab-case for file names: `job-manager.ts`, `action-executor.ts`, `worker-entrypoint.ts`
- Exception: test files use `.test.ts` suffix: `errors.test.ts`, `job-manager.test.ts`
- Integration tests suffix with `.integration.test.ts`: `user-tenant-repository.integration.test.ts`

**Functions and Methods:**

- camelCase for all functions: `createJob`, `startJob`, `getEnvOrThrow`, `loadConfig`
- Private methods use `private` modifier (TypeScript enforced): `private getJob`
- Constants use UPPER_SNAKE_CASE: `DEFAULT_QUEUE_CONFIG`, `QUEUE_NAMES`

**Variables:**

- camelCase for all variable declarations: `tenantId`, `jobId`, `createdTenantIds`
- Const and let follow camelCase: `const logger = createLogger(...)`, `let dbPool: DatabasePool`
- Mock factories in tests use camelCase: `createMockJobRepo()`, `createMockCrawler()`

**Types and Interfaces:**

- PascalCase for interfaces: `JobManager`, `Crawler`, `ActionExecutor`, `JobManagerConfig`
- PascalCase for types: `JobConfig`, `CrawlResult`, `ActionResult`, `AppConfig`
- Zod validators use PascalCase: `CrawlOptions`, `CrawlResult`, `ActionResult`
- Discriminant enum values use camelCase: `status: z.enum(['applied', 'rejected', 'deferred'])`

**Classes:**

- PascalCase for class names: `QuotaEnforcer`, `JobManager`, `SpatulaError`
- Error classes follow pattern: `{Name}Error`: `ValidationError`, `CrawlError`, `LLMError`, `StateError`
- Repository classes use pattern: `{Entity}Repository`: `JobRepository`, `UserTenantRepository`, `TenantRepository`

## Code Style

**Formatting:**

- Prettier enforces style: `.prettierrc` settings:
  - `semi: true` — semicolons required
  - `singleQuote: true` — single quotes for strings
  - `trailingComma: 'all'` — trailing commas in multiline structures
  - `printWidth: 100` — line length limit
  - `tabWidth: 2` — 2-space indentation

**Linting:**

- ESLint v9.16.0 with TypeScript support
- Config: `eslint.config.mjs` (flat config format)
- Key rules enforced:
  - `@typescript-eslint/no-unused-vars` — error with `argsIgnorePattern: '^_'` (allow unused params starting with `_`)
  - `@typescript-eslint/no-explicit-any` — warn (discourage but don't forbid)
  - `@typescript-eslint/consistent-type-imports` — error (enforce `import type { X } from` for types)
  - `no-console` — warn (discourage direct console usage, use logger instead)

**TypeScript Configuration:**

- `tsconfig.base.json` at monorepo root; each package has `tsconfig.json` extending it
- Compiler target: `ES2022`
- Module: `ESNext`
- `strict: true` — full strict mode enabled
- `esModuleInterop: true`
- `forceConsistentCasingInFileNames: true`
- `declaration: true` — emit .d.ts files
- `sourceMap: true` — generate source maps

## Import Organization

**Order:**

1. Node.js built-ins: `import { createServer } from 'node:http'`
2. External packages: `import { describe, it, expect } from 'vitest'`
3. Workspace packages (path aliases): `import { createLogger } from '@spatula/shared'`
4. Local files (relative imports): `import { JobManager } from './job-manager.js'`
5. Type-only imports (separate): `import type { JobConfig } from '@spatula/core'`

**Path Aliases:**

- Monorepo uses path aliases defined in `tsconfig.base.json`:
  - `@spatula/core` → `packages/core/src/index.ts`
  - `@spatula/db` → `packages/db/src/index.ts`
  - `@spatula/queue` → `packages/queue/src/index.ts`
  - `@spatula/shared` → `packages/shared/src/index.ts`
- Always use aliases for cross-package imports, never relative paths across packages

**Example pattern from `packages/queue/src/job-manager.ts`:**

```typescript
// Built-in — none in this file
// External packages
import { createLogger, StorageError } from '@spatula/shared';

// Type imports from other packages
import type { JobConfig, JobStatus } from '@spatula/core';
import type { QuotaEnforcer } from '@spatula/core';
import type { JobRepository, CrawlTaskRepository, SchemaRepository } from '@spatula/db';

// Runtime imports from other packages
import { QuotaExceededError } from '@spatula/shared';

// Local imports
import type { SpatulaQueues } from './queues.js';
import { JobStateMachine } from './state-machine.js';
```

Note: Import paths always use `.js` extension for ES modules (including local files).

## Error Handling

**Pattern:**

- Domain errors inherit from `SpatulaError` base class (in `packages/shared/src/errors.ts`)
- Each error type has a specific name and code:
  - `ValidationError` with code `'VALIDATION_ERROR'`
  - `CrawlError` with code `'CRAWL_ERROR'`
  - `ExtractionError` with code `'EXTRACTION_ERROR'`
  - `LLMError` with code `'LLM_ERROR'`
  - `StateError` with code `'STATE_ERROR'`
  - `QuotaExceededError` with code `'QUOTA_EXCEEDED'`
  - `TimeoutError` with code `'TIMEOUT_ERROR'` (retryable by default)
  - `NetworkError` with code `'NETWORK_ERROR'` (retryable by default)
  - `RateLimitError` with code `'RATE_LIMIT_ERROR'` (retryable, with optional `retryAfterMs`)

**Constructor Pattern:**

```typescript
export class StateError extends SpatulaError {
  constructor(message: string, options?: SpatulaErrorOptions) {
    super(message, 'STATE_ERROR', options);
    this.name = 'StateError';
  }
}
```

**Usage with Context:**

```typescript
throw new StateError('Cannot pause from completed state', {
  context: { from: 'completed', to: 'paused' },
});
```

**Options Interface:**

```typescript
export interface SpatulaErrorOptions {
  cause?: Error; // Original error for chaining
  context?: Record<string, unknown>; // Structured context
  retryable?: boolean; // Whether operation can be retried
}
```

## TypeScript Patterns

**Interface-Driven Architecture:**

- Core library defines interfaces for pluggable components: `Crawler`, `Extractor`, `SchemaEvolver`, `ContentStore`, `ActionExecutor`
- Interfaces located in `packages/core/src/interfaces/`
- Multiple implementations can satisfy same interface (e.g., Playwright vs Firecrawl for `Crawler`)

**Zod Validation with Type Inference:**

```typescript
// Define schema and infer type simultaneously
export const CrawlOptions = z.object({
  timeout: z.number().default(30000),
  proxy: z.object({...}).optional(),
});
export type CrawlOptions = z.infer<typeof CrawlOptions>;
```

**Readonly Properties:**

- Interface properties use `readonly` for immutability intent:

```typescript
export interface Crawler {
  readonly type: 'playwright' | 'firecrawl';
  crawl(url: string, options?: CrawlOptions): Promise<CrawlResult>;
}
```

**Private Constructor Injection:**

- Repositories and managers use constructor injection for dependencies:

```typescript
export class JobManager {
  private readonly jobRepo: JobRepository;
  private readonly queues: SpatulaQueues;

  constructor(config: JobManagerConfig) {
    this.jobRepo = config.jobRepo;
    this.queues = config.queues;
  }
}
```

## Logging

**Framework:** Pino (via `createLogger` in `@spatula/shared`)

**Usage Pattern:**

```typescript
const logger = createLogger('module-name');

logger.info({ jobId, seedUrls }, 'job started');
logger.warn({ err: error, tenantId }, 'Failed to check quota');
logger.error({ err }, 'Critical failure');
```

**Conventions:**

- Logger created at module level with clear module name
- Context passed as first argument (object with relevant IDs/state)
- Human-readable message as second argument
- Errors included as `err` property for structured logging

## Comments

**When to Comment:**

- Complex algorithms or non-obvious logic
- Important state machine transitions
- Workarounds or known limitations

**JSDoc/TSDoc:**

- Integration test files include descriptive JSDoc headers:

```typescript
/**
 * Integration tests for UserTenantRepository against real Postgres.
 *
 * Requires: TEST_DATABASE_URL pointing to a Postgres instance.
 * Migrations are applied once for the whole package via tests/setup/global-migrate.ts.
 */
```

- Function-level JSDoc is minimal; focus on integration test setup comments

## Function Design

**Size Guidelines:**

- Most functions stay under 50 lines
- Complex orchestration functions (e.g., `startJob`) may reach 100+ lines but decompose into private helpers
- State machine transitions often extracted to dedicated classes (`JobStateMachine`)

**Parameters:**

- Single config object parameter preferred over multiple params:

```typescript
// Preferred:
export class JobManager {
  constructor(config: JobManagerConfig) { ... }
}

// Avoid:
export class JobManager {
  constructor(jobRepo, taskRepo, schemaRepo, queues) { ... }
}
```

**Return Values:**

- Async functions return `Promise<T>` or `Promise<void>` (never bare promises)
- Void operations still use `Promise<void>` for consistency:

```typescript
async startJob(jobId: string, tenantId: string): Promise<void>
async createJob(config: JobConfig): Promise<string>
```

**Async-Await Style:**

- Prefer `async/await` over `.then()` chains
- Error handling uses try/catch or `.catch()` for specific error types

## Module Design

**Exports:**

- Use named exports exclusively (no default exports)
- Each package has barrel export at `src/index.ts`:

```typescript
// packages/core/src/index.ts
export * from './types/index.js';
export * from './interfaces/index.js';
export * from './crawlers/index.js';
export * from './llm/index.js';
```

**Barrel Files:**

- Subdirectories use `index.ts` to re-export all public APIs
- Enables clean imports: `import { Crawler } from '@spatula/core'`
- Allows packages to control public surface area

**File Organization:**

- Interfaces/types in separate `interfaces/` and `types/` directories
- Implementation organized by feature: `crawlers/`, `extraction/`, `billing/`
- Test files co-located with implementation: `src/billing/quota-enforcer.test.ts` alongside `src/billing/quota-enforcer.ts`

---

_Convention analysis: 2026-05-06_
