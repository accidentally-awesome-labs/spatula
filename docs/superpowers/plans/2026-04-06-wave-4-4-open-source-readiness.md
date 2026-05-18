# Wave 4-4: Open-Source Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the Spatula project for public open-source release — licensing, documentation, community infrastructure, examples, and cleanup.

**Architecture:** This is a documentation-only wave with zero runtime code changes. All deliverables are new files (LICENSE, README, CONTRIBUTING, SECURITY, architecture docs, examples, GitHub templates, workflows) plus metadata updates to package.json files and .env.example. One cleanup task removes stale TODOs and updates the wave roadmap.

**Tech Stack:** Markdown, YAML (GitHub Actions, release-please config), JSON (package.json), Mermaid (diagrams)

**Spec reference:** `docs/superpowers/specs/2026-03-31-wave-4-decomposition-design.md` § 4.4

---

## File Map

| Action | Path                                                      | Responsibility                                                      |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------- |
| Create | `LICENSE`                                                 | MIT license text                                                    |
| Create | `SECURITY.md`                                             | Vulnerability reporting policy                                      |
| Create | `README.md`                                               | 12-section project README                                           |
| Create | `CONTRIBUTING.md`                                         | Contributor guide                                                   |
| Create | `docs/architecture.md`                                    | Package diagram, data flow, interface map, action taxonomy, LLM map |
| Create | `.github/ISSUE_TEMPLATE/bug_report.md`                    | Bug report template                                                 |
| Create | `.github/ISSUE_TEMPLATE/feature_request.md`               | Feature request template                                            |
| Create | `.github/PULL_REQUEST_TEMPLATE.md`                        | PR checklist template                                               |
| Create | `.github/workflows/release-please.yml`                    | Changelog automation workflow                                       |
| Create | `release-please-config.json`                              | Monorepo release-please config                                      |
| Create | `.release-please-manifest.json`                           | Version manifest for release-please                                 |
| Create | `examples/quickstart/spatula.yaml`                        | Minimal single-site crawl                                           |
| Create | `examples/quickstart/docker-compose.yml`                  | Dev stack for quickstart                                            |
| Create | `examples/quickstart/README.md`                           | Quickstart walkthrough                                              |
| Create | `examples/ecommerce/spatula.yaml`                         | Multi-site product catalog                                          |
| Create | `examples/ecommerce/README.md`                            | Ecommerce example guide                                             |
| Create | `examples/news/spatula.yaml`                              | News article aggregation                                            |
| Create | `examples/news/README.md`                                 | News example guide                                                  |
| Create | `examples/real-estate/spatula.yaml`                       | Property listing extraction                                         |
| Create | `examples/real-estate/README.md`                          | Real estate example guide                                           |
| Create | `packages/core/tests/unit/config/example-configs.test.ts` | Validates example YAMLs against SpatulaYamlSchema                   |
| Modify | `.env.example`                                            | Expand from 5 to 25 env vars with categories                        |
| Modify | `package.json`                                            | Add license, repository, description, homepage, bugs                |
| Modify | `packages/core/package.json`                              | Add OSS metadata fields                                             |
| Modify | `packages/db/package.json`                                | Add OSS metadata fields                                             |
| Modify | `packages/queue/package.json`                             | Add OSS metadata fields                                             |
| Modify | `packages/shared/package.json`                            | Add OSS metadata fields                                             |
| Modify | `apps/api/package.json`                                   | Add OSS metadata fields                                             |
| Modify | `apps/cli/package.json`                                   | Add OSS metadata fields                                             |
| Modify | `docs/superpowers/specs/wave-roadmap.md`                  | Mark Wave 4 complete, update test counts                            |
| Modify | `apps/cli/src/hooks/useJobPolling.ts`                     | Remove stale DONE TODO comment                                      |
| Modify | `apps/cli/src/commands/run.ts`                            | Remove stale TODO (structured logging was implemented)              |

---

### Task 1: LICENSE

**Files:**

- Create: `LICENSE`

- [ ] **Step 1: Create MIT license file**

```text
MIT License

Copyright (c) 2026 Spatula Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Commit**

```bash
git add LICENSE
git commit -m "chore: add MIT license"
```

---

### Task 2: SECURITY.md

**Files:**

- Create: `SECURITY.md`

- [ ] **Step 1: Create security policy**

```markdown
# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email **security@spatula.dev** with:

1. A description of the vulnerability
2. Steps to reproduce
3. Affected versions
4. Any potential mitigations you've identified

### What to Expect

- **Acknowledgement:** Within 48 hours
- **Status update:** Within 7 days
- **Resolution target:** Within 30 days for critical issues

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure). We will credit reporters in the advisory unless they prefer to remain anonymous.

## Scope

The following are in scope:

- `@spatula/core`, `@spatula/db`, `@spatula/queue`, `@spatula/shared`
- `@spatula/api`, `@spatula/cli`
- Docker images published to `ghcr.io`

The following are out of scope:

- Third-party dependencies (report upstream)
- Social engineering attacks
- Denial of service attacks
```

- [ ] **Step 2: Commit**

```bash
git add SECURITY.md
git commit -m "chore: add security policy"
```

---

### Task 3: .env.example Update

**Files:**

- Modify: `.env.example`

All 25 environment variables found via `grep -r 'process.env\.' packages/ apps/` organized by category.

- [ ] **Step 1: Rewrite .env.example with all env vars**

```bash
# ─── LLM ──────────────────────────────────────────────────────
# OpenRouter API key (required for cloud LLM inference)
OPENROUTER_API_KEY=

# OpenRouter base URL override (default: https://openrouter.ai/api/v1)
# OPENROUTER_BASE_URL=

# Ollama base URL for local LLM inference (default: http://localhost:11434)
# OLLAMA_BASE_URL=http://localhost:11434

# LLM provider: "openrouter" or "ollama" (default: openrouter)
# LLM_PROVIDER=openrouter

