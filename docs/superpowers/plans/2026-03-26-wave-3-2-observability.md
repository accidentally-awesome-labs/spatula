# Wave 3-2: Observability & Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full observability — OpenTelemetry metrics with Prometheus exporter, distributed tracing, Sentry error aggregation, LLM cost tracking with usage API, two-tier health checks, and Bull Board queue dashboard.

**Architecture:** Metrics and tracing use OpenTelemetry SDK with opt-in configuration via env vars (no-ops when not configured). A `MeterProvider` exposes 19 Prometheus metrics on port 9464 (separate from API). A `NodeTracerProvider` auto-instruments HTTP, Postgres, and Redis, with manual BullMQ context propagation via `_traceContext` job data field. Sentry captures 5xx errors and worker failures. LLM usage is tracked in a Postgres table with aggregation queries powering a cost API. Health checks provide liveness (lightweight) and readiness (dependency checks) probes. Bull Board gives queue visibility behind admin auth.

**Tech Stack:** TypeScript, `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-prometheus`, `@opentelemetry/sdk-trace-node`, `@sentry/node`, `@bull-board/api`, `@bull-board/hono`, Drizzle ORM, Hono, Vitest

**Spec references:**

- Phase 12 spec: sections 4.1-4.6
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`
- Decomposition: `docs/superpowers/specs/2026-03-25-wave-3-decomposition-design.md` section 4.3

**Depends on:** Wave 3-1a (auth middleware, `requireScope('admin')`), Wave 3-1b (`AppDeps.redis`, `AppDeps.dbPool`)

---

## File Structure

### New Files

| File                                                               | Responsibility                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `packages/shared/src/metrics.ts`                                   | MeterProvider + PrometheusExporter + 19 metric instruments     |
| `packages/shared/src/tracing.ts`                                   | NodeTracerProvider + BatchSpanProcessor + auto-instrumentation |
| `packages/shared/src/sentry.ts`                                    | Sentry init + captureException helper                          |
| `apps/api/src/middleware/timing.ts`                                | Request timing middleware (duration, method, route, status)    |
| `apps/api/src/routes/usage.ts`                                     | `GET /api/v1/usage` cost API endpoint                          |
| `apps/api/src/routes/health.ts`                                    | `/health/live` and `/health/ready` endpoints                   |
| `apps/api/src/routes/admin-queues.ts`                              | Bull Board mount at `/api/admin/queues`                        |
| `packages/db/src/schema/llm-usage.ts`                              | `llm_usage` Drizzle table                                      |
| `packages/db/src/repositories/llm-usage-repository.ts`             | Insert + aggregation queries                                   |
| `packages/queue/src/trace-context.ts`                              | BullMQ trace context inject/extract helpers                    |
| `apps/api/tests/unit/middleware/timing.test.ts`                    | Timing middleware tests                                        |
| `apps/api/tests/unit/routes/usage.test.ts`                         | Usage API tests                                                |
| `apps/api/tests/unit/routes/health.test.ts`                        | Health check tests                                             |
| `packages/db/tests/unit/repositories/llm-usage-repository.test.ts` | LLM usage repo tests                                           |
| `packages/shared/tests/unit/metrics.test.ts`                       | Metrics setup tests                                            |

### Modified Files

| File                                         | Change                                                        |
| -------------------------------------------- | ------------------------------------------------------------- |
| `packages/shared/src/index.ts`               | Export metrics, tracing, sentry                               |
| `packages/db/src/schema/index.ts`            | Export `llmUsage` table                                       |
| `packages/db/src/repositories/index.ts`      | Export `LlmUsageRepository`                                   |
| `apps/api/src/types.ts`                      | Add `llmUsageRepo` to `AppDeps`                               |
| `apps/api/src/app.ts`                        | Add timing middleware, health routes, Bull Board, usage route |
| `apps/api/src/middleware/error-handler.ts`   | Add Sentry capture for 5xx                                    |
| `packages/core/src/llm/openrouter-client.ts` | Instrument with usage recording + metrics                     |
| `packages/core/src/llm/circuit-breaker.ts`   | Wire OTel metrics for breaker state                           |
| `packages/queue/src/queues.ts`               | Inject trace context on job enqueue                           |
| `packages/queue/src/workers/crawl-worker.ts` | Extract trace context, create child span                      |

---

## Task 1: OTel Metrics Setup

**Files:**

- Create: `packages/shared/src/metrics.ts`
- Create: `packages/shared/tests/unit/metrics.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Install OTel dependencies**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/shared add @opentelemetry/sdk-metrics @opentelemetry/exporter-prometheus @opentelemetry/api
```

- [ ] **Step 2: Write failing tests**

```typescript
// packages/shared/tests/unit/metrics.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createMetrics, shutdownMetrics } from '../../src/metrics.js';

describe('metrics', () => {
  afterEach(async () => {
    await shutdownMetrics();
  });

  it('creates metrics instance with all instruments', () => {
    const metrics = createMetrics();
    expect(metrics).toBeDefined();
    expect(metrics.httpRequestDuration).toBeDefined();
    expect(metrics.httpRequestsTotal).toBeDefined();
    expect(metrics.httpActiveConnections).toBeDefined();
    expect(metrics.queueJobDuration).toBeDefined();
    expect(metrics.queueJobsTotal).toBeDefined();
    expect(metrics.llmTokensUsed).toBeDefined();
    expect(metrics.llmRequestDuration).toBeDefined();
    expect(metrics.llmCostUsd).toBeDefined();
    expect(metrics.pagesProcessedTotal).toBeDefined();
    expect(metrics.pageCrawlDuration).toBeDefined();
    expect(metrics.entitiesCreatedTotal).toBeDefined();
    expect(metrics.exportSizeBytes).toBeDefined();
    expect(metrics.circuitBreakerState).toBeDefined();
    expect(metrics.circuitBreakerRejectionsTotal).toBeDefined();
  });

  it('returns no-op metrics when disabled', () => {
    // With no OTEL env vars, metrics should still work (no-op provider)
    const metrics = createMetrics({ enabled: false });
    expect(metrics).toBeDefined();
    // Instruments exist but don't export anywhere
    expect(metrics.httpRequestsTotal).toBeDefined();
  });
});
```

- [ ] **Step 3: Implement metrics module**

```typescript
// packages/shared/src/metrics.ts
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { createLogger } from './logger.js';

