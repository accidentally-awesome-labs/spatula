# Wave 5-6 Design: Deferred Items

**Date:** 2026-04-09
**Status:** Approved
**Parent spec:** `docs/superpowers/specs/2026-04-06-wave-5-decomposition-design.md` (section 4.6)
**Prerequisites:** Wave 5-5 (Pull Flow) — complete

---

## 1. Overview

Wave 5-6 addresses deferred items from Waves 2–5 that are now unblocked. The items are organized into three implementation groups by domain:

- **Group 1 — Remote & Platform Polish** (7 items): security, observability, and pull command enhancements
- **Group 2 — Local Extraction & Dedup** (2 items): CSS table extraction and crawl history dedup
- **Group 3 — Technical Debt** (1 item): config diff recursive comparison

### Item Inventory

| #   | Item                                               | Group | Server                                | CLI/Core                   | Migration |
| --- | -------------------------------------------------- | ----- | ------------------------------------- | -------------------------- | --------- |
| 1a  | Tenant creation auth protection                    | 1     | Route guard + env var                 | —                          | —         |
| 1b  | Quota audit logging                                | 1     | AuditLogger wiring                    | —                          | —         |
| 1c  | OpenRouter cost header extraction                  | 1     | —                                     | Core pkg                   | —         |
| 1d  | Observable gauge registration                      | 1     | Startup wiring                        | —                          | —         |
| 1e  | ApiDataSource status stubs                         | 1     | Job stats enrichment                  | Wire client fields         | —         |
| 1f  | `spatula reset --keep-remote`                      | 1     | —                                     | Reset command              | —         |
| 1g  | Pull `--include-extractions` / `--include-actions` | 1     | pageUrl join, entity-sources endpoint | Pull loop, progress, flags | Yes       |
| 2a  | CSS extractor table extraction                     | 2     | —                                     | Core pkg                   | —         |
| 2b  | `spatula add` crawl history dedup                  | 2     | —                                     | Add command                | —         |
| 3a  | Config diff recursive comparison                   | 3     | —                                     | Core pkg                   | —         |

---

## 2. Group 1: Remote & Platform Polish

### 2.1 Tenant Creation Auth Protection

**File:** `apps/api/src/app.ts:127`

**Problem:** `POST /api/v1/tenants` is unauthenticated — any caller can create tenants. Acceptable for dev/self-hosted bootstrap, but a security gap on hosted deployments.

**Design:**

- Add a shared-secret gate via `TENANT_CREATION_SECRET` env var
- When set: requests to `POST /api/v1/tenants` must include `X-Creation-Secret` header matching the value. Return 403 on mismatch.
- When unset: endpoint remains open (current behavior — dev/self-hosted compatible)
- Implement as inline middleware on the tenant routes mount, not a global middleware change

**New env var:** `TENANT_CREATION_SECRET` (optional). Add to `.env.example` with comment: "Set to restrict tenant creation to callers with the shared secret. Leave unset for open bootstrap (dev/self-hosted)."

### 2.2 Quota Audit Logging

**File:** `packages/queue/src/job-manager.ts`

**Problem:** `JobManager` throws `QuotaExceededError` on job creation quota violations but doesn't log an audit event.

**Design:**

- Add `auditLogger?: AuditLogger` to `JobManagerConfig`
- On `QuotaExceededError` from `quotaEnforcer.checkAndRecord()`, emit audit event before re-throwing:
  ```
  { action: 'quota.exceeded', tenantId, dimension: 'jobs', current, max }
  ```
- On concurrent job quota exceeded (the `getQuotas` path at line 58–72), emit the same pattern with `dimension: 'concurrent_jobs'`
- Wire `AuditLogger` into `JobManager` at server startup

### 2.3 OpenRouter Cost Header Extraction

**File:** `packages/core/src/llm/openrouter-client.ts:106`

**Problem:** `costUsd` is hardcoded to 0. OpenRouter returns actual cost in `x-openrouter-cost` response header.

**Design:**