# Default LLM model identifier (default: anthropic/claude-sonnet-4-20250514)
# LLM_PRIMARY_MODEL=

# ─── Crawlers ─────────────────────────────────────────────────
# Firecrawl API key (optional — only needed if crawler=firecrawl)
FIRECRAWL_API_KEY=

# ─── Database ─────────────────────────────────────────────────
# PostgreSQL connection string (required for server mode)
DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula

# Test database (used by `pnpm test:e2e`)
TEST_DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula_test

# Connection pool size (default: 10)
# DB_POOL_MAX=10

# Idle connection timeout in ms (default: 30000)
# DB_POOL_IDLE_TIMEOUT=30000

# ─── Redis ────────────────────────────────────────────────────
# Redis connection string (required for server mode — job queue + caching)
REDIS_URL=redis://localhost:6379

# ─── Auth ─────────────────────────────────────────────────────
# Auth strategy: "none", "api-key", or "jwt" (default: none)
# AUTH_STRATEGY=none

# JWT settings (required when AUTH_STRATEGY=jwt)
# JWT_ISSUER=
# JWT_AUDIENCE=
# JWT_JWKS_URL=

# ─── Storage ──────────────────────────────────────────────────
# Content store backend: "filesystem" or "s3" (default: filesystem)
# CONTENT_STORE=filesystem

# S3-compatible storage (required when CONTENT_STORE=s3)
# S3_BUCKET=
# S3_REGION=
# S3_ENDPOINT=
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=

# ─── Observability ────────────────────────────────────────────
# Sentry DSN for error tracking (optional)
# SENTRY_DSN=

# Sentry trace sampling rate 0.0–1.0 (default: 0.1)
# SENTRY_TRACES_SAMPLE_RATE=0.1

# OpenTelemetry collector endpoint (optional)
# OTEL_EXPORTER_ENDPOINT=

# ─── Server ───────────────────────────────────────────────────
# API server port (default: 3000)
# PORT=3000

# API base URL used by doctor server checks (default: http://localhost:3000)
# API_URL=http://localhost:3000

# CORS allowed origins, comma-separated (default: http://localhost:3000)
# CORS_ALLOWED_ORIGINS=http://localhost:3000

# ─── Workers ──────────────────────────────────────────────────
# Worker selection, comma-separated: crawl,schema,reconciliation,export,webhook
# SPATULA_WORKERS=crawl,schema,reconciliation,export,webhook

# ─── CLI ──────────────────────────────────────────────────────
# Override default Spatula home directory (default: ~/.spatula)
# SPATULA_HOME=

# ─── Logging ──────────────────────────────────────────────────
# Log level: "debug", "info", "warn", "error" (default: info)
# LOG_LEVEL=info
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: expand .env.example with all 25 environment variables"
```

---

### Task 4: Package.json Metadata

**Files:**

- Modify: `package.json` (root)
- Modify: `packages/core/package.json`
- Modify: `packages/db/package.json`
- Modify: `packages/queue/package.json`
- Modify: `packages/shared/package.json`
- Modify: `apps/api/package.json`
- Modify: `apps/cli/package.json`

- [ ] **Step 1: Add OSS metadata to root package.json**

Add these fields to the root `package.json`:

```json
{
  "description": "AI-powered intelligent web crawling platform — describe the data you want, get clean production-ready datasets",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/spatulaai/spatula.git"
  },
  "homepage": "https://github.com/spatulaai/spatula#readme",
  "bugs": {
    "url": "https://github.com/spatulaai/spatula/issues"
  },
  "keywords": ["web-scraping", "ai", "llm", "data-extraction", "crawling", "structured-data"]
}
```

- [ ] **Step 2: Add OSS metadata to all 6 workspace packages**

Each package gets `license`, `repository` (with `directory`), `homepage`, `bugs`, and a package-specific `description`:

| Package           | `description`                                                 |
| ----------------- | ------------------------------------------------------------- |
| `@spatula/core`   | `Core types, interfaces, and pipeline logic for Spatula`      |
| `@spatula/db`     | `PostgreSQL and SQLite database layer for Spatula`            |
| `@spatula/queue`  | `BullMQ job queue, workers, and webhook delivery for Spatula` |
| `@spatula/shared` | `Shared utilities — logging, auth, metrics, tracing, errors`  |
| `@spatula/api`    | `Hono REST API server for Spatula`                            |
| `@spatula/cli`    | `Command-line interface and TUI for Spatula`                  |

Example for `@spatula/core` (repeat pattern for all 6):

```json
{
  "license": "MIT",
  "description": "Core types, interfaces, and pipeline logic for Spatula",
  "repository": {
    "type": "git",
    "url": "https://github.com/spatulaai/spatula.git",
    "directory": "packages/core"
  },
  "homepage": "https://github.com/spatulaai/spatula#readme",
  "bugs": {
    "url": "https://github.com/spatulaai/spatula/issues"
  }
}
```

For `apps/api`, `directory` = `"apps/api"`. For `apps/cli`, `directory` = `"apps/cli"`.

- [ ] **Step 3: Commit**

```bash
git add package.json packages/core/package.json packages/db/package.json packages/queue/package.json packages/shared/package.json apps/api/package.json apps/cli/package.json
git commit -m "chore: add OSS metadata to all package.json files"
```

---

### Task 5: GitHub Templates

**Files:**

- Create: `.github/ISSUE_TEMPLATE/bug_report.md`
- Create: `.github/ISSUE_TEMPLATE/feature_request.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Create bug report template**

`.github/ISSUE_TEMPLATE/bug_report.md`:

```markdown
---
name: Bug Report
about: Report a bug to help us improve
title: ''
labels: bug
assignees: ''
---

## Describe the Bug

A clear and concise description of the bug.

## Steps to Reproduce

1. Run `spatula ...`
2. Configure with ...
3. See error

## Expected Behavior

What you expected to happen.

## Actual Behavior

What actually happened. Include error messages or logs.

## Environment

- **OS:** [e.g., macOS 15, Ubuntu 24.04]
- **Node.js:** [e.g., 22.x]
- **Spatula version:** [e.g., 0.1.0]
- **Mode:** [Local CLI / Server]
- **LLM provider:** [OpenRouter / Ollama / None]

## Additional Context

Relevant `spatula.yaml` config (redact API keys), log output, or screenshots.
```

