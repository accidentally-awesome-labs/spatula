# Testing Patterns

**Analysis Date:** 2026-05-06

## Test Framework

**Runner:**
- Vitest v2.1.0
- Node.js environment: `environment: 'node'`
- Config files:
  - Root: `tests/vitest.config.ts` (E2E tests)
  - Packages: `packages/{core,shared,db,queue}/vitest.config.ts` (unit tests)

**Assertion Library:**
- Vitest built-in assertions via `expect()`

**Run Commands:**
```bash
pnpm test              # Run all tests (turbo runs across packages)
pnpm test:watch       # Watch mode for all tests
pnpm test:e2e         # Run E2E tests: vitest run --config tests/e2e/vitest.config.ts
pnpm lint             # Run ESLint
pnpm typecheck        # Run tsc type checking
```

**Per-Package:**
```bash
pnpm --filter @spatula/core test
pnpm --filter @spatula/db exec vitest run tests/integration/user-tenant-repository.integration.test.ts
```

## Test File Organization

**Location:**
- Unit tests co-located with source: `src/billing/quota-enforcer.test.ts` (alongside `src/billing/quota-enforcer.ts`)
- Package-level tests in `tests/unit/`: `packages/db/tests/unit/cache.test.ts`, `packages/queue/tests/unit/job-manager.test.ts`
- Integration tests in `tests/integration/`: `packages/db/tests/integration/user-tenant-repository.integration.test.ts`
- E2E tests in `tests/e2e/`: `tests/e2e/full-pipeline.test.ts`

**Naming:**
- Unit tests: `{module-name}.test.ts`
- Integration tests: `{module-name}.integration.test.ts`
- E2E tests: `{scenario}.test.ts` in `tests/e2e/`

**Directory Structure:**
```
packages/{package}/
├── src/
│   ├── module-a.ts
│   ├── module-a.test.ts       # Co-located unit test
│   └── module-b.ts
├── tests/
│   ├── unit/
│   │   ├── exports.test.ts
│   │   └── connection.test.ts
│   └── integration/
│       └── user-tenant-repository.integration.test.ts
└── vitest.config.ts

tests/
└── e2e/
    ├── full-pipeline.test.ts
    └── fixtures/
        └── product-page.html
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ModuleName', () => {
  // Setup shared across all tests in suite
  let dependency: MockType;

  beforeEach(() => {
    dependency = createMock();
  });

  describe('methodName', () => {
    it('does something specific', async () => {
      const result = await dependency.method();
      expect(result).toBe(expectedValue);
    });

    it('handles error case', async () => {
      await expect(dependency.failingMethod()).rejects.toThrow('error message');
    });
  });
});
```

**Patterns:**
- Use `describe()` for grouping related tests
- Use nested `describe()` for organizing by method/feature
- Use `it()` for individual test cases
- Each test should be independent and idempotent

**Setup/Teardown:**
- `beforeEach()`: Runs before each test in suite (reset state)
- `afterEach()`: Cleanup per test (e.g., `vi.unstubAllEnvs()`)
- `beforeAll()`: One-time setup before all tests (expensive operations)
- `afterAll()`: One-time cleanup after all tests (close connections)

**Example from `packages/shared/tests/config.test.ts`:**
```typescript
describe('getEnvOrThrow', () => {
  afterEach(() => {
    vi.unstubAllEnvs();  // Clean up env stubs
  });

  it('returns the value if set', () => {
    vi.stubEnv('TEST_KEY', 'test_value');
    expect(getEnvOrThrow('TEST_KEY')).toBe('test_value');
  });

  it('throws if not set', () => {
    expect(() => getEnvOrThrow('MISSING_KEY')).toThrow('MISSING_KEY');
  });
});
```

## Mocking

**Framework:** Vitest's `vi` object

**Patterns:**

**Mock Factory Pattern:**
```typescript
function createMockJobRepo() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByTenant: vi.fn(),
    updateStatus: vi.fn(),
    updateStats: vi.fn(),
  };
}

describe('JobManager', () => {
  let jobRepo: ReturnType<typeof createMockJobRepo>;

  beforeEach(() => {
    jobRepo = createMockJobRepo();
    manager = new JobManager({ jobRepo: jobRepo as any });
  });
});
```

**Function Mocking:**
```typescript
const mockFn = vi.fn();
const mockFnWithReturnValue = vi.fn().mockResolvedValue({ id: 'job-001' });
const mockFnWithError = vi.fn().mockRejectedValue(new Error('failed'));

// Chaining multiple return values:
mockFn
  .mockResolvedValueOnce({ id: 'task-001' })
  .mockResolvedValueOnce({ id: 'task-002' });

// Assertion patterns:
expect(mockFn).toHaveBeenCalledWith(expectedArg);
expect(mockFn).toHaveBeenCalledTimes(2);
expect(mockFn).toHaveBeenCalledOnce();
expect(mockFn).not.toHaveBeenCalled();
```

**Environment Stubbing:**
```typescript
vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/spatula');
vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
vi.unstubAllEnvs(); // Clean up
```

**Mock Casting:**
- Use `as any` to cast mocks to real types when needed:
```typescript
manager = new JobManager({
  jobRepo: jobRepo as any,
  taskRepo: taskRepo as any,
  schemaRepo: schemaRepo as any,
  queues: queues as any,
});
```

**What to Mock:**
- External services (databases, APIs, queues)
- Repository implementations
- Configuration and environment
- Expensive operations (file I/O)

**What NOT to Mock:**
- Core domain logic (state machines, validation)
- Error classes (test real error behavior)
- Type system (use real interfaces/types)

