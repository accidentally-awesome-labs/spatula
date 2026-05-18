# Wave 4 Decomposition Design: API Completeness & Open-Source Release

**Status:** Approved
**Created:** 2026-03-31
**Scope:** Decompose Wave 4 into ordered implementation sub-plans. This wave concludes with the open-source release.

---

## 1. Overview

Wave 4 covers 3 workstreams across Phase 12 (server) and Phase 13 (local):

- **Phase 12G:** API & CLI Completeness (webhooks, bulk operations, diagnostics, timeout)
- **Phase 12H:** Open-Source Readiness (licensing, docs, community infrastructure)
- **Phase 13 Step 5:** Data Interaction Commands (explore, export, review, schema, logs, utility commands)

**Strategy:** Server-first, then CLI foundations, then CLI data commands, then documentation. Server features (4-1) are self-contained. CLI foundations (4-2) adapt hooks and add utility commands. CLI data commands (4-3) build TUI features on adapted hooks. Documentation (4-4) is last to ensure accuracy against final feature set.

**Baseline:** 1,958 tests across 6 packages at Wave 3 completion.

**Decision:** Remote operations (`spatula remote`, `spatula push`, `spatula pull`) are deferred to Wave 5 (Phase 13 Step 6). Wave 4 delivers a fully functional local experience + server completeness for the open-source release.

---

## 2. Sub-plan Summary

| Sub-plan | Scope                 | Spec Sections         | Est. New Files | Order |
| -------- | --------------------- | --------------------- | -------------- | ----- |
| **4-1**  | Server Completeness   | 12: 8.1–8.2, 8.4, 8.6 | ~12            | 1     |
| **4-2**  | CLI Foundations       | 13: 7.2–7.3, 7.5, 7.7 | ~15            | 2     |
| **4-3**  | CLI Data Commands     | 13: 7.2, 4.5          | ~12            | 3     |
| **4-4**  | Open-Source Readiness | 12: 9.1–9.7           | ~15            | 4     |

**Execution order:**

```
4-1 → 4-2 → 4-3 → 4-4
```

---

## 3. Dependency Graph

```
4-1 (Server Completeness)
  │  Provides: webhooks, bulk ops, timeout, HealthCheck registry, doctor system/server checks
  │
  └──→ 4-2 (CLI Foundations)
         Provides: openLocalProject utility, adapted hooks (DataSource), utility commands,
                   doctor project checks, CSS extractor, legacy migration
         Uses: HealthCheck registry from 4-1
         │
         └──→ 4-3 (CLI Data Commands)
                Provides: explore, export, review, schema, logs TUI commands, dashboard mode
                Uses: adapted hooks from 4-2, openLocalProject from 4-2
                │
                └──→ 4-4 (Open-Source Readiness)
                       Provides: LICENSE, README, CONTRIBUTING, CHANGELOG, templates,
                                 architecture docs, examples, .env.example, docs cleanup
                       Uses: final feature set from 4-1 + 4-2 + 4-3 for accurate docs
```

**Note:** 4-1 and 4-2 are partially independent — 4-2 only depends on 4-1 for the HealthCheck registry (doctor project checks). The remaining 4-2 deliverables (hook adaptation, utility commands, CSS extractor) have no server dependency. However, linear execution is simpler and avoids merge conflicts.

---

## 4. Sub-plan Details

### 4.1 Sub-plan 4-1: Server Completeness

**Goal:** Add remaining server-side API features — webhook delivery, bulk operations, request timeout, and system/server health checks with a pluggable diagnostic framework.

**Deliverables:**

1. **WebhookSender** (`packages/queue/src/webhook-sender.ts`) — serializes event as JSON, signs with HMAC-SHA256 if secret provided (sets `X-Spatula-Signature` header), POSTs with 10s timeout. Used by the webhook worker.

2. **Webhook BullMQ queue + worker** — add `WEBHOOK: 'spatula.webhooks'` to `QUEUE_NAMES` in `packages/queue/src/queues.ts`. Update `createQueues()` and `SpatulaQueues` interface. New `packages/queue/src/webhook-worker.ts` consuming the queue with 3 retries (1min, 5min, 30min exponential backoff). Register in `worker-entrypoint.ts`.

3. **Bull Board update** — add 6th queue adapter for `spatula.webhooks` in `apps/api/src/routes/admin-queues.ts`.