- After `const response = await this.doFetch(body)` (line 74), extract: `const costUsd = parseFloat(response.headers.get('x-openrouter-cost') ?? '') || 0;`
- Pass `costUsd` to `usageRecorder.record()` instead of the hardcoded 0
- No interface changes — `UsageRecord.costUsd` already accepts `number`
- `doFetch()` already returns the full `Response` object; headers are readable before or after `.json()`

### 2.4 Observable Gauge Registration

**File:** `packages/shared/src/metrics.ts:46`

**Problem:** Three observable gauges (`queue_depth`, `active_jobs`, `tenant_count`) are TODO stubs. They need access to repositories that aren't available at metrics creation time.

**Design:**

- Add `registerGauges(deps: { jobRepo, tenantRepo, queueProvider })` function exported from the metrics module
- Creates three `ObservableGauge` callbacks that lazily read current values on Prometheus scrape:
  - `queue_depth` — sum of waiting + active across all queues
  - `active_jobs` — count of jobs with `status = 'running'`
  - `tenant_count` — total tenant count
- Gauge callbacks must be wrapped in try/catch, returning 0 on error to prevent crashing the metrics scrape
- Called once at server startup after repos are constructed (in `apps/api/src/server.ts` or equivalent)
- Return type of `createMetrics()` unchanged — gauges don't need to be accessed by callers

### 2.5 ApiDataSource Status Stubs

**Files:** `apps/cli/src/data-sources/api-data-source.ts:74-76`, `apps/api/src/routes/jobs.ts`

**Problem:** Three fields in `ApiDataSource.getStatus()` return stub zeros: `pendingActions`, `schemaFields`, `storageBytes`.

**Design:**

**Server-side:** Enrich the job detail query to compute and include in the `stats` object:

- `pendingActionsCount` — `SELECT COUNT(*) FROM actions WHERE job_id = ? AND tenant_id = ? AND status = 'pending_review'`
- `schemaFieldCount` — count fields in the latest schema version's definition
- `storageBytesUsed` — already available on tenant model (`storageBytesUsed` field); for per-job, use `SELECT COALESCE(SUM(LENGTH(content)), 0) FROM raw_pages WHERE job_id = ? AND tenant_id = ?`

These are added to the `stats` JSON field on the job response (which is `z.record(z.number()).nullable()`), not as new top-level fields.

**Client-side:** In `ApiDataSource.getStatus()`, read from `job.stats`:

```typescript
pendingActions: (job.stats as any)?.pendingActionsCount ?? 0,
schemaFields: (job.stats as any)?.schemaFieldCount ?? 0,
storageBytes: { pages: (job.stats as any)?.storageBytesUsed ?? 0, database: 0, exports: 0 },
```

### 2.6 `spatula reset --keep-remote`

**File:** `apps/cli/src/commands/reset.ts`

**Problem:** `spatula reset` clears all `.spatula/` contents. No way to reset local crawl data while preserving remote job links and pulled data.

**Design:**

- Add `keepRemote?: boolean` to `ResetOptions`
- `--keep-remote` implies `--keep-entities` (the SQLite DB must survive to preserve remote state)
- After the filesystem reset (remove/recreate dirs), if `keepRemote` is true, open the DB and selectively clean:
  1. Delete all `runs` rows where `source = 'local'`
  2. Delete local entities: `DELETE FROM entities WHERE run_id IS NULL OR run_id NOT LIKE 'remote:%'` — NULL `runId` means pre-pull-feature local entities, non-`remote:` prefix means local run entities
  3. Delete all `crawl_tasks`, `pages` (always local — these are never pulled)
  4. Delete local extractions/actions: `DELETE FROM extractions WHERE run_id IS NULL OR run_id NOT LIKE 'remote:%'` (same pattern for actions)
  5. Preserve all `project_meta` entries matching `remote:*` keys
- Note: a new `deleteLocalEntities()` method (and equivalent for extractions/actions) should be added rather than reusing `deleteByRunIds`, since the inverse pattern + NULL handling requires a custom query
- Without `--keep-remote`: clear everything (current behavior unchanged)