## Fixtures and Factories

**Test Data Factories:**
```typescript
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const JOB_ID = 'job-001';

const baseConfig = {
  tenantId: TENANT_ID,
  name: 'Test Job',
  description: 'A test crawl job',
  seedUrls: ['https://a.com', 'https://b.com'],
  crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' as const },
  schema: {
    mode: 'fixed' as const,
    userFields: [
      {
        name: 'title',
        description: 'Page title',
        type: 'string' as const,
        required: true,
      },
    ],
  },
  llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
};
```

**HTML Fixtures:**
- Stored in `tests/fixtures/` directory
- Loaded at test runtime:
```typescript
const FIXTURE_HTML = readFileSync(
  join(__dirname, 'fixtures', 'product-page.html'),
  'utf-8',
);
```

**Location:**
- Co-located unit test fixtures: alongside test file
- E2E fixtures: `tests/e2e/fixtures/`
- Shared test utilities: `packages/{package}/tests/` directory

## Coverage

**Requirements:** Not enforced (no coverage threshold)

**View Coverage:**
```bash
pnpm test -- --coverage    # Run with coverage report
```

**Status:** Coverage tracking not currently enforced in CI; focused on production-quality code per phase with manual review.

## Test Types

**Unit Tests:**
- Scope: Single module/class in isolation
- Approach: Heavy use of mocks for dependencies
- Location: Co-located with source (`src/module.test.ts`) or `tests/unit/`
- Example: `packages/core/src/billing/quota-enforcer.test.ts` tests `QuotaEnforcer` class with mocked repos and enforcer

**Integration Tests:**
- Scope: Multiple components working together with real infrastructure
- Approach: Real database (Postgres), real repositories
- Location: `tests/integration/`
- Example: `packages/db/tests/integration/user-tenant-repository.integration.test.ts` uses real database pool
- Requires: `TEST_DATABASE_URL` environment variable pointing to Postgres instance
- Setup: Migrations applied via global setup hook wired in `vitest.config.ts`

**E2E Tests:**
- Scope: Full pipeline end-to-end
- Approach: Real components, in-memory or containerized services
- Location: `tests/e2e/`
- Example: `tests/e2e/full-pipeline.test.ts` exercises crawl → extraction → schema evolution → reconciliation → export
- Configuration: `tests/vitest.config.ts` specifies E2E test inclusion pattern

**Run Integration Tests:**
```bash
# Requires TEST_DATABASE_URL set
pnpm --filter @spatula/db exec vitest run tests/integration/user-tenant-repository.integration.test.ts

# Or run all integration tests for a package
pnpm --filter @spatula/db test
```

## Common Patterns

**Async Testing:**
```typescript
// Using async/await:
it('completes async operation', async () => {
  const result = await manager.createJob(config);
  expect(result).toBe(jobId);
});

// Using rejects matcher:
it('throws on quota exceeded', async () => {
  await expect(manager.startJob(jobId, tenantId)).rejects.toThrow(StateError);
});

// Using resolves matcher:
it('returns job status', async () => {
  await expect(manager.getJobStatus(jobId, tenantId)).resolves.toBe('running');
});
```

**Error Testing with Context:**
```typescript
it('throws StateError for invalid transition', async () => {
  jobRepo.findById.mockResolvedValue({
    id: JOB_ID,
    tenantId: TENANT_ID,
    status: 'completed',
    config: baseConfig,
  });

  // Assert error type AND context
  await expect(manager.pauseJob(JOB_ID, TENANT_ID)).rejects.toMatchObject({
    code: 'STATE_ERROR',
    context: { from: 'completed', to: 'paused' },
  });
});
```

**Custom Matcher Pattern:**
```typescript
expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
  action: 'quota.exceeded',
  actorId: 'system',
  actorType: 'system',
  tenantId: TENANT_ID,
  metadata: expect.objectContaining({ dimension: 'jobs' }),
}));
```

**Cleanup Pattern for Resources:**
```typescript
describe('UserTenantRepository (integration)', () => {
  const createdTenantIds: string[] = [];

  afterAll(async () => {
    // Cleanup: delete dependent records first (FK constraints)
    for (const tid of createdTenantIds) {
      await dbPool.db.execute(sql`DELETE FROM user_tenants WHERE tenant_id = ${tid}`);
      await dbPool.db.execute(sql`DELETE FROM tenants WHERE id = ${tid}::uuid`);
    }
    await dbPool.pool.end();
  });
});
```

## Test Configuration Details

**Vitest Config (unit tests) — `packages/core/vitest.config.ts`:**
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,        // Enable globals (describe, it, expect)
    environment: 'node',  // Node.js environment
  },
});
```

**Vitest Config (E2E) — `tests/vitest.config.ts`:**
```typescript
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.test.ts'],  // Only run files in e2e/
    globals: false,
    passWithNoTests: true,  // Don't fail if no tests found
  },
  resolve: {
    alias: {
      '@spatula/db': resolve(__dirname, '../packages/db/src/index.ts'),
      '@spatula/core': resolve(__dirname, '../packages/core/src/index.ts'),
      '@spatula/queue': resolve(__dirname, '../packages/queue/src/index.ts'),
      '@spatula/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
    },
  },
});
```

**Key Settings:**
- `globals: true` enables top-level `describe`, `it`, `expect` without imports
- `globals: false` in E2E requires explicit imports for better test clarity
- `environment: 'node'` (all tests use Node.js environment)
- `passWithNoTests: true` (E2E config) allows graceful runs when no tests matched

---

*Testing analysis: 2026-05-06*
