# Wave 5-5: Pull Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `spatula pull` — fetch entities, schema, and usage from a remote Spatula server to the local project, with schema conflict resolution, incremental pull, crash recovery, and explorer source filtering.

**Architecture:** The pull command uses `SpatulaApiClient` to fetch remote data via cursor-paginated streaming, upserts entities into local SQLite via `ProjectAdapter`, tracks pull state in `project_meta` for crash recovery, and creates a `RunRepository` record tagged with `source: 'remote:<name>:<jobId>'`. Schema conflicts are resolved via an Ink TUI component. The explorer gains a `[s]` source filter toggle.

**Tech Stack:** TypeScript, Vitest, Ink (React CLI), Drizzle ORM (SQLite), yargs (CLI)

**Design spec:** `docs/superpowers/specs/2026-04-08-wave-5-5-pull-flow-design.md`

---

### Task 1: Schema Diff Utility

**Files:**

- Create: `apps/cli/src/lib/schema-diff.ts`
- Test: `apps/cli/tests/unit/lib/schema-diff.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/cli/tests/unit/lib/schema-diff.test.ts
import { describe, it, expect } from 'vitest';
import { diffSchemas } from '../../../src/lib/schema-diff.js';
import type { SchemaDiff } from '../../../src/lib/schema-diff.js';

function field(name: string, type = 'string', required = false) {
  return { name, description: `${name} field`, type, required };
}

function schema(fields: unknown[], version = 1) {
  return {
    version,
    fields,
    fieldAliases: [],
    createdAt: new Date('2026-01-01'),
    parentVersion: null,
  };
}

describe('diffSchemas', () => {
  it('returns no changes for identical schemas', () => {
    const s = schema([field('name'), field('price', 'currency')]);
    const diff = diffSchemas(s, s);
    expect(diff.hasChanges).toBe(false);
    expect(diff.localOnly).toHaveLength(0);
    expect(diff.remoteOnly).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(2);
  });

  it('detects fields only in local', () => {
    const local = schema([field('name'), field('color')]);
    const remote = schema([field('name')]);
    const diff = diffSchemas(local, remote);
    expect(diff.hasChanges).toBe(true);
    expect(diff.localOnly).toHaveLength(1);
    expect(diff.localOnly[0].name).toBe('color');
  });

  it('detects fields only in remote', () => {
    const local = schema([field('name')]);
    const remote = schema([field('name'), field('price', 'currency')]);
    const diff = diffSchemas(local, remote);
    expect(diff.hasChanges).toBe(true);
    expect(diff.remoteOnly).toHaveLength(1);
    expect(diff.remoteOnly[0].name).toBe('price');
  });

  it('detects type changes in shared fields', () => {
    const local = schema([field('price', 'string')]);
    const remote = schema([field('price', 'currency')]);
    const diff = diffSchemas(local, remote);
    expect(diff.hasChanges).toBe(true);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].name).toBe('price');
    expect(diff.changed[0].differences).toContain('type: string \u2192 currency');
  });

  it('detects required flag changes', () => {
    const local = schema([field('name', 'string', false)]);
    const remote = schema([field('name', 'string', true)]);
    const diff = diffSchemas(local, remote);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].differences).toContain('required: false \u2192 true');
  });

  it('handles empty schemas', () => {
    const diff = diffSchemas(schema([]), schema([]));
    expect(diff.hasChanges).toBe(false);
    expect(diff.unchanged).toHaveLength(0);
  });

  it('handles one empty schema against a populated one', () => {
    const diff = diffSchemas(schema([]), schema([field('a'), field('b')]));
    expect(diff.hasChanges).toBe(true);
    expect(diff.remoteOnly).toHaveLength(2);
    expect(diff.localOnly).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm vitest run tests/unit/lib/schema-diff.test.ts`
Expected: FAIL — module `../../../src/lib/schema-diff.js` not found

- [ ] **Step 3: Implement schema-diff.ts**

```typescript
// apps/cli/src/lib/schema-diff.ts

interface FieldDef {
  name: string;
  description: string;
  type: string;
  required: boolean;
  [key: string]: unknown;
}

interface SchemaLike {
  version: number;
  fields: FieldDef[];
  [key: string]: unknown;
}

export interface SchemaDiff {
  localOnly: FieldDef[];
  remoteOnly: FieldDef[];
  changed: Array<{
    name: string;
    local: FieldDef;
    remote: FieldDef;
    differences: string[];
  }>;
  unchanged: FieldDef[];
  hasChanges: boolean;
}

export function diffSchemas(local: SchemaLike, remote: SchemaLike): SchemaDiff {
  const localMap = new Map(local.fields.map((f) => [f.name, f]));
  const remoteMap = new Map(remote.fields.map((f) => [f.name, f]));

  const localOnly: FieldDef[] = [];
  const remoteOnly: FieldDef[] = [];
  const changed: SchemaDiff['changed'] = [];
  const unchanged: FieldDef[] = [];

  for (const [name, lf] of localMap) {
    const rf = remoteMap.get(name);
    if (!rf) {
      localOnly.push(lf);
    } else {
      const diffs = fieldDifferences(lf, rf);
      if (diffs.length > 0) {
        changed.push({ name, local: lf, remote: rf, differences: diffs });
      } else {
        unchanged.push(lf);
      }
    }
  }

  for (const [name, rf] of remoteMap) {
    if (!localMap.has(name)) {
      remoteOnly.push(rf);
    }
  }

  return {
    localOnly,
    remoteOnly,
    changed,
    unchanged,
    hasChanges: localOnly.length > 0 || remoteOnly.length > 0 || changed.length > 0,
  };
}

function fieldDifferences(local: FieldDef, remote: FieldDef): string[] {
  const diffs: string[] = [];
  if (local.type !== remote.type) {
    diffs.push(`type: ${local.type} \u2192 ${remote.type}`);
  }
  if (local.required !== remote.required) {
    diffs.push(`required: ${local.required} \u2192 ${remote.required}`);
  }
  return diffs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm vitest run tests/unit/lib/schema-diff.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/schema-diff.ts apps/cli/tests/unit/lib/schema-diff.test.ts
git commit -m "feat(cli): add schema diff utility for pull flow"
```

---

### Task 2: YAML Field Appender

**Files:**

- Create: `apps/cli/src/lib/yaml-fields.ts`
- Test: `apps/cli/tests/unit/lib/yaml-fields.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/cli/tests/unit/lib/yaml-fields.test.ts
import { describe, it, expect } from 'vitest';
import { appendFieldsToYaml } from '../../../src/lib/yaml-fields.js';

describe('appendFieldsToYaml', () => {
  it('appends fields after existing fields block', () => {
    const yaml = `name: My Crawl
seeds:
  - https://example.com
fields:
  - title: string
  - price: currency
depth: 2
`;
    const newFields = [
      { name: 'rating', type: 'number' },
      { name: 'brand', type: 'string', required: true },
    ];
    const result = appendFieldsToYaml(yaml, newFields, '2026-04-08');
    expect(result).toContain('# Discovered by remote crawl (2026-04-08):');
    expect(result).toContain('  - rating: number');
    expect(result).toContain('  - brand: string');
    // Existing content preserved
    expect(result).toContain('  - title: string');
    expect(result).toContain('depth: 2');
  });

  it('creates fields block if none exists', () => {
    const yaml = `name: My Crawl
seeds:
  - https://example.com
depth: 2
`;
    const newFields = [{ name: 'title', type: 'string' }];
    const result = appendFieldsToYaml(yaml, newFields, '2026-04-08');
    expect(result).toContain('fields:');
    expect(result).toContain('  - title: string');
  });

  it('handles extended field format for required fields', () => {
    const yaml = `name: Test
fields:
  - title: string
`;
    const newFields = [{ name: 'price', type: 'currency', required: true }];
    const result = appendFieldsToYaml(yaml, newFields, '2026-04-08');
    expect(result).toContain('  - field: price');
    expect(result).toContain('    type: currency');
    expect(result).toContain('    required: true');
  });

  it('handles empty fields array as no-op', () => {
    const yaml = `name: Test\nfields:\n  - title: string\n`;
    const result = appendFieldsToYaml(yaml, [], '2026-04-08');
    expect(result).toBe(yaml);
  });

  it('handles empty array fields syntax', () => {
    const yaml = `name: Test\nfields: []\ndepth: 2\n`;
    const newFields = [{ name: 'title', type: 'string' }];
    const result = appendFieldsToYaml(yaml, newFields, '2026-04-08');
    expect(result).toContain('fields:');
    expect(result).toContain('  - title: string');
    expect(result).not.toContain('[]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm vitest run tests/unit/lib/yaml-fields.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement yaml-fields.ts**

```typescript
// apps/cli/src/lib/yaml-fields.ts

