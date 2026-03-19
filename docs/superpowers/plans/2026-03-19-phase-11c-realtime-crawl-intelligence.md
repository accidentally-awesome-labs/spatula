# Phase 11c: Real-Time & Crawl Intelligence — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add push-based real-time job updates via WebSocket (replacing 3s polling) and intelligent LLM-powered link prioritization during crawling.

**Architecture:** Workers publish typed events to Redis Pub/Sub channels (`spatula:events:{jobId}`) at key pipeline points. The API server subscribes to these channels per WebSocket connection and forwards events to connected clients. The CLI dashboard switches from HTTP polling to WebSocket with automatic polling fallback. Separately, a `LinkEvaluator` uses the fast LLM tier to score discovered links by relevance before enqueuing, filtering low-value links and assigning priority to high-value ones.

**Tech Stack:** TypeScript, ioredis (Pub/Sub), @hono/node-ws (WebSocket adapter), Vitest, Zustand (CLI store), Zod (validation)

---

## Prerequisites

- Phase 11a complete (migrations, ActionRepository, distributed lock, E2E test passing)
- Design spec: `docs/superpowers/specs/2026-03-17-phase-11-production-hardening-design.md` (section 11c)

## File Map

```
Created:
  packages/queue/src/events.ts                              — Job event types + RedisEventPublisher
  apps/api/src/ws/types.ts                                  — WebSocket message type definitions
  apps/api/src/ws/job-progress.ts                           — Per-job connection manager (Redis sub → WS forward)
  packages/core/src/link-evaluation/evaluator.ts            — LinkEvaluator interface + LLMLinkEvaluator
  packages/core/src/link-evaluation/index.ts                — Barrel exports
  apps/cli/src/hooks/useWebSocket.ts                        — WebSocket React hook (replaces polling in dashboard)

  packages/queue/tests/unit/events.test.ts
  apps/api/tests/unit/ws/job-progress.test.ts
  packages/core/tests/unit/link-evaluation/evaluator.test.ts
  apps/cli/tests/unit/hooks/useWebSocket.test.ts

Modified:
  packages/queue/src/worker-deps.ts                         — Add optional eventPublisher
  packages/queue/src/index.ts                               — Export events module
  packages/queue/src/workers/crawl-worker.ts                — Publish events + link evaluator integration
  packages/queue/src/workers/schema-worker.ts               — Publish schema_evolved event
  packages/queue/src/workers/reconciliation-worker.ts       — Publish entity_created + job_status_changed events
  apps/api/src/server.ts                                    — WebSocket adapter setup via @hono/node-ws
  apps/api/src/types.ts                                     — Add redisSubscriber to AppDeps
  apps/cli/src/components/dashboard/DashboardView.tsx       — WebSocket with polling fallback
  packages/core/src/index.ts                                — Export link-evaluation module
```

---

## Task 1: Event Types & Redis Publisher

**Files:**
- Create: `packages/queue/src/events.ts`
- Create: `packages/queue/tests/unit/events.test.ts`
- Modify: `packages/queue/src/index.ts`

This task creates the event publishing infrastructure that workers use to broadcast typed events to Redis Pub/Sub channels. The `EventPublisher` interface keeps workers decoupled from Redis — tests can use a no-op or spy implementation.

- [ ] **Step 1: Write failing tests**

Create `packages/queue/tests/unit/events.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisEventPublisher } from '../../src/events.js';
import type { JobEvent } from '../../src/events.js';

function createMockRedis() {
  return {
    publish: vi.fn().mockResolvedValue(1),
  };
}

describe('RedisEventPublisher', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let publisher: RedisEventPublisher;

  beforeEach(() => {
    mockRedis = createMockRedis();
    publisher = new RedisEventPublisher(mockRedis as any);
  });

  it('publishes to spatula:events:{jobId} channel', async () => {
    await publisher.publish('job-123', {
      type: 'crawl_progress',
      jobId: 'job-123',
      tenantId: 'tenant-1',
      data: { pagesFound: 10, pagesCrawled: 5, pagesExtracted: 3 },
    });

    expect(mockRedis.publish).toHaveBeenCalledWith(
      'spatula:events:job-123',
      expect.any(String),
    );
  });

  it('serializes event as JSON with timestamp', async () => {
    const before = Date.now();
    await publisher.publish('job-123', {
      type: 'task_completed',
      jobId: 'job-123',
      tenantId: 'tenant-1',
      data: { taskId: 't-1', url: 'https://example.com', classification: 'single_entry' },
    });
    const after = Date.now();

    const payload = JSON.parse(mockRedis.publish.mock.calls[0][1]) as JobEvent;
    expect(payload.type).toBe('task_completed');
    expect(payload.jobId).toBe('job-123');
    expect(payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp).toBeLessThanOrEqual(after);
  });

  it('does not throw when publish fails', async () => {
    mockRedis.publish.mockRejectedValue(new Error('connection lost'));
    await expect(
      publisher.publish('job-123', {
        type: 'error',
        jobId: 'job-123',
        tenantId: 'tenant-1',
        data: { message: 'test' },
      }),
    ).resolves.toBeUndefined();
  });

  it('supports all event types', async () => {
    const types = [
      'crawl_progress',
      'task_completed',
      'schema_evolved',
      'action_pending',
      'job_status_changed',
      'entity_created',
      'error',
    ] as const;

    for (const type of types) {
      await publisher.publish('job-1', {
        type,
        jobId: 'job-1',
        tenantId: 't-1',
        data: {},
      });
    }

    expect(mockRedis.publish).toHaveBeenCalledTimes(types.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run packages/queue/tests/unit/events.test.ts`
Expected: FAIL — cannot resolve `../../src/events.js`

- [ ] **Step 3: Implement events.ts**

