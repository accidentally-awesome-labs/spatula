# Feature Verification

This page maps Spatula's public feature claims to the checks that exercise them.
It is intended for maintainers preparing a public release and for contributors
who need to know where behavior is covered.

## User-facing features

| Feature                                                                   | Primary implementation                                                                | Verification                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local project setup (`spatula init`, `spatula new`)                       | `apps/cli/src/commands/init.ts`, `apps/cli/src/commands/new.tsx`                      | `apps/cli/tests/unit/commands/init.test.ts`, `apps/cli/tests/unit/commands/new*.test.tsx`, `apps/cli/tests/e2e/workflow.test.ts`                                                                                                                                                        |
| Local crawl pipeline (`spatula run`)                                      | `packages/core/src/pipeline/local-pipeline-runner.ts`, `apps/cli/src/commands/run.ts` | `packages/core/tests/unit/pipeline/local-pipeline-runner.test.ts`, `apps/cli/tests/e2e/tier2/pipeline-*.test.ts`                                                                                                                                                                        |
| Single-page extraction test (`spatula test <url>`)                        | `apps/cli/src/commands/test-url.ts`                                                   | `apps/cli/tests/unit/commands/test-url.test.ts`                                                                                                                                                                                                                                         |
| Interactive TUI modes: dashboard, review, explorer                        | `apps/cli/src/components/**`                                                          | `apps/cli/tests/unit/components/**`, `apps/cli/tests/e2e/tui-rendering.test.ts`                                                                                                                                                                                                         |
| Project data commands: status, schema, logs, add, config, reset, estimate | `apps/cli/src/commands/*.ts`                                                          | `apps/cli/tests/unit/commands/*.test.ts`, `apps/cli/tests/integration/project-commands.test.ts`, `apps/cli/tests/integration/data-commands.test.ts`                                                                                                                                     |
| Export formats: JSON, CSV, Parquet, SQLite, DuckDB                        | `packages/core/src/exporters/**`, `apps/cli/src/commands/export.ts`                   | `packages/core/tests/unit/exporters/*.test.ts`, `apps/cli/tests/unit/commands/export.test.ts`                                                                                                                                                                                           |
| JSON provenance export                                                    | `packages/core/src/exporters/json-exporter.ts`                                        | `packages/core/tests/unit/exporters/json-exporter.test.ts`, `packages/core/tests/unit/pipeline/export-orchestrator.test.ts`                                                                                                                                                             |
| Pluggable crawlers: Playwright and Firecrawl                              | `packages/core/src/crawlers/**`                                                       | `packages/core/tests/unit/crawlers/*.test.ts`, `apps/cli/tests/e2e/tier4/firecrawl-integration.test.ts`                                                                                                                                                                                 |
| Pluggable LLM providers: OpenRouter and Ollama                            | `packages/core/src/llm/**`                                                            | `packages/core/tests/unit/llm/*.test.ts`, `apps/cli/tests/e2e/tier4/openrouter-integration.test.ts`, adversarial CI workflow                                                                                                                                                            |
| Schema evolution and action review                                        | `packages/core/src/evolution/**`, `packages/core/src/execution/**`                    | `packages/core/tests/unit/evolution/*.test.ts`, `packages/core/tests/unit/pipeline/schema-orchestrator.test.ts`, `packages/core/tests/unit/types/actions.test.ts`, `packages/core/tests/unit/execution/action-executor-impl.test.ts`, `apps/cli/tests/unit/commands/review-cmd.test.ts` |
| Entity reconciliation and normalization                                   | `packages/core/src/reconciliation/**`                                                 | `packages/core/tests/unit/reconciliation/*.test.ts`, `packages/core/tests/unit/pipeline/reconcile-orchestrator.test.ts`                                                                                                                                                                 |
| Self-hosted REST API and OpenAPI contract                                 | `apps/api/src/**`, `packages/client/src/**`                                           | `tests/contract/*.test.ts`, `tests/e2e/full-pipeline.test.ts`                                                                                                                                                                                                                           |
| Queue workers and job lifecycle                                           | `packages/queue/src/**`                                                               | `apps/cli/tests/e2e/tier5/tier5a/*.test.ts`                                                                                                                                                                                                                                             |
| Auth, scopes, CORS, rate limiting, idempotency                            | `apps/api/src/auth/**`, `apps/api/src/middleware/**`                                  | `apps/cli/tests/e2e/tier5/tier5b/*.test.ts`, `tests/e2e/browser`, `tests/e2e/m2m`                                                                                                                                                                                                       |
| Webhooks and DLQ handling                                                 | `packages/queue/src/webhook-*.ts`, `apps/api/src/routes/admin-dlq.ts`                 | `apps/cli/tests/e2e/tier5/tier5a/webhook-delivery.test.ts`, `packages/queue/tests/unit/webhook-worker.test.ts`, `packages/queue/tests/unit/dlq-handler.test.ts`                                                                                                                         |
| Backup, restore, upgrade, support matrix                                  | `docs/runbooks/**`, `packages/db/src/**`                                              | `tests/e2e/backup/round-trip.test.ts`, `tests/upgrade/migrate-and-verify.test.ts`, `.github/workflows/support-matrix.yml`                                                                                                                                                               |

## Release verification

Run the standard PR gate before publishing:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm test:contract
pnpm test:private-contract
```

Run the public docs guard when changing README, package docs, examples, or
active docs:

```bash
pnpm test:contract -- public-docs
```

Run optional live checks only when you have real crawler and LLM credentials.
These checks make network calls and can incur provider cost:

```bash
SPATULA_LIVE_LLM=1 SPATULA_API_URL=http://localhost:3000 pnpm live:matrix
SPATULA_LIVE_LLM=1 SPATULA_API_URL=http://localhost:3000 pnpm sizing:baseline
```

The live matrix intentionally covers repeated cards, tables, single-detail
pages, profile pages, JSON-like documents, and legacy layouts. It is a release
confidence check, not a substitute for the deterministic unit, integration, E2E,
and contract suites.