- [ ] **Step 2: Create feature request template**

`.github/ISSUE_TEMPLATE/feature_request.md`:

```markdown
---
name: Feature Request
about: Suggest an idea for Spatula
title: ''
labels: enhancement
assignees: ''
---

## Use Case

Describe the problem you're trying to solve or the workflow you want to improve.

## Proposed Solution

A clear description of what you'd like to happen.

## Alternatives Considered

Any alternative solutions or workarounds you've tried.

## Additional Context

Links, screenshots, or examples that help explain the request.
```

- [ ] **Step 3: Create PR template**

`.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## Summary

Brief description of changes.

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor
- [ ] CI/CD

## Checklist

- [ ] Tests pass (`pnpm test`)
- [ ] Lint clean (`pnpm lint`)
- [ ] Types check (`pnpm typecheck`)
- [ ] New tests added for new functionality
- [ ] Documentation updated (if applicable)

## Related Issues

Closes #
```

- [ ] **Step 4: Commit**

```bash
git add .github/ISSUE_TEMPLATE/bug_report.md .github/ISSUE_TEMPLATE/feature_request.md .github/PULL_REQUEST_TEMPLATE.md
git commit -m "chore: add GitHub issue and PR templates"
```

---

### Task 6: Release-Please Changelog Automation

**Files:**

- Create: `.github/workflows/release-please.yml`
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`

- [ ] **Step 1: Create release-please workflow**

`.github/workflows/release-please.yml`:

```yaml
name: Release Please

on:
  push:
    branches:
      - main

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

- [ ] **Step 2: Create release-please config**

`release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "release-type": "node",
      "component": "spatula",
      "changelog-path": "CHANGELOG.md",
      "bump-minor-pre-major": true,
      "bump-patch-for-minor-pre-major": true
    },
    "packages/core": {
      "release-type": "node",
      "component": "core"
    },
    "packages/db": {
      "release-type": "node",
      "component": "db"
    },
    "packages/queue": {
      "release-type": "node",
      "component": "queue"
    },
    "packages/shared": {
      "release-type": "node",
      "component": "shared"
    },
    "apps/api": {
      "release-type": "node",
      "component": "api"
    },
    "apps/cli": {
      "release-type": "node",
      "component": "cli"
    }
  }
}
```

- [ ] **Step 3: Create version manifest**

`.release-please-manifest.json`:

```json
{
  ".": "0.0.1",
  "packages/core": "0.0.1",
  "packages/db": "0.0.1",
  "packages/queue": "0.0.1",
  "packages/shared": "0.0.1",
  "apps/api": "0.0.1",
  "apps/cli": "0.0.1"
}
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-please.yml release-please-config.json .release-please-manifest.json
git commit -m "ci: add release-please changelog automation for monorepo"
```

---

### Task 7: Architecture Documentation

**Files:**

- Create: `docs/architecture.md`

This is the largest creative deliverable. It contains 5 sections with Mermaid diagrams.

- [ ] **Step 1: Create architecture documentation**

`docs/architecture.md`:

````markdown
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

