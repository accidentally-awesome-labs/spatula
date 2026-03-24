# Wave 2.3a: SQLite Schema & Project Database

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create SQLite schema definitions mirroring 8 core Postgres tables (minus tenant_id, with intentional column differences), add 4 local-only tables, build the SQLite connection factory, and establish parity verification.

**Architecture:** Hand-written SQLite schemas using Drizzle sqliteTable API with consistent type translations. The SQLite schemas are NOT 1:1 copies of Postgres — they deliberately differ in several ways (pages merges columns from crawl_tasks, source_trust replaces reasoning with score, enum values may include local extensions like 'critical' priority). A createProjectDb() function configures SQLite with WAL mode, foreign keys, and busy timeout. Parity tests verify core column coverage while documenting known intentional differences.

**Codegen note:** The Phase 13 spec (section 5.10) calls for a build-time codegen script. This is deferred — the Postgres and SQLite Drizzle APIs (pgTable vs sqliteTable) have fundamentally different signatures, making AST-based codegen fragile. Instead, we hand-write schemas and use parity tests as the drift-detection mechanism. If codegen becomes needed, it would be a future enhancement.

**Tech Stack:** TypeScript, Drizzle ORM (drizzle-orm/sqlite-core), better-sqlite3, Vitest

**Spec references:**
- Phase 13 spec: section 5 (SQLite Schema and Repository Layer)
- File: docs/superpowers/specs/2026-03-21-phase-13-project-folder-model-design.md

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| packages/db/src/schema-sqlite/pages.ts | Pages table (HTML stored on disk) |
| packages/db/src/schema-sqlite/entities.ts | Entities + entity_sources tables |
| packages/db/src/schema-sqlite/extractions.ts | Extraction results |
| packages/db/src/schema-sqlite/schemas.ts | Schema versions with parentId |
| packages/db/src/schema-sqlite/crawl-tasks.ts | Crawl task tree |
| packages/db/src/schema-sqlite/actions.ts | Schema evolution actions |
| packages/db/src/schema-sqlite/source-trust.ts | Domain trust scoring |
| packages/db/src/schema-sqlite/runs.ts | Local-only: run tracking |
| packages/db/src/schema-sqlite/llm-usage.ts | Local-only: LLM cost tracking |
| packages/db/src/schema-sqlite/exports.ts | Local-only: export file tracking |
| packages/db/src/schema-sqlite/project-meta.ts | Local-only: key-value project state |
| packages/db/src/schema-sqlite/index.ts | Barrel export for all SQLite schemas |
| packages/db/src/project-db/connection.ts | createProjectDb() with SQLite pragmas |
| packages/db/tests/unit/schema-sqlite/parity.test.ts | Parity test verifying Postgres and SQLite columns |

### Modified Files

| File | Change |
|------|--------|
| packages/db/package.json | Add better-sqlite3 and types |
| packages/db/src/index.ts | Export project-db connection |

---

## Type Translation Reference

| Postgres | SQLite (Drizzle) | Notes |
|----------|-----------------|-------|
| uuid().defaultRandom() | text('id').primaryKey() | UUID generated in JS |
| text() | text() | Direct |
| integer() | integer() | Direct |
| real() | real() | Direct (float) |
| boolean() | integer('field', { mode: 'boolean' }) | 0/1 |
| timestamp({ withTimezone: true }) | text('field') | ISO 8601 strings |
| jsonb().$type<T>() | text('field', { mode: 'json' }) | JSON string |
| text().array() | text('field') | JSON-encoded array |
| bytea (customType) | blob('field') | SQLite BLOB |
| pgEnum values | text('field') | Validated in app layer |

Dropped from all tables: tenantId column. Kept unchanged: jobId column (maps to synthetic project ID).

---

## Task 1: Install Dependencies

**Files:**
- Modify: packages/db/package.json

- [ ] **Step 1: Add better-sqlite3 dependency**

Run:
```bash
cd /Users/salar/Projects/spatula
pnpm --filter @spatula/db add better-sqlite3
pnpm --filter @spatula/db add -D @types/better-sqlite3
```

