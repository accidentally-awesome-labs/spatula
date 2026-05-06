# Milestones

History of shipped milestones. Bootstrapped 2026-05-06 from existing wave roadmap and git history.

---

## v1.0 — Foundation through Hosted Platform

**Status:** Complete (2026-04-20)
**Span:** 2026-03-06 (design approved) → 2026-04-20 (post-Wave-5 cleanup)
**Outcome:** Production-shippable AI crawling platform with hosted API, multi-tenant billing, local-first CLI, and remote push/pull.

### Phases shipped

| # | Phase | Highlights |
|---|-------|------------|
| 1 | Foundation & Core Types | Monorepo, Zod schemas, action types, Drizzle schemas |
| 2 | Pluggable Crawler | Playwright + Firecrawl behind `Crawler` interface |
| 3 | LLM Integration & Static Extraction | OpenRouter client, three-tier model router, prompt library, heuristic fallbacks |
| 4 | Storage Layer | `ContentStore` interface (Postgres + local), repositories, hashing/dedup |
| 5 | Job Orchestration | BullMQ queues + workers (crawl/extract/schema/reconcile/export), retries, DLQ |
| 6 | Schema Evolution | Batched evaluation, distributed lock, action-driven mutations |
| 7 | Data Reconciliation | Synonym detection → normalization → entity reconciliation with provenance |
| 8 | API Server | Hono routes, OpenAPI, WebSockets, Bull Board admin |
| 9a | CLI Core / Conversational | `init`, `run`, `status`, `reset`, conversational Ink prompts |
| 9b | Dashboard + Review Mode | Live progress dashboard, action review TUI |
| 9c | Results Explorer | Entity explorer Ink TUI |
| 10 | Export Pipeline | JSON / CSV / Parquet / SQLite / DuckDB exporters with cursor pagination |
| 11a/b/c/d | Minimal Viable E2E + hardening + DX | E2E happy path, action exec/review, hardening, developer-experience polish |
| 12 (interleaved as Waves 1–5) | Production hardening | Lifecycle, reliability, auth, observability, perf, completeness, OSS, hosted layer |
| 13 (interleaved as Waves 1–5) | Local project-folder model | Orchestrator extraction, SQLite schema, config system, LocalPipelineRunner, data commands, remote ops |

### Wave-by-wave summary

| Wave | Theme | Server side | Local side | Status |
|------|-------|-------------|------------|--------|
| 1 | Foundation | 12A: server lifecycle, pooling, CI/CD, containers | 13.1: orchestrator extraction | ✓ |
| 2 | Resilience & Local Data Layer | 12D/F/J: circuit breaker, DLQ, robots/budget, Ollama, cost estimate | 13.2/3: SQLite schema + repos, YAML config, diff engine | ✓ |
| 3 | Auth, Observability & Local Execution | 12B/C/E + D/F deferred: auth (API key + JWT), OTel + Sentry, S3, streaming, indexes, Redis cache, idempotency, worker health, quality API | 13.4: `LocalPipelineRunner`, `DataSource`, core CLI | ✓ |
| 4 | API Completeness & OSS Release | 12G/H: webhooks, bulk ops, doctor, request timeout, MIT license, README, CONTRIBUTING, examples, release-please | 13.5: data interaction commands (`explore`, `export`, `review`, `schema`, `logs`, etc.) | ✓ |
| 5 | Hosted Platform & Remote Ops | 12I: JWT/OIDC users, Stripe billing (4 tiers), metering, 11 admin routes, retention | 13.6: `remote add/list/remove`, `push`, `pull`, `ApiDataSource` | ✓ |

### Wave-5 deferred items + post-review cleanup

- **Wave 5-6:** `spatula add` history dedup, CSS-extractor table extraction, `reset --keep-remote`, `ApiDataSource`, audit logging for quota events, OpenRouter cost extraction via `x-openrouter-cost`, observable gauges (`active_jobs`, `tenant_count`, `queue_depth`).
- **2026-04-20 cleanup:** Five defects closed (composite cursor, within-batch dup count, error boundaries, orphan `entity_sources`, `queue_depth` wiring) plus three TS fixes and migration centralization via `vitest globalSetup`.

### Tests at close

~294 test files across 5 packages; 2,302 unit + 71 integration tests in the SQLite/CLI flow alone.

### Artifacts

- Design doc: `docs/plans/2026-03-06-spatula-design.md`
- Phase plans: `docs/plans/2026-03-06-phase-1-foundation.md` … `2026-03-13-phase-9b-dashboard-review-mode.md`
- Wave plans: `docs/superpowers/plans/` (30+ plan files)
- Wave specs: `docs/superpowers/specs/` (decomposition + design specs)
- Wave roadmap: `docs/superpowers/specs/wave-roadmap.md`

### Carry-over into v1.1

The following are **planned but not yet executed** at v1.0 close:

- Wave 6 / Phase 14 public-launch design spec — `docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md`
- Wave 6-1 carve-out + migration squash implementation plan — `docs/superpowers/plans/2026-04-20-wave-6-1-carveout-migration-squash.md`

Whether these become v1.1 phases (or are superseded) is a v1.1 scoping decision.

---