**CLI registration:** Add `--keep-remote` boolean option to `reset` command in `index.tsx`.

### 2.7 Pull `--include-extractions` / `--include-actions`

**Files:** `apps/cli/src/commands/pull.ts`, `apps/cli/src/api/client.ts`, `apps/api/src/routes/extractions.ts`, multiple SQLite repos

**Problem:** Pull command only fetches entities. Extraction records, entity-source linkage, and action history are not pulled.

#### 2.7.1 SQLite Migration (single migration file)

All schema changes in one Drizzle migration:

- `extractions`: add nullable `runId` text column, add nullable `pageUrl` text column, make `pageId` nullable (for remote records without local page data). Add index on `runId`.
- `actions`: add nullable `runId` text column. Add index on `runId`.

**SQLite migration note:** Making `pageId` nullable requires table recreation in SQLite (SQLite does not support `ALTER COLUMN ... DROP NOT NULL`). Drizzle Kit handles this automatically via copy-recreate (create temp table, copy data, drop original, rename). **Test the migration against a populated local project DB** to ensure existing extraction data with non-null `pageId` is preserved during the recreation.

#### 2.7.2 Server-Side Changes

**Extraction API response:** Update `extractionResponseSchema` in `apps/api/src/schemas/responses.ts`:

- Change `pageId: z.string().uuid()` → `pageId: z.string().uuid().nullable()`
- Add `pageUrl: z.string().nullable()`
  In the extraction repository's `findByJob` and `findByJobCursor` methods, LEFT JOIN with `raw_pages` to include the page URL. Note: making `pageId` nullable on the API response is a backward-compatible addition (existing non-null values remain valid), but consumers parsing with strict Zod schemas will need to accept nulls.

**Entity-sources endpoint:** New route `GET /api/v1/jobs/:jobId/entity-sources` with cursor pagination.

- Register in `app.ts` under the existing jobs route group (tenant-scoped, same middleware chain)
- Response schema: `{ data: Array<{ entityId: z.string().uuid(), extractionId: z.string().uuid(), matchConfidence: z.number() }>, pagination: PaginationEnvelope }`
- Query params: `cursor`, `since`, `limit` (same pattern as extractions/actions endpoints)
- File: `apps/api/src/routes/entity-sources.ts` (new)

**Job stats enrichment:** Add `pendingActionsCount` and `schemaFieldCount` to job detail stats (see 2.5).

#### 2.7.3 API Client Methods

Add to `SpatulaApiClient`:

- `getExtractionsStreamPaginated(jobId, { since?, limit? })` — returns `{ data, pagination }` envelope
- `getActionsStreamPaginated(jobId, { since?, limit? })` — returns `{ data, pagination }` envelope
- `getEntitySourcesStreamPaginated(jobId, { since?, limit? })` — returns `{ data, pagination }` envelope

#### 2.7.4 SQLite Repository Methods

- `SqliteExtractionRepository`: add `upsertBatch()` (on conflict update by `id`), `deleteByRunIds(runIds)`
- `SqliteActionRepository`: add `upsertBatch()` (on conflict update by `id`), `deleteByRunIds(runIds)`
- Entity source methods (co-located in `packages/db/src/project-db/repositories/entity-repository.ts` alongside entity methods): add `upsertBatchSources()`, `deleteByExtractionIds()`

#### 2.7.5 Pull Flow Extension

After the existing entity pull loop (step 5), when flags are enabled:

**Step 6 — Extractions** (if `--include-extractions`):

1. Resume from `remote:{name}:pull_cursor_extractions` (independent cursor)
2. Fetch batch via `client.getExtractionsStreamPaginated(jobId, { since, limit: 100 })`
3. For each extraction: store `pageUrl` directly on the record, set `pageId` to null, set `runId` to the current pull-run record ID (same run used for entities — all pulled data types share one run ID for cleanup tracking)
4. Upsert batch into SQLite extractions table
5. Checkpoint cursor to `project_meta`