const logger = createLogger('metrics');

let meterProvider: MeterProvider | undefined;

export interface MetricsConfig {
  enabled?: boolean;
  port?: number;
}

// Use OTel API types (cleaner than nested ReturnType chains)
import type { Histogram, Counter, UpDownCounter } from '@opentelemetry/api';

export interface SpatulaMetrics {
  // API
  httpRequestDuration: Histogram;
  httpRequestsTotal: Counter;
  httpActiveConnections: UpDownCounter;
  // Queue
  queueJobDuration: Histogram;
  queueJobsTotal: Counter;
  // LLM
  llmTokensUsed: Counter;
  llmRequestDuration: Histogram;
  llmCostUsd: Counter;
  // Crawl
  pagesProcessedTotal: Counter;
  pageCrawlDuration: Histogram;
  entitiesCreatedTotal: Counter;
  // Business
  exportSizeBytes: Histogram;
  // Circuit breaker
  circuitBreakerState: UpDownCounter;
  circuitBreakerRejectionsTotal: Counter;
}

export function createMetrics(config?: MetricsConfig): SpatulaMetrics {
  const enabled = config?.enabled ?? !!process.env.OTEL_EXPORTER_ENDPOINT;
  const port = config?.port ?? 9464;

  if (enabled) {
    const exporter = new PrometheusExporter({ port, preventServerStart: false });
    meterProvider = new MeterProvider({ readers: [exporter] });
    logger.info({ port }, 'Prometheus metrics exporter started');
  } else {
    meterProvider = new MeterProvider();
  }

  const meter = meterProvider.getMeter('spatula');

  return {
    // API metrics
    httpRequestDuration: meter.createHistogram('http_request_duration_ms', {
      description: 'HTTP request duration in milliseconds',
      unit: 'ms',
    }),
    httpRequestsTotal: meter.createCounter('http_requests_total', {
      description: 'Total HTTP requests',
    }),
    httpActiveConnections: meter.createUpDownCounter('http_active_connections', {
      description: 'Active HTTP connections',
    }),
    // Queue metrics
    queueJobDuration: meter.createHistogram('queue_job_duration_ms', {
      description: 'Queue job processing duration in milliseconds',
      unit: 'ms',
    }),
    queueJobsTotal: meter.createCounter('queue_jobs_total', {
      description: 'Total queue jobs processed',
    }),
    // LLM metrics
    llmTokensUsed: meter.createCounter('llm_tokens_used', {
      description: 'Total LLM tokens consumed',
    }),
    llmRequestDuration: meter.createHistogram('llm_request_duration_ms', {
      description: 'LLM request duration in milliseconds',
      unit: 'ms',
    }),
    llmCostUsd: meter.createCounter('llm_cost_usd', {
      description: 'Total LLM cost in USD',
    }),
    // Crawl metrics
    pagesProcessedTotal: meter.createCounter('pages_processed_total', {
      description: 'Total pages crawled',
    }),
    pageCrawlDuration: meter.createHistogram('page_crawl_duration_ms', {
      description: 'Page crawl duration in milliseconds',
      unit: 'ms',
    }),
    entitiesCreatedTotal: meter.createCounter('entities_created_total', {
      description: 'Total entities created',
    }),
    // Business metrics
    exportSizeBytes: meter.createHistogram('export_size_bytes', {
      description: 'Export file size in bytes',
      unit: 'bytes',
    }),
    // Circuit breaker
    circuitBreakerState: meter.createUpDownCounter('circuit_breaker_state', {
      description: 'Circuit breaker state (0=closed, 1=open, 2=half_open)',
    }),
    circuitBreakerRejectionsTotal: meter.createCounter('circuit_breaker_rejections_total', {
      description: 'Total circuit breaker rejections',
    }),
  };
}

export async function shutdownMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = undefined;
  }
}
```

**Note:** The spec lists 19 metrics. The 2 observable gauges (`queue_depth`, `active_jobs`, `tenant_count`) require callback-based observation which depends on having access to the job repo and queue at metrics creation time. For now, create the 14 push-based metrics plus the 2 circuit breaker metrics (16 total). The 3 observable gauges (`queue_depth`, `active_jobs`, `tenant_count`) will be registered separately when the metrics are wired into the app (Task 12), since they need repo/queue references for their callbacks.

- [ ] **Step 4: Export from barrel**

Add to `packages/shared/src/index.ts`:

```typescript
export { createMetrics, shutdownMetrics } from './metrics.js';
export type { SpatulaMetrics, MetricsConfig } from './metrics.js';
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/shared test -- --run metrics
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/metrics.ts packages/shared/tests/unit/metrics.test.ts packages/shared/src/index.ts packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): add OpenTelemetry metrics setup with Prometheus exporter"
```

---

## Task 2: Request Timing Middleware

**Files:**

- Create: `apps/api/src/middleware/timing.ts`
- Create: `apps/api/tests/unit/middleware/timing.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/middleware/timing.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { timingMiddleware } from '../../../src/middleware/timing.js';