Create `packages/queue/src/events.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import type Redis from 'ioredis';

const logger = createLogger('events');

// ─── Event types ───────────────────────────────────────────────

export type JobEventType =
  | 'crawl_progress'
  | 'task_completed'
  | 'schema_evolved'
  | 'action_pending'
  | 'job_status_changed'
  | 'entity_created'
  | 'error';

export interface JobEvent {
  type: JobEventType;
  jobId: string;
  tenantId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export function channelForJob(jobId: string): string {
  return `spatula:events:${jobId}`;
}

// ─── Publisher interface ───────────────────────────────────────

export interface EventPublisher {
  publish(jobId: string, event: Omit<JobEvent, 'timestamp'>): Promise<void>;
}

// ─── Redis implementation ──────────────────────────────────────

export class RedisEventPublisher implements EventPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(jobId: string, event: Omit<JobEvent, 'timestamp'>): Promise<void> {
    const full: JobEvent = { ...event, timestamp: Date.now() };
    try {
      await this.redis.publish(channelForJob(jobId), JSON.stringify(full));
    } catch (err) {
      // Fire-and-forget: event publishing should never crash a worker
      logger.warn({ jobId, type: event.type, err }, 'failed to publish event');
    }
  }
}

// ─── No-op implementation (for tests / disabled mode) ──────────

export class NoopEventPublisher implements EventPublisher {
  async publish(): Promise<void> {
    // intentionally empty
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run packages/queue/tests/unit/events.test.ts`
Expected: PASS

- [ ] **Step 5: Add exports to index.ts**

In `packages/queue/src/index.ts`, add after the Redis Lock exports:

```typescript
// Events
export { RedisEventPublisher, NoopEventPublisher, channelForJob } from './events.js';
export type { EventPublisher, JobEvent, JobEventType } from './events.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/events.ts packages/queue/tests/unit/events.test.ts packages/queue/src/index.ts
git commit -m "feat(queue): add job event types and Redis publisher for real-time updates"
```

---

## Task 2: Worker Event Integration

**Files:**
- Modify: `packages/queue/src/worker-deps.ts`
- Modify: `packages/queue/src/workers/crawl-worker.ts`
- Modify: `packages/queue/src/workers/schema-worker.ts`
- Modify: `packages/queue/src/workers/reconciliation-worker.ts`

Workers publish events at key pipeline points: after crawling a page, after storing an extraction, after schema evolution, after entity creation, and on status changes. The `eventPublisher` is optional in `WorkerDeps` — when absent, events are silently skipped.

- [ ] **Step 1: Add eventPublisher to WorkerDeps**

In `packages/queue/src/worker-deps.ts`, add the import and property:

```typescript
// Add to imports at top
import type { EventPublisher } from './events.js';

// Add to WorkerDepsConfig interface (after actionRepo line)
  eventPublisher?: EventPublisher;

// Add to WorkerDeps class (after actionRepo readonly)
  readonly eventPublisher?: EventPublisher;

// Add to constructor body (after this.actionRepo line)
    this.eventPublisher = config.eventPublisher;
```

- [ ] **Step 2: Add event publishing to crawl-worker**

In `packages/queue/src/workers/crawl-worker.ts`, add two event publish calls.

After `await deps.taskRepo.updateClassification(taskId, tenantId, classification.classification);` (line 69), add:

```typescript
    // Publish task_completed event
    await deps.eventPublisher?.publish(jobId, {
      type: 'task_completed',
      jobId,
      tenantId,
      data: { taskId, url, classification: classification.classification },
    });
```

After the `logger.debug({ taskId, linksEnqueued: enqueued }, 'links enqueued');` line (line 140), add:

```typescript
      // Publish crawl progress
      await deps.eventPublisher?.publish(jobId, {
        type: 'crawl_progress',
        jobId,
        tenantId,
        data: { pagesFound: enqueued, taskId, url },
      });
```

- [ ] **Step 3: Add event publishing to schema-worker**

In `packages/queue/src/workers/schema-worker.ts`, after the `logger.info(...)` that logs `'schema evolved'` (line 130-133), add:

```typescript
    // Publish schema_evolved event
    await deps.eventPublisher?.publish(jobId, {
      type: 'schema_evolved',
      jobId,
      tenantId,
      data: {
        version: evolvedSchema.version,
        fieldsAdded: actions.filter((a) => a.type === 'add_field').map((a) => (a as any).payload?.name ?? ''),
        fieldsMerged: actions.filter((a) => a.type === 'merge_fields').map((a) => (a as any).payload?.canonicalName ?? ''),
      },
    });
```

- [ ] **Step 4: Add event publishing to reconciliation-worker**

In `packages/queue/src/workers/reconciliation-worker.ts`, inside the entity creation loop, after `await deps.entitySourceRepo.bulkLink(links);` (line 125), add:

```typescript
      // Publish entity_created event
      await deps.eventPublisher?.publish(jobId, {
        type: 'entity_created',
        jobId,
        tenantId,
        data: {
          entityId: dbEntity.id,
          name: String(entity.mergedData.name ?? entity.mergedData.title ?? `Entity ${dbEntity.id.slice(0, 8)}`),
        },
      });
```

After `await deps.jobRepo.updateStatus(jobId, tenantId, 'completed');` (line 151), add:

```typescript
    // Publish job_status_changed event
    await deps.eventPublisher?.publish(jobId, {
      type: 'job_status_changed',
      jobId,
      tenantId,
      data: { from: 'reconciling', to: 'completed' },
    });
```

- [ ] **Step 5: Verify existing tests still pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All existing worker tests PASS (eventPublisher is optional, so nothing breaks)

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/worker-deps.ts packages/queue/src/workers/crawl-worker.ts packages/queue/src/workers/schema-worker.ts packages/queue/src/workers/reconciliation-worker.ts
git commit -m "feat(queue): publish job events from workers via optional EventPublisher"
```

---

## Task 3: WebSocket Server

**Files:**
- Create: `apps/api/src/ws/types.ts`
- Create: `apps/api/src/ws/job-progress.ts`
- Create: `apps/api/tests/unit/ws/job-progress.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/types.ts`

The WebSocket server subscribes to Redis Pub/Sub per connected client and forwards job events as typed JSON messages. It validates tenant ownership on connect (verifying the tenant actually owns the job via a DB lookup), sends heartbeat pings every 30s, and cleanly unsubscribes on disconnect. The `@hono/node-ws` adapter bridges Hono's routing with the Node.js HTTP server's upgrade mechanism.

- [ ] **Step 1: Install @hono/node-ws dependency**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter api add @hono/node-ws`

