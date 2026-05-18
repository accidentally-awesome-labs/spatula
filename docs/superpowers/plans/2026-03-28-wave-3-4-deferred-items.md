# Wave 3-4: Deferred D/F Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four features deferred from Wave 2 that depend on Redis and auth infrastructure: idempotency middleware, worker health monitoring, quality score aggregation API, and confidence-based export filtering.

**Architecture:** All four items are independent (no inter-dependencies). Idempotency uses Redis to cache POST/PATCH responses by `Idempotency-Key` header. Worker health uses Redis heartbeats with TTL for crash detection. Quality aggregation runs SQL aggregation queries against the entities table. Export filtering extends the existing export creation and orchestrator with `minQuality` and `fields` parameters.

**Tech Stack:** TypeScript, Hono, ioredis, Drizzle ORM (Postgres), Vitest

**Spec references:**

- Phase 12 spec: sections 5.4-5.5, 7.5-7.6
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`
- Decomposition: `docs/superpowers/specs/2026-03-25-wave-3-decomposition-design.md` section 4.6

**Depends on:** Wave 3-1b (`AppDeps.redis`, `requireScope('admin')`), Wave 3-3a (`fetchEntitiesCursor`, `StreamingCsvExporter`), Wave 3-3b (cursor pagination on export endpoint)

---

## File Structure

### New Files

| File                                                 | Responsibility                          |
| ---------------------------------------------------- | --------------------------------------- |
| `apps/api/src/middleware/idempotency.ts`             | Idempotency middleware (Redis-backed)   |
| `apps/api/src/routes/admin-workers.ts`               | `GET /api/v1/admin/workers` endpoint    |
| `apps/api/src/routes/quality.ts`                     | `GET /api/v1/jobs/:id/quality` endpoint |
| `packages/queue/src/worker-heartbeat.ts`             | Heartbeat writer (setInterval + Redis)  |
| `apps/api/tests/unit/middleware/idempotency.test.ts` | Idempotency tests                       |
| `apps/api/tests/unit/routes/admin-workers.test.ts`   | Worker health tests                     |
| `apps/api/tests/unit/routes/quality.test.ts`         | Quality aggregation tests               |

### Modified Files

| File                                                | Change                                                     |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `apps/api/src/app.ts`                               | Mount idempotency middleware, quality route, workers route |
| `apps/api/src/schemas/export-request.ts`            | Add `minQuality` and `fields` params                       |
| `apps/api/src/routes/exports.ts`                    | Pass filtering params to export orchestrator               |
| `packages/core/src/pipeline/export-orchestrator.ts` | Apply minQuality filter + fields projection                |
| `packages/core/src/pipeline/entity-cursor.ts`       | Accept `minQuality` filter                                 |
| `packages/queue/src/worker-entrypoint.ts`           | Start/stop heartbeat                                       |
| `packages/queue/src/queues.ts`                      | Add `minQuality` + `fields` to `ExportJobPayload`          |
| `packages/queue/src/index.ts`                       | Export heartbeat                                           |

---

## Task 1: Idempotency Middleware

**Files:**

- Create: `apps/api/src/middleware/idempotency.ts`
- Create: `apps/api/tests/unit/middleware/idempotency.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/middleware/idempotency.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { idempotencyMiddleware } from '../../../src/middleware/idempotency.js';

function createMockRedis() {
  return { get: vi.fn(), set: vi.fn() };
}

function createTestApp(redis: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('deps', { redis });
    return next();
  });
  app.use('*', idempotencyMiddleware());
  app.post('/test', (c) => c.json({ created: true }, 201));
  app.get('/test', (c) => c.json({ data: 'ok' }));
  return app;
}