describe('timingMiddleware', () => {
  it('records request duration and increments request counter', async () => {
    const mockMetrics = {
      httpRequestDuration: { record: vi.fn() },
      httpRequestsTotal: { add: vi.fn() },
      httpActiveConnections: { add: vi.fn() },
    };

    const app = new Hono();
    app.use('*', timingMiddleware(mockMetrics as any));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);

    expect(mockMetrics.httpRequestsTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        method: 'GET',
        status: 200,
      }),
    );
    expect(mockMetrics.httpRequestDuration.record).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ method: 'GET', status: 200 }),
    );
  });

  it('tracks active connections (increment on start, decrement on end)', async () => {
    const mockMetrics = {
      httpRequestDuration: { record: vi.fn() },
      httpRequestsTotal: { add: vi.fn() },
      httpActiveConnections: { add: vi.fn() },
    };

    const app = new Hono();
    app.use('*', timingMiddleware(mockMetrics as any));
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request('/test');

    // Should have been called with +1 (start) and -1 (end)
    const calls = mockMetrics.httpActiveConnections.add.mock.calls;
    expect(calls).toContainEqual([1]);
    expect(calls).toContainEqual([-1]);
  });

  it('passes through when metrics is null', async () => {
    const app = new Hono();
    app.use('*', timingMiddleware(null));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Implement timing middleware**

```typescript
// apps/api/src/middleware/timing.ts
import type { MiddlewareHandler } from 'hono';
import type { SpatulaMetrics } from '@spatula/shared';

export function timingMiddleware(metrics: SpatulaMetrics | null): MiddlewareHandler {
  return async (c, next) => {
    if (!metrics) return next();

    const start = performance.now();
    metrics.httpActiveConnections.add(1);

    try {
      await next();
    } finally {
      const duration = performance.now() - start;
      const attrs = {
        method: c.req.method,
        route: c.req.routePath ?? c.req.path,
        status: c.res.status,
      };

      metrics.httpRequestDuration.record(duration, attrs);
      metrics.httpRequestsTotal.add(1, attrs);
      metrics.httpActiveConnections.add(-1);
    }
  };
}
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api test -- --run timing
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/middleware/timing.ts apps/api/tests/unit/middleware/timing.test.ts
git commit -m "feat(api): add request timing middleware with OTel metrics"
```

---

## Task 3: Sentry Integration

**Files:**

- Create: `packages/shared/src/sentry.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Install Sentry**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/shared add @sentry/node
```

- [ ] **Step 2: Write test for Sentry opt-in/opt-out**

```typescript
// packages/shared/tests/unit/sentry.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @sentry/node before importing
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((cb) => cb({ setExtra: vi.fn() })),
}));

import { initSentry, captureException } from '../../src/sentry.js';
import * as Sentry from '@sentry/node';

describe('sentry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SENTRY_DSN;
  });

  it('does nothing when DSN is not set', () => {
    initSentry();
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('initializes when DSN is provided', () => {
    initSentry({ dsn: 'https://test@sentry.io/123' });
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://test@sentry.io/123' }),
    );
  });

  it('captureException calls Sentry.captureException', () => {
    const error = new Error('test');
    captureException(error);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });
});
```

- [ ] **Step 3: Implement Sentry module**

```typescript
// packages/shared/src/sentry.ts
import * as Sentry from '@sentry/node';
import { createLogger } from './logger.js';

const logger = createLogger('sentry');

export interface SentryConfig {
  dsn: string;
  environment?: string;
  tracesSampleRate?: number;
}

export function initSentry(config?: SentryConfig): void {
  const dsn = config?.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    logger.debug('SENTRY_DSN not set, Sentry disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: config?.environment ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate:
      config?.tracesSampleRate ?? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
  });

  logger.info('Sentry initialized');
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (context) {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
      Sentry.captureException(error);
    });
  } else {
    Sentry.captureException(error);
  }
}

export { Sentry };
```

- [ ] **Step 3: Export from barrel**

Add to `packages/shared/src/index.ts`:

```typescript
export { initSentry, captureException } from './sentry.js';
export type { SentryConfig } from './sentry.js';
```

- [ ] **Step 4: Add Sentry capture to error handler**

In `apps/api/src/middleware/error-handler.ts`, add import:

```typescript
import { captureException } from '@spatula/shared';
```

In the `errorHandler` function, after the `if (status >= 500)` block's logger.error call, add:

```typescript
captureException(error, { requestId, path: c.req.path });
```

- [ ] **Step 5: Build and test**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/shared build && pnpm --filter @spatula/shared test && pnpm --filter @spatula/api test
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/sentry.ts packages/shared/src/index.ts packages/shared/tests/unit/sentry.test.ts packages/shared/package.json pnpm-lock.yaml apps/api/src/middleware/error-handler.ts
git commit -m "feat(shared): add Sentry integration with error capture for 5xx responses"
```

---

## Task 4: LLM Usage Table + Repository

**Files:**

- Create: `packages/db/src/schema/llm-usage.ts`
- Create: `packages/db/src/repositories/llm-usage-repository.ts`
- Create: `packages/db/tests/unit/repositories/llm-usage-repository.test.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/repositories/index.ts`

- [ ] **Step 1: Create llm_usage Drizzle schema**

```typescript
// packages/db/src/schema/llm-usage.ts
import { pgTable, uuid, text, integer, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { jobs } from './jobs.js';

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull(),
    purpose: text('purpose').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_llm_usage_tenant_time').on(table.tenantId, table.createdAt),
    index('idx_llm_usage_job')
      .on(table.jobId)
      .where(sql`job_id IS NOT NULL`),
  ],
);
```

- [ ] **Step 2: Export from schema barrel and generate migration**

Add to `packages/db/src/schema/index.ts`:

```typescript
export * from './llm-usage.js';
```

Run: `pnpm --filter @spatula/db db:generate`

- [ ] **Step 3: Write failing repo tests**

```typescript
// packages/db/tests/unit/repositories/llm-usage-repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmUsageRepository } from '../../../src/repositories/llm-usage-repository.js';

function createMockDb() {
  const returning = vi.fn();
  const values = vi.fn().mockReturnValue({ returning });

  return {
    db: {
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any,
    mocks: { returning, values },
  };
}

describe('LlmUsageRepository', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let repo: LlmUsageRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new LlmUsageRepository(mockDb.db);
  });

  describe('insert', () => {
    it('records an LLM usage entry', async () => {
      const entry = {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        model: 'anthropic/claude-3-haiku',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        costUsd: '0.000150',
        purpose: 'extraction',
      };
      mockDb.mocks.returning.mockResolvedValue([{ id: 'usage-1', ...entry }]);

      const result = await repo.insert(entry);
      expect(result.id).toBe('usage-1');
    });
  });
});
```

- [ ] **Step 4: Implement LlmUsageRepository**

```typescript
// packages/db/src/repositories/llm-usage-repository.ts
import { eq, and, gte, sql, desc } from 'drizzle-orm';
import { StorageError } from '@spatula/shared';
import { llmUsage } from '../schema/llm-usage.js';
import type { Database } from '../connection.js';