- [ ] **Step 2: Create WebSocket message types**

Create `apps/api/src/ws/types.ts`:

```typescript
export type WSMessageType =
  | 'crawl_progress'
  | 'task_completed'
  | 'schema_evolved'
  | 'action_pending'
  | 'job_status_changed'
  | 'entity_created'
  | 'error'
  | 'connected'
  | 'ping';

export interface WSMessage {
  type: WSMessageType;
  timestamp: number;
  data: Record<string, unknown>;
}
```

- [ ] **Step 3: Write failing tests for JobProgressManager**

Create `apps/api/tests/unit/ws/job-progress.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobProgressManager } from '../../../src/ws/job-progress.js';
import type { JobEvent } from '@spatula/queue';

function createMockRedis() {
  const handlers = new Map<string, (channel: string, message: string) => void>();
  return {
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: any) => {
      handlers.set(event, handler);
    }),
    duplicate: vi.fn().mockReturnThis(),
    _handlers: handlers,
    _simulateMessage(channel: string, message: string) {
      const handler = handlers.get('message');
      if (handler) handler(channel, message);
    },
  };
}

function createMockWS() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
  };
}

describe('JobProgressManager', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let manager: JobProgressManager;

  beforeEach(() => {
    mockRedis = createMockRedis();
    manager = new JobProgressManager(mockRedis as any);
  });

  it('subscribes to Redis channel on client connect', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);

    expect(mockRedis.subscribe).toHaveBeenCalledWith('spatula:events:job-1');
  });

  it('sends connected message on subscribe', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);

    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"connected"'),
    );
  });

  it('forwards matching Redis events to WebSocket client', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);

    const event: JobEvent = {
      type: 'crawl_progress',
      jobId: 'job-1',
      tenantId: 'tenant-1',
      timestamp: Date.now(),
      data: { pagesFound: 10, pagesCrawled: 5, pagesExtracted: 3 },
    };
    mockRedis._simulateMessage('spatula:events:job-1', JSON.stringify(event));

    // First call is "connected", second is the forwarded event
    expect(ws.send).toHaveBeenCalledTimes(2);
    const forwarded = JSON.parse(ws.send.mock.calls[1][0]);
    expect(forwarded.type).toBe('crawl_progress');
    expect(forwarded.data.pagesFound).toBe(10);
  });

  it('filters events by tenant to prevent cross-tenant leaks', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);

    const event: JobEvent = {
      type: 'crawl_progress',
      jobId: 'job-1',
      tenantId: 'tenant-OTHER',
      timestamp: Date.now(),
      data: { pagesFound: 10 },
    };
    mockRedis._simulateMessage('spatula:events:job-1', JSON.stringify(event));

    // Only "connected" message, event was filtered
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from Redis on client disconnect', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);
    await manager.removeClient('job-1', ws as any);

    expect(mockRedis.unsubscribe).toHaveBeenCalledWith('spatula:events:job-1');
  });

  it('does not unsubscribe if other clients remain on same job', async () => {
    const ws1 = createMockWS();
    const ws2 = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws1 as any);
    await manager.addClient('job-1', 'tenant-1', ws2 as any);

    await manager.removeClient('job-1', ws1 as any);

    expect(mockRedis.unsubscribe).not.toHaveBeenCalled();
  });

  it('skips send when WebSocket is not open', async () => {
    const ws = createMockWS();
    ws.readyState = 3; // CLOSED
    await manager.addClient('job-1', 'tenant-1', ws as any);

    // "connected" send should be skipped
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON messages from Redis', async () => {
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);

    mockRedis._simulateMessage('spatula:events:job-1', 'not valid json {{{');

    // Only "connected" message, no crash
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('sends ping heartbeats at 30s intervals', async () => {
    vi.useFakeTimers();
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);

    // First call is "connected"
    expect(ws.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledTimes(2);
    const ping = JSON.parse(ws.send.mock.calls[1][0]);
    expect(ping.type).toBe('ping');

    vi.useRealTimers();
  });

  it('stops heartbeat when all clients disconnect', async () => {
    vi.useFakeTimers();
    const ws = createMockWS();
    await manager.addClient('job-1', 'tenant-1', ws as any);
    await manager.removeClient('job-1', ws as any);

    vi.advanceTimersByTime(30_000);
    // Only "connected" message, no heartbeat after disconnect
    expect(ws.send).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter api test -- --run apps/api/tests/unit/ws/job-progress.test.ts`
Expected: FAIL — cannot resolve `../../../src/ws/job-progress.js`

- [ ] **Step 5: Implement JobProgressManager**

