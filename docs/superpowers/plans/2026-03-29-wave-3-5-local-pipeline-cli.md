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

This is a large sub-plan (~23 deliverables, ~20 new files). It decomposes into 12 tasks grouped by dependency:

**Foundation (Tasks 1-3):** Local content store, pipeline events emitter, project lockfile
**DataSource (Task 4):** Interface + LocalDataSource
**Pipeline Runner (Tasks 5-6):** The core 13-step execution engine + checkpoint/resume
**CLI Commands (Tasks 7-10):** init, run, status, reset
**Notifications (Task 11):** Desktop + webhook
**Integration (Task 12):** Hook adaptation + final wiring

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
| `packages/core/tests/unit/content-store/local-content-store.test.ts` | Local content store tests |

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
    private readonly adapter: any, // ProjectAdapter from @spatula/db
    private readonly events?: PipelineEventEmitter,
  ) {}

  async getEntities(query: PaginationQuery): Promise<PaginatedResult<Entity>> {
    const entities = await this.adapter.entityRepo.findByJob(
      this.adapter.projectId, this.adapter.projectId,
      { limit: query.limit ?? 50, offset: query.offset ?? 0, search: query.search },
    );
    const total = await this.adapter.entityRepo.countByJob(
      this.adapter.projectId, this.adapter.projectId,
    );
    return { data: entities as Entity[], total };
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.adapter.entityRepo.findById(id, this.adapter.projectId);
  }

  async searchEntities(filter: string): Promise<Entity[]> {
    const result = await this.adapter.entityRepo.findByJob(
      this.adapter.projectId, this.adapter.projectId,
      { search: filter },
    );
    return result as Entity[];
  }

  async getSchema(): Promise<unknown> {
    return this.adapter.schemaRepo.findLatest(this.adapter.projectId, this.adapter.projectId);
  }

  async getSchemaVersions(): Promise<unknown[]> {
    return this.adapter.schemaRepo.findAllVersions(this.adapter.projectId, this.adapter.projectId);
  }

  async getActions(status?: string): Promise<unknown[]> {
    return this.adapter.actionRepo.findByJob(this.adapter.projectId, this.adapter.projectId, { status });
  }

  async approveAction(id: string, reviewedBy?: string): Promise<void> {
    await this.adapter.actionRepo.updateStatus(id, this.adapter.projectId, 'approved', reviewedBy);
  }

  async rejectAction(id: string, reviewedBy?: string): Promise<void> {
    await this.adapter.actionRepo.updateStatus(id, this.adapter.projectId, 'rejected', reviewedBy);
  }

  async getStatus(): Promise<ProjectStatus> {
    const lastRun = await this.adapter.runRepo.findLatest?.();
    const totalPages = await this.adapter.taskRepo.countByJob?.(this.adapter.projectId, this.adapter.projectId) ?? 0;
    const totalEntities = await this.adapter.entityRepo.countByJob(this.adapter.projectId, this.adapter.projectId);
    const pendingActions = (await this.adapter.actionRepo.findByJob(this.adapter.projectId, this.adapter.projectId, { status: 'pending_review' })).length;
    const schema = await this.adapter.schemaRepo.findLatest(this.adapter.projectId, this.adapter.projectId);
    const schemaFields = schema ? Object.keys((schema as any).definition?.fields ?? {}).length : 0;

    return {
      lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, startedAt: lastRun.startedAt, pagesProcessed: lastRun.pagesProcessed ?? 0, entitiesCreated: lastRun.entitiesCreated ?? 0 } : undefined,
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
    return this.adapter.exportRepo.findById(id, this.adapter.projectId);
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

- [ ] **Step 3: Export from barrels**

Add to `packages/core/src/index.ts`:
```typescript
export type { DataSource, PaginationQuery, PaginatedResult, ProjectStatus, DataEvent } from './interfaces/data-source.js';
export { LocalDataSource } from './pipeline/local-data-source.js';
```

- [ ] **Step 4: Build and commit**

```bash
pnpm --filter @spatula/core build
git add packages/core/src/interfaces/data-source.ts packages/core/src/pipeline/local-data-source.ts packages/core/src/index.ts
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
      projectId: 'test-project',
      taskRepo: {
        findByJob: vi.fn().mockResolvedValue([]),
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
        update: vi.fn(),
        findLatest: vi.fn().mockResolvedValue(null),
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
    schemaEvolver: { evolve: vi.fn().mockResolvedValue({ actions: [], schema: {} }) },
    reconciler: { reconcile: vi.fn().mockResolvedValue({ entities: [] }) },
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

const logger = createLogger('local-pipeline-runner');

export interface LocalPipelineConfig {
  adapter: any; // ProjectAdapter
  config: any;  // Resolved JobConfig
  projectDir: string;
  crawler: any;
  extractor: any;
  classifier: any;
  contentStore: any;
  schemaEvolver?: any;
  reconciler?: any;
  linkEvaluator?: any;
  robotsChecker?: any;
  rateLimiter?: any;
  circuitBreaker?: any;
}

export class LocalPipelineRunner {
  private readonly lock: ProjectLock;
  private readonly events = new PipelineEventEmitter();
  private readonly queue: PriorityQueue<{ taskId: string; url: string; depth: number }>;
  private readonly semaphore: Semaphore;
  private readonly pageBudget: InMemoryPageBudget;
  private isRunning = false;
  private isPaused = false;

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

      // Step 6: Determine work
      const pendingTasks = await this.deps.adapter.taskRepo.findByJob(
        this.deps.adapter.projectId, this.deps.adapter.projectId, { status: 'pending' },
      );

      if (pendingTasks.length === 0 && this.deps.config.seedUrls?.length > 0) {
        // First run: enqueue seed URLs
        for (const url of this.deps.config.seedUrls) {
          const task = await this.deps.adapter.taskRepo.enqueue({
            jobId: this.deps.adapter.projectId,
            tenantId: this.deps.adapter.projectId,
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

      // Create run record
      const run = await this.deps.adapter.runRepo.create({
        status: 'started',
        startedAt: new Date().toISOString(),
        config: this.deps.config,
      });

      // Step 7: Re-extraction pass (placeholder)
      // TODO: Handle flagged pages

      // Step 8: Crawl + extract loop
      await this.crawlLoop();

      // Step 9: Schema evolution (post-crawl)
      // TODO: Batch schema evolution

      // Step 10: Reconciliation
      // TODO: Full or incremental reconciliation

      // Step 11: Auto-export
      // TODO: If export.autoExport is true

      // Step 12: Run summary
      const stats = {
        pagesProcessed: this.pageBudget.count,
        totalPages: this.pageBudget.maxPages,
        entitiesCreated: 0,
        errors: 0,
      };
      this.events.emit('progress', stats);
      logger.info(stats, 'Run completed');

      // Update run record
      await this.deps.adapter.runRepo.update(run.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        pagesProcessed: stats.pagesProcessed,
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
    const inProgress = await this.deps.adapter.taskRepo.findByJob(
      this.deps.adapter.projectId, this.deps.adapter.projectId, { status: 'in_progress' },
    );
    for (const task of inProgress) {
      await this.deps.adapter.taskRepo.updateStatus(task.id, this.deps.adapter.projectId, 'pending');
      logger.info({ taskId: task.id }, 'Recovered crashed task');
    }
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

  private async processTask(task: { taskId: string; url: string; depth: number }): Promise<void> {
    try {
      // Check page budget
      if (!this.pageBudget.tryIncrement()) {
        await this.deps.adapter.taskRepo.updateStatus(task.taskId, this.deps.adapter.projectId, 'skipped');
        return;
      }

      // Delegate to crawl orchestrator
      const result = await processCrawlTask(
        { taskId: task.taskId, jobId: this.deps.adapter.projectId, tenantId: this.deps.adapter.projectId, url: task.url, depth: task.depth },
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
            jobId: this.deps.adapter.projectId,
            tenantId: this.deps.adapter.projectId,
            url: link.url,
            depth: task.depth + 1,
            parentTaskId: task.taskId,
          });
          const priority = link.priority === 'high' ? 10 : link.priority === 'medium' ? 5 : 1;
          this.queue.enqueue({ taskId: childTask.id, url: link.url, depth: task.depth + 1 }, priority, task.depth + 1);
        }
      }
    } catch (error) {
      logger.error({ taskId: task.taskId, url: task.url, error }, 'Task failed');
      await this.deps.adapter.taskRepo.updateStatus(task.taskId, this.deps.adapter.projectId, 'failed');
    }
  }
}
```

**Note:** This is a SKELETON. Steps 5 (config diff), 7 (re-extraction), 9 (schema evolution), 10 (reconciliation), 11 (auto-export) are stubs with TODO comments. They will be filled in iteratively. The core crawl loop (step 8) is functional.

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
import { createProjectDb, ProjectAdapter } from '@spatula/db';
import { LocalPipelineRunner, LocalContentStore } from '@spatula/core';
import { createLogger } from '@spatula/shared';
import { join } from 'node:path';

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

  // Open SQLite DB
  const dbResult = createProjectDb(join(spatulaDir, 'project.db'));
  const adapter = new ProjectAdapter(dbResult.db);

  // Create content store (local file-based)
  const contentStore = new LocalContentStore(join(spatulaDir, 'pages'));

  // TODO: Create crawler, extractor, classifier, etc.
  // For now, these are placeholders — full DI wiring depends on
  // which LLM/crawler providers are configured.

  console.log(`Starting crawl for ${projectRoot}...`);
  console.log(`Seeds: ${resolvedConfig.seedUrls?.join(', ')}`);
  console.log(`Max pages: ${resolvedConfig.crawl?.maxPages ?? 1000}`);

  // Create and run pipeline
  const runner = new LocalPipelineRunner({
    adapter,
    config: resolvedConfig,
    projectDir: spatulaDir,
    crawler: null as any, // TODO: Wire real crawler
    extractor: null as any, // TODO: Wire real extractor
    classifier: null as any, // TODO: Wire real classifier
    contentStore,
  });

  // Ctrl+C handler for graceful shutdown
  let shuttingDown = false;
  process.on('SIGINT', async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nPausing... (waiting for in-flight tasks)');
    await runner.stop();
    console.log(`Paused. Run 'spatula run' to continue.`);
    process.exit(0);
  });

  try {
    await runner.run({ force: options.force });
    console.log('Crawl completed!');
  } catch (error) {
    console.error('Crawl failed:', (error as Error).message);
    process.exit(1);
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

- [ ] **Step 3: Build and commit**

```bash
pnpm --filter @spatula/cli build
git add apps/cli/src/commands/run.ts apps/cli/src/index.tsx
git commit -m "feat(cli): add spatula run command with pipeline runner and Ctrl+C checkpoint"
```

---

## Task 7: CLI Command — `spatula status`

**Files:**
- Modify: `apps/cli/src/commands/status.ts`

- [ ] **Step 1: Read existing status command**

Read `apps/cli/src/commands/status.ts`. It currently shows API-based job status. Add a local mode that uses `LocalDataSource` when in a project directory.

- [ ] **Step 2: Add local status display**

Add a `runLocalStatusCommand` function that:
1. Finds project root
2. Opens SQLite DB
3. Creates ProjectAdapter + LocalDataSource
4. Calls `dataSource.getStatus()`
5. Prints: last run, pages, entities, pending actions, schema fields, storage

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

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/notifications.ts apps/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): add desktop and webhook notification helpers"
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
