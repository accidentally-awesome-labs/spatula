# Spatula Architecture

This document describes the internal architecture of Spatula — the package structure, data flow, core interfaces, action system, and LLM integration points.

## Package Dependency Graph

```mermaid
graph TD
    shared["@spatula/shared<br/>logging, auth, metrics, errors"]
    core["@spatula/core<br/>types, interfaces, pipeline logic"]
    db["@spatula/db<br/>PostgreSQL + SQLite, Drizzle ORM"]
    queue["@spatula/queue<br/>BullMQ workers, webhooks"]
    api["@spatula/api<br/>Hono REST API"]
    cli["@spatula/cli<br/>CLI + TUI (yargs + Ink)"]

    core --> shared
    db --> shared
    db --> core
    queue --> shared
    queue --> core
    queue --> db
    api --> shared
    api --> core
    api --> db
    api --> queue
    cli --> shared
    cli --> core
    cli --> db
```

**Design principle:** `@spatula/core` is a pure library with zero HTTP, CLI, or queue knowledge. The API and CLI are thin clients that compose core interfaces with infrastructure.

## Data Flow

```mermaid
flowchart LR
    subgraph Input
        seeds["Seed URLs"]
        config["spatula.yaml"]
    end

    subgraph Crawl
        crawler["Crawler<br/>(Playwright / Firecrawl)"]
        relevance["Page Relevance<br/>Classification"]
        links["Link Evaluation<br/>& Scoring"]
    end

    subgraph Extract
        extractor["LLM Extractor<br/>(or CSS fallback)"]
        classify["Page Category<br/>Classification"]
    end

    subgraph Evolve
        evolver["Schema Evolver<br/>(batch-based)"]
        actions["Action Queue<br/>(approve/reject)"]
    end

    subgraph Reconcile
        matcher["Entity Matcher<br/>(fuzzy / composite / LLM)"]
        merge["Conflict Resolution<br/>& Field Provenance"]
        normalize["Normalization<br/>(currency, enum, text)"]
    end

    subgraph Export
        exporter["Exporter<br/>(JSON, CSV, Parquet,<br/>SQLite, DuckDB)"]
    end

    seeds --> crawler
    config --> crawler
    crawler --> relevance
    relevance -->|relevant| extractor
    relevance -->|relevant| links
    links -->|new URLs| crawler
    extractor --> classify
    classify --> evolver
    evolver --> actions
    actions -->|approved| matcher
    matcher --> merge
    merge --> normalize
    normalize --> exporter
```

### Pipeline Stages

1. **Crawl** — Fetch pages from seed URLs. Respect robots.txt, rate limits, and page budget. Evaluate discovered links for crawl priority.
2. **Classify** — LLM determines page relevance (is this page about the target data?) and page category (product page vs listing page vs article).
3. **Extract** — LLM extracts structured fields from relevant pages. Falls back to CSS-selector extraction when no LLM is configured.
4. **Schema Evolution** — Batched analysis of unmapped fields across pages. Proposes schema changes as actions requiring human review.
5. **Reconcile** — Match entities across pages (same product from different URLs), resolve conflicting field values, normalize data types.
6. **Export** — Output clean datasets in 5 formats. Every field carries provenance metadata (extracted, normalized, merged, resolved, inferred).

## Core Interfaces

Spatula is interface-driven — every major component is a contract with pluggable implementations.

| Interface | File | Implementations |
|-----------|------|-----------------|
| `Crawler` | `packages/core/src/interfaces/crawler.ts` | `PlaywrightCrawler`, `FirecrawlCrawler` |
| `Extractor` | `packages/core/src/interfaces/extractor.ts` | `LLMExtractor`, `CssExtractor` |
| `LLMClient` | `packages/core/src/interfaces/llm-client.ts` | `OpenRouterClient`, `OllamaClient`, `CircuitBreakerLLMClient` |
| `ContentStore` | `packages/core/src/interfaces/content-store.ts` | `FilesystemContentStore`, `S3ContentStore` |
| `DataSource` | `packages/core/src/interfaces/data-source.ts` | `LocalDataSource` (SQLite), API client (planned) |
| `SchemaEvolver` | `packages/core/src/interfaces/schema-evolver.ts` | `LLMSchemaEvolver` |
| `Reconciler` | `packages/core/src/interfaces/reconciler.ts` | `LLMReconciler` |
| `Exporter` | `packages/core/src/interfaces/exporter.ts` | `JsonExporter`, `CsvExporter`, `ParquetExporter`, `SqliteExporter`, `DuckDbExporter` |
| `ActionExecutor` | `packages/core/src/interfaces/action-executor.ts` | Pipeline action executor |
| `ConfigExecutor` | `packages/core/src/interfaces/config-executor.ts` | Config action executor |
| `Orchestrator` | `packages/core/src/interfaces/orchestrator.ts` | `CrawlOrchestrator`, `SchemaOrchestrator`, `ReconcileOrchestrator`, `ExportOrchestrator` |