- [ ] **Step 2: Verify build**

Run: pnpm --filter @spatula/db build

- [ ] **Step 3: Commit**

```bash
git add packages/db/package.json pnpm-lock.yaml
git commit -m "feat(db): add better-sqlite3 dependency for project database"
```

---

## Task 2: Core SQLite Schemas (Pages, Entities, Extractions)

**Files:**
- Create: packages/db/src/schema-sqlite/pages.ts
- Create: packages/db/src/schema-sqlite/entities.ts
- Create: packages/db/src/schema-sqlite/extractions.ts

- [ ] **Step 1: Create pages, entities, extractions schemas**

Read the Postgres originals first:
- packages/db/src/schema/raw-pages.ts (exports as `rawPages`)
- packages/db/src/schema/entities.ts (exports as `entities`, `entitySources`)
- packages/db/src/schema/extractions.ts (exports as `extractions`)

Create SQLite equivalents following the type translation reference above.

**Intentional differences from Postgres (document in code comments):**
- pages: maps to Postgres `raw_pages`. Drop tenantId. ADD `url`, `statusCode`, `title`, `classification` (merged from crawl_tasks for local query convenience — in Postgres these live on crawl_tasks, but locally it's simpler to have them on pages). ADD `contentPath`, `needsReextraction`, `reextractionReason` as local extensions.
- entities: drop tenantId, categories is text (JSON array not text[]), add sourceCount/updatedAt
- entity_sources: keep matchConfidence, composite PK (identical to Postgres minus no tenant scoping)
- extractions: drop tenantId

Use text('field', { mode: 'json' }) for all JSONB columns. Use text('field') for all timestamp columns. Use integer('field', { mode: 'boolean' }) for boolean columns.

Prefix all index names with `sqlite_` to avoid collision with Postgres index names.

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/schema-sqlite/pages.ts packages/db/src/schema-sqlite/entities.ts packages/db/src/schema-sqlite/extractions.ts
git commit -m "feat(db): add SQLite schemas for pages, entities, and extractions"
```

---

## Task 3: Remaining Mirrored SQLite Schemas

**Files:**
- Create: packages/db/src/schema-sqlite/schemas.ts
- Create: packages/db/src/schema-sqlite/crawl-tasks.ts
- Create: packages/db/src/schema-sqlite/actions.ts
- Create: packages/db/src/schema-sqlite/source-trust.ts

- [ ] **Step 1: Create schemas, crawl-tasks, actions, source-trust**

Read Postgres originals first:
- packages/db/src/schema/schemas.ts (exports as `schemasTable`, has self-referential parentId)
- packages/db/src/schema/crawl-tasks.ts (exports as `crawlTasks`, has self-referential parentTaskId)
- packages/db/src/schema/actions.ts (exports as `actions`)
- packages/db/src/schema/source-trust.ts (exports as `sourceTrust`)

**Intentional differences from Postgres (document in code comments):**
- schemas: drop tenantId, keep parentId as text (self-referential, no Drizzle FK declaration needed — enforced by PRAGMA foreign_keys)
- crawl-tasks: drop tenantId. ADD `priorityScore`, `errorMessage`, `attempts`, `completedAt` as local extensions. Enum columns (`status`, `priority`, `classification`, `crawlerType`) become plain text — validated in app layer, NOT via CHECK constraints (keeps schema flexible)
- actions: drop tenantId. Enum columns (`source`, `status`) become plain text
- source-trust: drop tenantId. **IMPORTANT:** Postgres has `reasoning TEXT NOT NULL` — the SQLite version REPLACES this with `score REAL` (numeric trust score) and makes `reasoning` optional. This is an intentional local deviation: the local pipeline uses numeric scores while the server uses text reasoning. Both columns should be present in SQLite (score + optional reasoning) for future compatibility

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/schema-sqlite/schemas.ts packages/db/src/schema-sqlite/crawl-tasks.ts packages/db/src/schema-sqlite/actions.ts packages/db/src/schema-sqlite/source-trust.ts
git commit -m "feat(db): add SQLite schemas for schemas, crawl-tasks, actions, source-trust"
```

---

## Task 4: Local-Only SQLite Tables

**Files:**
- Create: packages/db/src/schema-sqlite/runs.ts
- Create: packages/db/src/schema-sqlite/llm-usage.ts
- Create: packages/db/src/schema-sqlite/exports.ts
- Create: packages/db/src/schema-sqlite/project-meta.ts

- [ ] **Step 1: Create local-only tables**

These have no Postgres equivalent. Follow the spec section 5.5:
- runs: id, status, source, configSnapshot (json), timestamps, stats counters, errorMessage
- llm-usage: id, runId, model, prompt/completion/total tokens, costUsd, purpose, createdAt
- exports: id, runId, format, filePath, entityCount, fileSize, includeProvenance, createdAt
- project-meta: key (PK), value -- simple key-value store

- [ ] **Step 2: Commit**

```bash
git add packages/db/src/schema-sqlite/runs.ts packages/db/src/schema-sqlite/llm-usage.ts packages/db/src/schema-sqlite/exports.ts packages/db/src/schema-sqlite/project-meta.ts
git commit -m "feat(db): add local-only SQLite tables (runs, llm-usage, exports, project-meta)"
```

---

## Task 5: Schema Barrel Export and SQLite Connection

**Files:**
- Create: packages/db/src/schema-sqlite/index.ts
- Create: packages/db/src/project-db/connection.ts
- Modify: packages/db/src/index.ts

- [ ] **Step 1: Create SQLite schema barrel**

Export all tables from packages/db/src/schema-sqlite/index.ts:
- 7 mirrored files: pages, entities (includes entitySources), extractions, schemas, crawl-tasks, actions, source-trust
- 4 local-only files: runs, llm-usage, exports, project-meta

- [ ] **Step 2: Create SQLite connection factory**

Create packages/db/src/project-db/connection.ts with two functions:

**`createProjectDb(dbPath: string)`** — returns `{ db: DrizzleSQLite, sqlite: Database }`:
- Creates a `better-sqlite3` Database instance
- Sets pragmas: WAL mode, FK enforcement, busy timeout 5s, synchronous NORMAL
- Wraps with Drizzle using the SQLite schema
- Returns BOTH the Drizzle instance AND the raw sqlite instance (avoids accessing Drizzle internals via `(db as any).session?.client`)

```typescript
export function createProjectDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
```

**`initializeProjectDb(sqlite: Database, meta: { projectId: string; name: string })`** — creates all tables + seeds project_meta:
- Takes the RAW sqlite instance (not the Drizzle wrapper) — no internal access needed
- Creates all tables via `sqlite.exec(CREATE TABLE IF NOT EXISTS ...)`
- Seeds `project_meta` with initial values:
  - `schema_version` = `'1'`
  - `project_id` = the synthetic UUID
  - `name` = project name (from spatula.yaml or directory name)
  - `created_at` = ISO 8601 timestamp

```typescript
export function initializeProjectDb(
  sqlite: Database.Database,
  meta: { projectId: string; name: string },
): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS project_meta (...)`);
  // ... all other CREATE TABLE statements ...

  // Seed initial project metadata
  const insert = sqlite.prepare('INSERT OR IGNORE INTO project_meta (key, value) VALUES (?, ?)');
  insert.run('schema_version', '1');
  insert.run('project_id', meta.projectId);
  insert.run('name', meta.name);
  insert.run('created_at', new Date().toISOString());
}
```

The raw SQL must match the Drizzle schema definitions. Since both are hand-written, drift is possible — the parity test in Task 6 catches column-level drift, and the smoke test verifies end-to-end insertion.

- [ ] **Step 3: Update db barrel exports**

Add to packages/db/src/index.ts:

```typescript
// Project database (SQLite for local mode)
export { createProjectDb, initializeProjectDb } from './project-db/connection.js';
export type { ProjectDatabase, ProjectDbResult } from './project-db/connection.js';
```

Where `ProjectDbResult = { db: ProjectDatabase; sqlite: Database }` — callers use `db` for queries and `sqlite` for initialization and shutdown (`sqlite.close()`).

Also export the SQLite schema namespace:

```typescript
export * as sqliteSchema from './schema-sqlite/index.js';
```

- [ ] **Step 4: Verify build**

Run: pnpm --filter @spatula/db build

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema-sqlite/index.ts packages/db/src/project-db/connection.ts packages/db/src/index.ts
git commit -m "feat(db): add SQLite connection factory and schema barrel for project database"
```