interface FieldEntry {
  name: string;
  type: string;
  required?: boolean;
}

export function appendFieldsToYaml(
  yamlContent: string,
  fields: FieldEntry[],
  date: string,
): string {
  if (fields.length === 0) return yamlContent;

  const comment = `  # Discovered by remote crawl (${date}):`;
  const fieldLines = fields.map((f) => {
    if (f.required) {
      return `  - field: ${f.name}\n    type: ${f.type}\n    required: true`;
    }
    return `  - ${f.name}: ${f.type}`;
  });
  const block = `${comment}\n${fieldLines.join('\n')}\n`;

  // Handle "fields: []" — replace with populated block
  const emptyArrayMatch = yamlContent.match(/^(fields:\s*\[\])/m);
  if (emptyArrayMatch) {
    const idx = yamlContent.indexOf(emptyArrayMatch[0]);
    const before = yamlContent.slice(0, idx);
    const after = yamlContent.slice(idx + emptyArrayMatch[0].length);
    return `${before}fields:\n${block}${after}`;
  }

  // Find last field entry in existing fields block
  const fieldsHeaderMatch = yamlContent.match(/^fields:\s*$/m);
  if (fieldsHeaderMatch) {
    // Find the end of the fields block: last line starting with "  -"
    const lines = yamlContent.split('\n');
    let lastFieldLineIdx = -1;
    let inFieldsBlock = false;

    for (let i = 0; i < lines.length; i++) {
      if (/^fields:\s*$/.test(lines[i])) {
        inFieldsBlock = true;
        continue;
      }
      if (inFieldsBlock) {
        if (/^\s+-/.test(lines[i]) || /^\s+\w/.test(lines[i])) {
          lastFieldLineIdx = i;
        } else if (/^\S/.test(lines[i])) {
          break; // Next top-level key
        }
      }
    }

    if (lastFieldLineIdx >= 0) {
      // Insert after last field entry
      const before = lines.slice(0, lastFieldLineIdx + 1).join('\n');
      const after = lines.slice(lastFieldLineIdx + 1).join('\n');
      return `${before}\n${block}${after}`;
    }
    // fields: block with no entries yet
    const idx = yamlContent.indexOf(fieldsHeaderMatch[0]);
    const insertAt = idx + fieldsHeaderMatch[0].length;
    return `${yamlContent.slice(0, insertAt)}\n${block}${yamlContent.slice(insertAt)}`;
  }

  // No fields block — append one before depth/limit or at end
  const insertBeforeMatch = yamlContent.match(/^(depth|limit|crawler|safety|crawl|schema|llm):/m);
  if (insertBeforeMatch) {
    const idx = yamlContent.indexOf(insertBeforeMatch[0]);
    return `${yamlContent.slice(0, idx)}fields:\n${block}\n${yamlContent.slice(idx)}`;
  }

  return `${yamlContent.trimEnd()}\n\nfields:\n${block}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm vitest run tests/unit/lib/yaml-fields.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/yaml-fields.ts apps/cli/tests/unit/lib/yaml-fields.test.ts
git commit -m "feat(cli): add YAML field appender for pull schema merge"
```

---

### Task 3: SQLite Entities Table — Add `runId` Column

**Files:**

- Modify: `packages/db/src/schema-sqlite/entities.ts`
- Test: `packages/db/tests/unit/schema-sqlite/parity.test.ts` (verify no breakage)

- [ ] **Step 1: Add `runId` column to the entities table definition**

In `packages/db/src/schema-sqlite/entities.ts`, add `runId` field after `updatedAt`:

```typescript
// Add to the entities table columns, after updatedAt:
    runId: text('run_id'),
```

The column is nullable — existing entities and local crawl entities will have `runId = NULL`. Only pulled entities will have it set.

- [ ] **Step 2: Generate Drizzle migration for the new column**

Run: `cd packages/db && pnpm db:generate:sqlite`
Expected: Creates a new migration file (e.g., `drizzle-sqlite/0004_add_run_id.sql`) containing `ALTER TABLE entities ADD COLUMN run_id TEXT;`

Verify the migration file exists and contains the expected ALTER TABLE statement.

- [ ] **Step 3: Run existing tests to verify no breakage**

Run: `cd packages/db && pnpm vitest run tests/unit/schema-sqlite/parity.test.ts`
Expected: PASS — `runId` is a local-only column so it should not cause a parity mismatch. If parity test is strict on column names, a test exclusion for `runId` may be needed.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema-sqlite/entities.ts packages/db/drizzle-sqlite/
git commit -m "feat(db): add nullable runId column to SQLite entities table with migration"
```

---

### Task 4: Entity Repository Extensions

**Files:**

- Modify: `packages/db/src/project-db/repositories/entity-repository.ts`
- Test: `apps/cli/tests/unit/lib/entity-repo-pull.test.ts`

- [ ] **Step 1: Write failing tests for the new methods**

```typescript
// apps/cli/tests/unit/lib/entity-repo-pull.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { SqliteEntityRepository, sqliteSchema } from '@spatula/db';

const { entities } = sqliteSchema;
const { runs } = sqliteSchema;

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);

  // Create tables
  db.run(sql`CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    merged_data TEXT NOT NULL DEFAULT '{}',
    provenance TEXT NOT NULL DEFAULT '{}',
    categories TEXT NOT NULL DEFAULT '[]',
    quality_score REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    source_count INTEGER DEFAULT 0,
    updated_at TEXT,
    run_id TEXT
  )`);
  db.run(sql`CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'local',
    config_snapshot TEXT DEFAULT '{}',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    pages_crawled INTEGER DEFAULT 0,
    pages_reextracted INTEGER DEFAULT 0,
    entities_created INTEGER DEFAULT 0,
    llm_tokens_used INTEGER DEFAULT 0,
    llm_cost_usd REAL DEFAULT 0,
    error_message TEXT
  )`);

  return db;
}