| Interface        | File                                              | Implementations                                                                          |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Crawler`        | `packages/core/src/interfaces/crawler.ts`         | `PlaywrightCrawler`, `FirecrawlCrawler`                                                  |
| `Extractor`      | `packages/core/src/interfaces/extractor.ts`       | `LLMExtractor`, `CssExtractor`                                                           |
| `LLMClient`      | `packages/core/src/interfaces/llm-client.ts`      | `OpenRouterClient`, `OllamaClient`, `CircuitBreakerLLMClient`                            |
| `ContentStore`   | `packages/core/src/interfaces/content-store.ts`   | `FilesystemContentStore`, `S3ContentStore`                                               |
| `DataSource`     | `packages/core/src/interfaces/data-source.ts`     | `LocalDataSource` (SQLite), API client (planned)                                         |
| `SchemaEvolver`  | `packages/core/src/interfaces/schema-evolver.ts`  | `LLMSchemaEvolver`                                                                       |
| `Reconciler`     | `packages/core/src/interfaces/reconciler.ts`      | `LLMReconciler`                                                                          |
| `Exporter`       | `packages/core/src/interfaces/exporter.ts`        | `JsonExporter`, `CsvExporter`, `ParquetExporter`, `SqliteExporter`, `DuckDbExporter`     |
| `ActionExecutor` | `packages/core/src/interfaces/action-executor.ts` | Pipeline action executor                                                                 |
| `ConfigExecutor` | `packages/core/src/interfaces/config-executor.ts` | Config action executor                                                                   |
| `Orchestrator`   | `packages/core/src/interfaces/orchestrator.ts`    | `CrawlOrchestrator`, `SchemaOrchestrator`, `ReconcileOrchestrator`, `ExportOrchestrator` |

### Dual Execution Model

Spatula runs in two modes:

- **Server mode** — PostgreSQL + Redis + BullMQ. API server handles HTTP requests, BullMQ workers process jobs asynchronously. Multi-tenant.
- **Local mode** — SQLite + in-memory queues. `spatula run` executes the full pipeline in-process. Single-project.

Both modes use the same orchestrator functions from `@spatula/core`. The server wraps them in BullMQ workers; the CLI calls them directly via `LocalPipelineRunner`.

## Action System

All data mutations flow through typed **actions**. Actions are proposals that may require human review before execution.

### Action Categories

| Category           | Count | Examples                                                                                                                                                |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema**         | 9     | `ADD_FIELD`, `MODIFY_FIELD`, `REMOVE_FIELD`, `RENAME_FIELD`, `SPLIT_FIELD`, `GROUP_FIELDS`, `MERGE_FIELDS`, `RECOMMEND_TABLE_STRUCTURE`, `DERIVE_FIELD` |
| **Normalization**  | 2     | `SET_NORMALIZATION_RULE`, `UPDATE_ENUM_MAP`                                                                                                             |
| **Category**       | 3     | `DEFINE_CATEGORY`, `ASSIGN_CATEGORY_FIELDS`, `CLASSIFY_PAGE`                                                                                            |
| **Crawl**          | 1     | `ENQUEUE_LINKS`                                                                                                                                         |
| **Reconciliation** | 7     | `HINT_ENTITY_MATCH`, `MATCH_ENTITIES`, `SPLIT_ENTITIES`, `RESOLVE_CONFLICT`, `INFER_VALUE`, `CORRECT_VALUE`, `SET_SOURCE_TRUST`                         |
| **Reprocessing**   | 1     | `REPROCESS_EXTRACTION`                                                                                                                                  |
| **Quality**        | 1     | `FLAG_ANOMALY`                                                                                                                                          |
| **Documentation**  | 1     | `GENERATE_DOCUMENTATION`                                                                                                                                |
| **Config**         | 30    | Seed management, field configuration, crawl settings, LLM tuning, export preferences                                                                    |

**Total: 55 action types** (25 pipeline + 30 config).

### Safety Levels

Each project defines a `safety` level controlling how actions are handled:

| Level      | Behavior                                            |
| ---------- | --------------------------------------------------- |
| `trust_ai` | All actions auto-approved                           |
| `balanced` | Low-risk auto-approved, high-risk queued for review |
| `cautious` | Most actions queued for review                      |
| `manual`   | All actions queued for review                       |

## LLM Usage Map

LLM inference is used at 8 decision points, each routable to a different model tier:

| Task                 | Purpose                                       | Default Tier     | Why                        |
| -------------------- | --------------------------------------------- | ---------------- | -------------------------- |
| `pageRelevance`      | Is this page about our target data?           | Fast (Haiku)     | High volume, simple yes/no |
| `linkEvaluation`     | Should we follow this link?                   | Fast (Haiku)     | High volume, scoring task  |
| `extraction`         | Extract structured fields from page           | Primary (Sonnet) | Core accuracy requirement  |
| `schemaEvolution`    | Propose new fields from unmapped data         | Primary (Sonnet) | Complex reasoning          |
| `entityMatching`     | Are these the same real-world entity?         | Primary (Sonnet) | Fuzzy matching             |
| `conflictResolution` | Which value is correct when sources disagree? | Primary (Sonnet) | Judgment call              |
| `qualityAudit`       | Verify extraction quality                     | Primary (Sonnet) | Accuracy check             |
| `documentation`      | Generate field descriptions                   | Fast (Haiku)     | Simple text generation     |

Model routing is configured per-project in `spatula.yaml` under `llm.overrides`. The `model-router.ts` resolves the model for each task by checking: task-specific override > project default > global config default.
````

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: add architecture documentation with diagrams"
```

---

### Task 8: Example Configurations

**Files:**

- Create: `examples/quickstart/spatula.yaml`
- Create: `examples/quickstart/docker-compose.yml`
- Create: `examples/quickstart/README.md`
- Create: `examples/ecommerce/spatula.yaml`
- Create: `examples/ecommerce/README.md`
- Create: `examples/news/spatula.yaml`
- Create: `examples/news/README.md`
- Create: `examples/real-estate/spatula.yaml`
- Create: `examples/real-estate/README.md`

- [ ] **Step 1: Create quickstart example**

`examples/quickstart/spatula.yaml`:

```yaml
name: Quickstart
description: Extract product data from a single site

seeds:
  - https://books.toscrape.com

fields:
  - title: string
  - price: currency
  - availability: string
  - rating: number

depth: 2
limit: 50
```

`examples/quickstart/docker-compose.yml`:

```yaml
# Development stack for server mode.
# For local mode, you don't need this — just run `spatula run`.
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - '5432:5432'
    environment:
      POSTGRES_USER: spatula
      POSTGRES_PASSWORD: spatula
      POSTGRES_DB: spatula
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'

volumes:
  pgdata:
```

`examples/quickstart/README.md`:

````markdown
# Quickstart Example