Create `apps/api/src/ws/job-progress.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import { channelForJob } from '@spatula/queue';
import type { JobEvent } from '@spatula/queue';
import type Redis from 'ioredis';
import type { WSMessage } from './types.js';

const logger = createLogger('ws:job-progress');

const WS_OPEN = 1;

interface ClientEntry {
  ws: { send(data: string): void; close(): void; readyState: number };
  tenantId: string;
}

export class JobProgressManager {
  /** jobId → set of connected clients */
  private clients = new Map<string, Set<ClientEntry>>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly redis: Redis) {
    redis.on('message', (channel: string, message: string) => {
      this.handleRedisMessage(channel, message);
    });
  }

  async addClient(
    jobId: string,
    tenantId: string,
    ws: ClientEntry['ws'],
  ): Promise<void> {
    const entry: ClientEntry = { ws, tenantId };

    if (!this.clients.has(jobId)) {
      this.clients.set(jobId, new Set());
      await this.redis.subscribe(channelForJob(jobId));
      logger.debug({ jobId }, 'subscribed to job events');
    }

    this.clients.get(jobId)!.add(entry);
    this.startHeartbeat();

    const msg: WSMessage = {
      type: 'connected',
      timestamp: Date.now(),
      data: { jobId },
    };
    this.safeSend(ws, msg);
  }

  async removeClient(
    jobId: string,
    ws: ClientEntry['ws'],
  ): Promise<void> {
    const clients = this.clients.get(jobId);
    if (!clients) return;

    for (const entry of clients) {
      if (entry.ws === ws) {
        clients.delete(entry);
        break;
      }
    }

    if (clients.size === 0) {
      this.clients.delete(jobId);
      await this.redis.unsubscribe(channelForJob(jobId));
      logger.debug({ jobId }, 'unsubscribed from job events');
    }

    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
  }

  private handleRedisMessage(channel: string, message: string): void {
    let event: JobEvent;
    try {
      event = JSON.parse(message);
    } catch {
      logger.warn({ channel }, 'received non-JSON message on event channel');
      return;
    }

    const clients = this.clients.get(event.jobId);
    if (!clients) return;

    const wsMessage: WSMessage = {
      type: event.type,
      timestamp: event.timestamp,
      data: event.data,
    };

    for (const entry of clients) {
      // Tenant isolation: only forward events to clients with matching tenantId
      if (entry.tenantId !== event.tenantId) continue;
      this.safeSend(entry.ws, wsMessage);
    }
  }

  private safeSend(ws: ClientEntry['ws'], msg: WSMessage): void {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn({ err }, 'failed to send WebSocket message');
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      const ping: WSMessage = { type: 'ping', timestamp: Date.now(), data: {} };
      for (const clients of this.clients.values()) {
        for (const entry of clients) {
          this.safeSend(entry.ws, ping);
        }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter api test -- --run apps/api/tests/unit/ws/job-progress.test.ts`
Expected: PASS

- [ ] **Step 7: Add redisSubscriber to AppDeps**

In `apps/api/src/types.ts`, add an import and property:

```typescript
// Add at top of imports
import type Redis from 'ioredis';

// Add to AppDeps interface (after reviewQueue line)
  redisSubscriber?: Redis;
```

- [ ] **Step 8: Update server.ts with WebSocket adapter**

Replace `apps/api/src/server.ts` with:

```typescript
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createLogger, ValidationError } from '@spatula/shared';
import { createApp } from './app.js';
import { JobProgressManager } from './ws/job-progress.js';
import type { AppDeps } from './types.js';

const logger = createLogger('api:server');

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function startServer(deps: AppDeps, port = 3000) {
  const app = createApp(deps);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Mount WebSocket route when Redis subscriber is available
  if (deps.redisSubscriber) {
    const progressManager = new JobProgressManager(deps.redisSubscriber);

    app.get(
      '/ws/jobs/:id/progress',
      upgradeWebSocket((c) => {
        const jobId = c.req.param('id');
        const tenantId = c.req.header('x-tenant-id') ?? '';

        return {
          async onOpen(_evt, ws) {
            // Validate tenant header
            if (!tenantId || !UUID_REGEX.test(tenantId)) {
              ws.close(4001, 'x-tenant-id header required');
              return;
            }

            // Validate tenant owns this job
            try {
              const job = await deps.jobRepo.findById(jobId, tenantId);
              if (!job) {
                ws.close(4004, 'Job not found for tenant');
                return;
              }
            } catch (err) {
              logger.warn({ jobId, tenantId, err }, 'WS auth check failed');
              ws.close(4500, 'Internal error');
              return;
            }

            void progressManager.addClient(jobId, tenantId, ws.raw as any);
          },
          onClose(_evt, ws) {
            void progressManager.removeClient(jobId, ws.raw as any);
          },
        };
      }),
    );

    logger.info('WebSocket endpoint mounted at /ws/jobs/:id/progress');
  }

  const server = serve({
    fetch: app.fetch,
    port,
  });

  injectWebSocket(server);

  logger.info({ port }, 'API server started');
  return server;
}
```

- [ ] **Step 9: Verify existing API tests still pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter api test -- --run`
Expected: All existing API tests PASS

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/ws/types.ts apps/api/src/ws/job-progress.ts apps/api/tests/unit/ws/job-progress.test.ts apps/api/src/server.ts apps/api/src/types.ts
git commit -m "feat(api): add WebSocket server for real-time job progress via Redis Pub/Sub"
```

---

## Task 4: CLI WebSocket Hook

**Files:**
- Create: `apps/cli/src/hooks/useWebSocket.ts`
- Create: `apps/cli/tests/unit/hooks/useWebSocket.test.ts`
- Modify: `apps/cli/src/components/dashboard/DashboardView.tsx`

The CLI dashboard currently polls the API every 3s via `useJobPolling`. This task adds a `useWebSocket` hook that connects to the WebSocket endpoint and dispatches store updates on incoming events. The DashboardView switches to WebSocket when available, falling back to polling if the connection fails or is unavailable.

- [ ] **Step 1: Write failing tests for useWebSocket**