describe('SqliteEntityRepository pull extensions', () => {
  let db: ReturnType<typeof createTestDb>;
  let repo: SqliteEntityRepository;
  const projectId = 'test-project';

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteEntityRepository(db, projectId);
  });

  describe('upsertBatch', () => {
    it('inserts new entities', async () => {
      const result = await repo.upsertBatch([
        {
          id: 'ent-1',
          mergedData: { name: 'Entity 1' },
          provenance: {},
          qualityScore: 0.9,
          categories: ['product'],
          runId: 'run-1',
        },
        {
          id: 'ent-2',
          mergedData: { name: 'Entity 2' },
          provenance: {},
          qualityScore: 0.8,
          categories: [],
          runId: 'run-1',
        },
      ]);
      expect(result.inserted).toBe(2);
      expect(result.updated).toBe(0);
      expect(await repo.countByJob(projectId, '')).toBe(2);
    });

    it('updates existing entities on conflict', async () => {
      // Insert first
      await repo.upsertBatch([
        {
          id: 'ent-1',
          mergedData: { name: 'Original' },
          provenance: {},
          qualityScore: 0.5,
          categories: [],
          runId: 'run-1',
        },
      ]);

      // Upsert with updated data
      const result = await repo.upsertBatch([
        {
          id: 'ent-1',
          mergedData: { name: 'Updated' },
          provenance: { name: { finalValue: 'Updated' } },
          qualityScore: 0.9,
          categories: ['product'],
          runId: 'run-2',
        },
      ]);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(1);

      const rows = await repo.findByJob(projectId, '', { limit: 10, offset: 0 });
      expect((rows[0] as { mergedData: { name: string } }).mergedData.name).toBe('Updated');
    });

    it('handles empty batch', async () => {
      const result = await repo.upsertBatch([]);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(0);
    });
  });

  describe('deleteByRunIds', () => {
    it('deletes entities matching the given run IDs', async () => {
      await repo.upsertBatch([
        {
          id: 'e1',
          mergedData: {},
          provenance: {},
          qualityScore: 0,
          categories: [],
          runId: 'run-a',
        },
        {
          id: 'e2',
          mergedData: {},
          provenance: {},
          qualityScore: 0,
          categories: [],
          runId: 'run-a',
        },
        {
          id: 'e3',
          mergedData: {},
          provenance: {},
          qualityScore: 0,
          categories: [],
          runId: 'run-b',
        },
      ]);
      const deleted = await repo.deleteByRunIds(['run-a']);
      expect(deleted).toBe(2);
      expect(await repo.countByJob(projectId, '')).toBe(1);
    });

    it('returns 0 for empty array', async () => {
      const deleted = await repo.deleteByRunIds([]);
      expect(deleted).toBe(0);
    });
  });

  describe('countBySource', () => {
    it('counts all entities', async () => {
      // Insert a run, then entities
      db.insert(runs)
        .values({
          id: 'run-local',
          status: 'completed',
          source: 'local',
          configSnapshot: {},
          startedAt: new Date().toISOString(),
        })
        .run();
      db.insert(runs)
        .values({
          id: 'run-remote',
          status: 'pulled',
          source: 'remote:prod:job-1',
          configSnapshot: {},
          startedAt: new Date().toISOString(),
        })
        .run();
      await repo.upsertBatch([
        {
          id: 'e1',
          mergedData: {},
          provenance: {},
          qualityScore: 0,
          categories: [],
          runId: 'run-local',
        },
        {
          id: 'e2',
          mergedData: {},
          provenance: {},
          qualityScore: 0,
          categories: [],
          runId: 'run-remote',
        },
        {
          id: 'e3',
          mergedData: {},
          provenance: {},
          qualityScore: 0,
          categories: [],
          runId: null as unknown as string,
        },
      ]);

      expect(await repo.countBySource('all')).toBe(3);
      expect(await repo.countBySource('local')).toBe(2); // run-local + null runId
      expect(await repo.countBySource('remote')).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm vitest run tests/unit/lib/entity-repo-pull.test.ts`
Expected: FAIL — `upsertBatch`, `deleteByRunIds`, `countBySource` not defined

- [ ] **Step 3: Implement the new methods**

Add to `packages/db/src/project-db/repositories/entity-repository.ts`:

```typescript
// Add imports at the top:
import { sql, inArray, eq, isNull, like } from 'drizzle-orm';
import { runs } from '../../schema-sqlite/runs.js';

// Add these methods to SqliteEntityRepository class:

  async upsertBatch(batch: Array<{
    id: string;
    mergedData: Record<string, unknown>;
    provenance: Record<string, unknown>;
    qualityScore: number;
    categories: unknown[];
    runId: string | null;
  }>): Promise<{ inserted: number; updated: number }> {
    if (batch.length === 0) return { inserted: 0, updated: 0 };

    const countBefore = await this.countByJob(this.projectId, '');
    const now = new Date().toISOString();

    wrapStorageError(() => {
      for (const entity of batch) {
        this.db
          .insert(entities)
          .values({
            id: entity.id,
            jobId: this.projectId,
            mergedData: entity.mergedData,
            provenance: entity.provenance,
            qualityScore: entity.qualityScore,
            categories: entity.categories,
            createdAt: now,
            updatedAt: now,
            runId: entity.runId,
          })
          .onConflictDoUpdate({
            target: entities.id,
            set: {
              mergedData: entity.mergedData,
              provenance: entity.provenance,
              qualityScore: entity.qualityScore,
              categories: entity.categories,
              updatedAt: now,
              runId: entity.runId,
            },
          })
          .run();
      }
    }, { method: 'upsertBatch', table: 'entities' });

    const countAfter = await this.countByJob(this.projectId, '');
    const inserted = countAfter - countBefore;
    const updated = batch.length - inserted;
    return { inserted, updated };
  }

  async deleteByRunIds(runIds: string[]): Promise<number> {
    if (runIds.length === 0) return 0;

    const countBefore = await this.countByJob(this.projectId, '');
    wrapStorageError(() => {
      this.db
        .delete(entities)
        .where(inArray(entities.runId, runIds))
        .run();
    }, { method: 'deleteByRunIds', table: 'entities' });
    const countAfter = await this.countByJob(this.projectId, '');
    return countBefore - countAfter;
  }

  async countBySource(filter: 'all' | 'local' | 'remote'): Promise<number> {
    if (filter === 'all') {
      return this.countByJob(this.projectId, '');
    }

    let result: { count: number }[];
    if (filter === 'local') {
      // Local = runId is NULL or run.source = 'local'
      result = this.db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .leftJoin(runs, eq(entities.runId, runs.id))
        .where(sql`${entities.jobId} = ${this.projectId} AND (${entities.runId} IS NULL OR ${runs.source} = 'local')`)
        .all();
    } else {
      // Remote = run.source LIKE 'remote:%'
      result = this.db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .innerJoin(runs, eq(entities.runId, runs.id))
        .where(sql`${entities.jobId} = ${this.projectId} AND ${runs.source} LIKE 'remote:%'`)
        .all();
    }

    return Number(result[0]?.count ?? 0);
  }

  async findByJobFiltered(
    _jobId: string,
    _tenantId: string,
    options?: { limit: number; offset: number; sourceFilter?: 'all' | 'local' | 'remote' },
  ): Promise<unknown[]> {
    const filter = options?.sourceFilter ?? 'all';

    if (filter === 'all') {
      return this.findByJob(_jobId, _tenantId, options);
    }

    let query;
    if (filter === 'local') {
      query = this.db
        .select({
          id: entities.id, jobId: entities.jobId,
          mergedData: entities.mergedData, categories: entities.categories,
          qualityScore: entities.qualityScore, createdAt: entities.createdAt,
          sourceCount: entities.sourceCount,
        })
        .from(entities)
        .leftJoin(runs, eq(entities.runId, runs.id))
        .where(sql`${entities.jobId} = ${this.projectId} AND (${entities.runId} IS NULL OR ${runs.source} = 'local')`)
        .orderBy(desc(entities.qualityScore));
    } else {
      query = this.db
        .select({
          id: entities.id, jobId: entities.jobId,
          mergedData: entities.mergedData, categories: entities.categories,
          qualityScore: entities.qualityScore, createdAt: entities.createdAt,
          sourceCount: entities.sourceCount,
        })
        .from(entities)
        .innerJoin(runs, eq(entities.runId, runs.id))
        .where(sql`${entities.jobId} = ${this.projectId} AND ${runs.source} LIKE 'remote:%'`)
        .orderBy(desc(entities.qualityScore));
    }

    if (options?.limit !== undefined) {
      query = query.limit(options.limit) as typeof query;
    }
    if (options?.offset !== undefined) {
      query = query.offset(options.offset) as typeof query;
    }

    return query.all();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm vitest run tests/unit/lib/entity-repo-pull.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Add `findIdsBySourcePrefix` to RunRepository**

In `packages/db/src/project-db/repositories/run-repository.ts`, add:

```typescript
// Add import at top:
import { like } from 'drizzle-orm';

// Add method to RunRepository class:
  async findIdsBySourcePrefix(prefix: string): Promise<string[]> {
    const rows = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(like(runs.source, `${prefix}%`))
      .all();
    return rows.map((r) => r.id);
  }
```

- [ ] **Step 6: Run full existing test suites to check for regressions**

Run: `cd packages/db && pnpm vitest run tests/unit/`
Expected: All existing tests still PASS

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/project-db/repositories/entity-repository.ts packages/db/src/project-db/repositories/run-repository.ts apps/cli/tests/unit/lib/entity-repo-pull.test.ts
git commit -m "feat(db): add pull-flow methods to SQLite entity and run repos"
```

---

### Task 5: Expand `LocalProject` Interface

**Files:**

- Modify: `apps/cli/src/local-project.ts`

- [ ] **Step 1: Add `adapter` to the `LocalProject` interface and return value**

In `apps/cli/src/local-project.ts`:

Add the import:

```typescript
import type { ProjectAdapter as ProjectAdapterType } from '@spatula/db';
```

Add to the `LocalProject` interface:

```typescript
export interface LocalProject {
  dataSource: DataSource;
  projectRoot: string;
  projectId: string;
  metaRepo: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    deleteByPrefix(prefix: string): Promise<void>;
  };
  adapter: ProjectAdapterType;
  close(): void;
}
```

Add to the return object in `openLocalProject()`:

```typescript
return {
  dataSource,
  projectRoot,
  projectId,
  metaRepo: adapter.metaRepo,
  adapter,
  close: () => dbResult.close(),
};
```

- [ ] **Step 2: Run existing tests that use LocalProject**

Run: `cd apps/cli && pnpm vitest run tests/unit/commands/push.test.ts`
Expected: PASS — push tests mock openLocalProject, so they won't break

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/local-project.ts
git commit -m "feat(cli): expose ProjectAdapter on LocalProject interface"
```

---

### Task 6: `SpatulaApiClient` Extensions

**Files:**

- Modify: `apps/cli/src/api/client.ts`
- Test: `apps/cli/tests/unit/api/client-pull.test.ts`

- [ ] **Step 1: Write failing tests for the new methods**

```typescript
// apps/cli/tests/unit/api/client-pull.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpatulaApiClient } from '../../../src/api/client.js';

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

describe('SpatulaApiClient pull methods', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('getEntitiesStreamPaginated', () => {
    it('returns data and pagination from cursor endpoint', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({
        data: [{ id: 'e1', mergedData: { name: 'A' } }],
        pagination: { nextCursor: 'abc123', hasMore: true, total: 100 },
      });

      const result = await client.getEntitiesStreamPaginated('job-1', { limit: 500 });
      expect(result.data).toHaveLength(1);
      expect(result.pagination.nextCursor).toBe('abc123');
      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.total).toBe(100);
    });

    it('passes cursor and since as query params', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({ data: [], pagination: { hasMore: false, total: 0 } });

      await client.getEntitiesStreamPaginated('job-1', {
        cursor: 'cur-1',
        since: '2026-04-01T00:00:00Z',
        limit: 100,
      });

      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = fetchCall[0] as string;
      expect(url).toContain('cursor=cur-1');
      expect(url).toContain('since=2026-04-01T00%3A00%3A00Z');
      expect(url).toContain('limit=100');
    });
  });

  describe('getUsage', () => {
    it('fetches tenant usage summary', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1', { apiKey: 'sk_test' });
      mockFetch({
        data: {
          period: { start: '2026-03-01', end: '2026-04-01' },
          totalTokens: 50000,
          totalCostUsd: 1.5,
          byModel: {},
          byPurpose: {},
          byJob: [{ jobId: 'j1', tokens: 50000, costUsd: 1.5 }],
        },
      });

      const result = await client.getUsage({ period: '30d' });
      expect(result.totalTokens).toBe(50000);
      expect(result.byJob).toHaveLength(1);
    });

    it('defaults to 30d period', async () => {
      const client = new SpatulaApiClient('https://api.test', 't1');
      mockFetch({
        data: {
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
          period: {},
        },
      });

      await client.getUsage();
      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('period=30d');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm vitest run tests/unit/api/client-pull.test.ts`
Expected: FAIL — methods not found

- [ ] **Step 3: Implement the new methods in SpatulaApiClient**

Add to `apps/cli/src/api/client.ts` in the `SpatulaApiClient` class:

```typescript
  async getEntitiesStreamPaginated(
    jobId: string,
    query?: { cursor?: string; since?: string; limit?: number },
  ): Promise<{
    data: Record<string, unknown>[];
    pagination: { nextCursor?: string; hasMore: boolean; total: number };
  }> {
    const url = this.buildUrl(`/api/v1/jobs/${jobId}/entities`, {
      ...(query?.cursor ? { cursor: query.cursor } : {}),
      ...(query?.since ? { since: query.since } : {}),
      ...(query?.limit ? { limit: String(query.limit) } : {}),
    });

    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(
        response.status,
        (body as { error?: { code?: string } }).error?.code,
        (body as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`,
      );
    }

    const json = await response.json();
    return {
      data: ((json as { data?: unknown }).data ?? []) as Record<string, unknown>[],
      pagination: (json as { pagination?: unknown }).pagination as {
        nextCursor?: string;
        hasMore: boolean;
        total: number;
      },
    };
  }

  async getUsage(query?: { period?: string }): Promise<{
    period: { start: string; end: string };
    totalTokens: number;
    totalCostUsd: number;
    byModel: Record<string, { tokens: number; costUsd: number }>;
    byPurpose: Record<string, { tokens: number; costUsd: number }>;
    byJob: Array<{ jobId: string; tokens: number; costUsd: number }>;
  }> {
    return this.get(`/api/v1/usage`, {
      period: query?.period ?? '30d',
    });
  }
```

The existing client already has a private `headers()` method (line ~325) that returns the correct headers including auth. Use it directly in `getEntitiesStreamPaginated()` — call `this.headers()`. No renaming needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm vitest run tests/unit/api/client-pull.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run existing API client tests for regressions**

Run: `cd apps/cli && pnpm vitest run tests/unit/api/client.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/api/client.ts apps/cli/tests/unit/api/client-pull.test.ts
git commit -m "feat(cli): add getEntitiesStreamPaginated and getUsage to SpatulaApiClient"
```

---

### Task 7: Pull Command — Core Flow

**Files:**

- Create: `apps/cli/src/commands/pull.ts`
- Test: `apps/cli/tests/unit/commands/pull.test.ts`

- [ ] **Step 1: Write failing tests for the core pull flow**

```typescript
// apps/cli/tests/unit/commands/pull.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runPullCommand } from '../../../src/commands/pull.js';
import type { GlobalConfig } from '@spatula/core';

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(
      () =>
        ({
          version: 1,
          remotes: {
            prod: { url: 'https://api.spatula.dev', apiKey: 'sk_live_abc' },
          },
        }) as GlobalConfig,
    ),
  };
});