Extract book data from [books.toscrape.com](https://books.toscrape.com) — a practice site for web scraping.

## Local Mode (recommended for getting started)

```bash
# Install Spatula
npm install -g @spatula/cli

# Initialize from this example
cp spatula.yaml /path/to/my-project/
cd /path/to/my-project
spatula init

# Configure your LLM provider
spatula setup

# Run the crawl
spatula run

# Explore results
spatula explore

# Export data
spatula export --format json
```
````

## Server Mode

```bash
# Start database services
docker compose up -d

# Copy .env.example from repo root and configure
cp ../../.env.example .env

# Run migrations
pnpm --filter @spatula/db migrate

# Start the API server
pnpm --filter @spatula/api start
```

## What This Extracts

| Field          | Type     | Example                |
| -------------- | -------- | ---------------------- |
| `title`        | string   | "A Light in the Attic" |
| `price`        | currency | 51.77                  |
| `availability` | string   | "In stock"             |
| `rating`       | number   | 3                      |

````

- [ ] **Step 2: Create ecommerce example**

`examples/ecommerce/spatula.yaml`:

```yaml
name: Product Catalog
description: Multi-site product catalog extraction with price tracking

seeds:
  - https://store-one.example.com/products
  - https://store-two.example.com/catalog

fields:
  - field: product_name
    type: string
    required: true
  - field: price
    type: currency
    required: true
  - field: currency
    type: string
    description: Price currency code (USD, EUR, GBP, CAD)
  - field: brand
    type: string
  - field: category
    type: string
  - field: in_stock
    type: boolean
  - field: image_url
    type: url
  - field: sku
    type: string
  - field: description
    type: string

depth: 3
limit: 5000
crawler: playwright
safety: balanced

schema:
  mode: hybrid
  evolution:
    batchSize: 15
    maxFields: 40

reconciliation:
  strategy: composite_key
  conflictResolution: most_complete
  fuzzyThreshold: 0.85

llm:
  overrides:
    pageRelevance: anthropic/claude-3-haiku-20240307
    linkEvaluation: anthropic/claude-3-haiku-20240307

export:
  format: json
  includeProvenance: true
````

`examples/ecommerce/README.md`:

````markdown
# Ecommerce Product Catalog Example

Extract and reconcile product listings across multiple online stores.

## Highlights

- **Multi-site seeds** — crawls two stores and reconciles products across them
- **Composite key matching** — identifies the same product listed on different sites
- **Hybrid schema** — starts with defined fields, discovers new ones automatically
- **Model routing** — uses fast models for page classification, accurate models for extraction
- **Provenance tracking** — every field records which source it came from

## Usage

```bash
cp spatula.yaml /path/to/my-project/
cd /path/to/my-project
spatula init
spatula run
```
````

## Configuration Notes

- `safety: balanced` auto-approves low-risk schema changes, queues high-risk ones for `spatula review`
- `reconciliation.strategy: composite_key` uses product name + brand + category to match entities
- `depth: 3` follows product pages 3 levels deep from seed URLs

````

- [ ] **Step 3: Create news example**

`examples/news/spatula.yaml`:

```yaml
name: News Articles
description: Aggregate news articles with structured metadata

seeds:
  - https://news.example.com

fields:
  - field: headline
    type: string
    required: true
  - field: author
    type: string
  - field: published_date
    type: string
  - field: category
    type: string
    description: Article category (politics, technology, science, business, sports, entertainment)
  - field: summary
    type: string
  - field: source_url
    type: url
    required: true
  - field: image_url
    type: url

depth: 2
limit: 500
safety: cautious

schema:
  mode: discovery

reconciliation:
  strategy: exact_name
  conflictResolution: most_recent
````

`examples/news/README.md`:

````markdown
# News Article Aggregation Example

Extract structured article data from news websites.

## Highlights

- **Schema discovery** — starts with basic fields, lets the LLM discover additional metadata
- **Cautious safety** — most schema changes require manual review via `spatula review`
- **Exact name matching** — articles are matched by headline (no fuzzy dedup needed)
- **Most recent wins** — when the same article is found multiple times, the latest version is kept

## Usage

```bash
cp spatula.yaml /path/to/my-project/
cd /path/to/my-project
spatula init
spatula run
spatula review   # Review discovered schema changes
spatula export --format csv
```
````

````

- [ ] **Step 4: Create real estate example**

`examples/real-estate/spatula.yaml`:

```yaml
name: Property Listings
description: Extract real estate listings with location and pricing data

seeds:
  - https://listings.example.com/homes

fields:
  - field: address
    type: string
    required: true
  - field: price
    type: currency
    required: true
  - field: bedrooms
    type: number
  - field: bathrooms
    type: number
  - field: sqft
    type: number
  - field: property_type
    type: string
    description: Type of property (house, condo, townhouse, apartment, land)
  - field: listing_status
    type: string
    description: Listing status (active, pending, sold)
  - field: listing_url
    type: url
  - field: images
    type: array
    description: Property image URLs
  - field: description
    type: string

depth: 3
limit: 2000
crawler: playwright
safety: balanced

crawl:
  concurrency: 3

reconciliation:
  strategy: fuzzy_name
  conflictResolution: most_complete
  fuzzyThreshold: 0.80

export:
  format: sqlite
  autoExport: true
````

`examples/real-estate/README.md`:

````markdown
# Real Estate Listings Example

Extract property listings with structured location, pricing, and feature data.

## Highlights

- **Fuzzy entity matching** — matches listings even when addresses differ slightly ("123 Main St" vs "123 Main Street")
- **Array fields** — captures multiple image URLs per property
- **Enum fields** — constrains property type and listing status to known values
- **SQLite export** — outputs a queryable database for analysis
- **Low concurrency** — polite crawling at 3 concurrent requests

## Usage

```bash
cp spatula.yaml /path/to/my-project/
cd /path/to/my-project
spatula init
spatula run
spatula export --format sqlite --output properties.db
```
````

## Querying the Export

```bash
sqlite3 properties.db "SELECT address, price, bedrooms FROM entities WHERE bedrooms >= 3 ORDER BY price"
```

````

- [ ] **Step 5: Commit**

```bash
git add examples/
git commit -m "docs: add 4 example project configurations"
````

---

### Task 9: Example YAML Validation Test

**Files:**

- Create: `packages/core/tests/unit/config/example-configs.test.ts`

This test validates that all example `spatula.yaml` files parse against the real `SpatulaYamlSchema`. Prevents documentation rot — if the schema changes in future waves, CI catches broken examples.

- [ ] **Step 1: Write the test**

`packages/core/tests/unit/config/example-configs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SpatulaYamlSchema } from '../../../src/config/types.js';

const EXAMPLES_DIR = join(__dirname, '..', '..', '..', '..', '..', 'examples');

const examples = ['quickstart', 'ecommerce', 'news', 'real-estate'];

describe('example configurations', () => {
  for (const example of examples) {
    it(`examples/${example}/spatula.yaml passes schema validation`, () => {
      const raw = readFileSync(join(EXAMPLES_DIR, example, 'spatula.yaml'), 'utf-8');
      const parsed = parse(raw);
      const result = SpatulaYamlSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `examples/${example}/spatula.yaml failed validation:\n${result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
        );
      }
    });
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm --filter @spatula/core test -- tests/unit/config/example-configs.test.ts`
Expected: 4 tests PASS (one per example). If any fail, the example YAML has a field that doesn't match the schema — fix the example, not the test.

- [ ] **Step 3: Commit**

```bash
git add packages/core/tests/unit/config/example-configs.test.ts
git commit -m "test: add validation test for example spatula.yaml configs"
```

---

### Task 10: CONTRIBUTING.md

**Files:**

- Create: `CONTRIBUTING.md`

- [ ] **Step 1: Create contributing guide**

````markdown
# Contributing to Spatula

Thank you for your interest in contributing! This guide covers how to set up your development environment and submit changes.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 9.15+
- Docker (for PostgreSQL and Redis)
- Playwright browsers: `npx playwright install`

### Setup

```bash
# Clone and install
git clone https://github.com/spatulaai/spatula.git
cd spatula
pnpm install

