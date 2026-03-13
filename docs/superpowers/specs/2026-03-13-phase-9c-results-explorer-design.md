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

`ExplorerView` manages which sub-view is active via a simple state:

```typescript
type ExplorerSubView = 'table' | 'detail' | 'export';
```

- `table`: DataTable + FilterBar visible
- `detail`: EntityDetail replaces the table (full-screen)
- `export`: ExportDialog overlay on top of current view

## Components

### ExplorerView

Orchestrator component. Responsibilities:
- Initializes entity data fetching via `useEntityData`
- Manages `explorerSubView` transitions
- Passes filtered entities to DataTable
- Renders Header and KeyboardHints (mode-appropriate hints change per sub-view)

### FilterBar

Renders above the DataTable:

```
 Filter: bluetooth headphones_          [Local]   47 of 312 matches
```

- Text input field for filter query
- Mode indicator: `[Local]` or `[AI]`
- Match count: `N of M matches` (or `M entities` when no filter active)
- Press `F` from table to focus, `Escape` to clear and unfocus
- Press `A` to toggle AI filter mode

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

**Page size**: Auto-calculated from terminal height minus header, filter bar, and footer chrome. Typically 15–25 rows.

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

**CSV format:** Column headers from schema field names. One row per entity. Nested/complex values serialized as JSON strings within cells.

**JSON format:** Array of entity objects with `data` and `provenance` keys. Includes metadata (`jobId`, `exportedAt`, `filterQuery` if active).

## Hooks

### useEntityData

```typescript
useEntityData(apiClient: ApiClient, jobId: string): {
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

- Fetches paginated entities from `listEntities` API
- Auto-calculates page size from terminal dimensions
- Manages page state and navigation
- `fetchEntity` calls `getEntity` for full provenance data (used by EntityDetail)

### useEntityFilter

```typescript
useEntityFilter(entities: Entity[], schema: SchemaField[]): {
  filterQuery: string;
  filterMode: 'local' | 'ai';
  filteredEntities: Entity[];
  matchCount: number;
  isFiltering: boolean;
  setFilterQuery: (query: string) => void;
  toggleFilterMode: () => void;
  clearFilter: () => void;
  applyAiFilter: (query: string) => Promise<void>;
}
```

**Local filtering:**
- Case-insensitive text search across all field values
- Debounced at ~200ms, updates as user types
- Operates on loaded entities

**Dataset size strategy:**
- Small datasets (<500 entities): fetch all upfront, filter locally
- Large datasets (500+): send `search` param to API, paginate server-filtered results

**AI filtering:**
- Sends user query + schema field definitions to OpenRouter (fast model tier)
- LLM returns structured filter criteria (field conditions)
- Criteria translated to API query params for server-side filtering
- Single-shot translation — no conversation or follow-ups

### useExport

```typescript
useExport(): {
  exportEntities: (
    entities: Entity[] | EntityWithProvenance,
    format: 'json' | 'csv',
    options: { jobId: string; filterQuery?: string }
  ) => Promise<string>; // returns file path
}
```

- Handles JSON and CSV serialization
- Writes file to current working directory
- Returns file path for confirmation display

## Keyboard Navigation

### Table View
| Key | Action |
|-----|--------|
| `↑/↓` | Move row cursor |
| `←/→` | Scroll schema columns horizontally |
| `N` or `]` | Next page |
| `P` or `[` | Previous page |
| `Enter` | Open detail view for selected entity |
| `F` | Focus filter input |
| `A` | Toggle AI filter mode |
| `E` | Open export dialog |
| `Escape` | Clear filter (if active), otherwise exit mode |

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

### Global Mode Switching (from App.tsx)
| Key | Action |
|-----|--------|
| `D` | Switch to dashboard mode |
| `R` | Switch to review mode |
| `C` | Switch to conversational mode |

## Store Extensions

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
explorerSubView: 'table' | 'detail' | 'export';
```

## API Changes

### Server-side text search

Add `search` query parameter to the existing `listEntities` endpoint:

```
GET /api/v1/jobs/:jobId/entities?search=bluetooth&limit=50&offset=0
```

- Case-insensitive text search across all values in `mergedData` JSONB
- Uses PostgreSQL JSONB text search (cast to text, `ILIKE` or `to_tsvector`)
- Needed for filtering large datasets (500+ entities) without fetching everything client-side

No other API changes required. AI filter translation happens client-side in the CLI.

### API Client Extension

Add `search` param to existing `listEntities` method:

```typescript
listEntities(jobId: string, query?: {
  limit?: number;
  offset?: number;
  search?: string;  // new
}): Promise<{ entities: Entity[]; total: number }>;
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

apps/api/src/routes/
└── entities.ts            — add `search` query param support
```

## Out of Scope

- Full export pipeline (Phase 10) — inline export here is a lightweight precursor
- Streaming/real-time entity updates — explorer is for completed jobs
- Entity editing or manual corrections
- Advanced query language or saved filters
