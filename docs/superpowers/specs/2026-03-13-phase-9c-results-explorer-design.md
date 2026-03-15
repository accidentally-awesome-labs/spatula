# Phase 9c: CLI Results Explorer — Design Spec

> Post-crawl terminal-based data browser for viewing reconciled entities, inspecting per-field provenance, filtering results, and exporting datasets.

## Overview

The Results Explorer is the fourth CLI mode (`explorer`). After a job completes reconciliation, users switch to explorer mode to browse the final merged entities in a paginated table, drill into per-field provenance, apply text or AI-powered filters, and export results as JSON or CSV.

## Architecture

### Approach: Composable View Architecture

Follows the same pattern as DashboardView and ReviewView — a top-level orchestrator component with focused sub-components and custom hooks.

```
ExplorerView (orchestrator)
├── FilterBar          — text input + AI filter toggle + result count
├── DataTable          — paginated entity rows with fixed + scrollable columns
│   └── TableRow       — single entity row (highlighted when selected)
├── EntityDetail       — full-screen provenance view (replaces table when active)
├── ExportDialog       — format/scope selection overlay
└── Shared: Panel, Header, KeyboardHints, Spinner
```

### Sub-View State

`ExplorerView` manages which sub-view is active via **local component state** (consistent with DashboardView and ReviewView, which also manage their internal state locally rather than in the global store):

```typescript
type ExplorerSubView = 'table' | 'detail' | 'export';
const [subView, setSubView] = useState<ExplorerSubView>('table');
```

- `table`: DataTable + FilterBar visible
- `detail`: EntityDetail replaces the table (full-screen)
- `export`: ExportDialog overlay on top of current view

### Input Focus Management

The explorer is the first CLI mode with a text input field (FilterBar). This creates a conflict with the existing `useKeyboard` hook, which captures all character keypresses globally via Ink's `useInput`. When the filter input is focused and the user types text, character keys like `f`, `a`, `e`, `d`, `r` would also trigger keyboard handlers.

**Solution:** Use Ink's `useInput({ isActive })` option. The `useKeyboard` hook already wraps `useInput`, so we extend it with an `isActive` parameter:

```typescript
export function useKeyboard(keyMap: KeyMap, isActive = true): void {
  useInput((input, key) => { /* existing logic */ }, { isActive });
}
```

- When FilterBar is focused (`filterFocused = true`), pass `isActive: !filterFocused` to the table's `useKeyboard` call
- FilterBar manages its own `useInput` internally for text entry
- Global mode-switching keys (D, R, C from App.tsx) are also suppressed while filter is focused — the user must press `Escape` to unfocus first
- **App.tsx integration:** `filterFocused` is stored in the Zustand store (not local state) so that `App.tsx` can read it and pass `isActive: !filterFocused` to its own `useKeyboard(modeKeys, isActive)` call. This is the one piece of explorer state that must be in the store, because App.tsx needs to know whether to suppress global key bindings.
- This pattern is clean because `useInput` natively supports the `isActive` flag

## Types

### Entity and EntityWithProvenance

These types are introduced in `@spatula/shared` for use across CLI, API, and core:

```typescript
/** Entity as returned by the list endpoint (no provenance detail). */
export interface Entity {
  id: string;
  jobId: string;
  mergedData: Record<string, unknown>;
  categories: string[];
  qualityScore: number;
  createdAt: string;
  sourceCount: number; // computed by API from entity_sources join
}

/** Entity as returned by the detail endpoint (with full provenance). */
export interface EntityWithProvenance extends Entity {
  provenance: Record<string, FieldProvenanceEntry>;
  sources: Array<{
    extractionId: string;
    matchConfidence: number;
    sourceUrl?: string; // resolved via extraction → page join (see API Changes §4)
  }>;
}
```

`FieldProvenanceEntry` already exists in `@spatula/core/types/reconciliation.ts`.

**Note on `provenance` in list vs. detail endpoints:** The DB `entities` table stores `provenance` as a JSONB column on every row, but the list endpoint should **exclude** it from the response to keep payloads small. Only the detail endpoint (via `getEntity`) returns provenance. The list query should use a column selection that omits `provenance`.

### Schema types

Use `FieldDefinition` from `@spatula/core/types/schema.ts` (not `SchemaField` — that type does not exist). The store's `schemaData: Record<string, unknown>` should be parsed through the `SchemaDefinition` Zod schema to extract the `fields: FieldDefinition[]` array.

