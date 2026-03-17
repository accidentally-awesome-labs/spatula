# Phase 10: Export Pipeline — Design Spec

> Server-side export generation with async job processing, content store persistence, pluggable format exporters, and auto-generated data dictionaries.

## Overview

The Export Pipeline enables users to export reconciled entity data from completed crawl jobs as JSON or CSV files. Exports are triggered via the API, processed asynchronously by a dedicated BullMQ worker, and stored in the content store for download. A data dictionary endpoint provides auto-generated field documentation with computed statistics.

Phase 9c built a working CLI-side inline export. Phase 10 replaces that with a server-side pipeline so exports work identically from CLI, future web app, or any API consumer.

## Architecture

### Approach: Dedicated Export Service

Follows the existing crawl worker architecture — BullMQ job → worker processes → content store.

```
API Layer (apps/api)
├── POST /export           — creates export record + enqueues job
├── GET /export/:exportId  — returns export status + download URL
├── GET /export/:exportId/download — streams file from content store
└── GET /documentation     — returns data dictionary (computed on demand)

Queue Layer (packages/queue)
└── ExportWorker           — processes export jobs from BullMQ
    ├── fetches entities in batches from DB
    ├── runs Exporter implementation
    ├── writes result to content store
    └── updates export record with status + content ref

Core Layer (packages/core)
├── JsonExporter           — implements Exporter interface
├── CsvExporter            — implements Exporter interface
├── DocumentationGenerator — computes data dictionary from schema + entity stats
└── Shared serialization utils (extracted from CLI useExport)

DB Layer (packages/db)
├── exports table          — tracks export jobs
└── ExportRepository       — CRUD for export records

Content Store
└── stores export file blobs (local FS dev, S3/GCS prod)
```

### Data Flow

1. Client calls `POST /api/v1/jobs/:jobId/export` with `{ format, includeProvenance }`
2. API creates an `exports` row (status: `pending`), enqueues BullMQ job
3. API returns `202 Accepted` with export ID
4. ExportWorker picks up job, fetches entities in batches, runs exporter
5. Exporter returns serialized content (string)
6. Worker writes content to content store, updates export record (status: `completed`, contentRef, entityCount, fileSize, completedAt)
7. Client polls `GET /export/:exportId` — when `completed`, response includes metadata
8. Client downloads file via `GET /export/:exportId/download`

## Database

### Exports Table

```sql
CREATE TABLE exports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  format        TEXT NOT NULL,           -- 'json' or 'csv'
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed'
  include_provenance BOOLEAN NOT NULL DEFAULT false,
  entity_count  INTEGER,                 -- null until completed
  content_ref   TEXT,                    -- null until completed, content store key
  file_size     INTEGER,                 -- null until completed, bytes
  error         TEXT,                    -- null unless failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ             -- null until completed
);

CREATE INDEX exports_job_idx ON exports(job_id);
CREATE INDEX exports_tenant_idx ON exports(tenant_id);
```

### ExportRepository

```typescript
interface CreateExportInput {
  jobId: string;
  tenantId: string;
  format: 'json' | 'csv';
  includeProvenance: boolean;
}

class ExportRepository {
  create(input: CreateExportInput): Promise<ExportRow>;
  findById(exportId: string, tenantId: string): Promise<ExportRow | null>;
  findByJob(jobId: string, tenantId: string): Promise<ExportRow[]>;
  updateStatus(exportId: string, tenantId: string, update: {
    status: 'processing' | 'completed' | 'failed';
    entityCount?: number;
    contentRef?: string;
    fileSize?: number;
    error?: string;
    completedAt?: Date;
  }): Promise<ExportRow>;
}
```

## API Endpoints

### POST /api/v1/jobs/:jobId/export

Creates an export record and enqueues a BullMQ job.

**Request body:**
```typescript
{
  format: 'json' | 'csv';
  includeProvenance?: boolean;  // default false
}
```

**Response (202 Accepted):**
```typescript
{
  data: {
    id: string;
    status: 'pending';
    format: string;
    includeProvenance: boolean;
    createdAt: string;
  }
}
```

**Validation:** Uses a Zod schema (`exportRequestSchema`) for body validation. Returns 400 for invalid format.

### GET /api/v1/jobs/:jobId/export/:exportId

