# Phase 4: Storage Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the full PostgreSQL storage layer with Drizzle ORM — database schema, repository pattern, content store, and migration infrastructure.

**Architecture:** Drizzle ORM defines the schema as TypeScript pgTable declarations. A thin repository layer wraps Drizzle queries with tenant isolation and error handling. The ContentStore interface (from core) gets a PostgreSQL implementation storing raw HTML in a dedicated table. All JSONB columns store core types (JobConfig, SchemaDefinition, ExtractionResult data) directly.

**Tech Stack:** Drizzle ORM + drizzle-kit, node-postgres (pg), PostgreSQL 15+, vitest

---

## Prerequisites

- Phase 1-3 complete (core types, interfaces, extraction pipeline)
- `packages/db` scaffolded with `@spatula/shared` and `@spatula/core` workspace deps
- PostgreSQL available locally (or via Docker) for integration tests

## Package Layout

```
packages/db/
├── src/
│   ├── schema/           # Drizzle table definitions
│   │   ├── enums.ts      # pgEnum declarations
│   │   ├── tenants.ts
│   │   ├── jobs.ts
│   │   ├── crawl-tasks.ts
│   │   ├── raw-pages.ts
│   │   ├── schemas.ts
│   │   ├── extractions.ts
│   │   ├── entities.ts
│   │   ├── actions.ts
│   │   ├── source-trust.ts
│   │   └── index.ts      # barrel
│   ├── repositories/     # Query wrappers
│   │   ├── job-repository.ts
│   │   ├── crawl-task-repository.ts
│   │   ├── schema-repository.ts
│   │   ├── extraction-repository.ts
│   │   ├── page-repository.ts
│   │   └── index.ts
│   ├── content-store/
│   │   └── pg-content-store.ts
│   ├── connection.ts     # DB connection factory
│   ├── migrate.ts        # Migration runner
│   └── index.ts          # Package barrel
├── drizzle.config.ts
├── drizzle/              # Generated migrations (by drizzle-kit)
└── tests/
    ├── unit/
    │   ├── schema/
    │   │   └── schema-validation.test.ts
    │   └── repositories/
    │       ├── job-repository.test.ts
    │       ├── crawl-task-repository.test.ts
    │       ├── schema-repository.test.ts
    │       ├── extraction-repository.test.ts
    │       └── page-repository.test.ts
    └── helpers/
        └── test-db.ts    # In-memory test helpers
```

---

## Task 1: Install Dependencies & Configure Drizzle

**Files:**
- Modify: `packages/db/package.json`
- Create: `packages/db/drizzle.config.ts`

**Step 1: Install dependencies**

Run:
```bash
cd packages/db && pnpm add drizzle-orm pg && pnpm add -D @types/pg drizzle-kit
```

**Step 2: Create drizzle.config.ts**

Create `packages/db/drizzle.config.ts`:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/spatula',
  },
});
```

**Step 3: Verify build still works**

Run: `cd /path/to/spatula && pnpm build`
Expected: Clean build (drizzle.config.ts is not compiled by tsc)

**Step 4: Commit**

```bash
git add packages/db/package.json packages/db/drizzle.config.ts pnpm-lock.yaml
git commit -m "feat(db): add Drizzle ORM and node-postgres dependencies"
```

---

## Task 2: Database Connection Factory

**Files:**
- Create: `packages/db/src/connection.ts`
- Create: `packages/db/tests/unit/connection.test.ts`

**Step 1: Write the failing test**

Create `packages/db/tests/unit/connection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createDatabase } from '../../src/connection.js';

describe('createDatabase', () => {
  it('creates a drizzle instance from a connection string', () => {
    const db = createDatabase('postgresql://localhost:5432/spatula_test');
    expect(db).toBeDefined();
    // Drizzle instance has a `select` method
    expect(typeof db.select).toBe('function');
  });

  it('creates a drizzle instance from default env var', () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://localhost:5432/spatula_test';
    try {
      const db = createDatabase();
      expect(db).toBeDefined();
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original;
      } else {
        delete process.env.DATABASE_URL;
      }
    }
  });

  it('throws StorageError when no URL provided and env missing', () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => createDatabase()).toThrow('DATABASE_URL');
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original;
      }
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/connection.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

Create `packages/db/src/connection.ts`:

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { StorageError } from '@spatula/shared';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(connectionString?: string) {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new StorageError('DATABASE_URL is required — pass it directly or set the environment variable');
  }

  return drizzle({
    connection: { connectionString: url },
    schema,
  });
}
```

Note: This will not fully compile until we create the schema barrel export in Task 3. That's OK — we're building bottom-up. For now, create a temporary `packages/db/src/schema/index.ts` placeholder:

```typescript
// Schema tables — populated in subsequent tasks
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/connection.test.ts`
Expected: PASS — all 3 tests

**Step 5: Commit**

```bash
git add packages/db/src/connection.ts packages/db/src/schema/index.ts packages/db/tests/unit/connection.test.ts
git commit -m "feat(db): add database connection factory with StorageError"
```

---

## Task 3: Schema — Enums

**Files:**
- Create: `packages/db/src/schema/enums.ts`
- Create: `packages/db/tests/unit/schema/enums.test.ts`

**Step 1: Write the failing test**

Create `packages/db/tests/unit/schema/enums.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  jobStatusEnum,
  crawlTaskStatusEnum,
  taskPriorityEnum,
  pageClassificationEnum,
  crawlerTypeEnum,
  actionSourceEnum,
  actionStatusEnum,
  trustLevelEnum,
} from '../../../src/schema/enums.js';