describe('idempotencyMiddleware', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  it('passes through GET requests without checking Redis', async () => {
    const app = createTestApp(redis);
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('passes through POST without Idempotency-Key header', async () => {
    const app = createTestApp(redis);
    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('returns cached response for duplicate Idempotency-Key', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ statusCode: 201, body: { created: true } }));
    const app = createTestApp(redis);
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'unique-key-1' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(redis.set).not.toHaveBeenCalled(); // Didn't re-cache
  });

  it('caches response on first POST with Idempotency-Key', async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    const app = createTestApp(redis);
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'unique-key-2' },
    });
    expect(res.status).toBe(201);
    expect(redis.set).toHaveBeenCalledWith(
      'idempotency:tenant-1:unique-key-2',
      expect.any(String),
      'EX',
      86400,
    );
  });

  it('works without Redis (passes through)', async () => {
    const app = createTestApp(null);
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
    });
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Implement idempotency middleware**

```typescript
// apps/api/src/middleware/idempotency.ts
import type { MiddlewareHandler } from 'hono';
import { createLogger } from '@spatula/shared';

const logger = createLogger('idempotency');
const IDEMPOTENCY_TTL = 86400; // 24 hours

export function idempotencyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // Only for POST/PATCH (mutating)
    if (c.req.method !== 'POST' && c.req.method !== 'PATCH') {
      return next();
    }

    const idempotencyKey = c.req.header('idempotency-key');
    if (!idempotencyKey) {
      return next();
    }

    const redis = c.get('deps')?.redis;
    if (!redis) {
      return next();
    }

    const tenantId = c.get('tenantId') ?? 'unknown';
    const cacheKey = `idempotency:${tenantId}:${idempotencyKey}`;

    // Check for cached response
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const { statusCode, body } = JSON.parse(cached);
        logger.debug({ cacheKey }, 'Returning cached idempotent response');
        return c.json(body, statusCode);
      }
    } catch (err) {
      logger.warn({ err, cacheKey }, 'Idempotency cache read failed');
    }

    // Proceed with request
    await next();

    // Cache only successful (2xx) responses — don't cache errors
    // A transient 500 should be retryable, not cached for 24 hours
    try {
      const status = c.res.status;
      if (status < 200 || status >= 300) return; // Don't cache non-2xx
      const cloned = c.res.clone();
      const body = await cloned.json();
      await redis.set(
        cacheKey,
        JSON.stringify({ statusCode: status, body }),
        'EX',
        IDEMPOTENCY_TTL,
      );
    } catch (err) {
      logger.warn({ err, cacheKey }, 'Idempotency cache write failed');
    }
  };
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @spatula/api test -- --run idempotency
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/middleware/idempotency.ts apps/api/tests/unit/middleware/idempotency.test.ts
git commit -m "feat(api): add idempotency middleware with Redis-backed 24hr cache"
```

---

## Task 2: Worker Health Monitoring — Heartbeat Writer

**Files:**

- Create: `packages/queue/src/worker-heartbeat.ts`
- Modify: `packages/queue/src/worker-entrypoint.ts`
- Modify: `packages/queue/src/index.ts`

- [ ] **Step 1: Implement heartbeat writer**

```typescript
// packages/queue/src/worker-heartbeat.ts
import { hostname } from 'node:os';
import type Redis from 'ioredis';
import { createLogger } from '@spatula/shared';

const logger = createLogger('worker-heartbeat');

export interface HeartbeatConfig {
  redis: Redis;
  queues: string[];
  intervalMs?: number;
  ttlSeconds?: number;
}

export class WorkerHeartbeat {
  private readonly workerId: string;
  private readonly redis: Redis;
  private readonly queues: string[];
  private readonly intervalMs: number;
  private readonly ttlSeconds: number;
  private timer?: ReturnType<typeof setInterval>;
  private readonly startedAt: number;

  constructor(config: HeartbeatConfig) {
    this.workerId = `${hostname()}-${process.pid}`;
    this.redis = config.redis;
    this.queues = config.queues;
    this.intervalMs = config.intervalMs ?? 30_000;
    this.ttlSeconds = config.ttlSeconds ?? 60;
    this.startedAt = Date.now();
  }

  start(): void {
    this.beat(); // Immediate first beat
    this.timer = setInterval(() => this.beat(), this.intervalMs);
    this.timer.unref(); // Don't keep process alive
    logger.info({ workerId: this.workerId, queues: this.queues }, 'Heartbeat started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Delete heartbeat key on clean shutdown
    const key = `worker:heartbeat:${this.workerId}`;
    this.redis.del(key).catch(() => {});
    logger.info({ workerId: this.workerId }, 'Heartbeat stopped');
  }

  private beat(): void {
    const key = `worker:heartbeat:${this.workerId}`;
    const value = JSON.stringify({
      workerId: this.workerId,
      queues: this.queues,
      pid: process.pid,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      activeJobs: 0, // TODO: wire to actual active job count
      lastBeat: new Date().toISOString(),
    });

    this.redis.set(key, value, 'EX', this.ttlSeconds).catch((err) => {
      logger.warn({ err, workerId: this.workerId }, 'Heartbeat write failed');
    });
  }
}
```