Returns export status and metadata.

**Response (200):**
```typescript
{
  data: {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    format: string;
    includeProvenance: boolean;
    entityCount: number | null;     // populated when completed
    fileSize: number | null;        // populated when completed
    contentRef: string | null;      // populated when completed
    error: string | null;           // populated when failed
    createdAt: string;
    completedAt: string | null;     // populated when completed
  }
}
```

Returns 404 if export not found.

### GET /api/v1/jobs/:jobId/export/:exportId/download

Streams the export file from content store.

**Response headers:**
- `Content-Type`: `application/json` for JSON, `text/csv` for CSV
- `Content-Disposition`: `attachment; filename="spatula-{jobId-short}-{date}.{format}"`
- `Content-Length`: file size from export record

**Error cases:**
- 404 if export not found
- 409 if export not yet completed (status is not `completed`)

### GET /api/v1/jobs/:jobId/documentation

Computed on demand — no storage needed. Returns the data dictionary for the job's current schema and entity data.

**Response (200):**
```typescript
{
  data: {
    jobId: string;
    schemaVersion: number;
    generatedAt: string;
    entityCount: number;
    fields: Array<{
      name: string;
      type: string;
      description: string;
      required: boolean;
      aliases: string[];
      stats: {
        fillRate: number;       // 0-1
        uniqueCount: number;
        sampleValues: unknown[];  // up to 5 distinct values
        min?: number;           // numeric fields only
        max?: number;           // numeric fields only
      };
    }>;
  }
}
```

**Performance:** For large datasets (>1000 entities), stats are computed from the first 1000 entities with a `sampled: true` flag in the response. This keeps the endpoint fast.

## Core Implementations

### Exporter Interface (already exists)

```typescript
// packages/core/src/interfaces/exporter.ts (existing)
export interface Exporter {
  readonly format: ExportFormat;
  export(
    entities: unknown[],
    schema: SchemaDefinition,
    options: ExportOptions,
  ): Promise<ExportResult>;
}
```

**ExportResult** needs to be defined (not yet in codebase):
```typescript
export interface ExportResult {
  content: string;
  entityCount: number;
  format: ExportFormat;
}
```

### JsonExporter

Implements `Exporter`. Produces a self-contained JSON file:

```typescript
{
  metadata: {
    jobId: string;
    exportedAt: string;
    entityCount: number;
    schemaVersion: number;
    format: 'json';
    includeProvenance: boolean;
  },
  schema: SchemaDefinition,
  documentation: DataDictionary | null,  // included when includeDocumentation is true
  entities: Array<{
    data: Record<string, unknown>;
    qualityScore: number;
    categories: string[];
    sourceCount: number;
    provenance?: Record<string, FieldProvenanceEntry>;  // when includeProvenance
    sources?: Array<{ extractionId, matchConfidence, sourceUrl? }>;  // when includeProvenance
  }>
}
```

Pretty-printed with 2-space indent. Streamed or built in memory (entities are already fetched in batches by the worker, passed as array to the exporter).

### CsvExporter

Implements `Exporter`. Produces a plain CSV file:

- Header row: schema field names in definition order
- Data rows: one per entity, field values from `mergedData`
- RFC 4180 escaping: values with commas, double quotes, or newlines are quoted with doubled inner quotes
- Formula injection protection: values starting with `=`, `+`, `-`, `@` get a tab prefix inside quotes
- Nested/complex values: JSON-serialized with proper quote escaping
- Null/undefined: empty string
- Provenance is NOT included in CSV (no natural flat representation)

### Shared Serialization Utilities

Extract from `apps/cli/src/hooks/useExport.ts` into `packages/core/src/exporters/csv-utils.ts`:

- `csvEscapeValue(str: string): string`
- `entityToCsvRow(entity: Entity, fields: string[]): string`
- `entitiesToCsv(entities: Entity[], fields: string[]): string`

The CLI `useExport` hook then imports these from `@spatula/core` instead of having its own copy.

### DocumentationGenerator

```typescript
// packages/core/src/exporters/documentation-generator.ts

function generateDocumentation(
  schema: SchemaDefinition,
  entities: Entity[],
  jobId: string,
): DataDictionary
```