describe('schema enums', () => {
  it('jobStatusEnum has all statuses', () => {
    expect(jobStatusEnum.enumValues).toEqual([
      'pending', 'queued', 'running', 'paused',
      'reconciling', 'completed', 'failed', 'cancelled',
    ]);
  });

  it('crawlTaskStatusEnum has all statuses', () => {
    expect(crawlTaskStatusEnum.enumValues).toEqual([
      'pending', 'in_progress', 'completed', 'failed', 'skipped',
    ]);
  });

  it('taskPriorityEnum has all priorities', () => {
    expect(taskPriorityEnum.enumValues).toEqual(['high', 'medium', 'low']);
  });

  it('pageClassificationEnum has all classifications', () => {
    expect(pageClassificationEnum.enumValues).toEqual([
      'single_entry', 'multiple_entries', 'navigation', 'irrelevant', 'partial',
    ]);
  });

  it('crawlerTypeEnum has all types', () => {
    expect(crawlerTypeEnum.enumValues).toEqual(['playwright', 'firecrawl']);
  });

  it('actionSourceEnum has all sources', () => {
    expect(actionSourceEnum.enumValues).toEqual([
      'extraction', 'schema_evolution', 'reconciliation', 'quality_audit',
    ]);
  });

  it('actionStatusEnum has all statuses', () => {
    expect(actionStatusEnum.enumValues).toEqual([
      'pending_review', 'approved', 'applied', 'rejected', 'rolled_back',
    ]);
  });

  it('trustLevelEnum has all levels', () => {
    expect(trustLevelEnum.enumValues).toEqual([
      'authoritative', 'high', 'medium', 'low',
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/enums.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `packages/db/src/schema/enums.ts`:

```typescript
import { pgEnum } from 'drizzle-orm/pg-core';

export const jobStatusEnum = pgEnum('job_status', [
  'pending', 'queued', 'running', 'paused',
  'reconciling', 'completed', 'failed', 'cancelled',
]);

export const crawlTaskStatusEnum = pgEnum('crawl_task_status', [
  'pending', 'in_progress', 'completed', 'failed', 'skipped',
]);

export const taskPriorityEnum = pgEnum('task_priority', [
  'high', 'medium', 'low',
]);

export const pageClassificationEnum = pgEnum('page_classification', [
  'single_entry', 'multiple_entries', 'navigation', 'irrelevant', 'partial',
]);

export const crawlerTypeEnum = pgEnum('crawler_type', [
  'playwright', 'firecrawl',
]);

export const actionSourceEnum = pgEnum('action_source', [
  'extraction', 'schema_evolution', 'reconciliation', 'quality_audit',
]);

export const actionStatusEnum = pgEnum('action_status', [
  'pending_review', 'approved', 'applied', 'rejected', 'rolled_back',
]);

export const trustLevelEnum = pgEnum('trust_level', [
  'authoritative', 'high', 'medium', 'low',
]);
```

Update `packages/db/src/schema/index.ts`:

```typescript
export * from './enums.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/enums.test.ts`
Expected: PASS — all 8 tests

**Step 5: Commit**

```bash
git add packages/db/src/schema/enums.ts packages/db/src/schema/index.ts packages/db/tests/unit/schema/enums.test.ts
git commit -m "feat(db): add PostgreSQL enum declarations for all domain types"
```

---

## Task 4: Schema — Core Tables (tenants, jobs, schemas)

**Files:**
- Create: `packages/db/src/schema/tenants.ts`
- Create: `packages/db/src/schema/jobs.ts`
- Create: `packages/db/src/schema/schemas.ts`
- Create: `packages/db/tests/unit/schema/tables.test.ts`
- Modify: `packages/db/src/schema/index.ts`

**Step 1: Write the failing test**

Create `packages/db/tests/unit/schema/tables.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { tenants } from '../../../src/schema/tenants.js';
import { jobs } from '../../../src/schema/jobs.js';
import { schemasTable } from '../../../src/schema/schemas.js';

describe('core table schemas', () => {
  it('tenants table has correct name and columns', () => {
    expect(getTableName(tenants)).toBe('tenants');
    expect(tenants.id).toBeDefined();
    expect(tenants.name).toBeDefined();
    expect(tenants.config).toBeDefined();
    expect(tenants.createdAt).toBeDefined();
  });

  it('jobs table has correct name and all columns', () => {
    expect(getTableName(jobs)).toBe('jobs');
    expect(jobs.id).toBeDefined();
    expect(jobs.tenantId).toBeDefined();
    expect(jobs.name).toBeDefined();
    expect(jobs.description).toBeDefined();
    expect(jobs.config).toBeDefined();
    expect(jobs.status).toBeDefined();
    expect(jobs.schemaId).toBeDefined();
    expect(jobs.stats).toBeDefined();
    expect(jobs.createdAt).toBeDefined();
    expect(jobs.startedAt).toBeDefined();
    expect(jobs.completedAt).toBeDefined();
  });

  it('schemas table has correct name and all columns', () => {
    expect(getTableName(schemasTable)).toBe('schemas');
    expect(schemasTable.id).toBeDefined();
    expect(schemasTable.jobId).toBeDefined();
    expect(schemasTable.tenantId).toBeDefined();
    expect(schemasTable.version).toBeDefined();
    expect(schemasTable.definition).toBeDefined();
    expect(schemasTable.parentId).toBeDefined();
    expect(schemasTable.createdAt).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/tables.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `packages/db/src/schema/tenants.ts`:

```typescript
import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Create `packages/db/src/schema/jobs.ts`:

```typescript
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { JobConfig } from '@spatula/core';
import { jobStatusEnum } from './enums.js';
import { tenants } from './tenants.js';
import { schemasTable } from './schemas.js';

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    config: jsonb('config').$type<JobConfig>().notNull(),
    status: jobStatusEnum('status').notNull().default('pending'),
    schemaId: uuid('schema_id').references(() => schemasTable.id),
    stats: jsonb('stats').$type<Record<string, number>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('jobs_tenant_status_idx').on(table.tenantId, table.status),
    index('jobs_tenant_created_idx').on(table.tenantId, table.createdAt),
  ],
);
```

Create `packages/db/src/schema/schemas.ts`:

```typescript
import { pgTable, uuid, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SchemaDefinition } from '@spatula/core';
import { tenants } from './tenants.js';

export const schemasTable = pgTable(
  'schemas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<SchemaDefinition>().notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => schemasTable.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('schemas_job_version_idx').on(table.jobId, table.version),
  ],
);
```

Note: `schemasTable` (not `schemas`) avoids conflict with the Drizzle `pgSchema` import and the core type `SchemaDefinition`. The `jobs.jobId` FK to `schemasTable` is a forward reference — we use `.references(() => schemasTable.id)` which Drizzle resolves lazily.

Update `packages/db/src/schema/index.ts`:

```typescript
export * from './enums.js';
export * from './tenants.js';
export * from './jobs.js';
export * from './schemas.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/tables.test.ts`
Expected: PASS — all 3 tests

**Step 5: Commit**

```bash
git add packages/db/src/schema/tenants.ts packages/db/src/schema/jobs.ts packages/db/src/schema/schemas.ts packages/db/src/schema/index.ts packages/db/tests/unit/schema/tables.test.ts
git commit -m "feat(db): add tenants, jobs, and schemas table definitions with indexes"
```

---

## Task 5: Schema — Crawl & Page Tables (crawl_tasks, raw_pages)

**Files:**
- Create: `packages/db/src/schema/crawl-tasks.ts`
- Create: `packages/db/src/schema/raw-pages.ts`
- Modify: `packages/db/tests/unit/schema/tables.test.ts` (add tests)
- Modify: `packages/db/src/schema/index.ts`

**Step 1: Write the failing test**

Add to `packages/db/tests/unit/schema/tables.test.ts`:

```typescript
import { crawlTasks } from '../../../src/schema/crawl-tasks.js';
import { rawPages } from '../../../src/schema/raw-pages.js';

describe('crawl & page table schemas', () => {
  it('crawl_tasks table has correct name and all columns', () => {
    expect(getTableName(crawlTasks)).toBe('crawl_tasks');
    expect(crawlTasks.id).toBeDefined();
    expect(crawlTasks.jobId).toBeDefined();
    expect(crawlTasks.tenantId).toBeDefined();
    expect(crawlTasks.url).toBeDefined();
    expect(crawlTasks.depth).toBeDefined();
    expect(crawlTasks.status).toBeDefined();
    expect(crawlTasks.priority).toBeDefined();
    expect(crawlTasks.classification).toBeDefined();
    expect(crawlTasks.parentTaskId).toBeDefined();
    expect(crawlTasks.crawlerType).toBeDefined();
    expect(crawlTasks.contentRef).toBeDefined();
    expect(crawlTasks.metadata).toBeDefined();
    expect(crawlTasks.createdAt).toBeDefined();
    expect(crawlTasks.processedAt).toBeDefined();
  });

  it('raw_pages table has correct name and all columns', () => {
    expect(getTableName(rawPages)).toBe('raw_pages');
    expect(rawPages.id).toBeDefined();
    expect(rawPages.taskId).toBeDefined();
    expect(rawPages.tenantId).toBeDefined();
    expect(rawPages.contentRef).toBeDefined();
    expect(rawPages.contentHash).toBeDefined();
    expect(rawPages.metadata).toBeDefined();
    expect(rawPages.createdAt).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/tables.test.ts`
Expected: FAIL — cannot import crawl-tasks/raw-pages

**Step 3: Write the implementation**

Create `packages/db/src/schema/crawl-tasks.ts`:

```typescript
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  crawlTaskStatusEnum,
  taskPriorityEnum,
  pageClassificationEnum,
  crawlerTypeEnum,
} from './enums.js';
import { jobs } from './jobs.js';
import { tenants } from './tenants.js';

export const crawlTasks = pgTable(
  'crawl_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => jobs.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    url: text('url').notNull(),
    depth: integer('depth').notNull().default(0),
    status: crawlTaskStatusEnum('status').notNull().default('pending'),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    classification: pageClassificationEnum('classification'),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => crawlTasks.id),
    crawlerType: crawlerTypeEnum('crawler_type'),
    contentRef: text('content_ref'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    index('crawl_tasks_job_status_idx').on(table.jobId, table.status),
    index('crawl_tasks_job_depth_idx').on(table.jobId, table.depth),
    index('crawl_tasks_url_idx').on(table.url),
  ],
);
```

Create `packages/db/src/schema/raw-pages.ts`:

```typescript
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { crawlTasks } from './crawl-tasks.js';
import { tenants } from './tenants.js';

export const rawPages = pgTable(
  'raw_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => crawlTasks.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    contentRef: text('content_ref').notNull(),
    contentHash: text('content_hash').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('raw_pages_task_idx').on(table.taskId),
    index('raw_pages_content_hash_idx').on(table.contentHash),
  ],
);
```

Update `packages/db/src/schema/index.ts`:

```typescript
export * from './enums.js';
export * from './tenants.js';
export * from './jobs.js';
export * from './schemas.js';
export * from './crawl-tasks.js';
export * from './raw-pages.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/tables.test.ts`
Expected: PASS — all 5 tests

**Step 5: Commit**

```bash
git add packages/db/src/schema/crawl-tasks.ts packages/db/src/schema/raw-pages.ts packages/db/src/schema/index.ts packages/db/tests/unit/schema/tables.test.ts
git commit -m "feat(db): add crawl_tasks and raw_pages table definitions with indexes"
```

---

## Task 6: Schema — Extraction & Entity Tables

**Files:**
- Create: `packages/db/src/schema/extractions.ts`
- Create: `packages/db/src/schema/entities.ts`
- Modify: `packages/db/tests/unit/schema/tables.test.ts` (add tests)
- Modify: `packages/db/src/schema/index.ts`

**Step 1: Write the failing test**

Add to `packages/db/tests/unit/schema/tables.test.ts`:

```typescript
import { extractions } from '../../../src/schema/extractions.js';
import { entities, entitySources } from '../../../src/schema/entities.js';

describe('extraction & entity table schemas', () => {
  it('extractions table has correct name and all columns', () => {
    expect(getTableName(extractions)).toBe('extractions');
    expect(extractions.id).toBeDefined();
    expect(extractions.jobId).toBeDefined();
    expect(extractions.tenantId).toBeDefined();
    expect(extractions.pageId).toBeDefined();
    expect(extractions.schemaVersion).toBeDefined();
    expect(extractions.data).toBeDefined();
    expect(extractions.unmappedFields).toBeDefined();
    expect(extractions.metadata).toBeDefined();
    expect(extractions.createdAt).toBeDefined();
  });

  it('entities table has correct name and all columns', () => {
    expect(getTableName(entities)).toBe('entities');
    expect(entities.id).toBeDefined();
    expect(entities.jobId).toBeDefined();
    expect(entities.tenantId).toBeDefined();
    expect(entities.mergedData).toBeDefined();
    expect(entities.provenance).toBeDefined();
    expect(entities.categories).toBeDefined();
    expect(entities.qualityScore).toBeDefined();
    expect(entities.createdAt).toBeDefined();
  });

  it('entity_sources join table has correct name and columns', () => {
    expect(getTableName(entitySources)).toBe('entity_sources');
    expect(entitySources.entityId).toBeDefined();
    expect(entitySources.extractionId).toBeDefined();
    expect(entitySources.matchConfidence).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/tables.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `packages/db/src/schema/extractions.ts`:

```typescript
import { pgTable, uuid, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';
import { rawPages } from './raw-pages.js';
import { tenants } from './tenants.js';

export const extractions = pgTable(
  'extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => jobs.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    pageId: uuid('page_id').notNull().references(() => rawPages.id),
    schemaVersion: integer('schema_version').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    unmappedFields: jsonb('unmapped_fields').$type<unknown[]>().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('extractions_job_schema_idx').on(table.jobId, table.schemaVersion),
    index('extractions_page_idx').on(table.pageId),
  ],
);
```

Create `packages/db/src/schema/entities.ts`:

```typescript
import { pgTable, uuid, jsonb, text, real, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { jobs } from './jobs.js';
import { extractions } from './extractions.js';
import { tenants } from './tenants.js';

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => jobs.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    mergedData: jsonb('merged_data').$type<Record<string, unknown>>().notNull(),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull(),
    categories: text('categories').array().notNull().default(sql`'{}'::text[]`),
    qualityScore: real('quality_score').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('entities_job_categories_idx').using('gin', table.categories),
    index('entities_job_quality_idx').on(table.jobId, table.qualityScore),
  ],
);

export const entitySources = pgTable(
  'entity_sources',
  {
    entityId: uuid('entity_id').notNull().references(() => entities.id),
    extractionId: uuid('extraction_id').notNull().references(() => extractions.id),
    matchConfidence: real('match_confidence').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entityId, table.extractionId] }),
  ],
);
```

Update `packages/db/src/schema/index.ts`:

```typescript
export * from './enums.js';
export * from './tenants.js';
export * from './jobs.js';
export * from './schemas.js';
export * from './crawl-tasks.js';
export * from './raw-pages.js';
export * from './extractions.js';
export * from './entities.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/tables.test.ts`
Expected: PASS — all 8 tests

**Step 5: Commit**

```bash
git add packages/db/src/schema/extractions.ts packages/db/src/schema/entities.ts packages/db/src/schema/index.ts packages/db/tests/unit/schema/tables.test.ts
git commit -m "feat(db): add extractions, entities, and entity_sources table definitions"
```

---

## Task 7: Schema — Actions & Source Trust Tables

**Files:**
- Create: `packages/db/src/schema/actions.ts`
- Create: `packages/db/src/schema/source-trust.ts`
- Modify: `packages/db/tests/unit/schema/tables.test.ts` (add tests)
- Modify: `packages/db/src/schema/index.ts`

**Step 1: Write the failing test**

Add to `packages/db/tests/unit/schema/tables.test.ts`:

```typescript
import { actions } from '../../../src/schema/actions.js';
import { sourceTrust } from '../../../src/schema/source-trust.js';

describe('actions & source trust table schemas', () => {
  it('actions table has correct name and all columns', () => {
    expect(getTableName(actions)).toBe('actions');
    expect(actions.id).toBeDefined();
    expect(actions.jobId).toBeDefined();
    expect(actions.tenantId).toBeDefined();
    expect(actions.type).toBeDefined();
    expect(actions.payload).toBeDefined();
    expect(actions.source).toBeDefined();
    expect(actions.status).toBeDefined();
    expect(actions.confidence).toBeDefined();
    expect(actions.reasoning).toBeDefined();
    expect(actions.stateChanges).toBeDefined();
    expect(actions.reviewedBy).toBeDefined();
    expect(actions.createdAt).toBeDefined();
    expect(actions.appliedAt).toBeDefined();
  });

  it('source_trust table has correct name and all columns', () => {
    expect(getTableName(sourceTrust)).toBe('source_trust');
    expect(sourceTrust.id).toBeDefined();
    expect(sourceTrust.jobId).toBeDefined();
    expect(sourceTrust.tenantId).toBeDefined();
    expect(sourceTrust.domain).toBeDefined();
    expect(sourceTrust.trustLevel).toBeDefined();
    expect(sourceTrust.reasoning).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/tables.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `packages/db/src/schema/actions.ts`:

```typescript
import { pgTable, uuid, text, jsonb, real, timestamp, index } from 'drizzle-orm/pg-core';
import { actionSourceEnum, actionStatusEnum } from './enums.js';
import { jobs } from './jobs.js';
import { tenants } from './tenants.js';

export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => jobs.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    source: actionSourceEnum('source').notNull(),
    status: actionStatusEnum('status').notNull().default('pending_review'),
    confidence: real('confidence').notNull(),
    reasoning: text('reasoning').notNull(),
    stateChanges: jsonb('state_changes').$type<Record<string, unknown>>(),
    reviewedBy: text('reviewed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (table) => [
    index('actions_job_type_idx').on(table.jobId, table.type),
    index('actions_job_status_idx').on(table.jobId, table.status),
    index('actions_job_created_idx').on(table.jobId, table.createdAt),
  ],
);
```

Create `packages/db/src/schema/source-trust.ts`:

```typescript
import { pgTable, uuid, text } from 'drizzle-orm/pg-core';
import { trustLevelEnum } from './enums.js';
import { jobs } from './jobs.js';
import { tenants } from './tenants.js';

export const sourceTrust = pgTable('source_trust', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  domain: text('domain').notNull(),
  trustLevel: trustLevelEnum('trust_level').notNull(),
  reasoning: text('reasoning').notNull(),
});
```

Update `packages/db/src/schema/index.ts`:

```typescript
export * from './enums.js';
export * from './tenants.js';
export * from './jobs.js';
export * from './schemas.js';
export * from './crawl-tasks.js';
export * from './raw-pages.js';
export * from './extractions.js';
export * from './entities.js';
export * from './actions.js';
export * from './source-trust.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/schema/tables.test.ts`
Expected: PASS — all 10 tests