- [ ] **Step 2: Wire heartbeat into worker-entrypoint.ts**

Read `packages/queue/src/worker-entrypoint.ts`. Add heartbeat start before the shutdown handler, and stop in the shutdown handler.

After the workers are created and before the shutdown handler:

```typescript
import { WorkerHeartbeat } from './worker-heartbeat.js';

// Start heartbeat — reuse the existing redisForLock connection (not a new connection)
const heartbeat = new WorkerHeartbeat({
  redis: redisForLock,
  queues: workers.map((w) => w.name),
});
heartbeat.start();
```

**Note:** Reuse `redisForLock` (already created at line 42) rather than creating a new Redis connection. This avoids connection management issues and ensures the heartbeat is cleaned up when `redisForLock` is quit during shutdown.

In the shutdown handler, add:

```typescript
heartbeat.stop();
```

- [ ] **Step 3: Write heartbeat tests**

Create `packages/queue/tests/unit/worker-heartbeat.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerHeartbeat } from '../../src/worker-heartbeat.js';

describe('WorkerHeartbeat', () => {
  let mockRedis: any;
  let heartbeat: WorkerHeartbeat;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRedis = {
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
    };
    heartbeat = new WorkerHeartbeat({ redis: mockRedis, queues: ['spatula.crawl'] });
  });

  afterEach(() => {
    heartbeat.stop();
    vi.useRealTimers();
  });

  it('writes heartbeat to Redis on start', () => {
    heartbeat.start();
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^worker:heartbeat:/),
      expect.any(String),
      'EX',
      60,
    );
  });

  it('deletes heartbeat key on stop', () => {
    heartbeat.start();
    heartbeat.stop();
    expect(mockRedis.del).toHaveBeenCalledWith(expect.stringMatching(/^worker:heartbeat:/));
  });

  it('heartbeat value contains workerId, queues, pid', () => {
    heartbeat.start();
    const value = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(value.workerId).toBeDefined();
    expect(value.queues).toEqual(['spatula.crawl']);
    expect(value.pid).toBe(process.pid);
  });
});
```

- [ ] **Step 4: Export from barrel**

Add to `packages/queue/src/index.ts`:

```typescript
export { WorkerHeartbeat } from './worker-heartbeat.js';
export type { HeartbeatConfig } from './worker-heartbeat.js';
```

- [ ] **Step 4: Build and test**

```bash
pnpm --filter @spatula/queue build && pnpm --filter @spatula/queue test
```

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/worker-heartbeat.ts packages/queue/src/worker-entrypoint.ts packages/queue/src/index.ts
git commit -m "feat(queue): add worker heartbeat with Redis TTL for health monitoring"
```

---

## Task 3: Worker Health Monitoring — Admin Endpoint

**Files:**

- Create: `apps/api/src/routes/admin-workers.ts`
- Create: `apps/api/tests/unit/routes/admin-workers.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/routes/admin-workers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminWorkerRoutes } from '../../../src/routes/admin-workers.js';

function createTestApp(mockRedis: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'admin');
    c.set('auth', { tenantId: 'admin', userId: 'admin', scopes: ['admin'] });
    c.set('deps', { redis: mockRedis });
    return next();
  });
  app.route('/api/v1/admin/workers', adminWorkerRoutes());
  return app;
}