### Dual Execution Model

Spatula runs in two modes:

- **Server mode** — PostgreSQL + Redis + BullMQ. API server handles HTTP requests, BullMQ workers process jobs asynchronously. Multi-tenant.
- **Local mode** — SQLite + in-memory queues. `spatula run` executes the full pipeline in-process. Single-project.

Both modes use the same orchestrator functions from `@spatula/core`. The server wraps them in BullMQ workers; the CLI calls them directly via `LocalPipelineRunner`.

## Action System

All data mutations flow through typed **actions**. Actions are proposals that may require human review before execution.

### Action Categories

| Category | Count | Examples |
|----------|-------|---------|
| **Schema** | 9 | `ADD_FIELD`, `MODIFY_FIELD`, `REMOVE_FIELD`, `RENAME_FIELD`, `SPLIT_FIELD`, `GROUP_FIELDS`, `MERGE_FIELDS`, `RECOMMEND_TABLE_STRUCTURE`, `DERIVE_FIELD` |
| **Normalization** | 2 | `SET_NORMALIZATION_RULE`, `UPDATE_ENUM_MAP` |
| **Category** | 3 | `DEFINE_CATEGORY`, `ASSIGN_CATEGORY_FIELDS`, `CLASSIFY_PAGE` |
| **Crawl** | 1 | `ENQUEUE_LINKS` |
| **Reconciliation** | 7 | `HINT_ENTITY_MATCH`, `MATCH_ENTITIES`, `SPLIT_ENTITIES`, `RESOLVE_CONFLICT`, `INFER_VALUE`, `CORRECT_VALUE`, `SET_SOURCE_TRUST` |
| **Reprocessing** | 1 | `REPROCESS_EXTRACTION` |
| **Quality** | 1 | `FLAG_ANOMALY` |
| **Documentation** | 1 | `GENERATE_DOCUMENTATION` |
| **Config** | 30 | Seed management, field configuration, crawl settings, LLM tuning, export preferences |

**Total: 55 action types** (25 pipeline + 30 config).

### Safety Levels

Each project defines a `safety` level controlling how actions are handled:

| Level | Behavior |
|-------|----------|
| `trust_ai` | All actions auto-approved |
| `balanced` | Low-risk auto-approved, high-risk queued for review |
| `cautious` | Most actions queued for review |
| `manual` | All actions queued for review |

## LLM Usage Map

LLM inference is used at 8 decision points, each routable to a different model tier:

| Task | Purpose | Default Tier | Why |
|------|---------|-------------|-----|
| `pageRelevance` | Is this page about our target data? | Fast (Haiku) | High volume, simple yes/no |
| `linkEvaluation` | Should we follow this link? | Fast (Haiku) | High volume, scoring task |
| `extraction` | Extract structured fields from page | Primary (Sonnet) | Core accuracy requirement |
| `schemaEvolution` | Propose new fields from unmapped data | Primary (Sonnet) | Complex reasoning |
| `entityMatching` | Are these the same real-world entity? | Primary (Sonnet) | Fuzzy matching |
| `conflictResolution` | Which value is correct when sources disagree? | Primary (Sonnet) | Judgment call |
| `qualityAudit` | Verify extraction quality | Primary (Sonnet) | Accuracy check |
| `documentation` | Generate field descriptions | Fast (Haiku) | Simple text generation |

Model routing is configured per-project in `spatula.yaml` under `llm.overrides`. The `model-router.ts` resolves the model for each task by checking: task-specific override > project default > global config default.