**Step 5: Commit**

```bash
git add packages/db/src/schema/actions.ts packages/db/src/schema/source-trust.ts packages/db/src/schema/index.ts packages/db/tests/unit/schema/tables.test.ts
git commit -m "feat(db): add actions and source_trust table definitions with indexes"
```

---

## Task 8: Repository — Job Repository

**Files:**
- Create: `packages/db/src/repositories/job-repository.ts`
- Create: `packages/db/tests/unit/repositories/job-repository.test.ts`
- Create: `packages/db/src/repositories/index.ts`

**Step 1: Write the failing test**

Create `packages/db/tests/unit/repositories/job-repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobRepository } from '../../../src/repositories/job-repository.js';

// We test the repository against a mock db object to verify query construction
// Integration tests against real Postgres come in Task 13

function createMockDb() {
  const chainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]),
    then: undefined as unknown,
  };
  // Make chainable thenable so await works
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'test-id' }]));

  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]) }) }),
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
    delete: vi.fn().mockReturnValue(chainable),
  };
}

describe('JobRepository', () => {
  let repo: JobRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new JobRepository(mockDb as any);
  });

  it('has create method', () => {
    expect(typeof repo.create).toBe('function');
  });

  it('has findById method', () => {
    expect(typeof repo.findById).toBe('function');
  });

  it('has findByTenant method', () => {
    expect(typeof repo.findByTenant).toBe('function');
  });

  it('has updateStatus method', () => {
    expect(typeof repo.updateStatus).toBe('function');
  });

  it('has updateStats method', () => {
    expect(typeof repo.updateStats).toBe('function');
  });

  it('create calls db.insert', async () => {
    await repo.create({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Test Job',
      description: 'Test',
      config: {} as any,
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/job-repository.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `packages/db/src/repositories/job-repository.ts`:

```typescript
import { eq, and, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import type { JobConfig, JobStatus } from '@spatula/core';
import { jobs } from '../schema/jobs.js';
import type { Database } from '../connection.js';

const logger = createLogger('job-repository');

export interface CreateJobInput {
  tenantId: string;
  name: string;
  description: string;
  config: JobConfig;
  schemaId?: string;
}

export class JobRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateJobInput) {
    try {
      const [row] = await this.db
        .insert(jobs)
        .values({
          tenantId: input.tenantId,
          name: input.name,
          description: input.description,
          config: input.config,
          schemaId: input.schemaId,
        })
        .returning();

      logger.debug({ jobId: row.id }, 'job created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create job: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId: input.tenantId },
      });
    }
  }

  async findById(id: string, tenantId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.tenantId, tenantId)));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find job ${id}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, tenantId },
      });
    }
  }

  async findByTenant(tenantId: string, options?: { status?: JobStatus; limit?: number }) {
    try {
      let query = this.db
        .select()
        .from(jobs)
        .where(
          options?.status
            ? and(eq(jobs.tenantId, tenantId), eq(jobs.status, options.status))
            : eq(jobs.tenantId, tenantId),
        )
        .orderBy(desc(jobs.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to list jobs: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }

  async updateStatus(id: string, tenantId: string, status: JobStatus) {
    try {
      const timestamps: Record<string, Date> = {};
      if (status === 'running') timestamps.startedAt = new Date();
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        timestamps.completedAt = new Date();
      }

      const [row] = await this.db
        .update(jobs)
        .set({ status, ...timestamps })
        .where(and(eq(jobs.id, id), eq(jobs.tenantId, tenantId)))
        .returning();

      if (!row) {
        throw new StorageError(`Job ${id} not found`, { context: { id, tenantId } });
      }

      logger.debug({ jobId: id, status }, 'job status updated');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update job status: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, tenantId, status },
      });
    }
  }

  async updateStats(id: string, tenantId: string, stats: Record<string, number>) {
    try {
      const [row] = await this.db
        .update(jobs)
        .set({ stats })
        .where(and(eq(jobs.id, id), eq(jobs.tenantId, tenantId)))
        .returning();

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to update job stats: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, tenantId },
      });
    }
  }
}
```

Create `packages/db/src/repositories/index.ts`:

```typescript
export { JobRepository } from './job-repository.js';
export type { CreateJobInput } from './job-repository.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/job-repository.test.ts`
Expected: PASS — all 6 tests