describe('Admin worker routes', () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      scan: vi.fn(),
      get: vi.fn(),
    };
  });

  it('returns list of healthy workers', async () => {
    mockRedis.scan.mockResolvedValueOnce(['0', ['worker:heartbeat:host1-1234']]);
    mockRedis.get.mockResolvedValue(
      JSON.stringify({
        workerId: 'host1-1234',
        queues: ['spatula.crawl'],
        pid: 1234,
        uptime: 3600,
        activeJobs: 2,
        lastBeat: new Date().toISOString(),
      }),
    );

    const app = createTestApp(mockRedis);
    const res = await app.request('/api/v1/admin/workers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].workerId).toBe('host1-1234');
    expect(body.data[0].status).toBe('healthy');
  });

  it('returns empty list when no workers', async () => {
    mockRedis.scan.mockResolvedValue(['0', []]);
    const app = createTestApp(mockRedis);
    const res = await app.request('/api/v1/admin/workers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });

  it('returns 500 when Redis unavailable', async () => {
    const app = createTestApp(null);
    const res = await app.request('/api/v1/admin/workers');
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Implement admin workers endpoint**

```typescript
// apps/api/src/routes/admin-workers.ts
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';

const listWorkersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin'],
  summary: 'List active workers with health status',
  responses: {
    200: jsonContent(
      z.object({
        data: z.array(
          z.object({
            workerId: z.string(),
            queues: z.array(z.string()),
            pid: z.number(),
            uptime: z.number(),
            activeJobs: z.number(),
            lastBeat: z.string(),
            status: z.enum(['healthy', 'unhealthy']),
          }),
        ),
      }),
      'Worker list',
    ),
    500: jsonContent(errorResponseSchema, 'Redis unavailable'),
  },
});

export function adminWorkerRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(listWorkersRoute, async (c) => {
    const deps = c.get('deps');
    if (!deps.redis) {
      throw new Error('Redis not configured for worker health monitoring');
    }

    const workers: Array<Record<string, unknown>> = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await deps.redis.scan(
        cursor,
        'MATCH',
        'worker:heartbeat:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;

      for (const key of keys) {
        const value = await deps.redis.get(key);
        if (value) {
          try {
            const data = JSON.parse(value);
            workers.push({ ...data, status: 'healthy' });
          } catch {
            /* skip malformed */
          }
        }
      }
    } while (cursor !== '0');

    // Workers whose TTL has expired are simply absent — no "unhealthy" entries.
    // The TTL-based approach means missing = unhealthy (not present in response).

    return c.json({ data: workers });
  });

  return router;
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @spatula/api test -- --run admin-workers
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/admin-workers.ts apps/api/tests/unit/routes/admin-workers.test.ts
git commit -m "feat(api): add GET /api/v1/admin/workers endpoint for worker health"
```

---

## Task 4: Quality Score Aggregation API

**Files:**

- Create: `apps/api/src/routes/quality.ts`
- Create: `apps/api/tests/unit/routes/quality.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/api/tests/unit/routes/quality.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { qualityRoutes } from '../../../src/routes/quality.js';

function createTestApp(mockDeps: any) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['jobs:read'] });
    c.set('deps', mockDeps);
    return next();
  });
  app.route('/api/v1/jobs/:jobId/quality', qualityRoutes());
  return app;
}

describe('Quality routes', () => {
  let mockEntityRepo: any;

  beforeEach(() => {
    mockEntityRepo = {
      getQualityAggregation: vi.fn().mockResolvedValue({
        entityCount: 500,
        averageQuality: 0.78,
        distribution: { excellent: 120, good: 200, fair: 130, poor: 50 },
        fieldCompleteness: { name: 0.98, price: 0.85, description: 0.72 },
      }),
    };
  });

  it('returns quality aggregation for a job', async () => {
    const app = createTestApp({ entityRepo: mockEntityRepo });
    const res = await app.request('/api/v1/jobs/job-1/quality');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.entityCount).toBe(500);
    expect(body.data.averageQuality).toBe(0.78);
    expect(body.data.distribution.excellent).toBe(120);
    expect(body.data.fieldCompleteness.name).toBe(0.98);
    // Verify tenant isolation
    expect(mockEntityRepo.getQualityAggregation).toHaveBeenCalledWith('job-1', 'tenant-1');
  });
});
```

- [ ] **Step 2: Add getQualityAggregation to EntityRepository**

Read `packages/db/src/repositories/entity-repository.ts`. Add a method using SQL aggregation:

```typescript
  async getQualityAggregation(jobId: string, tenantId: string) {
    try {
      const conditions = [eq(entities.jobId, jobId), eq(entities.tenantId, tenantId)];

      // Totals + distribution via SQL
      const [stats] = await this.db
        .select({
          entityCount: sql<number>`count(*)::int`,
          averageQuality: sql<number>`COALESCE(avg(${entities.qualityScore}), 0)::float`,
          excellent: sql<number>`count(*) FILTER (WHERE ${entities.qualityScore} >= 0.9)::int`,
          good: sql<number>`count(*) FILTER (WHERE ${entities.qualityScore} >= 0.7 AND ${entities.qualityScore} < 0.9)::int`,
          fair: sql<number>`count(*) FILTER (WHERE ${entities.qualityScore} >= 0.5 AND ${entities.qualityScore} < 0.7)::int`,
          poor: sql<number>`count(*) FILTER (WHERE ${entities.qualityScore} < 0.5)::int`,
        })
        .from(entities)
        .where(and(...conditions));

      // Field completeness: count non-null per field key
      // This requires knowing the schema fields. For now, sample a few entities
      // and check which keys are present across the dataset.
      const sampleEntities = await this.db
        .select({ mergedData: entities.mergedData })
        .from(entities)
        .where(and(...conditions))
        .limit(100);

      const fieldCounts: Record<string, number> = {};
      const total = stats?.entityCount ?? 0;

      for (const entity of sampleEntities) {
        const data = entity.mergedData as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          if (value !== null && value !== undefined && value !== '') {
            fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
          }
        }
      }

      const sampleSize = sampleEntities.length;
      const fieldCompleteness: Record<string, number> = {};
      for (const [key, count] of Object.entries(fieldCounts)) {
        fieldCompleteness[key] = Math.round((count / sampleSize) * 100) / 100;
      }

      return {
        entityCount: stats?.entityCount ?? 0,
        averageQuality: Math.round((stats?.averageQuality ?? 0) * 100) / 100,
        distribution: {
          excellent: stats?.excellent ?? 0,
          good: stats?.good ?? 0,
          fair: stats?.fair ?? 0,
          poor: stats?.poor ?? 0,
        },
        fieldCompleteness,
      };
    } catch (error) {
      throw new StorageError(`Failed to aggregate quality: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, tenantId },
      });
    }
  }
```

- [ ] **Step 3: Implement quality route**

```typescript
// apps/api/src/routes/quality.ts
import { createRoute, z } from '@hono/zod-openapi';
import { createOpenAPIRouter } from '../openapi-config.js';
import { jsonContent, errorResponseSchema } from '../schemas/responses.js';

const jobIdParam = z.object({
  jobId: z.string().openapi({ param: { name: 'jobId', in: 'path' } }),
});

const getQualityRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Quality'],
  summary: 'Get quality score aggregation for a job',
  request: { params: jobIdParam },
  responses: {
    200: jsonContent(
      z.object({
        data: z.object({
          entityCount: z.number(),
          averageQuality: z.number(),
          distribution: z.object({
            excellent: z.number(),
            good: z.number(),
            fair: z.number(),
            poor: z.number(),
          }),
          fieldCompleteness: z.record(z.number()),
        }),
      }),
      'Quality aggregation',
    ),
  },
});

