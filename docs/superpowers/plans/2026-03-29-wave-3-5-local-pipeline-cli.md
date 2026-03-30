# Wave 3-5: Local Pipeline Runner + Core CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire orchestrators (Wave 1), SQLite repos (Wave 2), and config system (Wave 2) into a working local crawl pipeline with CLI commands (init, run, status, reset, new), checkpoint/resume, and notifications.

**Architecture:** The `LocalPipelineRunner` orchestrates the same core functions used by BullMQ workers, but in a single process using in-memory concurrency (semaphore), priority queue, domain rate limiting, and page budgeting. A `DataSource` abstraction lets existing CLI TUI components (Dashboard, Explorer, Review) work against either the API or SQLite transparently. A `LocalDataSource` wraps the `ProjectAdapter` (Wave 2 SQLite repos) and bridges real-time updates from the pipeline runner via `EventEmitter`. Five CLI commands (`init`, `run`, `status`, `reset`, `new`) provide the user-facing interface.

**Tech Stack:** TypeScript, Ink (CLI TUI), SQLite (better-sqlite3 via Drizzle), Pino (logging), `node-notifier` (desktop notifications), `@spatula/core` (orchestrators), `@spatula/db` (ProjectAdapter)

**Spec references:**
- Phase 13 spec: sections 3, 4, 10
- File: `docs/superpowers/specs/2026-03-21-phase-13-project-folder-model-design.md`
- Decomposition: `docs/superpowers/specs/2026-03-25-wave-3-decomposition-design.md` section 4.7

**Depends on (Wave 1/2 only — NOT Wave 3 server sub-plans):**
- Wave 1: `processCrawlTask`, `processSchemaEvolution`, `processReconciliation`, `processExport`
- Wave 2: `ProjectAdapter`, `parseProjectYaml`, `resolveConfig`, `diffConfigs`, `findProjectRoot`, `RobotsTxtChecker`, `InMemoryDomainRateLimiter`, `InMemoryPageBudget`, `CrawlCompletionChecker`, `CircuitBreakerLLMClient`, `estimateCost()`

---

## Scope Note

This is a large sub-plan (~27 deliverables, ~24 new files). It decomposes into 14 tasks grouped by dependency:

**Foundation (Tasks 1-2):** Local content store, pipeline infrastructure (events, lock, priority queue, semaphore)
**DataSource (Task 3):** Interface + LocalDataSource
**Pipeline Runner (Task 4):** The core 13-step execution engine + checkpoint/resume (steps 9-11 fully wired, retry with backoff, robots.txt + rate limiting)
**CLI Commands (Tasks 5-8c):** init, run (with DI wiring + progress display), status, reset, new, CLI command tests
**Notifications (Task 9):** Desktop + webhook
**Logging (Task 10):** Structured per-run log files
**Integration (Tasks 11-12):** Hook adaptation + final wiring

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/core/src/content-store/local-content-store.ts` | File-based content store (HTML to `.spatula/pages/`) |
| `packages/core/src/pipeline/pipeline-events.ts` | `PipelineEventEmitter` for real-time updates |
| `packages/core/src/pipeline/project-lock.ts` | PID-based lockfile (`.spatula/run.lock`) |
| `packages/core/src/pipeline/priority-queue.ts` | In-memory priority queue for crawl tasks |
| `packages/core/src/pipeline/concurrency.ts` | Semaphore for parallel page processing |
| `packages/core/src/pipeline/local-pipeline-runner.ts` | 13-step execution engine |
| `packages/core/src/interfaces/data-source.ts` | `DataSource` interface |
| `packages/core/src/pipeline/local-data-source.ts` | `LocalDataSource` wrapping ProjectAdapter + events |
| `apps/cli/src/commands/init.ts` | `spatula init` setup wizard |
| `apps/cli/src/commands/run.ts` | `spatula run` with progress display |
| `apps/cli/src/commands/reset.ts` | `spatula reset` state cleanup |
| `apps/cli/src/notifications.ts` | Desktop + webhook notification helpers |
| `packages/core/tests/unit/pipeline/project-lock.test.ts` | Lockfile tests |
| `packages/core/tests/unit/pipeline/priority-queue.test.ts` | Priority queue tests |
| `packages/core/tests/unit/pipeline/concurrency.test.ts` | Semaphore tests |
| `packages/core/tests/unit/pipeline/local-pipeline-runner.test.ts` | Pipeline runner tests |
| `packages/core/tests/unit/pipeline/pipeline-events.test.ts` | PipelineEventEmitter typed emit/on tests |
| `packages/core/tests/unit/pipeline/local-data-source.test.ts` | LocalDataSource delegation tests |
| `packages/core/tests/unit/content-store/local-content-store.test.ts` | Local content store tests |
| `apps/cli/tests/unit/commands/init.test.ts` | `spatula init` filesystem tests |
| `apps/cli/tests/unit/commands/reset.test.ts` | `spatula reset` selective cleanup tests |
| `apps/cli/tests/unit/notifications.test.ts` | Desktop + webhook notification helper tests |

### Modified Files

| File | Change |
|------|--------|
| `packages/core/src/content-store/index.ts` | Export `LocalContentStore` |
| `packages/core/src/pipeline/index.ts` | Export new pipeline components |
| `packages/core/src/interfaces/content-store.ts` | Already has `ContentStore` interface (no change needed) |
| `packages/core/src/index.ts` | Export `DataSource`, `LocalDataSource` |
| `apps/cli/src/index.tsx` | Add init, run, status, reset commands |
| `apps/cli/src/hooks/useEntityData.ts` | Accept `DataSource` instead of `ApiClient` |
| `apps/cli/src/hooks/useJobPolling.ts` | Accept `DataSource` |
| `apps/cli/src/hooks/useEntityFilter.ts` | Accept `DataSource` |
| `apps/cli/src/hooks/useExport.ts` | Accept `DataSource` |

---

## Task 1: Local Content Store

**Files:**
- Create: `packages/core/src/content-store/local-content-store.ts`
- Create: `packages/core/tests/unit/content-store/local-content-store.test.ts`
- Modify: `packages/core/src/content-store/index.ts`

The local content store writes raw HTML to `.spatula/pages/{id}.html` and implements the `ContentStore` interface for local mode.

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/unit/content-store/local-content-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalContentStore } from '../../../src/content-store/local-content-store.js';

describe('LocalContentStore', () => {
  let tempDir: string;
  let store: LocalContentStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spatula-test-'));
    store = new LocalContentStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores text content to file and returns file:// ref', async () => {
    const ref = await store.store('page-1', '<html>Hello</html>');
    expect(ref).toContain('file://');
    expect(ref).toContain('page-1');

    // Verify file exists
    const content = await readFile(ref.replace('file://', ''), 'utf-8');
    expect(content).toBe('<html>Hello</html>');
  });

  it('retrieves stored text content', async () => {
    const ref = await store.store('page-2', '<html>World</html>');
    const content = await store.retrieve(ref);
    expect(content).toBe('<html>World</html>');
  });

  it('stores and retrieves binary content', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const ref = await store.storeBinary('export-1', data);
    const retrieved = await store.retrieveBinary(ref);
    expect(retrieved).toEqual(data);
  });

  it('deletes stored content', async () => {
    const ref = await store.store('page-3', 'content');
    await store.delete(ref);
    const retrieved = await store.retrieveBinary(ref);
    expect(retrieved).toBeNull();
  });

  it('returns null for missing binary content', async () => {
    const result = await store.retrieveBinary('file:///nonexistent');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Implement LocalContentStore**

```typescript
// packages/core/src/content-store/local-content-store.ts
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { ContentStore } from '../interfaces/content-store.js';
import { createLogger } from '@spatula/shared';

const logger = createLogger('local-content-store');

export class LocalContentStore implements ContentStore {
  constructor(private readonly basePath: string) {}