const mockMetaGet = vi.fn();
const mockMetaSet = vi.fn();
const mockMetaDelete = vi.fn();

const mockUpsertBatch = vi.fn().mockResolvedValue({ inserted: 5, updated: 0 });
const mockDeleteByRunIds = vi.fn().mockResolvedValue(0);
const mockSchemaFindLatest = vi.fn().mockResolvedValue(null);
const mockSchemaCreate = vi.fn().mockResolvedValue({ id: 'schema-1' });
const mockRunCreate = vi.fn().mockResolvedValue({ id: 'run-1' });
const mockRunUpdateStats = vi.fn();

const mockFindIdsBySourcePrefix = vi.fn().mockResolvedValue([]);

function buildMockAdapter() {
  return {
    entityRepo: { upsertBatch: mockUpsertBatch, deleteByRunIds: mockDeleteByRunIds },
    schemaRepo: { findLatest: mockSchemaFindLatest, create: mockSchemaCreate },
    runRepo: {
      create: mockRunCreate,
      updateStats: mockRunUpdateStats,
      findIdsBySourcePrefix: mockFindIdsBySourcePrefix,
    },
  };
}

function mockFetchSequence(
  responses: Array<{ data: unknown; pagination?: unknown; status?: number }>,
) {
  let callIdx = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      const resp = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      const status = resp.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () =>
          Promise.resolve(
            resp.pagination
              ? { data: resp.data, pagination: resp.pagination }
              : { data: resp.data },
          ),
      });
    }),
  );
}