export function qualityRoutes() {
  const router = createOpenAPIRouter();

  router.openapi(getQualityRoute, async (c) => {
    const { jobId } = c.req.valid('param');
    const tenantId = c.get('tenantId');
    const deps = c.get('deps');

    const aggregation = await deps.entityRepo.getQualityAggregation(jobId, tenantId);
    return c.json({ data: aggregation });
  });

  return router;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @spatula/api test -- --run quality
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/quality.ts apps/api/tests/unit/routes/quality.test.ts packages/db/src/repositories/entity-repository.ts
git commit -m "feat(api): add GET /api/v1/jobs/:id/quality for quality score aggregation"
```

---

## Task 5: Confidence-Based Export Filtering

**Files:**

- Modify: `apps/api/src/schemas/export-request.ts`
- Modify: `packages/core/src/pipeline/export-orchestrator.ts`
- Modify: `packages/core/src/pipeline/entity-cursor.ts`
- Modify: `packages/core/src/pipeline/types.ts`

- [ ] **Step 1: Extend export request schema**

Read `apps/api/src/schemas/export-request.ts`. Add:

```typescript
export const exportRequestSchema = z.object({
  format: z.enum(['json', 'csv', 'parquet', 'duckdb', 'sqlite']),
  includeProvenance: z.boolean().default(false),
  minQuality: z.number().min(0).max(1).optional().openapi({
    description:
      'Minimum quality score filter (0-1). Only entities with quality_score >= this value are included.',
    example: 0.7,
  }),
  fields: z
    .array(z.string())
    .optional()
    .openapi({
      description:
        'Subset of fields to include in the export. If omitted, all fields are included.',
      example: ['name', 'price', 'description'],
    }),
});
```

- [ ] **Step 2: Add minQuality to ExportInput type**

Read `packages/core/src/pipeline/types.ts`. Add to `ExportInput`:

```typescript
  minQuality?: number;
  fields?: string[];
```

- [ ] **Step 3: Add minQuality filter to entity cursor**

Read `packages/core/src/pipeline/entity-cursor.ts`. Update `CursorEntityRepo` to accept `minQuality`:

Only add `minQuality` to `CursorEntityRepo` — do NOT add `since` (it's already in the concrete `EntityRepository` but intentionally not in the core interface):

```typescript
export interface CursorEntityRepo {
  findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
    minQuality?: number,
  ): Promise<{ entities: unknown[]; nextCursor: string | null }>;
}
```

Update `fetchEntitiesCursor` to accept and pass `minQuality`:

```typescript
export async function* fetchEntitiesCursor(
  entityRepo: CursorEntityRepo,
  jobId: string,
  tenantId: string,
  batchSize = 500,
  options?: { minQuality?: number },
): AsyncIterable<unknown[]> {
  let cursor: string | undefined;
  while (true) {
    const batch = await entityRepo.findByJobCursor(
      jobId,
      tenantId,
      batchSize,
      cursor,
      options?.minQuality,
    );
    if (batch.entities.length === 0) break;
    yield batch.entities;
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
  }
}
```

**Note:** The concrete `EntityRepository.findByJobCursor` has `since` as the 5th parameter. The core interface drops it because `fetchEntitiesCursor` (used by the export orchestrator) never needs `since`. The concrete repo is called directly by the route handlers when `since` is needed.

- [ ] **Step 4: Add minQuality filter to EntityRepository.findByJobCursor**

Read `packages/db/src/repositories/entity-repository.ts`. Update `findByJobCursor` to accept `minQuality`:

```typescript
  async findByJobCursor(
    jobId: string,
    tenantId: string,
    limit: number,
    cursor?: string,
    since?: string,
    minQuality?: number,
  ) {
```

Add:

```typescript
if (minQuality !== undefined) {
  conditions.push(sql`${entities.qualityScore} >= ${minQuality}`);
}
```

- [ ] **Step 5: Apply minQuality and fields in export orchestrator**

Read `packages/core/src/pipeline/export-orchestrator.ts`. The `processExport` function receives `ExportInput` which now has `minQuality` and `fields`.

For `minQuality`: pass to `fetchEntitiesCursor`:

```typescript
const entityStream = fetchEntitiesCursor(deps.entityRepo as any, jobId, tenantId, 500, {
  minQuality: input.minQuality,
});
```

For `fields`: apply field projection to each entity before passing to the exporter. For streaming JSON/CSV, wrap the entity stream with a projection:

```typescript
async function* projectedStream() {
  for await (const batch of countedEntityStream()) {
    if (input.fields) {
      yield batch.map((entity: any) => ({
        ...entity,
        mergedData: Object.fromEntries(
          input.fields!.map((f) => [f, (entity.mergedData ?? entity)[f]]),
        ),
      }));
    } else {
      yield batch;
    }
  }
}
```

Also apply fields projection in the offset/binary path when collecting entities.

Also apply `minQuality` to the `countByJob` call so the total reflects filtered count. If `countByJob` doesn't support `minQuality`, note that `total` is unfiltered (same pattern as the cursor pagination).

- [ ] **Step 6: Pass filtering params from route to orchestrator**

Read `apps/api/src/routes/exports.ts`. The trigger export handler creates the export job payload. Pass `minQuality` and `fields` from the request body through to the export queue job data and eventually to `ExportInput`.

Read how the export job is enqueued — via `deps.exportQueue.add()` with a payload typed as `ExportJobPayload`. First update `packages/queue/src/queues.ts` to add the new fields to `ExportJobPayload`:

```typescript
export interface ExportJobPayload {
  exportId: string;
  jobId: string;
  tenantId: string;
  format: 'json' | 'csv' | 'parquet' | 'duckdb' | 'sqlite';
  includeProvenance: boolean;
  minQuality?: number; // NEW
  fields?: string[]; // NEW
}
```

Then in the route handler, pass `body.minQuality` and `body.fields` through to the job payload.

- [ ] **Step 7: Run tests**

```bash
pnpm --filter @spatula/core test && pnpm --filter @spatula/api test
```

All existing export orchestrator tests must pass. The new params are optional so existing tests are unaffected.

- [ ] **Step 8: Add export filtering tests**

Add tests to `packages/core/tests/unit/pipeline/entity-cursor.test.ts`:

- `fetchEntitiesCursor` with `minQuality` option passes it to `findByJobCursor`

Add test to `packages/core/tests/unit/pipeline/export-orchestrator.test.ts`:

- Export with `minQuality` passes filter to entity cursor
- Export with `fields` applies field projection to output

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/schemas/export-request.ts packages/core/src/pipeline/ packages/db/src/repositories/entity-repository.ts apps/api/src/routes/exports.ts
git commit -m "feat: add confidence-based export filtering with minQuality and fields params"
```

---

## Task 6: Wire into App + Integration Verification

**Files:**

- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Wire idempotency middleware into app.ts**

Read `apps/api/src/app.ts`. Add import:

```typescript
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { qualityRoutes } from './routes/quality.js';
import { adminWorkerRoutes } from './routes/admin-workers.js';
```

Add `'Idempotency-Key'` to the CORS `allowHeaders` array (find the existing `cors()` call and add it):

```typescript
  allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Tenant-Id', 'Idempotency-Key'],
```

Add idempotency middleware after rate limiting (per decomposition spec middleware chain order):

```typescript
// Idempotency (after rate limiting, before routes)
app.use('/api/*', idempotencyMiddleware());
```

Add quality route:

```typescript
// Quality aggregation
app.get('/api/v1/jobs/:jobId/quality', requireScope('jobs:read'));
app.route('/api/v1/jobs/:jobId/quality', qualityRoutes());
```

Add workers route (under existing admin scope):

```typescript
app.route('/api/v1/admin/workers', adminWorkerRoutes());
```

- [ ] **Step 2: Run ALL tests**

```bash
pnpm --filter @spatula/api test && pnpm --filter @spatula/db test && pnpm --filter @spatula/core test && pnpm --filter @spatula/queue test
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/app.ts
git commit -m "feat(api): wire idempotency, quality route, and workers route into app"
```

- [ ] **Step 4: Verify full test suite**

```bash
pnpm test
```

Expected: All 1,579+ tests pass, plus ~15 new tests.
