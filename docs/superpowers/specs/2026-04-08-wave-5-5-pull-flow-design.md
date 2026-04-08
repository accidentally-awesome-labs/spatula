# Wave 5-5 Design: Pull Flow

**Status:** Approved
**Created:** 2026-04-08
**Parent spec:** `docs/superpowers/specs/2026-04-06-wave-5-decomposition-design.md` (section 4.5)
**Prerequisites:** Wave 5-4 (Remote Config & Push) — complete

---

## 1. Overview

The pull flow fetches entities, schema, and LLM usage from a hosted Spatula server back to the local project. It supports incremental pulls, crash recovery via cursor checkpointing, and schema conflict resolution through an interactive TUI.

**Scope (7 deliverables):**

1. `spatula pull` command — 9-step flow
2. Schema conflict resolution TUI
3. Incremental pull
4. Pull from running job
5. Partial pull recovery
6. Entity coexistence
7. Source filtering in explorer

**Deferred to 5-6:**

- `--include-extractions` and `--include-actions` flags (optional pull of extraction records and action history). Rationale: these are explicitly optional in the spec, add significant complexity (extraction records have FK dependencies on raw_pages which don't exist locally), and the primary pull use case (entities + schema + usage) is complete without them.

---

## 2. `spatula pull` Command

### 2.1 CLI Interface

```
spatula pull [remote-name] [options]

Options:
  --full        Force complete re-pull (clear previously-pulled entities first)
  --restart     Clear interrupted pull cursor and start fresh
  --remote, -r  Remote name (default: first configured remote)
```

### 2.2 The 9-Step Flow

**Step 1: Resolve remote**
- Read remote config from `~/.spatula/config.yaml` under `remotes.<name>`
- Read linked job ID from `project_meta` key `remote:<name>:job_id`
- If no linked job: error "No job linked for remote '<name>'. Run `spatula push` first."
- If no remote configured: error "No remote '<name>'. Run `spatula remote add` first."

**Step 2: Check job status**
- `GET /api/v1/jobs/:jobId` via `SpatulaApiClient.getJob()`
- If `completed` or `failed` → proceed normally
- If `running` or `paused` → trigger pull-from-running-job flow (section 4)
- If `cancelled` or `pending` → warn and confirm

**Step 3: Check for interrupted pull**
- Read `remote:<name>:pull_cursor` from `project_meta`
- If present and `--restart` not passed: print "Resuming interrupted pull from cursor..." and skip to step 5 with saved cursor
- If present and `--restart` passed: clear cursor, proceed fresh
- If not present: proceed fresh

**Step 4: Fetch and resolve schema**
- Fetch remote schema: `SpatulaApiClient.getSchema(jobId)` → `SchemaDefinition`
- Load local schema: `adapter.schemaRepo.findLatest(projectId, projectId)` (both params ignored, uses pre-bound projectId)
- If no local schema: accept remote schema, write to local DB and append fields to `spatula.yaml`
- If schemas differ: show schema conflict resolution TUI (section 3)
- If schemas match: skip, print "Schema up to date"

**Step 5: Fetch entities (batched cursor streaming)**
- If `--full` flag: delete all entities from previous pull runs for this remote via `deleteByRunIds()` (see section 5 for details)
- Determine `since` parameter:
  - If resuming (cursor exists): use cursor, no `since` (cursor already encodes position)
  - If incremental (has `remote:<name>:last_pull_at`): use that timestamp as `since`
  - If first pull or `--full`: no cursor, no `since`
- Loop:
  1. Call `SpatulaApiClient.getEntitiesStreamPaginated(jobId, { cursor, since, limit: 500 })` → `{ data: Entity[], pagination: { nextCursor?, hasMore, total } }`
     **Note:** The existing `getEntitiesStream()` uses the generic `.get()` unwrapper which strips the pagination envelope. A new `getEntitiesStreamPaginated()` method is needed that returns both `data` and `pagination` (similar to existing `listEntitiesPaginated()`).
  2. For each entity in batch:
     - Strip `tenantId`
     - Remap `jobId` → local `projectId`
     - Preserve original entity `id` (required for incremental upsert)
  3. Upsert batch into local SQLite via `adapter.entityRepo.upsertBatch(entities)`
  4. Save cursor to `project_meta`: `remote:<name>:pull_cursor` = `pagination.nextCursor`
  5. Update progress display (entities pulled so far, batch number)
  6. If `pagination.nextCursor` is null or `pagination.hasMore` is false → done
- Track total entities inserted and updated counts

**Step 6: Fetch LLM usage summary**
- Call `SpatulaApiClient.getUsage()` → tenant-wide usage aggregation (totalTokens, totalCostUsd, byModel, byPurpose, byJob)
- The existing `GET /api/v1/usage` endpoint returns usage for all jobs; extract the linked job's usage from the `byJob` array by matching `jobId`
- Store job-specific aggregate totals in the pull-run record (`llmTokensUsed`, `llmCostUsd`)
- Store detailed breakdown in `project_meta` as `remote:<name>:last_pull_usage` (JSON-serialized)

**Step 7: Create pull-run record**
- `adapter.runRepo.create({ status: 'pulled', source: 'remote:<name>:<jobId>', configSnapshot: { remote, jobId, full, incremental }, startedAt })`
- Then `adapter.runRepo.updateStats(runId, { entitiesCreated: insertCount, llmTokensUsed, llmCostUsd })` — separate call because `create()` only accepts status/source/config/startedAt

**Step 8: Clear cursor + update timestamps**
- Delete `remote:<name>:pull_cursor` from `project_meta`
- Set `remote:<name>:last_pull_at` = current ISO timestamp

**Step 9: Print summary**
```
Pull complete from 'prod' (job abc123)
  Entities:  142 new, 28 updated (170 total)
  Schema:    3 new fields merged
  LLM usage: 45,230 tokens ($0.12)
  Duration:  12.3s
```

---

## 3. Schema Conflict Resolution TUI

### 3.1 Ink Component: `SchemaConflict`

**File:** `apps/cli/src/components/SchemaConflict.tsx`

Shows a field-level diff between local and remote schemas, then prompts for resolution.

**Display:**

```
Schema differences detected:

  Local only:          Remote only:         Changed:
  - local_field_1      + remote_field_1     ~ shared_field (type: string→number)
  - local_field_2      + remote_field_2

Resolution:
  [1] Use remote schema (recommended) — replaces local with remote
  [2] Keep local schema — ignore remote changes
  [3] Merge — keep all fields from both schemas

Choice (1/2/3):
```

**Behavior by choice:**

1. **Use remote:** Replace local schema in SQLite. Overwrite fields in `spatula.yaml`.
2. **Keep local:** No schema changes. Entities are still pulled (field mismatch handled at data level).
3. **Merge:** Union of both field sets. New fields from remote appended to `spatula.yaml` with comment marker.

### 3.2 Schema Diff Utility

**File:** `apps/cli/src/lib/schema-diff.ts`

```typescript
interface SchemaDiff {
  localOnly: FieldDefinition[];     // fields in local but not remote
  remoteOnly: FieldDefinition[];    // fields in remote but not local
  changed: Array<{
    name: string;
    local: FieldDefinition;
    remote: FieldDefinition;
    differences: string[];          // human-readable diff descriptions
  }>;
  unchanged: FieldDefinition[];
  hasChanges: boolean;
}

function diffSchemas(local: SchemaDefinition, remote: SchemaDefinition): SchemaDiff
```

Fields are matched by `name`. Type changes, required flag changes, and nested field changes are detected.

### 3.3 `spatula.yaml` Field Appender

**File:** `apps/cli/src/lib/yaml-fields.ts`

Appends new fields to the `fields:` section of `spatula.yaml` without destroying existing comments or formatting.

**Strategy:** Read file as raw string, find the `fields:` block, append new entries at the end with a comment header:

```yaml
# Discovered by remote crawl (2026-04-08):
  - field: remote_field_1
    type: string
  - field: remote_field_2
    type: number
    required: true
```

Uses string manipulation (find last field entry, append after it) rather than full YAML parse-serialize to preserve formatting.

**Edge cases:**
- No `fields:` key → append `fields:` section at end of file
- Empty `fields:` block (e.g., `fields: []`) → replace with populated block
- Tab vs space indentation → detect from existing file content, match style
- `FieldDefinition` type imported from `@spatula/core/types/schema.js`

---

## 4. Pull From Running Job

When the linked job status is `running` or `paused`:

```
Job 'abc123' is still running (142/500 pages crawled).

  [1] Pull current snapshot (can pull again later)
  [2] Wait for completion (polls every 30s)
  [3] Cancel pull

Choice (1/2/3):
```

**Option 1 (snapshot):** Proceed with pull. Entities available so far are fetched. User can run `spatula pull` again later for the rest (incremental pull handles this).

**Option 2 (wait):** Poll `SpatulaApiClient.getJob(jobId)` every 30 seconds. Show spinner with status updates. When `completed` (or `failed`), proceed with pull.

**Option 3 (cancel):** Exit with no changes.

---

## 5. Incremental Pull

On subsequent pulls after the first:

1. Read `remote:<name>:last_pull_at` from `project_meta`
2. If present: pass as `since` parameter to the entity streaming endpoint
3. Server returns only entities created/updated after that timestamp
4. Upserted locally — existing entities updated, new ones inserted
5. On completion: `last_pull_at` updated to current time

**`--full` flag behavior:**
1. Delete all entities belonging to pull runs from this remote
   - Query: find all runs where `source LIKE 'remote:<name>:%'`
   - Delete entities where `jobId = projectId` and entity was created by those runs
   - Alternative: track entity IDs per run in a junction, or tag entities with `source` in a meta column
   - **Chosen approach:** Add optional `runId` column to SQLite entities table (nullable, no migration needed for existing entities). Pulled entities get `runId` set. `--full` deletes by `runId IN (SELECT id FROM runs WHERE source LIKE ...)`.
2. Clear `last_pull_at`
3. Pull all entities fresh

---

## 6. Partial Pull Recovery (Crash Recovery)

The pull cursor is checkpointed to `project_meta` after every batch:

```
remote:<name>:pull_cursor = <base64url cursor from API response>
```

**Recovery flow:**
- On `spatula pull`, step 3 checks for existing cursor
- If found: resume from that cursor (entities before cursor already upserted)
- If user wants to start over: `spatula pull --restart` clears cursor

**Consistency:** Because entities are upserted (not insert-only), replaying a partial batch after crash is safe — duplicates are updated in place.

---

## 7. Entity Coexistence

Pulled and local entities share the `entities` table in SQLite.

**Distinction:** Via `runs.source` field:
- `'local'` — from local crawl runs
- `'remote:<name>:<jobId>'` — from pull operations

**Rules for pulled entities:**
- NOT flagged for re-extraction (no local HTML exists)
- Preserve original entity IDs from remote (for incremental upsert)
- `runId` column links entity → pull run for cleanup/filtering

---

## 8. Source Filtering in Explorer

### 8.1 Keybinding

Add `[s]` (source) toggle in `ExplorerView` cycling through (`[f]`/`[F]` are already bound to the text filter bar):
- **All** (default) — show all entities
- **Local only** — entities from runs where `source = 'local'`
- **Remote only** — entities from runs where `source LIKE 'remote:%'`

### 8.2 Implementation

**`SqliteEntityRepository` extension:**

```typescript
async findByJobFiltered(
  jobId: string,
  tenantId: string,
  options?: { limit: number; offset: number; sourceFilter?: 'all' | 'local' | 'remote' },
): Promise<unknown[]>
```

When `sourceFilter` is `'local'` or `'remote'`:
- JOIN `entities` with `runs` via `runId`
- Filter on `runs.source = 'local'` or `runs.source LIKE 'remote:%'`
- Entities with `runId = NULL` (pre-existing, from before pull feature) treated as local

### 8.3 Status Bar

Show active filter in explorer status bar: `[Filter: All]`, `[Filter: Local]`, `[Filter: Remote]`

---

## 9. Infrastructure Additions

### 9.0 `LocalProject` Interface Expansion

**File:** `apps/cli/src/local-project.ts`

The current `LocalProject` interface only exposes `dataSource`, `projectRoot`, `projectId`, `metaRepo`, and `close()`. The push/remote commands only need `metaRepo`, but pull needs direct access to `schemaRepo`, `entityRepo`, and `runRepo` for writes.

**Change:** Expose the `ProjectAdapter` as `adapter` on `LocalProject`:

```typescript
interface LocalProject {
  dataSource: DataSource;
  projectRoot: string;
  projectId: string;
  metaRepo: ProjectMetaRepository;
  adapter: ProjectAdapter;            // NEW — exposes all SQLite repos
  close(): void;
}
```

The `ProjectAdapter` is already constructed internally by `openLocalProject()` — just return it. Pull uses `adapter.entityRepo`, `adapter.schemaRepo`, and `adapter.runRepo`.

### 9.1 `SqliteEntityRepository.upsertBatch()`

New method for bulk upsert of pulled entities:

```typescript
async upsertBatch(entities: Array<{
  id: string;                           // preserve remote ID
  mergedData: Record<string, unknown>;
  provenance: Record<string, unknown>;
  qualityScore: number;
  categories: unknown[];
  runId: string;                        // pull run ID
}>): Promise<{ inserted: number; updated: number }>
```

Uses Drizzle's `onConflictDoUpdate()` on the `id` PK (NOT `INSERT OR REPLACE`, which is destructive — it deletes then re-inserts, wiping any FK-linked `entity_sources` rows). The `onConflictDoUpdate` updates `mergedData`, `provenance`, `qualityScore`, `categories`, `runId`, and `updatedAt` while preserving the row and its FK relationships. Returns counts for summary display.

**Note on UUID collision:** Both local and remote entities use UUIDs. Collision probability is negligible (~2^-122). The spec accepts this risk rather than adding ID namespacing complexity.

### 9.2 `SqliteEntityRepository.deleteByRunIds()`

Delete entities belonging to specific runs (for `--full` flag):

```typescript
async deleteByRunIds(runIds: string[]): Promise<number>
```

### 9.3 `SqliteEntityRepository.countBySource()`

Count entities by source filter (for explorer status):

```typescript
async countBySource(filter: 'all' | 'local' | 'remote'): Promise<number>
```

### 9.4 SQLite Entities Table: `runId` Column

Add nullable `runId TEXT` column to the `entities` table in `packages/db/src/schema-sqlite/entities.ts`. Requires a Drizzle migration for existing local projects. New entities from local crawls continue to have `runId = NULL` (backward compatible). Pulled entities always have `runId` set.

### 9.5 `SpatulaApiClient` New Methods

**`getEntitiesStreamPaginated()`** — cursor-based entity fetch that preserves the pagination envelope:

```typescript
async getEntitiesStreamPaginated(
  jobId: string,
  query?: { cursor?: string; since?: string; limit?: number },
): Promise<{
  data: Record<string, unknown>[];
  pagination: { nextCursor?: string; hasMore: boolean; total: number };
}>
```

The existing `getEntitiesStream()` uses the generic `.get()` unwrapper which strips pagination. This new method does its own `fetch()` and returns the full response shape (similar to the existing `listEntitiesPaginated()` pattern).

**`getUsage()`** — wraps `GET /api/v1/usage`:

```typescript
async getUsage(query?: { period?: string }): Promise<{
  period: { start: string; end: string };
  totalTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { tokens: number; costUsd: number }>;
  byPurpose: Record<string, { tokens: number; costUsd: number }>;
  byJob: Array<{ jobId: string; tokens: number; costUsd: number }>;
}>
```

Note: This is a tenant-wide endpoint. Job-specific usage is extracted client-side from the `byJob` array.

### 9.6 Progress Display

Ink component for pull progress:

```
Pulling entities from 'prod'...
  Batch 4/? │ 1,842 entities fetched │ 12.3s elapsed
```

Uses `<Spinner>` from ink-spinner + batch counter. Total batches unknown upfront (cursor-based), so show `?` until final batch.

### 9.7 Command Registration

Register `pull` command in `apps/cli/src/index.tsx` alongside existing `push` and `remote`.

---

## 10. Meta Key Schema

All pull-related state stored in `project_meta` (SQLite key-value):

| Key | Value | Lifecycle |
|-----|-------|-----------|
| `remote:<name>:job_id` | Remote job UUID | Set by push, read by pull |
| `remote:<name>:pushed_at` | ISO timestamp | Set by push |
| `remote:<name>:config_hash` | 12-char SHA256 | Set by push |
| `remote:<name>:pull_cursor` | Base64url cursor | Set per batch, cleared on completion |
| `remote:<name>:last_pull_at` | ISO timestamp | Set on pull completion |
| `remote:<name>:last_pull_usage` | JSON usage summary | Set on pull completion |

---

## 11. Error Handling

| Scenario | Behavior |
|----------|----------|
| Remote unreachable | Error with "Cannot reach remote '<name>' at <url>. Check connection." |
| Auth failure (401/403) | Error with "Authentication failed. Run `spatula remote add` to reconfigure." |
| Job not found (404) | Error with "Job <id> not found on remote. It may have been deleted." Clear stale meta. |
| Network error mid-pull | Cursor already checkpointed. Next `spatula pull` resumes. |
| Schema fetch fails | Error before entity pull starts. No partial state. |
| Entity batch fails | Cursor from last successful batch is saved. Resume on retry. |
| Local DB write fails | SQLite transaction per batch. Failed batch is not partially written. |

---

## 12. File Map

| File | Action | Purpose |
|------|--------|---------|
| `apps/cli/src/commands/pull.ts` | New | Pull command implementation |
| `apps/cli/src/components/SchemaConflict.tsx` | New | Schema conflict resolution TUI |
| `apps/cli/src/lib/schema-diff.ts` | New | Field-level schema comparison |
| `apps/cli/src/lib/yaml-fields.ts` | New | Append fields to spatula.yaml |
| `apps/cli/src/lib/pull-progress.tsx` | New | Ink progress display for pull |
| `apps/cli/src/api/client.ts` | Modify | Add `getEntitiesStreamPaginated()` and `getUsage()` methods |
| `apps/cli/src/local-project.ts` | Modify | Expose `adapter: ProjectAdapter` on `LocalProject` interface |
| `apps/cli/src/index.tsx` | Modify | Register pull command |
| `apps/cli/src/components/explorer/ExplorerView.tsx` | Modify | Add `[s]` source filter toggle |
| `apps/cli/src/components/explorer/DataTable.tsx` | Modify | Show source filter indicator in status |
| `packages/db/src/schema-sqlite/entities.ts` | Modify | Add nullable `runId` column |
| `packages/db/src/project-db/repositories/entity-repository.ts` | Modify | Add upsertBatch, deleteByRunIds, countBySource, findByJobFiltered |

---

## 13. Testing Strategy

- **Unit tests:** Schema diff utility, YAML field appender, entity transform (strip tenantId, remap jobId)
- **Integration tests:** Pull command with mocked API client — full flow, incremental, resume, --full
- **Repository tests:** upsertBatch (insert + update), deleteByRunIds, countBySource, findByJobFiltered
- **TUI tests:** Schema conflict component renders diff, handles selection
- **Explorer tests:** Source filter toggle cycles correctly, filtered queries work