# Start database services
docker compose up -d

# Copy environment config
cp .env.example .env
# Edit .env with your settings (at minimum: OPENROUTER_API_KEY)

# Run database migrations
pnpm --filter @spatula/db migrate

# Build all packages
pnpm build

# Run tests
pnpm test
```
````

## Development Workflow

### Branch Naming

- `feat/short-description` — new features
- `fix/short-description` — bug fixes
- `docs/short-description` — documentation
- `refactor/short-description` — code restructuring

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add parquet export format
fix: handle null fields in CSV exporter
docs: update CLI command reference
test: add schema evolution edge cases
chore: update dependencies
```

Scopes are optional but helpful for monorepo navigation:

```
feat(core): add CSS selector extraction fallback
fix(api): return 404 for cross-tenant action approve
```

## Code Style

- **ESLint** — `pnpm lint` (auto-fixable: `pnpm lint --fix`)
- **Prettier** — `pnpm format:check` (auto-fix: `pnpm format`)
- **TypeScript** — strict mode, `pnpm typecheck`

All three run in CI on every push.

## Testing

```bash
# Run all unit tests
pnpm test

# Run E2E tests (requires Docker services running)
pnpm test:e2e

# Run tests for a specific package
pnpm --filter @spatula/core test

# Run a specific test file
pnpm --filter @spatula/core test -- src/tests/unit/extraction/llm-extractor.test.ts
```

### Test Guidelines

- Place tests next to source files or in a parallel `tests/` directory matching the source structure
- Unit tests: test individual functions/classes in isolation
- Integration tests: test interactions between components (may use in-memory SQLite)
- E2E tests: test full API workflows against Postgres + Redis (in `tests/e2e/`)

## Project Structure

```
spatula/
├── apps/
│   ├── api/          # Hono REST API server
│   └── cli/          # CLI + TUI application
├── packages/
│   ├── core/         # Types, interfaces, pipeline logic (no I/O deps)
│   ├── db/           # PostgreSQL + SQLite, Drizzle ORM
│   ├── queue/        # BullMQ workers, webhooks
│   └── shared/       # Logging, auth, metrics, errors
├── tests/
│   └── e2e/          # End-to-end API tests
├── examples/         # Example project configurations
└── docs/             # Architecture and design documentation
```

See [docs/architecture.md](docs/architecture.md) for a detailed architecture guide.

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with tests
3. Ensure all checks pass: `pnpm lint && pnpm typecheck && pnpm test`
4. Push and open a pull request
5. Fill out the PR template
6. Address review feedback

## Reporting Issues