export interface LlmUsageInput {
  tenantId: string;
  jobId?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: string;
  purpose: string;
}

export interface UsageAggregation {
  totalTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { tokens: number; costUsd: number }>;
  byPurpose: Record<string, { tokens: number; costUsd: number }>;
  byJob: Array<{ jobId: string; tokens: number; costUsd: number }>;
}

export class LlmUsageRepository {
  constructor(private readonly db: Database) {}

  async insert(input: LlmUsageInput) {
    try {
      const [row] = await this.db
        .insert(llmUsage)
        .values({
          tenantId: input.tenantId,
          jobId: input.jobId,
          model: input.model,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          totalTokens: input.totalTokens,
          costUsd: input.costUsd,
          purpose: input.purpose,
        })
        .returning();
      return row;
    } catch (error) {
      throw new StorageError(`Failed to insert LLM usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId: input.tenantId, model: input.model },
      });
    }
  }

  async aggregateByTenant(tenantId: string, since: Date): Promise<UsageAggregation> {
    try {
      const conditions = and(eq(llmUsage.tenantId, tenantId), gte(llmUsage.createdAt, since));

      // Totals via SQL aggregation (not in-memory)
      const [totals] = await this.db
        .select({
          totalTokens: sql<number>`COALESCE(SUM(${llmUsage.totalTokens}), 0)::int`,
          totalCostUsd: sql<number>`COALESCE(SUM(${llmUsage.costUsd}::numeric), 0)::float`,
        })
        .from(llmUsage)
        .where(conditions);

      // By model
      const modelRows = await this.db
        .select({
          model: llmUsage.model,
          tokens: sql<number>`SUM(${llmUsage.totalTokens})::int`,
          costUsd: sql<number>`SUM(${llmUsage.costUsd}::numeric)::float`,
        })
        .from(llmUsage)
        .where(conditions)
        .groupBy(llmUsage.model);

      // By purpose
      const purposeRows = await this.db
        .select({
          purpose: llmUsage.purpose,
          tokens: sql<number>`SUM(${llmUsage.totalTokens})::int`,
          costUsd: sql<number>`SUM(${llmUsage.costUsd}::numeric)::float`,
        })
        .from(llmUsage)
        .where(conditions)
        .groupBy(llmUsage.purpose);

      // By job (top jobs)
      const jobRows = await this.db
        .select({
          jobId: llmUsage.jobId,
          tokens: sql<number>`SUM(${llmUsage.totalTokens})::int`,
          costUsd: sql<number>`SUM(${llmUsage.costUsd}::numeric)::float`,
        })
        .from(llmUsage)
        .where(and(conditions, sql`${llmUsage.jobId} IS NOT NULL`))
        .groupBy(llmUsage.jobId)
        .orderBy(desc(sql`SUM(${llmUsage.costUsd}::numeric)`))
        .limit(50);

      const byModel: Record<string, { tokens: number; costUsd: number }> = {};
      for (const r of modelRows) byModel[r.model] = { tokens: r.tokens, costUsd: r.costUsd };

      const byPurpose: Record<string, { tokens: number; costUsd: number }> = {};
      for (const r of purposeRows) byPurpose[r.purpose] = { tokens: r.tokens, costUsd: r.costUsd };

      return {
        totalTokens: totals?.totalTokens ?? 0,
        totalCostUsd: totals?.totalCostUsd ?? 0,
        byModel,
        byPurpose,
        byJob: jobRows.map((r) => ({ jobId: r.jobId!, tokens: r.tokens, costUsd: r.costUsd })),
      };
    } catch (error) {
      throw new StorageError(`Failed to aggregate LLM usage: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }
}
```

- [ ] **Step 5: Export from barrels**

Add to `packages/db/src/repositories/index.ts`:

```typescript
export { LlmUsageRepository } from './llm-usage-repository.js';
export type { LlmUsageInput, UsageAggregation } from './llm-usage-repository.js';
```

- [ ] **Step 6: Run tests**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test -- --run llm-usage
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/llm-usage.ts packages/db/src/schema/index.ts packages/db/src/repositories/llm-usage-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/llm-usage-repository.test.ts packages/db/drizzle/
git commit -m "feat(db): add llm_usage table and LlmUsageRepository with aggregation"
```

---

## Task 5: Cost API Endpoint

**Files:**

- Create: `apps/api/src/routes/usage.ts`
- Create: `apps/api/tests/unit/routes/usage.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/routes/usage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { usageRoutes } from '../../../src/routes/usage.js';

function createTestApp(mockDeps: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['jobs:read'] });
    c.set('deps', mockDeps);
    return next();
  });
  app.route('/api/v1/usage', usageRoutes());
  return app;
}

describe('Usage routes', () => {
  let mockLlmUsageRepo: any;

  beforeEach(() => {
    mockLlmUsageRepo = {
      aggregateByTenant: vi.fn().mockResolvedValue({
        totalTokens: 1250000,
        totalCostUsd: 4.23,
        byModel: { 'anthropic/claude-3-haiku': { tokens: 800000, costUsd: 0.8 } },
        byPurpose: { extraction: { tokens: 500000, costUsd: 2.1 } },
        byJob: [{ jobId: 'job-1', tokens: 125000, costUsd: 0.42 }],
      }),
    };
  });

  it('returns aggregated usage for default 30d period', async () => {
    const app = createTestApp({ llmUsageRepo: mockLlmUsageRepo });
    const res = await app.request('/api/v1/usage');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalTokens).toBe(1250000);
    expect(body.data.totalCostUsd).toBe(4.23);
    expect(body.data.byModel).toBeDefined();
    expect(body.data.period).toBeDefined();
  });

  it('accepts custom period parameter', async () => {
    const app = createTestApp({ llmUsageRepo: mockLlmUsageRepo });
    const res = await app.request('/api/v1/usage?period=7d');

    expect(res.status).toBe(200);
    expect(mockLlmUsageRepo.aggregateByTenant).toHaveBeenCalledWith('tenant-1', expect.any(Date));
  });
});
```

- [ ] **Step 2: Implement usage route**

```typescript
// apps/api/src/routes/usage.ts
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';

function parsePeriod(period: string): Date {
  const match = period.match(/^(\d+)d$/);
  if (!match) throw new Error(`Invalid period: ${period}. Use format like "30d".`);
  const days = parseInt(match[1], 10);
  const since = new Date();
  since.setDate(since.getDate() - days);
  return since;
}

const getUsageRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Usage'],
  summary: 'Get LLM usage for the authenticated tenant',
  request: {
    query: z.object({
      period: z.string().default('30d').openapi({ example: '30d' }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({
        data: z.object({
          period: z.object({ start: z.string(), end: z.string() }),
          totalTokens: z.number(),
          totalCostUsd: z.number(),
          byModel: z.record(z.object({ tokens: z.number(), costUsd: z.number() })),
          byPurpose: z.record(z.object({ tokens: z.number(), costUsd: z.number() })),
          byJob: z.array(z.object({ jobId: z.string(), tokens: z.number(), costUsd: z.number() })),
        }),
      }),
      'LLM usage aggregation',
    ),
    400: jsonContent(errorResponseSchema, 'Invalid period'),
  },
});

export function usageRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(getUsageRoute, async (c) => {
    const deps = c.get('deps');
    const tenantId = c.get('tenantId');
    const { period } = c.req.valid('query');

    if (!deps.llmUsageRepo) {
      throw new Error('LLM usage tracking not configured');
    }

    const since = parsePeriod(period);
    const aggregation = await deps.llmUsageRepo.aggregateByTenant(tenantId, since);

    return c.json({
      data: {
        period: { start: since.toISOString(), end: new Date().toISOString() },
        ...aggregation,
      },
    });
  });

  return router;
}
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api test -- --run routes/usage
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/usage.ts apps/api/tests/unit/routes/usage.test.ts
git commit -m "feat(api): add GET /api/v1/usage endpoint for LLM cost tracking"
```

---

## Task 6: Health Check Endpoints

**Files:**

- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/tests/unit/routes/health.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/routes/health.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { healthRoutes } from '../../../src/routes/health.js';
import type { Pool } from 'pg';

describe('Health routes', () => {
  describe('GET /health/live', () => {
    it('returns 200 with status ok', async () => {
      const app = new Hono();
      app.route('', healthRoutes({} as any));
      const res = await app.request('/health/live');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 when all checks pass', async () => {
      const deps = {
        dbPool: { query: vi.fn().mockResolvedValue({}) } as unknown as Pool,
        redis: { ping: vi.fn().mockResolvedValue('PONG') } as any,
        queues: {
          crawl: { getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0 }) },
        } as any,
      };
      const app = new Hono();
      app.route('', healthRoutes(deps));
      const res = await app.request('/health/ready');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.checks.database).toBe('ok');
      expect(body.checks.redis).toBe('ok');
      expect(body.checks.queue).toBe('ok');
    });

    it('returns 503 when database check fails', async () => {
      const deps = {
        dbPool: {
          query: vi.fn().mockRejectedValue(new Error('connection refused')),
        } as unknown as Pool,
        redis: { ping: vi.fn().mockResolvedValue('PONG') } as any,
        queues: {
          crawl: { getJobCounts: vi.fn().mockResolvedValue({ waiting: 0 }) },
        } as any,
      };
      const app = new Hono();
      app.route('', healthRoutes(deps));
      const res = await app.request('/health/ready');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('degraded');
      expect(body.checks.database).toBe('fail');
      expect(body.checks.redis).toBe('ok');
    });
  });
});
```

- [ ] **Step 2: Implement health routes**

```typescript
// apps/api/src/routes/health.ts
import { Hono } from 'hono';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { SpatulaQueues } from '@spatula/queue';