Create `apps/cli/tests/unit/hooks/useWebSocket.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock WebSocket before importing the hook
const mockWsInstances: any[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((evt: any) => void) | null = null;
  onmessage: ((evt: any) => void) | null = null;
  onclose: ((evt: any) => void) | null = null;
  onerror: ((evt: any) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    mockWsInstances.push(this);
  }

  _open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  _message(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  _close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  _error() {
    this.onerror?.({});
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

import { parseWSMessage, applyWSMessageToStore } from '../../src/hooks/useWebSocket.js';
import type { CliStore } from '../../src/store/index.js';

function createMockStore() {
  const state = {
    setJobData: vi.fn(),
    setPendingActions: vi.fn(),
    setRecentActions: vi.fn(),
    setSchemaData: vi.fn(),
    setEntityPreviews: vi.fn(),
    jobData: { status: 'running' },
    pendingActions: [],
    recentActions: [],
    entityPreviews: [],
  };
  return {
    getState: vi.fn().mockReturnValue(state),
    _state: state,
  } as unknown as CliStore & { _state: typeof state };
}

describe('parseWSMessage', () => {
  it('parses valid JSON message', () => {
    const msg = parseWSMessage(JSON.stringify({ type: 'crawl_progress', timestamp: 1, data: {} }));
    expect(msg).toEqual({ type: 'crawl_progress', timestamp: 1, data: {} });
  });

  it('returns null for invalid JSON', () => {
    expect(parseWSMessage('not json')).toBeNull();
  });

  it('returns null for message missing type', () => {
    expect(parseWSMessage(JSON.stringify({ data: {} }))).toBeNull();
  });
});

describe('applyWSMessageToStore', () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
  });

  it('updates jobData status on job_status_changed', () => {
    applyWSMessageToStore(store, {
      type: 'job_status_changed',
      timestamp: Date.now(),
      data: { from: 'running', to: 'paused' },
    });

    expect(store._state.setJobData).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paused' }),
    );
  });

  it('appends to recentActions and pendingActions on action_pending', () => {
    applyWSMessageToStore(store, {
      type: 'action_pending',
      timestamp: Date.now(),
      data: { actionId: 'a-1', type: 'add_field', confidence: 0.9 },
    });

    expect(store._state.setRecentActions).toHaveBeenCalled();
    expect(store._state.setPendingActions).toHaveBeenCalled();
  });

  it('updates schemaData on schema_evolved', () => {
    store._state.schemaData = { version: 1 };
    applyWSMessageToStore(store, {
      type: 'schema_evolved',
      timestamp: Date.now(),
      data: { version: 2, fieldsAdded: ['color'], fieldsMerged: [] },
    });

    expect(store._state.setSchemaData).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2 }),
    );
  });

  it('appends to entityPreviews on entity_created', () => {
    applyWSMessageToStore(store, {
      type: 'entity_created',
      timestamp: Date.now(),
      data: { entityId: 'e-1', name: 'Test Entity' },
    });

    expect(store._state.setEntityPreviews).toHaveBeenCalled();
  });

  it('does not throw on unknown event type', () => {
    expect(() =>
      applyWSMessageToStore(store, {
        type: 'connected' as any,
        timestamp: Date.now(),
        data: { heartbeat: true },
      }),
    ).not.toThrow();
  });
});

afterEach(() => {
  mockWsInstances.length = 0;
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run apps/cli/tests/unit/hooks/useWebSocket.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement useWebSocket hook**

Create `apps/cli/src/hooks/useWebSocket.ts`:

```typescript
import { useEffect, useRef, useState } from 'react';
import type { CliStore, PendingAction } from '../store/index.js';

// ─── Message parsing (exported for testing) ────────────────────

export interface WSMessage {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export function parseWSMessage(raw: string): WSMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.type !== 'string') return null;
    return parsed as WSMessage;
  } catch {
    return null;
  }
}

// ─── Store dispatch (exported for testing) ─────────────────────

export function applyWSMessageToStore(store: CliStore, msg: WSMessage): void {
  const state = store.getState();

  switch (msg.type) {
    case 'job_status_changed':
      if (state.jobData) {
        state.setJobData({ ...state.jobData, status: msg.data.to as string });
      }
      break;

    case 'schema_evolved':
      if (state.schemaData) {
        state.setSchemaData({
          ...state.schemaData,
          version: msg.data.version,
          _lastEvent: msg.data,
        });
      }
      break;

    case 'action_pending': {
      const action: PendingAction = {
        id: msg.data.actionId as string,
        type: msg.data.type as string,
        confidence: msg.data.confidence as number | undefined,
        status: 'pending_review',
      };
      state.setPendingActions([action, ...state.pendingActions]);
      state.setRecentActions([action, ...state.recentActions].slice(0, 20));
      break;
    }

    case 'entity_created': {
      const preview = {
        id: msg.data.entityId as string,
        name: msg.data.name as string,
      };
      state.setEntityPreviews([...state.entityPreviews, preview].slice(-5));
      break;
    }

    // crawl_progress, task_completed, error, connected — no store dispatch needed
    // (ProgressPanel reads from jobData which is updated on job_status_changed)
    default:
      break;
  }
}

// ─── React hook ────────────────────────────────────────────────

export interface UseWebSocketResult {
  connected: boolean;
  error: string | null;
}

