# Wave 2.3b: SQLite Repositories & ProjectAdapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement SQLite repository classes that satisfy the same interfaces as the Postgres repositories (from `@spatula/core/pipeline/types.ts`), plus local-only repositories and a `ProjectAdapter` factory that assembles them all with a pre-bound project ID.

**Architecture:** Each SQLite repository takes a Drizzle SQLite DB instance in its constructor and implements the corresponding interface from `pipeline/types.ts`. The `tenantId` parameter is accepted on all methods but ignored (single-user local mode). UUID generation uses `crypto.randomUUID()`. Timestamps are ISO 8601 strings. JSON columns use Drizzle's `{ mode: 'json' }` for automatic serialization. The `ProjectAdapter` creates all repos with a shared DB and pre-binds the synthetic project ID so callers don't need to pass jobId/tenantId.

**Tech Stack:** TypeScript, Drizzle ORM (better-sqlite3), Vitest

**Spec references:**
- Phase 13 spec: section 5.7 (Repository Layer), 5.6 (Synthetic Project ID)
- File: `docs/superpowers/specs/2026-03-21-phase-13-project-folder-model-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/db/src/project-db/repositories/job-repository.ts` | SQLite job repo (synthetic — composes from project_meta + runs) |
| `packages/db/src/project-db/repositories/page-repository.ts` | SQLite page repo (create, findByContentHash, findByIds) |
| `packages/db/src/project-db/repositories/extraction-repository.ts` | SQLite extraction repo (store, findByJob) |
| `packages/db/src/project-db/repositories/entity-repository.ts` | SQLite entity + entity-source repos |
| `packages/db/src/project-db/repositories/schema-repository.ts` | SQLite schema repo (findLatest, create, versions) |
| `packages/db/src/project-db/repositories/crawl-task-repository.ts` | SQLite crawl task repo (enqueue, updateStatus, getJobStats) |
| `packages/db/src/project-db/repositories/action-repository.ts` | SQLite action repo (create, findByJob, updateStatus) |
| `packages/db/src/project-db/repositories/source-trust-repository.ts` | SQLite source trust repo (upsert, findByJob) |
| `packages/db/src/project-db/repositories/run-repository.ts` | Local-only: run CRUD |
| `packages/db/src/project-db/repositories/llm-usage-repository.ts` | Local-only: LLM cost tracking |
| `packages/db/src/project-db/repositories/export-repository.ts` | Local-only: export file tracking |
| `packages/db/src/project-db/repositories/project-meta-repository.ts` | Local-only: key-value store |
| `packages/db/src/project-db/repositories/index.ts` | Barrel export |
| `packages/db/src/project-db/adapter.ts` | ProjectAdapter factory |
| `packages/db/tests/unit/project-db/repositories.test.ts` | Integration tests against in-memory SQLite |

### Modified Files

| File | Change |
|------|--------|
| `packages/db/src/index.ts` | Export ProjectAdapter and repos |

---

## Common Patterns

All SQLite repositories follow these conventions:

```typescript
import { eq, and, desc, sql } from 'drizzle-orm';
import type { ProjectDatabase } from '../connection.js';
import { someTable } from '../../schema-sqlite/some-table.js';

export class SqliteSomeRepository {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,  // pre-bound synthetic project ID
  ) {}

  // jobId/tenantId accepted but ignored — uses this.projectId
  async someMethod(_jobId: string, _tenantId?: string): Promise<Something> {
    const row = await this.db.select().from(someTable)
      .where(eq(someTable.jobId, this.projectId))  // uses pre-bound projectId
      .limit(1)
      .then(rows => rows[0] ?? null);
    return row;
  }

  async create(data: CreateInput): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    this.db.insert(someTable).values({
      id,
      jobId: this.projectId,  // auto-set from pre-bound projectId
      ...data,
      createdAt: new Date().toISOString(),
    }).run();
    return { id };
  }
}
```