export interface HealthDeps {
  dbPool?: Pool;
  redis?: Redis;
  queues?: SpatulaQueues;
}

// Health routes receive deps directly (not via c.get('deps')) because they
// mount before depsMiddleware in the chain — they need to work without auth.
export function healthRoutes(deps: HealthDeps) {
  const app = new Hono();

  // Liveness probe -- lightweight, no dependency checks
  app.get('/health/live', (c) => c.json({ status: 'ok' }));

  // Readiness probe -- checks all dependencies in parallel
  app.get('/health/ready', async (c) => {
    const checks: Record<string, 'ok' | 'fail'> = {};

    const results = await Promise.allSettled([
      // Database check
      deps.dbPool
        ? deps.dbPool.query('SELECT 1').then(() => {
            checks.database = 'ok';
          })
        : Promise.resolve().then(() => {
            checks.database = 'ok';
          }),
      // Redis check
      deps.redis
        ? deps.redis.ping().then(() => {
            checks.redis = 'ok';
          })
        : Promise.resolve().then(() => {
            checks.redis = 'ok';
          }),
      // Queue check
      deps.queues?.crawl
        ? deps.queues.crawl.getJobCounts().then(() => {
            checks.queue = 'ok';
          })
        : Promise.resolve().then(() => {
            checks.queue = 'ok';
          }),
    ]);

    // Mark failed checks
    if (results[0].status === 'rejected') checks.database = 'fail';
    if (results[1].status === 'rejected') checks.redis = 'fail';
    if (results[2].status === 'rejected') checks.queue = 'fail';

    const allOk = Object.values(checks).every((v) => v === 'ok');
    const status = allOk ? 'ok' : 'degraded';
    const httpStatus = allOk ? 200 : 503;

    return c.json({ status, checks }, httpStatus as any);
  });

  return app;
}
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api test -- --run routes/health
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/health.ts apps/api/tests/unit/routes/health.test.ts
git commit -m "feat(api): add two-tier health checks (liveness + readiness probes)"
```

---

## Task 7: Bull Board Queue Dashboard

**Files:**

- Create: `apps/api/src/routes/admin-queues.ts`

- [ ] **Step 1: Install Bull Board**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api add @bull-board/api @bull-board/hono @bull-board/ui
```