---

## Task 6: Parity Verification Tests

**Files:**
- Create: packages/db/tests/unit/schema-sqlite/parity.test.ts

- [ ] **Step 1: Write parity tests**

Use Drizzle getTableColumns() to programmatically compare Postgres and SQLite schemas.

**Critical: Postgres table variable names (from packages/db/src/schema/index.ts):**
- `rawPages` (NOT `pages`) — maps to SQLite `pages`
- `schemasTable` (NOT `schemas`) — maps to SQLite `schemas`
- `crawlTasks` — maps to SQLite `crawlTasks`
- `entities` — maps to SQLite `entities`
- `entitySources` — maps to SQLite `entitySources`
- `extractions` — maps to SQLite `extractions`
- `actions` — maps to SQLite `actions`
- `sourceTrust` — maps to SQLite `sourceTrust`

**DO NOT include in parity comparison:**
- Postgres `tenants` — dropped entirely (no SQLite equivalent)
- Postgres `jobs` — replaced by SQLite `runs`
- Postgres `contentStore` — dropped (content on disk locally)
- Postgres `exports` — the SQLite `exports` is a LOCAL-ONLY table with a DIFFERENT shape (no status, no contentRef; has filePath, runId instead)

**Known intentional differences to document in tests:**
- `pages`: SQLite adds `url`, `statusCode`, `title`, `classification`, `contentPath`, `needsReextraction`, `reextractionReason` (merged from crawl_tasks + local extensions)
- `source_trust`: Postgres has `reasoning NOT NULL`; SQLite has both `score REAL` and optional `reasoning`
- All tables: `tenantId` dropped