export function useWebSocket(
  store: CliStore,
  baseUrl: string,
  tenantId: string,
  jobId: string,
): UseWebSocketResult {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    if (!jobId) return;

    // Convert http(s):// to ws(s)://
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws/jobs/${jobId}/progress`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setError(null);
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      const msg = parseWSMessage(typeof evt.data === 'string' ? evt.data : '');
      if (msg) {
        applyWSMessageToStore(store, msg);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setError('WebSocket connection error');
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
    };

    return () => {
      mountedRef.current = false;
      ws.close();
      wsRef.current = null;
    };
  }, [store, baseUrl, tenantId, jobId]);

  return { connected, error };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run apps/cli/tests/unit/hooks/useWebSocket.test.ts`
Expected: PASS

- [ ] **Step 5: Update DashboardView to use WebSocket with polling fallback**

In `apps/cli/src/components/dashboard/DashboardView.tsx`, add the WebSocket import and swap the data source:

Replace the imports section:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand';
import type { CliStore } from '../../store/index.js';
import type { SpatulaApiClient } from '../../api/client.js';
import { useJobPolling } from '../../hooks/useJobPolling.js';
import { useWebSocket } from '../../hooks/useWebSocket.js';
import { useKeyboard } from '../../hooks/useKeyboard.js';
import { Spinner } from '../shared/Spinner.js';
import { ProgressPanel } from './ProgressPanel.js';
import { SchemaPanel } from './SchemaPanel.js';
import { ActivityFeed } from './ActivityFeed.js';
import { EntityPreview } from './EntityPreview.js';
```

Replace the existing `useJobPolling` call and add WebSocket with fallback. Change the body of the function after the `useStore` calls:

```typescript
  // Try WebSocket for real-time updates; use slower polling as supplement
  const { connected: wsConnected } = useWebSocket(
    store,
    apiClient.baseUrl,
    apiClient.tenantId,
    activeJobId ?? '',
  );

  // When WebSocket is connected, use slower 15s polling to keep full job data fresh
  // (WebSocket provides incremental updates; polling refreshes full state including
  // progress counters that individual WS events don't aggregate).
  // When WebSocket is disconnected, poll at normal 3s rate.
  const { lastError } = useJobPolling(
    store,
    apiClient,
    activeJobId ?? '',
    wsConnected ? 15000 : 3000,
  );
```

No change needed to `useJobPolling.ts` — slowing the interval from 3s to 15s works with the existing implementation.

The `SpatulaApiClient` needs to expose `baseUrl` and `tenantId` as public readonly. In `apps/cli/src/api/client.ts`, change the property declarations:

```typescript
  public readonly baseUrl: string;
  public readonly tenantId: string;
```

(These are already stored as private properties — just change visibility from `private` to `public readonly`.)

- [ ] **Step 6: Verify all CLI tests pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter cli test -- --run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/hooks/useWebSocket.ts apps/cli/tests/unit/hooks/useWebSocket.test.ts apps/cli/src/components/dashboard/DashboardView.tsx apps/cli/src/api/client.ts
git commit -m "feat(cli): add WebSocket hook for real-time dashboard updates with polling fallback"
```

---

## Task 5: Link Evaluator

**Files:**
- Create: `packages/core/src/link-evaluation/evaluator.ts`
- Create: `packages/core/src/link-evaluation/index.ts`
- Create: `packages/core/tests/unit/link-evaluation/evaluator.test.ts`
- Modify: `packages/core/src/index.ts`

The `LinkEvaluator` uses the fast LLM tier (Haiku/Flash) to score discovered links by relevance before the crawl worker enqueues them. It batches up to 20 links per LLM call to reduce API costs, returning scored links with `relevanceScore`, `expectedContent` classification, priority level, and reasoning.

**Design notes:**
- `LLMTask` type already includes `'linkEvaluation'` (`packages/core/src/llm/types.ts:3`)
- The `resolveModel()` function (`packages/core/src/llm/model-router.ts`) routes it to the appropriate model tier
- `ExtractedLink` is already defined in `packages/core/src/crawlers/link-extractor.ts:23-27`
- `SchemaDefinition` is defined in `packages/core/src/types/schema.ts:80-88`

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/unit/link-evaluation/evaluator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMLinkEvaluator } from '../../../src/link-evaluation/evaluator.js';
import type { ExtractedLink } from '../../../src/crawlers/link-extractor.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';

const MOCK_SCHEMA: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'title', description: 'Product title', type: 'string', required: true },
    { name: 'price', description: 'Product price', type: 'currency', required: true },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

const MOCK_CONTEXT = {
  description: 'Scrape product listings from an electronics store',
  seedDomains: ['shop.example.com'],
  currentDepth: 1,
  maxDepth: 3,
};

function createMockLLM(response: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content: response,
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
    }),
  };
}