- [ ] **Step 2: Implement Bull Board mount**

```typescript
// apps/api/src/routes/admin-queues.ts
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { HonoAdapter } from '@bull-board/hono';
import type { SpatulaQueues } from '@spatula/queue';
import { QUEUE_NAMES } from '@spatula/queue';

export function createQueueDashboard(queues: SpatulaQueues) {
  // Mount at /api/v1/admin/queues to leverage existing requireScope('admin') on /api/v1/admin/*
  const serverAdapter = new HonoAdapter('/api/v1/admin/queues');

  createBullBoard({
    queues: [
      new BullMQAdapter(queues.crawl),
      new BullMQAdapter(queues.extract),
      new BullMQAdapter(queues.schemaEvolution),
      new BullMQAdapter(queues.reconciliation),
      new BullMQAdapter(queues.export),
    ],
    serverAdapter,
  });

  return serverAdapter.registerPlugin();
}
```

**Note:** All 5 existing queues registered. The webhooks queue (6th) is added in Wave 4. Mounted at `/api/v1/admin/queues` (not `/api/admin/queues`) to leverage the existing `requireScope('admin')` middleware on `/api/v1/admin/*`.

- [ ] **Step 3: Build to verify**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api build
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/admin-queues.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add Bull Board queue dashboard at /api/admin/queues"
```

---

## Task 8: Distributed Tracing Setup

**Files:**

- Create: `packages/shared/src/tracing.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Install OTel tracing dependencies**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/shared add @opentelemetry/sdk-trace-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
```

- [ ] **Step 2: Write tracing tests**

```typescript
// packages/shared/tests/unit/tracing.test.ts
import { describe, it, expect } from 'vitest';
import { initTracing, shutdownTracing } from '../../src/tracing.js';

