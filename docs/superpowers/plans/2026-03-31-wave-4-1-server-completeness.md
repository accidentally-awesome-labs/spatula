# Wave 4-1: Server Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add remaining server-side API features — webhook delivery, bulk operations, request timeout, and a pluggable diagnostic health check framework with `spatula doctor`.

**Architecture:** Webhook delivery uses a dedicated BullMQ queue (`spatula.webhooks`) with HMAC-SHA256 signing and 3-retry exponential backoff. Bulk operations are two new POST endpoints with partial-success semantics. The diagnostic framework uses a pluggable `HealthCheck` interface with a registry pattern — Phase 12 registers system/server checks, Phase 13 (Wave 4-2) adds project checks without modifying this code. The timeout middleware wraps Hono handlers with `AbortController` to enforce per-route time limits.

**Tech Stack:** Hono (API routes + middleware), BullMQ (webhook queue/worker), Zod (schema validation), Vitest (testing), `node:crypto` (HMAC-SHA256)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/shared/src/webhook-types.ts` | Webhook event types, payload shape, event type enum |
| `packages/queue/src/webhook-sender.ts` | WebhookSender class — sign, serialize, POST |
| `packages/queue/src/webhook-worker.ts` | BullMQ worker consuming `spatula.webhooks` queue |
| `apps/api/src/routes/batch-actions.ts` | `POST /api/v1/actions/batch` (approve/reject) |
| `apps/api/src/routes/batch-jobs.ts` | `POST /api/v1/jobs/batch` (cancel/delete) |
| `apps/api/src/middleware/timeout.ts` | Request timeout middleware (30s default, 5min exports) |
| `packages/core/src/diagnostics/health-check.ts` | HealthCheck interface + registry |
| `packages/core/src/diagnostics/system-checks.ts` | 5 system-level health checks |
| `packages/core/src/diagnostics/server-checks.ts` | 4 server-level health checks |
| `apps/cli/src/commands/doctor.ts` | `spatula doctor` command |

### Modified Files

| File | Change |
|------|--------|
| `packages/queue/src/queues.ts` | Add `WEBHOOK` to `QUEUE_NAMES`, update `SpatulaQueues` + `createQueues()` |
| `packages/queue/src/worker-entrypoint.ts` | Register webhook worker |
| `apps/api/src/routes/admin-queues.ts` | Add 6th queue adapter for Bull Board |
| `apps/api/src/schemas/job.ts` | Add optional `webhooks` field to `createJobSchema` |
| `apps/api/src/app.ts` | Add timeout middleware to chain, register batch routes |
| `apps/cli/src/index.tsx` | Register `doctor` command |
| `packages/core/src/index.ts` | Export diagnostics barrel |
| `packages/shared/src/index.ts` | Export webhook types |

### Test Files

| File | Tests |
|------|-------|
| `packages/queue/tests/unit/webhook-sender.test.ts` | WebhookSender sign, send, error handling |
| `packages/queue/tests/unit/webhook-worker.test.ts` | Worker backoff strategy, sender invocation |
| `apps/api/tests/unit/routes/batch-actions.test.ts` | Batch approve/reject, partial failure, max 100 |
| `apps/api/tests/unit/routes/batch-jobs.test.ts` | Batch cancel/delete, partial failure, max 100 |
| `apps/api/tests/unit/middleware/timeout.test.ts` | Timeout triggers 504, normal request passes |
| `packages/core/tests/unit/diagnostics/health-check.test.ts` | Registry, run by category, pass/fail/warn |
| `packages/core/tests/unit/diagnostics/system-checks.test.ts` | Each system check |
| `apps/cli/tests/unit/commands/doctor.test.ts` | Doctor command output formatting |

---

## Tasks

### Task 1: Webhook Types

**Files:**
- Create: `packages/shared/src/webhook-types.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create webhook types**

```typescript
// packages/shared/src/webhook-types.ts

export const WEBHOOK_EVENT_TYPES = [
  'job.completed',
  'job.failed',
  'job.cancelled',
  'export.completed',
  'action.pending',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  timestamp: string;
  data: {
    jobId: string;
    tenantId: string;
    status?: string;
    entityCount?: number;
    duration?: number;
  };
}

export interface WebhookConfig {
  url: string;
  secret?: string;
  events: WebhookEventType[];
}
```

- [ ] **Step 2: Export from shared barrel**

Add to `packages/shared/src/index.ts`:

```typescript
export * from './webhook-types.js';
```

- [ ] **Step 3: Run build to verify**

Run: `pnpm --filter @spatula/shared build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/webhook-types.ts packages/shared/src/index.ts
git commit -m "feat(shared): add webhook event types and config"
```

---

### Task 2: WebhookSender

**Files:**
- Create: `packages/queue/src/webhook-sender.ts`
- Create: `packages/queue/tests/unit/webhook-sender.test.ts`

- [ ] **Step 1: Write tests for WebhookSender**