**Step 7 — Entity Sources** (if `--include-extractions`, pulled automatically):

1. Resume from `remote:{name}:pull_cursor_entity_sources`
2. Fetch batch via `client.getEntitySourcesStreamPaginated(jobId, { since, limit: 500 })`
3. Upsert batch into SQLite `entity_sources` table
4. Checkpoint cursor

**Step 8 — Actions** (if `--include-actions`):

1. Resume from `remote:{name}:pull_cursor_actions`
2. Fetch batch via `client.getActionsStreamPaginated(jobId, { since, limit: 100 })`
3. For each action: set `runId` to current run ID
4. Upsert batch into SQLite actions table
5. Checkpoint cursor

**Pull order matters:** entities → extractions → entity_sources → actions. Entity and extraction IDs must exist before entity_sources can reference them.

#### 2.7.6 `--full` Flag Behavior

When `--full` is combined with:

- `--include-extractions`: first collect extraction IDs for the remote run IDs, delete matching `entity_sources` rows, then delete extractions by `runId` (via `deleteByRunIds`). Order matters: entity_sources FK references must be cleared before extractions.
- `--include-actions`: clear previously-pulled actions by `runId` (via `deleteByRunIds`)

#### 2.7.7 PullResult Extension

Add to `PullResult`:

```typescript
extractionsInserted?: number;
extractionsUpdated?: number;
entitySourcesInserted?: number;
actionsInserted?: number;
actionsUpdated?: number;
```

#### 2.7.8 Pull Progress Display

The existing pull command uses inline `process.stderr.write` for progress (no Ink component exists yet). Create a `PullProgress` Ink component or extend the inline progress to support multi-phase display:

- Show current phase label: "Pulling entities...", "Pulling extractions...", "Pulling entity sources...", "Pulling actions..."
- Show per-phase batch count / total
- Overall progress across all active phases

#### 2.7.9 CLI Flag Registration

In `index.tsx`, add to the `pull` command:

```typescript
.option('include-extractions', {
  type: 'boolean',
  default: false,
  describe: 'Also pull extraction records from the remote job',
})
.option('include-actions', {
  type: 'boolean',
  default: false,
  describe: 'Also pull action history from the remote job',
})
```

---

## 3. Group 2: Local Extraction & Dedup

### 3.1 CSS Extractor Table Extraction

**File:** `packages/core/src/extraction/css-extractor.ts`

**Problem:** CSS extractor handles `currency`, `url`, `number`, `array`, `string` field types but cannot extract tabular data from `<table>` elements.

**Design decision:** Do NOT add a new `table` field type to the schema enum. Tables are semantically arrays of objects — an `array` field where `arrayItemType.type === 'object'` maps directly to a table. This avoids rippling changes through `FieldDefinition` (3 type locations), `field-proposer.ts`, `config/types.ts`, and LLM schema evolution prompts.

#### 3.1.1 Extraction Logic

Enhance the `array` case in `extractByField()`:

```
case 'array':
  if (field.arrayItemType?.type === 'object' || field.objectFields) {
    return findTable($, fieldName);
  }
  return findList($, fieldName);
```

New `findTable($, fieldName)` function:

1. **Locate table:**
   - `table[class*="${fieldName}"]` → `table[id*="${fieldName}"]` → `article table, main table, .content table` → first `<table>` on page
2. **Extract headers:**
   - From `<thead> th` elements
   - Fallback: first `<tr>` cells as headers
   - Last resort: generate `col_0`, `col_1`, etc.
3. **Extract rows:**
   - Iterate `<tbody> tr` (or all `<tr>` after header row)
   - Map each `<td>` to the corresponding header key
   - Trim whitespace, skip entirely empty rows
4. **Edge cases:**
   - `colspan`: fill adjacent columns with the same value
   - `rowspan`: basic support — propagate value to subsequent rows
   - Nested tables: skip — only extract from the outermost matching table
   - `<th>` in `<tbody>`: treat as cell values alongside `<td>` (some tables use row headers)