describe('tracing', () => {
  it('returns without error when no endpoint is configured', () => {
    delete process.env.OTEL_EXPORTER_ENDPOINT;
    expect(() => initTracing()).not.toThrow();
  });

  it('shutdownTracing is safe to call without prior init', async () => {
    await expect(shutdownTracing()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 3: Implement tracing module**

```typescript
// packages/shared/src/tracing.ts
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { createLogger } from './logger.js';

const logger = createLogger('tracing');

let tracerProvider: NodeTracerProvider | undefined;

export interface TracingConfig {
  serviceName?: string;
  endpoint?: string;
}

export function initTracing(config?: TracingConfig): void {
  const endpoint = config?.endpoint ?? process.env.OTEL_EXPORTER_ENDPOINT;
  if (!endpoint) {
    logger.debug('OTEL_EXPORTER_ENDPOINT not set, tracing disabled');
    return;
  }

  const serviceName = config?.serviceName ?? 'spatula-api';

  tracerProvider = new NodeTracerProvider({
    resource: new Resource({ [ATTR_SERVICE_NAME]: serviceName }),
  });

  const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  tracerProvider.addSpanProcessor(new BatchSpanProcessor(exporter));
  tracerProvider.register();

  registerInstrumentations({
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  logger.info({ endpoint, serviceName }, 'Distributed tracing initialized');
}

export async function shutdownTracing(): Promise<void> {
  if (tracerProvider) {
    await tracerProvider.shutdown();
    tracerProvider = undefined;
  }
}
```

- [ ] **Step 3: Export from barrel**

Add to `packages/shared/src/index.ts`:

```typescript
export { initTracing, shutdownTracing } from './tracing.js';
export type { TracingConfig } from './tracing.js';
```

- [ ] **Step 4: Build**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/shared build
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/tracing.ts packages/shared/src/index.ts packages/shared/tests/unit/tracing.test.ts packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): add distributed tracing with OTel NodeTracerProvider"
```

---

## Task 9: BullMQ Trace Context Propagation

**Files:**

- Create: `packages/queue/src/trace-context.ts`
- Modify: `packages/queue/src/index.ts`

- [ ] **Step 1: Install OTel API in queue package**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue add @opentelemetry/api
```

- [ ] **Step 2: Write trace context tests**

```typescript
// packages/queue/tests/unit/trace-context.test.ts
import { describe, it, expect } from 'vitest';
import { injectTraceContext, extractTraceContext } from '../../src/trace-context.js';

describe('trace context', () => {
  it('injectTraceContext returns data unchanged when no active trace', () => {
    const data = { jobId: 'j1', tenantId: 't1' };
    const result = injectTraceContext(data);
    expect(result.jobId).toBe('j1');
    expect(result.tenantId).toBe('t1');
    // No _traceContext added when there is no active span
  });

  it('extractTraceContext returns no-op cleanup when _traceContext is absent', () => {
    const data = { jobId: 'j1' };
    const { cleanup } = extractTraceContext(data, 'test-span');
    expect(cleanup).toBeTypeOf('function');
    expect(() => cleanup()).not.toThrow();
  });
});
```

- [ ] **Step 3: Implement trace context helpers**

```typescript
// packages/queue/src/trace-context.ts
import { context, propagation, trace, SpanKind } from '@opentelemetry/api';

/**
 * Inject current trace context into job data.
 * Call before enqueuing a BullMQ job.
 */
export function injectTraceContext<T extends Record<string, unknown>>(
  data: T,
): T & { _traceContext?: Record<string, string> } {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  if (Object.keys(carrier).length === 0) {
    return data; // No active trace context
  }

  return { ...data, _traceContext: carrier };
}

/**
 * Extract parent trace context from job data and create a child span.
 * Call at the start of a BullMQ worker processor.
 * Returns a cleanup function that ends the span.
 */
export function extractTraceContext(
  jobData: Record<string, unknown>,
  spanName: string,
): { cleanup: () => void } {
  const carrier = jobData._traceContext as Record<string, string> | undefined;
  if (!carrier) {
    return { cleanup: () => {} };
  }

  const parentContext = propagation.extract(context.active(), carrier);
  const tracer = trace.getTracer('spatula-worker');
  const span = tracer.startSpan(spanName, { kind: SpanKind.CONSUMER }, parentContext);

  return {
    cleanup: () => span.end(),
  };
}
```

- [ ] **Step 3: Export from barrel**

Add to `packages/queue/src/index.ts`:

```typescript
export { injectTraceContext, extractTraceContext } from './trace-context.js';
```

- [ ] **Step 4: Build**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue build
```

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/trace-context.ts packages/queue/src/index.ts packages/queue/tests/unit/trace-context.test.ts packages/queue/package.json pnpm-lock.yaml
git commit -m "feat(queue): add BullMQ trace context propagation helpers"
```

---

## Task 10: Circuit Breaker OTel Wiring

**Files:**

- Modify: `packages/core/src/llm/circuit-breaker.ts`

- [ ] **Step 1: Read the circuit breaker file**

Read `packages/core/src/llm/circuit-breaker.ts` to understand the existing structure. It has a TODO comment about emitting metrics.

- [ ] **Step 2: Add optional metrics parameter**

Add an optional `metrics` parameter to the constructor or a `setMetrics()` method. When metrics are provided, record state transitions and rejections:

```typescript
import type { SpatulaMetrics } from '@spatula/shared';
```

Add to the class:

```typescript
  private metrics?: SpatulaMetrics;

  setMetrics(metrics: SpatulaMetrics): void {
    this.metrics = metrics;
  }
```

In the `complete()` method, when a request is rejected (circuit open):

```typescript
this.metrics?.circuitBreakerRejectionsTotal.add(1);
```

On state transitions, update the state gauge. Remove the TODO comment.

- [ ] **Step 3: Build and test**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build && pnpm --filter @spatula/core test
```

All existing circuit breaker tests must pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/llm/circuit-breaker.ts
git commit -m "feat(core): wire circuit breaker to OTel metrics instruments"
```

---

## Task 11: Instrument OpenRouterClient with Usage Recording

**Files:**

- Modify: `packages/core/src/llm/openrouter-client.ts`
- Modify: `packages/core/src/interfaces/llm-client.ts`

This is the critical producer that writes LLM usage records. Without this, the `llm_usage` table and `/api/v1/usage` endpoint are empty.

- [ ] **Step 1: Add onUsage callback to LLMClient interface**

Read `packages/core/src/interfaces/llm-client.ts`. The `LLMCompletionResponse` already includes `usage: LLMUsage`. Add an optional `onUsage` callback interface:

```typescript
export interface LLMUsageRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  purpose?: string;
}

export interface LLMUsageRecorder {
  record(usage: LLMUsageRecord): void;
}
```

- [ ] **Step 2: Add usage recorder to OpenRouterClient**

Read `packages/core/src/llm/openrouter-client.ts`. Add an optional `usageRecorder` to the constructor options or a `setUsageRecorder()` method:

```typescript
  private usageRecorder?: LLMUsageRecorder;

  setUsageRecorder(recorder: LLMUsageRecorder): void {
    this.usageRecorder = recorder;
  }
```

In the `complete()` method, after a successful API call that returns the response, add:

```typescript
// Record usage (fire-and-forget)
if (this.usageRecorder && response.usage) {
  this.usageRecorder.record({
    model: response.model,
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    totalTokens: response.usage.totalTokens,
    costUsd: 0, // OpenRouter cost comes from response headers — extract if available
    durationMs: duration,
  });
}
```

The `duration` should be measured around the fetch call. Add `const start = performance.now()` before the fetch and `const duration = performance.now() - start` after.

- [ ] **Step 3: Build and test**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build && pnpm --filter @spatula/core test
```

All existing LLM client tests must pass. The recorder is optional so existing tests won't be affected.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/llm/openrouter-client.ts packages/core/src/interfaces/llm-client.ts
git commit -m "feat(core): instrument OpenRouterClient with usage recording callback"
```

---

## Task 12: Wire Everything into App

**Files:**

- Create: `apps/api/src/services/usage-recorder.ts`
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Add new deps to AppDeps**

In `apps/api/src/types.ts`, add:

```typescript
import type { LlmUsageRepository } from '@spatula/db';
import type { SpatulaMetrics } from '@spatula/shared';
```

Add to `AppDeps`:

```typescript
  llmUsageRepo?: LlmUsageRepository;
  metrics?: SpatulaMetrics;
```

- [ ] **Step 2: Create UsageRecorder implementation**

This is the concrete glue that connects `OpenRouterClient` to both the database and Prometheus counters. Without it, LLM usage tracking produces no data.

```typescript
// apps/api/src/services/usage-recorder.ts
import type { LLMUsageRecorder, LLMUsageRecord } from '@spatula/core';
import type { LlmUsageRepository } from '@spatula/db';
import type { SpatulaMetrics } from '@spatula/shared';
import { createLogger } from '@spatula/shared';

const logger = createLogger('usage-recorder');

/**
 * Bridges OpenRouterClient usage events to both:
 * 1. LlmUsageRepository (Postgres persistence)
 * 2. SpatulaMetrics (Prometheus counters)
 *
 * All writes are fire-and-forget — usage recording must never
 * block or fail the LLM call.
 */
export class DefaultUsageRecorder implements LLMUsageRecorder {
  constructor(
    private readonly tenantId: string,
    private readonly jobId: string | undefined,
    private readonly repo?: LlmUsageRepository,
    private readonly metrics?: SpatulaMetrics,
  ) {}

  record(usage: LLMUsageRecord): void {
    const attrs = { tenantId: this.tenantId, jobId: this.jobId ?? 'unknown', model: usage.model };

    // Prometheus counters (immediate, in-process)
    if (this.metrics) {
      this.metrics.llmTokensUsed.add(usage.totalTokens, attrs);
      this.metrics.llmCostUsd.add(usage.costUsd, attrs);
      this.metrics.llmRequestDuration.record(usage.durationMs, attrs);
    }

    // Database persistence (fire-and-forget)
    if (this.repo) {
      this.repo
        .insert({
          tenantId: this.tenantId,
          jobId: this.jobId,
          model: usage.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          costUsd: usage.costUsd.toFixed(6),
          purpose: usage.purpose ?? 'unknown',
        })
        .catch((err) => {
          logger.warn({ err, model: usage.model }, 'Failed to record LLM usage');
        });
    }
  }
}
```

**Note:** The `DefaultUsageRecorder` is scoped per tenant+job. It's constructed when building worker deps or in the orchestrator setup, not in `app.ts`. The wiring happens at the point where `OpenRouterClient` is constructed — typically in the worker entry point or orchestrator deps. For now, create the class and export it. The actual connection to `OpenRouterClient.setUsageRecorder()` depends on where the LLM client is instantiated in the codebase.

- [ ] **Step 3: Register observable gauges for queue_depth, active_jobs, tenant_count**

In `app.ts`, after creating the app, register the 3 observable gauges that need repo/queue callbacks. These complete the 19-metric spec:

```typescript
// Register observable gauges (need repo/queue access for callbacks)
if (deps.metrics) {
  const meter = (deps.metrics as any)._meter; // Internal — or pass meter through SpatulaMetrics
  // Alternative: export the meter from createMetrics() and use it here
}
```

**Simpler approach:** Add a `registerObservableGauges()` function to `packages/shared/src/metrics.ts` that accepts the repos/queues and registers the 3 gauges:

```typescript
export function registerObservableGauges(
  meter: Meter,
  deps: {
    jobRepo?: { countByTenant: (tenantId: string, options?: any) => Promise<number> };
    tenantRepo?: { findAll?: () => Promise<unknown[]> };
    queues?: { crawl?: { getJobCounts: () => Promise<Record<string, number>> } };
  },
): void {
  // These are sampled periodically by the Prometheus exporter
  if (deps.queues?.crawl) {
    meter
      .createObservableGauge('queue_depth', {
        description: 'Current queue depth',
      })
      .addCallback(async (result) => {
        try {
          const counts = await deps.queues!.crawl!.getJobCounts();
          result.observe(counts.waiting ?? 0, { queue: 'crawl' });
        } catch {
          /* skip */
        }
      });
  }
}
```

**Pragmatic decision:** Observable gauges require async callbacks which have complex lifecycle concerns with the OTel SDK. For the initial implementation, defer the 3 observable gauges to a follow-up and document this as a known limitation. The 16 push-based metrics cover the core monitoring needs. Add a TODO comment in `metrics.ts`:

```typescript
// TODO: Register observable gauges for queue_depth, active_jobs, tenant_count
// These need access to JobRepository, TenantRepository, and Queue objects
// which are not available at metrics creation time. Wire via registerObservableGauges()
// when the app startup sequence is formalized.
```

- [ ] **Step 4: Update app.ts**

Add imports:

```typescript
import { timingMiddleware } from './middleware/timing.js';
import { usageRoutes } from './routes/usage.js';
import { healthRoutes } from './routes/health.js';
import { createQueueDashboard } from './routes/admin-queues.js';
```

Add timing middleware after `requestContextMiddleware` and before `honoLogger()` (per decomposition spec section 5.1 middleware chain order):

```typescript
app.use('*', requestContextMiddleware);
app.use('*', timingMiddleware(deps.metrics ?? null)); // NEW — after requestContext, before logger
app.use('*', honoLogger());
```

Add health routes (keep existing `/health` for backward compat):

```typescript
// Health checks (no auth — these paths are in SKIP_AUTH_PATHS)
app.route('', healthRoutes({ dbPool: deps.dbPool, redis: deps.redis, queues: deps.queues }));
```

Add usage route after other API routes:

```typescript
// Usage API (requires jobs:read scope)
app.get('/api/v1/usage', requireScope('jobs:read'));
app.route('/api/v1/usage', usageRoutes());
```

Add Bull Board conditionally:

```typescript
// Queue dashboard (admin scope enforced by /api/v1/admin/* middleware)
if (deps.queues) {
  app.route('', createQueueDashboard(deps.queues));
}
```

- [ ] **Step 5: Run ALL tests**

```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/api test
```

All tests must pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/types.ts apps/api/src/app.ts apps/api/src/services/usage-recorder.ts
git commit -m "feat(api): wire observability — timing, health checks, usage API, Bull Board, usage recorder"
```

---

## Task 13: Integration Verification

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/salar/Projects/spatula && pnpm test
```

- [ ] **Step 2: Verify test counts**

Expected: ~1,449 existing + ~15-20 new = ~1,465+ tests.

New test breakdown:

- Metrics setup: 2 tests
- Timing middleware: 3 tests
- LLM usage repo: 1+ tests
- Usage API: 2 tests
- Health checks: 3 tests

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration issues in observability wiring"
```