4. **Webhook event payload type** (`packages/shared/src/webhook-types.ts`):

   ```typescript
   interface WebhookEvent {
     id: string; // evt_<nanoid>
     type: WebhookEventType; // job.completed | job.failed | job.cancelled | export.completed | action.pending
     timestamp: string; // ISO 8601
     data: {
       jobId: string;
       tenantId: string;
       status?: string;
       entityCount?: number;
       duration?: number;
     };
   }
   ```

5. **JobConfig schema extension** — extend job creation Zod schema with optional `webhooks` field: `url` (required URL), `secret` (optional, min 16 chars), `events` (array from allowed set, default: `['job.completed', 'job.failed']`).

6. **Webhook event integration** — fire webhook events from 5 existing code paths:
   - `job.completed` / `job.failed` — job status transitions in queue workers
   - `job.cancelled` — job cancellation route handler
   - `export.completed` — export orchestrator completion
   - `action.pending` — schema evolution when actions are created

7. **Bulk operations** — two new route files:
   - `apps/api/src/routes/batch-actions.ts` — `POST /api/v1/actions/batch` with `{ action: 'approve' | 'reject', ids: string[] }`, max 100. Requires `actions:write` scope. Partial success response.
   - `apps/api/src/routes/batch-jobs.ts` — `POST /api/v1/jobs/batch` with `{ action: 'cancel' | 'delete', ids: string[] }`, max 100. Requires `jobs:write` scope. Partial success response.
   - Response: `{ data: { succeeded: string[], failed: { id: string, error: string }[] } }`

8. **Request timeout middleware** (`apps/api/src/middleware/timeout.ts`) — Hono middleware, 30s default, 5min for export download endpoint, returns 504 on timeout. Slots into middleware chain early (after security headers, before auth).

9. **HealthCheck interface + pluggable registry** (`packages/core/src/diagnostics/health-check.ts`):

   ```typescript
   interface HealthCheck {
     name: string;
     category: 'system' | 'server' | 'project';
     run(): Promise<{ status: 'pass' | 'fail' | 'warn'; message: string }>;
   }
   ```

   Registry with `registerCheck(check)` and `runChecks(categories)`.

10. **System checks** (`packages/core/src/diagnostics/system-checks.ts`) — 5 checks:
    - Node.js version >= 22
    - Docker available (`docker info`)
    - LLM provider reachable (Ollama: `GET /api/tags`, OpenRouter: key validation)
    - Playwright browsers installed (if crawler = playwright)
    - `.env` exists and has required keys (required key list defined here)

11. **Server checks** (`packages/core/src/diagnostics/server-checks.ts`) — 4 checks:
    - Postgres reachable (connection test)
    - Redis reachable (PING)
    - API server reachable (`GET /health/ready`)
    - Migrations up to date (compare applied vs available)

12. **Doctor command** (`apps/cli/src/commands/doctor.ts`) — runs applicable checks by context: always `system`, `server` if `.env` exists, `project` if `spatula.yaml` exists (project checks added in 4-2). Formatted pass/fail/warn output.

**New env vars:** None (webhook config is per-job, not global).

**Existing test impact:** All 1,958 tests continue passing. New tests are additive.

**Spec references:** Phase 12, sections 8.1–8.2, 8.4, 8.6

---

### 4.2 Sub-plan 4-2: CLI Foundations

**Goal:** Adapt CLI hooks from ApiClient to DataSource, implement utility commands, add doctor project checks, build CSS-only extractor, and migrate legacy commands. This is the prerequisite work that enables TUI data commands in 4-3.

**Deliverables:**

1. **Shared project utility** (`apps/cli/src/local-project.ts`) — `openLocalProject(cwd)` function that: finds project root (walks up for `spatula.yaml`), opens SQLite DB, creates `ProjectAdapter`, wraps in `LocalDataSource`, returns `{ dataSource, adapter, db, projectRoot, close() }`. Handles error cases (no project found, corrupt DB) with clear messages. Ensures `close()` is always called via try/finally patterns. Eliminates the duplicated setup logic currently in `run.ts` and `status.ts`.

2. **Hook adaptation** — refactor 4 hooks to accept `DataSource | SpatulaApiClient`:
   - `apps/cli/src/hooks/useJobPolling.ts` — local: `dataSource.getStatus()`, `dataSource.getSchema()`, `dataSource.getActions()`, `dataSource.getEntities()`
   - `apps/cli/src/hooks/useEntityData.ts` — local: `dataSource.getEntities(query)` with pagination
   - `apps/cli/src/hooks/useEntityFilter.ts` — local: `dataSource.searchEntities(filter)` (in-memory), remote: API `search` param
   - `apps/cli/src/hooks/useExport.ts` — local: `dataSource.createExport()` calling export orchestrator directly