**Key differences from Postgres repos:**
- **Pre-bound projectId:** Every repo constructor takes `(db, projectId)`. Methods ignore the `jobId`/`tenantId` parameters and use `this.projectId` instead. This matches spec section 5.7.
- UUIDs generated via `crypto.randomUUID()` (not Postgres `gen_random_uuid()`)
- Timestamps as `new Date().toISOString()` (not Postgres `now()`)
- JSON columns auto-serialized by Drizzle `{ mode: 'json' }` — no manual `JSON.stringify`
- **`returning()` pattern:** Use `this.db.insert(table).values({...}).returning().get()` — the `.get()` at the end is better-sqlite3's synchronous return. Array destructuring `const [row]` also works.
- **`count(*)` — NO `::int` cast!** Postgres uses `sql<number>\`count(*)::int\`` but `::int` is invalid in SQLite. Use plain `sql<number>\`count(*)\`` and wrap result with `Number()` in TypeScript.
- better-sqlite3 is synchronous — Drizzle wraps it but the API is still `async`
- **Transactions:** Drizzle for better-sqlite3 supports `db.transaction((tx) => {...})` but the callback is synchronous (not async). Use synchronous operations inside transactions.

---

## Task 0: Job Repository (Synthetic)

**Files:**
- Create: `packages/db/src/project-db/repositories/job-repository.ts`

- [ ] **Step 1: Create SQLite job repository**

The `JobRepo` interface (`pipeline/types.ts`) is required by ALL four orchestrators. In local mode, there is no `jobs` table — the "job" IS the project. The SQLite job repo composes a synthetic job row from `project_meta` and the latest `run`:

```typescript
export class SqliteJobRepository {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,
  ) {}

  async findById(_jobId: string, _tenantId?: string): Promise<{ id: string; config: unknown; status?: string } | null> {
    // Return synthetic job from project_meta + latest run
    const metaRows = this.db.select().from(projectMeta).all();
    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));

    const latestRun = this.db.select().from(runs)
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();

    return {
      id: this.projectId,
      config: latestRun?.configSnapshot ?? {},
      status: latestRun?.status,
    };
  }

  async updateStatus(_jobId: string, _tenantId?: string, status: string): Promise<unknown> {
    // Update the latest run's status
    const latestRun = this.db.select().from(runs)
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();
    if (latestRun) {
      this.db.update(runs)
        .set({ status })
        .where(eq(runs.id, latestRun.id))
        .run();
    }
    return {};
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/project-db/repositories/job-repository.ts
git commit -m "feat(db): add synthetic SQLite job repository for local project mode"
```

---

## Task 1: Page + Extraction Repositories

**Files:**
- Create: `packages/db/src/project-db/repositories/page-repository.ts`
- Create: `packages/db/src/project-db/repositories/extraction-repository.ts`

- [ ] **Step 1: Create SQLite page repository**

Implements `PageRepo` from `pipeline/types.ts`. Methods:
- `create(data)` — insert into pages table, generate UUID, return `{ id }`
- `findByContentHash(hash, _tenantId?)` — select where contentHash matches
- `findByIds(ids, _tenantId?)` — select where id IN ids

Read the Postgres `PageRepository` at `packages/db/src/repositories/page-repository.ts` for the exact method signatures and return shapes. The SQLite version drops `tenantId` filtering.

**Important:** The SQLite `pages` table has `jobId NOT NULL` — the `create` method must auto-set `jobId: this.projectId` on every insert. It also has additional columns not in Postgres (`url`, `statusCode`, `title`, `classification`, `contentPath`, `needsReextraction`). The `create` method should accept these as optional extensions beyond the base interface.

- [ ] **Step 2: Create SQLite extraction repository**

Implements `ExtractionRepo` from `pipeline/types.ts`. Methods:
- `store(data)` — insert into extractions table, generate UUID
- `findByJob(jobId, _tenantId?, options?)` — select with optional schemaVersion filter, limit, offset

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/project-db/repositories/page-repository.ts packages/db/src/project-db/repositories/extraction-repository.ts
git commit -m "feat(db): add SQLite page and extraction repositories"
```

---

## Task 2: Entity + EntitySource Repositories

**Files:**
- Create: `packages/db/src/project-db/repositories/entity-repository.ts`

- [ ] **Step 1: Create SQLite entity + entity-source repository**

Implements `EntityRepo` and `EntitySourceRepo` from `pipeline/types.ts`. Both in one file since entity_sources is a junction table tightly coupled to entities.

Methods for EntityRepo:
- `create(data)` — insert entity, generate UUID, return `{ id }`
- `findByJob(jobId, _tenantId?, options?)` — select with limit/offset
- `findByJobWithProvenance(jobId, _tenantId?, options?)` — same but includes provenance field
- `countByJob(jobId, _tenantId?)` — count entities

Methods for EntitySourceRepo:
- `bulkLink(links)` — insert multiple entity_source rows

**Important for `categories`:** The SQLite schema uses `text('categories', { mode: 'json' })`. Drizzle auto-serializes arrays. The Postgres version uses `text[]` with different serialization.

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/project-db/repositories/entity-repository.ts
git commit -m "feat(db): add SQLite entity and entity-source repositories"
```