5. **Return:** `Array<Record<string, string>>` or `null` if no table found

#### 3.1.2 Auto-Discovery Enhancement

In `autoDiscover()`, after existing detections, add:

- Find `<table>` elements in content areas (`article table`, `main table`, `.content table`) with 3+ data rows
- Include first matching table as `tables` key in the discovered data object
- Limit to first table to avoid noise from navigation/layout tables

### 3.2 `spatula add` Crawl History Dedup

**File:** `apps/cli/src/commands/add.ts`

**Problem:** `runAddCommand()` deduplicates URLs only against seeds in `spatula.yaml`. URLs already crawled in prior runs are accepted as new.

#### 3.2.1 Repository Method

Add to `SqliteCrawlTaskRepository`:

```typescript
async findCompletedUrls(): Promise<string[]> {
  const rows = this.db
    .select({ url: crawlTasks.url })
    .from(crawlTasks)
    .where(
      and(
        eq(crawlTasks.jobId, this.projectId),
        eq(crawlTasks.status, 'completed'),
      ),
    )
    .all();
  return rows.map(r => r.url);
}
```

The existing `sl_crawl_tasks_url_idx` index covers URL lookups. A compound `(status, url)` index is unnecessary for local SQLite (table size is bounded by crawl history, typically <10K rows).

#### 3.2.2 Command Changes

In `runAddCommand()`:

1. After reading `spatula.yaml`, attempt to open the local project DB via `openLocalProject()` inside a try/catch
2. If DB exists, call `taskRepo.findCompletedUrls()` and normalize the results with the same `normaliseUrl()` function
3. Pass crawled URL set as additional dedup source to `validateAndDedup()`
4. If `.spatula/project.db` doesn't exist (ENOENT), or the DB is locked (SQLITE_BUSY), or any other DB error occurs: log a warning and proceed without history dedup — never let DB access failure break URL addition
5. Always call `close()` on the DB handle in a `finally` block to prevent leaked file descriptors

#### 3.2.3 Interface Extensions

Extend `DeduplicationResult` and `AddResult` with:

```typescript
alreadyCrawled: string[];  // URLs skipped because they were already crawled
```

Extend `validateAndDedup()` signature:

```typescript
export function validateAndDedup(
  urls: string[],
  existingSeeds: string[],
  crawledUrls?: string[],
): DeduplicationResult;
```

When a URL matches `crawledUrls`, add to `alreadyCrawled` instead of `duplicates`.

#### 3.2.4 `--no-history` Flag

Add `noHistory?: boolean` to skip the DB lookup entirely. Useful when the user intentionally wants to re-crawl a URL.

**CLI registration:** In `index.tsx`, add to the `add` command:

```typescript
.option('no-history', {
  type: 'boolean',
  default: false,
  describe: 'Skip crawl history dedup (allow re-adding crawled URLs)',
})
```

#### 3.2.5 Output Format

```
Added 5 URL(s):
  + https://example.com/new-page
Skipped 2 already in config:
  ~ https://example.com/existing
Skipped 3 already crawled:
  ↻ https://example.com/done-page
```

---

## 4. Group 3: Technical Debt

### 4.1 Config Diff Recursive Comparison

**File:** `packages/core/src/config/config-differ.ts:195`
**Types:** `packages/core/src/config/diff-types.ts`

**Problem:** `diffFieldProperties()` compares top-level field properties but skips recursive comparison of `objectFields` and `arrayItemType`. Returns `Array<{ property: string; from: unknown; to: unknown }>` which feeds into `FieldChange.changes`.

**Design:**

The existing `FieldChange` interface is `{ name: string; changes: Array<{ property, from, to }> }`. Extend the change entry type to support nesting:

```typescript
// In diff-types.ts, extend the changes array entry type:
export interface PropertyChange {
  property: string;
  from: unknown;
  to: unknown;
  nestedChanges?: PropertyChange[]; // for recursive arrayItemType/objectFields
  addedFields?: string[]; // for objectFields: names of added sub-fields
  removedFields?: string[]; // for objectFields: names of removed sub-fields
}

export interface FieldChange {
  name: string;
  changes: PropertyChange[];
}
```