**Step 5: Commit**

```bash
git add packages/db/src/repositories/job-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/job-repository.test.ts
git commit -m "feat(db): add JobRepository with CRUD, status transitions, and tenant isolation"
```

---

## Task 9: Repository — Crawl Task Repository

**Files:**
- Create: `packages/db/src/repositories/crawl-task-repository.ts`
- Create: `packages/db/tests/unit/repositories/crawl-task-repository.test.ts`
- Modify: `packages/db/src/repositories/index.ts`

**Step 1: Write the failing test**

Create `packages/db/tests/unit/repositories/crawl-task-repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlTaskRepository } from '../../../src/repositories/crawl-task-repository.js';

function createMockDb() {
  const chainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'task-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'task-id' }]));

  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'task-id' }]) }) }),
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('CrawlTaskRepository', () => {
  let repo: CrawlTaskRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new CrawlTaskRepository(mockDb as any);
  });

  it('has enqueue method', () => {
    expect(typeof repo.enqueue).toBe('function');
  });

  it('has findByJob method', () => {
    expect(typeof repo.findByJob).toBe('function');
  });

  it('has updateStatus method', () => {
    expect(typeof repo.updateStatus).toBe('function');
  });

  it('has updateClassification method', () => {
    expect(typeof repo.updateClassification).toBe('function');
  });

  it('enqueue calls db.insert', async () => {
    await repo.enqueue({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      url: 'https://example.com',
      depth: 0,
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/crawl-task-repository.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `packages/db/src/repositories/crawl-task-repository.ts`:

```typescript
import { eq, and, asc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import type { PageClassification } from '@spatula/core';
import { crawlTasks } from '../schema/crawl-tasks.js';
import type { Database } from '../connection.js';

const logger = createLogger('crawl-task-repository');

type CrawlTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
type TaskPriority = 'high' | 'medium' | 'low';
type CrawlerType = 'playwright' | 'firecrawl';

export interface EnqueueTaskInput {
  jobId: string;
  tenantId: string;
  url: string;
  depth: number;
  priority?: TaskPriority;
  parentTaskId?: string;
  crawlerType?: CrawlerType;
}

export class CrawlTaskRepository {
  constructor(private readonly db: Database) {}

  async enqueue(input: EnqueueTaskInput) {
    try {
      const [row] = await this.db
        .insert(crawlTasks)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          url: input.url,
          depth: input.depth,
          priority: input.priority ?? 'medium',
          parentTaskId: input.parentTaskId,
          crawlerType: input.crawlerType,
        })
        .returning();

      logger.debug({ taskId: row.id, url: input.url }, 'crawl task enqueued');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to enqueue task: ${(error as Error).message}`, {
        cause: error as Error,
        context: { url: input.url, jobId: input.jobId },
      });
    }
  }

  async findByJob(jobId: string, options?: { status?: CrawlTaskStatus; limit?: number }) {
    try {
      let query = this.db
        .select()
        .from(crawlTasks)
        .where(
          options?.status
            ? and(eq(crawlTasks.jobId, jobId), eq(crawlTasks.status, options.status))
            : eq(crawlTasks.jobId, jobId),
        )
        .orderBy(asc(crawlTasks.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find tasks: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async updateStatus(id: string, status: CrawlTaskStatus) {
    try {
      const timestamps: Record<string, Date> = {};
      if (status === 'completed' || status === 'failed' || status === 'skipped') {
        timestamps.processedAt = new Date();
      }

      const [row] = await this.db
        .update(crawlTasks)
        .set({ status, ...timestamps })
        .where(eq(crawlTasks.id, id))
        .returning();

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to update task status: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, status },
      });
    }
  }

  async updateClassification(id: string, classification: PageClassification) {
    try {
      const [row] = await this.db
        .update(crawlTasks)
        .set({ classification })
        .where(eq(crawlTasks.id, id))
        .returning();

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to update classification: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, classification },
      });
    }
  }
}
```

Update `packages/db/src/repositories/index.ts`:

```typescript
export { JobRepository } from './job-repository.js';
export type { CreateJobInput } from './job-repository.js';
export { CrawlTaskRepository } from './crawl-task-repository.js';
export type { EnqueueTaskInput } from './crawl-task-repository.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/crawl-task-repository.test.ts`
Expected: PASS — all 5 tests

**Step 5: Commit**

```bash
git add packages/db/src/repositories/crawl-task-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/crawl-task-repository.test.ts
git commit -m "feat(db): add CrawlTaskRepository with enqueue, status, and classification"
```

---

## Task 10: Repository — Schema Repository

**Files:**
- Create: `packages/db/src/repositories/schema-repository.ts`
- Create: `packages/db/tests/unit/repositories/schema-repository.test.ts`
- Modify: `packages/db/src/repositories/index.ts`

**Step 1: Write the failing test**

Create `packages/db/tests/unit/repositories/schema-repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaRepository } from '../../../src/repositories/schema-repository.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'schema-id', version: 1 }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'schema-id', version: 1 }]));

  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'schema-id', version: 1 }]) }) }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('SchemaRepository', () => {
  let repo: SchemaRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new SchemaRepository(mockDb as any);
  });

  it('has create method', () => {
    expect(typeof repo.create).toBe('function');
  });

  it('has findLatest method', () => {
    expect(typeof repo.findLatest).toBe('function');
  });

  it('has findByVersion method', () => {
    expect(typeof repo.findByVersion).toBe('function');
  });

  it('has findAllVersions method', () => {
    expect(typeof repo.findAllVersions).toBe('function');
  });

  it('create calls db.insert', async () => {
    await repo.create({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      version: 1,
      definition: {} as any,
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/schema-repository.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `packages/db/src/repositories/schema-repository.ts`:

```typescript
import { eq, and, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import type { SchemaDefinition } from '@spatula/core';
import { schemasTable } from '../schema/schemas.js';
import type { Database } from '../connection.js';

const logger = createLogger('schema-repository');

export interface CreateSchemaInput {
  jobId: string;
  tenantId: string;
  version: number;
  definition: SchemaDefinition;
  parentId?: string;
}

export class SchemaRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateSchemaInput) {
    try {
      const [row] = await this.db
        .insert(schemasTable)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          version: input.version,
          definition: input.definition,
          parentId: input.parentId,
        })
        .returning();

      logger.debug({ schemaId: row.id, version: input.version }, 'schema version created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create schema: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId, version: input.version },
      });
    }
  }

  async findLatest(jobId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(schemasTable)
        .where(eq(schemasTable.jobId, jobId))
        .orderBy(desc(schemasTable.version))
        .limit(1);

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find latest schema: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async findByVersion(jobId: string, version: number) {
    try {
      const [row] = await this.db
        .select()
        .from(schemasTable)
        .where(and(eq(schemasTable.jobId, jobId), eq(schemasTable.version, version)));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find schema version: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, version },
      });
    }
  }

  async findAllVersions(jobId: string) {
    try {
      return await this.db
        .select()
        .from(schemasTable)
        .where(eq(schemasTable.jobId, jobId))
        .orderBy(desc(schemasTable.version));
    } catch (error) {
      throw new StorageError(`Failed to list schema versions: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }
}
```

Update `packages/db/src/repositories/index.ts`:

```typescript
export { JobRepository } from './job-repository.js';
export type { CreateJobInput } from './job-repository.js';
export { CrawlTaskRepository } from './crawl-task-repository.js';
export type { EnqueueTaskInput } from './crawl-task-repository.js';
export { SchemaRepository } from './schema-repository.js';
export type { CreateSchemaInput } from './schema-repository.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/schema-repository.test.ts`
Expected: PASS — all 5 tests

**Step 5: Commit**

```bash
git add packages/db/src/repositories/schema-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/schema-repository.test.ts
git commit -m "feat(db): add SchemaRepository with versioning and latest-fetch"
```

---

## Task 11: Repository — Extraction Repository

**Files:**
- Create: `packages/db/src/repositories/extraction-repository.ts`
- Create: `packages/db/tests/unit/repositories/extraction-repository.test.ts`
- Modify: `packages/db/src/repositories/index.ts`

**Step 1: Write the failing test**

Create `packages/db/tests/unit/repositories/extraction-repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtractionRepository } from '../../../src/repositories/extraction-repository.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'extraction-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'extraction-id' }]));

  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'extraction-id' }]) }) }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('ExtractionRepository', () => {
  let repo: ExtractionRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new ExtractionRepository(mockDb as any);
  });

  it('has store method', () => {
    expect(typeof repo.store).toBe('function');
  });

  it('has findByJob method', () => {
    expect(typeof repo.findByJob).toBe('function');
  });

  it('has findByPage method', () => {
    expect(typeof repo.findByPage).toBe('function');
  });

  it('store calls db.insert', async () => {
    await repo.store({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      pageId: '550e8400-e29b-41d4-a716-446655440002',
      schemaVersion: 1,
      data: { name: 'Test' },
      unmappedFields: [],
      metadata: { confidence: 0.9, modelUsed: 'test', tokensUsed: 100, extractionTimeMs: 50, unmappedFields: [] },
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/extraction-repository.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `packages/db/src/repositories/extraction-repository.ts`:

```typescript
import { eq, and, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { extractions } from '../schema/extractions.js';
import type { Database } from '../connection.js';

const logger = createLogger('extraction-repository');

export interface StoreExtractionInput {
  jobId: string;
  tenantId: string;
  pageId: string;
  schemaVersion: number;
  data: Record<string, unknown>;
  unmappedFields: unknown[];
  metadata: Record<string, unknown>;
}

export class ExtractionRepository {
  constructor(private readonly db: Database) {}

  async store(input: StoreExtractionInput) {
    try {
      const [row] = await this.db
        .insert(extractions)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          pageId: input.pageId,
          schemaVersion: input.schemaVersion,
          data: input.data,
          unmappedFields: input.unmappedFields,
          metadata: input.metadata,
        })
        .returning();

      logger.debug({ extractionId: row.id, pageId: input.pageId }, 'extraction stored');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to store extraction: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId: input.jobId, pageId: input.pageId },
      });
    }
  }

  async findByJob(jobId: string, options?: { schemaVersion?: number; limit?: number }) {
    try {
      let query = this.db
        .select()
        .from(extractions)
        .where(
          options?.schemaVersion
            ? and(eq(extractions.jobId, jobId), eq(extractions.schemaVersion, options.schemaVersion))
            : eq(extractions.jobId, jobId),
        )
        .orderBy(desc(extractions.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find extractions: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async findByPage(pageId: string) {
    try {
      return await this.db
        .select()
        .from(extractions)
        .where(eq(extractions.pageId, pageId))
        .orderBy(desc(extractions.createdAt));
    } catch (error) {
      throw new StorageError(`Failed to find extractions for page: ${(error as Error).message}`, {
        cause: error as Error,
        context: { pageId },
      });
    }
  }
}
```

Update `packages/db/src/repositories/index.ts`:

```typescript
export { JobRepository } from './job-repository.js';
export type { CreateJobInput } from './job-repository.js';
export { CrawlTaskRepository } from './crawl-task-repository.js';
export type { EnqueueTaskInput } from './crawl-task-repository.js';
export { SchemaRepository } from './schema-repository.js';
export type { CreateSchemaInput } from './schema-repository.js';
export { ExtractionRepository } from './extraction-repository.js';
export type { StoreExtractionInput } from './extraction-repository.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/extraction-repository.test.ts`
Expected: PASS — all 4 tests

**Step 5: Commit**

```bash
git add packages/db/src/repositories/extraction-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/extraction-repository.test.ts
git commit -m "feat(db): add ExtractionRepository with store, findByJob, and findByPage"
```

---

## Task 12: Repository — Page Repository & PostgreSQL Content Store

**Files:**
- Create: `packages/db/src/repositories/page-repository.ts`
- Create: `packages/db/src/content-store/pg-content-store.ts`
- Create: `packages/db/tests/unit/repositories/page-repository.test.ts`
- Create: `packages/db/tests/unit/content-store/pg-content-store.test.ts`
- Modify: `packages/db/src/repositories/index.ts`

**Step 1: Write the failing tests**

Create `packages/db/tests/unit/repositories/page-repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PageRepository } from '../../../src/repositories/page-repository.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'page-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'page-id' }]));

  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'page-id' }]) }) }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
    delete: vi.fn().mockReturnValue(chainable),
  };
}

describe('PageRepository', () => {
  let repo: PageRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new PageRepository(mockDb as any);
  });

  it('has create method', () => {
    expect(typeof repo.create).toBe('function');
  });

  it('has findByContentHash method', () => {
    expect(typeof repo.findByContentHash).toBe('function');
  });

  it('has findByTask method', () => {
    expect(typeof repo.findByTask).toBe('function');
  });

  it('create calls db.insert', async () => {
    await repo.create({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      contentRef: 'pg://content/abc123',
      contentHash: 'sha256-abc123',
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
```

Create `packages/db/tests/unit/content-store/pg-content-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgContentStore } from '../../../src/content-store/pg-content-store.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'content-id', content: '<html>test</html>' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) =>
    resolve([{ id: 'content-id', content: '<html>test</html>' }]),
  );

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'content-id' }]),
      }),
    }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
    delete: vi.fn().mockReturnValue(chainable),
  };
}

describe('PgContentStore', () => {
  let store: PgContentStore;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    store = new PgContentStore(mockDb as any);
  });

  it('implements ContentStore interface — store()', () => {
    expect(typeof store.store).toBe('function');
  });

  it('implements ContentStore interface — retrieve()', () => {
    expect(typeof store.retrieve).toBe('function');
  });

  it('implements ContentStore interface — delete()', () => {
    expect(typeof store.delete).toBe('function');
  });

  it('store calls db.insert', async () => {
    const ref = await store.store('test-key', '<html>content</html>');
    expect(ref).toBeDefined();
    expect(typeof ref).toBe('string');
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/page-repository.test.ts tests/unit/content-store/pg-content-store.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create a content storage table. Create `packages/db/src/schema/content.ts`:

```typescript
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

export const contentStore = pgTable('content_store', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Add to `packages/db/src/schema/index.ts`:
```typescript
export * from './content.js';
```

Create `packages/db/src/content-store/pg-content-store.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { StorageError, createLogger } from '@spatula/shared';
import type { ContentStore } from '@spatula/core';
import { contentStore } from '../schema/content.js';
import type { Database } from '../connection.js';

const logger = createLogger('pg-content-store');

export class PgContentStore implements ContentStore {
  constructor(private readonly db: Database) {}

  async store(key: string, content: string): Promise<string> {
    try {
      const [row] = await this.db
        .insert(contentStore)
        .values({ key, content })
        .returning();

      const ref = `pg://${row.id}`;
      logger.debug({ ref, key }, 'content stored');
      return ref;
    } catch (error) {
      throw new StorageError(`Failed to store content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { key },
      });
    }
  }

  async retrieve(ref: string): Promise<string> {
    const id = ref.replace('pg://', '');
    try {
      const [row] = await this.db
        .select()
        .from(contentStore)
        .where(eq(contentStore.id, id));

      if (!row) {
        throw new StorageError(`Content not found: ${ref}`, { context: { ref } });
      }

      return row.content;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to retrieve content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }

  async delete(ref: string): Promise<void> {
    const id = ref.replace('pg://', '');
    try {
      await this.db
        .delete(contentStore)
        .where(eq(contentStore.id, id));

      logger.debug({ ref }, 'content deleted');
    } catch (error) {
      throw new StorageError(`Failed to delete content: ${(error as Error).message}`, {
        cause: error as Error,
        context: { ref },
      });
    }
  }
}
```

Create `packages/db/src/repositories/page-repository.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import { rawPages } from '../schema/raw-pages.js';
import type { Database } from '../connection.js';

const logger = createLogger('page-repository');

export interface CreatePageInput {
  taskId: string;
  tenantId: string;
  contentRef: string;
  contentHash: string;
  metadata?: Record<string, unknown>;
}

export class PageRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreatePageInput) {
    try {
      const [row] = await this.db
        .insert(rawPages)
        .values({
          taskId: input.taskId,
          tenantId: input.tenantId,
          contentRef: input.contentRef,
          contentHash: input.contentHash,
          metadata: input.metadata ?? {},
        })
        .returning();

      logger.debug({ pageId: row.id, taskId: input.taskId }, 'page created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create page: ${(error as Error).message}`, {
        cause: error as Error,
        context: { taskId: input.taskId },
      });
    }
  }

  async findByContentHash(contentHash: string) {
    try {
      const [row] = await this.db
        .select()
        .from(rawPages)
        .where(eq(rawPages.contentHash, contentHash));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find page by hash: ${(error as Error).message}`, {
        cause: error as Error,
        context: { contentHash },
      });
    }
  }

  async findByTask(taskId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(rawPages)
        .where(eq(rawPages.taskId, taskId));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find page: ${(error as Error).message}`, {
        cause: error as Error,
        context: { taskId },
      });
    }
  }
}
```

Update `packages/db/src/repositories/index.ts`:

```typescript
export { JobRepository } from './job-repository.js';
export type { CreateJobInput } from './job-repository.js';
export { CrawlTaskRepository } from './crawl-task-repository.js';
export type { EnqueueTaskInput } from './crawl-task-repository.js';
export { SchemaRepository } from './schema-repository.js';
export type { CreateSchemaInput } from './schema-repository.js';
export { ExtractionRepository } from './extraction-repository.js';
export type { StoreExtractionInput } from './extraction-repository.js';
export { PageRepository } from './page-repository.js';
export type { CreatePageInput } from './page-repository.js';
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/db && pnpm vitest run tests/unit/repositories/page-repository.test.ts tests/unit/content-store/pg-content-store.test.ts`
Expected: PASS — all 8 tests

**Step 5: Commit**

```bash
git add packages/db/src/schema/content.ts packages/db/src/schema/index.ts packages/db/src/content-store/pg-content-store.ts packages/db/src/repositories/page-repository.ts packages/db/src/repositories/index.ts packages/db/tests/unit/repositories/page-repository.test.ts packages/db/tests/unit/content-store/pg-content-store.test.ts
git commit -m "feat(db): add PageRepository, PgContentStore, and content_store table"
```

---

## Task 13: Package Barrel Export

**Files:**
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/tests/unit/exports.test.ts`