describe('runPullCommand', () => {
  beforeEach(() => {
    mockMetaGet.mockReset();
    mockMetaSet.mockReset();
    mockMetaDelete.mockReset();
    mockUpsertBatch.mockClear();
    mockDeleteByRunIds.mockClear();
    mockSchemaFindLatest.mockReset();
    mockRunCreate.mockClear();
    mockRunUpdateStats.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('pulls entities from a completed remote job', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    mockFetchSequence([
      // getJob
      { data: { id: 'remote-job-1', status: 'completed', stats: { pagesProcessed: 10 } } },
      // getSchema
      {
        data: {
          version: 1,
          fields: [{ name: 'title', type: 'string', required: true, description: '' }],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      // getEntitiesStreamPaginated — single batch
      {
        data: [
          {
            id: 'e1',
            mergedData: { title: 'A' },
            provenance: {},
            categories: [],
            qualityScore: 0.9,
            tenantId: 't1',
            jobId: 'remote-job-1',
          },
        ],
        pagination: { hasMore: false, total: 1 },
      },
      // getUsage
      {
        data: {
          period: {},
          totalTokens: 1000,
          totalCostUsd: 0.05,
          byModel: {},
          byPurpose: {},
          byJob: [{ jobId: 'remote-job-1', tokens: 1000, costUsd: 0.05 }],
        },
      },
    ]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
    });

    expect(result.success).toBe(true);
    expect(result.entitiesInserted).toBe(5);
    expect(mockUpsertBatch).toHaveBeenCalled();
    expect(mockRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pulled',
        source: 'remote:prod:remote-job-1',
      }),
    );
    expect(mockMetaSet).toHaveBeenCalledWith('remote:prod:last_pull_at', expect.any(String));
    expect(mockMetaDelete).toHaveBeenCalledWith('remote:prod:pull_cursor');
  });

  it('errors when no linked job exists', async () => {
    mockMetaGet.mockResolvedValue(null);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No job linked');
  });

  it('errors when remote is not configured', async () => {
    const result = await runPullCommand({
      remoteName: 'nonexistent',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('resumes from cursor when interrupted pull detected', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      if (key === 'remote:prod:pull_cursor') return 'saved-cursor-abc';
      return null;
    });

    mockFetchSequence([
      // getJob (still needed for status check)
      { data: { id: 'remote-job-1', status: 'completed' } },
      // getEntitiesStreamPaginated — resumes from cursor
      {
        data: [
          {
            id: 'e5',
            mergedData: {},
            provenance: {},
            categories: [],
            qualityScore: 0.8,
            tenantId: 't1',
            jobId: 'j1',
          },
        ],
        pagination: { hasMore: false, total: 1 },
      },
      // getUsage
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
    ]);

    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      skipSchema: true,
    });

    expect(result.success).toBe(true);
    expect(result.resumed).toBe(true);
  });

  it('clears entities on --full flag before pulling', async () => {
    mockMetaGet.mockImplementation(async (key: string) => {
      if (key === 'remote:prod:job_id') return 'remote-job-1';
      return null;
    });

    mockFetchSequence([
      { data: { id: 'remote-job-1', status: 'completed' } },
      {
        data: {
          version: 1,
          fields: [],
          fieldAliases: [],
          createdAt: '2026-01-01',
          parentVersion: null,
        },
      },
      { data: [], pagination: { hasMore: false, total: 0 } },
      {
        data: {
          period: {},
          totalTokens: 0,
          totalCostUsd: 0,
          byModel: {},
          byPurpose: {},
          byJob: [],
        },
      },
    ]);

    await runPullCommand({
      remoteName: 'prod',
      metaGet: mockMetaGet,
      metaSet: mockMetaSet,
      metaDelete: mockMetaDelete,
      adapter: buildMockAdapter() as any,
      projectId: 'test-project',
      projectRoot: '/tmp/test',
      full: true,
    });

    expect(mockDeleteByRunIds).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm vitest run tests/unit/commands/pull.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement pull.ts**

```typescript
// apps/cli/src/commands/pull.ts
import { loadGlobalConfig } from '@spatula/core';
import { SpatulaApiClient } from '../api/client.js';
import { createLogger } from '@spatula/shared';

const logger = createLogger('cli:pull');

export interface PullInput {
  remoteName: string;
  metaGet: (key: string) => Promise<string | null>;
  metaSet: (key: string, value: string) => Promise<void>;
  metaDelete: (key: string) => Promise<void>;
  adapter: {
    entityRepo: {
      upsertBatch: (
        batch: Array<{
          id: string;
          mergedData: Record<string, unknown>;
          provenance: Record<string, unknown>;
          qualityScore: number;
          categories: unknown[];
          runId: string | null;
        }>,
      ) => Promise<{ inserted: number; updated: number }>;
      deleteByRunIds: (runIds: string[]) => Promise<number>;
    };
    schemaRepo: {
      findLatest: (
        jobId: string,
        tenantId?: string,
      ) => Promise<{ id: string; version: number; definition: unknown } | null>;
      create: (data: {
        jobId: string;
        tenantId: string;
        version: number;
        definition: unknown;
        parentId?: string;
      }) => Promise<unknown>;
    };
    runRepo: {
      create: (data: {
        status: string;
        source: string;
        configSnapshot: Record<string, unknown>;
        startedAt: string;
      }) => Promise<{ id: string }>;
      updateStats: (id: string, stats: Record<string, unknown>) => Promise<void>;
      findLatestByStatus?: (statuses: string[]) => Promise<{ id: string; source: string } | null>;
      findIdsBySourcePrefix: (prefix: string) => Promise<string[]>;
    };
  };
  projectId: string;
  projectRoot: string;
  full?: boolean;
  restart?: boolean;
  skipSchema?: boolean;
  onProgress?: (batch: number, total: number) => void;
  resolveSchemaConflict?: (diff: unknown) => Promise<'remote' | 'local' | 'merge'>;
  resolveRunningJob?: (
    status: string,
    stats?: Record<string, unknown>,
  ) => Promise<'snapshot' | 'wait' | 'cancel'>;
}

export interface PullResult {
  success: boolean;
  entitiesInserted?: number;
  entitiesUpdated?: number;
  schemaFieldsAdded?: number;
  llmTokens?: number;
  llmCostUsd?: number;
  resumed?: boolean;
  error?: string;
  jobStatus?: string;
}

function getRemoteConfig(name: string): { url: string; apiKey: string } | null {
  const config = loadGlobalConfig();
  const remote = config?.remotes?.[name];
  if (!remote?.url || !remote?.apiKey) return null;
  return { url: remote.url, apiKey: remote.apiKey };
}

export async function runPullCommand(input: PullInput): Promise<PullResult> {
  // Step 1: Resolve remote
  const remote = getRemoteConfig(input.remoteName);
  if (!remote) {
    return {
      success: false,
      error: `Remote "${input.remoteName}" not found or missing API key. Run \`spatula remote add\` first.`,
    };
  }

  const jobId = await input.metaGet(`remote:${input.remoteName}:job_id`);
  if (!jobId) {
    return {
      success: false,
      error: `No job linked for remote '${input.remoteName}'. Run \`spatula push\` first.`,
    };
  }

  const client = new SpatulaApiClient(remote.url, '', { apiKey: remote.apiKey });
  const startedAt = new Date().toISOString();

  // Step 2: Check job status
  let jobData: Record<string, unknown>;
  try {
    jobData = (await client.getJob(jobId)) as Record<string, unknown>;
  } catch (err) {
    return { success: false, error: `Failed to fetch job ${jobId}: ${(err as Error).message}` };
  }
  const jobStatus = jobData.status as string;

  if (jobStatus === 'running' || jobStatus === 'paused') {
    if (!input.resolveRunningJob) {
      return {
        success: false,
        jobStatus,
        error: `Job is still ${jobStatus}. Use interactive mode for snapshot/wait options.`,
      };
    }
    const choice = await input.resolveRunningJob(
      jobStatus,
      jobData.stats as Record<string, unknown>,
    );
    if (choice === 'cancel') {
      return { success: false, error: 'Pull cancelled by user.' };
    }
    if (choice === 'wait') {
      // Poll until completed
      let pollStatus = jobStatus;
      while (pollStatus === 'running' || pollStatus === 'paused') {
        await new Promise((r) => setTimeout(r, 30_000));
        const pollData = (await client.getJob(jobId)) as Record<string, unknown>;
        pollStatus = pollData.status as string;
      }
    }
    // 'snapshot' or 'wait' completed — proceed with pull
  }

  // Step 3: Check for interrupted pull
  let cursor = await input.metaGet(`remote:${input.remoteName}:pull_cursor`);
  let resumed = false;
  if (cursor && input.restart) {
    await input.metaDelete(`remote:${input.remoteName}:pull_cursor`);
    cursor = null;
  } else if (cursor) {
    resumed = true;
  }

  // Step 4: Fetch and resolve schema (skip if resuming or skipSchema)
  let schemaFieldsAdded = 0;
  if (!resumed && !input.skipSchema) {
    try {
      const remoteSchema = (await client.getSchema(jobId)) as Record<string, unknown>;
      const localSchema = await input.adapter.schemaRepo.findLatest(
        input.projectId,
        input.projectId,
      );

      if (!localSchema && remoteSchema) {
        // No local schema — accept remote
        await input.adapter.schemaRepo.create({
          jobId: input.projectId,
          tenantId: input.projectId,
          version: (remoteSchema.version as number) ?? 1,
          definition: remoteSchema,
        });
        const fields = (remoteSchema.fields ?? []) as unknown[];
        schemaFieldsAdded = fields.length;
      } else if (localSchema && remoteSchema) {
        // Both exist — diff and resolve
        const { diffSchemas } = await import('../lib/schema-diff.js');
        const diff = diffSchemas(
          localSchema.definition as {
            version: number;
            fields: Array<{ name: string; description: string; type: string; required: boolean }>;
          },
          remoteSchema as {
            version: number;
            fields: Array<{ name: string; description: string; type: string; required: boolean }>;
          },
        );
        if (diff.hasChanges && input.resolveSchemaConflict) {
          const choice = await input.resolveSchemaConflict(diff);
          if (choice === 'remote') {
            await input.adapter.schemaRepo.create({
              jobId: input.projectId,
              tenantId: input.projectId,
              version: (localSchema.version ?? 0) + 1,
              definition: remoteSchema,
              parentId: localSchema.id,
            });
            schemaFieldsAdded = diff.remoteOnly.length + diff.changed.length;
          } else if (choice === 'merge') {
            const mergedFields = [...(remoteSchema.fields as unknown[]), ...diff.localOnly];
            await input.adapter.schemaRepo.create({
              jobId: input.projectId,
              tenantId: input.projectId,
              version: (localSchema.version ?? 0) + 1,
              definition: { ...remoteSchema, fields: mergedFields },
              parentId: localSchema.id,
            });
            schemaFieldsAdded = diff.remoteOnly.length;
          }
          // 'local' choice — no schema changes
        }
      }
    } catch {
      logger.warn('Schema fetch failed, continuing with entity pull');
    }
  }

  // Step 5: Handle --full flag
  if (input.full) {
    await input.metaDelete(`remote:${input.remoteName}:pull_cursor`);
    await input.metaDelete(`remote:${input.remoteName}:last_pull_at`);
    cursor = null;

    // Find all pull runs for this remote and delete their entities
    const pullRunIds = await input.adapter.runRepo.findIdsBySourcePrefix(
      `remote:${input.remoteName}:`,
    );
    if (pullRunIds.length > 0) {
      await input.adapter.entityRepo.deleteByRunIds(pullRunIds);
    }
  }

  // Determine since parameter for incremental pull
  let since: string | undefined;
  if (!cursor && !input.full) {
    const lastPullAt = await input.metaGet(`remote:${input.remoteName}:last_pull_at`);
    if (lastPullAt) since = lastPullAt;
  }

  // Create run record early so we can set runId on entities
  const run = await input.adapter.runRepo.create({
    status: 'pulled',
    source: `remote:${input.remoteName}:${jobId}`,
    configSnapshot: { remote: input.remoteName, jobId, full: !!input.full, incremental: !!since },
    startedAt,
  });

  // Fetch entities in batches
  let totalInserted = 0;
  let totalUpdated = 0;
  let batchNum = 0;

  try {
    let hasMore = true;
    while (hasMore) {
      const result = await client.getEntitiesStreamPaginated(jobId, {
        cursor: cursor ?? undefined,
        since,
        limit: 500,
      });

      const batch = (result.data ?? []).map((entity: Record<string, unknown>) => ({
        id: entity.id as string,
        mergedData: (entity.mergedData ?? {}) as Record<string, unknown>,
        provenance: (entity.provenance ?? {}) as Record<string, unknown>,
        qualityScore: (entity.qualityScore as number) ?? 0,
        categories: (entity.categories ?? []) as unknown[],
        runId: run.id,
      }));

      if (batch.length > 0) {
        const upsertResult = await input.adapter.entityRepo.upsertBatch(batch);
        totalInserted += upsertResult.inserted;
        totalUpdated += upsertResult.updated;
      }

      batchNum++;
      input.onProgress?.(batchNum, totalInserted + totalUpdated);

      // Checkpoint cursor
      cursor = result.pagination?.nextCursor ?? null;
      if (cursor) {
        await input.metaSet(`remote:${input.remoteName}:pull_cursor`, cursor);
      }

      hasMore = result.pagination?.hasMore ?? false;
    }
  } catch (err) {
    // Cursor is already checkpointed — safe to resume later
    logger.error({ err }, 'Entity pull interrupted');
    return {
      success: false,
      entitiesInserted: totalInserted,
      entitiesUpdated: totalUpdated,
      resumed,
      error: `Pull interrupted after ${batchNum} batches: ${(err as Error).message}. Run \`spatula pull\` to resume.`,
    };
  }

  // Step 6: Fetch LLM usage
  let llmTokens = 0;
  let llmCostUsd = 0;
  try {
    const usage = await client.getUsage();
    const jobUsage = usage.byJob?.find((j: { jobId: string }) => j.jobId === jobId);
    if (jobUsage) {
      llmTokens = jobUsage.tokens;
      llmCostUsd = jobUsage.costUsd;
    }
    await input.metaSet(`remote:${input.remoteName}:last_pull_usage`, JSON.stringify(usage));
  } catch {
    logger.warn('Usage fetch failed, continuing');
  }

  // Step 7: Update run stats
  await input.adapter.runRepo.updateStats(run.id, {
    entitiesCreated: totalInserted,
    llmTokensUsed: llmTokens,
    llmCostUsd,
  });

  // Step 8: Clear cursor + update timestamps
  await input.metaDelete(`remote:${input.remoteName}:pull_cursor`);
  await input.metaSet(`remote:${input.remoteName}:last_pull_at`, new Date().toISOString());

  // Step 9: Return summary
  return {
    success: true,
    entitiesInserted: totalInserted,
    entitiesUpdated: totalUpdated,
    schemaFieldsAdded,
    llmTokens,
    llmCostUsd,
    resumed,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm vitest run tests/unit/commands/pull.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/pull.ts apps/cli/tests/unit/commands/pull.test.ts
git commit -m "feat(cli): implement core pull command with 9-step flow"
```

---

### Task 8: Schema Conflict Resolution TUI

**Files:**

- Create: `apps/cli/src/components/SchemaConflict.tsx`
- Test: `apps/cli/tests/unit/components/schema-conflict.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// apps/cli/tests/unit/components/schema-conflict.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SchemaConflict } from '../../../src/components/SchemaConflict.js';
import type { SchemaDiff } from '../../../src/lib/schema-diff.js';

describe('SchemaConflict', () => {
  const mockDiff: SchemaDiff = {
    localOnly: [{ name: 'color', description: '', type: 'string', required: false }],
    remoteOnly: [{ name: 'rating', description: '', type: 'number', required: false }],
    changed: [{
      name: 'price',
      local: { name: 'price', description: '', type: 'string', required: false },
      remote: { name: 'price', description: '', type: 'currency', required: true },
      differences: ['type: string \u2192 currency', 'required: false \u2192 true'],
    }],
    unchanged: [{ name: 'title', description: '', type: 'string', required: true }],
    hasChanges: true,
  };

  it('renders the diff summary', () => {
    const onResolve = vi.fn();
    const { lastFrame } = render(
      <SchemaConflict diff={mockDiff} onResolve={onResolve} />,
    );
    const output = lastFrame();
    expect(output).toContain('Schema differences detected');
    expect(output).toContain('color');
    expect(output).toContain('rating');
    expect(output).toContain('price');
  });

  it('shows the three resolution options', () => {
    const onResolve = vi.fn();
    const { lastFrame } = render(
      <SchemaConflict diff={mockDiff} onResolve={onResolve} />,
    );
    const output = lastFrame();
    expect(output).toContain('Use remote');
    expect(output).toContain('Keep local');
    expect(output).toContain('Merge');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm vitest run tests/unit/components/schema-conflict.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SchemaConflict.tsx**

```tsx
// apps/cli/src/components/SchemaConflict.tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SchemaDiff } from '../lib/schema-diff.js';

interface SchemaConflictProps {
  diff: SchemaDiff;
  onResolve: (choice: 'remote' | 'local' | 'merge') => void;
}

export function SchemaConflict({ diff, onResolve }: SchemaConflictProps) {
  const [selected, setSelected] = useState(0);
  const options: Array<{ key: 'remote' | 'local' | 'merge'; label: string; desc: string }> = [
    { key: 'remote', label: 'Use remote', desc: 'replaces local with remote' },
    { key: 'local', label: 'Keep local', desc: 'ignore remote changes' },
    { key: 'merge', label: 'Merge', desc: 'keep all fields from both' },
  ];

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1));
    if (key.return) onResolve(options[selected].key);
    if (input === '1') onResolve('remote');
    if (input === '2') onResolve('local');
    if (input === '3') onResolve('merge');
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Schema differences detected</Text>
      <Text> </Text>

      {diff.localOnly.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor> Local only:</Text>
          {diff.localOnly.map((f) => (
            <Text key={f.name} color="yellow">
              {' '}
              - {f.name} ({f.type})
            </Text>
          ))}
        </Box>
      )}

      {diff.remoteOnly.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor> Remote only:</Text>
          {diff.remoteOnly.map((f) => (
            <Text key={f.name} color="green">
              {' '}
              + {f.name} ({f.type})
            </Text>
          ))}
        </Box>
      )}

      {diff.changed.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor> Changed:</Text>
          {diff.changed.map((c) => (
            <Box key={c.name} flexDirection="column">
              <Text color="cyan"> ~ {c.name}</Text>
              {c.differences.map((d, i) => (
                <Text key={i} dimColor>
                  {' '}
                  {d}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )}

      <Text> </Text>
      <Text bold>Resolution:</Text>
      {options.map((opt, i) => (
        <Text key={opt.key}>
          {i === selected ? ' \u276f ' : '   '}
          <Text bold={i === selected}>
            [{i + 1}] {opt.label}
          </Text>
          <Text dimColor> \u2014 {opt.desc}</Text>
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm vitest run tests/unit/components/schema-conflict.test.tsx`
Expected: Both tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/components/SchemaConflict.tsx apps/cli/tests/unit/components/schema-conflict.test.tsx
git commit -m "feat(cli): add SchemaConflict TUI component for pull flow"
```

---

### Task 9: Pull Progress Display

**Files:**

- Create: `apps/cli/src/lib/pull-progress.tsx`

- [ ] **Step 1: Create the progress component**

```tsx
// apps/cli/src/lib/pull-progress.tsx
import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface PullProgressProps {
  remoteName: string;
  batch: number;
  entityCount: number;
  elapsed: number;
}

export function PullProgress({ remoteName, batch, entityCount, elapsed }: PullProgressProps) {
  const elapsedStr = (elapsed / 1000).toFixed(1);
  return (
    <Box>
      <Text color="green">
        <Spinner type="dots" />
      </Text>
      <Text>
        {' '}
        Pulling from &apos;{remoteName}&apos;... Batch {batch} | {entityCount.toLocaleString()}{' '}
        entities | {elapsedStr}s
      </Text>
    </Box>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/lib/pull-progress.tsx
git commit -m "feat(cli): add PullProgress ink component"
```

---

### Task 10: Pull Command Handler (Interactive Wrapper)

**Files:**

- Modify: `apps/cli/src/commands/pull.ts`

- [ ] **Step 1: Add the `handlePullCommand` function that wraps `runPullCommand` with TUI interactions**

Append to `apps/cli/src/commands/pull.ts`:

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { openLocalProject } from '../local-project.js';
import { diffSchemas } from '../lib/schema-diff.js';
import { appendFieldsToYaml } from '../lib/yaml-fields.js';

async function promptChoice(question: string, choices: string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const choiceText = choices.map((c, i) => `  [${i + 1}] ${c}`).join('\n');
    rl.question(`${question}\n${choiceText}\n\nChoice: `, (answer) => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      resolve(idx >= 0 && idx < choices.length ? idx : 0);
    });
  });
}

export async function handlePullCommand(opts: {
  remoteName: string;
  full?: boolean;
  restart?: boolean;
}): Promise<void> {
  let project: Awaited<ReturnType<typeof openLocalProject>> | null = null;

  try {
    project = await openLocalProject(process.cwd());

    const result = await runPullCommand({
      remoteName: opts.remoteName,
      metaGet: (k) => project!.metaRepo.get(k),
      metaSet: (k, v) => project!.metaRepo.set(k, v),
      metaDelete: (k) => project!.adapter.metaRepo.delete(k),
      adapter: project.adapter,
      projectId: project.projectId,
      projectRoot: project.projectRoot,
      full: opts.full,
      restart: opts.restart,
      onProgress: (batch, total) => {
        process.stderr.write(`\r  Batch ${batch} | ${total} entities fetched`);
      },
      resolveRunningJob: async (jobStatus: string, stats?: Record<string, unknown>) => {
        const pagesInfo = stats?.pagesProcessed ? ` (${stats.pagesProcessed} pages crawled)` : '';
        const choice = await promptChoice(`Job is still ${jobStatus}${pagesInfo}.`, [
          'Pull current snapshot (can pull again later)',
          'Wait for completion (polls every 30s)',
          'Cancel pull',
        ]);
        return (['snapshot', 'wait', 'cancel'] as const)[choice];
      },
      resolveSchemaConflict: async (diff) => {
        const schemaDiff = diff as import('../lib/schema-diff.js').SchemaDiff;
        if (schemaDiff.remoteOnly.length > 0) {
          console.log(
            `\n  Remote has ${schemaDiff.remoteOnly.length} new field(s): ${schemaDiff.remoteOnly.map((f) => f.name).join(', ')}`,
          );
        }
        if (schemaDiff.changed.length > 0) {
          console.log(
            `  ${schemaDiff.changed.length} field(s) changed: ${schemaDiff.changed.map((c) => c.name).join(', ')}`,
          );
        }
        if (schemaDiff.localOnly.length > 0) {
          console.log(
            `  ${schemaDiff.localOnly.length} local-only field(s): ${schemaDiff.localOnly.map((f) => f.name).join(', ')}`,
          );
        }
        const choice = await promptChoice('\nHow should schema differences be resolved?', [
          'Use remote schema (recommended)',
          'Keep local schema',
          'Merge (keep all fields from both)',
        ]);
        return (['remote', 'local', 'merge'] as const)[choice];
      },
    });

    if (!result.success) {
      console.error(`\nPull failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }

    // Handle schema changes — write to spatula.yaml if fields were added
    if (result.schemaFieldsAdded && result.schemaFieldsAdded > 0) {
      try {
        const yamlPath = join(project.projectRoot, 'spatula.yaml');
        const yamlContent = readFileSync(yamlPath, 'utf-8');
        const schema = await project.adapter.schemaRepo.findLatest(project.projectId);
        if (schema?.definition) {
          const fields = ((schema.definition as { fields?: unknown[] }).fields ?? []) as Array<{
            name: string;
            type: string;
            required?: boolean;
          }>;
          const date = new Date().toISOString().split('T')[0];
          const updated = appendFieldsToYaml(yamlContent, fields, date);
          writeFileSync(yamlPath, updated, 'utf-8');
        }
      } catch {
        // Non-fatal: schema is in DB even if yaml write fails
      }
    }

    // Print summary
    process.stderr.write('\r' + ' '.repeat(60) + '\r'); // Clear progress line
    console.log(`\nPull complete from '${opts.remoteName}'`);
    console.log(
      `  Entities:  ${result.entitiesInserted} new, ${result.entitiesUpdated} updated (${(result.entitiesInserted ?? 0) + (result.entitiesUpdated ?? 0)} total)`,
    );
    if (result.schemaFieldsAdded) {
      console.log(`  Schema:    ${result.schemaFieldsAdded} new fields`);
    }
    if (result.llmTokens) {
      console.log(
        `  LLM usage: ${result.llmTokens?.toLocaleString()} tokens ($${result.llmCostUsd?.toFixed(2)})`,
      );
    }
    if (result.resumed) {
      console.log(`  (Resumed from interrupted pull)`);
    }
  } finally {
    project?.close();
  }
}
```

- [ ] **Step 2: Run the full pull test suite**

Run: `cd apps/cli && pnpm vitest run tests/unit/commands/pull.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/commands/pull.ts
git commit -m "feat(cli): add handlePullCommand interactive wrapper"
```

---

### Task 11: Explorer Source Filtering

**Files:**

- Modify: `apps/cli/src/components/explorer/ExplorerView.tsx`
- Modify: `apps/cli/src/components/explorer/DataTable.tsx`
- Test: `apps/cli/tests/unit/components/explorer-source-filter.test.ts`

- [ ] **Step 1: Write failing test for source filter cycling**

```typescript
// apps/cli/tests/unit/components/explorer-source-filter.test.ts
import { describe, it, expect } from 'vitest';
import { cycleSourceFilter } from '../../../src/components/explorer/source-filter.js';

describe('cycleSourceFilter', () => {
  it('cycles all -> local -> remote -> all', () => {
    expect(cycleSourceFilter('all')).toBe('local');
    expect(cycleSourceFilter('local')).toBe('remote');
    expect(cycleSourceFilter('remote')).toBe('all');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm vitest run tests/unit/components/explorer-source-filter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the source-filter utility**

```typescript
// apps/cli/src/components/explorer/source-filter.ts
export type SourceFilter = 'all' | 'local' | 'remote';

const CYCLE: SourceFilter[] = ['all', 'local', 'remote'];

export function cycleSourceFilter(current: SourceFilter): SourceFilter {
  const idx = CYCLE.indexOf(current);
  return CYCLE[(idx + 1) % CYCLE.length];
}

export function sourceFilterLabel(filter: SourceFilter): string {
  return filter.charAt(0).toUpperCase() + filter.slice(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cli && pnpm vitest run tests/unit/components/explorer-source-filter.test.ts`
Expected: PASS

- [ ] **Step 5: Add `[s]` keybinding to ExplorerView.tsx**

In `apps/cli/src/components/explorer/ExplorerView.tsx`:

1. Add import at top:

```typescript
import { cycleSourceFilter, sourceFilterLabel } from './source-filter.js';
import type { SourceFilter } from './source-filter.js';
```

2. Add state inside the component:

```typescript
const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
```

3. Add to `TABLE_HINTS` array:

```typescript
{ key: 'S', description: 'Source filter' },
```

4. Add to keyboard map (in the table keyboard section):

```typescript
s: () => setSourceFilter((f) => cycleSourceFilter(f)),
S: () => setSourceFilter((f) => cycleSourceFilter(f)),
```

5. Pass `sourceFilter` to `DataTable` as a prop.

6. Wire source filter into data fetching. In the `useEntityData` hook call (or wherever `findByJob` / `dataSource.getEntities` is invoked), pass `sourceFilter` through. For the `LocalDataSource` path, this means the `ExplorerView` needs to check if `backend` is a `LocalDataSource` and call `adapter.entityRepo.findByJobFiltered()` with `{ sourceFilter }` instead of `findByJob()`. For the `ApiDataSource` path, source filtering is N/A (remote data is always "remote").

   Practical approach: if `sourceFilter !== 'all'` and the backend is local, re-fetch entities through `adapter.entityRepo.findByJobFiltered(jobId, '', { limit: pageSize, offset: page * pageSize, sourceFilter })`. The `useEntityData` hook should accept an optional `sourceFilter` parameter and pass it through.

- [ ] **Step 6: Update DataTable footer to show source filter**

In `apps/cli/src/components/explorer/DataTable.tsx`, add `sourceFilter?: string` to the props interface and show it in the footer:

```tsx
// Add to the footer Box, after the page info:
{
  sourceFilter && sourceFilter !== 'all' && <Text dimColor> [Source: {sourceFilter}]</Text>;
}
```

- [ ] **Step 7: Run existing explorer tests for regressions**

Run: `cd apps/cli && pnpm vitest run tests/unit/commands/explore.test.ts tests/unit/hooks/useEntityData.test.ts tests/unit/hooks/useEntityFilter.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/components/explorer/source-filter.ts apps/cli/src/components/explorer/ExplorerView.tsx apps/cli/src/components/explorer/DataTable.tsx apps/cli/tests/unit/components/explorer-source-filter.test.ts
git commit -m "feat(cli): add source filter toggle to explorer view"
```

---

### Task 12: Command Registration

**Files:**

- Modify: `apps/cli/src/index.tsx`

- [ ] **Step 1: Register the pull command in yargs**

In `apps/cli/src/index.tsx`, add the pull command registration after the push command block (around line 540):

```typescript
.command(
  'pull [remote]',
  'Pull entities and schema from a remote Spatula server to the local project',
  (y) =>
    y
      .positional('remote', {
        type: 'string',
        default: 'default',
        describe: 'Remote name (from `spatula remote add`)',
      })
      .option('full', {
        type: 'boolean',
        default: false,
        describe: 'Force complete re-pull (clear previously-pulled entities)',
      })
      .option('restart', {
        type: 'boolean',
        default: false,
        describe: 'Clear interrupted pull cursor and start fresh',
      }),
  async (argv) => {
    const { handlePullCommand } = await import('./commands/pull.js');
    await handlePullCommand({
      remoteName: argv.remote as string,
      full: argv.full,
      restart: argv.restart,
    });
  },
)
```

- [ ] **Step 2: Verify the CLI builds**

Run: `cd apps/cli && pnpm build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Verify help text shows pull command**

Run: `cd apps/cli && node dist/index.js --help`
Expected: Output includes `pull [remote]` in the command list

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/index.tsx
git commit -m "feat(cli): register pull command in CLI entrypoint"
```

---

### Task 13: Integration Test — Full Pull Flow

**Files:**

- Test: `apps/cli/tests/unit/commands/pull-integration.test.ts`

- [ ] **Step 1: Write integration test covering the end-to-end happy path**

```typescript
// apps/cli/tests/unit/commands/pull-integration.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { runPullCommand } from '../../../src/commands/pull.js';
import type { GlobalConfig } from '@spatula/core';

vi.mock('@spatula/core', async () => {
  const actual = await vi.importActual<typeof import('@spatula/core')>('@spatula/core');
  return {
    ...actual,
    loadGlobalConfig: vi.fn(
      () =>
        ({
          version: 1,
          remotes: { prod: { url: 'https://api.test', apiKey: 'sk_test' } },
        }) as GlobalConfig,
    ),
  };
});

describe('Pull flow integration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('handles multi-batch cursor pagination', async () => {
    const meta: Record<string, string> = { 'remote:prod:job_id': 'j1' };
    let fetchCallCount = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        fetchCallCount++;
        const urlStr = url.toString();

        if (urlStr.includes('/jobs/j1') && !urlStr.includes('/entities')) {
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: { id: 'j1', status: 'completed' } }),
          };
        }
        if (urlStr.includes('/schema')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: {
                  version: 1,
                  fields: [],
                  fieldAliases: [],
                  createdAt: '2026-01-01',
                  parentVersion: null,
                },
              }),
          };
        }
        if (urlStr.includes('/entities')) {
          const hasCursor = urlStr.includes('cursor=');
          if (!hasCursor) {
            return {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'e1',
                      mergedData: { x: 1 },
                      provenance: {},
                      categories: [],
                      qualityScore: 0.9,
                      tenantId: 't',
                      jobId: 'j1',
                    },
                  ],
                  pagination: { nextCursor: 'cursor-page2', hasMore: true, total: 2 },
                }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: [
                  {
                    id: 'e2',
                    mergedData: { x: 2 },
                    provenance: {},
                    categories: [],
                    qualityScore: 0.8,
                    tenantId: 't',
                    jobId: 'j1',
                  },
                ],
                pagination: { hasMore: false, total: 2 },
              }),
          };
        }
        if (urlStr.includes('/usage')) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: {
                  period: {},
                  totalTokens: 500,
                  totalCostUsd: 0.01,
                  byModel: {},
                  byPurpose: {},
                  byJob: [{ jobId: 'j1', tokens: 500, costUsd: 0.01 }],
                },
              }),
          };
        }
        return { ok: true, status: 200, json: () => Promise.resolve({ data: {} }) };
      }),
    );

    const upsertCalls: unknown[][] = [];
    const result = await runPullCommand({
      remoteName: 'prod',
      metaGet: async (k) => meta[k] ?? null,
      metaSet: async (k, v) => {
        meta[k] = v;
      },
      metaDelete: async (k) => {
        delete meta[k];
      },
      adapter: {
        entityRepo: {
          upsertBatch: async (batch) => {
            upsertCalls.push(batch);
            return { inserted: batch.length, updated: 0 };
          },
          deleteByRunIds: async () => 0,
        },
        schemaRepo: {
          findLatest: async () => null,
          create: async () => ({ id: 's1' }),
        },
        runRepo: {
          create: async (data) => ({ id: 'run-1', ...data }),
          updateStats: async () => {},
        },
      } as any,
      projectId: 'test',
      projectRoot: '/tmp/test',
    });

    expect(result.success).toBe(true);
    expect(upsertCalls).toHaveLength(2); // Two batches
    expect(result.entitiesInserted).toBe(2);
    expect(result.llmTokens).toBe(500);
    expect(meta['remote:prod:last_pull_at']).toBeDefined();
    expect(meta['remote:prod:pull_cursor']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `cd apps/cli && pnpm vitest run tests/unit/commands/pull-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run the full CLI test suite**

Run: `cd apps/cli && pnpm vitest run tests/unit/`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add apps/cli/tests/unit/commands/pull-integration.test.ts
git commit -m "test(cli): add pull flow integration test with multi-batch pagination"
```

---

### Task 14: Final Build Verification & Cleanup

- [ ] **Step 1: Build all packages**

Run: `pnpm build`
Expected: Clean build across all packages

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: All tests pass, count increases by ~25-30 tests

- [ ] **Step 3: Verify pull command works end-to-end (dry run)**

Run: `cd apps/cli && node dist/index.js pull --help`
Expected: Shows pull command help with options (--full, --restart, remote positional)

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: final cleanup for Wave 5-5 pull flow"
```