```typescript
// packages/queue/tests/unit/webhook-sender.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookSender } from '../../src/webhook-sender.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('WebhookSender', () => {
  const sender = new WebhookSender();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a POST with JSON body and correct headers', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const event = {
      id: 'evt_test1',
      type: 'job.completed' as const,
      timestamp: '2026-03-31T00:00:00Z',
      data: { jobId: 'job-1', tenantId: 'tenant-1', status: 'completed' },
    };

    await sender.send('https://example.com/webhook', event);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual(event);
  });

  it('adds HMAC-SHA256 signature when secret is provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const event = {
      id: 'evt_test2',
      type: 'job.failed' as const,
      timestamp: '2026-03-31T00:00:00Z',
      data: { jobId: 'job-1', tenantId: 'tenant-1' },
    };

    await sender.send('https://example.com/webhook', event, 'my-secret-key-1234');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['X-Spatula-Signature']).toBeDefined();
    expect(options.headers['X-Spatula-Signature']).toMatch(/^sha256=/);
  });

  it('throws on non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

    const event = {
      id: 'evt_test3',
      type: 'job.completed' as const,
      timestamp: '2026-03-31T00:00:00Z',
      data: { jobId: 'job-1', tenantId: 'tenant-1' },
    };

    await expect(sender.send('https://example.com/webhook', event)).rejects.toThrow('Webhook delivery failed: 500');
  });

  it('throws on fetch error (network failure)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const event = {
      id: 'evt_test4',
      type: 'job.completed' as const,
      timestamp: '2026-03-31T00:00:00Z',
      data: { jobId: 'job-1', tenantId: 'tenant-1' },
    };

    await expect(sender.send('https://example.com/webhook', event)).rejects.toThrow('ECONNREFUSED');
  });

  it('uses 10s timeout via AbortSignal', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const event = {
      id: 'evt_test5',
      type: 'job.completed' as const,
      timestamp: '2026-03-31T00:00:00Z',
      data: { jobId: 'job-1', tenantId: 'tenant-1' },
    };

    await sender.send('https://example.com/webhook', event);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/queue test -- tests/unit/webhook-sender.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement WebhookSender**

```typescript
// packages/queue/src/webhook-sender.ts
import { createHmac } from 'node:crypto';
import { createLogger } from '@spatula/shared';
import type { WebhookEvent } from '@spatula/shared';

const logger = createLogger('webhook-sender');
const TIMEOUT_MS = 10_000;

export class WebhookSender {
  async send(url: string, event: WebhookEvent, secret?: string): Promise<void> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Spatula-Webhook/1.0',
    };

    if (secret) {
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      headers['X-Spatula-Signature'] = `sha256=${signature}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed: ${response.status}`);
    }

    logger.debug({ url, eventType: event.type, eventId: event.id }, 'webhook delivered');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @spatula/queue test -- tests/unit/webhook-sender.test.ts`
Expected: 5 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/webhook-sender.ts packages/queue/tests/unit/webhook-sender.test.ts
git commit -m "feat(queue): add WebhookSender with HMAC-SHA256 signing"
```

---

### Task 3: Webhook Queue Infrastructure + Worker

**Files:**
- Modify: `packages/queue/src/queues.ts`
- Create: `packages/queue/src/webhook-worker.ts`
- Modify: `packages/queue/src/worker-entrypoint.ts`
- Modify: `apps/api/src/routes/admin-queues.ts`

- [ ] **Step 1: Add WEBHOOK to QUEUE_NAMES and update SpatulaQueues**

In `packages/queue/src/queues.ts`, add to `QUEUE_NAMES`:

```typescript
WEBHOOK: 'spatula.webhooks',
```

Add to `SpatulaQueues` interface:

```typescript
webhook: Queue<WebhookJobData>;
```

Add `WebhookJobData` type:

```typescript
export interface WebhookJobData {
  url: string;
  event: WebhookEvent;
  secret?: string;
}
```

In `createQueues()`, add after the export queue creation:

```typescript
const webhook = new Queue<WebhookJobData>(QUEUE_NAMES.WEBHOOK, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'custom' },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});
```

Add `webhook` to the returned object and `closeAll()`.

Import `WebhookEvent` from `@spatula/shared`.

- [ ] **Step 2: Create webhook worker**

```typescript
// packages/queue/src/webhook-worker.ts
import { Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import { createLogger } from '@spatula/shared';
import { WebhookSender } from './webhook-sender.js';
import { QUEUE_NAMES } from './queues.js';
import type { WebhookJobData } from './queues.js';

const logger = createLogger('webhook-worker');

// Custom backoff: 1min, 5min, 30min
const BACKOFF_DELAYS = [60_000, 300_000, 1_800_000];

export function createWebhookWorker(connection: ConnectionOptions): Worker<WebhookJobData> {
  const sender = new WebhookSender();

  const worker = new Worker<WebhookJobData>(
    QUEUE_NAMES.WEBHOOK,
    async (job: Job<WebhookJobData>) => {
      const { url, event, secret } = job.data;
      logger.info({ eventId: event.id, eventType: event.type, url, attempt: job.attemptsMade + 1 }, 'delivering webhook');
      await sender.send(url, event, secret);
    },
    {
      connection,
      concurrency: 5,
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          return BACKOFF_DELAYS[Math.min(attemptsMade, BACKOFF_DELAYS.length - 1)];
        },
      },
    },
  );

  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, eventId: job?.data.event.id, error: err.message, attempt: job?.attemptsMade }, 'webhook delivery failed');
  });

  return worker;
}
```

- [ ] **Step 3: Register webhook worker in worker-entrypoint.ts**

Add to `packages/queue/src/worker-entrypoint.ts`, following the existing pattern:

```typescript
import { createWebhookWorker } from './webhook-worker.js';

// Inside the worker creation block, add:
if (isWorkerEnabled('webhook', enabledWorkers)) {
  const webhookWorker = createWebhookWorker(connection);
  webhookWorker.on('failed', dlqHandler);
  workers.push(webhookWorker);
  logger.info('webhook worker started');
}
```

- [ ] **Step 4: Update Bull Board to include 6th queue**

In `apps/api/src/routes/admin-queues.ts`, add after the export adapter:

```typescript
new BullMQAdapter(queues.webhook),
```

- [ ] **Step 5: Export from queue barrel**

In `packages/queue/src/index.ts`, add:

```typescript
export { WebhookSender, enqueueWebhookIfConfigured } from './webhook-sender.js';
export type { WebhookJobData } from './queues.js';
```

- [ ] **Step 6: Run existing tests to verify no breakage**