---

## Task 3: Schema + CrawlTask Repositories

**Files:**
- Create: `packages/db/src/project-db/repositories/schema-repository.ts`
- Create: `packages/db/src/project-db/repositories/crawl-task-repository.ts`

- [ ] **Step 1: Create SQLite schema repository**

Implements `SchemaRepo` from `pipeline/types.ts`. Methods:
- `findLatest(jobId, _tenantId?)` — select order by version DESC limit 1
- `create(data)` — insert with generated UUID, parentId optional

Additional methods (not in pipeline interface but needed by CLI):
- `findAllVersions(jobId)` — list all schema versions ordered by version

- [ ] **Step 2: Create SQLite crawl-task repository**

Implements BOTH `CrawlTaskRepo` from `pipeline/types.ts` AND `TaskStatsRepo` from `@spatula/core/crawlers/completion-checker.js`. Declare as: `class SqliteCrawlTaskRepository implements CrawlTaskRepo, TaskStatsRepo`. Methods:
- `enqueue(data)` — insert task with generated UUID, default status='pending'
- `updateStatus(taskId, _tenantId?, status)` — update status field
- `updateClassification(taskId, _tenantId?, classification)` — update classification field
- `getJobStats(jobId, _tenantId?)` — group by status, count per status

Additional methods:
- `findPending(jobId, options?)` — find pending tasks ordered by priorityScore DESC (for the local pipeline's priority queue)

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/project-db/repositories/schema-repository.ts packages/db/src/project-db/repositories/crawl-task-repository.ts
git commit -m "feat(db): add SQLite schema and crawl-task repositories"
```

---

## Task 4: Action + SourceTrust Repositories

**Files:**
- Create: `packages/db/src/project-db/repositories/action-repository.ts`
- Create: `packages/db/src/project-db/repositories/source-trust-repository.ts`

- [ ] **Step 1: Create SQLite action repository**

Implements `ActionRepo` from `pipeline/types.ts`. Methods:
- `create(data)` — insert with generated UUID
- `findByJob(jobId, options?)` — find actions with optional status filter
- `updateStatus(actionId, _tenantId?, status, reviewedBy?)` — update status

- [ ] **Step 2: Create SQLite source-trust repository**

Implements `SourceTrustRepo` from `pipeline/types.ts`. Methods:
- `upsert(data)` — delete existing for domain + insert new (transaction)
- `findByJob(jobId)` — list all trust records for a job

**Note on `reasoning` column:** The pipeline interface requires `upsert({ ..., reasoning: string })` but the SQLite `source_trust` table drops `reasoning` (per spec). The SQLite repo accepts the `reasoning` parameter in the method signature but does NOT persist it — it is silently dropped. The `score` field (local extension) is set to a default of 0.5 if not provided. Document this as a known local-mode limitation in a code comment.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/project-db/repositories/action-repository.ts packages/db/src/project-db/repositories/source-trust-repository.ts
git commit -m "feat(db): add SQLite action and source-trust repositories"
```

---

## Task 5: Local-Only Repositories

**Files:**
- Create: `packages/db/src/project-db/repositories/run-repository.ts`
- Create: `packages/db/src/project-db/repositories/llm-usage-repository.ts`
- Create: `packages/db/src/project-db/repositories/export-repository.ts`
- Create: `packages/db/src/project-db/repositories/project-meta-repository.ts`

- [ ] **Step 1: Create run repository**

No Postgres equivalent. Methods:
- `create(data)` — insert run with generated UUID
- `findLatestByStatus(statuses)` — find most recent run with status in given list (for config diff baseline)
- `findById(id)` — get single run
- `updateStatus(id, status, completedAt?)` — update run status
- `updateStats(id, stats)` — increment stats counters

- [ ] **Step 2: Create LLM usage repository**

No Postgres equivalent. Methods:
- `record(data)` — insert usage record with generated UUID
- `findByRun(runId)` — list usage for a run
- `aggregateByRun(runId)` — sum tokens/cost grouped by purpose for a single run (llm_usage has runId, not jobId)

- [ ] **Step 3: Create export repository (local)**

Implements `ExportRepo` from `pipeline/types.ts`. The local exports table has a simpler schema (no `contentRef`, has `filePath`), but must still satisfy the `updateStatus` interface method for the export orchestrator.

Methods:
- `create(data)` — insert with generated UUID
- `findAll()` — list all exports
- `findById(id)` — get single export
- `updateStatus(exportId, _tenantId?, data)` — update status, entityCount, fileSize, error, completedAt. For local mode, `contentRef` from the interface is mapped to `filePath` (or ignored if the caller provides a file path separately)

- [ ] **Step 4: Create project-meta repository**

Simple key-value store. Methods:
- `get(key)` — get value by key, return null if not found
- `set(key, value)` — upsert key-value pair
- `getAll()` — return all key-value pairs as Record

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/project-db/repositories/run-repository.ts packages/db/src/project-db/repositories/llm-usage-repository.ts packages/db/src/project-db/repositories/export-repository.ts packages/db/src/project-db/repositories/project-meta-repository.ts
git commit -m "feat(db): add local-only SQLite repositories (run, llm-usage, export, project-meta)"
```

---

## Task 6: Repository Barrel + ProjectAdapter

**Files:**
- Create: `packages/db/src/project-db/repositories/index.ts`
- Create: `packages/db/src/project-db/adapter.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Create repository barrel**

Export all repos from `packages/db/src/project-db/repositories/index.ts`.

- [ ] **Step 2: Create ProjectAdapter**

The `ProjectAdapter` is a factory that creates all repos from a single DB instance and pre-binds the synthetic project ID:

```typescript
// packages/db/src/project-db/adapter.ts
import type { ProjectDatabase } from './connection.js';
import { SqlitePageRepository } from './repositories/page-repository.js';
import { SqliteExtractionRepository } from './repositories/extraction-repository.js';
import { SqliteEntityRepository, SqliteEntitySourceRepository } from './repositories/entity-repository.js';
import { SqliteSchemaRepository } from './repositories/schema-repository.js';
import { SqliteCrawlTaskRepository } from './repositories/crawl-task-repository.js';
import { SqliteActionRepository } from './repositories/action-repository.js';
import { SqliteSourceTrustRepository } from './repositories/source-trust-repository.js';
import { RunRepository } from './repositories/run-repository.js';
import { LlmUsageRepository } from './repositories/llm-usage-repository.js';
import { SqliteExportRepository } from './repositories/export-repository.js';
import { ProjectMetaRepository } from './repositories/project-meta-repository.js';

export class ProjectAdapter {
  readonly pageRepo: SqlitePageRepository;
  readonly extractionRepo: SqliteExtractionRepository;
  readonly entityRepo: SqliteEntityRepository;
  readonly entitySourceRepo: SqliteEntitySourceRepository;
  readonly schemaRepo: SqliteSchemaRepository;
  readonly taskRepo: SqliteCrawlTaskRepository;
  readonly actionRepo: SqliteActionRepository;
  readonly sourceTrustRepo: SqliteSourceTrustRepository;
  readonly runRepo: RunRepository;
  readonly llmUsageRepo: LlmUsageRepository;
  readonly exportRepo: SqliteExportRepository;
  readonly metaRepo: ProjectMetaRepository;

  private readonly projectId: string;

  readonly jobRepo: SqliteJobRepository;

  constructor(db: ProjectDatabase, projectId: string) {
    this.projectId = projectId;
    // All repos receive (db, projectId) — pre-binds the synthetic project ID per spec 5.7
    this.jobRepo = new SqliteJobRepository(db, projectId);
    this.pageRepo = new SqlitePageRepository(db, projectId);
    this.extractionRepo = new SqliteExtractionRepository(db, projectId);
    this.entityRepo = new SqliteEntityRepository(db, projectId);
    this.entitySourceRepo = new SqliteEntitySourceRepository(db, projectId);
    this.schemaRepo = new SqliteSchemaRepository(db, projectId);
    this.taskRepo = new SqliteCrawlTaskRepository(db, projectId);
    this.actionRepo = new SqliteActionRepository(db, projectId);
    this.sourceTrustRepo = new SqliteSourceTrustRepository(db, projectId);
    // Local-only repos don't need projectId (they don't have jobId columns)
    this.runRepo = new RunRepository(db);
    this.llmUsageRepo = new LlmUsageRepository(db);
    this.exportRepo = new SqliteExportRepository(db);
    this.metaRepo = new ProjectMetaRepository(db);
  }

  /** Get the synthetic project ID (used as jobId in all queries) */
  getProjectId(): string {
    return this.projectId;
  }

  /** Get a meta value by key */
  async getMeta(key: string): Promise<string | null> {
    return this.metaRepo.get(key);
  }
}
```

**Design note:** Per spec section 5.7, repos receive `projectId` in their constructor and use it internally. The `jobId`/`tenantId` parameters on interface methods are accepted but ignored — the pre-bound `projectId` is always used. The `getProjectId()` method exposes the ID for callers that need it explicitly (e.g., when creating run records).

- [ ] **Step 3: Update db barrel exports**

Add to `packages/db/src/index.ts`:

```typescript
// Project-db repositories and adapter
export { ProjectAdapter } from './project-db/adapter.js';
export * from './project-db/repositories/index.js';
```

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @spatula/db build`

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/project-db/repositories/index.ts packages/db/src/project-db/adapter.ts packages/db/src/index.ts
git commit -m "feat(db): add ProjectAdapter factory and repository barrel exports"
```

---

## Task 7: Repository Integration Tests

**Files:**
- Create: `packages/db/tests/unit/project-db/repositories.test.ts`

- [ ] **Step 1: Write integration tests against in-memory SQLite**

These tests create a real in-memory SQLite DB, initialize it with migrations, and test each repository against actual SQL. This catches Drizzle schema / SQL mismatches.

```typescript
// packages/db/tests/unit/project-db/repositories.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createProjectDb, initializeProjectDb } from '../../../src/project-db/connection.js';
import { ProjectAdapter } from '../../../src/project-db/adapter.js';
import type { ProjectDatabase, ProjectDbResult } from '../../../src/project-db/connection.js';

describe('SQLite Repositories (in-memory)', () => {
  let dbResult: ProjectDbResult;
  let adapter: ProjectAdapter;
  const projectId = '00000000-0000-0000-0000-000000000001';
  const tenantId = '00000000-0000-0000-0000-000000000002'; // ignored by SQLite repos

  beforeAll(() => {
    dbResult = createProjectDb(':memory:');
    initializeProjectDb(dbResult.db, { projectId, name: 'test-project' });
    adapter = new ProjectAdapter(dbResult.db, projectId);
  });

  afterAll(() => {
    dbResult.close();
  });

  describe('ProjectMetaRepository', () => {
    it('reads seeded project_id', async () => {
      const value = await adapter.getMeta('project_id');
      expect(value).toBe(projectId);
    });

    it('sets and gets a value', async () => {
      await adapter.metaRepo.set('custom_key', 'custom_value');
      const value = await adapter.metaRepo.get('custom_key');
      expect(value).toBe('custom_value');
    });
  });

  describe('PageRepository', () => {
    it('creates and finds a page by content hash', async () => {
      const page = await adapter.pageRepo.create({
        taskId: 'task-1',
        tenantId,
        contentRef: 'ref-1',
        contentHash: 'hash-abc',
        metadata: { url: 'https://example.com', title: 'Test' },
      });
      expect(page.id).toBeDefined();

      const found = await adapter.pageRepo.findByContentHash('hash-abc', tenantId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(page.id);
    });

    it('returns null for non-existent hash', async () => {
      const found = await adapter.pageRepo.findByContentHash('nonexistent', tenantId);
      expect(found).toBeNull();
    });
  });

  describe('ExtractionRepository', () => {
    it('stores and retrieves extractions', async () => {
      await adapter.extractionRepo.store({
        jobId: projectId,
        tenantId,
        pageId: 'page-1',
        schemaVersion: 1,
        data: { title: 'Test Product' },
        unmappedFields: [],
        metadata: { confidence: 0.95 },
      });

      const results = await adapter.extractionRepo.findByJob(projectId, tenantId);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].data).toBeDefined();
    });
  });

  describe('SchemaRepository', () => {
    it('creates and finds latest schema', async () => {
      await adapter.schemaRepo.create({
        jobId: projectId,
        tenantId,
        version: 1,
        definition: { version: 1, fields: [], fieldAliases: [], createdAt: new Date(), parentVersion: null } as any,
      });

      const latest = await adapter.schemaRepo.findLatest(projectId, tenantId);
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe(1);
    });
  });

  describe('CrawlTaskRepository', () => {
    it('enqueues and updates task status', async () => {
      const task = await adapter.taskRepo.enqueue({
        jobId: projectId,
        tenantId,
        url: 'https://example.com/page1',
        depth: 0,
        parentTaskId: '',
      });
      expect(task.id).toBeDefined();

      await adapter.taskRepo.updateStatus(task.id, tenantId, 'completed');
    });

    it('gets job stats', async () => {
      const stats = await adapter.taskRepo.getJobStats(projectId, tenantId);
      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('completed');
    });
  });

  describe('EntityRepository', () => {
    it('creates and counts entities', async () => {
      await adapter.entityRepo.create({
        jobId: projectId,
        tenantId,
        mergedData: { name: 'Test Entity' },
        provenance: {},
        qualityScore: 0.85,
      });

      const count = await adapter.entityRepo.countByJob(projectId, tenantId);
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('RunRepository', () => {
    it('creates and finds a run', async () => {
      const run = await adapter.runRepo.create({
        status: 'running',
        source: 'local',
        configSnapshot: { seeds: ['https://example.com'] },
        startedAt: new Date().toISOString(),
      });
      expect(run.id).toBeDefined();

      const found = await adapter.runRepo.findById(run.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe('running');
    });

    it('finds latest by status', async () => {
      const latest = await adapter.runRepo.findLatestByStatus(['running', 'completed', 'paused']);
      expect(latest).not.toBeNull();
    });
  });

  describe('ProjectAdapter', () => {
    it('returns projectId', () => {
      expect(adapter.getProjectId()).toBe(projectId);
    });

    it('has all repositories initialized', () => {
      expect(adapter.pageRepo).toBeDefined();
      expect(adapter.extractionRepo).toBeDefined();
      expect(adapter.entityRepo).toBeDefined();
      expect(adapter.entitySourceRepo).toBeDefined();
      expect(adapter.schemaRepo).toBeDefined();
      expect(adapter.taskRepo).toBeDefined();
      expect(adapter.actionRepo).toBeDefined();
      expect(adapter.sourceTrustRepo).toBeDefined();
      expect(adapter.runRepo).toBeDefined();
      expect(adapter.llmUsageRepo).toBeDefined();
      expect(adapter.exportRepo).toBeDefined();
      expect(adapter.metaRepo).toBeDefined();
    });
  });
});
```

**Why in-memory SQLite tests, not mocks:** These repos are the data layer — they must work against real SQL. Mocking Drizzle would test nothing. In-memory SQLite is fast (no disk I/O) and disposes automatically.

**Prerequisite:** The migration files in `packages/db/drizzle-sqlite/` must exist for `initializeProjectDb` to work. These are committed to git, so they're available on checkout. If running tests after schema changes, run `pnpm --filter @spatula/db db:generate:sqlite` first to regenerate.

- [ ] **Step 2: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test -- --run repositories`

- [ ] **Step 3: Run full db suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db test -- --run`

- [ ] **Step 4: Commit**

```bash
git add packages/db/tests/unit/project-db/repositories.test.ts
git commit -m "test(db): add SQLite repository integration tests against in-memory DB"
```

---

## Task 8: Integration Verification

- [ ] **Step 1: Run full db test suite**

Run: `pnpm --filter @spatula/db test -- --run`

- [ ] **Step 2: Run build**

Run: `pnpm --filter @spatula/db build && pnpm --filter @spatula/queue build`

- [ ] **Step 3: Verify directory structure**

Run: `ls packages/db/src/project-db/repositories/`

Expected: 12 files (page, extraction, entity, schema, crawl-task, action, source-trust, run, llm-usage, export, project-meta, index)

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "test: verify Wave 2.3b — SQLite repositories + ProjectAdapter"
```