After existing property comparisons in `diffFieldProperties()` (line 195), add:

**arrayItemType:**

```typescript
if (current.arrayItemType && previous.arrayItemType) {
  const nestedChanges = diffFieldProperties(current.arrayItemType, previous.arrayItemType);
  if (nestedChanges.length > 0) {
    changes.push({
      property: 'arrayItemType',
      from: previous.arrayItemType,
      to: current.arrayItemType,
      nestedChanges,
    });
  }
} else if (current.arrayItemType !== previous.arrayItemType) {
  changes.push({
    property: 'arrayItemType',
    from: previous.arrayItemType,
    to: current.arrayItemType,
  });
}
```

**objectFields:**

```typescript
if (current.objectFields || previous.objectFields) {
  const currentFields = new Map((current.objectFields ?? []).map((f) => [f.name, f]));
  const previousFields = new Map((previous.objectFields ?? []).map((f) => [f.name, f]));

  const addedFields = [...currentFields.keys()].filter((k) => !previousFields.has(k));
  const removedFields = [...previousFields.keys()].filter((k) => !currentFields.has(k));
  const nestedChanges = [...currentFields.keys()]
    .filter((k) => previousFields.has(k))
    .flatMap((k) => diffFieldProperties(currentFields.get(k)!, previousFields.get(k)!));

  if (addedFields.length || removedFields.length || nestedChanges.length) {
    changes.push({
      property: 'objectFields',
      from: previous.objectFields,
      to: current.objectFields,
      nestedChanges,
      addedFields,
      removedFields,
    });
  }
}
```

---

## 5. Cross-Cutting Concerns

### 5.1 SQLite Migration

One migration file covering all schema changes:

- `extractions`: add nullable `run_id`, add nullable `page_url`, make `page_id` nullable. Add index on `run_id`.
- `actions`: add nullable `run_id`. Add index on `run_id`.

### 5.2 CLI Entrypoint Updates

Three commands need new flags registered in `apps/cli/src/index.tsx`:

- `pull`: `--include-extractions`, `--include-actions`
- `reset`: `--keep-remote`
- `add`: `--no-history`

### 5.3 Environment Variables

| Variable                 | Required | Default        | Item |
| ------------------------ | -------- | -------------- | ---- |
| `TENANT_CREATION_SECRET` | No       | (unset = open) | 1a   |

Add to `.env.example`.

### 5.4 Server-Side Deliverables Summary

| Change                                                       | File(s)                                                     | Item |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ---- |
| Tenant creation route guard                                  | `apps/api/src/app.ts`                                       | 1a   |
| AuditLogger wiring in JobManager                             | `packages/queue/src/job-manager.ts`                         | 1b   |
| Observable gauge registration                                | `packages/shared/src/metrics.ts`, server startup            | 1d   |
| Job stats enrichment (pendingActionsCount, schemaFieldCount) | `apps/api/src/routes/jobs.ts`, job repository               | 1e   |
| Extraction response `pageUrl` join                           | `apps/api/src/routes/extractions.ts`, extraction repository | 1g   |
| New `entity-sources` endpoint                                | `apps/api/src/routes/entity-sources.ts` (new)               | 1g   |

### 5.5 Testing Strategy

Each item requires unit tests. The SQLite migration (section 5.1) requires a dedicated migration test that exercises the upgrade path from a populated local project DB — verifying that existing extraction records with non-null `pageId` survive the table recreation. Integration tests for:

- Pull with `--include-extractions` / `--include-actions` (end-to-end with mocked API)
- Reset with `--keep-remote` (verify remote data preserved, local cleared)
- Add with crawl history (verify dedup against DB)
- CSS table extraction (various HTML table structures)

### 5.6 Roadmap Update

After Wave 5-6 completion, update `docs/superpowers/specs/wave-roadmap.md` to mark Wave 5 as complete with final test counts.
