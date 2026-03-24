# Wave 2.3a: SQLite Schema & Project Database

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create SQLite schema definitions mirroring 8 core Postgres tables (minus tenant_id, with intentional column differences), add 4 local-only tables, build the SQLite connection factory, and establish parity verification.

**Architecture:** Hand-written SQLite Drizzle schemas using `sqliteTable` API with consistent type translations. The SQLite schemas are NOT 1:1 copies of Postgres — they deliberately differ (pages merges columns from crawl_tasks, source_trust replaces reasoning with score, local extensions on multiple tables). Table creation uses Drizzle Kit's migration system: `drizzle-kit generate` produces SQL migration files from the Drizzle schemas at build time, and `migrate()` from `drizzle-orm/better-sqlite3/migrator` applies them at runtime. This eliminates raw-SQL/Drizzle-schema drift and enables incremental version upgrades for local project databases.

**Tech Stack:** TypeScript, Drizzle ORM (drizzle-orm/sqlite-core + better-sqlite3/migrator), Drizzle Kit (migration generation), better-sqlite3, Vitest

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
| packages/db/src/project-db/connection.ts | createProjectDb() + initializeProjectDb() with migrate() |
| packages/db/drizzle.config.sqlite.ts | Drizzle Kit config for SQLite migration generation |
| packages/db/drizzle-sqlite/ | Generated migration SQL files (committed to git) |
| packages/db/tests/unit/schema-sqlite/parity.test.ts | Parity test verifying Postgres and SQLite columns |

### Modified Files

| File | Change |
|------|--------|
| packages/db/package.json | Add better-sqlite3, types, db:generate:sqlite script |
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
- crawl-tasks: drop tenantId. ADD `priorityScore`, `errorMessage`, `attempts`, `completedAt` as local extensions. Enum columns become text WITH CHECK constraints per spec section 5.2:
  - `status` CHECK IN ('pending','in_progress','completed','failed','skipped')
  - `priority` CHECK IN ('critical','high','medium','low') — NOTE: `critical` is a LOCAL EXTENSION not in the Postgres `task_priority` enum
  - `classification` CHECK IN ('single_entry','multiple_entries','navigation','irrelevant','partial')
  - `crawlerType` — no CHECK (only 2 values, validated at config layer)
  Use Drizzle's `check()` in the table options callback:
  ```typescript
  import { check } from 'drizzle-orm/sqlite-core';
  import { sql } from 'drizzle-orm';
  // In table definition third arg:
  check('status_check', sql`${table.status} IN ('pending','in_progress','completed','failed','skipped')`)
  ```
- actions: drop tenantId. Enum columns with CHECK constraints:
  - `source` CHECK IN ('extraction','schema_evolution','reconciliation','quality_audit')
  - `status` CHECK IN ('pending_review','approved','applied','rejected','rolled_back')
- source-trust: drop tenantId. **Spec deviation documented:** Postgres has `reasoning TEXT NOT NULL` — the spec's SQLite DDL (section 5.3) drops `reasoning` and adds `score REAL`. We follow the spec: DROP `reasoning`, ADD `score REAL`, ADD `created_at TEXT`. The parity test must exclude `reasoning` from the Postgres-to-SQLite comparison for this table.

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

## Task 5: Schema Barrel, Drizzle Kit Config, Migration Generation & Connection Factory

**Files:**
- Create: packages/db/src/schema-sqlite/index.ts
- Create: packages/db/drizzle.config.sqlite.ts
- Create: packages/db/src/project-db/connection.ts
- Modify: packages/db/package.json (add script)
- Modify: packages/db/src/index.ts

- [ ] **Step 1: Create SQLite schema barrel**

Export all tables from packages/db/src/schema-sqlite/index.ts:
- 7 mirrored files: pages, entities (includes entitySources), extractions, schemas, crawl-tasks, actions, source-trust
- 4 local-only files: runs, llm-usage, exports, project-meta

- [ ] **Step 2: Create Drizzle Kit config for SQLite**