Use [GitHub Issues](https://github.com/spatulaai/spatula/issues) with the provided templates:

- **Bug reports** — include steps to reproduce, expected vs actual behavior, and your environment
- **Feature requests** — describe the use case and proposed solution

For security vulnerabilities, see [SECURITY.md](SECURITY.md).

````

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: add contributing guide"
````

---

### Task 11: README.md

**Files:**

- Create: `README.md`

This is the main project README with all 12 sections from the spec.

- [ ] **Step 1: Create README**

````markdown
# Spatula

**AI-powered intelligent web crawling. Describe the data you want, get clean production-ready datasets.**

[![CI](https://github.com/spatulaai/spatula/actions/workflows/ci.yml/badge.svg)](https://github.com/spatulaai/spatula/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@spatula/cli.svg)](https://www.npmjs.com/package/@spatula/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is Spatula?

Spatula is an AI-powered web crawling platform that turns unstructured websites into clean, structured datasets. You describe the data you want in plain language, provide seed URLs, and Spatula handles the rest — crawling pages, extracting structured data with LLMs, evolving the schema as it discovers new fields, reconciling entities across sources, and exporting production-ready datasets. It works locally as a CLI tool or as a multi-tenant API server.

## Features

- **Natural language data description** — define what you want to extract in `spatula.yaml`, not XPath
- **LLM-powered extraction** — uses AI at every decision point with smart model routing for cost control
- **Automatic schema evolution** — discovers new fields as it crawls, with human-in-the-loop review
- **Entity reconciliation** — matches and merges the same entity found across different pages and sites
- **5 export formats** — JSON, CSV, Parquet, SQLite, DuckDB — all with field-level provenance
- **Dual execution mode** — run locally with SQLite or as a multi-tenant server with PostgreSQL + Redis
- **Pluggable crawlers** — Playwright (built-in) or Firecrawl (API-based)
- **Pluggable LLM providers** — OpenRouter (cloud) or Ollama (local, fully offline)
- **55 typed actions** — every mutation is a reviewable, auditable action
- **Interactive TUI** — explore data, review schema changes, and monitor crawls from the terminal

## Quickstart

### Local Mode

```bash
# Install
npm install -g @spatula/cli

# Create a project
mkdir my-project && cd my-project
spatula init

# Or start with the conversational wizard
spatula new

# Configure your LLM provider
spatula setup

# Run the crawl
spatula run

# Explore results
spatula explore

# Export
spatula export --format json
```

### Server Mode

```bash
# Clone the repository
git clone https://github.com/spatulaai/spatula.git
cd spatula

# Install dependencies
pnpm install

# Start PostgreSQL and Redis
docker compose up -d

# Configure environment
cp .env.example .env
# Edit .env — set at minimum: OPENROUTER_API_KEY

# Run database migrations
pnpm --filter @spatula/db migrate

# Start the API server
pnpm --filter @spatula/api start

# Start background workers
pnpm --filter @spatula/queue start:workers
```

The API is available at `http://localhost:3000`. Swagger UI is at `http://localhost:3000/api/docs`.

## Architecture Overview

```mermaid
graph TD
    subgraph Clients
        cli["CLI / TUI"]
        api_client["API Clients"]
    end

    subgraph Server
        api["Hono API<br/>@spatula/api"]
        queue["BullMQ Workers<br/>@spatula/queue"]
    end

    subgraph Core
        core["Pipeline Logic<br/>@spatula/core"]
    end

    subgraph Data
        pg["PostgreSQL"]
        redis["Redis"]
        sqlite["SQLite<br/>(local mode)"]
    end

    subgraph External
        llm["LLM<br/>(OpenRouter / Ollama)"]
        crawler["Crawler<br/>(Playwright / Firecrawl)"]
    end

    cli --> core
    cli --> sqlite
    api_client --> api
    api --> core
    api --> pg
    api --> redis
    queue --> core
    queue --> pg
    queue --> redis
    core --> llm
    core --> crawler
```

See [docs/architecture.md](docs/architecture.md) for the full architecture guide with data flow diagrams, interface maps, and the action taxonomy.

## Configuration

### Project Configuration (`spatula.yaml`)

```yaml
name: My Project
seeds:
  - https://example.com/products

fields:
  - product_name: string
  - price: currency
  - in_stock: boolean

depth: 3
limit: 1000
crawler: playwright
safety: balanced
```

See [examples/](examples/) for complete configuration examples covering ecommerce, news, and real estate use cases.

### Environment Variables

| Variable             | Required | Default                  | Description                                    |
| -------------------- | -------- | ------------------------ | ---------------------------------------------- |
| `OPENROUTER_API_KEY` | Yes\*    | —                        | OpenRouter API key for cloud LLM               |
| `OLLAMA_BASE_URL`    | No       | `http://localhost:11434` | Ollama endpoint for local LLM                  |
| `DATABASE_URL`       | Server   | —                        | PostgreSQL connection string                   |
| `REDIS_URL`          | Server   | —                        | Redis connection string                        |
| `AUTH_STRATEGY`      | No       | `none`                   | Auth mode: `none`, `api-key`, `jwt`            |
| `FIRECRAWL_API_KEY`  | No       | —                        | Firecrawl API key (if using Firecrawl crawler) |
| `CONTENT_STORE`      | No       | `filesystem`             | Storage backend: `filesystem` or `s3`          |
| `SENTRY_DSN`         | No       | —                        | Sentry error tracking endpoint                 |
| `LOG_LEVEL`          | No       | `info`                   | Log level: `debug`, `info`, `warn`, `error`    |

\* Not required when using Ollama. See [.env.example](.env.example) for the full list.

## CLI Usage

| Command              | Description                                        |
| -------------------- | -------------------------------------------------- |
| `spatula init`       | Initialize a new project in the current directory  |
| `spatula new`        | Interactive project creation wizard                |
| `spatula run`        | Run the crawl pipeline (press `[d]` for dashboard) |
| `spatula status`     | Show project status and run history                |
| `spatula explore`    | Browse extracted entities in a TUI                 |
| `spatula review`     | Review pending schema actions in a TUI             |
| `spatula export`     | Export data (json, csv, sqlite, parquet, duckdb)   |
| `spatula schema`     | View current schema and version history            |
| `spatula logs`       | View run logs (`--tail` for live follow)           |
| `spatula add <url>`  | Add seed URLs to the project                       |
| `spatula estimate`   | Estimate crawl cost before running                 |
| `spatula doctor`     | Diagnose environment and project health            |
| `spatula test <url>` | Test extraction on a single page                   |
| `spatula config`     | Open project config in your editor                 |
| `spatula setup`      | Reconfigure global settings (LLM, crawler)         |
| `spatula reset`      | Reset project data for a fresh crawl               |

## API Reference

The API server exposes a RESTful JSON API with OpenAPI documentation.

**Interactive docs:** `http://localhost:3000/api/docs` (Swagger UI)

**Key endpoints:**

| Method | Path                                             | Description                  |
| ------ | ------------------------------------------------ | ---------------------------- |
| `POST` | `/api/v1/jobs`                                   | Create a crawl job           |
| `GET`  | `/api/v1/jobs/:jobId`                            | Get job status               |
| `GET`  | `/api/v1/jobs/:jobId/entities`                   | List extracted entities      |
| `GET`  | `/api/v1/jobs/:jobId/schema`                     | Get current schema           |
| `GET`  | `/api/v1/jobs/:jobId/actions`                    | List pending actions         |
| `POST` | `/api/v1/jobs/:jobId/actions/:actionId/approve`  | Approve a schema action      |
| `POST` | `/api/v1/jobs/:jobId/export`                     | Create an export             |
| `GET`  | `/api/v1/jobs/:jobId/exports/:exportId/download` | Download export file         |
| `POST` | `/api/v1/actions/batch`                          | Bulk approve/reject actions  |
| `POST` | `/api/v1/jobs/batch`                             | Bulk cancel/delete jobs      |
| `GET`  | `/api/v1/usage`                                  | LLM usage and cost breakdown |
| `GET`  | `/health`                                        | Health check                 |

All endpoints require authentication when `AUTH_STRATEGY` is set. See [.env.example](.env.example) for auth configuration.

## Export Formats

| Format  | Extension  | Best For                           | Streaming | Provenance |
| ------- | ---------- | ---------------------------------- | --------- | ---------- |
| JSON    | `.json`    | APIs, nested data                  | Yes       | Yes        |
| CSV     | `.csv`     | Spreadsheets, simple tabular data  | Yes       | No         |
| Parquet | `.parquet` | Big data analytics (Spark, DuckDB) | No        | Yes        |
| SQLite  | `.db`      | Local querying, portable database  | No        | Yes        |
| DuckDB  | `.duckdb`  | Analytics, columnar queries        | No        | Yes        |

```bash
# Export with provenance metadata
spatula export --format json --include-provenance

# Export only high-quality entities
spatula export --format csv --min-quality 0.8

# Export to a specific path
spatula export --format sqlite --output ./data/products.db
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Run E2E tests (requires Docker services)
pnpm test:e2e

# Lint
pnpm lint

# Type check
pnpm typecheck

# Format check
pnpm format:check
```

### Project Structure

```
spatula/
├── apps/
│   ├── api/          # Hono REST API server
│   └── cli/          # CLI + TUI application
├── packages/
│   ├── core/         # Types, interfaces, pipeline logic
│   ├── db/           # PostgreSQL + SQLite, Drizzle ORM
│   ├── queue/        # BullMQ workers, webhooks
│   └── shared/       # Logging, auth, metrics, errors
├── tests/e2e/        # End-to-end API tests
├── examples/         # Example project configurations
└── docs/             # Architecture and design docs
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and the pull request process.

## License

[MIT](LICENSE)
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add comprehensive project README"
```

---

### Task 12: Stale Documentation Cleanup

**Files:**

- Modify: `docs/superpowers/specs/wave-roadmap.md`
- Modify: `apps/cli/src/hooks/useJobPolling.ts` (line 1 — remove stale TODO)
- Modify: `apps/cli/src/commands/run.ts` (lines 16-19 — remove stale TODO)
- Modify: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md` (sections 8.3, 8.5, 9.7)
- Modify: `docs/superpowers/specs/2026-03-21-phase-13-project-folder-model-design.md` (section 7.4)

- [ ] **Step 1: Remove stale TODO from useJobPolling.ts**

In `apps/cli/src/hooks/useJobPolling.ts`, line 1, delete:

```typescript
// TODO(Wave 3-5): Accept DataSource instead of ApiClient for local mode — DONE
```

This work was completed in Wave 4-2 (hook adaptation to accept `DataSource | SpatulaApiClient`).

- [ ] **Step 2: Remove stale TODO from run.ts**

In `apps/cli/src/commands/run.ts`, lines 16-19, delete:

```typescript
 * TODO(Wave 3-5 Task 10): Structured file logging — add a Pino file transport
 * that writes newline-delimited JSON to `.spatula/logs/<run-id>.ndjson` so that
 * each run produces a persistent, machine-readable audit trail.  The transport
 * can be created with `pino.transport({ target: 'pino/file', options: { destination: logPath } })`
 * and passed as the second argument to `createLogger`.
```

Structured ndjson logging was implemented in Wave 3-5/4-3 (the `spatula logs` command reads these files).

- [ ] **Step 3: Update wave roadmap — mark Wave 4 complete**

In `docs/superpowers/specs/wave-roadmap.md`:

1. Update the status table (line 21): change Wave 4 status from `Pending` to `**Complete**`
2. Update Wave 5 scope to explicitly include deferred items:
   - Remote operations (`spatula remote`, `spatula push`, `spatula pull`)
   - `ApiDataSource` implementation
   - `spatula reset --keep-remote` flag
   - `spatula add` SQLite crawl history dedup
3. Update test counts section (line 341+): update from Wave 2 numbers to current totals (263 test files, ~2,100+ tests across all packages)
4. Add Wave 4 sub-plan completion table matching the pattern of Wave 3's table:

```markdown
| Sub-plan | Scope                                                                | Status       |
| -------- | -------------------------------------------------------------------- | ------------ |
| 4-1      | Server Completeness (webhooks, bulk ops, timeout, doctor)            | **Complete** |
| 4-2      | CLI Foundations (hook adaptation, utility commands, CSS extractor)   | **Complete** |
| 4-3      | CLI Data Commands (explore, export, review, schema, logs, dashboard) | **Complete** |
| 4-4      | Open-Source Readiness (LICENSE, README, docs, examples, templates)   | **Complete** |
```

- [ ] **Step 4: Annotate Phase 12 spec sections 8.3 and 8.5**

In `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`:

- Section 8.3 (line 1257): Add `> **Status: Completed in Wave 2** — Phase 13 Step 3 (Config System) implemented `spatula init` as part of the local project-folder model.` after the heading.
- Section 8.5 (line 1292): Add `> **Status: Completed in Wave 2** — Phase 13 Step 3 (Config System) implemented `spatula.yaml` as the project configuration format.` after the heading.

- [ ] **Step 5: Update Phase 12 spec section 9.7 filenames**

In `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`, section 9.7 (lines 1376-1383):

Replace all `job.yaml` references with `spatula.yaml` in the example directory tree.

- [ ] **Step 6: Annotate Phase 13 spec section 7.4**

In `docs/superpowers/specs/2026-03-21-phase-13-project-folder-model-design.md`:

- Section 7.4 (line 1390): Add `> **Status: Deferred to Wave 5** — Remote operations will be implemented in Phase 13 Step 6.` after the heading.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/hooks/useJobPolling.ts apps/cli/src/commands/run.ts docs/superpowers/specs/wave-roadmap.md docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md docs/superpowers/specs/2026-03-21-phase-13-project-folder-model-design.md
git commit -m "docs: clean up stale TODOs, annotate specs, mark Wave 4 complete"
```

---

## Execution Summary

| Task      | Files  | Description                           |
| --------- | ------ | ------------------------------------- |
| 1         | 1      | MIT license                           |
| 2         | 1      | Security policy                       |
| 3         | 1      | Expand .env.example                   |
| 4         | 7      | Package.json OSS metadata             |
| 5         | 3      | GitHub issue/PR templates             |
| 6         | 3      | Release-please automation             |
| 7         | 1      | Architecture documentation            |
| 8         | 9      | Example configurations                |
| 9         | 1      | Example YAML validation test          |
| 10        | 1      | Contributing guide                    |
| 11        | 1      | Project README                        |
| 12        | 5      | Stale docs cleanup + spec annotations |
| **Total** | **34** | **12 commits**                        |