describe('LLMLinkEvaluator', () => {
  it('returns scored links from LLM response', async () => {
    const links: ExtractedLink[] = [
      { url: 'https://shop.example.com/products/laptop', text: 'Gaming Laptop' },
      { url: 'https://shop.example.com/about', text: 'About Us' },
    ];

    const llmResponse = JSON.stringify([
      {
        url: 'https://shop.example.com/products/laptop',
        relevanceScore: 0.95,
        expectedContent: 'single_entry',
        priority: 'high',
        reasoning: 'Product detail page matching target schema',
      },
      {
        url: 'https://shop.example.com/about',
        relevanceScore: 0.1,
        expectedContent: 'unknown',
        priority: 'low',
        reasoning: 'About page, unlikely to contain product data',
      },
    ]);

    const llm = createMockLLM(llmResponse);
    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    const result = await evaluator.evaluate(links, MOCK_CONTEXT, MOCK_SCHEMA);

    expect(result).toHaveLength(2);
    expect(result[0].relevanceScore).toBe(0.95);
    expect(result[0].priority).toBe('high');
    expect(result[1].relevanceScore).toBe(0.1);
    expect(result[1].priority).toBe('low');
  });

  it('batches links in groups of 20', async () => {
    const links: ExtractedLink[] = Array.from({ length: 25 }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      text: `Page ${i}`,
    }));

    const batchResponse = (count: number) =>
      JSON.stringify(
        Array.from({ length: count }, (_, i) => ({
          url: links[i]?.url ?? `https://example.com/page-${i}`,
          relevanceScore: 0.5,
          expectedContent: 'unknown',
          priority: 'medium',
          reasoning: 'Generic page',
        })),
      );

    const llm = createMockLLM(batchResponse(20));
    // Make the second call return remaining links
    (llm.complete as any)
      .mockResolvedValueOnce({
        content: batchResponse(20),
        model: 'test-model',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        content: batchResponse(5),
        model: 'test-model',
        usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        finishReason: 'stop',
      });

    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    const result = await evaluator.evaluate(links, MOCK_CONTEXT, MOCK_SCHEMA);

    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(25);
  });

  it('returns empty array for empty input', async () => {
    const llm = createMockLLM('[]');
    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    const result = await evaluator.evaluate([], MOCK_CONTEXT, MOCK_SCHEMA);

    expect(result).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('falls back to low-confidence scores on LLM failure', async () => {
    const links: ExtractedLink[] = [
      { url: 'https://example.com/page', text: 'Page' },
    ];

    const llm = createMockLLM('invalid json');
    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    const result = await evaluator.evaluate(links, MOCK_CONTEXT, MOCK_SCHEMA);

    expect(result).toHaveLength(1);
    expect(result[0].relevanceScore).toBe(0.5);
    expect(result[0].priority).toBe('medium');
    expect(result[0].expectedContent).toBe('unknown');
  });

  it('includes schema field names and job description in prompt', async () => {
    const links: ExtractedLink[] = [
      { url: 'https://example.com/page', text: 'Test' },
    ];

    const llm = createMockLLM(JSON.stringify([{
      url: 'https://example.com/page',
      relevanceScore: 0.5,
      expectedContent: 'unknown',
      priority: 'medium',
      reasoning: 'test',
    }]));

    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    await evaluator.evaluate(links, MOCK_CONTEXT, MOCK_SCHEMA);

    const userPrompt = (llm.complete as any).mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain('title');
    expect(userPrompt).toContain('price');
    expect(userPrompt).toContain('electronics store');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/link-evaluation/evaluator.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement LinkEvaluator**

Create `packages/core/src/link-evaluation/evaluator.ts`:

```typescript
import { createLogger } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { ExtractedLink } from '../crawlers/link-extractor.js';
import type { SchemaDefinition } from '../types/schema.js';

const logger = createLogger('link-evaluator');

const BATCH_SIZE = 20;

// ─── Types ─────────────────────────────────────────────────────

export type ExpectedContentType =
  | 'single_entry'
  | 'listing'
  | 'pagination'
  | 'category'
  | 'unknown';

export type LinkPriority = 'high' | 'medium' | 'low';

export interface EvaluatedLink extends ExtractedLink {
  relevanceScore: number;
  expectedContent: ExpectedContentType;
  priority: LinkPriority;
  reasoning: string;
}

export interface LinkEvaluationContext {
  description: string;
  seedDomains: string[];
  currentDepth: number;
  maxDepth: number;
}

// ─── Interface ─────────────────────────────────────────────────

export interface LinkEvaluator {
  evaluate(
    links: ExtractedLink[],
    jobContext: LinkEvaluationContext,
    schema: SchemaDefinition,
  ): Promise<EvaluatedLink[]>;
}

// ─── LLM Implementation ───────────────────────────────────────

export class LLMLinkEvaluator implements LinkEvaluator {
  constructor(
    private readonly llm: LLMClient,
    private readonly model: string,
  ) {}

  async evaluate(
    links: ExtractedLink[],
    jobContext: LinkEvaluationContext,
    schema: SchemaDefinition,
  ): Promise<EvaluatedLink[]> {
    if (links.length === 0) return [];

    const results: EvaluatedLink[] = [];

    // Process in batches to reduce API costs
    for (let i = 0; i < links.length; i += BATCH_SIZE) {
      const batch = links.slice(i, i + BATCH_SIZE);
      const evaluated = await this.evaluateBatch(batch, jobContext, schema);
      results.push(...evaluated);
    }

    return results;
  }

  private async evaluateBatch(
    links: ExtractedLink[],
    jobContext: LinkEvaluationContext,
    schema: SchemaDefinition,
  ): Promise<EvaluatedLink[]> {
    const fieldNames = schema.fields.map((f) => f.name).join(', ');
    const linksJson = links.map((l) => ({ url: l.url, text: l.text ?? '' }));

    const prompt = `Evaluate each link's relevance to this data extraction job.

Job description: ${jobContext.description}
Seed domains: ${jobContext.seedDomains.join(', ')}
Current crawl depth: ${jobContext.currentDepth}/${jobContext.maxDepth}
Target schema fields: ${fieldNames}

Links to evaluate:
${JSON.stringify(linksJson, null, 2)}

For each link, return a JSON array with objects containing:
- url: the link URL (exactly as provided)
- relevanceScore: 0-1 float (1 = highly relevant to extracting target data)
- expectedContent: one of "single_entry", "listing", "pagination", "category", "unknown"
- priority: "high", "medium", or "low"
- reasoning: brief explanation

Return ONLY the JSON array, no other text.`;

    try {
      const response = await this.llm.complete({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a web crawl link evaluator. You evaluate links for relevance to data extraction jobs. Respond only with JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        jsonMode: true,
      });

      return this.parseResponse(response.content, links);
    } catch (err) {
      logger.warn({ err, linkCount: links.length }, 'LLM link evaluation failed, using fallback scores');
      return this.fallbackScores(links);
    }
  }

  private parseResponse(content: string, originalLinks: ExtractedLink[]): EvaluatedLink[] {
    try {
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) throw new Error('Response is not an array');

      // Build a map for quick lookup; fall back for any missing links
      const resultMap = new Map<string, any>();
      for (const item of parsed) {
        if (item.url) resultMap.set(item.url, item);
      }

      return originalLinks.map((link) => {
        const evaluated = resultMap.get(link.url);
        if (evaluated) {
          return {
            ...link,
            relevanceScore: clamp(Number(evaluated.relevanceScore) || 0.5, 0, 1),
            expectedContent: validateExpectedContent(evaluated.expectedContent),
            priority: validatePriority(evaluated.priority),
            reasoning: String(evaluated.reasoning || ''),
          };
        }
        return { ...link, relevanceScore: 0.5, expectedContent: 'unknown' as const, priority: 'medium' as const, reasoning: 'Not evaluated by LLM' };
      });
    } catch {
      logger.warn('Failed to parse LLM link evaluation response, using fallback');
      return this.fallbackScores(originalLinks);
    }
  }

  private fallbackScores(links: ExtractedLink[]): EvaluatedLink[] {
    return links.map((link) => ({
      ...link,
      relevanceScore: 0.5,
      expectedContent: 'unknown' as const,
      priority: 'medium' as const,
      reasoning: 'Fallback score — LLM evaluation unavailable',
    }));
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const VALID_CONTENT_TYPES = new Set(['single_entry', 'listing', 'pagination', 'category', 'unknown']);
function validateExpectedContent(value: unknown): ExpectedContentType {
  return VALID_CONTENT_TYPES.has(value as string) ? (value as ExpectedContentType) : 'unknown';
}

const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);
function validatePriority(value: unknown): LinkPriority {
  return VALID_PRIORITIES.has(value as string) ? (value as LinkPriority) : 'medium';
}
```

- [ ] **Step 4: Create barrel export**

Create `packages/core/src/link-evaluation/index.ts`:

```typescript
export {
  LLMLinkEvaluator,
  type LinkEvaluator,
  type EvaluatedLink,
  type LinkEvaluationContext,
  type ExpectedContentType,
  type LinkPriority,
} from './evaluator.js';
```

- [ ] **Step 5: Add to core index**

In `packages/core/src/index.ts`, add after the `// Execution` export line:

```typescript
// Link Evaluation
export * from './link-evaluation/index.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run packages/core/tests/unit/link-evaluation/evaluator.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/link-evaluation/evaluator.ts packages/core/src/link-evaluation/index.ts packages/core/tests/unit/link-evaluation/evaluator.test.ts packages/core/src/index.ts
git commit -m "feat(core): add LLM-powered link evaluator for intelligent crawl prioritization"
```

---

## Task 6: Crawl Worker Link Evaluation Integration

**Files:**
- Modify: `packages/queue/src/worker-deps.ts`
- Modify: `packages/queue/src/workers/crawl-worker.ts`

The crawl worker's link-handling section currently enqueues all discovered links at equal priority. This task integrates the `LinkEvaluator` so links are scored and filtered (relevanceScore > 0.3) before enqueuing, with LLM-assigned priority mapped to BullMQ job priority.

**Design notes:**
- `linkEvaluator` is optional in WorkerDeps — when absent, all links enqueue as before (backwards compatible)
- Priority mapping: `high` → BullMQ priority 1, `medium` → 5, `low` → 10 (lower number = higher priority in BullMQ)
- Links below 0.3 relevance threshold are skipped entirely

- [ ] **Step 1: Add linkEvaluator to WorkerDeps**

In `packages/queue/src/worker-deps.ts`, add:

```typescript
// Add to imports
import type { LinkEvaluator } from '@spatula/core';

// Add to WorkerDepsConfig interface (after eventPublisher line)
  linkEvaluator?: LinkEvaluator;

// Add to WorkerDeps class (after eventPublisher readonly)
  readonly linkEvaluator?: LinkEvaluator;

// Add to constructor body (after this.eventPublisher line)
    this.linkEvaluator = config.linkEvaluator;
```

- [ ] **Step 2: Integrate link evaluator into crawl-worker**

In `packages/queue/src/workers/crawl-worker.ts`, add the import at the top:

```typescript
import type { JobConfig, LinkEvaluationContext } from '@spatula/core';
```

Replace the link-handling section (lines 117–141 — from `const maxDepth` to the closing brace after `logger.debug` for links enqueued) with:

```typescript
    const maxDepth = job.config.crawl.maxDepth;
    if (depth < maxDepth && crawlResult.links.length > 0) {
      // Evaluate links if evaluator is available
      let linksToEnqueue: Array<{ url: string; text?: string; rel?: string; [key: string]: unknown }> = crawlResult.links;
      if (deps.linkEvaluator) {
        const schema = await deps.schemaRepo.findLatest(jobId, tenantId);
        if (schema) {
          const config = job.config as JobConfig;
          const context: LinkEvaluationContext = {
            description: config.description,
            seedDomains: config.seedUrls.map((u: string) => new URL(u).hostname),
            currentDepth: depth,
            maxDepth,
          };
          const evaluated = await deps.linkEvaluator.evaluate(
            crawlResult.links,
            context,
            schema.definition,
          );
          // Filter links below relevance threshold
          linksToEnqueue = evaluated.filter((l) => l.relevanceScore > 0.3);
          logger.debug(
            { taskId, total: crawlResult.links.length, accepted: linksToEnqueue.length },
            'links evaluated',
          );
        }
      }

      let enqueued = 0;
      for (const link of linksToEnqueue) {
        if (!link.url || !isValidCrawlUrl(link.url)) continue;

        const childTask = await deps.taskRepo.enqueue({
          jobId,
          tenantId,
          url: link.url,
          depth: depth + 1,
          parentTaskId: taskId,
        });

        // Map LLM priority to BullMQ priority (lower = higher priority)
        const priority =
          'priority' in link
            ? { high: 1, medium: 5, low: 10 }[link.priority as string] ?? 5
            : undefined;

        await deps.queues.crawl.add(
          `crawl:${link.url}`,
          {
            taskId: childTask.id,
            jobId,
            tenantId,
            url: link.url,
            depth: depth + 1,
          },
          priority !== undefined ? { priority } : undefined,
        );
        enqueued++;
      }
      logger.debug({ taskId, linksEnqueued: enqueued }, 'links enqueued');

      // Publish crawl progress
      await deps.eventPublisher?.publish(jobId, {
        type: 'crawl_progress',
        jobId,
        tenantId,
        data: { pagesFound: enqueued, taskId, url },
      });
    }
```

- [ ] **Step 3: Verify existing crawl-worker tests pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: PASS (linkEvaluator is optional, so existing tests unaffected)

- [ ] **Step 4: Commit**

```bash
git add packages/queue/src/worker-deps.ts packages/queue/src/workers/crawl-worker.ts
git commit -m "feat(queue): integrate link evaluator into crawl worker for priority-based enqueuing"
```

---

## Post-Implementation Checklist

After all tasks are complete:

- [ ] Run full test suite: `cd /Users/salar/Projects/spatula && pnpm test`
- [ ] Verify TypeScript compilation: `cd /Users/salar/Projects/spatula && pnpm build`
- [ ] Confirm no circular dependencies introduced between packages