3. **CSS-only extractor** (`packages/core/src/extraction/css-extractor.ts`) — implements `Extractor` interface using auto-detected CSS selectors (headings, prices, images, links, lists, tables). No LLM dependency — works fully offline. Wire into `apps/cli/src/commands/test-url.ts` in two paths: (a) explicit `--skip-llm` flag, and (b) automatic fallback when no LLM provider is configured (per Phase 13 spec 7.2: "falls back to static extraction with auto-detected CSS selectors and prints a hint to configure an LLM for better results"). Replaces current TODO stub.

4. **Doctor project checks** (`packages/core/src/diagnostics/project-checks.ts`) — 8 checks registered into 4-1's pluggable registry:
   - `spatula.yaml` valid (parses against config schema)
   - `.spatula/project.db` integrity (`PRAGMA integrity_check`)
   - SQLite WAL mode active
   - Orphaned `in_progress` crawl tasks (indicates prior crash)
   - Missing page files for pending re-extraction
   - Pending review actions count
   - Disk usage breakdown (pages, DB, exports)
   - Remote link status (if remotes configured — deferred until Wave 5 remote support)

5. **Utility commands** (new files):
   - `apps/cli/src/commands/add.ts` — `spatula add <url> [url...]`: validate URLs, dedup against existing seeds in `spatula.yaml` AND crawl history in SQLite task table (via `openLocalProject`), write back to YAML.
   - `apps/cli/src/commands/config.ts` — `spatula config`: open `spatula.yaml` in `$EDITOR` (fallback: `vi`), using `child_process.spawn` with `stdio: 'inherit'`.
   - `apps/cli/src/commands/setup.ts` — `spatula setup`: interactive menu to reconfigure `~/.spatula/config.yaml` (LLM provider, API keys, default crawler, proxy settings).
   - `apps/cli/src/commands/estimate.ts` — `spatula estimate`: load project config via `openLocalProject`, call existing `estimateCost()`, format as table showing per-category breakdown with confidence level.

6. **`spatula new` local adaptation** — modify `apps/cli/src/commands/new.tsx`: when no `--api-url` is provided, write conversational output to `spatula.yaml` + create `.spatula/` directory instead of calling `apiClient.createJob()`.

7. **Legacy command migration** (spec 7.7):
   - `spatula list` — add deprecation warning: "Use `spatula remote jobs <name>` (coming in a future release). For local project status, use `spatula status`."
   - `spatula status <jobId>` (with explicit jobId arg in remote/API mode) — add deprecation notice pointing to `spatula remote status <name>`.

8. **Command registration** — register `add`, `config`, `setup`, `estimate`, `doctor` in `apps/cli/src/index.tsx` with yargs.

**New env vars:** None.

**Spec references:** Phase 13, sections 7.2–7.3, 7.5, 7.7

---

### 4.3 Sub-plan 4-3: CLI Data Commands

**Goal:** Build TUI-based data interaction commands for exploring, exporting, reviewing, and inspecting crawl results locally. Reuse existing Ink components from Phases 9a-9c where possible.

**Deliverables:**

1. **`spatula explore`** (`apps/cli/src/commands/explore.tsx`) — entity browser TUI:
   - Paginated entity list (reuse `components/explorer/` with adapted `useEntityData` hook)
   - Filter/search bar (adapted `useEntityFilter` — in-memory for <500 entities)
   - Entity detail view (select → show all fields + provenance)
   - Sort by field name, quality score, or creation date
   - Keyboard: `↑↓` navigate, `Enter` detail view, `/` search, `q` quit, `e` export selected
   - Uses `openLocalProject` from 4-2

2. **`spatula export`** (`apps/cli/src/commands/export.ts`) — non-interactive local export:
   - `--format` flag: json (default), csv, sqlite, parquet, duckdb
   - `--output` flag: output path (default: `.spatula/exports/<timestamp>.<format>`)
   - `--include-provenance` flag (JSON only)
   - `--min-quality` flag (filter by quality score)
   - Calls `processExport()` orchestrator directly via `openLocalProject`
   - Progress output: entity count, file size, path written