Run: `pnpm test`
Expected: All 1,958+ tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/queue/src/queues.ts packages/queue/src/webhook-worker.ts packages/queue/src/webhook-sender.ts packages/queue/src/worker-entrypoint.ts packages/queue/src/index.ts apps/api/src/routes/admin-queues.ts
git commit -m "feat(queue): add webhook queue, worker, and Bull Board registration"
```

---

### Task 4: Webhook Config Schema + Event Enqueue Helper

**Files:**
- Modify: `apps/api/src/schemas/job.ts`
- Modify: `packages/queue/src/webhook-sender.ts` (add enqueue helper)

- [ ] **Step 1: Add webhooks field to job creation schema**

In `apps/api/src/schemas/job.ts`, add to `createJobSchema`:

```typescript
webhooks: z.object({
  url: z.string().url(),
  secret: z.string().min(16).optional(),
  events: z.array(z.enum([
    'job.completed',
    'job.failed',
    'job.cancelled',
    'export.completed',
    'action.pending',
  ])).default(['job.completed', 'job.failed']),
}).optional(),
```

- [ ] **Step 2: Add fire-and-forget enqueue helper to webhook-sender.ts**

Append to `packages/queue/src/webhook-sender.ts`:

```typescript
import { nanoid } from 'nanoid';
import type { Queue } from 'bullmq';
import type { WebhookConfig, WebhookEventType } from '@spatula/shared';
import type { WebhookJobData } from './queues.js';

export function enqueueWebhookIfConfigured(
  webhookQueue: Queue<WebhookJobData>,
  webhookConfig: WebhookConfig | undefined,
  eventType: WebhookEventType,
  data: WebhookEvent['data'],
): void {
  if (!webhookConfig) return;
  if (!webhookConfig.events.includes(eventType)) return;

  const event: WebhookEvent = {
    id: `evt_${nanoid(12)}`,
    type: eventType,
    timestamp: new Date().toISOString(),
    data,
  };

  webhookQueue.add('webhook', {
    url: webhookConfig.url,
    event,
    secret: webhookConfig.secret,
  }).catch((err) => {
    logger.warn({ err, eventType }, 'failed to enqueue webhook event');
  });
}
```

- [ ] **Step 3: Wire webhook events into existing code paths**

The 5 integration points where `enqueueWebhookIfConfigured` should be called (after the relevant state transition). The implementer should locate each transition point and add the call:

- **job.completed / job.failed**: After job status update in the completion handler (e.g., in the reconciliation worker's success/fail path, or wherever the final job status is set).
- **job.cancelled**: In `apps/api/src/routes/jobs.ts` after the `cancel` action in the PATCH handler.
- **export.completed**: In the export worker/orchestrator after successful export.
- **action.pending**: In the schema evolution orchestrator after creating new actions.

Pattern at each integration point:
```typescript
import { enqueueWebhookIfConfigured } from '@spatula/queue';
// ...
if (deps.queues?.webhook) {
  const jobConfig = await deps.jobRepo.findById(jobId, tenantId);
  enqueueWebhookIfConfigured(
    deps.queues.webhook,
    jobConfig?.config?.webhooks,
    'job.completed', // or appropriate event type
    { jobId, tenantId, status: 'completed' },
  );
}
```

Note: The exact file and line numbers depend on the current codebase. The implementer should grep for status transitions (`updateStatus.*completed`, `updateStatus.*failed`, `updateStatus.*cancelled`) to find the right insertion points.

- [ ] **Step 4: Run full tests**

Run: `pnpm test`
Expected: All tests pass (webhook enqueue is fire-and-forget, won't break existing tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/schemas/job.ts packages/queue/src/webhook-sender.ts
# Plus any modified orchestrator/route files for event wiring
git commit -m "feat: add webhook config schema and wire event integration points"
```

---

### Task 5: Batch Actions Endpoint

**Files:**
- Create: `apps/api/src/routes/batch-actions.ts`
- Create: `apps/api/tests/unit/routes/batch-actions.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write tests**

```typescript
// apps/api/tests/unit/routes/batch-actions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { batchActionRoutes } from '../../../src/routes/batch-actions.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createTestApp(deps: any) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['actions:write'] });
    return next();
  });
  app.route('/api/v1/actions', batchActionRoutes());
  return app;
}