For each mirrored pair:
1. Get Postgres column names, remove `tenantId`
2. Get SQLite column names
3. Assert every Postgres column (minus tenantId and known-dropped columns) exists in SQLite
4. Assert known local extensions exist

Also add these smoke tests:

1. **DB initialization smoke test:** Create an in-memory DB (`:memory:`), call `initializeProjectDb`, verify `project_meta` contains `schema_version` and `project_id`.

2. **Drizzle round-trip test:** Create DB, initialize, insert a row via Drizzle ORM (e.g., insert into `projectMeta` using the Drizzle schema), read it back, verify the data matches. This catches column name mismatches between the raw SQL CREATE TABLE statements and the Drizzle schema definitions — if they drift, Drizzle will write to wrong columns and the read-back will fail.

- [ ] **Step 2: Run tests**

Run: pnpm --filter @spatula/db test -- --run parity

- [ ] **Step 3: Run full db test suite**

Run: pnpm --filter @spatula/db test -- --run

- [ ] **Step 4: Commit**

```bash
git add packages/db/tests/unit/schema-sqlite/parity.test.ts
git commit -m "test(db): add SQLite schema parity verification against Postgres schemas"
```

---

## Task 7: Integration Verification

- [ ] **Step 1: Run full db test suite**

Run: pnpm --filter @spatula/db test -- --run

- [ ] **Step 2: Run full build**

Run: pnpm --filter @spatula/db build and pnpm --filter @spatula/queue build

- [ ] **Step 3: Verify schema-sqlite directory**

Run: ls packages/db/src/schema-sqlite/

Expected: 12 files (7 mirrored: pages, entities, extractions, schemas, crawl-tasks, actions, source-trust; 4 local: runs, llm-usage, exports, project-meta; 1 barrel: index)

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "test: verify Wave 2.3a -- SQLite schema with parity verification"
```