3. **`spatula review`** (`apps/cli/src/commands/review.tsx`) — action review TUI:
   - List of pending schema actions (reuse `components/review/` with adapted hooks)
   - For each action: what changed, why (extraction evidence), impact
   - Keyboard: `y` approve, `n` reject, `s` skip, `a` approve all, `q` quit
   - Uses `dataSource.getActions('pending')`, `dataSource.approveAction()`, `dataSource.rejectAction()`
   - Summary on exit: "Approved 3, rejected 1, 2 remaining"

4. **`spatula schema`** (`apps/cli/src/commands/schema.ts`) — non-interactive schema viewer:
   - Current schema version, field count
   - Field table: name, type, required, description, source (user-defined vs discovered)
   - `--versions` flag: show version history with diff summary per version
   - `--json` flag: output raw schema as JSON
   - Uses `dataSource.getSchema()` and `dataSource.getSchemaVersions()`

5. **`spatula logs`** (`apps/cli/src/commands/logs.ts`) — run log viewer:
   - Defaults to latest run's log file (`.spatula/logs/<latest>.log`)
   - `--run <id>` flag: view specific run's log
   - `--errors` flag: filter to error-level entries only
   - `--tail` flag: follow mode using `fs.watch` (prints new lines as they appear)
   - Reads ndjson log files created by `spatula run`, formatted output: timestamp, level, message, key fields

6. **Dashboard mode `[d]`** — enhance `spatula run` with `[d]` keybinding:
   - Pressing `[d]` during `spatula run` expands the compact progress line into a full Ink TUI dashboard
   - Multi-panel view: pages being crawled, entity count, schema evolution, errors
   - Uses adapted hooks from 4-2 for live data
   - Dismiss with `[d]` again or `Esc`, returns to compact progress line

7. **Command registration** — register `explore`, `export`, `review`, `schema`, `logs` in `apps/cli/src/index.tsx`.

**New env vars:** None.

**Spec references:** Phase 13, sections 7.2, 4.5

---

### 4.4 Sub-plan 4-4: Open-Source Readiness

**Goal:** Everything needed for the public open-source release — licensing, documentation, community infrastructure, examples, and cleanup of stale documentation.

**Deliverables:**

1. **License** — `LICENSE` at project root, MIT.

2. **Security policy** — `SECURITY.md` at project root. How to report vulnerabilities (email, not public issues), expected response time, scope of supported versions. _(Added beyond Phase 12 spec — standard for open-source projects.)_

3. **README.md** — 12 sections:
   - Hero: one-line description + badge row (CI status, license, npm version)
   - What is Spatula?: 3-sentence elevator pitch
   - Features: bullet list of core capabilities
   - Quickstart: 5-step setup covering BOTH local mode (`spatula init` + `spatula run`) and server mode (docker-compose, .env, migrations)
   - Architecture Overview: Mermaid package diagram + data flow diagram
   - Configuration: env var table with descriptions, defaults, required/optional
   - CLI Usage: command reference table with examples for all commands
   - API Reference: link to Swagger UI at `/api/docs`
   - Export Formats: table of 5 formats with features (streaming, provenance, use case)
   - Development: run tests, lint, build, project structure overview
   - Contributing: link to CONTRIBUTING.md
   - License: MIT

4. **CONTRIBUTING.md** — getting started (fork, clone, install, test), development workflow (branch naming, conventional commits), code style (eslint/prettier refs), testing guide, PR process, architecture guide (link to `docs/architecture.md`), reporting issues.

5. **CHANGELOG automation** — `.github/workflows/release-please.yml` GitHub Action using `release-please` for conventional commit changelog generation. `release-please-config.json` with monorepo config for all 6 packages.

6. **GitHub templates**:
   - `.github/ISSUE_TEMPLATE/bug_report.md` — steps to reproduce, expected vs actual, environment
   - `.github/ISSUE_TEMPLATE/feature_request.md` — use case, proposed solution, alternatives
   - `.github/PULL_REQUEST_TEMPLATE.md` — checklist (tests pass, lint clean, docs updated)

7. **Architecture documentation** (`docs/architecture.md`):
   - Package dependency diagram (Mermaid)
   - Data flow diagram: seed URL → crawl → extract → evolve schema → reconcile → export
   - Interface map: which interfaces exist and who implements them
   - Action type taxonomy: pipeline vs config actions
   - LLM usage map: where AI is called and which model tier

8. **Example configurations** (`examples/`):
   - `examples/quickstart/` — simple single-site crawl (`spatula.yaml` + `docker-compose.yml` + `README.md`)
   - `examples/ecommerce/` — multi-site product catalog (`spatula.yaml` + `README.md`)
   - `examples/news/` — news article aggregation (`spatula.yaml` + `README.md`)
   - `examples/real-estate/` — property listing extraction (`spatula.yaml` + `README.md`)