**DataDictionary type:**
```typescript
export interface FieldStats {
  fillRate: number;
  uniqueCount: number;
  sampleValues: unknown[];
  min?: number;
  max?: number;
}

export interface FieldDocumentation {
  name: string;
  type: string;
  description: string;
  required: boolean;
  aliases: string[];
  stats: FieldStats;
}

export interface DataDictionary {
  jobId: string;
  schemaVersion: number;
  generatedAt: string;
  entityCount: number;
  sampled?: boolean;         // true when stats computed from sample
  sampleSize?: number;       // included when sampled
  fields: FieldDocumentation[];
}
```

**Stats computation:**
- Single pass over entities
- Per field: count non-null values (fillRate), collect unique values via Set (capped at 1000 entries for memory), track min/max for numeric values
- `sampleValues`: up to 5 distinct non-null values
- `fillRate`: non-null count / total entity count

## ExportWorker

Lives in `packages/queue`, follows existing worker patterns.

### Job Payload

```typescript
interface ExportJobPayload {
  exportId: string;
  jobId: string;
  tenantId: string;
  format: 'json' | 'csv';
  includeProvenance: boolean;
}
```

### Processing Steps

1. Update export record: status → `processing`
2. Fetch schema via `SchemaRepository.findByJob`
3. Fetch all entities in batches of 100 via `EntityRepository.findByJob`
   - JSON with provenance: include `provenance` column in select
   - CSV or no provenance: exclude `provenance` column (lighter query)
4. If JSON format: generate data dictionary via `DocumentationGenerator`
5. Run appropriate exporter (`JsonExporter` or `CsvExporter`)
6. Write `ExportResult.content` to content store
   - Key format: `exports/{tenantId}/{jobId}/{exportId}.{format}`
7. Update export record: status → `completed`, set contentRef, entityCount, fileSize, completedAt
8. On error at any step: update status → `failed`, save error message

### Queue Configuration

- Queue name: `export`
- Concurrency: 2 (I/O-bound, not CPU-bound)
- No retry on failure (user can re-trigger export)
- Job timeout: 5 minutes

## CLI Integration

Update the CLI to use the API export pipeline instead of local generation.

### Updated useExport Hook

Replace local entity fetching + serialization with API calls:

- `exportSingleEntity` → calls `POST /export` for one entity (or keeps local for immediate single-entity export — cheaper than a round-trip for one item)
- `exportEntitySet` → calls `POST /export`, then polls `GET /export/:exportId` for status, then downloads via `GET /export/:exportId/download`

### New API Client Methods

```typescript
createExport(jobId: string, body: { format: string; includeProvenance?: boolean }): Promise<Record<string, unknown>>;
getExport(jobId: string, exportId: string): Promise<Record<string, unknown>>;
downloadExport(jobId: string, exportId: string): Promise<string>;  // returns file content
getDocumentation(jobId: string): Promise<Record<string, unknown>>;
```

### ExportDialog Changes

Minimal UI changes — same format/scope selection. Progress display changes from "Fetching entities (150/312)" to export status polling ("Pending..." → "Processing..." → "Completed"). Download step added after completion.

## File Structure

```
packages/core/src/exporters/
├── json-exporter.ts           — JsonExporter implementation
├── csv-exporter.ts            — CsvExporter implementation
├── csv-utils.ts               — shared CSV serialization utilities
├── documentation-generator.ts — data dictionary generator
├── types.ts                   — ExportResult, DataDictionary, FieldStats types
└── index.ts                   — barrel export

packages/db/src/schema/
└── exports.ts                 — exports table definition

packages/db/src/repositories/
└── export-repository.ts       — ExportRepository CRUD

packages/queue/src/workers/
└── export-worker.ts           — BullMQ export job processor

apps/api/src/routes/
└── exports.ts                 — replace 501 stubs with real endpoints

apps/api/src/schemas/
└── export-request.ts          — Zod schema for POST /export body

apps/cli/src/hooks/
└── useExport.ts               — update to use API export pipeline

apps/cli/src/api/
└── client.ts                  — add export API methods
```

## Out of Scope

- Parquet, DuckDB, SQLite exporters (future formats — pluggable interface supports them)
- Export scheduling or recurring exports
- Export sharing or public URLs
- Web app UI for exports (Phase 10 is API + CLI only)
- LLM-generated documentation summaries (schema already has field descriptions)