Create `packages/db/drizzle.config.sqlite.ts`:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema-sqlite/index.ts',
  out: './drizzle-sqlite',
});
```

- [ ] **Step 3: Add generation script to package.json**

In `packages/db/package.json`, add to scripts:

```json
"db:generate:sqlite": "drizzle-kit generate --config drizzle.config.sqlite.ts"
```

- [ ] **Step 4: Generate initial SQLite migration**

Run:
```bash
cd /Users/salar/Projects/spatula && pnpm --filter @spatula/db db:generate:sqlite
```

This reads the SQLite Drizzle schemas and generates SQL migration files in `packages/db/drizzle-sqlite/`. The output should include:
- `0000_*.sql` — CREATE TABLE statements for all 12 tables
- `_journal.json` — migration tracking metadata

Verify the generated SQL looks correct (table names, column names, types match the Drizzle schemas).

**Note on regeneration:** Drizzle Kit assigns random tag names (e.g., `0000_previous_nova`) and timestamps to migration files. If you regenerate, the tag name and `when` field in `_journal.json` will differ, producing a git diff. This is expected — only regenerate when the schema actually changes. CI can verify freshness using `drizzle-kit generate --check` (non-zero exit if schema has changed since last generation).

**Note on `dbCredentials`:** The SQLite config intentionally omits `dbCredentials` — only `generate` is used, not `push` or `migrate` via CLI.

- [ ] **Step 5: Create SQLite connection factory**

Create `packages/db/src/project-db/connection.ts` with:

**`createProjectDb(dbPath: string): ProjectDbResult`** — creates a configured SQLite DB:
- Creates `better-sqlite3` Database instance
- Sets pragmas: WAL mode, FK enforcement, busy timeout 5s, synchronous NORMAL
- Wraps with Drizzle using the SQLite schema
- Returns `{ db, sqlite }` — callers use `db` for ORM queries, `sqlite` for shutdown

**`initializeProjectDb(db: ProjectDatabase, meta: { projectId: string; name: string })`** — applies migrations + seeds:
- Calls `migrate()` from `drizzle-orm/better-sqlite3/migrator` (synchronous)
- Migration folder: `resolve(__dirname, '../../drizzle-sqlite')` (at compile time __dirname = `packages/db/dist/project-db/`, so `../../drizzle-sqlite` = `packages/db/drizzle-sqlite/`)
- After migration, seeds `project_meta` via Drizzle ORM insert (idempotent via `onConflictDoNothing()`):
  ```typescript
  db.insert(projectMeta).values({ key: 'schema_version', value: '1' }).onConflictDoNothing().run();
  db.insert(projectMeta).values({ key: 'project_id', value: meta.projectId }).onConflictDoNothing().run();
  // ... etc
  ```
  `onConflictDoNothing()` is a method on the SQLite insert builder (maps to `INSERT OR IGNORE`). Call `.run()` at the end (better-sqlite3 is synchronous).

**IMPORTANT — ESM `__dirname` shim:** The package is `"type": "module"`. `__dirname` doesn't exist natively in ESM. Add at the top of connection.ts:

```typescript
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
```

This matches the pattern used in the existing `packages/db/src/migrate.ts`.

**Key advantages over raw SQL approach:**
- No hand-written SQL to drift from Drizzle schemas — SQL generated by Drizzle Kit
- Incremental version upgrades: user upgrades Spatula, `migrate()` applies only new migrations
- Type-safe seeding via Drizzle ORM insert
- Same pattern as existing Postgres migration runner

- [ ] **Step 6: Update db barrel exports**

Add to packages/db/src/index.ts:

```typescript
// Project database (SQLite for local mode)
export { createProjectDb, initializeProjectDb } from './project-db/connection.js';
export type { ProjectDatabase, ProjectDbResult } from './project-db/connection.js';
export * as sqliteSchema from './schema-sqlite/index.js';
```

- [ ] **Step 7: Verify build**

Run: pnpm --filter @spatula/db build

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema-sqlite/index.ts packages/db/drizzle.config.sqlite.ts packages/db/drizzle-sqlite/ packages/db/src/project-db/connection.ts packages/db/src/index.ts packages/db/package.json
git commit -m "feat(db): add SQLite connection factory with Drizzle Kit migrations"
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

1. **DB initialization smoke test:** Create an in-memory DB (`:memory:`), call `createProjectDb` then `initializeProjectDb`, verify `project_meta` contains `schema_version` and `project_id` by reading back via Drizzle ORM.

2. **Drizzle round-trip test:** After initialization, insert a row via Drizzle ORM (e.g., insert into `projectMeta` using the Drizzle schema), read it back, verify the data matches. This verifies that the Drizzle Kit-generated migration SQL creates tables that match the Drizzle ORM schema definitions — if they ever diverge (e.g., due to a drizzle-kit version change), this test catches it.

3. **Multi-table round-trip:** Insert into `runs` table (a local-only table with JSON column), read back, verify JSON is correctly serialized/deserialized. This tests the `text('field', { mode: 'json' })` mode works end-to-end through migrations.

- [ ] **Step 2: Ensure migration files exist before running tests**

The parity smoke tests call `initializeProjectDb` which calls `migrate()`, which reads SQL files from `packages/db/drizzle-sqlite/`. These must exist (generated in Task 5 Step 4). If running tests on a fresh checkout, run `pnpm --filter @spatula/db db:generate:sqlite` first.

- [ ] **Step 3: Run tests**

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

Expected: 12 files defining 13 tables total:
- 7 mirrored files with 8 mirrored tables: pages, entities + entity_sources (one file), extractions, schemas, crawl-tasks, actions, source-trust
- 4 local-only files with 4 local tables: runs, llm-usage, exports, project-meta
- 1 barrel: index.ts

Note: Spec section 5.1 says "9 core tables" — this counts entity_sources separately from entities (8 table objects across 7 files). The plan mirrors all of them.

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "test: verify Wave 2.3a -- SQLite schema with parity verification"
```