**Step 1: Write the failing test**

Create `packages/db/tests/unit/exports.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('package exports', () => {
  it('exports connection factory', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.createDatabase).toBeDefined();
  });

  it('exports all schema tables', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.tenants).toBeDefined();
    expect(mod.jobs).toBeDefined();
    expect(mod.schemasTable).toBeDefined();
    expect(mod.crawlTasks).toBeDefined();
    expect(mod.rawPages).toBeDefined();
    expect(mod.extractions).toBeDefined();
    expect(mod.entities).toBeDefined();
    expect(mod.entitySources).toBeDefined();
    expect(mod.actions).toBeDefined();
    expect(mod.sourceTrust).toBeDefined();
    expect(mod.contentStore).toBeDefined();
  });

  it('exports all enums', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.jobStatusEnum).toBeDefined();
    expect(mod.crawlTaskStatusEnum).toBeDefined();
    expect(mod.actionSourceEnum).toBeDefined();
  });

  it('exports all repositories', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.JobRepository).toBeDefined();
    expect(mod.CrawlTaskRepository).toBeDefined();
    expect(mod.SchemaRepository).toBeDefined();
    expect(mod.ExtractionRepository).toBeDefined();
    expect(mod.PageRepository).toBeDefined();
  });

  it('exports PgContentStore', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.PgContentStore).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run tests/unit/exports.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Update `packages/db/src/index.ts`:

```typescript
// Schema
export * from './schema/index.js';