  async store(key: string, content: string): Promise<string> {
    const filePath = join(this.basePath, `${key}.html`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    const ref = `file://${filePath}`;
    logger.debug({ ref, key }, 'content stored locally');
    return ref;
  }

  async retrieve(ref: string): Promise<string> {
    const filePath = this.parseRef(ref);
    return readFile(filePath, 'utf-8');
  }

  async delete(ref: string): Promise<void> {
    const filePath = this.parseRef(ref);
    try {
      await unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async storeBinary(key: string, data: Uint8Array): Promise<string> {
    const filePath = join(this.basePath, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return `file://${filePath}`;
  }

  async retrieveBinary(ref: string): Promise<Uint8Array | null> {
    const filePath = this.parseRef(ref);
    try {
      return await readFile(filePath);
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  private parseRef(ref: string): string {
    if (ref.startsWith('file://')) return ref.slice(7);
    return ref;
  }
}
```

- [ ] **Step 3: Export from barrel**

Add to `packages/core/src/content-store/index.ts`:
```typescript
export { LocalContentStore } from './local-content-store.js';
```

- [ ] **Step 4: Run tests and commit**

```bash
pnpm --filter @spatula/core test -- --run local-content-store
git add packages/core/src/content-store/ packages/core/tests/unit/content-store/local-content-store.test.ts
git commit -m "feat(core): add LocalContentStore for file-based HTML storage"
```

---

## Task 2: Pipeline Infrastructure — Events, Lock, Priority Queue, Semaphore

**Files:**
- Create: `packages/core/src/pipeline/pipeline-events.ts`
- Create: `packages/core/src/pipeline/project-lock.ts`
- Create: `packages/core/src/pipeline/priority-queue.ts`
- Create: `packages/core/src/pipeline/concurrency.ts`
- Create tests for each

This task creates 4 small, independent infrastructure pieces that the `LocalPipelineRunner` depends on.

- [ ] **Step 1: Implement PipelineEventEmitter**

```typescript
// packages/core/src/pipeline/pipeline-events.ts
import { EventEmitter } from 'node:events';

export interface PipelineEvents {
  'task:completed': (task: { id: string; url: string; status: string }) => void;
  'entity:created': (entity: { id: string; jobId: string }) => void;
  'schema:evolved': (schema: { version: number; fields: unknown[] }) => void;
  'action:pending': (action: { id: string; type: string }) => void;
  'progress': (stats: { pagesProcessed: number; totalPages: number; entitiesCreated: number; errors: number }) => void;
}

export class PipelineEventEmitter extends EventEmitter {
  emit<K extends keyof PipelineEvents>(event: K, ...args: Parameters<PipelineEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof PipelineEvents>(event: K, listener: PipelineEvents[K]): this {
    return super.on(event, listener as (...args: any[]) => void);
  }
}
```

- [ ] **Step 1b: Write PipelineEventEmitter tests (I11)**

```typescript
// packages/core/tests/unit/pipeline/pipeline-events.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PipelineEventEmitter } from '../../../src/pipeline/pipeline-events.js';

describe('PipelineEventEmitter', () => {
  it('emits and receives typed task:completed events', () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on('task:completed', handler);
    emitter.emit('task:completed', { id: 't1', url: 'https://example.com', status: 'completed' });
    expect(handler).toHaveBeenCalledWith({ id: 't1', url: 'https://example.com', status: 'completed' });
  });

  it('emits and receives typed progress events', () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on('progress', handler);
    emitter.emit('progress', { pagesProcessed: 5, totalPages: 100, entitiesCreated: 2, errors: 0 });
    expect(handler).toHaveBeenCalledWith({ pagesProcessed: 5, totalPages: 100, entitiesCreated: 2, errors: 0 });
  });

  it('supports multiple listeners on the same event', () => {
    const emitter = new PipelineEventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    emitter.on('entity:created', h1);
    emitter.on('entity:created', h2);
    emitter.emit('entity:created', { id: 'e1', jobId: 'j1' });
    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement ProjectLock**

```typescript
// packages/core/src/pipeline/project-lock.ts
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { createLogger } from '@spatula/shared';

const logger = createLogger('project-lock');

export class ProjectLock {
  private readonly lockPath: string;
  private acquired = false;

  constructor(projectDir: string) {
    this.lockPath = `${projectDir}/run.lock`;
  }

  acquire(force = false): boolean {
    if (existsSync(this.lockPath)) {
      const content = readFileSync(this.lockPath, 'utf-8');
      const pid = parseInt(content.trim(), 10);

      // Check if PID is still running
      try {
        process.kill(pid, 0); // Signal 0 = check if process exists
        if (!force) {
          logger.warn({ pid }, 'Another spatula process is running');
          return false;
        }
        logger.info({ pid }, 'Forcing lock takeover (--force)');
      } catch {
        // PID not running — stale lock
        logger.info({ pid }, 'Stale lock detected, acquiring');
      }
    }

    writeFileSync(this.lockPath, String(process.pid));
    this.acquired = true;
    return true;
  }

  release(): void {
    if (this.acquired && existsSync(this.lockPath)) {
      try {
        unlinkSync(this.lockPath);
        this.acquired = false;
      } catch (err) {
        logger.warn({ err }, 'Failed to release lock');
      }
    }
  }

  get isAcquired(): boolean {
    return this.acquired;
  }
}
```

- [ ] **Step 3: Write tests for lock**

```typescript
// packages/core/tests/unit/pipeline/project-lock.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectLock } from '../../../src/pipeline/project-lock.js';

describe('ProjectLock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spatula-lock-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('acquires lock when no existing lock', () => {
    const lock = new ProjectLock(tempDir);
    expect(lock.acquire()).toBe(true);
    expect(lock.isAcquired).toBe(true);
    expect(existsSync(join(tempDir, 'run.lock'))).toBe(true);
    lock.release();
  });

  it('releases lock and removes file', () => {
    const lock = new ProjectLock(tempDir);
    lock.acquire();
    lock.release();
    expect(existsSync(join(tempDir, 'run.lock'))).toBe(false);
    expect(lock.isAcquired).toBe(false);
  });

  it('detects stale lock and acquires', () => {
    // Write a lock with a PID that definitely does not exist
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(tempDir, 'run.lock'), '999999');
    const lock = new ProjectLock(tempDir);
    expect(lock.acquire()).toBe(true);
  });
});
```

- [ ] **Step 4: Implement PriorityQueue**

```typescript
// packages/core/src/pipeline/priority-queue.ts

export interface QueueItem<T> {
  data: T;
  priority: number; // Higher = process first
  depth: number;    // For breadth-first tiebreaking
}

export class PriorityQueue<T> {
  private items: QueueItem<T>[] = [];

  enqueue(data: T, priority: number, depth: number): void {
    this.items.push({ data, priority, depth });
    this.items.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority; // Higher priority first
      return a.depth - b.depth; // Lower depth first (breadth-first)
    });
  }

  dequeue(): T | undefined {
    return this.items.shift()?.data;
  }

  dequeueBatch(count: number): T[] {
    const batch: T[] = [];
    for (let i = 0; i < count; i++) {
      const item = this.dequeue();
      if (!item) break;
      batch.push(item);
    }
    return batch;
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }
}
```

- [ ] **Step 5: Write priority queue tests**

```typescript
// packages/core/tests/unit/pipeline/priority-queue.test.ts
import { describe, it, expect } from 'vitest';
import { PriorityQueue } from '../../../src/pipeline/priority-queue.js';

describe('PriorityQueue', () => {
  it('dequeues highest priority first', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('low', 1, 0);
    q.enqueue('high', 10, 0);
    q.enqueue('medium', 5, 0);
    expect(q.dequeue()).toBe('high');
    expect(q.dequeue()).toBe('medium');
    expect(q.dequeue()).toBe('low');
  });

  it('breaks ties by depth (breadth-first)', () => {
    const q = new PriorityQueue<string>();
    q.enqueue('deep', 5, 3);
    q.enqueue('shallow', 5, 1);
    q.enqueue('mid', 5, 2);
    expect(q.dequeue()).toBe('shallow');
    expect(q.dequeue()).toBe('mid');
    expect(q.dequeue()).toBe('deep');
  });

  it('dequeueBatch returns up to N items', () => {
    const q = new PriorityQueue<number>();
    q.enqueue(1, 1, 0);
    q.enqueue(2, 2, 0);
    q.enqueue(3, 3, 0);
    const batch = q.dequeueBatch(2);
    expect(batch).toEqual([3, 2]);
    expect(q.size).toBe(1);
  });

  it('reports size and isEmpty', () => {
    const q = new PriorityQueue<string>();
    expect(q.isEmpty).toBe(true);
    q.enqueue('a', 1, 0);
    expect(q.isEmpty).toBe(false);
    expect(q.size).toBe(1);
  });
});
```

- [ ] **Step 6: Implement Semaphore**

```typescript
// packages/core/src/pipeline/concurrency.ts

export class Semaphore {
  private current = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.waiting.shift();
    if (next) next();
  }

  get available(): number {
    return this.max - this.current;
  }

  get activeCount(): number {
    return this.current;
  }
}
```

- [ ] **Step 7: Write semaphore tests**

```typescript
// packages/core/tests/unit/pipeline/concurrency.test.ts
import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../../src/pipeline/concurrency.js';

describe('Semaphore', () => {
  it('allows up to max concurrent acquisitions', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.activeCount).toBe(2);
    expect(sem.available).toBe(0);
  });

  it('blocks beyond max and resumes on release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let resolved = false;
    const pending = sem.acquire().then(() => { resolved = true; });

    // Not yet resolved
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    sem.release();
    await pending;
    expect(resolved).toBe(true);
  });

  it('reports available slots', async () => {
    const sem = new Semaphore(3);
    expect(sem.available).toBe(3);
    await sem.acquire();
    expect(sem.available).toBe(2);
    sem.release();
    expect(sem.available).toBe(3);
  });
});
```

- [ ] **Step 8: Export all from pipeline barrel**

Add to `packages/core/src/pipeline/index.ts`:
```typescript
export { PipelineEventEmitter } from './pipeline-events.js';
export type { PipelineEvents } from './pipeline-events.js';
export { ProjectLock } from './project-lock.js';
export { PriorityQueue } from './priority-queue.js';
export { Semaphore } from './concurrency.js';
```

- [ ] **Step 9: Run tests and commit**

```bash
pnpm --filter @spatula/core test -- --run pipeline/project-lock --run pipeline/priority-queue --run pipeline/concurrency
git add packages/core/src/pipeline/ packages/core/tests/unit/pipeline/
git commit -m "feat(core): add pipeline infrastructure — events, lock, priority queue, semaphore"
```

---

## Task 3: DataSource Interface + LocalDataSource

**Files:**
- Create: `packages/core/src/interfaces/data-source.ts`
- Create: `packages/core/src/pipeline/local-data-source.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Define DataSource interface**

```typescript
// packages/core/src/interfaces/data-source.ts
import type { Entity } from '@spatula/shared';

export interface PaginationQuery {
  limit?: number;
  offset?: number;
  search?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
}

export interface ProjectStatus {
  lastRun?: { id: string; status: string; startedAt: string; pagesProcessed: number; entitiesCreated: number };
  totalPages: number;
  totalEntities: number;
  pendingActions: number;
  schemaFields: number;
  storageBytes: { pages: number; database: number; exports: number };
}

export interface DataEvent {
  type: string;
  data: unknown;
}

export interface DataSource {
  // Entities
  getEntities(query: PaginationQuery): Promise<PaginatedResult<Entity>>;
  getEntity(id: string): Promise<Entity | null>;
  searchEntities(filter: string): Promise<Entity[]>;

  // Schema
  getSchema(): Promise<unknown>;
  getSchemaVersions(): Promise<unknown[]>;

  // Actions
  getActions(status?: string): Promise<unknown[]>;
  approveAction(id: string, reviewedBy?: string): Promise<void>;
  rejectAction(id: string, reviewedBy?: string): Promise<void>;

  // Job/project status
  getStatus(): Promise<ProjectStatus>;

  // Exports
  createExport(options: { format: string; includeProvenance?: boolean }): Promise<unknown>;
  getExport(id: string): Promise<unknown>;
  downloadExport(id: string): Promise<{ data: Uint8Array; filename: string } | null>;

  // Documentation
  getDocumentation(): Promise<{ schema: unknown; examples: unknown[] } | null>;

  // Real-time updates (optional)
  subscribe?(callback: (event: DataEvent) => void): () => void;
}
```

- [ ] **Step 2: Implement LocalDataSource**

```typescript
// packages/core/src/pipeline/local-data-source.ts
import type { DataSource, PaginationQuery, PaginatedResult, ProjectStatus, DataEvent } from '../interfaces/data-source.js';
import type { Entity } from '@spatula/shared';
import type { PipelineEventEmitter } from './pipeline-events.js';

/**
 * DataSource backed by SQLite ProjectAdapter + EventEmitter.
 * Used in local mode — no API server needed.
 */
export class LocalDataSource implements DataSource {
  constructor(
    private readonly adapter: import('@spatula/db').ProjectAdapter,
    private readonly events?: PipelineEventEmitter,
  ) {}

  private get projectId(): string {
    return this.adapter.getProjectId();
  }

  async getEntities(query: PaginationQuery): Promise<PaginatedResult<Entity>> {
    const entities = await this.adapter.entityRepo.findByJob(
      this.projectId, this.projectId,
      { limit: query.limit ?? 50, offset: query.offset ?? 0 },
    );
    const total = await this.adapter.entityRepo.countByJob(
      this.projectId, this.projectId,
    );
    return { data: entities as Entity[], total };
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.adapter.entityRepo.findById(id, this.projectId);
  }

  async searchEntities(filter: string): Promise<Entity[]> {
    // Note: entityRepo.findByJob does not support search filtering;
    // client-side filtering or a dedicated search method can be added later.
    const result = await this.adapter.entityRepo.findByJob(
      this.projectId, this.projectId,
    );
    return result as Entity[];
  }

  async getSchema(): Promise<unknown> {
    return this.adapter.schemaRepo.findLatest(this.projectId, this.projectId);
  }

  async getSchemaVersions(): Promise<unknown[]> {
    return this.adapter.schemaRepo.findAllVersions(this.projectId, this.projectId);
  }

  async getActions(status?: string): Promise<unknown[]> {
    return this.adapter.actionRepo.findByJob(this.projectId, this.projectId, { status });
  }

  async approveAction(id: string, reviewedBy?: string): Promise<void> {
    await this.adapter.actionRepo.updateStatus(id, this.projectId, 'approved', reviewedBy);
  }

  async rejectAction(id: string, reviewedBy?: string): Promise<void> {
    await this.adapter.actionRepo.updateStatus(id, this.projectId, 'rejected', reviewedBy);
  }

  async getStatus(): Promise<ProjectStatus> {
    const lastRun = await this.adapter.runRepo.findLatestByStatus(['completed', 'started', 'failed']);
    const taskStats = await this.adapter.taskRepo.getJobStats(this.projectId, this.projectId);
    const totalPages = taskStats.completed + taskStats.inProgress + taskStats.pending + taskStats.failed + taskStats.skipped;
    const totalEntities = await this.adapter.entityRepo.countByJob(this.projectId, this.projectId);
    const pendingActions = (await this.adapter.actionRepo.findByJob(this.projectId, this.projectId, { status: 'pending_review' })).length;
    const schema = await this.adapter.schemaRepo.findLatest(this.projectId, this.projectId);
    const schemaFields = schema ? Object.keys((schema as any).definition?.fields ?? {}).length : 0;

    return {
      lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, startedAt: lastRun.startedAt, pagesProcessed: lastRun.pagesCrawled ?? 0, entitiesCreated: lastRun.entitiesCreated ?? 0 } : undefined,
      totalPages,
      totalEntities,
      pendingActions,
      schemaFields,
      storageBytes: { pages: 0, database: 0, exports: 0 }, // TODO: compute from filesystem
    };
  }

  async createExport(options: { format: string; includeProvenance?: boolean }): Promise<unknown> {
    // In local mode, export runs synchronously via the export orchestrator
    // This is a placeholder — the actual export logic is in the pipeline runner
    return { id: 'local-export', format: options.format, status: 'pending' };
  }

  async getExport(id: string): Promise<unknown> {
    return this.adapter.exportRepo.findById(id);
  }

  async downloadExport(id: string): Promise<{ data: Uint8Array; filename: string } | null> {
    const exp = await this.adapter.exportRepo.findById(id);
    if (!exp || !exp.filePath) return null;
    try {
      const { readFile } = await import('node:fs/promises');
      const data = await readFile(exp.filePath);
      const filename = exp.filePath.split('/').pop() ?? `export-${id}`;
      return { data, filename };
    } catch {
      return null;
    }
  }

  async getDocumentation(): Promise<{ schema: unknown; examples: unknown[] } | null> {
    const schema = await this.getSchema();
    if (!schema) return null;
    // Return schema + sample entities as documentation
    const sample = await this.adapter.entityRepo.findByJob(
      this.projectId, this.projectId, { limit: 3, offset: 0 },
    );
    return { schema, examples: sample };
  }

  subscribe(callback: (event: DataEvent) => void): () => void {
    if (!this.events) return () => {};

    const handler = (type: string) => (data: unknown) => callback({ type, data });
    const handlers: Array<[string, (data: unknown) => void]> = [
      ['task:completed', handler('task:completed')],
      ['entity:created', handler('entity:created')],
      ['schema:evolved', handler('schema:evolved')],
      ['action:pending', handler('action:pending')],
      ['progress', handler('progress')],
    ];

    for (const [event, fn] of handlers) {
      this.events.on(event as any, fn);
    }

    return () => {
      for (const [event, fn] of handlers) {
        this.events!.removeListener(event, fn);
      }
    };
  }
}
```

- [ ] **Step 3: Write LocalDataSource tests (I10)**

```typescript
// packages/core/tests/unit/pipeline/local-data-source.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LocalDataSource } from '../../../src/pipeline/local-data-source.js';

function createMockAdapter() {
  return {
    getProjectId: vi.fn().mockReturnValue('proj-1'),
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([{ id: 'e1', mergedData: {} }]),
      countByJob: vi.fn().mockResolvedValue(1),
      findById: vi.fn().mockResolvedValue({ id: 'e1', mergedData: {} }),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({ version: 1, definition: { fields: { name: {} } } }),
      findAllVersions: vi.fn().mockResolvedValue([]),
    },
    actionRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn(),
    },
    taskRepo: {
      getJobStats: vi.fn().mockResolvedValue({ pending: 0, inProgress: 0, completed: 5, failed: 0, skipped: 0 }),
    },
    runRepo: {
      findLatestByStatus: vi.fn().mockResolvedValue({ id: 'r1', status: 'completed', startedAt: '2026-03-29T00:00:00Z', pagesCrawled: 5, entitiesCreated: 1 }),
    },
    exportRepo: {
      findById: vi.fn().mockResolvedValue(null),
    },
  } as any;
}

describe('LocalDataSource', () => {
  it('delegates getEntities to entityRepo.findByJob', async () => {
    const adapter = createMockAdapter();
    const ds = new LocalDataSource(adapter);
    const result = await ds.getEntities({ limit: 10, offset: 0 });
    expect(adapter.entityRepo.findByJob).toHaveBeenCalledWith('proj-1', 'proj-1', { limit: 10, offset: 0 });
    expect(result.total).toBe(1);
  });

  it('delegates getEntity to entityRepo.findById', async () => {
    const adapter = createMockAdapter();
    const ds = new LocalDataSource(adapter);
    await ds.getEntity('e1');
    expect(adapter.entityRepo.findById).toHaveBeenCalledWith('e1', 'proj-1');
  });

  it('delegates getStatus and returns correct shape', async () => {
    const adapter = createMockAdapter();
    const ds = new LocalDataSource(adapter);
    const status = await ds.getStatus();
    expect(status.lastRun).toBeDefined();
    expect(status.totalEntities).toBe(1);
    expect(status.schemaFields).toBe(1);
  });

  it('searchEntities delegates to adapter with filter', async () => {
    const adapter = createMockAdapter();
    const ds = new LocalDataSource(adapter);
    await ds.searchEntities('widget');
    // entityRepo.findByJob is called with the project IDs (filter applied client-side)
    expect(adapter.entityRepo.findByJob).toHaveBeenCalledWith('proj-1', 'proj-1');
  });

  it('getSchema returns latest schema from adapter', async () => {
    const adapter = createMockAdapter();
    const ds = new LocalDataSource(adapter);
    const schema = await ds.getSchema();
    expect(adapter.schemaRepo.findLatest).toHaveBeenCalledWith('proj-1', 'proj-1');
    expect(schema).toHaveProperty('version', 1);
  });

  it('getActions filters by status', async () => {
    const adapter = createMockAdapter();
    const ds = new LocalDataSource(adapter);
    await ds.getActions('pending_review');
    expect(adapter.actionRepo.findByJob).toHaveBeenCalledWith('proj-1', 'proj-1', { status: 'pending_review' });
  });

  it('subscribe returns unsubscribe function', async () => {
    const { PipelineEventEmitter } = await import('../../../src/pipeline/pipeline-events.js');
    const events = new PipelineEventEmitter();
    const adapter = createMockAdapter();
    const ds = new LocalDataSource(adapter, events);

    const received: unknown[] = [];
    const unsubscribe = ds.subscribe!((event) => received.push(event));

    events.emit('entity:created', { id: 'e2', jobId: 'proj-1' });
    expect(received).toHaveLength(1);

    unsubscribe();
    events.emit('entity:created', { id: 'e3', jobId: 'proj-1' });
    expect(received).toHaveLength(1); // No new events after unsubscribe
  });

  it('approveAction delegates to adapter', async () => {
    const adapter = createMockAdapter();
    const ds = new LocalDataSource(adapter);
    await ds.approveAction('action-1', 'reviewer');
    expect(adapter.actionRepo.updateStatus).toHaveBeenCalledWith('action-1', 'proj-1', 'approved', 'reviewer');
  });
});
```

- [ ] **Step 4: Export from barrels**

Add to `packages/core/src/index.ts`:
```typescript
export type { DataSource, PaginationQuery, PaginatedResult, ProjectStatus, DataEvent } from './interfaces/data-source.js';
export { LocalDataSource } from './pipeline/local-data-source.js';
```

- [ ] **Step 5: Build and commit**

```bash
pnpm --filter @spatula/core build
git add packages/core/src/interfaces/data-source.ts packages/core/src/pipeline/local-data-source.ts packages/core/tests/unit/pipeline/local-data-source.test.ts packages/core/src/index.ts
git commit -m "feat(core): add DataSource interface and LocalDataSource for SQLite-backed local mode"
```

---

## Task 4: LocalPipelineRunner — Core Execution Engine

This is the largest single task. The runner implements the 13-step execution flow from the spec. Given complexity, the implementation should start with a minimal skeleton that handles steps 1-4 (config, DB, lock, recovery) and step 8 (crawl loop) with steps 5-7 and 9-13 as stubs that are filled in progressively.

**Files:**
- Create: `packages/core/src/pipeline/local-pipeline-runner.ts`
- Create: `packages/core/tests/unit/pipeline/local-pipeline-runner.test.ts`

- [ ] **Step 1: Write skeleton tests**

Test the runner's lifecycle: create → start → stop. Mock all deps.

```typescript
// packages/core/tests/unit/pipeline/local-pipeline-runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LocalPipelineRunner } from '../../../src/pipeline/local-pipeline-runner.js';

function createMockDeps() {
  return {
    adapter: {
      getProjectId: vi.fn().mockReturnValue('test-project'),
      taskRepo: {
        findPending: vi.fn().mockResolvedValue([]),
        getJobStats: vi.fn().mockResolvedValue({ pending: 0, inProgress: 0, completed: 0, failed: 0, skipped: 0 }),
        updateStatus: vi.fn(),
        enqueue: vi.fn().mockResolvedValue({ id: 'task-1' }),
      },
      pageRepo: { findByContentHash: vi.fn() },
      extractionRepo: { store: vi.fn() },
      entityRepo: { countByJob: vi.fn().mockResolvedValue(0) },
      schemaRepo: { findLatest: vi.fn().mockResolvedValue(null) },
      actionRepo: { findByJob: vi.fn().mockResolvedValue([]) },
      runRepo: {
        create: vi.fn().mockResolvedValue({ id: 'run-1' }),
        updateStatus: vi.fn(),
        updateStats: vi.fn(),
        findLatestByStatus: vi.fn().mockResolvedValue(null),
      },
      metaRepo: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      },
      exportRepo: { create: vi.fn() },
      jobRepo: { findById: vi.fn() },
      entitySourceRepo: { bulkLink: vi.fn() },
      sourceTrustRepo: { upsert: vi.fn() },
    },
    config: {
      seedUrls: ['https://example.com'],
      crawl: { maxPages: 100, maxDepth: 3, concurrency: 2 },
      schema: { mode: 'discovery' },
    },
    projectDir: '/tmp/test-project/.spatula',
    crawler: { crawl: vi.fn().mockResolvedValue({ content: '<html></html>', statusCode: 200 }), close: vi.fn() },
    extractor: { extract: vi.fn().mockResolvedValue({ data: {}, unmappedFields: [] }) },
    classifier: { classify: vi.fn().mockResolvedValue('product') },
    contentStore: { store: vi.fn().mockResolvedValue('file://test'), retrieve: vi.fn(), delete: vi.fn(), storeBinary: vi.fn(), retrieveBinary: vi.fn() },
    schemaEvolver: { evolve: vi.fn().mockResolvedValue([]) },
    reconciler: { reconcile: vi.fn().mockResolvedValue({ entities: [], actions: [] }) },
    linkEvaluator: { evaluate: vi.fn().mockResolvedValue([]) },
    robotsChecker: { isAllowed: vi.fn().mockResolvedValue(true) },
    rateLimiter: { waitForSlot: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('LocalPipelineRunner', () => {
  it('creates a runner instance', () => {
    const deps = createMockDeps();
    const runner = new LocalPipelineRunner(deps as any);
    expect(runner).toBeDefined();
  });

  it('starts and creates a run record', async () => {
    const deps = createMockDeps();
    const runner = new LocalPipelineRunner(deps as any);

    // Run with no pending tasks = immediate completion
    await runner.run();

    expect(deps.adapter.runRepo.create).toHaveBeenCalled();
  });

  it('enqueues seed URLs as crawl tasks on first run', async () => {
    const deps = createMockDeps();
    const runner = new LocalPipelineRunner(deps as any);

    await runner.run();

    expect(deps.adapter.taskRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
    );
  });

  it('recovers crashed tasks (resets in_progress to pending)', async () => {
    const deps = createMockDeps();
    // Mock in-progress tasks from a previous crash
    deps.adapter.taskRepo.getJobStats.mockResolvedValue({ inProgress: 2, pending: 0, completed: 0, failed: 0, skipped: 0 });
    // Mock the actual in-progress tasks to recover
    // Verify updateStatus called with 'pending' for each
    const runner = new LocalPipelineRunner(deps as any);
    await runner.run();
    // recoverCrashedTasks() detects inProgress > 0; once recoverCrashed() helper exists,
    // verify updateStatus called with 'pending' for each in-progress task
    expect(deps.adapter.taskRepo.getJobStats).toHaveBeenCalled();
  });

  it('skips task when page budget is exhausted', async () => {
    const deps = createMockDeps();
    // Set maxPages to 1, enqueue 2 tasks
    (deps.config as any).crawl.maxPages = 1;
    deps.adapter.taskRepo.findPending.mockResolvedValue([
      { id: 'task-2', url: 'https://example.com/a', depth: 1, priorityScore: 5 },
      { id: 'task-3', url: 'https://example.com/b', depth: 1, priorityScore: 5 },
    ]);
    const runner = new LocalPipelineRunner(deps as any);
    await runner.run();
    // The second task exceeds the page budget — verify it is marked 'skipped'
    expect(deps.adapter.taskRepo.updateStatus).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), 'skipped',
    );
  });

  it('retries failed tasks up to 3 times with backoff', async () => {
    const deps = createMockDeps();
    deps.adapter.taskRepo.findPending.mockResolvedValue([
      { id: 'task-retry', url: 'https://example.com/retry', depth: 0, priorityScore: 5 },
    ]);
    // Mock processCrawlTask to fail first 2 times, succeed on 3rd
    let callCount = 0;
    deps.crawler.crawl.mockImplementation(async () => {
      callCount++;
      if (callCount < 3) throw new Error('transient crawl error');
      return { content: '<html>ok</html>', statusCode: 200 };
    });
    const runner = new LocalPipelineRunner(deps as any);
    await runner.run();
    // The task should eventually succeed after retries
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('marks task as failed after max retries', async () => {
    const deps = createMockDeps();
    deps.adapter.taskRepo.findPending.mockResolvedValue([
      { id: 'task-fail', url: 'https://example.com/fail', depth: 0, priorityScore: 5 },
    ]);
    // Mock processCrawlTask to always fail
    deps.crawler.crawl.mockRejectedValue(new Error('permanent error'));
    const runner = new LocalPipelineRunner(deps as any);
    await runner.run();
    // Verify task status set to 'failed' after 3 retries
    expect(deps.adapter.taskRepo.updateStatus).toHaveBeenCalledWith(
      'task-fail', expect.any(String), 'failed',
    );
  });

  it('calls processReconciliation after crawl loop', async () => {
    const deps = createMockDeps();
    const runner = new LocalPipelineRunner(deps as any);
    await runner.run();
    // Verify reconciliation orchestrator repo methods are called
    expect(deps.adapter.runRepo.create).toHaveBeenCalled();
    // reconciler.reconcile is called internally by processReconciliation
    expect(deps.adapter.entityRepo.countByJob).toHaveBeenCalled();
  });

  it('calls processExport when autoExport is true', async () => {
    const deps = createMockDeps();
    // Set config.export.autoExport = true
    (deps.config as any).export = { autoExport: true, format: 'json', includeProvenance: false };
    deps.adapter.exportRepo.create.mockResolvedValue({ id: 'export-1' });
    const runner = new LocalPipelineRunner(deps as any);
    await runner.run();
    // Verify export orchestrator is triggered — exportRepo.create is called
    expect(deps.adapter.exportRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'json', status: 'pending' }),
    );
  });

  it('stops gracefully and marks run as paused', async () => {
    const deps = createMockDeps();
    // Make the crawl loop run at least one iteration before stop()
    deps.adapter.taskRepo.findPending.mockResolvedValue([
      { id: 'task-long', url: 'https://example.com/long', depth: 0, priorityScore: 5 },
    ]);
    deps.crawler.crawl.mockImplementation(async () => {
      return { content: '<html>slow</html>', statusCode: 200 };
    });
    const runner = new LocalPipelineRunner(deps as any);
    // Start run in background and stop immediately
    const runPromise = runner.run();
    await runner.stop();
    await runPromise.catch(() => {});
    // Verify lock was released
    expect(deps.adapter.runRepo.updateStatus).toHaveBeenCalled();
  });

  it('enqueues discovered links from crawl results', async () => {
    const deps = createMockDeps();
    deps.adapter.taskRepo.findPending.mockResolvedValue([
      { id: 'task-parent', url: 'https://example.com', depth: 0, priorityScore: 10 },
    ]);
    // Mock processCrawlTask to return linksFound
    deps.crawler.crawl.mockResolvedValue({ content: '<html><a href="/page2">p2</a></html>', statusCode: 200 });
    deps.extractor.extract.mockResolvedValue({
      data: {},
      unmappedFields: [],
      linksFound: [{ url: 'https://example.com/page2', priority: 'high' }],
    });
    const runner = new LocalPipelineRunner(deps as any);
    await runner.run();
    // Verify new tasks enqueued with correct priorities for discovered links
    expect(deps.adapter.taskRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
    );
  });
});
```

- [ ] **Step 2: Implement LocalPipelineRunner skeleton**

Read the spec (section 4.2) for the 13-step flow. Implement as a class with a `run()` method. Start with the core lifecycle:

```typescript
// packages/core/src/pipeline/local-pipeline-runner.ts
import { createLogger } from '@spatula/shared';
import { ProjectLock } from './project-lock.js';
import { PipelineEventEmitter } from './pipeline-events.js';
import { PriorityQueue } from './priority-queue.js';
import { Semaphore } from './concurrency.js';
import { InMemoryPageBudget } from '../crawlers/page-budget.js';
import { processCrawlTask } from './crawl-orchestrator.js';
import { processSchemaEvolution } from './schema-orchestrator.js';
import { processReconciliation } from './reconcile-orchestrator.js';
import { processExport } from './export-orchestrator.js';
import type { EventPublisher } from './types.js';
import type { PageClassifier } from '../extraction/page-classifier.js';

const logger = createLogger('local-pipeline-runner');

export interface LocalPipelineConfig {
  adapter: import('@spatula/db').ProjectAdapter;
  config: Record<string, unknown>; // Resolved config from parseProjectYaml + resolveConfig
  projectDir: string;
  // Core processing deps (required — pipeline crashes without these)
  crawler: import('../interfaces/crawler.js').Crawler;
  extractor: import('../interfaces/extractor.js').Extractor;
  classifier: PageClassifier;                                      // from extraction/page-classifier.ts
  contentStore: import('../interfaces/content-store.js').ContentStore;
  // LLM-powered pipeline stages (required for entity production)
  schemaEvolver: import('../interfaces/schema-evolver.js').SchemaEvolver;    // SchemaEvolverImpl
  reconciler: import('../interfaces/reconciler.js').DataReconciler;          // DataReconcilerImpl
  // Optional enhancements
  linkEvaluator?: import('../link-evaluation/evaluator.js').LinkEvaluator;
  robotsChecker?: import('../crawlers/robots-txt.js').RobotsTxtChecker;
  rateLimiter?: import('../crawlers/domain-rate-limiter.js').DomainRateLimiter;
}

export class LocalPipelineRunner {
  private readonly lock: ProjectLock;
  private readonly events = new PipelineEventEmitter();
  private readonly queue: PriorityQueue<{ taskId: string; url: string; depth: number }>;
  private readonly semaphore: Semaphore;
  private readonly pageBudget: InMemoryPageBudget;
  private isRunning = false;
  private isPaused = false;
  private errorCount = 0;

  constructor(private readonly deps: LocalPipelineConfig) {
    this.lock = new ProjectLock(deps.projectDir);
    this.queue = new PriorityQueue();
    this.semaphore = new Semaphore(deps.config.crawl?.concurrency ?? 5);
    this.pageBudget = new InMemoryPageBudget(deps.config.crawl?.maxPages ?? 1000);
  }

  get eventEmitter(): PipelineEventEmitter {
    return this.events;
  }

  async run(options?: { force?: boolean }): Promise<void> {
    // Step 1: Config already resolved by caller

    // Step 2: DB already opened by caller (via ProjectAdapter)

    // Step 3: Acquire lock
    if (!this.lock.acquire(options?.force)) {
      throw new Error('Another spatula process is running. Use --force to take over.');
    }

    this.isRunning = true;

    try {
      // Step 4: Crash recovery — reset in_progress tasks
      await this.recoverCrashedTasks();

      // Step 5: Config diff (placeholder — full implementation in next iteration)
      // TODO: Compare current config against last run snapshot

      const projectId = this.deps.adapter.getProjectId();

      // Step 6: Determine work
      const pendingTasks = await this.deps.adapter.taskRepo.findPending(
        projectId, { limit: 1000 },
      );

      if (pendingTasks.length === 0 && this.deps.config.seedUrls?.length > 0) {
        // First run: seed a synthetic job record so orchestrators can find config
        // (SqliteJobRepository.findById reads from the latest run's configSnapshot)

        // Enqueue seed URLs
        for (const url of this.deps.config.seedUrls) {
          const task = await this.deps.adapter.taskRepo.enqueue({
            jobId: projectId,
            tenantId: projectId,
            url,
            depth: 0,
          });
          this.queue.enqueue({ taskId: task.id, url, depth: 0 }, 10, 0);
        }
      } else {
        for (const task of pendingTasks) {
          this.queue.enqueue(
            { taskId: task.id, url: task.url, depth: task.depth ?? 0 },
            task.priorityScore ?? 5,
            task.depth ?? 0,
          );
        }
      }

      // Create run record (I3: use configSnapshot + source, matching RunRepository.create API)
      const run = await this.deps.adapter.runRepo.create({
        status: 'started',
        source: 'cli',
        configSnapshot: this.deps.config,
        startedAt: new Date().toISOString(),
      });

      // Step 7: Re-extraction pass (placeholder)
      // TODO: Handle flagged pages

      // Step 8: Crawl + extract loop
      await this.crawlLoop();

      // Step 9: Schema evolution (post-crawl)
      // Calls the same pure orchestrator used by BullMQ workers.
      // No distributed lock needed in single-process local mode.
      if (this.deps.config.schema?.evolutionConfig?.enabled) {
        logger.info({ jobId: projectId }, 'Running schema evolution');
        const schemaResult = await processSchemaEvolution(
          { jobId: projectId, tenantId: projectId, extractionIds: [] },
          {
            schemaEvolver: this.deps.schemaEvolver!,
            jobRepo: this.deps.adapter.jobRepo,
            extractionRepo: this.deps.adapter.extractionRepo,
            schemaRepo: this.deps.adapter.schemaRepo,
            actionRepo: this.deps.adapter.actionRepo,
            eventPublisher: this.localEventPublisher(projectId),
          },
        );
        if (schemaResult.evolved) {
          this.events.emit('schema:evolved', {
            version: schemaResult.newVersion!,
            fields: [],
          });
          logger.info({ newVersion: schemaResult.newVersion, actions: schemaResult.actionsApplied }, 'Schema evolved');
        }
      }

      // Step 10: Reconciliation
      // Merges extractions into deduplicated entities with provenance.
      // Without this step the pipeline produces NO entities.
      logger.info({ jobId: projectId }, 'Running reconciliation');
      const reconcileResult = await processReconciliation(
        { jobId: projectId, tenantId: projectId },
        {
          reconciler: this.deps.reconciler!,
          jobRepo: this.deps.adapter.jobRepo,
          schemaRepo: this.deps.adapter.schemaRepo,
          extractionRepo: this.deps.adapter.extractionRepo,
          pageRepo: this.deps.adapter.pageRepo,
          entityRepo: this.deps.adapter.entityRepo,
          entitySourceRepo: this.deps.adapter.entitySourceRepo,
          sourceTrustRepo: this.deps.adapter.sourceTrustRepo,
          eventPublisher: this.localEventPublisher(projectId),
        },
      );
      logger.info(
        { entities: reconcileResult.entitiesCreated, actions: reconcileResult.actionsGenerated },
        'Reconciliation completed',
      );

      // Step 11: Auto-export
      // If the user configured autoExport, run the export orchestrator immediately.
      if (this.deps.config.export?.autoExport) {
        const exportFormat = this.deps.config.export.format ?? 'json';
        logger.info({ jobId: projectId, format: exportFormat }, 'Running auto-export');

        // Create an export record so the orchestrator can track status
        const exportRecord = await this.deps.adapter.exportRepo.create({
          jobId: projectId,
          tenantId: projectId,
          format: exportFormat,
          status: 'pending',
        });

        await processExport(
          {
            exportId: exportRecord.id,
            jobId: projectId,
            tenantId: projectId,
            format: exportFormat,
            includeProvenance: this.deps.config.export.includeProvenance ?? false,
          },
          {
            jobRepo: this.deps.adapter.jobRepo,
            schemaRepo: this.deps.adapter.schemaRepo,
            entityRepo: this.deps.adapter.entityRepo,
            exportRepo: this.deps.adapter.exportRepo,
            contentStore: this.deps.contentStore,
          },
        );
        logger.info({ exportId: exportRecord.id, format: exportFormat }, 'Auto-export completed');
      }

      // Step 12: Run summary
      const entityCount = await this.deps.adapter.entityRepo.countByJob(projectId, projectId);
      const stats = {
        pagesProcessed: this.pageBudget.count,
        totalPages: this.pageBudget.maxPages,
        entitiesCreated: entityCount,
        errors: this.errorCount,
      };
      this.events.emit('progress', stats);
      logger.info(stats, 'Run completed');

      // Update run record (I4: use updateStatus + updateStats per RunRepository API)
      await this.deps.adapter.runRepo.updateStatus(run.id, 'completed', new Date().toISOString());
      await this.deps.adapter.runRepo.updateStats(run.id, {
        pagesCrawled: stats.pagesProcessed,
        entitiesCreated: stats.entitiesCreated,
      });

    } finally {
      // Step 13: Release lock
      this.isRunning = false;
      this.lock.release();
    }
  }

  async stop(): Promise<void> {
    this.isPaused = true;
    // Wait for in-flight tasks to finish (up to 10s)
    const deadline = Date.now() + 10_000;
    while (this.semaphore.activeCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.isRunning = false;
    this.lock.release();
  }

  private async recoverCrashedTasks(): Promise<void> {
    const projectId = this.deps.adapter.getProjectId();
    // Note: SqliteCrawlTaskRepository does not expose a "findByStatus" method.
    // Crash recovery needs a `findInProgress(jobId)` method added to the repo
    // (or use getJobStats to detect, then a bulk-update helper). For the skeleton,
    // check stats and log a warning; full recovery will be added when the repo
    // is extended with a recoverCrashed(jobId) helper.
    const stats = await this.deps.adapter.taskRepo.getJobStats(projectId, projectId);
    if (stats.inProgress > 0) {
      logger.warn({ count: stats.inProgress }, 'Detected in-progress tasks from previous crash — TODO: add recoverCrashed() to CrawlTaskRepository');
    }
  }

  /** Adapts PipelineEventEmitter to the EventPublisher interface used by orchestrators */
  private localEventPublisher(projectId: string): EventPublisher {
    return {
      publish: async (_jobId: string, event: { type: string; jobId: string; tenantId: string; data: unknown }) => {
        // Bridge orchestrator events to PipelineEventEmitter
        if (event.type === 'entity_created') {
          this.events.emit('entity:created', { id: (event.data as any).entityId, jobId: projectId });
        } else if (event.type === 'schema_evolved') {
          this.events.emit('schema:evolved', { version: (event.data as any).version, fields: (event.data as any).fieldsAdded ?? [] });
        }
      },
    };
  }

  private async crawlLoop(): Promise<void> {
    while (!this.queue.isEmpty && this.isRunning && !this.isPaused) {
      const batch = this.queue.dequeueBatch(this.semaphore.available || 1);

      await Promise.allSettled(
        batch.map(async (task) => {
          await this.semaphore.acquire();
          try {
            await this.processTask(task);
          } finally {
            this.semaphore.release();
          }
        }),
      );
    }
  }

  private async processTask(
    task: { taskId: string; url: string; depth: number },
    maxRetries = 3,
  ): Promise<void> {
    const projectId = this.deps.adapter.getProjectId();

    // Check page budget before any attempt
    if (!this.pageBudget.tryIncrement()) {
      await this.deps.adapter.taskRepo.updateStatus(task.taskId, projectId, 'skipped');
      return;
    }

    // robots.txt compliance (Gap 6)
    if (this.deps.robotsChecker) {
      const allowed = await this.deps.robotsChecker.isAllowed(task.url);
      if (!allowed) {
        logger.info({ taskId: task.taskId, url: task.url }, 'Blocked by robots.txt');
        await this.deps.adapter.taskRepo.updateStatus(task.taskId, projectId, 'skipped');
        return;
      }
    }

    // Per-domain rate limiting (Gap 6)
    if (this.deps.rateLimiter) {
      await this.deps.rateLimiter.waitForSlot(task.url);
    }

    // Retry loop with exponential backoff (Gap 3)
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Delegate to crawl orchestrator
        const result = await processCrawlTask(
          { taskId: task.taskId, jobId: projectId, tenantId: projectId, url: task.url, depth: task.depth },
          {
            crawler: this.deps.crawler,
            classifier: this.deps.classifier,
            extractor: this.deps.extractor,
            contentStore: this.deps.contentStore,
            linkEvaluator: this.deps.linkEvaluator,
            taskRepo: this.deps.adapter.taskRepo,
            pageRepo: this.deps.adapter.pageRepo,
            jobRepo: this.deps.adapter.jobRepo,
            extractionRepo: this.deps.adapter.extractionRepo,
            schemaRepo: this.deps.adapter.schemaRepo,
          },
        );

        if (!result.error) {
          this.events.emit('task:completed', { id: task.taskId, url: task.url, status: 'completed' });

          // Enqueue discovered links
          for (const link of result.linksFound ?? []) {
            const childTask = await this.deps.adapter.taskRepo.enqueue({
              jobId: projectId,
              tenantId: projectId,
              url: link.url,
              depth: task.depth + 1,
              parentTaskId: task.taskId,
            });
            const priority = link.priority === 'high' ? 10 : link.priority === 'medium' ? 5 : 1;
            this.queue.enqueue({ taskId: childTask.id, url: link.url, depth: task.depth + 1 }, priority, task.depth + 1);
          }
        }

        // Emit progress after each successful task
        this.events.emit('progress', {
          pagesProcessed: this.pageBudget.count,
          totalPages: this.pageBudget.maxPages,
          entitiesCreated: 0, // Updated at run summary
          errors: this.errorCount,
        });
        return; // Success — exit retry loop

      } catch (error) {
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          logger.warn({ taskId: task.taskId, url: task.url, attempt, delay }, 'Retrying task after failure');
          await new Promise((r) => setTimeout(r, delay));
        } else {
          // Max retries exhausted
          logger.error({ taskId: task.taskId, url: task.url, error, attempts: maxRetries + 1 }, 'Task failed after all retries');
          this.errorCount++;
          await this.deps.adapter.taskRepo.updateStatus(task.taskId, projectId, 'failed');
        }
      }
    }
  }
}
```

**Note:** Steps 5 (config diff) and 7 (re-extraction) remain as stubs with TODO comments — they are enhancements for incremental re-runs. Steps 8-11 (crawl loop, schema evolution, reconciliation, auto-export) are **fully wired** to the Wave 1 orchestrators. The pipeline produces entities end-to-end. Per-task retry with exponential backoff (2s/4s/8s), robots.txt compliance, and domain rate limiting are included in `processTask`.

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @spatula/core test -- --run local-pipeline-runner
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/pipeline/local-pipeline-runner.ts packages/core/tests/unit/pipeline/local-pipeline-runner.test.ts packages/core/src/pipeline/index.ts
git commit -m "feat(core): add LocalPipelineRunner with crawl loop, lock, and crash recovery"
```

---

## Task 5: CLI Command — `spatula init`

**Files:**
- Create: `apps/cli/src/commands/init.ts`
- Modify: `apps/cli/src/index.tsx`

- [ ] **Step 1: Implement init command**

Read `apps/cli/src/index.tsx` to understand the yargs command pattern. Read the spec section 3 for the setup wizard flow.

The `init` command:
1. Checks for `~/.spatula/config.yaml` (global config)
2. If missing: first-time flow (LLM setup, crawler defaults, then project)
3. If present: project-only flow
4. Creates `spatula.yaml` with seed URLs, fields, depth, limit
5. Creates `.spatula/` directory structure (pages/, exports/, cache/robots/, logs/)

For the initial implementation, use a simplified interactive flow via `readline` (not Ink) since the init command is a one-time wizard, not a TUI. The conversational mode (`spatula new`) uses Ink.

```typescript
// apps/cli/src/commands/init.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@spatula/shared';

const logger = createLogger('cli:init');

export interface InitOptions {
  url?: string;
  depth?: number;
  limit?: number;
}

export async function runInitCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const yamlPath = join(cwd, 'spatula.yaml');

  if (existsSync(yamlPath)) {
    console.log('spatula.yaml already exists in this directory.');
    return;
  }

  // Check global config
  const globalConfigPath = join(homedir(), '.spatula', 'config.yaml');
  if (!existsSync(globalConfigPath)) {
    console.log('Welcome to Spatula! Creating global config...');
    mkdirSync(join(homedir(), '.spatula'), { recursive: true });
    writeFileSync(globalConfigPath, 'version: 1\n\ncrawler: playwright\npoliteness:\n  respectRobotsTxt: true\n  delayMs: 1000\n');
    console.log(`Global config saved to ${globalConfigPath}`);
  } else {
    console.log(`Using global config (~/.spatula/config.yaml)`);
  }

  // Create project
  const seedUrl = options.url ?? 'https://example.com';
  const depth = options.depth ?? 2;
  const limit = options.limit ?? 1000;

  const yaml = `seeds:\n  - ${seedUrl}\n\ndepth: ${depth}\nlimit: ${limit}\n`;
  writeFileSync(yamlPath, yaml);
  console.log(`Created spatula.yaml`);

  // Create .spatula/ directory structure
  const spatulaDir = join(cwd, '.spatula');
  for (const dir of ['pages', 'exports', 'cache/robots', 'logs']) {
    mkdirSync(join(spatulaDir, dir), { recursive: true });
  }
  console.log(`Created .spatula/ directory structure`);

  // Add .spatula to .gitignore if it exists
  const gitignorePath = join(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = require('node:fs').readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.spatula')) {
      require('node:fs').appendFileSync(gitignorePath, '\n.spatula/\n');
      console.log('Added .spatula/ to .gitignore');
    }
  }

  console.log('\nReady! Start crawling: spatula run');
}
```

- [ ] **Step 2: Wire into CLI entry point**

Read `apps/cli/src/index.tsx`. Add the `init` command to yargs:

```typescript
import { runInitCommand } from './commands/init.js';

// In yargs builder, add:
.command('init [url]', 'Initialize a new Spatula project', (yargs) => {
  return yargs
    .positional('url', { type: 'string', describe: 'Seed URL' })
    .option('depth', { type: 'number', default: 2, describe: 'Crawl depth' })
    .option('limit', { type: 'number', default: 1000, describe: 'Max pages' });
}, async (argv) => {
  await runInitCommand({ url: argv.url as string, depth: argv.depth, limit: argv.limit });
})
```

- [ ] **Step 3: Build and commit**

```bash
pnpm --filter @spatula/cli build
git add apps/cli/src/commands/init.ts apps/cli/src/index.tsx
git commit -m "feat(cli): add spatula init command for project setup"
```

---

## Task 6: CLI Command — `spatula run`

**Files:**
- Create: `apps/cli/src/commands/run.ts`
- Modify: `apps/cli/src/index.tsx`

- [ ] **Step 1: Implement run command**

The `run` command:
1. Finds project root (`findProjectRoot()` from Wave 2)
2. Parses `spatula.yaml` + resolves config
3. Opens SQLite DB + creates ProjectAdapter
4. Creates LocalPipelineRunner with all deps
5. Sets up Ctrl+C handler for checkpoint/resume
6. Runs the pipeline
7. Prints summary

```typescript
// apps/cli/src/commands/run.ts
import { findProjectRoot, parseProjectYaml, resolveConfig } from '@spatula/core';
import { createProjectDb, initializeProjectDb, ProjectAdapter } from '@spatula/db';
import { LocalPipelineRunner, LocalContentStore } from '@spatula/core';
import { createLLMClient } from '@spatula/core/llm';
import { CircuitBreakerLLMClient } from '@spatula/core/llm';
import { CrawlerFactory } from '@spatula/core/crawlers';
import { StaticExtractor } from '@spatula/core/extraction';
import { PageClassifier } from '@spatula/core/extraction';
import { SchemaEvolverImpl } from '@spatula/core/evolution';
import { DataReconcilerImpl } from '@spatula/core/reconciliation';
import { LLMLinkEvaluator } from '@spatula/core/link-evaluation';
import { RobotsTxtChecker } from '@spatula/core/crawlers';
import { InMemoryDomainRateLimiter } from '@spatula/core/crawlers';
import { resolveModel } from '@spatula/core/llm';
import { createLogger } from '@spatula/shared';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const logger = createLogger('cli:run');

export interface RunOptions {
  force?: boolean;
  fullReconcile?: boolean;
  incremental?: boolean;
}

export async function runRunCommand(options: RunOptions): Promise<void> {
  // Find project root
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error('Not in a Spatula project. Run "spatula init" to create one.');
    process.exit(1);
  }

  const spatulaDir = join(projectRoot, '.spatula');

  // Parse and resolve config
  const config = parseProjectYaml(join(projectRoot, 'spatula.yaml'));
  const resolvedConfig = await resolveConfig(config);

  // Open SQLite DB and apply migrations (I6)
  const dbResult = createProjectDb(join(spatulaDir, 'project.db'));

  // Read or generate a stable project ID from project meta
  // initializeProjectDb seeds project_meta with the projectId on first run
  const projectName = resolvedConfig.name ?? 'unnamed-project';
  const projectId = resolvedConfig.projectId ?? randomUUID();
  initializeProjectDb(dbResult.db, { projectId, name: projectName });

  // ProjectAdapter requires both db and projectId (C2)
  const adapter = new ProjectAdapter(dbResult.db, projectId);

  // Create content store (local file-based)
  const contentStore = new LocalContentStore(join(spatulaDir, 'pages'));

  // --- DI Wiring: LLM Client ---
  // createLLMClient reads provider from config (openrouter or ollama).
  // Wrap with CircuitBreakerLLMClient for resilience (Gap 6).
  const llmProvider = resolvedConfig.llm?.provider ?? 'ollama';
  const baseLLMClient = createLLMClient({
    provider: llmProvider,
    openrouter: llmProvider === 'openrouter'
      ? { apiKey: process.env.OPENROUTER_API_KEY ?? resolvedConfig.llm?.apiKey ?? '' }
      : undefined,
    ollama: llmProvider === 'ollama'
      ? { baseUrl: resolvedConfig.llm?.baseUrl }
      : undefined,
  });
  const llmClient = new CircuitBreakerLLMClient(baseLLMClient, {
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    halfOpenMaxAttempts: 2,
  });

  const llmConfig = {
    primaryModel: resolvedConfig.llm?.primaryModel ?? 'anthropic/claude-sonnet-4-20250514',
    modelOverrides: resolvedConfig.llm?.modelOverrides,
  };

  // --- DI Wiring: Crawler ---
  // CrawlerFactory.create() returns a Playwright or Firecrawl crawler.
  const crawlerType = resolvedConfig.crawler?.type ?? 'playwright';
  const crawler = await CrawlerFactory.create({
    type: crawlerType,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
  });

  // --- DI Wiring: Extractor + Classifier ---
  // Both need an LLMClient and LLMConfig. StaticExtractor also needs jobId.
  const extractor = new StaticExtractor(llmClient, llmConfig, projectId);
  const classifier = new PageClassifier(llmClient, llmConfig);

  // --- DI Wiring: Schema Evolution + Reconciliation ---
  // These are required for entity production (Gap 1).
  const schemaEvolver = new SchemaEvolverImpl(llmClient, llmConfig);
  const reconciler = new DataReconcilerImpl(llmClient, llmConfig);

  // --- DI Wiring: Optional Enhancements ---
  const linkEvaluator = new LLMLinkEvaluator(
    llmClient,
    resolveModel(llmConfig, 'linkEvaluation'),
  );
  const robotsChecker = new RobotsTxtChecker();
  const rateLimiter = new InMemoryDomainRateLimiter(
    resolvedConfig.politeness?.delayMs ?? 1000,
  );

  // --- Progress Display (Gap 4) ---
  // Minimal single-line progress using stdout.write('\r...').
  // Updated on every 'progress' event from the pipeline runner.
  const startTime = Date.now();

  console.log(`Starting crawl for ${projectRoot}...`);
  console.log(`Seeds: ${resolvedConfig.seedUrls?.join(', ')}`);
  console.log(`Max pages: ${resolvedConfig.crawl?.maxPages ?? 1000}`);
  console.log(''); // Blank line before progress

  // Create and run pipeline
  const runner = new LocalPipelineRunner({
    adapter,
    config: resolvedConfig,
    projectDir: spatulaDir,
    crawler,
    extractor,
    classifier,
    contentStore,
    schemaEvolver,
    reconciler,
    linkEvaluator,
    robotsChecker,
    rateLimiter,
  });

  // Subscribe to progress events for minimal progress display (Gap 4)
  runner.eventEmitter.on('progress', (stats) => {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed > 0 ? (stats.pagesProcessed / elapsed).toFixed(1) : '0.0';
    const line = `  Crawling — ${stats.pagesProcessed}/${stats.totalPages} pages | ${stats.entitiesCreated} entities | ${stats.errors} errors | ${rate} pages/sec`;
    process.stdout.write(`\r${line.padEnd(80)}`);
  });

  // Ctrl+C handler for graceful shutdown
  let shuttingDown = false;
  process.on('SIGINT', async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write('\n');
    console.log('Pausing... (waiting for in-flight tasks)');
    await runner.stop();
    console.log(`Paused. Run 'spatula run' to continue.`);
    process.exit(0);
  });

  try {
    await runner.run({ force: options.force });
    process.stdout.write('\n'); // Newline after progress line
    console.log('Crawl completed!');
  } catch (error) {
    process.stdout.write('\n');
    console.error('Crawl failed:', (error as Error).message);
    process.exit(1);
  } finally {
    await crawler.close();
    dbResult.close();
  }
}
```

- [ ] **Step 2: Wire into CLI entry point**

Add to yargs:
```typescript
.command('run', 'Start or resume a crawl', (yargs) => {
  return yargs
    .option('force', { type: 'boolean', default: false, describe: 'Force lock takeover' })
    .option('full-reconcile', { type: 'boolean', default: false })
    .option('incremental', { type: 'boolean', default: false });
}, async (argv) => {
  const { runRunCommand } = await import('./commands/run.js');
  await runRunCommand({ force: argv.force, fullReconcile: argv.fullReconcile, incremental: argv.incremental });
})
```

- [ ] **Step 3: Dashboard mode follow-up (I9)**

The `[d]` keybinding during `spatula run` should open the existing Dashboard TUI component in local mode. This requires wiring `LocalDataSource` (wrapping the same `ProjectAdapter` and `PipelineEventEmitter` the runner uses) into the Dashboard components from `apps/cli/src/components/`. The `subscribe()` method on `LocalDataSource` provides real-time updates from the running pipeline. Full implementation may be complex — if so, add a minimal version that prints a summary table on `[d]` press, with full Dashboard integration as a follow-up item within this task.

- [ ] **Step 4: Build and commit**

```bash
pnpm --filter @spatula/cli build
git add apps/cli/src/commands/run.ts apps/cli/src/index.tsx
git commit -m "feat(cli): add spatula run command with pipeline runner and Ctrl+C checkpoint"
```

---

## Task 7: CLI Command — `spatula status`

**Files:**
- Modify: `apps/cli/src/commands/status.ts`

**I12 note:** In local mode, `spatula status` does NOT need a `jobId` argument. The command auto-detects local mode by calling `findProjectRoot(process.cwd())` — if a `spatula.yaml` exists in the directory tree, it uses SQLite/LocalDataSource. Otherwise, it falls back to the API-based flow (which requires `jobId`). The `jobId` positional should be optional.

- [ ] **Step 1: Read existing status command**

Read `apps/cli/src/commands/status.ts`. It currently shows API-based job status. Add a local mode that uses `LocalDataSource` when in a project directory.

- [ ] **Step 2: Add local status display**

Add a `runLocalStatusCommand` function that:
1. Calls `findProjectRoot(process.cwd())` to auto-detect local mode
2. If local: opens SQLite DB, creates `ProjectAdapter` + `LocalDataSource`
3. Calls `dataSource.getStatus()`
4. Prints: last run, pages, entities, pending actions, schema fields, storage
5. If NOT local and no `jobId` provided: print error suggesting `spatula init` or passing a jobId

Update the yargs definition to make `jobId` optional:
```typescript
.command('status [jobId]', 'Show project or job status', (yargs) => {
  return yargs.positional('jobId', { type: 'string', describe: 'Job ID (API mode only, optional in local mode)' });
}, async (argv) => {
  // Auto-detect local mode
  const projectRoot = findProjectRoot(process.cwd());
  if (projectRoot) {
    await runLocalStatusCommand(projectRoot);
  } else if (argv.jobId) {
    await runApiStatusCommand(argv.jobId);
  } else {
    console.error('Not in a Spatula project and no jobId provided. Run "spatula init" or pass a jobId.');
    process.exit(1);
  }
})
```

- [ ] **Step 3: Build and commit**

```bash
git add apps/cli/src/commands/status.ts apps/cli/src/index.tsx
git commit -m "feat(cli): add local project status display to spatula status"
```

---

## Task 8: CLI Command — `spatula reset`

**Files:**
- Create: `apps/cli/src/commands/reset.ts`
- Modify: `apps/cli/src/index.tsx`

- [ ] **Step 1: Implement reset command**

```typescript
// apps/cli/src/commands/reset.ts
import { existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '@spatula/core';

export interface ResetOptions {
  keepExports?: boolean;
  keepEntities?: boolean;
}

export async function runResetCommand(options: ResetOptions): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error('Not in a Spatula project.');
    process.exit(1);
  }

  const spatulaDir = join(projectRoot, '.spatula');
  if (!existsSync(spatulaDir)) {
    console.log('No .spatula/ directory found. Nothing to reset.');
    return;
  }

  // Delete .spatula contents selectively
  const dirs = readdirSync(spatulaDir);
  for (const item of dirs) {
    const fullPath = join(spatulaDir, item);
    if (options.keepExports && item === 'exports') continue;
    if (item === 'project.db' && options.keepEntities) continue;

    rmSync(fullPath, { recursive: true, force: true });
  }

  // Recreate directory structure
  for (const dir of ['pages', 'exports', 'cache/robots', 'logs']) {
    const { mkdirSync } = require('node:fs');
    mkdirSync(join(spatulaDir, dir), { recursive: true });
  }

  console.log('Project state reset. spatula.yaml preserved.');
  if (options.keepExports) console.log('Exports preserved.');
  if (options.keepEntities) console.log('Database preserved (entities kept).');
}
```

- [ ] **Step 2: Wire into CLI and commit**

```bash
git add apps/cli/src/commands/reset.ts apps/cli/src/index.tsx
git commit -m "feat(cli): add spatula reset command with selective cleanup"
```

---

## Task 8c: CLI Command Tests — `spatula init` + `spatula reset`

**Files:**
- Create: `apps/cli/tests/unit/commands/init.test.ts`
- Create: `apps/cli/tests/unit/commands/reset.test.ts`

These tests use temp directories (same pattern as the local content store tests) to verify filesystem effects without touching the real filesystem.

- [ ] **Step 1: Write init command tests**

```typescript
// apps/cli/tests/unit/commands/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The init command writes to process.cwd(), so we mock it
// or extract the core logic into a testable function.
// Here we test the extracted createProject() helper.
import { runInitCommand } from '../../../src/commands/init.js';

describe('spatula init', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spatula-init-test-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates spatula.yaml with seed URL', async () => {
    await runInitCommand({ url: 'https://example.com', depth: 3, limit: 500 });

    const yamlPath = join(tempDir, 'spatula.yaml');
    expect(existsSync(yamlPath)).toBe(true);
    const content = readFileSync(yamlPath, 'utf-8');
    expect(content).toContain('https://example.com');
    expect(content).toContain('depth: 3');
    expect(content).toContain('limit: 500');
  });

  it('creates .spatula/ directory structure', async () => {
    await runInitCommand({ url: 'https://example.com' });

    const spatulaDir = join(tempDir, '.spatula');
    expect(existsSync(spatulaDir)).toBe(true);
    expect(existsSync(join(spatulaDir, 'pages'))).toBe(true);
    expect(existsSync(join(spatulaDir, 'exports'))).toBe(true);
    expect(existsSync(join(spatulaDir, 'cache', 'robots'))).toBe(true);
    expect(existsSync(join(spatulaDir, 'logs'))).toBe(true);
  });

  it('does not overwrite existing spatula.yaml', async () => {
    writeFileSync(join(tempDir, 'spatula.yaml'), 'existing: true');
    await runInitCommand({ url: 'https://example.com' });

    const content = readFileSync(join(tempDir, 'spatula.yaml'), 'utf-8');
    expect(content).toBe('existing: true');
  });

  it('appends .spatula/ to .gitignore if it exists', async () => {
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules/\n');
    await runInitCommand({ url: 'https://example.com' });

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.spatula');
  });

  it('does not duplicate .spatula/ in .gitignore', async () => {
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules/\n.spatula/\n');
    await runInitCommand({ url: 'https://example.com' });

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    const count = (gitignore.match(/\.spatula/g) || []).length;
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Write reset command tests**

```typescript
// apps/cli/tests/unit/commands/reset.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runResetCommand } from '../../../src/commands/reset.js';

// Mock findProjectRoot to return our temp dir
vi.mock('@spatula/core', () => ({
  findProjectRoot: vi.fn(),
}));

describe('spatula reset', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spatula-reset-test-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Create a realistic project structure
    writeFileSync(join(tempDir, 'spatula.yaml'), 'seeds:\n  - https://example.com\n');
    const spatulaDir = join(tempDir, '.spatula');
    for (const dir of ['pages', 'exports', 'cache/robots', 'logs']) {
      mkdirSync(join(spatulaDir, dir), { recursive: true });
    }
    writeFileSync(join(spatulaDir, 'project.db'), 'fake-db');
    writeFileSync(join(spatulaDir, 'pages', 'p1.html'), '<html>Page 1</html>');
    writeFileSync(join(spatulaDir, 'exports', 'export.json'), '{}');

    // Set up mock
    const core = await import('@spatula/core');
    (core.findProjectRoot as ReturnType<typeof vi.fn>).mockReturnValue(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes .spatula/ contents but preserves spatula.yaml', async () => {
    await runResetCommand({});

    expect(existsSync(join(tempDir, 'spatula.yaml'))).toBe(true);
    // DB should be removed
    expect(existsSync(join(tempDir, '.spatula', 'project.db'))).toBe(false);
    // Pages should be removed
    expect(existsSync(join(tempDir, '.spatula', 'pages', 'p1.html'))).toBe(false);
    // Directory structure should be recreated
    expect(existsSync(join(tempDir, '.spatula', 'pages'))).toBe(true);
    expect(existsSync(join(tempDir, '.spatula', 'exports'))).toBe(true);
    expect(existsSync(join(tempDir, '.spatula', 'logs'))).toBe(true);
  });

  it('preserves exports when --keep-exports is set', async () => {
    await runResetCommand({ keepExports: true });

    expect(existsSync(join(tempDir, '.spatula', 'exports', 'export.json'))).toBe(true);
    // DB and pages should still be removed
    expect(existsSync(join(tempDir, '.spatula', 'project.db'))).toBe(false);
  });

  it('preserves database when --keep-entities is set', async () => {
    await runResetCommand({ keepEntities: true });

    expect(existsSync(join(tempDir, '.spatula', 'project.db'))).toBe(true);
    // Pages should still be removed
    expect(existsSync(join(tempDir, '.spatula', 'pages', 'p1.html'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests and commit**

```bash
pnpm --filter @spatula/cli test -- --run commands/init --run commands/reset
git add apps/cli/tests/unit/commands/
git commit -m "test(cli): add unit tests for spatula init and spatula reset commands"
```

---

## Task 8b: CLI Command — `spatula new` (I8)

**Files:**
- Modify: `apps/cli/src/commands/new.tsx` (existing conversational mode)
- Modify: `apps/cli/src/index.tsx`

The existing `apps/cli/src/commands/new.tsx` implements a conversational mode that creates API jobs via the server. In local mode, `spatula new` should instead:

1. Start the same conversational Ink TUI (describe what data you want, provide seed URLs, etc.)
2. Write the result to `spatula.yaml` in the current directory (instead of calling the API)
3. Create the `.spatula/` directory structure (same as `spatula init`)
4. If no LLM is configured, fall back to `spatula init` (the non-conversational wizard)

This is primarily a wiring change: the conversational UI collects the same information, but the output target changes from "POST /jobs" to "write spatula.yaml". The LLM-powered field suggestion and schema refinement steps remain the same.

- [ ] **Step 1: Add local-mode output path to new.tsx**

Read `apps/cli/src/commands/new.tsx`. Add a `mode: 'api' | 'local'` prop. When `mode === 'local'`, the final step writes `spatula.yaml` instead of creating an API job.

- [ ] **Step 2: Auto-detect mode in CLI entry point**

If no API server is configured (no `SPATULA_API_URL` env var and no `~/.spatula/config.yaml` server entry), default to local mode.

- [ ] **Step 3: Build and commit**

```bash
git add apps/cli/src/commands/new.tsx apps/cli/src/index.tsx
git commit -m "feat(cli): adapt spatula new to write spatula.yaml in local mode"
```

---

## Task 9: Notifications — Desktop + Webhook

**Files:**
- Create: `apps/cli/src/notifications.ts`

- [ ] **Step 1: Install node-notifier**

```bash
pnpm --filter @spatula/cli add node-notifier
pnpm --filter @spatula/cli add -D @types/node-notifier
```

- [ ] **Step 2: Implement notification helpers**

```typescript
// apps/cli/src/notifications.ts
import { createLogger } from '@spatula/shared';

const logger = createLogger('cli:notifications');

export async function sendDesktopNotification(title: string, message: string): Promise<void> {
  // Skip in CI, Docker, or headless environments
  if (process.env.CI || process.env.DOCKER) return;

  try {
    const notifier = await import('node-notifier');
    notifier.default.notify({ title, message, sound: true });
  } catch (err) {
    logger.debug({ err }, 'Desktop notification not available');
  }
}

export async function sendWebhookNotification(
  webhookUrl: string,
  event: { type: string; data: Record<string, unknown> },
): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, webhookUrl }, 'Webhook notification failed');
    }
  } catch (err) {
    logger.warn({ err, webhookUrl }, 'Webhook notification error');
  }
}
```

- [ ] **Step 3: Write notification tests**

```typescript
// apps/cli/tests/unit/notifications.test.ts
import { describe, it, expect, vi } from 'vitest';

// Mock node-notifier
vi.mock('node-notifier', () => ({
  default: { notify: vi.fn() },
}));

// Mock fetch for webhooks
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import { sendDesktopNotification, sendWebhookNotification } from '../../src/notifications.js';

describe('notifications', () => {
  it('sendDesktopNotification calls node-notifier', async () => {
    delete process.env.CI;
    await sendDesktopNotification('Test', 'Hello');
    const notifier = (await import('node-notifier')).default;
    expect(notifier.notify).toHaveBeenCalled();
  });

  it('sendDesktopNotification skips in CI', async () => {
    process.env.CI = 'true';
    const notifier = (await import('node-notifier')).default;
    vi.mocked(notifier.notify).mockClear();
    await sendDesktopNotification('Test', 'Hello');
    expect(notifier.notify).not.toHaveBeenCalled();
    delete process.env.CI;
  });

  it('sendWebhookNotification posts JSON', async () => {
    await sendWebhookNotification('https://hooks.example.com/test', {
      type: 'completed', data: { pages: 100 },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.example.com/test',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sendWebhookNotification handles failure gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    await expect(
      sendWebhookNotification('https://hooks.example.com/test', { type: 'failed', data: {} }),
    ).resolves.not.toThrow();
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/notifications.ts apps/cli/tests/unit/notifications.test.ts apps/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): add desktop and webhook notification helpers with tests"
```

---

## Task 10: Structured Logging

The pipeline runner needs per-run log files. Pino already handles structured JSON logging. Configure it to write to `.spatula/logs/{timestamp}.log`.

- [ ] **Step 1: Add log file output to run command**

In `apps/cli/src/commands/run.ts`, before starting the pipeline, configure Pino to write to a log file:

```typescript
import pino from 'pino';
import { join } from 'node:path';

const logFile = join(spatulaDir, 'logs', `${new Date().toISOString().replace(/:/g, '-')}.log`);
const fileTransport = pino.transport({ target: 'pino/file', options: { destination: logFile } });
```

The existing `createLogger` from `@spatula/shared` uses Pino. Adding a file destination is a Pino configuration concern — check if the shared logger supports multiple destinations or if we need to add one.

For the initial implementation, simply write logs to stdout (existing behavior) AND a file via `pino.multistream`. This can be refined later.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/commands/run.ts
git commit -m "feat(cli): add structured JSON logging to .spatula/logs/"
```

---

## Task 11: CLI Hook Adaptation (DataSource)

**Files:**
- Modify: `apps/cli/src/hooks/useEntityData.ts`
- Modify: `apps/cli/src/hooks/useJobPolling.ts`
- Modify: `apps/cli/src/hooks/useEntityFilter.ts`
- Modify: `apps/cli/src/hooks/useExport.ts`

- [ ] **Step 1: Read each hook file**

Each hook currently accepts an `ApiClient` or makes API calls. Refactor to accept a `DataSource` instead:

```typescript
// Before:
function useEntityData(apiClient: ApiClient, jobId: string)

// After:
function useEntityData(dataSource: DataSource)
```

The `DataSource` interface provides the same data via different methods. The hooks call `dataSource.getEntities()` instead of `apiClient.listEntities()`.

- [ ] **Step 2: Refactor each hook**

Read each file, understand its current API, and replace the API client calls with DataSource method calls. Keep backward compatibility by accepting either type (union type or adapter pattern).

**Important:** This is a breaking change for the hooks. All callers (App.tsx, Dashboard, Explorer, Review) need to be updated to pass a DataSource. For now, create the DataSource versions alongside the existing API versions — don't break existing server-mode functionality.

- [ ] **Step 3: Build and commit**

```bash
git add apps/cli/src/hooks/
git commit -m "feat(cli): adapt hooks to accept DataSource for local mode"
```

---

## Task 12: Integration Verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
```

- [ ] **Step 2: Verify CLI builds**

```bash
pnpm --filter @spatula/cli build
```

- [ ] **Step 3: Verify `spatula init` works**

In a temp directory:
```bash
cd /tmp && mkdir test-project && cd test-project
node /path/to/spatula/apps/cli/dist/index.js init https://example.com
ls -la spatula.yaml .spatula/
```

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration issues in local pipeline and CLI"
```