describe('POST /api/v1/actions/batch', () => {
  let deps: any;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = {
      actionRepo: {
        findById: vi.fn(),
        updateStatus: vi.fn(),
      },
      auditLogger: { log: vi.fn() },
    };
    app = createTestApp(deps);
  });

  it('approves multiple actions and returns succeeded/failed', async () => {
    deps.actionRepo.findById
      .mockResolvedValueOnce({ id: 'act-1', status: 'pending_review', tenantId: 'tenant-1' })
      .mockResolvedValueOnce({ id: 'act-2', status: 'pending_review', tenantId: 'tenant-1' });
    deps.actionRepo.updateStatus.mockResolvedValue({});

    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', ids: ['act-1', 'act-2'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual(['act-1', 'act-2']);
    expect(body.data.failed).toEqual([]);
  });

  it('returns partial failure when some actions not found', async () => {
    deps.actionRepo.findById
      .mockResolvedValueOnce({ id: 'act-1', status: 'pending_review', tenantId: 'tenant-1' })
      .mockResolvedValueOnce(null);
    deps.actionRepo.updateStatus.mockResolvedValue({});

    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', ids: ['act-1', 'act-missing'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual(['act-1']);
    expect(body.data.failed).toEqual([{ id: 'act-missing', error: 'Action not found' }]);
  });

  it('rejects batch larger than 100', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `act-${i}`);

    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', ids }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects invalid action type', async () => {
    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', ids: ['act-1'] }),
    });

    expect(res.status).toBe(400);
  });

  it('handles reject action', async () => {
    deps.actionRepo.findById.mockResolvedValue({ id: 'act-1', status: 'pending_review', tenantId: 'tenant-1' });
    deps.actionRepo.updateStatus.mockResolvedValue({});

    const res = await app.request('/api/v1/actions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', ids: ['act-1'] }),
    });

    expect(res.status).toBe(200);
    expect(deps.actionRepo.updateStatus).toHaveBeenCalledWith('act-1', 'tenant-1', 'rejected', 'user-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- tests/unit/routes/batch-actions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement batch actions route**

```typescript
// apps/api/src/routes/batch-actions.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createLogger } from '@spatula/shared';
import type { AppEnv } from '../types.js';

const logger = createLogger('batch-actions');

const batchActionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export function batchActionRoutes() {
  const router = new Hono<AppEnv>();

  router.post('/batch', zValidator('json', batchActionSchema), async (c) => {
    const { action, ids } = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const auth = c.get('auth');
    const deps = c.get('deps');
    const reviewedBy = auth?.userId;

    const status = action === 'approve' ? 'approved' : 'rejected';
    const succeeded: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        const existing = await deps.actionRepo.findById(id, tenantId);
        if (!existing) {
          failed.push({ id, error: 'Action not found' });
          continue;
        }
        if (existing.status !== 'pending_review') {
          failed.push({ id, error: `Action is already ${existing.status}` });
          continue;
        }
        await deps.actionRepo.updateStatus(id, tenantId, status, reviewedBy);
        succeeded.push(id);
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }

    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: reviewedBy,
        actorType: 'user',
        action: `actions.batch_${action}`,
        resourceType: 'action',
        resourceId: ids.join(','),
        metadata: { succeeded: succeeded.length, failed: failed.length },
      });
    }

    logger.info({ action, total: ids.length, succeeded: succeeded.length, failed: failed.length }, 'batch action complete');
    return c.json({ data: { succeeded, failed } });
  });

  return router;
}
```

- [ ] **Step 4: Register route in app.ts**

In `apps/api/src/app.ts`, add the batch route. Important: register `/actions/batch` before any `/actions/:actionId` pattern so it matches first:

```typescript
import { batchActionRoutes } from './routes/batch-actions.js';

// Register with scope check:
app.use('/api/v1/actions/batch', requireScope('actions:write'));
app.route('/api/v1/actions', batchActionRoutes());
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @spatula/api test -- tests/unit/routes/batch-actions.test.ts`
Expected: 5 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/batch-actions.ts apps/api/tests/unit/routes/batch-actions.test.ts apps/api/src/app.ts
git commit -m "feat(api): add POST /api/v1/actions/batch for bulk approve/reject"
```

---

### Task 6: Batch Jobs Endpoint

**Files:**
- Create: `apps/api/src/routes/batch-jobs.ts`
- Create: `apps/api/tests/unit/routes/batch-jobs.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write tests**

```typescript
// apps/api/tests/unit/routes/batch-jobs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { batchJobRoutes } from '../../../src/routes/batch-jobs.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

function createTestApp(deps: any) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('tenantId', 'tenant-1');
    c.set('auth', { tenantId: 'tenant-1', userId: 'user-1', scopes: ['jobs:write'] });
    return next();
  });
  app.route('/api/v1/jobs', batchJobRoutes());
  return app;
}

describe('POST /api/v1/jobs/batch', () => {
  let deps: any;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = {
      jobRepo: {
        findById: vi.fn(),
        updateStatus: vi.fn(),
        deleteWithData: vi.fn().mockResolvedValue(undefined),
      },
      auditLogger: { log: vi.fn() },
    };
    app = createTestApp(deps);
  });

  it('cancels multiple jobs', async () => {
    deps.jobRepo.findById
      .mockResolvedValueOnce({ id: 'job-1', status: 'running', tenantId: 'tenant-1' })
      .mockResolvedValueOnce({ id: 'job-2', status: 'running', tenantId: 'tenant-1' });
    deps.jobRepo.updateStatus.mockResolvedValue({});

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', ids: ['job-1', 'job-2'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual(['job-1', 'job-2']);
    expect(deps.jobRepo.updateStatus).toHaveBeenCalledTimes(2);
  });

  it('deletes multiple jobs', async () => {
    deps.jobRepo.findById
      .mockResolvedValueOnce({ id: 'job-1', status: 'completed', tenantId: 'tenant-1' })
      .mockResolvedValueOnce({ id: 'job-2', status: 'failed', tenantId: 'tenant-1' });

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', ids: ['job-1', 'job-2'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual(['job-1', 'job-2']);
    expect(deps.jobRepo.deleteWithData).toHaveBeenCalledTimes(2);
  });

  it('returns partial failure for not-found jobs', async () => {
    deps.jobRepo.findById.mockResolvedValueOnce(null);

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', ids: ['job-missing'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.succeeded).toEqual([]);
    expect(body.data.failed).toEqual([{ id: 'job-missing', error: 'Job not found' }]);
  });

  it('rejects cancel on already-completed job', async () => {
    deps.jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'completed', tenantId: 'tenant-1' });

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', ids: ['job-1'] }),
    });

    const body = await res.json();
    expect(body.data.failed[0].error).toContain('Cannot cancel');
  });

  it('rejects batch larger than 100', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `job-${i}`);

    const res = await app.request('/api/v1/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', ids }),
    });

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- tests/unit/routes/batch-jobs.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement batch jobs route**

```typescript
// apps/api/src/routes/batch-jobs.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createLogger } from '@spatula/shared';
import type { AppEnv } from '../types.js';

const logger = createLogger('batch-jobs');

const CANCELLABLE_STATUSES = new Set(['pending', 'running', 'paused']);

const batchJobSchema = z.object({
  action: z.enum(['cancel', 'delete']),
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export function batchJobRoutes() {
  const router = new Hono<AppEnv>();

  router.post('/batch', zValidator('json', batchJobSchema), async (c) => {
    const { action, ids } = c.req.valid('json');
    const tenantId = c.get('tenantId');
    const auth = c.get('auth');
    const deps = c.get('deps');

    const succeeded: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        const job = await deps.jobRepo.findById(id, tenantId);
        if (!job) {
          failed.push({ id, error: 'Job not found' });
          continue;
        }

        if (action === 'cancel') {
          if (!CANCELLABLE_STATUSES.has(job.status)) {
            failed.push({ id, error: `Cannot cancel job with status '${job.status}'` });
            continue;
          }
          await deps.jobRepo.updateStatus(id, tenantId, 'cancelled');
        } else {
          // delete
          await deps.jobRepo.deleteWithData(id, tenantId);
        }

        succeeded.push(id);
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }

    if (deps.auditLogger) {
      deps.auditLogger.log({
        tenantId,
        actorId: auth?.userId,
        actorType: 'user',
        action: `jobs.batch_${action}`,
        resourceType: 'job',
        resourceId: ids.join(','),
        metadata: { succeeded: succeeded.length, failed: failed.length },
      });
    }

    logger.info({ action, total: ids.length, succeeded: succeeded.length, failed: failed.length }, 'batch job operation complete');
    return c.json({ data: { succeeded, failed } });
  });

  return router;
}
```

- [ ] **Step 4: Register route in app.ts**

Same pattern as batch actions — register `/jobs/batch` before `/jobs/:jobId`:

```typescript
import { batchJobRoutes } from './routes/batch-jobs.js';

app.use('/api/v1/jobs/batch', requireScope('jobs:write'));
app.route('/api/v1/jobs', batchJobRoutes());
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @spatula/api test -- tests/unit/routes/batch-jobs.test.ts`
Expected: 5 PASS

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/batch-jobs.ts apps/api/tests/unit/routes/batch-jobs.test.ts apps/api/src/app.ts
git commit -m "feat(api): add POST /api/v1/jobs/batch for bulk cancel/delete"
```

---

### Task 7: Request Timeout Middleware

**Files:**
- Create: `apps/api/src/middleware/timeout.ts`
- Create: `apps/api/tests/unit/middleware/timeout.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write tests**

```typescript
// apps/api/tests/unit/middleware/timeout.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { timeoutMiddleware } from '../../../src/middleware/timeout.js';

describe('timeoutMiddleware', () => {
  it('allows requests that complete within timeout', async () => {
    const app = new Hono();
    app.use('*', timeoutMiddleware({ defaultMs: 1000 }));
    app.get('/fast', (c) => c.json({ ok: true }));

    const res = await app.request('/fast');
    expect(res.status).toBe(200);
  });

  it('returns 504 when request exceeds timeout', async () => {
    const app = new Hono();
    app.use('*', timeoutMiddleware({ defaultMs: 50 }));
    app.get('/slow', async (c) => {
      await new Promise((r) => setTimeout(r, 200));
      return c.json({ ok: true });
    });

    const res = await app.request('/slow');
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error.code).toBe('TIMEOUT');
  });

  it('uses route-specific timeout when configured', async () => {
    const app = new Hono();
    app.use('*', timeoutMiddleware({
      defaultMs: 50,
      overrides: { '/api/v1/exports/:exportId/download': 5000 },
    }));
    app.get('/api/v1/exports/:exportId/download', async (c) => {
      await new Promise((r) => setTimeout(r, 100));
      return c.json({ ok: true });
    });

    const res = await app.request('/api/v1/exports/exp-1/download');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/api test -- tests/unit/middleware/timeout.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement timeout middleware**

```typescript
// apps/api/src/middleware/timeout.ts
import type { MiddlewareHandler } from 'hono';
import { createLogger } from '@spatula/shared';

const logger = createLogger('timeout');

export interface TimeoutConfig {
  defaultMs: number;
  overrides?: Record<string, number>;
}

export function timeoutMiddleware(config: TimeoutConfig): MiddlewareHandler {
  const { defaultMs, overrides = {} } = config;

  return async (c, next) => {
    const path = c.req.path;
    const timeoutMs = findOverride(path, overrides) ?? defaultMs;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    });

    try {
      await Promise.race([next(), timeoutPromise]);
    } catch (err) {
      if ((err as Error).message === 'TIMEOUT') {
        logger.warn({ path: c.req.path, timeoutMs }, 'request timed out');
        return c.json(
          { error: { code: 'TIMEOUT', message: `Request timed out after ${timeoutMs}ms`, requestId: '' } },
          504,
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function findOverride(path: string, overrides: Record<string, number>): number | undefined {
  for (const [pattern, ms] of Object.entries(overrides)) {
    const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$');
    if (regex.test(path)) return ms;
  }
  return undefined;
}
```

- [ ] **Step 4: Wire into app.ts middleware chain**

In `apps/api/src/app.ts`, add after `securityHeaders()` and before CORS:

```typescript
import { timeoutMiddleware } from './middleware/timeout.js';

app.use('*', timeoutMiddleware({
  defaultMs: 30_000,
  overrides: {
    '/api/v1/exports/:exportId/download': 300_000, // 5 minutes
  },
}));
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @spatula/api test -- tests/unit/middleware/timeout.test.ts`
Expected: 3 PASS

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/middleware/timeout.ts apps/api/tests/unit/middleware/timeout.test.ts apps/api/src/app.ts
git commit -m "feat(api): add request timeout middleware (30s default, 5min exports)"
```

---

### Task 8: HealthCheck Interface + Registry

**Files:**
- Create: `packages/core/src/diagnostics/health-check.ts`
- Create: `packages/core/tests/unit/diagnostics/health-check.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write tests**

```typescript
// packages/core/tests/unit/diagnostics/health-check.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HealthCheckRegistry } from '../../../src/diagnostics/health-check.js';
import type { HealthCheck } from '../../../src/diagnostics/health-check.js';

describe('HealthCheckRegistry', () => {
  it('registers and runs checks by category', async () => {
    const registry = new HealthCheckRegistry();

    const systemCheck: HealthCheck = {
      name: 'node-version',
      category: 'system',
      run: vi.fn().mockResolvedValue({ status: 'pass', message: 'v22.0.0' }),
    };

    const serverCheck: HealthCheck = {
      name: 'postgres',
      category: 'server',
      run: vi.fn().mockResolvedValue({ status: 'fail', message: 'Connection refused' }),
    };

    registry.register(systemCheck);
    registry.register(serverCheck);

    const results = await registry.runChecks(['system']);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('node-version');
    expect(results[0].status).toBe('pass');
  });

  it('runs multiple categories', async () => {
    const registry = new HealthCheckRegistry();

    registry.register({
      name: 'check-a',
      category: 'system',
      run: async () => ({ status: 'pass', message: 'OK' }),
    });

    registry.register({
      name: 'check-b',
      category: 'server',
      run: async () => ({ status: 'warn', message: 'Slow' }),
    });

    const results = await registry.runChecks(['system', 'server']);
    expect(results).toHaveLength(2);
  });

  it('catches errors in checks and reports as fail', async () => {
    const registry = new HealthCheckRegistry();

    registry.register({
      name: 'broken',
      category: 'system',
      run: async () => { throw new Error('Unexpected'); },
    });

    const results = await registry.runChecks(['system']);
    expect(results[0].status).toBe('fail');
    expect(results[0].message).toContain('Unexpected');
  });

  it('returns empty results for unknown category', async () => {
    const registry = new HealthCheckRegistry();
    const results = await registry.runChecks(['project']);
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/core test -- tests/unit/diagnostics/health-check.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement HealthCheck interface + registry**

```typescript
// packages/core/src/diagnostics/health-check.ts

export type CheckStatus = 'pass' | 'fail' | 'warn';
export type CheckCategory = 'system' | 'server' | 'project';

export interface HealthCheckResult {
  status: CheckStatus;
  message: string;
}

export interface HealthCheck {
  name: string;
  category: CheckCategory;
  run(): Promise<HealthCheckResult>;
}

export interface CheckResult extends HealthCheckResult {
  name: string;
  category: CheckCategory;
}

export class HealthCheckRegistry {
  private checks: HealthCheck[] = [];

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  async runChecks(categories: CheckCategory[]): Promise<CheckResult[]> {
    const applicable = this.checks.filter((c) => categories.includes(c.category));
    const results: CheckResult[] = [];

    for (const check of applicable) {
      try {
        const result = await check.run();
        results.push({ name: check.name, category: check.category, ...result });
      } catch (err) {
        results.push({
          name: check.name,
          category: check.category,
          status: 'fail',
          message: (err as Error).message,
        });
      }
    }

    return results;
  }
}
```

- [ ] **Step 4: Create diagnostics barrel and export from core**

```typescript
// packages/core/src/diagnostics/index.ts
export * from './health-check.js';
```

Add to `packages/core/src/index.ts`:

```typescript
export * from './diagnostics/index.js';
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @spatula/core test -- tests/unit/diagnostics/health-check.test.ts`
Expected: 4 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/diagnostics/ packages/core/src/index.ts packages/core/tests/unit/diagnostics/health-check.test.ts
git commit -m "feat(core): add HealthCheck interface and pluggable registry"
```

---

### Task 9: System + Server Health Checks

**Files:**
- Create: `packages/core/src/diagnostics/system-checks.ts`
- Create: `packages/core/src/diagnostics/server-checks.ts`
- Create: `packages/core/tests/unit/diagnostics/system-checks.test.ts`
- Create: `packages/core/tests/unit/diagnostics/server-checks.test.ts`
- Modify: `packages/core/src/diagnostics/index.ts`

- [ ] **Step 1: Write system checks tests**

```typescript
// packages/core/tests/unit/diagnostics/system-checks.test.ts
import { describe, it, expect } from 'vitest';
import { createSystemChecks } from '../../../src/diagnostics/system-checks.js';

describe('System Health Checks', () => {
  it('creates 5 system checks', () => {
    const checks = createSystemChecks();
    expect(checks).toHaveLength(5);
    expect(checks.every((c) => c.category === 'system')).toBe(true);
  });

  it('node-version check passes for current Node.js', async () => {
    const checks = createSystemChecks();
    const nodeCheck = checks.find((c) => c.name === 'node-version')!;
    const result = await nodeCheck.run();
    expect(result.status).toBe('pass');
  });

  it('all checks have name and category', () => {
    const checks = createSystemChecks();
    for (const check of checks) {
      expect(check.name).toBeTruthy();
      expect(check.category).toBe('system');
      expect(typeof check.run).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Write server checks tests**

```typescript
// packages/core/tests/unit/diagnostics/server-checks.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createServerChecks } from '../../../src/diagnostics/server-checks.js';

describe('Server Health Checks', () => {
  it('creates 4 server checks', () => {
    const checks = createServerChecks({});
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.category === 'server')).toBe(true);
  });

  it('postgres check uses provided tester', async () => {
    const checks = createServerChecks({
      checkPostgres: vi.fn().mockResolvedValue({ status: 'pass', message: 'Connected' }),
    });
    const pgCheck = checks.find((c) => c.name === 'postgres')!;
    const result = await pgCheck.run();
    expect(result.status).toBe('pass');
  });

  it('postgres check warns when no tester and no URL', async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const checks = createServerChecks({});
    const pgCheck = checks.find((c) => c.name === 'postgres')!;
    const result = await pgCheck.run();
    expect(result.status).toBe('fail');
    if (original) process.env.DATABASE_URL = original;
  });

  it('redis check uses provided tester', async () => {
    const checks = createServerChecks({
      checkRedis: vi.fn().mockResolvedValue({ status: 'pass', message: 'PONG' }),
    });
    const redisCheck = checks.find((c) => c.name === 'redis')!;
    const result = await redisCheck.run();
    expect(result.status).toBe('pass');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @spatula/core test -- tests/unit/diagnostics/system-checks.test.ts tests/unit/diagnostics/server-checks.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement system checks**

```typescript
// packages/core/src/diagnostics/system-checks.ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { HealthCheck } from './health-check.js';

export function createSystemChecks(): HealthCheck[] {
  return [
    {
      name: 'node-version',
      category: 'system',
      async run() {
        const major = parseInt(process.versions.node.split('.')[0], 10);
        if (major >= 22) {
          return { status: 'pass', message: `Node.js v${process.versions.node}` };
        }
        return { status: 'fail', message: `Node.js v${process.versions.node} — v22+ required` };
      },
    },
    {
      name: 'docker',
      category: 'system',
      async run() {
        try {
          execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 });
          return { status: 'pass', message: 'Docker is available' };
        } catch {
          return { status: 'warn', message: 'Docker not available (optional for local dev)' };
        }
      },
    },
    {
      name: 'llm-provider',
      category: 'system',
      async run() {
        // Check Ollama
        try {
          const ollamaUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
          const res = await fetch(`${ollamaUrl}/api/tags`, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) return { status: 'pass', message: 'Ollama is reachable' };
        } catch { /* ignore */ }

        // Check OpenRouter
        if (process.env.OPENROUTER_API_KEY) {
          return { status: 'pass', message: 'OpenRouter API key configured' };
        }

        return { status: 'warn', message: 'No LLM provider configured (crawl-only mode)' };
      },
    },
    {
      name: 'playwright',
      category: 'system',
      async run() {
        try {
          execFileSync('npx', ['playwright', '--version'], { stdio: 'pipe', timeout: 10000 });
          return { status: 'pass', message: 'Playwright browsers installed' };
        } catch {
          return { status: 'warn', message: 'Playwright not installed (run: npx playwright install)' };
        }
      },
    },
    {
      name: 'env-file',
      category: 'system',
      async run() {
        if (existsSync('.env') || existsSync('.env.local')) {
          return { status: 'pass', message: '.env file found' };
        }
        return { status: 'warn', message: 'No .env file found — copy .env.example to .env' };
      },
    },
  ];
}
```

- [ ] **Step 5: Implement server checks**

```typescript
// packages/core/src/diagnostics/server-checks.ts
import type { HealthCheck, HealthCheckResult } from './health-check.js';

export interface ServerCheckConfig {
  /** Test database connectivity. Caller provides the implementation (avoids pg/ioredis dependency in core). */
  checkPostgres?: () => Promise<HealthCheckResult>;
  /** Test Redis connectivity. */
  checkRedis?: () => Promise<HealthCheckResult>;
  apiUrl?: string;
  /** Test migration state. Returns { applied, available } counts. */
  checkMigrations?: () => Promise<HealthCheckResult>;
}

export function createServerChecks(config: ServerCheckConfig): HealthCheck[] {
  return [
    {
      name: 'postgres',
      category: 'server',
      async run() {
        if (!config.checkPostgres) {
          const url = process.env.DATABASE_URL;
          if (!url) return { status: 'fail', message: 'DATABASE_URL not configured' };
          return { status: 'warn', message: 'DATABASE_URL set but no connection tester provided' };
        }
        return config.checkPostgres();
      },
    },
    {
      name: 'redis',
      category: 'server',
      async run() {
        if (!config.checkRedis) {
          const url = process.env.REDIS_URL;
          if (!url) return { status: 'fail', message: 'REDIS_URL not configured' };
          return { status: 'warn', message: 'REDIS_URL set but no connection tester provided' };
        }
        return config.checkRedis();
      },
    },
    {
      name: 'api-server',
      category: 'server',
      async run() {
        const url = config.apiUrl ?? process.env.API_URL ?? 'http://localhost:3000';
        try {
          const res = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) return { status: 'pass', message: 'API server is ready' };
          return { status: 'fail', message: `API server returned ${res.status}` };
        } catch (err) {
          return { status: 'fail', message: `API server: ${(err as Error).message}` };
        }
      },
    },
    {
      name: 'migrations',
      category: 'server',
      async run() {
        if (!config.checkMigrations) {
          return { status: 'warn', message: 'No migration checker provided' };
        }
        return config.checkMigrations();
      },
    },
  ];
}
```

The doctor command (Task 10) provides the actual `pg`/`ioredis` connection testers when calling `createServerChecks()`, keeping `@spatula/core` database-agnostic:

```typescript
// In doctor.ts, when hasEnv:
const serverConfig: ServerCheckConfig = {
  async checkPostgres() {
    const url = process.env.DATABASE_URL;
    if (!url) return { status: 'fail', message: 'DATABASE_URL not configured' };
    try {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
      await client.connect();
      await client.end();
      return { status: 'pass', message: 'PostgreSQL is reachable' };
    } catch (err) {
      return { status: 'fail', message: `PostgreSQL: ${(err as Error).message}` };
    }
  },
  async checkRedis() {
    const url = process.env.REDIS_URL;
    if (!url) return { status: 'fail', message: 'REDIS_URL not configured' };
    try {
      const { default: Redis } = await import('ioredis');
      const redis = new Redis(url, { connectTimeout: 5000, lazyConnect: true });
      await redis.connect();
      await redis.ping();
      await redis.quit();
      return { status: 'pass', message: 'Redis is reachable' };
    } catch (err) {
      return { status: 'fail', message: `Redis: ${(err as Error).message}` };
    }
  },
  async checkMigrations() {
    const url = process.env.DATABASE_URL;
    if (!url) return { status: 'fail', message: 'Cannot check without DATABASE_URL' };
    try {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
      await client.connect();
      const result = await client.query("SELECT COUNT(*) FROM drizzle.__drizzle_migrations");
      await client.end();
      return { status: 'pass', message: `${result.rows[0].count} migrations applied` };
    } catch (err) {
      return { status: 'warn', message: `Migration check: ${(err as Error).message}` };
    }
  },
};
for (const check of createServerChecks(serverConfig)) registry.register(check);
```

- [ ] **Step 6: Export from diagnostics barrel**

Update `packages/core/src/diagnostics/index.ts`:

```typescript
export * from './health-check.js';
export * from './system-checks.js';
export * from './server-checks.js';
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @spatula/core test -- tests/unit/diagnostics/`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/diagnostics/ packages/core/tests/unit/diagnostics/
git commit -m "feat(core): add 5 system + 4 server health checks"
```

---

### Task 10: Doctor Command + CLI Registration

**Files:**
- Create: `apps/cli/src/commands/doctor.ts`
- Create: `apps/cli/tests/unit/commands/doctor.test.ts`
- Modify: `apps/cli/src/index.tsx`

- [ ] **Step 1: Write tests**

```typescript
// apps/cli/tests/unit/commands/doctor.test.ts
import { describe, it, expect } from 'vitest';
import { formatCheckResults, determineCategoriesFromContext } from '../../src/commands/doctor.js';

describe('spatula doctor', () => {
  it('formats pass results', () => {
    const output = formatCheckResults([
      { name: 'node-version', category: 'system', status: 'pass', message: 'v22.0.0' },
    ]);
    expect(output).toContain('node-version');
    expect(output).toContain('v22.0.0');
    expect(output).toContain('PASS');
  });

  it('formats fail results', () => {
    const output = formatCheckResults([
      { name: 'postgres', category: 'server', status: 'fail', message: 'Connection refused' },
    ]);
    expect(output).toContain('FAIL');
    expect(output).toContain('Connection refused');
  });

  it('formats warn results', () => {
    const output = formatCheckResults([
      { name: 'docker', category: 'system', status: 'warn', message: 'Not available' },
    ]);
    expect(output).toContain('WARN');
  });

  it('shows summary counts', () => {
    const output = formatCheckResults([
      { name: 'a', category: 'system', status: 'pass', message: 'OK' },
      { name: 'b', category: 'system', status: 'warn', message: 'Meh' },
      { name: 'c', category: 'server', status: 'fail', message: 'Bad' },
    ]);
    expect(output).toContain('1 passed');
    expect(output).toContain('1 warnings');
    expect(output).toContain('1 failed');
  });

  it('determines system-only when no .env and no project', () => {
    const cats = determineCategoriesFromContext({ hasEnv: false, hasProject: false });
    expect(cats).toEqual(['system']);
  });

  it('adds server category when .env exists', () => {
    const cats = determineCategoriesFromContext({ hasEnv: true, hasProject: false });
    expect(cats).toContain('system');
    expect(cats).toContain('server');
  });

  it('adds project category when spatula.yaml exists', () => {
    const cats = determineCategoriesFromContext({ hasEnv: false, hasProject: true });
    expect(cats).toContain('system');
    expect(cats).toContain('project');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @spatula/cli test -- tests/unit/commands/doctor.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement doctor command**

```typescript
// apps/cli/src/commands/doctor.ts
import { existsSync } from 'node:fs';
import {
  HealthCheckRegistry,
  createSystemChecks,
  createServerChecks,
  findProjectRoot,
} from '@spatula/core';
import type { CheckCategory, CheckResult } from '@spatula/core';

export function determineCategoriesFromContext(context: {
  hasEnv: boolean;
  hasProject: boolean;
}): CheckCategory[] {
  const categories: CheckCategory[] = ['system'];
  if (context.hasEnv) categories.push('server');
  if (context.hasProject) categories.push('project');
  return categories;
}

export function formatCheckResults(results: CheckResult[]): string {
  const lines: string[] = [];
  let currentCategory = '';

  for (const result of results) {
    if (result.category !== currentCategory) {
      currentCategory = result.category;
      lines.push(`\n  ${currentCategory.toUpperCase()} CHECKS`);
      lines.push('  ' + '-'.repeat(40));
    }

    const icon =
      result.status === 'pass' ? ' PASS' :
      result.status === 'warn' ? ' WARN' :
      ' FAIL';
    lines.push(`  ${icon}  ${result.name} — ${result.message}`);
  }

  // Summary
  const passed = results.filter((r) => r.status === 'pass').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  lines.push('');
  lines.push(`  ${results.length} checks: ${passed} passed, ${warned} warnings, ${failed} failed`);

  return lines.join('\n');
}

export async function runDoctorCommand(): Promise<void> {
  const cwd = process.cwd();

  // Detect context
  const hasEnv = existsSync('.env') || existsSync('.env.local');
  const hasProject = findProjectRoot(cwd) !== null;
  const categories = determineCategoriesFromContext({ hasEnv, hasProject });

  console.log('\nSpatula Doctor\n');
  console.log(`  Context: ${hasProject ? 'inside project' : 'no project'}, ${hasEnv ? '.env found' : 'no .env'}`);

  // Build registry
  const registry = new HealthCheckRegistry();
  for (const check of createSystemChecks()) registry.register(check);
  if (hasEnv) {
    for (const check of createServerChecks({})) registry.register(check);
  }
  // Project checks will be registered by Wave 4-2

  // Run checks
  const results = await registry.runChecks(categories);
  console.log(formatCheckResults(results));

  // Exit code based on failures
  const hasFail = results.some((r) => r.status === 'fail');
  if (hasFail) process.exitCode = 1;
}
```

- [ ] **Step 4: Register doctor command in index.tsx**

In `apps/cli/src/index.tsx`, add the import and yargs command:

```typescript
import { runDoctorCommand } from './commands/doctor.js';

// Add as yargs command:
.command(
  'doctor',
  'Run system health checks',
  () => {},
  async () => {
    await runDoctorCommand();
  },
)
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @spatula/cli test -- tests/unit/commands/doctor.test.ts`
Expected: 7 PASS

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/commands/doctor.ts apps/cli/tests/unit/commands/doctor.test.ts apps/cli/src/index.tsx
git commit -m "feat(cli): add spatula doctor command with system + server checks"
```

---

### Task 11: Final Integration + Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (1,958 baseline + ~30 new ≈ ~1,990)

- [ ] **Step 2: Run build across all packages**

Run: `pnpm -r build`
Expected: All packages build successfully

- [ ] **Step 3: Verify typecheck**

Run: `pnpm -r typecheck`
Expected: No type errors

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
# If clean, skip. Otherwise:
git add -A
git commit -m "chore: wave 4-1 final cleanup"
```