## Components

### ExplorerView

Orchestrator component. Responsibilities:
- Initializes entity data fetching via `useEntityData`
- Manages `subView` transitions (local state)
- Manages `filterFocused` via the store (so App.tsx can suppress global keys)
- Passes filtered entities to DataTable
- Renders its own `KeyboardHints` internally (not via App.tsx's `hintsForMode`), since explorer hints are dynamic — they change based on `subView` and `filterFocused` state. App.tsx should render no hints when `mode === 'explorer'` and let ExplorerView handle it.

### FilterBar

Renders above the DataTable:

```
 Filter: bluetooth headphones_          [Local]   47 of 312 matches
```

- Text input field for filter query
- Mode indicator: `[Local]` or `[AI]`
- Match count: `N of M matches` (or `M entities` when no filter active)
- Press `F` from table to focus, `Escape` to unfocus (returns keyboard control to table)
- Press `A` to toggle AI filter mode (only when filter is focused)
- Uses its own `useInput({ isActive: filterFocused })` for text entry
- Handles backspace, printable characters, Enter (submit AI query)

### DataTable

Paginated entity table with fixed and scrollable columns.

**Column layout:**

```
┌────┬───────┬─────────┬──────────────────┬──────────────┬─────────────┐
│ #  │ Score │ Sources │ field_1          │ field_2      │ field_3 ... │
├────┼───────┼─────────┼──────────────────┼──────────────┼─────────────┤
│  1 │  0.92 │      3  │ Sony WH-1000XM5  │ $348.00      │ Over-ear    │
│  2 │  0.87 │      2  │ AirPods Pro 2    │ $249.00      │ In-ear      │
│> 3 │  0.85 │      4  │ Bose QC Ultra    │ $429.00      │ Over-ear    │
│  4 │  0.71 │      1  │ Samsung Buds3    │ $179.99      │ In-ear      │
└────┴───────┴─────────┴──────────────────┴──────────────┴─────────────┘
 Page 2 of 7 (312 entities)          Showing cols 1-3 of 8 →
```

- **Fixed left columns** (always visible): row number, quality score (0–1), source count
- **Schema columns**: fill remaining terminal width, in schema-definition order
- Column values truncated to max width (~20 chars) with `…` for overflow
- Selected row indicated by `>` prefix and highlight color
- Footer shows page info and column scroll position

**Page size**: Auto-calculated from terminal height using Ink's `useStdout()`:
```typescript
const { stdout } = useStdout();
const pageSize = stdout.rows - HEADER_HEIGHT - FILTER_BAR_HEIGHT - TABLE_HEADER_HEIGHT - FOOTER_HEIGHT - 2;
// Typically 15–25 rows depending on terminal
```

**Empty state**: When a job has zero entities (e.g., reconciliation produced no matches or job hasn't reached that stage), show: `"No entities found for this job. Entities are created during the reconciliation phase."`

### TableRow

Single row component. Accepts entity data, column definitions, selected state. Renders fixed columns + visible schema columns with truncation.

### EntityDetail

Full-screen provenance view, replaces the table when user presses Enter on a row.

**Layout:**

```
╔══ Entity Detail ═══════════════════════════════════════════════╗
║  Quality: 0.85    Sources: 4    Categories: headphones, audio  ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  name: Bose QC Ultra                                           ║
║    ├─ provenance: merged (3 sources)                           ║
║    ├─ sources:                                                 ║
║    │   • amazon.com/bose-qc → "Bose QuietComfort Ultra"       ║
║    │   • bestbuy.com/bose   → "BOSE QC Ultra Headphones"      ║
║    │   • bose.com/products  → "QuietComfort Ultra"             ║
║    └─ resolution: most_complete                                ║
║                                                                ║
║  price: $429.00                                                ║
║    ├─ provenance: normalized                                   ║
║    ├─ sources:                                                 ║
║    │   • amazon.com  → "$429.00"                               ║
║    │   • bestbuy.com → "429.99" (conflict)                     ║
║    └─ resolution: source_priority                              ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
 ↑↓ scroll fields    E export    Escape back to table
```

- Header bar: quality score, source count, categories
- Fields listed vertically with provenance tree beneath each
- `↑/↓` scrolls through fields when they exceed terminal height (viewport window)
- Conflict indicators highlighted with distinct color
- `E` opens export dialog scoped to this entity
- `Escape` returns to table with cursor position preserved
- Data fetched via `apiClient.getEntity(jobId, entityId)` (separate call with full provenance)

**Loading state**: While `fetchEntity` is in-flight, show `<Spinner label="Loading entity..." />` (consistent with DashboardView's loading pattern). On fetch error, show error message with option to press `Escape` to return to table.

### ExportDialog

Overlay dialog for export configuration:

```
╔══ Export ══════════════════════════════╗
║                                        ║
║  Format:   [JSON]   CSV               ║
║  Scope:    [Current entity]            ║
║            Filtered results (47)       ║
║                                        ║
║  Enter to export · Escape to cancel    ║
╚════════════════════════════════════════╝
```

- `←/→` toggles format: JSON or CSV
- `↑/↓` toggles scope (contextual options):
  - From detail view: "Current entity" + "Filtered results (N)"
  - From table view: "Filtered results (N)" only
  - If no filter active: label shows "All results (N)"
- `Enter` executes export, writes to current working directory
- Filename: `spatula-{jobId-short}-{timestamp}.{json|csv}`
- After writing: confirmation message, e.g., `Exported 47 entities to spatula-a1b2c3-20260313.json`
- `Escape` cancels, returns to previous view

**Export data fetching for multi-page results**: When exporting filtered/all results that span multiple pages, the `useExport` hook fetches all matching entities from the API in sequential page requests (using the same `search` param if active), accumulates them, then serializes. A progress indicator shows `"Fetching entities for export... (150/312)"` during this process.

**CSV format:** Column headers from schema field names. One row per entity. Proper CSV escaping applied: values containing commas, quotes, or newlines are quoted per RFC 4180. Nested/complex values serialized as JSON strings within cells. UTF-8 encoding.

**JSON format:** Array of entity objects with `data` and `provenance` keys. Includes metadata (`jobId`, `exportedAt`, `filterQuery` if active).

## Hooks

### useEntityData

```typescript
useEntityData(apiClient: SpatulaApiClient, jobId: string): {
  entities: Entity[];
  totalCount: number;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  isLoading: boolean;
  goToPage: (page: number) => void;
  nextPage: () => void;
  prevPage: () => void;
  fetchEntity: (entityId: string) => Promise<EntityWithProvenance>;
}
```

- Fetches paginated entities from `listEntities` API (which now returns `{ data: entities, total: N }`)
- Auto-calculates page size from terminal dimensions via `useStdout()`
- Manages page state and navigation
- `fetchEntity` calls `getEntity` for full provenance data (used by EntityDetail)

### useEntityFilter

```typescript
useEntityFilter(
  apiClient: SpatulaApiClient,
  jobId: string,
  schema: FieldDefinition[],  // from @spatula/core/types/schema
  totalCount: number,
  pageSize: number,
): {
  filterQuery: string;
  filterMode: 'local' | 'ai';
  filteredEntities: Entity[];
  matchCount: number;
  isFiltering: boolean;
  setFilterQuery: (query: string) => void;
  toggleFilterMode: () => void;
  clearFilter: () => void;
  applyAiFilter: (query: string) => Promise<void>;
  currentPage: number;
  totalPages: number;
  nextPage: () => void;
  prevPage: () => void;
}
```

**Local filtering:**
- Case-insensitive text search across all field values
- Debounced at ~200ms, updates as user types
- Operates on loaded entities

**Dataset size strategy:**
- Small datasets (<500 entities based on `totalCount`): fetch all upfront, filter locally
- Large datasets (500+): send `search` param to API, paginate server-filtered results

The hook manages its own pagination state when filtering, independent of `useEntityData`'s pagination. This avoids tangling filtered vs. unfiltered page state.

**AI filtering (stretch goal):**
- Sends user query + `FieldDefinition[]` to OpenRouter via direct client-side call (fast model tier)
- Prompt template: system prompt describing the schema fields and their types, user query as input
- LLM returns structured JSON: `{ filters: Array<{ field: string, operator: 'eq'|'contains'|'lt'|'gt'|'in', value: unknown }> }`
- Filters converted to `search` param or applied locally depending on complexity
- Single-shot translation — no conversation or follow-ups
- Error handling: if LLM returns invalid JSON or references nonexistent fields, show error message in FilterBar and fall back to local mode
- **Note:** AI filter is a stretch goal. Core explorer functionality (table, detail, local filter, export) ships first. AI filter can be added as a follow-up if time permits.

### useExport

```typescript
useExport(apiClient: SpatulaApiClient): {
  isExporting: boolean;
  exportProgress: { fetched: number; total: number } | null;
  exportSingleEntity: (
    entity: EntityWithProvenance,
    format: 'json' | 'csv',
    options: { jobId: string }
  ) => Promise<string>; // returns file path
  exportEntitySet: (
    jobId: string,
    format: 'json' | 'csv',
    options: { search?: string; filterQuery?: string }
  ) => Promise<string>; // returns file path
}
```

- `exportSingleEntity`: serializes the already-loaded entity — no API call needed
- `exportEntitySet`: fetches all matching entities page-by-page from the API, then serializes
- Shows progress via `exportProgress` during multi-page fetches
- Handles JSON and CSV serialization with proper escaping
- Writes file to current working directory using `fs.writeFile`
- Returns file path for confirmation display

## Keyboard Navigation

### Table View (active when `!filterFocused`)
| Key | Action |
|-----|--------|
| `↑/↓` | Move row cursor |
| `←/→` | Scroll schema columns horizontally |
| `N` or `]` | Next page |
| `P` or `[` | Previous page |
| `Enter` | Open detail view for selected entity |
| `F` | Focus filter input |
| `E` | Open export dialog |
| `Escape` | Exit to previous mode |

### Filter Focused (active when `filterFocused`)
| Key | Action |
|-----|--------|
| Printable chars | Append to filter query |
| `Backspace` | Delete last character |
| `A` | Toggle AI filter mode |
| `Enter` | Submit AI filter query (in AI mode) |
| `Escape` | Clear filter and unfocus (return keyboard to table) |

All other keys (including global mode-switching D/R/C) are suppressed while filter is focused.

### Detail View
| Key | Action |
|-----|--------|
| `↑/↓` | Scroll fields |
| `E` | Open export dialog (scoped to current entity) |
| `Escape` | Return to table (cursor preserved) |

### Export Dialog
| Key | Action |
|-----|--------|
| `←/→` | Toggle format (JSON/CSV) |
| `↑/↓` | Toggle scope |
| `Enter` | Execute export |
| `Escape` | Cancel, return to previous view |

### Global Mode Switching (from App.tsx, active when `!filterFocused`)
| Key | Action |
|-----|--------|
| `D` | Switch to dashboard mode |
| `R` | Switch to review mode |
| `C` | Switch to conversational mode |

## Store Extensions

**Store as source of truth:** Hooks (`useEntityData`, `useEntityFilter`) fetch data from the API and write results into the store. Components read from the store, not from hook return values directly. This matches the pattern used by DashboardView and ReviewView, where `useJobPolling` fetches and writes to the store, and components read `store.jobData`, `store.pendingActions`, etc.

The hook signatures above show return values for clarity of what data they manage, but internally they call the store setters. Components should read from the store (e.g., `store.entities`, `store.totalEntityCount`).

Added to the existing Zustand store (`apps/cli/src/store/index.ts`):

```typescript
// Explorer state
entities: Entity[];
totalEntityCount: number;
currentEntityPage: number;
selectedEntityIndex: number;
expandedEntity: EntityWithProvenance | null;
filterQuery: string;
filterMode: 'local' | 'ai';
filterFocused: boolean; // in store so App.tsx can suppress global keys

// Explorer setters
setEntities: (entities: Entity[]) => void;
setTotalEntityCount: (count: number) => void;
setCurrentEntityPage: (page: number) => void;
setSelectedEntityIndex: (index: number) => void;
setExpandedEntity: (entity: EntityWithProvenance | null) => void;
setFilterQuery: (query: string) => void;
setFilterMode: (mode: 'local' | 'ai') => void;
setFilterFocused: (focused: boolean) => void;
```

Note: `explorerSubView` is intentionally NOT in the store — it lives as local state in ExplorerView (consistent with how DashboardView and ReviewView manage their internal state).

## API Changes

### 1. Entity list endpoint — add total count and search

The `listEntities` endpoint (`apps/api/src/routes/entities.ts`) currently returns `{ data: entities }`. It needs two changes:

**Response format change** — include total count for pagination:
```typescript
return c.json({
  data: entities,
  total: count,  // new field
});
```

**Note on API client compatibility:** The existing `SpatulaApiClient.request()` unwraps `json.data` automatically. To also access `total`, add a new method `listEntitiesPaginated` that returns the full response object `{ data: Entity[], total: number }` instead of using the generic `request()` unwrapper. Existing `listEntities` remains unchanged for backward compatibility.

```typescript
// New method in SpatulaApiClient
async listEntitiesPaginated(
  jobId: string,
  query?: Record<string, unknown>,
): Promise<{ data: Entity[]; total: number }> {
  // Direct fetch that returns full response, not unwrapped
  const url = this.buildUrl(`/api/v1/jobs/${jobId}/entities`, query);
  const response = await fetch(url, { method: 'GET', headers: this.headers() });
  // ... error handling ...
  return (await response.json()) as { data: Entity[]; total: number };
}
```

**Entity query schema** — create a new `entityQuerySchema` extending `paginationSchema` (not modifying the shared one):
```typescript
// apps/api/src/schemas/entity-query.ts
export const entityQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
});
export type EntityQueryParams = z.infer<typeof entityQuerySchema>;
```

### 2. EntityRepository — add count and search support

```typescript
// New method: countByJob
async countByJob(
  jobId: string,
  tenantId: string,
  options?: { search?: string },
): Promise<number>

// Extended: findByJob adds search option
async findByJob(
  jobId: string,
  tenantId: string,
  options?: { limit?: number; offset?: number; search?: string },
)
```

**Search implementation**: Cast `mergedData` JSONB to text and use `ILIKE`:
```sql
WHERE merged_data::text ILIKE '%search_term%'
```

This is simple and effective for the expected dataset sizes. Full-text search (`to_tsvector`) is over-engineered for this use case.

### 3. Entity list endpoint — add sourceCount

The `Entity` type includes `sourceCount` (number of source extractions). Use a SQL subquery to compute it efficiently (avoids N+1):

```sql
SELECT e.*, (SELECT COUNT(*) FROM entity_sources es WHERE es.entity_id = e.id) as source_count
FROM entities e WHERE ...
```

This is done in `EntityRepository.findByJob` using Drizzle's `sql` template literal for the subquery, added as an extra column in the select.

### 4. Entity detail endpoint — resolve sourceUrl

The `entity_sources` table only stores `entityId`, `extractionId`, and `matchConfidence` — it has no `sourceUrl`. To populate `EntityWithProvenance.sources[].sourceUrl`, the detail endpoint must join through `entity_sources` → `extractions` → `pages` (or use the extraction's metadata) to resolve the source URL. The `sourceUrl` field is marked optional in the type since the join may not always resolve (e.g., if the extraction or page was deleted).

The implementation should use a single query with JOINs rather than multiple round-trips:
```sql
SELECT es.extraction_id, es.match_confidence, p.url as source_url
FROM entity_sources es
JOIN extractions ex ON ex.id = es.extraction_id
JOIN pages p ON p.id = ex.page_id
WHERE es.entity_id = :entityId
```

## File Structure

```
apps/cli/src/components/explorer/
├── ExplorerView.tsx      — orchestrator
├── DataTable.tsx          — paginated table with fixed + scrollable columns
├── TableRow.tsx           — single entity row
├── FilterBar.tsx          — filter input + mode indicator + count
├── EntityDetail.tsx       — full-screen provenance view
├── ExportDialog.tsx       — format/scope selection overlay
└── index.ts               — module exports

apps/cli/src/hooks/
├── useEntityData.ts       — pagination + data fetching
├── useEntityFilter.ts     — local + AI filtering
└── useExport.ts           — JSON/CSV export

packages/shared/src/types/
└── entity.ts              — Entity, EntityWithProvenance types (re-export from shared/src/index.ts)

apps/api/src/schemas/
└── entity-query.ts        — entityQuerySchema (extends paginationSchema with search)

apps/api/src/routes/
└── entities.ts            — add total count, search support, sourceCount
```

## Out of Scope

- Full export pipeline (Phase 10) — inline export here is a lightweight precursor
- Streaming/real-time entity updates — explorer is for completed jobs
- Entity editing or manual corrections
- Advanced query language or saved filters
- AI filter is a stretch goal — core explorer ships without it