// Connection
export { createDatabase } from './connection.js';
export type { Database } from './connection.js';

// Repositories
export * from './repositories/index.js';

// Content Store
export { PgContentStore } from './content-store/pg-content-store.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run tests/unit/exports.test.ts`
Expected: PASS — all 5 tests

**Step 5: Commit**

```bash
git add packages/db/src/index.ts packages/db/tests/unit/exports.test.ts
git commit -m "feat(db): add package barrel exports for schema, repositories, and content store"
```

---

## Task 14: Final Verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass across all packages

**Step 2: Run typecheck**

Run: `pnpm build`
Expected: Clean build, no errors

**Step 3: Run linter**

Run: `pnpm lint`
Expected: No lint errors

**Step 4: Run formatter**

Run: `pnpm format:check`
Expected: All files formatted. If not, run `npx prettier --write` on the offending files.

**Step 5: Verify test count**

Expected: ~210+ tests total (185 from Phase 3 + new tests from Phase 4)

**Step 6: Commit any format fixes**

```bash
git add -A
git commit -m "chore: format Phase 4 files"
```

---

## Summary

| Task | Component | Tests |
|------|-----------|-------|
| 1 | Dependencies & drizzle.config | — |
| 2 | Connection factory | 3 |
| 3 | Enum declarations | 8 |
| 4 | Core tables (tenants, jobs, schemas) | 3 |
| 5 | Crawl tables (crawl_tasks, raw_pages) | 2 |
| 6 | Extraction tables (extractions, entities) | 3 |
| 7 | Audit tables (actions, source_trust) | 2 |
| 8 | JobRepository | 6 |
| 9 | CrawlTaskRepository | 5 |
| 10 | SchemaRepository | 5 |
| 11 | ExtractionRepository | 4 |
| 12 | PageRepository + PgContentStore | 8 |
| 13 | Package barrel export | 5 |
| 14 | Final verification | — |
| **Total** | | **~54** |