9. **`.env.example` update** — add ALL env vars from Waves 1-4 organized by category. The implementer must audit every sub-plan's "New env vars" section and grep the codebase for `process.env.` references. Categories include (not exhaustive):
   - Database: `DATABASE_URL`, `TEST_DATABASE_URL`
   - Redis: `REDIS_URL`
   - Auth: `AUTH_STRATEGY`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_JWKS_URL`
   - LLM: `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`, `OPENROUTER_BASE_URL`
   - Crawlers: `FIRECRAWL_API_KEY`
   - Storage: `CONTENT_STORE`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
   - Observability: `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `OTEL_EXPORTER_PROMETHEUS_PORT`, `OTEL_EXPORTER_ENDPOINT`
   - Server: `CORS_ALLOWED_ORIGINS`, `PORT`
   - Workers: `SPATULA_WORKERS`

10. **Package.json metadata** — update all 6 package.json files (`core`, `db`, `queue`, `shared`, `api`, `cli`) with: `license: "MIT"`, `repository`, `description`, `keywords`, `homepage`, `bugs` fields. _(Added beyond Phase 12 spec — standard for npm packages.)_

11. **Stale documentation cleanup**:
    - `docs/superpowers/specs/wave-roadmap.md` — mark Wave 4 complete, update final test counts, update Wave 5 scope to explicitly include remote operations deferred from Wave 4
    - Phase 12 spec — annotate sections 8.3 and 8.5 as "Completed in Wave 2/3" where deferred items landed; update section 9.7 example filenames from `job.yaml` to `spatula.yaml`
    - Phase 13 spec — annotate section 7.4 (Remote Operations) as "Deferred to Wave 5"
    - Remove or update stale TODO comments in code that reference completed work
    - Ensure `spatula reset --keep-remote` flag is documented as deferred to Wave 5 alongside remote ops

**New env vars:** None.

**Spec references:** Phase 12, sections 9.1–9.7

---

## 5. Cross-Cutting Concerns

### 5.1 Middleware Chain Order

The timeout middleware from 4-1 slots into the existing Hono middleware chain:

```
security-headers → timeout → cors → request-context → auth → validate-tenant → rate-limit → timing → routes
```

### 5.2 Test Impact

All new code is additive — no breaking changes to existing 1,958 tests. Each sub-plan adds its own test suite. Expected final test count: ~2,200+ (estimate).

### 5.3 AppDeps

No new fields expected in Wave 4. All infrastructure (Redis client, queue connections, auth, OTel) was established in Wave 3.

### 5.4 New Environment Variables

Wave 4 does not introduce new global environment variables. Webhook configuration is per-job (stored in `JobConfig`), not per-deployment.

### 5.5 Items Deferred to Wave 5

The following items from Phase 13 are explicitly deferred to Wave 5 (Phase 13 Step 6: Remote Operations):

- `spatula remote add/list/remove/status/jobs/start/pause/resume/cancel/watch/link/unlink`
- `spatula push` / `spatula pull`
- `ApiDataSource` implementation
- `spatula reset --keep-remote` flag
- Remote link status doctor check (placeholder registered in 4-2, implementation in Wave 5)

---

## 6. Dependency on Wave 3 Outputs

Wave 4 builds on these Wave 3 deliverables:

| Wave 3 Output                             | Used By                       |
| ----------------------------------------- | ----------------------------- |
| Auth middleware + scopes                  | 4-1 (bulk ops require scopes) |
| BullMQ queue infrastructure               | 4-1 (webhook queue)           |
| Bull Board (5 queues)                     | 4-1 (add 6th queue)           |
| Redis shared client                       | 4-1 (server health check)     |
| DataSource interface + LocalDataSource    | 4-2 (hook adaptation)         |
| ProjectAdapter + SQLite repos             | 4-2 (openLocalProject)        |
| Export orchestrator (5 formats)           | 4-3 (spatula export)          |
| `estimateCost()`                          | 4-2 (spatula estimate)        |
| `diffConfigs()`                           | Already wired in Wave 3       |
| Pipeline events + progress display        | 4-3 (dashboard mode)          |
| Config system (YAML parse, global config) | 4-2 (setup, config, add)      |
| Structured logging (ndjson)               | 4-3 (spatula logs)            |
