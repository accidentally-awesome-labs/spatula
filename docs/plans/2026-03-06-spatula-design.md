# Spatula — Intelligent Web Crawling Platform Design

**Date:** 2026-03-06
**Status:** Approved
**Authors:** Human + Claude Opus 4.6

---

## Table of Contents

1. [Vision & Goals](#1-vision--goals)
2. [Architecture Overview](#2-architecture-overview)
3. [Tech Stack](#3-tech-stack)
4. [Monorepo Structure](#4-monorepo-structure)
5. [Core Types & Schema System](#5-core-types--schema-system)
6. [Action-Based Execution Model](#6-action-based-execution-model)
7. [LLM Intelligence Map](#7-llm-intelligence-map)
8. [Database Schema](#8-database-schema)
9. [Job Orchestration](#9-job-orchestration)
10. [API Design](#10-api-design)
11. [Interactive CLI](#11-interactive-cli)
12. [Export Pipeline](#12-export-pipeline)
13. [Scalability Design](#13-scalability-design)
14. [Implementation Phases](#14-implementation-phases)

---

## 1. Vision & Goals

Spatula is an AI-powered web crawling platform that lets users describe in plain language what data they want, provide seed URLs, and receive a clean, unified, production-ready dataset.

### Core Capabilities

- **Natural language job configuration** — Users describe what they want ("audiophile products from head-fi.org") and the AI configures the crawl
- **User-defined or AI-discovered schemas** — Users can specify fields, let the AI discover them, or combine both (hybrid mode)
- **Intelligent schema evolution** — As the crawler encounters more data, the schema dynamically expands with category-aware field relevance
- **Cross-source reconciliation** — Field synonym detection, value normalization, entity deduplication, gap filling, and conflict resolution across multiple websites
- **Production-ready output** — Clean, unified data with full provenance trails, auto-generated documentation, and multiple export formats

### Design Principles

1. **Interface-driven** — Every major component defined as a TypeScript interface with injectable implementations
2. **Action-based** — All state mutations (from LLM or otherwise) flow through typed, validated, auditable action objects
3. **Core engine has zero knowledge of HTTP or CLI** — Pure library; API server and CLI are thin clients
4. **Tenant-aware from day one** — Every table, query, and queue scoped by tenant_id
5. **Stateless workers** — All state in Postgres/Redis; workers are replaceable and horizontally scalable
6. **LLM-powered at every decision point** — With smart model routing for cost optimization

---

## 2. Architecture Overview

```
Clients
  CLI (Ink TUI)  ──┐
  API (REST)     ──┼──► API Server (Hono, stateless, N pods)
  WebSocket      ──┘              │
                                  ▼
                      Job Orchestrator
                      (BullMQ now, Temporal-ready)
                      tenant-scoped queues
                                  │
          ┌───────────────────────┼───────────────────────┐
          ▼                       ▼                       ▼
  Crawl Workers           Extract Workers          Schema Evolver
  (stateless,             (stateless,              (singleton w/lock,
   auto-scale)             auto-scale)              batched eval)
          │                       │                       │
          ▼                       ▼                       ▼
  Content Store            PostgreSQL               PostgreSQL
  (interface)              (extractions,            (schema versions,
   - PostgresStore          jobs, tasks)             tenant-scoped)
   - S3Store (later)              ▲
                                  │
                           Redis
                           (queues, locks, rate limits)
```

### Key Architecture Decisions

- **Hybrid orchestration strategy** — Start with BullMQ linear pipeline for simplicity; design interfaces so Temporal/Inngest can replace BullMQ when multi-tenancy and reliability requirements increase
- **Content Store abstraction** — Raw HTML stored behind a `ContentStore` interface (Postgres initially, S3/R2 when data volume requires it)
- **Batched schema evolution** — Schema evolver runs every N extractions with a distributed lock, not per-page, to eliminate race conditions and reduce LLM costs
- **Config-driven concurrency** — Per-tenant resource quotas, not hardcoded worker counts

---

## 3. Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Language** | TypeScript | Single language across core, API, CLI, future frontend. Strong typing + Zod for runtime schema validation |
| **Runtime** | Node.js / Bun | Mature ecosystem, excellent async I/O for orchestrating external services |
| **Monorepo** | Turborepo + pnpm | Build ordering, caching, parallel test runs |
| **API Server** | Hono | Lightweight, fast, middleware-friendly, works in any runtime |
| **Database** | PostgreSQL + Drizzle ORM | JSONB for flexible schemas, proven at scale, excellent TS integration |
| **Queue** | BullMQ + Redis | Battle-tested job queue, retries, backpressure, priority queues |
| **LLM Provider** | OpenRouter | Single API for Claude, GPT-4o, Gemini, Llama — multi-model on day one |
| **Crawlers** | Playwright + Firecrawl | Pluggable interface; Playwright for self-hosted, Firecrawl for managed |
| **CLI Framework** | Ink (React for terminals) | Component-based TUI, live-updating views, flexbox layout |
| **Testing** | Vitest | Fast, TypeScript-native, compatible with the ecosystem |

---

## 4. Monorepo Structure

```
spatula/
├── package.json                  # workspace root
├── tsconfig.base.json
├── turbo.json
├── .env.example
├── docker-compose.yml            # Postgres + Redis for local dev
│
├── packages/
│   ├── core/                     # THE ENGINE — zero HTTP/CLI dependencies
│   │   ├── src/
│   │   │   ├── interfaces/       # All contracts
│   │   │   │   ├── crawler.ts
│   │   │   │   ├── extractor.ts
│   │   │   │   ├── schema-evolver.ts
│   │   │   │   ├── content-store.ts
│   │   │   │   ├── orchestrator.ts
│   │   │   │   ├── reconciler.ts
│   │   │   │   └── exporter.ts
│   │   │   ├── crawlers/         # Crawler implementations
│   │   │   │   ├── playwright.ts
│   │   │   │   └── firecrawl.ts
│   │   │   ├── extraction/       # LLM extraction logic
│   │   │   │   ├── openrouter-client.ts
│   │   │   │   ├── prompts/
│   │   │   │   └── extractor.ts
│   │   │   ├── schema/           # Schema evolution engine
│   │   │   │   ├── analyzer.ts
│   │   │   │   ├── evolver.ts
│   │   │   │   └── versioner.ts
│   │   │   ├── reconciliation/   # Data cleaning & dedup
│   │   │   │   ├── deduplicator.ts
│   │   │   │   ├── normalizer.ts
│   │   │   │   └── gap-filler.ts
│   │   │   ├── link-evaluation/
│   │   │   │   └── evaluator.ts
│   │   │   ├── execution/        # Action executor
│   │   │   │   ├── action-executor.ts
│   │   │   │   ├── config-executor.ts
│   │   │   │   └── review-queue.ts
│   │   │   ├── export/
│   │   │   │   ├── json.ts
│   │   │   │   └── csv.ts
│   │   │   ├── types/            # Shared Zod schemas & types
│   │   │   │   ├── job.ts
│   │   │   │   ├── schema.ts
│   │   │   │   ├── extraction.ts
│   │   │   │   ├── actions.ts
│   │   │   │   ├── config-actions.ts
│   │   │   │   ├── reconciliation.ts
│   │   │   │   └── config.ts
│   │   │   └── index.ts
│   │   └── tests/
│   │       ├── unit/
│   │       ├── integration/
│   │       └── fixtures/
│   │
│   ├── db/                       # Database — Drizzle schemas + repositories
│   │   ├── src/
│   │   │   ├── schema/
│   │   │   ├── repositories/
│   │   │   ├── migrations/
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── queue/                    # Queue — BullMQ today, Temporal tomorrow
│   │   ├── src/
│   │   │   ├── bullmq/
│   │   │   │   ├── crawl-queue.ts
│   │   │   │   ├── extract-queue.ts
│   │   │   │   └── workers/
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── shared/                   # Shared utilities
│       ├── src/
│       │   ├── logger.ts
│       │   ├── errors.ts
│       │   ├── config.ts
│       │   └── utils.ts
│       └── package.json
│
├── apps/
│   ├── api/                      # Hono API server
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── middleware/
│   │   │   ├── ws/
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── cli/                      # Interactive CLI (Ink TUI)
│       ├── src/
│       │   ├── components/
│       │   │   ├── App.tsx
│       │   │   ├── conversational/
│       │   │   ├── dashboard/
│       │   │   ├── review/
│       │   │   ├── explorer/
│       │   │   └── shared/
│       │   ├── hooks/
│       │   ├── store/
│       │   └── index.tsx
│       └── package.json
│
└── docs/
    └── plans/
```

### Dependency Graph

```
shared <--- db <--- queue
  ^          ^        ^
  |          |        |
  +---- core ---------+
          ^
          |
     +----+----+
     |         |
    api       cli
```

Core depends on `shared`, imports interfaces that `db` and `queue` implement. Apps wire everything together via dependency injection at startup.

---

## 5. Core Types & Schema System

### Job Configuration

```typescript
const FieldDefinition = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum([
    'string', 'number', 'boolean', 'url',
    'currency', 'enum', 'array', 'object'
  ]),
  required: z.boolean().default(false),
  normalization: NormalizationRule.optional(),
  enumValues: z.array(z.string()).optional(),
  arrayItemType: z.lazy(() => FieldDefinition).optional(),
  objectFields: z.lazy(() => z.array(FieldDefinition)).optional(),
});

const JobConfig = z.object({
  tenantId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  seedUrls: z.array(z.string().url()),

  crawl: z.object({
    maxDepth: z.number().min(0).max(10).default(2),
    maxPages: z.number().min(1).default(1000),
    concurrency: z.number().min(1).max(20).default(5),
    crawlerType: z.enum(['playwright', 'firecrawl']).default('playwright'),
  }),

  schema: z.object({
    mode: z.enum(['fixed', 'discovery', 'hybrid']),
    userFields: z.array(FieldDefinition).optional(),
    evolutionConfig: z.object({
      enabled: z.boolean(),
      batchSize: z.number().default(10),
      maxFields: z.number().default(50),
      relevanceThresholds: z.object({
        requiredMin: z.number().default(0.85),
        optionalMin: z.number().default(0.40),
        rareBelow: z.number().default(0.40),
        minCategorySampleSize: z.number().default(5),
      }),
      tableStrategy: z.enum(['single', 'multi', 'auto']).default('auto'),
    }).optional(),
  }),

  llm: z.object({
    primaryModel: z.string().default('anthropic/claude-sonnet-4-20250514'),
    modelOverrides: z.object({
      pageRelevance: z.string().optional(),
      extraction: z.string().optional(),
      linkEvaluation: z.string().optional(),
      schemaEvolution: z.string().optional(),
      entityMatching: z.string().optional(),
      conflictResolution: z.string().optional(),
      qualityAudit: z.string().optional(),
      documentation: z.string().optional(),
    }).optional(),
  }),

  reconciliation: ReconciliationConfig.optional(),
});
```

### Category-Aware Field Relevance

Instead of a flat confidence threshold (which would discard subset-specific fields), fields are evaluated both globally and per-category:

```typescript
const FieldRelevance = z.object({
  globalFrequency: z.number(),
  categoryBreakdown: z.array(z.object({
    category: z.string(),
    frequency: z.number(),
    sampleSize: z.number(),
  })),
  classification: z.enum([
    'universal_required',     // >85% global frequency
    'universal_optional',     // 40-85% global frequency
    'categorical_required',   // >85% within at least one category
    'categorical_optional',   // 40-85% within at least one category
    'rare',                   // <40% everywhere
  ]),
  applicableCategories: z.array(z.string()).nullable(),
});
```

Example: `driver_type` has 40% global frequency but 98% within headphones — classified as `categorical_required` for headphones, not discarded.

### Schema Definition

```typescript
const FieldAlias = z.object({
  canonicalName: z.string(),
  aliases: z.array(z.object({
    name: z.string(),
    sources: z.array(z.string()),
    occurrences: z.number(),
  })),
  mergedAt: z.date(),
  reasoning: z.string(),
});

const SchemaDefinition = z.object({
  version: z.number(),
  fields: z.array(FieldDefinition),
  fieldAliases: z.array(FieldAlias),
  createdAt: z.date(),
  parentVersion: z.number().nullable(),
});
```

### Normalization Rules

```typescript
const NormalizationRule = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('currency'),
    config: z.object({
      targetCurrency: z.string().optional(),
      decimalPlaces: z.number().default(2),
    }),
  }),
  z.object({
    type: z.literal('enum'),
    config: z.object({
      canonicalValues: z.array(z.string()),
      synonymMap: z.record(z.string()),
    }),
  }),
  z.object({
    type: z.literal('list'),
    config: z.object({
      separator: z.string().optional(),
      itemNormalization: z.lazy(() => NormalizationRule).optional(),
    }),
  }),
  z.object({
    type: z.literal('text'),
    config: z.object({
      casing: z.enum(['title', 'lower', 'upper', 'preserve']).default('title'),
      trim: z.boolean().default(true),
      collapseWhitespace: z.boolean().default(true),
    }),
  }),
  z.object({
    type: z.literal('measurement'),
    config: z.object({
      targetUnit: z.string().optional(),
      format: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('boolean'),
    config: z.object({
      trueValues: z.array(z.string()).default(['yes', 'true', '1', 'available']),
      falseValues: z.array(z.string()).default(['no', 'false', '0', 'unavailable']),
    }),
  }),
  z.object({
    type: z.literal('llm'),
    config: z.object({
      instruction: z.string(),
    }),
  }),
]);
```

### Extraction Types

```typescript
const ExtractionResult = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  pageId: z.string().uuid(),
  schemaVersion: z.number(),
  data: z.record(z.unknown()),
  metadata: z.object({
    confidence: z.number().min(0).max(1),
    modelUsed: z.string(),
    tokensUsed: z.number(),
    extractionTimeMs: z.number(),
    unmappedFields: z.array(z.object({
      name: z.string(),
      value: z.unknown(),
      suggestedType: z.string(),
    })),
  }),
});
```

### Reconciliation Types

```typescript
const EntityMatchStrategy = z.enum([
  'exact_name', 'fuzzy_name', 'composite_key', 'llm_assisted',
]);

const ConflictResolution = z.enum([
  'most_common', 'most_complete', 'source_priority', 'most_recent', 'llm_resolved',
]);

const ValueProvenance = z.enum([
  'extracted', 'normalized', 'merged', 'resolved', 'inferred',
]);

const EntityMatch = z.object({
  entityId: z.string().uuid(),
  sourceExtractions: z.array(z.object({
    extractionId: z.string().uuid(),
    sourceUrl: z.string().url(),
    sourceDomain: z.string(),
    crawledAt: z.date(),
    fieldsCovered: z.array(z.string()),
  })),
  mergedData: z.record(z.unknown()),
  fieldProvenance: z.record(z.object({
    finalValue: z.unknown(),
    provenanceType: ValueProvenance,
    sources: z.array(z.object({
      sourceUrl: z.string(),
      rawValue: z.unknown(),
      normalizedValue: z.unknown(),
    })),
    hadConflict: z.boolean(),
    resolution: ConflictResolution.optional(),
  })),
});

const ReconciliationConfig = z.object({
  matchStrategy: EntityMatchStrategy.default('composite_key'),
  conflictResolution: ConflictResolution.default('most_complete'),
  sourcePriority: z.array(z.string()).optional(),
  fuzzyMatchThreshold: z.number().default(0.85),
  enableLLMMatching: z.boolean().default(true),
});
```

---

## 6. Action-Based Execution Model

Every state mutation in Spatula flows through typed, validated action objects. The LLM never directly mutates state — it produces actions that an executor processes.

```
LLM Call → Structured JSON → Zod Validation → Action[] → Executor → State Mutation
```

### Pipeline Actions (22 types)

Used during and after crawling:

**Schema Actions:**
- `add_field` — Add a new field to the schema
- `merge_fields` — Merge synonym fields under a canonical name
- `modify_field` — Change field type, required status, description
- `remove_field` — Remove a field (rare, requires review)
- `rename_field` — Rename a field for cleaner output
- `split_field` — Split one field into multiple (e.g., "dimensions" → width, height, depth)
- `group_fields` — Combine flat fields into nested object (e.g., price_amount + price_currency → price)

**Normalization Actions:**
- `set_normalization_rule` — Attach normalization rules to a field
- `update_enum_map` — Expand enum synonym mappings

**Category Actions:**
- `define_category` — Identify natural groupings in the data
- `assign_category_fields` — Map fields to categories with required/optional status

**Crawl Actions:**
- `classify_page` — Classify page type (single entry, listing, navigation, irrelevant)
- `enqueue_links` — Add discovered links to crawl queue with priority
- `hint_entity_match` — Early hint that two pages describe the same entity

**Reconciliation Actions:**
- `match_entities` — Group extractions as the same real-world entity
- `split_entities` — Undo incorrect entity match
- `resolve_conflict` — Choose a value when sources disagree
- `infer_value` — Fill a gap with AI-inferred data (flagged as inferred)
- `correct_value` — Fix a typo, outlier, or format error
- `set_source_trust` — Assign trust rankings to source domains

**Reprocessing Actions:**
- `reprocess_extraction` — Re-extract pages with evolved schema

**Finalization Actions:**
- `recommend_table_structure` — Single vs multi-table recommendation
- `derive_field` — Compute a field from other fields
- `flag_anomaly` — Flag suspicious values without mutating
- `generate_documentation` — Produce data dictionary and quality summary

### Config Actions (30 types)

Used during conversational job configuration:

**Job Metadata:** `set_job_name`, `set_job_description`

**Seed URLs:** `add_seed_urls`, `remove_seed_urls`, `replace_seed_urls`

**Crawl Settings:** `set_crawl_depth`, `set_max_pages`, `set_concurrency`, `set_crawler_type`

**Schema Fields:** `add_user_field`, `add_multiple_user_fields`, `remove_user_field`, `modify_user_field`, `reorder_user_fields`, `replace_all_user_fields`, `define_nested_field`

**Schema Mode:** `set_schema_mode`, `set_evolution_config`

**LLM Config:** `set_primary_model`, `set_model_override`, `clear_model_override`

**Reconciliation Config:** `set_match_strategy`, `set_conflict_resolution`, `set_source_priority`

**Safety & Review:** `set_action_approval_policy`

**Templates:** `save_as_template`, `load_template`, `clone_job_config`

**Control:** `confirm_and_start`, `reset_config`

### Action Executor

```typescript
interface ActionExecutor {
  execute(action: Action): Promise<ActionResult>;
  rollback(actionId: string): Promise<void>;
  preview(action: Action): Promise<ActionPreview>;
}

interface ActionResult {
  actionId: string;
  status: 'applied' | 'rejected' | 'deferred';
  stateChanges: StateChange[];
  rejectionReason?: string;
}
```

### Safety Policies

Each action type has a default approval policy:

| Risk Level | Policy | Examples |
|---|---|---|
| **None** | `always_auto` | flag_anomaly, generate_documentation, classify_page, enqueue_links |
| **Low** | `auto_above_threshold` | add_field, set_normalization_rule, define_category |
| **Medium** | `batch_review` | merge_fields, rename_field, split_field, resolve_conflict |
| **High** | `always_review` | remove_field, recommend_table_structure, derive_field |

Users can override with presets: `trust_ai`, `balanced` (default), `cautious`, `manual`.

### LLM Output → Action Flow

1. Prompt includes the Zod output schema the LLM must conform to
2. LLM responds with structured JSON
3. Zod.parse() validates — on failure, retry with error feedback (up to 3x)
4. Validated actions checked against safety policy
5. Auto-approved actions executed immediately
6. Review-required actions queued for user approval
7. All actions recorded in audit log with reasoning, confidence, and state changes

---

## 7. LLM Intelligence Map

Every step where LLM intelligence is used, with model routing for cost optimization:

### Crawl Phase

| Step | Model Tier | Purpose |
|---|---|---|
| Page relevance check | Fast (Haiku/Flash) | Quick yes/no — does this page contain relevant data? |
| Data extraction | Primary (Sonnet) | Extract structured data using current schema |
| Unmapped field detection | Primary (Sonnet) | Capture fields not in schema (piggybacks on extraction) |
| First-pass normalization | Primary (Sonnet) | Normalize values during extraction via prompt instructions |
| Link evaluation | Fast (Haiku/Flash) | Score discovered links for relevance and priority |

### Schema Evolution Phase (batched)

| Step | Model Tier | Purpose |
|---|---|---|
| Category detection | Primary (Sonnet) | Identify natural groupings from data patterns |
| New field proposal | Primary (Sonnet) | Propose fields from unmapped evidence |
| Field synonym detection | Primary (Sonnet) | Detect cross-source field name synonyms |
| Normalization rule generation | Primary (Sonnet) | Build rules from observed value patterns |
| Enum canonicalization | Primary (Sonnet) | Build synonym maps for enum-like values |
| Category-field relevance | Primary (Sonnet) | Evaluate per-category field importance |

### Reconciliation Phase

| Step | Model Tier | Purpose |
|---|---|---|
| Entity matching | Primary (Sonnet) | Confirm ambiguous entity matches |
| Gap filling | Primary (Sonnet) | Infer obvious missing values (flagged as inferred) |
| Conflict resolution | Primary (Sonnet) | Pick best value when sources disagree |
| Value correction | Primary (Sonnet) | Fix typos, outliers, format errors |

### Finalization Phase

| Step | Model Tier | Purpose |
|---|---|---|
| Schema finalization | Smart (Sonnet/Opus) | Review for redundancy, optimal table design |
| Data quality audit | Smart (Sonnet/Opus) | Sample and flag anomalies, outliers, errors |
| Documentation generation | Fast (Haiku) | Auto-generate data dictionary and quality summary |

### Three-Layer Consolidation Pipeline

```
Layer 1: Field Synonym Detection (during schema evolution)
  "retail_price" from Site A + "price" from Site B → canonical "price"

Layer 2: Value Normalization (rules built during evolution, applied retroactively)
  "$299" | "299 USD" | "GBP249" → { amount: 299.00, currency: "USD" }
  "circumaural" | "Over Ear" → "over-ear"

Layer 3: Entity Reconciliation (post-crawl)
  Amazon entry + Head-Fi entry + Official site entry → single merged entity
  with gap filling, conflict resolution, and full provenance trail
```

---

## 8. Database Schema

```sql
-- Tenants
tenants (
  id          uuid PK,
  name        text,
  config      jsonb,      -- tenant-level defaults
  created_at  timestamptz
)

-- Jobs
jobs (
  id           uuid PK,
  tenant_id    uuid FK → tenants,
  name         text,
  description  text,
  config       jsonb,     -- full JobConfig
  status       enum(pending, queued, running, paused,
                    reconciling, completed, failed, cancelled),
  schema_id    uuid FK → schemas,
  stats        jsonb,     -- { pagesFound, pagesProcessed, entitiesFound, ... }
  created_at   timestamptz,
  started_at   timestamptz,
  completed_at timestamptz
)

-- Crawl Tasks
crawl_tasks (
  id              uuid PK,
  job_id          uuid FK → jobs,
  tenant_id       uuid,
  url             text,
  depth           integer,
  status          enum(pending, in_progress, completed, failed, skipped),
  priority        enum(high, medium, low),
  classification  enum(single_entry, multiple_entries, navigation, irrelevant, partial),
  parent_task_id  uuid,
  crawler_type    enum(playwright, firecrawl),
  content_ref     text,      -- ContentStore reference
  metadata        jsonb,
  created_at      timestamptz,
  processed_at    timestamptz
)

-- Raw Pages
raw_pages (
  id           uuid PK,
  task_id      uuid FK → crawl_tasks,
  tenant_id    uuid,
  content_ref  text,         -- ContentStore reference (Postgres key or S3 path)
  content_hash text,         -- dedup identical pages
  metadata     jsonb,
  created_at   timestamptz
)

-- Schemas
schemas (
  id          uuid PK,
  job_id      uuid FK → jobs,
  tenant_id   uuid,
  version     integer,
  definition  jsonb,         -- SchemaDefinition
  parent_id   uuid FK → schemas,
  created_at  timestamptz
)

-- Extractions
extractions (
  id              uuid PK,
  job_id          uuid FK → jobs,
  tenant_id       uuid,
  page_id         uuid FK → raw_pages,
  schema_version  integer,
  data            jsonb,
  unmapped_fields jsonb,
  metadata        jsonb,
  created_at      timestamptz
)

-- Entities (post-reconciliation)
entities (
  id            uuid PK,
  job_id        uuid FK → jobs,
  tenant_id     uuid,
  merged_data   jsonb,
  provenance    jsonb,      -- per-field source tracking
  categories    text[],
  quality_score float,
  created_at    timestamptz
)

-- Entity Sources (join table)
entity_sources (
  entity_id        uuid FK → entities,
  extraction_id    uuid FK → extractions,
  match_confidence float
)

-- Actions (audit log)
actions (
  id             uuid PK,
  job_id         uuid FK → jobs,
  tenant_id      uuid,
  type           text,
  payload        jsonb,
  source         enum(extraction, schema_evolution, reconciliation, quality_audit),
  status         enum(pending_review, approved, applied, rejected, rolled_back),
  confidence     float,
  reasoning      text,
  state_changes  jsonb,
  reviewed_by    text,
  created_at     timestamptz,
  applied_at     timestamptz
)

-- Source Trust
source_trust (
  id          uuid PK,
  job_id      uuid FK → jobs,
  tenant_id   uuid,
  domain      text,
  trust_level enum(authoritative, high, medium, low),
  reasoning   text
)
```

### Indexes

```
jobs:         (tenant_id, status), (tenant_id, created_at)
crawl_tasks:  (job_id, status), (job_id, depth), (url) for dedup
raw_pages:    (task_id), (content_hash) for dedup
extractions:  (job_id, schema_version), (page_id)
entities:     (job_id, categories) GIN, (job_id, quality_score)
actions:      (job_id, type), (job_id, status), (job_id, created_at)
```

---

## 9. Job Orchestration

### State Machine

```
pending → queued → running ⇄ paused
                      │
                      ├── all pages done → reconciling → completed
                      ├── unrecoverable error → failed
                      └── user cancels → cancelled
```

The `reconciling` state is distinct from `running` — crawl workers are done but post-crawl processing (entity matching, gap filling, quality audit, documentation) is in progress.

### Pipeline Flow

```
For each URL in queue:
  1. Crawl worker fetches page via pluggable crawler
  2. Page relevance check (fast model) → ClassifyPageAction
  3. If relevant: Extract data (primary model) → ExtractionResult
  4. Link evaluation (fast model) → EnqueueLinksAction
  5. Store raw content + extraction in Postgres

Every N extractions (batched):
  6. Schema evolution (primary model)
     → AddField, MergeFields, SetNormalizationRule, etc.
  7. Apply approved actions, queue others for review

Post-crawl:
  8. Re-normalize all extractions against final schema
  9. Entity matching + gap filling + conflict resolution
  10. Schema finalization + table structure recommendation
  11. Data quality audit
  12. Documentation generation
```

### Queue Configuration

```typescript
interface QueueConfig {
  crawl: { concurrency: number; rateLimit: { max: number; duration: number } };
  extract: { concurrency: number };
  schemaEvolution: { batchSize: number; lockTTL: number };
}
```

---

## 10. API Design

### REST Endpoints

```
POST   /api/v1/jobs                         Create a new crawl job
GET    /api/v1/jobs                         List jobs (filtered, paginated)
GET    /api/v1/jobs/:id                     Get job details + stats
PATCH  /api/v1/jobs/:id                     Update job (pause, resume, cancel)
DELETE /api/v1/jobs/:id                     Delete job and all data

GET    /api/v1/jobs/:id/schema              Get current schema + evolution history
GET    /api/v1/jobs/:id/schema/:version     Get specific schema version

GET    /api/v1/jobs/:id/extractions         List raw extractions (paginated)
GET    /api/v1/jobs/:id/entities            List reconciled entities (paginated, filterable)
GET    /api/v1/jobs/:id/entities/:eid       Get entity with full provenance

GET    /api/v1/jobs/:id/actions             List actions (filterable by type, status)
POST   /api/v1/jobs/:id/actions/:aid/approve   Approve pending action
POST   /api/v1/jobs/:id/actions/:aid/reject    Reject pending action
POST   /api/v1/jobs/:id/actions/approve-all    Batch approve

POST   /api/v1/jobs/:id/export             Trigger export
GET    /api/v1/jobs/:id/export/:eid         Download export file

GET    /api/v1/jobs/:id/documentation       Get auto-generated data dictionary
```

### WebSocket

```
/ws/jobs/:id/progress    Real-time crawl progress + action notifications
```

---

## 11. Interactive CLI

### Four Modes

**Mode 1: Conversational (default)** — Chat-like interface where the user describes their crawl in natural language. AI interprets intent, produces ConfigActions, displays the evolving config in a styled panel. User refines until satisfied.

**Mode 2: Dashboard** — Live-updating crawl monitoring. Shows progress bars, schema panel with categories and field coverage, activity feed, and recent entity preview. Keyboard-driven (single-key navigation).

**Mode 3: Review** — Interactive action review. Shows full context for each pending action: reasoning, evidence table, impact assessment, diff preview. Single-key approve/reject/edit.

**Mode 4: Explorer** — Post-crawl data browser. Scrollable table with natural language filtering, provenance display on entity expand, and inline export.

### Component Architecture

Built with Ink (React for terminals) + Zustand for state + WebSocket for real-time API connection.

```
apps/cli/src/
├── components/
│   ├── App.tsx
│   ├── conversational/
│   │   ├── ChatView.tsx
│   │   ├── ConfigPanel.tsx
│   │   └── StreamingResponse.tsx
│   ├── dashboard/
│   │   ├── DashboardView.tsx
│   │   ├── ProgressBar.tsx
│   │   ├── SchemaPanel.tsx
│   │   ├── ActivityFeed.tsx
│   │   └── EntityTable.tsx
│   ├── review/
│   │   ├── ReviewView.tsx
│   │   ├── ActionCard.tsx
│   │   ├── EvidenceTable.tsx
│   │   └── DiffPreview.tsx
│   ├── explorer/
│   │   ├── ExplorerView.tsx
│   │   ├── FilterBar.tsx
│   │   ├── DataTable.tsx
│   │   └── ProvenancePanel.tsx
│   └── shared/
│       ├── Header.tsx
│       ├── KeyboardHints.tsx
│       ├── Spinner.tsx
│       └── Panel.tsx
├── hooks/
│   ├── useWebSocket.ts
│   ├── useJobState.ts
│   └── useKeyboard.ts
├── store/
│   └── index.ts
└── index.tsx
```

---

## 12. Export Pipeline

```typescript
interface Exporter {
  export(entities: Entity[], schema: SchemaDefinition, options: ExportOptions): Promise<ExportResult>;
}
```

**v1:** JsonExporter, CsvExporter
**Future:** ParquetExporter, DuckDbExporter, SqliteExporter

Export includes: data, schema definition, auto-generated documentation, and optionally the full provenance trail.

---

## 13. Scalability Design

Five decisions baked into the foundation:

1. **Content Store interface** — Raw HTML behind `ContentStore` (Postgres now, S3/R2 later). Keeps main database lean.

2. **Batched schema evolution** — Runs every N extractions with distributed lock. Eliminates race conditions, reduces LLM costs from O(pages) to O(pages/batch_size).

3. **Tenant-aware from day one** — Every table has `tenant_id`, every query scopes by tenant, every queue job carries tenant context.

4. **Config-driven concurrency** — Per-tenant resource quotas: `{ maxConcurrentCrawls, maxPagesPerJob, maxExtractionWorkers }`.

5. **Stateless workers** — All state in Postgres/Redis. Workers die and restart without data loss. Enables horizontal scaling and Temporal migration.

### Scale Path

| Scale | Changes Needed |
|---|---|
| 1-100 jobs | Current design works as-is |
| 100-1K jobs | Add read replicas, PgBouncer, worker auto-scaling |
| 1K+ jobs | Temporal for orchestration, S3 for content, table partitioning |

---

## 14. Implementation Phases

Each phase is production-quality: tested, documented, and hardened before the next begins.

### Phase 1: Project Foundation & Core Types
- Monorepo scaffolding (Turborepo + pnpm)
- All Zod schemas and types from Section 5
- Config system, logger, error types
- CI pipeline, linting, formatting, test infrastructure
- **Deliverable:** `npm test` runs, all validators pass, project structure documented

### Phase 2: Pluggable Crawler
- `Crawler` interface definition
- Playwright adapter
- Firecrawl adapter
- Link discovery and extraction from raw pages
- **Deliverable:** Both adapters crawl any URL, return normalized content, fully tested

### Phase 3: LLM Integration & Static Extraction
- OpenRouter client with retry, rate limiting, model selection
- Prompt engineering for structured extraction
- Raw HTML + Zod schema → structured JSON
- **Deliverable:** Fixture-based test suite (20+ page snapshots)

### Phase 4: Storage Layer
- PostgreSQL + Drizzle ORM setup
- All tables from Section 8
- Repository pattern, migration system
- **Deliverable:** Full CRUD, integration tests against real Postgres

### Phase 5: Job Orchestration
- Job state machine (Section 9)
- BullMQ queues with configurable concurrency
- AI-powered link relevance filtering + configurable depth
- Ties Phases 2-4 together
- **Deliverable:** E2E test — create job → crawl → extract → store

### Phase 6: Intelligent Schema Evolution
- Schema analysis engine with category detection
- Dynamic feature discovery
- Schema versioning with diff history
- Batched evaluation with distributed locking
- **Deliverable:** Test suite feeding sequential pages, verifying evolution

### Phase 7: Data Reconciliation & Normalization
- Full three-layer consolidation pipeline
- Entity matching, gap filling, conflict resolution
- Required vs optional inference, schema finalization
- **Deliverable:** Given messy multi-source data → clean normalized output

### Phase 8: API Server
- Hono REST endpoints (Section 10)
- WebSocket for real-time progress
- Input validation, structured errors, OpenAPI docs
- **Deliverable:** Full API test suite, Swagger docs

### Phase 9a: CLI — Core + Conversational Mode
- Ink setup, component library, WebSocket connection
- Conversational job creation with LLM (ConfigActions)
- Basic status/list commands
- **Deliverable:** Create and start a job through conversation

### Phase 9b: CLI — Dashboard + Review Mode
- Live dashboard with all panels
- Interactive action review flow
- Keyboard navigation
- **Deliverable:** Monitor full crawl lifecycle interactively

### Phase 9c: CLI — Results Explorer
- Data table with filtering
- Natural language filter
- Provenance display, inline export
- **Deliverable:** Browse, filter, export results from terminal

### Phase 10: Export Pipeline
- JSON and CSV exporters
- Pluggable exporter interface
- Export from API and CLI
- **Deliverable:** Export tests per format, validated against schema

---

## Action Type Reference

### Pipeline Actions (22)

| # | Type | Category | Default Safety |
|---|---|---|---|
| 1 | `add_field` | Schema | auto_above_threshold |
| 2 | `merge_fields` | Schema | batch_review |
| 3 | `modify_field` | Schema | auto_above_threshold |
| 4 | `remove_field` | Schema | always_review |
| 5 | `rename_field` | Schema | batch_review |
| 6 | `split_field` | Schema | batch_review |
| 7 | `group_fields` | Schema | batch_review |
| 8 | `set_normalization_rule` | Normalization | auto_above_threshold |
| 9 | `update_enum_map` | Normalization | always_auto |
| 10 | `define_category` | Category | auto_above_threshold |
| 11 | `assign_category_fields` | Category | auto_above_threshold |
| 12 | `classify_page` | Crawl | always_auto |
| 13 | `enqueue_links` | Crawl | always_auto |
| 14 | `hint_entity_match` | Crawl | always_auto |
| 15 | `match_entities` | Reconciliation | auto_above_threshold |
| 16 | `split_entities` | Reconciliation | batch_review |
| 17 | `resolve_conflict` | Reconciliation | batch_review |
| 18 | `infer_value` | Reconciliation | batch_review |
| 19 | `correct_value` | Reconciliation | batch_review |
| 20 | `set_source_trust` | Reconciliation | auto_above_threshold |
| 21 | `reprocess_extraction` | Reprocessing | auto_above_threshold |
| 22 | `recommend_table_structure` | Finalization | always_review |
| 23 | `derive_field` | Finalization | always_review |
| 24 | `flag_anomaly` | Finalization | always_auto |
| 25 | `generate_documentation` | Finalization | always_auto |

### Config Actions (30)

| # | Type | Category |
|---|---|---|
| 1 | `set_job_name` | Metadata |
| 2 | `set_job_description` | Metadata |
| 3 | `add_seed_urls` | Seed URLs |
| 4 | `remove_seed_urls` | Seed URLs |
| 5 | `replace_seed_urls` | Seed URLs |
| 6 | `set_crawl_depth` | Crawl Settings |
| 7 | `set_max_pages` | Crawl Settings |
| 8 | `set_concurrency` | Crawl Settings |
| 9 | `set_crawler_type` | Crawl Settings |
| 10 | `add_user_field` | Schema Fields |
| 11 | `add_multiple_user_fields` | Schema Fields |
| 12 | `remove_user_field` | Schema Fields |
| 13 | `modify_user_field` | Schema Fields |
| 14 | `reorder_user_fields` | Schema Fields |
| 15 | `replace_all_user_fields` | Schema Fields |
| 16 | `define_nested_field` | Schema Fields |
| 17 | `set_schema_mode` | Schema Mode |
| 18 | `set_evolution_config` | Schema Mode |
| 19 | `set_primary_model` | LLM Config |
| 20 | `set_model_override` | LLM Config |
| 21 | `clear_model_override` | LLM Config |
| 22 | `set_match_strategy` | Reconciliation |
| 23 | `set_conflict_resolution` | Reconciliation |
| 24 | `set_source_priority` | Reconciliation |
| 25 | `set_action_approval_policy` | Safety |
| 26 | `save_as_template` | Templates |
| 27 | `load_template` | Templates |
| 28 | `clone_job_config` | Templates |
| 29 | `confirm_and_start` | Control |
| 30 | `reset_config` | Control |
