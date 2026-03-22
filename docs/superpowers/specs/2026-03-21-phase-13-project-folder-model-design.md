# Phase 13: Project-Folder Model & Local Execution

**Status:** Draft
**Created:** 2026-03-21
**Depends on:** Phase 12 (production hardening, Workstream J local DX features)
**Scope:** Transform Spatula from a server-centric platform into a project-folder-based developer tool with local execution, resumable crawls, and seamless hosted integration.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Project Structure & Global Config](#2-project-structure--global-config)
3. [Setup Wizard](#3-setup-wizard)
4. [Local Execution Pipeline](#4-local-execution-pipeline)
5. [SQLite Schema & Repository Layer](#5-sqlite-schema--repository-layer)
6. [Config Diff Engine](#6-config-diff-engine)
7. [Command Structure](#7-command-structure)
8. [Remote Operations & Hosted Integration](#8-remote-operations--hosted-integration)
9. [Data Pull Flow](#9-data-pull-flow)
10. [Safety & Edge Cases](#10-safety--edge-cases)
11. [Implementation Steps](#11-implementation-steps)
12. [Testing Strategy](#12-testing-strategy)
13. [Migration & Rollout](#13-migration--rollout)

---

## 1. Overview

### 1.1 Problem

Spatula is currently server-centric: all state lives in Postgres, managed via API, namespaced by tenant/job. Starting a crawl requires Docker (Postgres + Redis), an API server, worker processes, and an OpenRouter API key. This is the right architecture for a hosted offering but creates unnecessary friction for the primary open-source use case: a developer who wants to scrape a product catalog into a folder.

### 1.2 Solution

Introduce a project-folder model inspired by git and npm:

- `spatula.yaml` in a directory marks it as a Spatula project (like `package.json`)
- `.spatula/` stores derived state (like `node_modules/`)
- `~/.spatula/config.yaml` holds global credentials and preferences (like `~/.npmrc`)
- Crawls run in-process with no external infrastructure beyond the LLM provider
- Projects are resumable, extendable, and version-control friendly
- Config-only push to hosted, results pull back to local

### 1.3 Two Modes, One Core

The `@spatula/core` engine is shared between local and server modes. The same crawlers, extractors, classifiers, schema evolvers, reconcilers, and exporters run in both environments. Only the orchestration layer differs:

| | Local Mode | Server Mode |
|---|---|---|
| Database | SQLite (single file) | PostgreSQL |
| Orchestration | In-process pipeline | BullMQ + Redis |
| Concurrency | Semaphore (in-memory) | Worker processes |
| State location | `.spatula/project.db` | Postgres tables |
| Auth | None | API keys / JWT |
| Multi-tenancy | No (single project) | Yes |

### 1.4 Design Principles

- **Minimum viable config:** A working project needs one line (a URL)
- **Progressive disclosure:** Simple things are simple, complex things are possible
- **Secrets never in project files:** `spatula.yaml` is always safe to commit
- **Resume by default:** Ctrl+C is not an error, it's a pause
- **Core engine is mode-agnostic:** Business logic never knows if it's running locally or on a server

---

## 2. Project Structure & Global Config

### 2.1 Global Config (`~/.spatula/config.yaml`)

Created once via `spatula init --global` or automatically during first `spatula init`. Holds credentials and default preferences. Never committed to version control.

The global config includes a `version` field for forward compatibility. When a new Spatula version requires new config keys, `spatula setup` detects the version mismatch and prompts the user to update. Unknown keys are preserved (not stripped) to support downgrade scenarios.

```yaml
version: 1                              # config schema version

# Credentials
openrouterApiKey: sk_or_abc123...
firecrawlApiKey: fc_...                  # optional

# Preferences (defaults for all projects)
llm:
  provider: ollama                       # or openrouter
  model: llama3.2:8b

crawler: playwright                      # or firecrawl
politeness:
  respectRobotsTxt: true
  delayMs: 1000

# Remotes (managed by `spatula remote add`)
remotes:
  prod:
    url: https://api.spatula.dev
    apiKey: sk_live_...
  staging:
    url: https://staging.spatula.dev
    apiKey: sk_test_...
```

### 2.2 Project File (`spatula.yaml`)

The source of truth for a project. Version-controlled. Contains no secrets.

**Tier 1 -- bare minimum (works with just this):**

```yaml
seeds:
  - https://acme.com/products
```

Name defaults to directory name. Schema mode defaults to `discovery`. All other settings from global config or built-in defaults.

**Tier 2 -- typical project (most users stop here):**

```yaml
name: Acme Products

seeds:
  - https://acme.com/products
  - https://acme.com/categories

fields:
  - product_name: string
  - price: currency
  - description: string
  - image_url: url

depth: 3
limit: 2000
```

The field shorthand `product_name: string` expands to `{ field: product_name, type: string }`. The expanded form is available when per-field options are needed:

```yaml
fields:
  - product_name: string                 # shorthand: field_name: type
  - field: price                         # expanded form
    type: currency
    required: true
    selector: ".price-current"
```

The expanded form uses `field` (not `name`) as the key to avoid confusion: `field` is the field name being defined, `type` is its data type. The shorthand `price: currency` is syntactic sugar for `{ field: price, type: currency }`.

**Tier 3 -- full control:**

```yaml
name: Acme Products
description: Full product catalog with pricing and availability

seeds:
  - https://acme.com/products
  - https://acme.com/categories

fields:
  - product_name: string
  - field: price
    type: currency
    required: true
    selector: ".price-current"
  - description: string
  - availability: string

depth: 3
limit: 2000
crawler: playwright
safety: balanced

crawl:
  concurrency: 5
  proxy: socks5://127.0.0.1:1080
  cookies:
    - name: session_id
      domain: .acme.com

schema:
  mode: hybrid
  evolution:
    batchSize: 10
    maxFields: 50

llm:
  model: anthropic/claude-sonnet-4-20250514
  overrides:
    linkEvaluation: anthropic/claude-3-haiku-20240307
    pageRelevance: anthropic/claude-3-haiku-20240307

reconciliation:
  strategy: composite_key
  conflictResolution: most_complete
  fuzzyThreshold: 0.85

export:
  format: json
  autoExport: true
  includeProvenance: false

notify:
  desktop: true
  webhook: https://hooks.slack.com/services/...
  on: [completed, failed]
```

### 2.3 Config-to-JobConfig Mapping

User-friendly YAML names map to internal `JobConfig` fields at parse time:

| YAML (user-facing) | JobConfig (internal) |
|--------------------|----------------------|
| `seeds` | `seedUrls` |
| `depth` | `crawl.maxDepth` |
| `limit` | `crawl.maxPages` |
| `crawler` | `crawl.crawlerType` |
| `fields` | `schema.userFields` |
| `safety` | `safetyPreset` |
| `crawl.concurrency` | `crawl.concurrency` |
| `crawl.proxy` | `crawl.proxy` |
| `crawl.cookies` | `crawl.cookies` |
| `schema.mode` | `schema.mode` |
| `schema.evolution.*` | `schema.evolutionConfig.*` |
| `llm.model` | `llm.primaryModel` |
| `llm.overrides` | `llm.modelOverrides` |
| `reconciliation.strategy` | `reconciliation.matchStrategy` |
| `reconciliation.conflictResolution` | `reconciliation.conflictResolution` |
| `reconciliation.fuzzyThreshold` | `reconciliation.fuzzyMatchThreshold` |

### 2.4 Secrets Strategy

`spatula.yaml` never contains secrets. Sensitive values are resolved from:

1. **Global config (`~/.spatula/config.yaml`):** API keys for LLM providers and remotes
2. **Environment variables:** Override anything. Convention:
   - `SPATULA_PROXY_PASSWORD` -- proxy authentication
   - `SPATULA_COOKIE_<UPPERCASE_NAME>` -- cookie values (e.g., `SPATULA_COOKIE_SESSION_ID`)
   - `SPATULA_REMOTE_<NAME>_API_KEY` -- remote API keys
3. **Interactive prompt:** If a required secret is not found in config or env, the CLI prompts at runtime

The YAML declares WHAT is needed (cookie names, proxy URL, remote names). The environment provides SENSITIVE VALUES.

### 2.5 Config Resolution Order

```
Built-in defaults (lowest priority)
  | overridden by
~/.spatula/config.yaml (global preferences)
  | overridden by
spatula.yaml (project config)
  | overridden by
CLI flags (--depth 5, --limit 500)
  | overridden by
Environment variables (SPATULA_*, highest priority)
```

### 2.6 Project State (`.spatula/`)

Gitignored. Derived state that can be regenerated by re-running `spatula run`.

```
.spatula/
  project.db                  # SQLite database (all project state)
  pages/                      # Raw HTML files, named by page ID
    a1b2c3d4.html
    e5f6g7h8.html
  exports/                    # Generated export files
    2026-03-21T1432-json/
      data.json
      documentation.json
  cache/
    robots/                   # Per-domain robots.txt cache
  logs/
    2026-03-21T1432.log       # Per-run structured logs
  run.lock                    # PID lockfile (prevents concurrent runs)
```

### 2.7 Project Detection

The CLI walks up the directory tree looking for `spatula.yaml` (like git looks for `.git/`). Commands that require a project context fail with:

```
Not in a Spatula project. Run 'spatula init' to create one.
```

---

## 3. Setup Wizard

### 3.1 Single Entry Point: `spatula init`

No separate global vs project setup. The CLI detects what's needed and guides the user through everything in one flow.

### 3.2 First-Time Flow (no `~/.spatula/config.yaml`)

```
$ spatula init https://acme.com/products

  Welcome to Spatula! Let's get you set up.

--- AI Setup -----------------------------------------

? How would you like to power AI extraction?

  > Ollama (free, local, offline)
    OpenRouter (cloud, higher quality)
    Skip (CSS selectors only, no AI)

? Checking Ollama... Found at localhost:11434
? Available models:
  > llama3.2:8b (recommended - 5GB)
    llama3.2:3b (faster - 2GB)
    Pull a different model: ___

  Done: AI configured: Ollama / llama3.2:8b

--- Crawling Defaults --------------------------------

? Default crawler?
  > Playwright (handles JavaScript, best compatibility)
    Basic HTTP (fast, lightweight)

? Respect robots.txt? Yes

  Done: Global config saved to ~/.spatula/config.yaml

--- Project: acme-products ---------------------------

  Seed URL: https://acme.com/products

? Add more URLs? (enter to skip)
  URL: https://acme.com/categories
  URL: (enter)

? What data are you looking for?
  > Let AI discover fields automatically
    I know what fields I want
    Both - define some, AI discovers the rest
    Describe in plain English (conversational mode)

? How deep to crawl?
  > 2 levels deep (default - good for most sites)
    3 levels deep (catalogs, large sites)
    Just the seed pages (depth 0)
    Custom: ___

? Max pages?
  > 1000 (default)
    Custom: ___

? Does this site need special access?
  > No - public site
    Proxy server
    Cookies / logged-in session
    Both

? When AI proposes schema changes during crawling:
  > Balanced - auto-approve safe changes, ask about risky ones
    Trust AI - approve everything
    Cautious - ask about most changes
    Manual - review every change

--- Ready! -------------------------------------------

  Done: Created spatula.yaml
  Done: Created .spatula/

  Start crawling:  spatula run
  Test one page:   spatula test https://acme.com/products/item-1
  Estimate cost:   spatula estimate
```

### 3.3 Returning User Flow (global config exists)

Skips global setup, goes straight to project creation:

```
$ spatula init

  Done: Using global config (~/.spatula/config.yaml)

--- New Project --------------------------------------

? URL(s) to scrape:
  URL: ___

  ...project questions only...
```

### 3.4 Conversational Alternative: `spatula new`

`spatula new` opens the existing LLM-guided conversational mode (Phase 9a) but writes to `spatula.yaml` instead of creating an API job. The user describes what they want in natural language, and the LLM produces the config through dialogue.

Requires a configured LLM provider. If no LLM is configured, falls back to `spatula init` wizard with a message: `Conversational mode requires an LLM. Starting setup wizard instead.`

**When to use which:**
- `spatula init` -- recommended default. Works without AI, step-by-step guided, always available. The setup wizard completion screen suggests this as the primary path.
- `spatula new` -- for users who prefer natural language. Best when the user isn't sure what fields they need and wants the LLM to explore the target site with them.

The `spatula init` wizard's "What data are you looking for?" step includes "Describe in plain English" as an option, which seamlessly hands off to the `spatula new` conversational flow. This makes `spatula init` the single entry point that branches to conversational mode when appropriate, rather than two competing commands.

### 3.5 Reconfiguration: `spatula setup`

Interactive menu for changing global settings:

```
$ spatula setup

  Current config (~/.spatula/config.yaml):
    AI: Ollama / llama3.2:8b
    Crawler: playwright
    Remotes: prod, staging

? What would you like to change?
  > AI provider / model
    Default crawler
    Crawling defaults
    Manage remotes
    View full config
```

### 3.6 Generated Project File

`spatula init` produces a Tier 1 file with commented-out options for discoverability:

```yaml
seeds:
  - https://acme.com/products

# Uncomment and customize as needed:
#
# name: My Project
# depth: 2                    # how many links deep to crawl (0-10)
# limit: 1000                 # max pages to crawl
# crawler: playwright         # playwright or firecrawl
# safety: balanced            # trust_ai, balanced, cautious, manual
#
# fields:                     # define expected data fields
#   - product_name: string
#   - price: currency
#
# See: https://docs.spatula.dev/config for all options
```

---

## 4. Local Execution Pipeline

### 4.1 Architecture

A `LocalPipelineRunner` orchestrates the same `@spatula/core` functions that the server workers use, but sequentially in a single process with no queue infrastructure.

### 4.1.1 Prerequisite Refactoring: Extract Shared Pipeline Logic

The current BullMQ workers in `@spatula/queue` contain significant orchestration logic beyond just calling core functions:

- **crawl-worker.ts:** content dedup (SHA-256), page classification dispatch, inline extraction, schema evolution batch counting, link evaluation with priority mapping, child task enqueuing, error classification
- **schema-worker.ts:** distributed lock acquisition, extraction batch fetching, action persistence, schema version bumping
- **reconciliation-worker.ts:** extraction loading, page metadata enrichment, entity storage, job status transition
- **export-worker.ts:** entity count validation, format dispatch, content store write, metadata tracking

This logic is currently interleaved with BullMQ-specific concerns (job data parsing, queue references, Redis connections). The `LocalPipelineRunner` needs the same business logic without the queue dependencies.

**Required refactoring:** Extract the pure orchestration logic into shared functions in `@spatula/core`:

```
packages/core/src/pipeline/
  crawl-orchestrator.ts      # Content dedup, classify, extract, evaluate links
  schema-orchestrator.ts     # Batch check, evolve, apply actions, version bump
  reconcile-orchestrator.ts  # Load extractions, reconcile, store entities
  export-orchestrator.ts     # Validate, dispatch format, write output
```

Each orchestrator is a pure function that accepts repositories and core services via dependency injection:

```typescript
// Example: crawl-orchestrator.ts
export async function processCrawlTask(
  task: CrawlTask,
  deps: {
    crawler: Crawler;
    classifier: PageClassifier;
    extractor: Extractor;
    linkEvaluator?: LinkEvaluator;
    pageRepo: PageRepository;
    extractionRepo: ExtractionRepository;
    taskRepo: CrawlTaskRepository;
    contentStore: ContentStore;  // PgContentStore or local file store
  },
  config: CrawlConfig,
): Promise<CrawlTaskResult> {
  // Dedup check, crawl, classify, extract, evaluate links
  // Same logic currently in crawl-worker.ts, no BullMQ references
}
```

After refactoring:
- **BullMQ workers** become thin wrappers: parse job data, call orchestrator, update job status
- **LocalPipelineRunner** calls the same orchestrators directly in its crawl loop
- **Zero business logic duplication**

This refactoring is a Phase 13 prerequisite task. It does not change server-mode behavior -- the workers produce identical results, they just delegate to shared functions.

### 4.1.2 DataSource Abstraction for CLI Components

The existing CLI components (Explorer, Dashboard, Review) use hooks that communicate via HTTP API calls:

- `useJobPolling` -- polls `GET /api/v1/jobs/:id` every 3s
- `useWebSocket` -- streams via `ws://host/ws/jobs/:id/progress`
- `useEntityData` -- fetches `GET /api/v1/entities`
- `useEntityFilter` -- calls `GET /api/v1/entities?filter=...`
- `useExport` -- calls `POST /api/v1/exports`

In local mode, there is no API server. These hooks need to work against SQLite instead.

**Design:** Define a `DataSource` interface that both the API client and the SQLite project adapter implement:

```typescript
interface DataSource {
  // Entities
  getEntities(query: PaginationQuery): Promise<PaginatedResult<Entity>>;
  getEntity(id: string): Promise<Entity | null>;
  searchEntities(filter: string): Promise<Entity[]>;

  // Schema
  getSchema(): Promise<SchemaDefinition>;
  getSchemaVersions(): Promise<SchemaVersion[]>;

  // Actions
  getActions(status?: string): Promise<Action[]>;
  approveAction(id: string, reviewedBy?: string): Promise<void>;
  rejectAction(id: string, reviewedBy?: string): Promise<void>;

  // Job/project status
  getStatus(): Promise<ProjectStatus>;

  // Exports
  createExport(options: ExportOptions): Promise<ExportRecord>;
  getExport(id: string): Promise<ExportRecord>;
  downloadExport(id: string): Promise<string>;  // file path or content

  // Documentation
  getDocumentation(): Promise<Documentation>;

  // Real-time updates (optional)
  subscribe?(callback: (event: DataEvent) => void): () => void;
}
```

**Two implementations:**

```typescript
// Remote mode: wraps existing API client
class ApiDataSource implements DataSource {
  constructor(private client: ApiClient) {}
  async getEntities(query) { return this.client.listEntities(jobId, query); }
  subscribe(cb) { /* WebSocket connection */ }
}

// Local mode: wraps SQLite repositories
class LocalDataSource implements DataSource {
  constructor(private adapter: ProjectAdapter) {}
  async getEntities(query) { return this.adapter.entityRepo.findByJob(...); }
  subscribe(cb) { /* EventEmitter from LocalPipelineRunner */ }
}
```

**Real-time updates in local mode:** The `LocalPipelineRunner` emits events as it processes:

```typescript
interface PipelineEvents {
  'task:completed': (task: CrawlTask) => void;
  'entity:created': (entity: Entity) => void;
  'schema:evolved': (schema: SchemaDefinition) => void;
  'action:pending': (action: Action) => void;
  'progress': (stats: RunStats) => void;
}
```

The `LocalDataSource.subscribe()` method listens to these events and forwards them to the TUI hooks, providing the same real-time update experience as WebSocket in server mode.

**CLI hook adaptation:** Existing hooks are modified to accept a `DataSource` instead of an `ApiClient`:

```typescript
// Before (server-only):
function useEntityData(apiClient: ApiClient, jobId: string) { ... }

// After (mode-agnostic):
function useEntityData(dataSource: DataSource) { ... }
```

The TUI components don't change at all -- they render data from whatever source provides it. The mode selection happens at the top level (`App.tsx`) where either `ApiDataSource` or `LocalDataSource` is constructed and passed down.

### 4.2 Execution Flow

```
spatula run
  |
  +-- 1. Load & resolve config
  |     spatula.yaml + global defaults + CLI flags + env vars
  |
  +-- 2. Open SQLite DB (WAL mode for concurrent read access)
  |
  +-- 3. Acquire project lock (.spatula/run.lock)
  |     If locked: "Another spatula process is running (PID 12345)."
  |
  +-- 4. Crash recovery check
  |     Any tasks stuck in 'in_progress'? Reset to 'pending'
  |     (they were in-flight when the process died)
  |
  +-- 5. Config diff against last run snapshot
  |     +-- New seed URLs -> enqueue as new crawl tasks
  |     +-- Schema fields added -> flag existing pages for re-extraction
  |     +-- Schema fields removed -> drop from future extractions
  |     +-- Proxy/cookies changed -> retry failed tasks
  |     +-- robots.txt toggled off -> re-enqueue skipped tasks
  |     +-- Reconciliation strategy changed -> force full reconciliation
  |     +-- Show summary with re-extraction cost estimate, confirm
  |
  +-- 6. Determine work to do:
  |     +-- Pending crawl tasks (new + resumed + re-enqueued)
  |     +-- Pages flagged for re-extraction (schema changed)
  |     +-- Pending review actions from last run
  |         (remind: "3 pending actions - run `spatula review`")
  |
  +-- 7. Re-extraction pass (if flagged pages exist):
  |     +-- Only runs if this is a resume/subsequent run
  |     +-- Re-extract flagged pages with current schema
  |         (page HTML from .spatula/pages/, no re-crawl needed)
  |     +-- Handle missing page files gracefully:
  |         re-crawl those pages instead
  |     +-- Update extractions + clear flag
  |
  +-- 8. Crawl + extract loop:
  |     +-- Priority queue: tasks ordered by link relevance score
  |     |   (high=first, equal scores=breadth-first by depth)
  |     +-- Semaphore: up to `concurrency` tasks in parallel
  |     |
  |     |  for each task:
  |     |   +-- Check robots.txt (cached per-domain, 1hr TTL)
  |     |   +-- Wait for domain rate limit slot (in-memory per-domain)
  |     |   +-- Check page budget (atomic in-memory counter)
  |     |   +-- Crawl URL
  |     |   +-- Content dedup: SHA-256 hash check against pages table
  |     |   |   If duplicate: skip extraction, reuse content ref
  |     |   +-- Save HTML to .spatula/pages/{id}.html
  |     |   +-- Store page metadata in SQLite
  |     |   +-- Classify page (LLM)
  |     |   +-- Extract fields (LLM/static -> store extraction)
  |     |   +-- Evaluate links -> enqueue as new tasks with priority
  |     |   +-- Record LLM token usage + cost
  |     |   +-- Commit task status immediately (checkpoint)
  |     |
  |     +-- Error handling per-task:
  |     |   +-- Crawl timeout/network error -> retry up to 3x
  |     |   |   with exponential backoff (2s, 4s, 8s)
  |     |   +-- After max retries -> mark task 'failed', continue
  |     |   +-- LLM error -> circuit breaker (5 consecutive failures
  |     |   |   -> pause LLM calls for 30s, retry with half-open)
  |     |   |   If breaker stays open: skip LLM steps, log warning,
  |     |   |   continue crawling (extraction will be incomplete)
  |     |   +-- robots.txt blocked -> mark 'skipped', continue
  |     |
  |     +-- Completion detection:
  |         +-- All tasks completed/skipped/failed AND
  |         |   no new tasks enqueued in last batch -> natural completion
  |         +-- Page budget (maxPages) reached -> budget completion
  |         +-- User pause (space) or quit (Ctrl+C) -> checkpoint
  |
  +-- 9. Schema evolution (batched, every N extractions):
  |     +-- Propose field/normalization actions
  |     +-- Apply safety policy:
  |     |   +-- Auto-approved -> apply immediately to schema
  |     |   |   Flag previously-extracted pages for re-extraction
  |     |   |   (queued for NEXT run, not mid-crawl)
  |     |   +-- Manual-review -> queue in DB for `spatula review`
  |     +-- Bump schema version in DB
  |
  +-- 10. Reconciliation:
  |      +-- Entity count < 5,000 -> full reconciliation
  |      +-- Entity count >= 5,000 -> incremental
  |      +-- Override: --full-reconcile or --incremental
  |      +-- Match -> resolve conflicts -> store entities
  |
  +-- 11. Auto-export (if export.autoExport: true):
  |       Write to .spatula/exports/{timestamp}-{format}/
  |
  +-- 12. Run summary:
  |       +-- Pages crawled, entities created, schema fields
  |       +-- Errors/skipped, LLM cost for this run
  |       +-- Pending review actions (if any)
  |       +-- Send notification (desktop/webhook if configured)
  |
  +-- 13. Release project lock, close DB
```

### 4.3 Concurrency Model

The crawl loop runs with configurable concurrency using a simple in-memory semaphore. With `concurrency: 5`, up to 5 pages are crawled simultaneously via `Promise.allSettled` batches, respecting per-domain rate limits (also in-memory, no Redis needed). Single process, single project.

### 4.4 Checkpoint & Resume

After each page completes (crawl + extract), the crawl task status is updated in SQLite immediately. If the user hits Ctrl+C:

1. Graceful shutdown handler fires
2. Waits for in-flight pages to finish (up to 10s timeout)
3. Marks any remaining in-flight tasks as `pending` (not `failed`)
4. Saves a run record with `status: paused`
5. Releases project lock
6. Prints: `Paused at 347/2000 pages. Run 'spatula run' to continue.`

On next `spatula run`, crash recovery resets any orphaned `in_progress` tasks (from hard crashes where shutdown handler didn't run), then the pipeline continues from where it left off.

### 4.5 Progress Display

**Compact mode (default):**

```
  Acme Products -- crawling
  ############-------- 347/2000 pages | 892 entities | 12 fields
  Current: https://acme.com/products/page-8 (2.1s)
  Speed: ~3.2 pages/sec | Cost: $0.24 | Errors: 2

  [d] dashboard  [q] quit  [space] pause
```

**Dashboard mode (press `d`):** Expands to the full multi-panel TUI (progress panel, schema panel, activity feed, entity preview). Same components as the existing Dashboard mode but fed by the local crawl instead of WebSocket/polling. Press `q` or `Esc` to return to compact view.

**Pause (press `space`):** Finishes current in-flight pages, then waits. Press `space` again to resume. Useful for inspecting results mid-crawl without losing state.

### 4.6 Re-Extraction Concurrency

The re-extraction pass (step 7) reuses the same semaphore and concurrency setting as the crawl loop. Re-extraction is I/O-light (reads HTML from disk, calls LLM, writes to SQLite) so the configured concurrency applies well. The domain rate limiter is NOT used during re-extraction since no network requests are made.

### 4.7 Logs

Each run writes a structured JSON log file to `.spatula/logs/{timestamp}.log`. Log entries use the same Pino format as the server (structured JSON in production, pretty-printed in development).

**Log entries include:** crawl task starts/completions, extraction results, schema evolution actions, reconciliation decisions, LLM call durations/costs, errors with stack traces.

**`spatula logs` command:** Pretty-prints the latest run's log. `--run <id>` shows a specific run. `--errors` filters to error entries only. `--tail` follows the log in real-time during an active run.

**"Latest" determination:** Most recent run by `started_at` regardless of status.

### 4.8 Push Without Prior Run

`spatula push` works even if no `spatula run` has been executed. The push only needs a valid `spatula.yaml` -- it doesn't require local crawl state. This supports the workflow: `spatula init` -> `spatula push prod` (skip local, go straight to hosted).

### 4.9 Review Workflow

Schema evolution uses the existing safety policy system (Phase 11b). Default is `balanced`:

- **Auto-approved** (low risk): `classify_page`, `enqueue_links`, `add_field` (optional), `set_normalization_rule` (high confidence)
- **Queued for review** (high risk): `remove_field`, `merge_fields`, `rename_field`, `split_field`

After a crawl completes or pauses with pending actions:

```
$ spatula review

  3 pending actions for Acme Products

  Action 1/3: Add field 'availability' (string)
  Evidence: found in 89% of product pages
  Confidence: 0.92
  [y] approve  [n] reject  [s] skip  [d] details

  > y

  Action 2/3: Merge fields 'colour' -> 'color'
  Evidence: same values in 95% of overlapping entities
  [y] approve  [n] reject  [s] skip  [d] details

  > y

  ...

  Done: 2 approved, 1 rejected. 847 pages flagged for re-extraction.
  Run `spatula run` to re-extract with updated schema.
```

Re-extraction on next `spatula run` uses stored HTML from `.spatula/pages/` -- no re-crawling needed. If page files are missing, those pages are re-crawled instead.

---

## 5. SQLite Schema & Repository Layer

### 5.1 Schema Design Philosophy

The local SQLite schema mirrors the 9 core Postgres tables (minus `tenant_id`) and adds 2 local-specific tables. It drops 5 infrastructure tables not needed for single-user local use.

### 5.2 Type Adaptations

| Postgres Type | SQLite Adaptation |
|---------------|-------------------|
| `UUID DEFAULT gen_random_uuid()` | `TEXT PRIMARY KEY` (generated via `crypto.randomUUID()` in JS) |
| `JSONB` | `TEXT` (JSON serialized, parsed in application layer) |
| Custom ENUMs (8 types) | `TEXT` with `CHECK` constraints |
| `text[]` (array) | `TEXT` (JSON-encoded array) |
| `bytea` | `BLOB` |
| `TIMESTAMP WITH TIME ZONE` | `TEXT` (ISO 8601 format) |
| GIN index | Standard B-tree index |

### 5.3 Tables Kept (Adapted from Postgres)

All tables drop `tenant_id`. The `job_id` column is retained and always set to a synthetic project ID (see section 5.6).

**Important:** The SQLite DDL below is illustrative. The authoritative schemas are generated by the codegen script (section 5.10) from the Postgres Drizzle definitions. The codegen ensures exact column parity (minus `tenant_id`). The examples show the shape and local-only extensions.

**Local-only extensions** added by codegen to specific tables (not in Postgres):
- `pages`: `content_path TEXT` (path to HTML file on disk), `needs_reextraction INTEGER DEFAULT 0`, `reextraction_reason TEXT`
- `crawl_tasks`: `priority_score REAL DEFAULT 0.5` (numeric relevance score for priority queue ordering), `attempts INTEGER DEFAULT 0`, `error_message TEXT`

**Enum value mapping:** SQLite CHECK constraints use the exact same values as the Postgres enums defined in `packages/db/src/schema/enums.ts`:
- `crawl_task_status`: `pending`, `in_progress`, `completed`, `failed`, `skipped`
- `task_priority`: `critical`, `high`, `medium`, `low`
- `page_classification`: `product`, `category`, `listing`, `article`, `navigation`, `other`
- `crawler_type`: `playwright`, `firecrawl`
- `action_source`: `extraction`, `schema_evolution`, `reconciliation`, `quality_audit`
- `action_status`: `pending_review`, `approved`, `applied`, `rejected`, `rolled_back`
- `trust_level`: `authoritative`, `high`, `medium`, `low`
- `job_status`: not used locally (no `jobs` table)

**Key tables (illustrative, see codegen for authoritative DDL):**

**pages** -- crawled page metadata (HTML stored on disk)

```sql
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  url TEXT NOT NULL,
  content_hash TEXT,
  content_ref TEXT,                      -- Postgres: points to content_store
  content_path TEXT,                     -- LOCAL EXTENSION: relative path to .spatula/pages/
  status_code INTEGER,
  title TEXT,
  classification TEXT CHECK (classification IN (
    'product','category','listing','article','navigation','other'
  )),
  metadata TEXT DEFAULT '{}',
  needs_reextraction INTEGER DEFAULT 0,  -- LOCAL EXTENSION
  reextraction_reason TEXT,              -- LOCAL EXTENSION
  crawled_at TEXT NOT NULL
);
CREATE INDEX idx_pages_content_hash ON pages(content_hash);
CREATE INDEX idx_pages_reextraction ON pages(needs_reextraction)
  WHERE needs_reextraction = 1;
```

**entities** -- reconciled entities with provenance

```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  categories TEXT DEFAULT '[]',          -- Postgres: text[], SQLite: JSON array
  merged_data TEXT NOT NULL DEFAULT '{}',
  provenance TEXT DEFAULT '{}',
  quality_score REAL,
  source_count INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_entities_quality ON entities(quality_score DESC);
```

**entity_sources** -- links entities to extractions

```sql
CREATE TABLE entity_sources (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  extraction_id TEXT NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
  match_confidence REAL NOT NULL,        -- from Postgres schema
  PRIMARY KEY (entity_id, extraction_id)
);
```

**extractions** -- per-page extraction results

```sql
CREATE TABLE extractions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}',            -- from Postgres schema
  unmapped_fields TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_extractions_page ON extractions(page_id);
```

**schemas** -- versioned schema definitions

```sql
CREATE TABLE schemas (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_id TEXT REFERENCES schemas(id), -- from Postgres: schema lineage
  definition TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_schemas_job_version ON schemas(job_id, version);
```

**crawl_tasks** -- per-URL crawl status

```sql
CREATE TABLE crawl_tasks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  parent_task_id TEXT REFERENCES crawl_tasks(id),  -- from Postgres
  url TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','in_progress','completed','failed','skipped'
  )),
  priority TEXT DEFAULT 'medium' CHECK (priority IN (
    'critical','high','medium','low'
  )),
  priority_score REAL DEFAULT 0.5,       -- LOCAL EXTENSION
  classification TEXT,
  crawler_type TEXT,
  metadata TEXT DEFAULT '{}',
  error_message TEXT,                    -- LOCAL EXTENSION
  attempts INTEGER DEFAULT 0,           -- LOCAL EXTENSION
  content_ref TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  completed_at TEXT                      -- LOCAL EXTENSION
);
CREATE INDEX idx_crawl_tasks_status ON crawl_tasks(status, priority_score DESC);
```

**actions** -- schema evolution proposals

```sql
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'extraction','schema_evolution','reconciliation','quality_audit'
  )),
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN (
    'pending_review','approved','applied','rejected','rolled_back'
  )),
  payload TEXT NOT NULL DEFAULT '{}',
  confidence REAL,
  reasoning TEXT,
  state_changes TEXT DEFAULT '{}',
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX idx_actions_status ON actions(status)
  WHERE status = 'pending_review';
```

**source_trust** -- trust scoring

```sql
CREATE TABLE source_trust (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  trust_level TEXT DEFAULT 'medium' CHECK (trust_level IN (
    'authoritative','high','medium','low'
  )),
  score REAL,
  created_at TEXT NOT NULL
);
```

### 5.4 Tables Dropped (Not Needed Locally)

| Table | Reason |
|-------|--------|
| `tenants` | Single user, single project |
| `jobs` | Replaced by `runs` table |
| `content_store` | Page content stored as files on disk |
| `api_keys` | No auth locally |
| `audit_log` | No audit locally |
| `dead_letter_queue` | No queue system locally |
| `usage_records` | Billing only |
| `user_tenants` | Hosted only |

### 5.5 Tables Added (Local-Specific)

**runs** -- tracks each invocation of `spatula run`

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'running','paused','completed','failed','pulled'
  )),
  source TEXT NOT NULL DEFAULT 'local',
  config_snapshot TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  pages_crawled INTEGER DEFAULT 0,
  pages_reextracted INTEGER DEFAULT 0,
  entities_created INTEGER DEFAULT 0,
  llm_tokens_used INTEGER DEFAULT 0,
  llm_cost_usd REAL DEFAULT 0,
  error_message TEXT
);
```

The `source` column distinguishes local runs from pulled data: `'local'` for crawl runs, `'remote:<name>:<jobId>'` for pull operations.

**llm_usage** -- per-call LLM cost tracking

```sql
CREATE TABLE llm_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_llm_usage_run ON llm_usage(run_id);
CREATE INDEX idx_llm_usage_created ON llm_usage(created_at);
```

**exports** -- tracks generated export files

```sql
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  format TEXT NOT NULL,
  file_path TEXT NOT NULL,
  entity_count INTEGER,
  file_size INTEGER,
  include_provenance INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
```

**project_meta** -- key-value store for project state

```sql
CREATE TABLE project_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Used for: `project_id` (synthetic UUID), `schema_version` (DB schema version for migrations), `name`, `created_at`, remote job links (`remote:prod:job_id`, `remote:prod:pushed_at`, `remote:prod:config_hash`), pull cursors (`pull:prod:cursor`).

### 5.6 Synthetic Project ID and Tenant ID

On `spatula init`, two stable UUIDs are generated and stored in `project_meta`:
- `project_id` -- used as the `job_id` value in all local tables
- `synthetic_tenant_id` -- used to satisfy `JobConfig.tenantId` (required by Zod validation)

All tables use `project_id` as their `job_id` value. The `synthetic_tenant_id` is injected into `JobConfig` by the config parser so that core engine functions (which validate `tenantId` as required UUID) work without modification. The tenant ID has no functional meaning locally -- it exists purely for type compatibility.

```typescript
// In LocalPipelineRunner, when building JobConfig:
const jobConfig = yamlToJobConfig(spatulaYaml, {
  tenantId: projectAdapter.getMeta('synthetic_tenant_id'),
  jobId: projectAdapter.getMeta('project_id'),
});
```

This avoids modifying the `JobConfig` Zod schema (which would affect all server-side validation) while keeping local mode fully compatible.

### 5.7 Repository Layer

**Adapter pattern -- no interface changes to existing repos:**

```typescript
class ProjectAdapter {
  private projectId: string;

  constructor(private db: SqliteDatabase) {
    this.projectId = this.getProjectMeta('project_id');
  }

  get entityRepo(): EntityRepository {
    return new SqliteEntityRepository(this.db, this.projectId);
  }

  get schemaRepo(): SchemaRepository {
    return new SqliteSchemaRepository(this.db, this.projectId);
  }

  get extractionRepo(): ExtractionRepository {
    return new SqliteExtractionRepository(this.db, this.projectId);
  }
  // ... all other repos
}
```

Each SQLite repository implements the same interface as its Postgres counterpart. The `tenantId` parameter is accepted but ignored. The `jobId` is pre-bound to the synthetic project ID.

```typescript
class SqliteEntityRepository implements EntityRepository {
  constructor(private db: SqliteDatabase, private projectId: string) {}

  async findByJob(jobId: string, tenantId?: string): Promise<Entity[]> {
    return this.db.select().from(entities)
      .where(eq(entities.jobId, this.projectId));
  }
}
```

The core engine receives repositories through dependency injection and never knows whether it's talking to Postgres or SQLite.

### 5.8 SQLite Connection Setup

```typescript
function createProjectDb(dbPath: string): BetterSqlite3Database {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  return drizzle(sqlite, { schema: sqliteSchema });
}
```

WAL mode enables concurrent readers (e.g., `spatula explore` in another terminal) while the crawl is writing.

### 5.9 Schema Creation Strategy

No versioned migrations for the local SQLite DB. Tables are created in one shot on first use:

```typescript
if (!existsSync(dbPath)) {
  const db = createProjectDb(dbPath);
  db.run(CREATE_ALL_TABLES_SQL);
  insertProjectMeta(db, 'schema_version', '1');
  insertProjectMeta(db, 'project_id', crypto.randomUUID());
}
```

On future Spatula versions that change the local schema, `spatula run` detects the version mismatch:

```
Project DB was created with Spatula v1.2. Current version is v1.5.
  > Migrate (update DB schema, keep data)
    Reset (fresh start, data will be lost)
    Cancel
```

### 5.10 Schema Codegen (Build-Time)

To prevent SQLite schema drift from Postgres, a build-time script generates the SQLite schema from Postgres Drizzle definitions:

**New file:** `packages/db/scripts/generate-sqlite-schema.ts`

```
Input:  packages/db/src/schema/*.ts (Postgres Drizzle tables)
Output: packages/db/src/schema-sqlite/*.ts (SQLite Drizzle tables)

Transforms:
  pgTable -> sqliteTable
  uuid().defaultRandom() -> text()
  jsonb() -> text()
  pgEnum values -> text() + CHECK constraint
  text('col').array() -> text() (JSON-encoded)
  timestamp({ withTimezone: true }) -> text()
  Drops: tenant_id columns
  Preserves: column names, relationships, indexes
```

Runs as part of the build (`turbo run build`). CI fails if generated files differ from committed files (ensures schema parity). Developers only maintain the Postgres schema -- the SQLite variant is derived.

Local-only tables (`runs`, `llm_usage`, `exports`, `project_meta`) are hand-written (no Postgres equivalent to derive from).

### 5.11 File Organization

```
packages/db/src/
  schema/                   # Existing Postgres schemas (unchanged)
    tenants.ts
    jobs.ts
    entities.ts
    ...
  schema-sqlite/            # Generated + hand-written SQLite schemas
    entities.ts             # GENERATED from schema/entities.ts
    pages.ts                # GENERATED from schema/raw-pages.ts
    crawl-tasks.ts          # GENERATED
    extractions.ts          # GENERATED
    schemas.ts              # GENERATED
    actions.ts              # GENERATED
    source-trust.ts         # GENERATED
    entity-sources.ts       # GENERATED
    runs.ts                 # HAND-WRITTEN (local-only)
    llm-usage.ts            # HAND-WRITTEN (local-only)
    exports.ts              # HAND-WRITTEN (local-only)
    project-meta.ts         # HAND-WRITTEN (local-only)
  repositories/             # Existing Postgres repos (unchanged)
  project-db/               # New: SQLite connection + repos
    connection.ts           # createProjectDb()
    adapter.ts              # ProjectAdapter (repo factory)
    repositories/           # SQLite implementations
      entity-repository.ts
      schema-repository.ts
      extraction-repository.ts
      page-repository.ts
      crawl-task-repository.ts
      action-repository.ts
      source-trust-repository.ts
      run-repository.ts
      llm-usage-repository.ts
      export-repository.ts
```

---

## 6. Config Diff Engine

### 6.1 Purpose

Detects changes between the current `spatula.yaml` and the last run's config snapshot, determines what work needs to happen, and presents the impact to the user for confirmation.

### 6.2 When It Runs

At the start of every `spatula run`, before any crawling begins. On the first run (no previous snapshot), no diff -- everything is fresh. The config snapshot is saved to the `runs` table as `config_snapshot` JSON at the start of each run.

**Baseline selection rule:** The diff compares against the most recent run with `status IN ('completed', 'paused')`, not failed runs. Failed runs may represent broken configs that the user is fixing -- diffing against a failed config would show spurious changes on every subsequent run. If no completed/paused run exists, it's treated as a first run (no diff).

### 6.3 Diff Structure

```typescript
interface ConfigDiff {
  // Seeds
  seedsAdded: string[];
  seedsRemoved: string[];

  // Schema fields
  fieldsAdded: FieldDefinition[];
  fieldsRemoved: string[];
  fieldsModified: FieldChange[];
  fieldsRenamed: { from: string; to: string }[];
  schemaModeChanged?: { from: string; to: string };

  // Crawl settings
  crawlChanged: {
    maxDepth?: { from: number; to: number };
    maxPages?: { from: number; to: number };
    concurrency?: { from: number; to: number };
    crawlerType?: { from: string; to: string };
    proxyChanged: boolean;
    cookiesChanged: boolean;
    robotsTxtToggled?: { from: boolean; to: boolean };
  };

  // Other
  llmChanged: boolean;
  reconciliationChanged: boolean;
  safetyChanged: boolean;

  // Derived work
  impact: {
    newTasksToEnqueue: number;
    pagesNeedingReextraction: number;
    reextractionCostEstimate: number;
    failedTasksToRetry: number;
    skippedTasksToReenqueue: number;
    forceFullReconciliation: boolean;
  };
}
```

### 6.4 Actions Derived from Changes

| Change | Action |
|--------|--------|
| Seeds added | Enqueue as new crawl tasks at depth 0 |
| Seeds removed | No action (already-crawled data stays) |
| Fields added | Flag all completed pages for re-extraction |
| Fields removed | No action (drop from future extractions, keep historical data) |
| Field type changed | Flag pages for re-extraction |
| Field selector changed | Flag pages for re-extraction |
| maxDepth increased | Re-evaluate links from pages at old max depth, enqueue at new depths |
| maxDepth decreased | No action on existing data. Entities from deeper pages remain in DB and appear in exports. The diff summary notes this: "Depth reduced to 2. 143 entities from depth 3-4 will remain in results. Use `spatula reset --keep-exports` for a clean re-crawl." |
| maxPages changed | Applied to the budget counter going forward |
| concurrency changed | Applied immediately to semaphore |
| crawlerType changed | Applied to new tasks only |
| Proxy/cookies added or changed | Retry all `failed` crawl tasks |
| Proxy/cookies removed | No action |
| robots.txt toggled OFF | Re-enqueue all tasks skipped for robots.txt |
| robots.txt toggled ON | No action (future crawls check robots.txt) |
| Schema mode fixed -> hybrid/discovery | Enable evolution going forward |
| Schema mode hybrid/discovery -> fixed | Freeze current schema, disable evolution |
| Reconciliation strategy changed | Force full re-reconciliation regardless of entity count |
| LLM model changed | Applied to new LLM calls only (no re-extraction) |
| Safety preset changed | Applied immediately |
| Config section removed | Revert to built-in defaults |

### 6.5 Field Rename Detection

When a field is removed and a field is added in the same diff with the same type, prompt:

```
  Schema:
    - product_name (string) -- removed
    + name (string) -- added

  Is 'name' a rename of 'product_name'? (Y/n)
    -> If yes: rename in schema, preserve historical data linkage
    -> If no: treat as remove + add (flag for re-extraction)
```

### 6.6 URL Normalization

Before comparing seeds, normalize by:
- Removing trailing slashes
- Lowercasing the hostname
- Sorting query parameters
- Removing default ports (`:80`, `:443`)
- Removing fragments (`#section`)

### 6.7 User Confirmation

```
$ spatula run

  Config changes detected since last run:

    Seeds:
      + https://acme.com/sale-items (new)

    Schema:
      + availability (string) -- new field
      ~ price: selector changed ".old-price" -> ".price-current"

    Crawl:
      depth: 2 -> 3
      proxy: added socks5://127.0.0.1:1080
      -> 4 previously-failed tasks will be retried

    Impact:
      -> 1 new seed URL to crawl
      -> 847 pages flagged for re-extraction
      -> Estimated re-extraction cost: ~$1.40 (or $0.00 with Ollama)
      -> Deeper links will be discovered from existing pages

  Proceed? (Y/n)
```

On first run, no diff is shown. On resume with no config changes, no diff is shown.

---

## 7. Command Structure

### 7.1 Project Lifecycle

| Command | Description | Requires project? |
|---------|-------------|-------------------|
| `spatula init [url]` | Setup wizard (global + project) | No -- creates one |
| `spatula new` | Conversational mode (LLM-guided) | No -- creates one |
| `spatula run` | Start/resume crawling | Yes |
| `spatula status` | Show project state, run history, pending work | Yes |
| `spatula reset` | Clear `.spatula/` with confirmation. Flags: `--keep-exports` (preserve export files), `--keep-entities` (preserve entities + extractions + entity_sources but clear crawl tasks + pages), `--keep-remote` (preserve pulled remote data, clear local crawl data). Flags can be combined. | Yes |

### 7.2 Data Interaction

| Command | Description | Requires project? |
|---------|-------------|-------------------|
| `spatula explore` | Browse/filter/sort entities (TUI) | Yes |
| `spatula export [--format]` | Export results to file | Yes |
| `spatula review` | Approve/reject pending schema actions | Yes |
| `spatula schema` | View current schema (fields, versions, evolution history) | Yes |
| `spatula logs [--run id]` | View run logs, defaults to latest | Yes |
| `spatula test <url>` | Single-page test extraction (no DB needed). Outside a project with no LLM configured: falls back to static extraction with auto-detected CSS selectors and prints a hint to configure an LLM for better results. | No (uses project schema if inside one) |
| `spatula estimate` | Cost estimation | Yes (reads config) |

### 7.3 Project Modification

| Command | Description |
|---------|-------------|
| `spatula add <url> [url...]` | Add seed URLs (deduplicated against existing seeds and crawl history), enqueued on next run |
| `spatula config` | Open `spatula.yaml` in `$EDITOR` |

### 7.4 Remote Operations

| Command | Description |
|---------|-------------|
| `spatula remote add <name> [url]` | Configure a remote (interactive if url omitted) |
| `spatula remote list` | List configured remotes with linked job status |
| `spatula remote remove <name>` | Remove a remote configuration |
| `spatula remote status <name>` | Show linked job status on that remote |
| `spatula remote jobs <name>` | List all jobs on a remote |
| `spatula remote start <name>` | Start the linked job |
| `spatula remote pause <name>` | Pause the linked job |
| `spatula remote resume <name>` | Resume the linked job |
| `spatula remote cancel <name>` | Cancel the linked job |
| `spatula remote watch <name>` | Live dashboard of remote job (WebSocket) |
| `spatula remote link <name> <jobId>` | Manually link to an existing remote job |
| `spatula remote unlink <name>` | Remove the link (keeps remote job running) |
| `spatula push [remote]` | Push config to hosted, create + optionally start job |
| `spatula pull [remote]` | Pull results from hosted into local project |

### 7.5 System

| Command | Description | Requires project? |
|---------|-------------|-------------------|
| `spatula setup` | Reconfigure global settings (interactive) | No |
| `spatula doctor` | System health checks (context-aware, see below) | No (extra checks if inside project) |

**`spatula doctor` checks:**

Global (always):
- `~/.spatula/config.yaml` exists and is valid (schema version check)
- LLM provider reachable (Ollama: `GET /api/tags`, OpenRouter: key validation)
- Playwright browsers installed (if crawler=playwright)
- Node.js version >= 22
- Docker available (optional, for self-hosted server mode)

Project-level (when inside a project):
- `spatula.yaml` is valid (parses against config schema)
- `.spatula/project.db` integrity (`PRAGMA integrity_check`)
- SQLite WAL mode active
- Orphaned `in_progress` crawl tasks (indicates prior crash)
- Missing page files needed for pending re-extraction
- Pending review actions count
- Disk usage breakdown (pages, DB, exports)
- Remote link status (if remotes configured: verify connectivity) |

### 7.6 Context Awareness

Commands detect the project root by walking up directories looking for `spatula.yaml`.

- Inside a project: project commands work, `spatula status` shows local state
- Outside a project: project commands fail with `Not in a Spatula project. Run 'spatula init' to create one.`
- `spatula test <url>` works anywhere but uses project schema if inside one

### 7.7 Legacy Command Migration

Existing server-centric commands are subsumed:

| Old Command | New Equivalent |
|-------------|---------------|
| `spatula list` | `spatula remote jobs <name>` |
| `spatula status <jobId>` | `spatula remote status <name>` |
| `spatula new` (API job creation) | `spatula new` (writes `spatula.yaml` instead) |

---

## 8. Remote Operations & Hosted Integration

### 8.1 Remote Configuration

Remotes are configured via `spatula remote add` and stored in `~/.spatula/config.yaml`:

```
$ spatula remote add prod

? Server URL: https://api.spatula.dev
? API key: sk_live_****
  Verifying... connected (plan: starter, 47/50 jobs this month)
  Done: Remote 'prod' saved to ~/.spatula/config.yaml
```

### 8.2 Push Flow

`spatula push` uploads the project config (not data) to a remote server, creating a server-side job.

```
$ spatula push prod

  Pushing config to prod (https://api.spatula.dev)...
  Done: Job created: job_8f2a1b
  Start crawling now? (Y/n): y
  Done: Job started on prod
```

**What's pushed:** The `spatula.yaml` config, transformed to `JobConfig` format. No local entities, pages, or extractions.

**What's tracked locally:** The remote job link is stored in `project_meta`:

```sql
INSERT INTO project_meta VALUES ('remote:prod:job_id', 'job_8f2a1b');
INSERT INTO project_meta VALUES ('remote:prod:pushed_at', '2026-03-21T14:32:00Z');
INSERT INTO project_meta VALUES ('remote:prod:config_hash', 'sha256:abc...');
```

**Re-push after config changes:**

```
$ spatula push prod

  Config changed since last push.
  Previous job: job_8f2a1b (running, 73%)

  > Cancel old job and create new one
    Keep old job running, create a new one alongside it
    Cancel push

  Done: job_8f2a1b cancelled
  Done: New job created: job_c4e9f2
  Start crawling now? (Y/n): y
```

The default option cancels the old job to avoid consuming quota. Users who want parallel jobs (e.g., comparing configs) can choose to keep both running.

### 8.3 Remote Job Control

All remote control commands act on the linked job for that remote:

```
$ spatula remote status prod

  Acme Products (job_c4e9f2) on prod
  -----------------------------------
  Status: running
  Pages:  1,847 / 2,000
  Entities: 1,203
  Schema: 14 fields (v3)
  Started: 12 minutes ago
  Est. completion: ~3 minutes

$ spatula remote watch prod
  # Opens live dashboard TUI via WebSocket

$ spatula remote pause prod
  Done: Job paused on prod

$ spatula remote resume prod
  Done: Job resumed on prod
```

### 8.4 Remote List

Shows all configured remotes and their linked job status:

```
$ spatula remote list

  Name     URL                            Linked Job    Status
  prod     https://api.spatula.dev        job_c4e9f2    running (73%)
  staging  https://staging.spatula.dev    --            not linked
```

---

## 9. Data Pull Flow

### 9.1 What Gets Pulled

| Data | Pulled? | Notes |
|------|---------|-------|
| Entities (data, provenance, quality) | Yes | Core output |
| Schema (current + history) | Yes | Needed for explore/export |
| LLM usage | Yes | Cost visibility |
| Extractions | Optional | `--include-extractions` flag |
| Actions history | Optional | `--include-actions` flag |
| Pages / raw HTML | No | Too large, not needed locally |
| Crawl tasks | No | Execution state only |

### 9.2 Pull Flow

```
spatula pull prod
  |
  +-- 1. Resolve remote: prod -> url + apiKey + linked job
  +-- 2. Check job status (warn if still running)
  +-- 3. Check for interrupted previous pull (resume from cursor)
  +-- 4. Fetch remote schema -> compare with local
  |     +-- If conflict: prompt (use remote / keep local / merge)
  |     +-- Update spatula.yaml if schema changed
  |        (append discovered fields with comment)
  +-- 5. Fetch entities (paginated, cursor-based, resumable):
  |     +-- Transform: strip tenant_id, map job_id -> project_id
  |     +-- Tag: run.source = 'remote:prod:job_c4e9f2'
  |     +-- Upsert: update if entity ID exists, insert if new
  |     +-- Save cursor after each batch (checkpoint)
  +-- 6. Fetch LLM usage summary -> write to local DB
  +-- 7. Create pull-run record (status: 'pulled')
  +-- 8. Clear cursor from project_meta (pull complete)
  +-- 9. Summary
```

### 9.3 Schema Conflict Resolution

When the remote schema differs from local:

```
Remote schema (v7, 18 fields) differs from local (v3, 12 fields).
Remote has 6 additional fields: availability, brand, sku, weight, ...

  > Use remote schema (recommended - learned from more data)
    Keep local schema
    Merge (keep all fields from both)
```

If "Use remote" or "Merge" is chosen, discovered fields are appended to `spatula.yaml`:

```yaml
fields:
  - product_name: string
  - price: currency
  - description: string
  # Discovered by remote crawl (2026-03-21):
  - availability: string
  - brand: string
  - sku: string
```

### 9.4 Pull API Contract

The pull flow requires a cursor-based pagination endpoint on the hosted API. This is a cross-phase dependency with Phase 12:

**Required endpoint (Phase 12 must expose):**

```
GET /api/v1/jobs/:jobId/entities/stream?cursor=<opaque>&limit=100&since=<iso8601>
```

- `cursor`: opaque base64-encoded token (contains `{id, createdAt}` for keyset pagination)
- `limit`: batch size (default 100, max 500)
- `since`: ISO 8601 timestamp for incremental pulls (only entities created/updated after this time)
- Ordering: `created_at ASC, id ASC` (stable for keyset pagination)

**Response:**

```json
{
  "data": [...entities...],
  "pagination": {
    "nextCursor": "eyJpZCI6...",
    "hasMore": true,
    "total": 6100
  }
}
```

The cursor-based pagination endpoint from Phase 12 section 6.5 satisfies this requirement. The `since` parameter is an addition needed for incremental pulls.

### 9.5 Incremental Pull

If the project already has pulled data, `spatula pull` fetches only entities created after the last pull timestamp. `--full` forces a complete re-pull (clears previously-pulled entities first).

### 9.5 Pull from Running Job

```
Job job_c4e9f2 is still running (73% complete, 4,500 entities so far).
  > Pull current snapshot (can pull again later for more)
    Wait for completion (polls every 30s)
    Cancel
```

### 9.6 Partial Pull Recovery

Pull cursor is tracked in `project_meta`. If a pull is interrupted (network failure), the next `spatula pull` resumes from the last saved cursor. `--restart` forces a fresh pull.

### 9.7 Local + Remote Entity Coexistence

Pulled entities and locally-crawled entities coexist in the same `entities` table, distinguished by their `run_id` which links to a `runs` record with a `source` field (`'local'` vs `'remote:prod:job_c4e9f2'`).

- `spatula explore` shows all entities by default
- Filter by source: toggle in explorer TUI (all / local / remote)
- Pulled entities are NOT flagged for re-extraction (no local HTML available)
- If schema changes and user wants updated remote data: `spatula push` again for a fresh remote crawl, then `spatula pull`

---

## 10. Safety & Edge Cases

### 10.1 Concurrent Run Protection

A PID lockfile at `.spatula/run.lock` prevents two `spatula run` processes on the same project:

```
Another spatula process is running (PID 12345).
Wait for it to finish, or run `spatula run --force` to take over.
```

`--force` kills the stale process (if PID is no longer running, the lock is considered stale and automatically acquired).

### 10.2 Crash Recovery

On startup, `spatula run` checks for tasks stuck in `in_progress` status. These indicate a previous crash (graceful shutdown would have reset them to `pending`). All `in_progress` tasks are reset to `pending` with their `attempts` counter preserved.

### 10.3 Missing Page Files

If `.spatula/pages/` files are deleted (user cleanup, corruption), operations that need HTML content handle it gracefully:

- **Re-extraction:** Missing pages are re-crawled instead of re-extracted
- **Normal crawl:** No impact (page files are written fresh)
- **Status check:** `spatula doctor` reports missing page files if re-extraction is pending

### 10.4 Disk Space

For large crawls, page files can accumulate significant disk space. `spatula status` shows disk usage:

```
  Storage: 234 MB
    Pages: 198 MB (2,047 files)
    Database: 32 MB
    Exports: 4 MB
```

`spatula reset --keep-exports --keep-entities` clears page files and crawl tasks while preserving extracted entities and exports (the most valuable data).

### 10.5 SQLite Integrity

`spatula doctor` runs `PRAGMA integrity_check` on the project database:

```
  Done: .spatula/project.db healthy (PRAGMA integrity_check: ok)
```

If corruption is detected:

```
  FAIL: .spatula/project.db integrity check failed
  Run 'spatula reset' to create a fresh database.
  Exports in .spatula/exports/ are unaffected.
```

### 10.6 Concurrent Read Access

SQLite WAL mode allows concurrent readers while a crawl is writing. `spatula explore`, `spatula status`, `spatula export`, and `spatula schema` can all run in separate terminals while `spatula run` is active. Readers see a consistent snapshot that updates as new entities are committed.

### 10.7 Re-extraction Cost Visibility

The config diff summary includes estimated re-extraction cost using the Phase 12 cost estimator:

```
  Impact:
    -> 847 pages flagged for re-extraction
    -> Estimated cost: ~$1.40 (anthropic/claude-sonnet-4) or $0.00 (Ollama)
```

This prevents surprise costs when editing `spatula.yaml`.

### 10.8 Desktop Notifications

For local long-running crawls, desktop notifications via `node-notifier`:

```yaml
# spatula.yaml
notify:
  desktop: true
```

Fires an OS-native notification when a crawl completes, fails, or requires review actions. More natural than webhooks for local use (the user isn't watching the terminal).

**Headless environments:** Desktop notifications are silently skipped when `process.env.CI` is set, when running in a Docker container (no display server), or when `node-notifier` fails to detect a notification backend. No error thrown -- the notification is simply a no-op.

---

## 11. Implementation Steps

This spec is designed to be implemented in 6 discrete steps, each independently plannable and deliverable. Each step produces a working, testable increment. Later steps depend on earlier ones but can each have their own implementation plan.

### Step 1: Prerequisite Refactoring -- Extract Shared Pipeline Orchestrators

**Goal:** Extract business logic from BullMQ workers into pure, reusable orchestrator functions in `@spatula/core`. This is a refactoring of existing code with zero behavior change.

**Scope:**
- Create `packages/core/src/pipeline/crawl-orchestrator.ts` (from `crawl-worker.ts`)
- Create `packages/core/src/pipeline/schema-orchestrator.ts` (from `schema-worker.ts`)
- Create `packages/core/src/pipeline/reconcile-orchestrator.ts` (from `reconciliation-worker.ts`)
- Create `packages/core/src/pipeline/export-orchestrator.ts` (from `export-worker.ts`)
- Refactor BullMQ workers to be thin wrappers calling orchestrators
- All existing server-mode tests must continue to pass

**Delivers:** Shared orchestrator functions that both server workers and the future `LocalPipelineRunner` can call. No user-facing changes.

**Sections:** 4.1.1

**Tests:** Existing worker tests refactored to test orchestrators directly. Worker wrapper tests verify delegation.

---

### Step 2: SQLite Schema, Codegen & Repository Layer

**Goal:** Build the local database layer -- SQLite schema, codegen script, repository implementations, and the `ProjectAdapter`.

**Scope:**
- Schema codegen script (`generate-sqlite-schema.ts`)
- Generated SQLite schemas from Postgres definitions
- Hand-written local-only tables (`runs`, `llm_usage`, `exports`, `project_meta`)
- `createProjectDb()` connection function with SQLite pragmas
- `ProjectAdapter` with all SQLite repository implementations
- Repository parity test suite (shared tests for Postgres + SQLite)

**Delivers:** A fully functional SQLite data layer that implements the same repository interfaces as Postgres. No CLI integration yet -- tested via unit/integration tests only.

**Sections:** 5.1 -- 5.11

**Tests:** Repository parity tests, codegen snapshot tests, SQLite pragma verification.

---

### Step 3: Config System -- YAML Parser, Global Config, Config Resolver

**Goal:** Build the configuration layer -- `spatula.yaml` parsing, `~/.spatula/config.yaml` loading, config resolution stack, and the config diff engine.

**Scope:**
- YAML parser with field shorthand expansion (`price: currency` -> `{ field: price, type: currency }`)
- `spatula.yaml` -> `JobConfig` transformation (section 2.3 mapping)
- Global config loader (`~/.spatula/config.yaml`)
- Config resolution stack (defaults -> global -> project -> CLI flags -> env vars)
- Config diff engine (section 6) with all change detection, URL normalization, field rename detection
- Secrets resolution (env vars, interactive prompts)
- Project detection (walk up directories for `spatula.yaml`)

**Delivers:** The ability to read, parse, resolve, and diff project configurations. No CLI commands yet -- tested via unit tests.

**Sections:** 2.1 -- 2.7, 6.1 -- 6.7

**Tests:** YAML parser tests (all tiers + edge cases), config resolution tests, config diff tests (every change type), URL normalizer tests.

---

### Step 4: Local Execution Pipeline & Core CLI Commands

**Goal:** Wire together the orchestrators (Step 1), SQLite layer (Step 2), and config system (Step 3) into the `LocalPipelineRunner`, plus the minimum CLI commands to create and run a project.

**Scope:**
- `LocalPipelineRunner` with full execution flow (section 4.2)
- In-memory priority queue, semaphore, checkpoint/resume logic
- Crash recovery, project lockfile
- `DataSource` interface + `LocalDataSource` implementation
- Compact progress display (section 4.5)
- Dashboard mode bridge (press `d` to expand)
- CLI commands: `spatula init` (wizard), `spatula run`, `spatula status`, `spatula reset`
- `spatula new` (conversational mode writing to `spatula.yaml`)
- Desktop notifications (`node-notifier`)
- Adapt existing CLI hooks to accept `DataSource`

**Delivers:** A fully functional local crawl workflow: `spatula init` -> `spatula run` -> see results. Resume works. Config diff works. This is the minimum viable local experience.

**Sections:** 3.1 -- 3.6, 4.1 -- 4.9, 10.1 -- 10.8

**Tests:** Pipeline integration tests (mock crawlers + LLM), resume/checkpoint tests, crash recovery tests, wizard tests, progress display tests.

---

### Step 5: Data Interaction Commands

**Goal:** Add the commands for exploring, exporting, reviewing, and modifying project data.

**Scope:**
- `spatula explore` -- Entity explorer TUI backed by `LocalDataSource`
- `spatula export` -- Local export using export orchestrator (all 5 formats)
- `spatula review` -- Action review TUI backed by `LocalDataSource`
- `spatula schema` -- Schema viewer (fields, versions, evolution history)
- `spatula logs` -- Run log viewer
- `spatula add` -- Add seed URLs with dedup
- `spatula config` -- Open `spatula.yaml` in `$EDITOR`
- `spatula doctor` -- System health checks (global + project)
- `spatula estimate` -- Cost estimation (from Phase 12, integrated with config system)
- `spatula test` -- Single-page test (from Phase 12, uses project schema if available)
- `spatula setup` -- Global reconfiguration wizard

**Delivers:** Full local data interaction. The user can explore, export, review schema actions, and manage their project entirely from the CLI.

**Sections:** 7.1 -- 7.7 (data interaction + modification + system commands)

**Tests:** Explorer/review TUI tests with mock DataSource, export format tests, doctor check tests, add dedup tests.

---

### Step 6: Remote Operations & Hosted Integration

**Goal:** Add the push/pull bridge between local projects and the hosted offering.

**Scope:**
- `spatula remote add/list/remove` -- Remote configuration
- `spatula push` -- Config upload, job creation, old job cancellation prompt
- `spatula pull` -- Results download with cursor pagination, incremental pull, schema conflict resolution, `spatula.yaml` field update
- `spatula remote start/pause/resume/cancel/status/watch` -- Remote job lifecycle
- `spatula remote jobs` -- List all hosted jobs
- `spatula remote link/unlink` -- Manual job linking
- `ApiDataSource` implementation (wraps existing `ApiClient`)
- Remote link tracking in `project_meta`

**Delivers:** The full local-to-hosted bridge. Users can develop locally, push to production, pull results back, and control remote jobs.

**Sections:** 8.1 -- 8.4, 9.1 -- 9.7

**Tests:** Push/pull integration tests (mock API), cursor resume tests, schema merge tests, remote command tests.

---

### Step Dependency Graph

```
Step 1 (Extract Orchestrators)
  |
  v
Step 2 (SQLite Schema + Repos)     Step 3 (Config System)
  |                                   |
  +------- both required by ----------+
  |
  v
Step 4 (Pipeline + Core CLI)
  |
  v
Step 5 (Data Interaction Commands)
  |
  v
Step 6 (Remote Operations)
```

Steps 2 and 3 can be developed in parallel after Step 1 completes. Steps 4-6 are sequential -- each builds on the previous.

### Interleaved Execution with Phase 12

Phase 13 steps should be executed **in parallel with Phase 12 workstreams**, not sequentially after Phase 12 completes. The two phases touch different layers (Phase 12: server code, Phase 13: local/CLI code) with minimal file overlap.

| Wave | Phase 12 (server layer) | Phase 13 (local layer) |
|------|------------------------|----------------------|
| **1** | A: CI/CD, Dockerfiles, shutdown, pooling, orchestrators | Step 1: Extract orchestrators (shared task) |
| **2** | D + F + J: circuit breaker, robots.txt, Ollama, proxy | Steps 2 + 3: SQLite schema + config system |
| **3** | B + C + E: auth, observability, performance | Step 4: Pipeline runner + core CLI |
| **4** | G + H: webhooks, bulk ops, LICENSE, README | Step 5: Data commands |
| **5** | I: billing, admin, data retention | Step 6: Remote ops (push/pull) |

**Open-source release targets end of Wave 4** — includes both server mode (Phase 12) and local project-folder mode (Phase 13 Steps 1-5). Wave 5 (hosted platform features + remote ops) follows.

Step 1 (orchestrator extraction) may be done as part of Phase 12 Workstream A (section 2.5) if workers are being refactored at the same time. If not, it remains Phase 13's first step.

### Estimated Scope Per Step

| Step | New Files | Modified Files | Approximate Effort |
|------|-----------|----------------|-------------------|
| 1. Extract Orchestrators | 4 | 4 workers | Medium (refactor, high test coverage needed) |
| 2. SQLite + Repos | ~15 | 0 | Medium-high (12 repos + codegen) |
| 3. Config System | ~5 | 1 | Medium (parser, resolver, differ) |
| 4. Pipeline + Core CLI | ~10 | ~8 hooks/components | High (pipeline runner, wizard, progress UI) |
| 5. Data Commands | ~12 | 0 | Medium (mostly wiring existing components) |
| 6. Remote Ops | ~15 | 2 | Medium (push/pull/remote subcommands) |

---

## 12. Testing Strategy

### 12.1 New Test Categories

| Category | What's Tested | Tool |
|----------|---------------|------|
| **SQLite repos** | All SQLite repository implementations against real SQLite | Vitest (in-memory SQLite) |
| **Schema codegen** | Generated SQLite schemas match Postgres source | Vitest + snapshot tests |
| **Config parser** | YAML parsing, shorthand expansion, config resolution | Vitest |
| **Config diff** | Change detection, URL normalization, rename detection | Vitest |
| **Pipeline runner** | Local execution flow, checkpoint, resume, crash recovery | Vitest + mock crawlers/LLM |
| **Wizard** | Setup flow, prompt handling, file generation | Vitest + mock inquirer |
| **Remote ops** | Push/pull/link, cursor resume, schema merge | Vitest + mock API |
| **CLI commands** | All new commands (init, run, status, etc.) | Vitest + Ink testing |

### 12.2 Repository Parity Tests

Shared test suites that run the same assertions against both Postgres and SQLite repository implementations. Ensures behavioral parity:

```typescript
function entityRepoTests(createRepo: () => EntityRepository) {
  it('stores and retrieves entities', async () => { ... });
  it('filters by quality score', async () => { ... });
  it('paginates results', async () => { ... });
  // Same tests, different backends
}

describe('PostgresEntityRepository', () => entityRepoTests(() => pgRepo));
describe('SqliteEntityRepository', () => entityRepoTests(() => sqliteRepo));
```

### 12.3 Integration Tests

- **Full local crawl:** `spatula init` -> `spatula run` -> `spatula explore` -> `spatula export` against a local fixture server
- **Resume flow:** Start crawl -> interrupt -> resume -> verify no data loss
- **Config diff flow:** Run -> edit config -> run again -> verify correct re-extraction
- **Push/pull flow:** Local crawl -> push to test server -> pull results -> verify data integrity

### 12.4 Codegen Verification

CI runs the schema codegen script and fails if generated files differ from committed files. This ensures the SQLite schema stays in sync with Postgres:

```yaml
# In CI workflow
- name: Verify SQLite schema codegen
  run: |
    pnpm run generate:sqlite-schema
    git diff --exit-code packages/db/src/schema-sqlite/
```

---

## 13. Migration & Rollout

### 13.1 New Package Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `better-sqlite3` | ^12.x | Already a dependency (SQLite exporter) |
| `node-notifier` | ^10.x | Desktop notifications |
| `yaml` | ^2.x | YAML parsing for spatula.yaml |
| `inquirer` | ^12.x | Interactive wizard prompts |
| `ora` | ^8.x | Spinner/progress display |

### 13.2 Environment Variable Additions

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPATULA_PROXY_PASSWORD` | -- | Proxy authentication |
| `SPATULA_COOKIE_<NAME>` | -- | Cookie values (e.g., `SPATULA_COOKIE_SESSION_ID`) |
| `SPATULA_REMOTE_<NAME>_API_KEY` | -- | Remote API keys (override global config) |
| `SPATULA_HOME` | `~/.spatula` | Override global config directory |

### 13.3 New Files Summary

| Path | Purpose |
|------|---------|
| `packages/db/src/schema-sqlite/` | Generated + hand-written SQLite schemas |
| `packages/db/src/project-db/connection.ts` | SQLite connection with pragmas |
| `packages/db/src/project-db/adapter.ts` | ProjectAdapter (repo factory) |
| `packages/db/src/project-db/repositories/` | SQLite repo implementations |
| `packages/db/scripts/generate-sqlite-schema.ts` | Schema codegen script |
| `packages/core/src/pipeline/crawl-orchestrator.ts` | Shared crawl logic (dedup, classify, extract, link eval) |
| `packages/core/src/pipeline/schema-orchestrator.ts` | Shared schema evolution logic |
| `packages/core/src/pipeline/reconcile-orchestrator.ts` | Shared reconciliation logic |
| `packages/core/src/pipeline/export-orchestrator.ts` | Shared export logic |
| `packages/core/src/pipeline/local-pipeline-runner.ts` | In-process execution pipeline |
| `packages/core/src/pipeline/priority-queue.ts` | In-memory priority queue |
| `packages/core/src/pipeline/semaphore.ts` | Concurrency limiter |
| `packages/core/src/pipeline/checkpoint.ts` | Checkpoint/resume logic |
| `packages/core/src/pipeline/types.ts` | PipelineEvents, DataSource interface |
| `packages/core/src/config/yaml-parser.ts` | spatula.yaml parser + shorthand expansion |
| `packages/core/src/config/config-resolver.ts` | Global + project + CLI + env resolution |
| `packages/core/src/config/config-differ.ts` | Config diff engine |
| `packages/core/src/config/url-normalizer.ts` | URL normalization for seed comparison |
| `apps/cli/src/commands/init.ts` | Setup wizard (replaces Phase 12 version) |
| `apps/cli/src/commands/run.ts` | Local crawl runner |
| `apps/cli/src/commands/status.ts` | Project status (replaces existing) |
| `apps/cli/src/commands/explore.ts` | Entity explorer (replaces existing) |
| `apps/cli/src/commands/review.ts` | Action review |
| `apps/cli/src/commands/export.ts` | Export command |
| `apps/cli/src/commands/test.ts` | Single-page test (from Phase 12) |
| `apps/cli/src/commands/estimate.ts` | Cost estimation (from Phase 12) |
| `apps/cli/src/commands/add.ts` | Add seed URLs |
| `apps/cli/src/commands/schema.ts` | View schema |
| `apps/cli/src/commands/logs.ts` | View run logs |
| `apps/cli/src/commands/reset.ts` | Clear project state |
| `apps/cli/src/commands/config.ts` | Open config in editor |
| `apps/cli/src/commands/setup.ts` | Global reconfiguration |
| `apps/cli/src/commands/doctor.ts` | System health (replaces Phase 12 version) |
| `apps/cli/src/commands/push.ts` | Push config to remote |
| `apps/cli/src/commands/pull.ts` | Pull results from remote |
| `apps/cli/src/commands/remote/` | Remote subcommands (add, list, remove, status, etc.) |
| `apps/cli/src/data-source/api-data-source.ts` | DataSource wrapping API client (remote mode) |
| `apps/cli/src/data-source/local-data-source.ts` | DataSource wrapping SQLite repos (local mode) |
| `apps/cli/src/progress/compact.tsx` | Compact progress display |
| `apps/cli/src/progress/dashboard-bridge.tsx` | Bridge local crawl to dashboard TUI |

### 13.4 Modified Files Summary

| Path | Change |
|------|--------|
| `apps/cli/src/index.tsx` | New command registration, project detection |
| `apps/cli/src/App.tsx` | Mode routing for local vs remote dashboard |
| `apps/cli/src/store/index.ts` | Project-aware store (SQLite-backed vs API-backed) |
| `apps/cli/src/api/client.ts` | Add push/pull methods |
| `packages/core/src/interfaces/crawler.ts` | Add proxy + cookies to CrawlOptions |
| `packages/core/src/crawlers/playwright-crawler.ts` | Proxy and cookie support |
| `packages/core/src/crawlers/firecrawl-crawler.ts` | Cookie-to-header conversion |
| `packages/core/src/types/job.ts` | Add proxy + cookies to CrawlConfig |
| `packages/shared/src/config.ts` | Global config loading from ~/.spatula/ |
| `packages/queue/src/workers/crawl-worker.ts` | Refactor: extract logic to crawl-orchestrator, become thin wrapper |
| `packages/queue/src/workers/schema-worker.ts` | Refactor: extract logic to schema-orchestrator |
| `packages/queue/src/workers/reconciliation-worker.ts` | Refactor: extract logic to reconcile-orchestrator |
| `packages/queue/src/workers/export-worker.ts` | Refactor: extract logic to export-orchestrator |
| `apps/cli/src/hooks/useJobPolling.ts` | Accept DataSource instead of ApiClient |
| `apps/cli/src/hooks/useEntityData.ts` | Accept DataSource instead of ApiClient |
| `apps/cli/src/hooks/useEntityFilter.ts` | Accept DataSource instead of ApiClient |
| `apps/cli/src/hooks/useExport.ts` | Accept DataSource instead of ApiClient |
| `apps/cli/src/hooks/useWebSocket.ts` | Accept DataSource (subscribe method replaces WS) |
| `.gitignore` | Add `.spatula/` pattern |

### 13.5 Backward Compatibility

Phase 13 is additive. The existing server-mode architecture (Postgres + Redis + BullMQ + API) is completely unchanged. The new local mode is a separate code path that shares the core engine.

Existing CLI commands (`spatula list`, `spatula status <jobId>`) are deprecated in favor of `spatula remote jobs <name>` and `spatula remote status <name>` but continue to work as aliases during a transition period.

### 13.6 Relationship to Phase 12

Phase 13 depends on several Phase 12 features:

- **Workstream J:** Ollama LLM client, `spatula test`, cost estimation, proxy/cookie support -- all used directly by the local pipeline
- **Workstream F:** robots.txt compliance, per-domain politeness, crawl budget enforcement -- integrated into `LocalPipelineRunner`
- **Workstream D:** Circuit breaker for LLM calls -- used by local pipeline's error handling
- **Workstream G:** `spatula init` wizard -- extended for project-folder model (replaces Phase 12's simpler version)
- **Workstream G:** `spatula doctor` -- extended with project-level checks

Phase 12 features that are server-only (auth, rate limiting, billing, admin panel, S3 content store, queue dashboard) are not used by the local mode.
