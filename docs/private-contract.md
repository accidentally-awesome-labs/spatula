# Private Contract — OSS Surface Consumed by spatula-saas

This document is the authoritative enumeration of the TypeScript exports AND SQL schema entities from the Spatula OSS packages that the private `accidentally-awesome-labs/spatula-saas` repo imports or references. It is the third leg of the carve-out boundary (per CONTEXT.md decision D-03):

| Leg                | What it covers                                                                                                               | Where it lives                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| TS-surface freeze  | typed mock-consumer import block + negative-filter sweep over barrels                                                        | `tests/private-contract/oss-surface.test.ts`                                                |
| SQL-surface freeze | `pg_dump --schema-only` of fresh-applied `0000_v1_baseline.sql`, normalized + diffed against committed `baseline.schema.sql` | `tests/private-contract/schema-lint.test.ts` + `tests/private-contract/baseline.schema.sql` |
| Doc residuals      | runtime drift / RLS / trigger semantics / other gaps the two tests cannot catch                                              | **this document** (see [Residual Risk Register](#residual-risk-register) below)             |

Both tests run on every PR push (per CONTEXT.md D-04 cadence — wired into `.github/workflows/ci.yml` as the `test-private-contract` job). Any change to the surface enumerated below requires a matching change in `spatula-saas` and a composed-migration smoke run before any OSS GA tag (per spec §3.1.6).

---

## TS Surface — consumed packages

Five OSS packages form the consumed TypeScript surface. The mock-consumer import block at the top of `tests/private-contract/oss-surface.test.ts` mirrors realistic `spatula-saas` import shape; renaming or removing any pinned symbol below fails the PR.

### @spatula/core

Pure pipeline processors. `spatula-saas` composes the hosted-tier pipeline by wrapping these with its own quota / metering / payment-event glue.

| Export                   | Kind       | Notes                                                                                |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------ |
| `processCrawlTask`       | `function` | Crawl-task entry point — saas wraps with usage recording                             |
| `processSchemaEvolution` | `function` | Schema evolution job — saas wraps with batch-cost metering                           |
| `processReconciliation`  | `function` | Reconciliation job — saas wraps with per-entity counter                              |
| `processExport`          | `function` | Export orchestrator — saas wraps with format-availability check (saas-side, not OSS) |

### @spatula/db

Connection factories, repositories, and Drizzle schema definitions. `spatula-saas` reaches across the package barrel to define its own commercial-tier tables (subscriptions, usage_records, customer-payment-method records) that FK against the OSS tables.

**Connection factories:**

| Export                                  | Kind       | Notes                                                                       |
| --------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `createDatabase(connectionString?)`     | `function` | Returns a Drizzle client (Postgres node-postgres driver)                    |
| `createDatabasePool(connectionString?)` | `function` | Returns a `pg.Pool` for direct queries (saas uses for batch reconciliation) |

**Repositories:**

| Export                 | Kind  | Notes                                                           |
| ---------------------- | ----- | --------------------------------------------------------------- |
| `TenantRepository`     | class | CRUD + quota updates (saas reads to enforce tier defaults)      |
| `JobRepository`        | class | Job CRUD (saas reads for usage aggregation periodically)        |
| `ApiKeyRepository`     | class | API key issuance + rotation (saas handles key issuance UI side) |
| `DlqRepository`        | class | Dead-letter inspection (saas surfaces in admin UI)              |
| `UserTenantRepository` | class | OIDC user → tenant join (saas owns the user-tenant invite flow) |
| `AuditLogRepository`   | class | Append-only audit log (saas writes commercial-tier events)      |

**Drizzle schema objects** (full public schema — private repo's tables FK against these column types):

`tenants`, `jobs`, `apiKeys`, `userTenants`, `auditLog`, `entities`, `extractions`, `rawPages`, `crawlTasks`, `actions`, `exports`, `sourceTrust`, `content`, `deadLetterQueue`, `llmUsage`, `schemas`, `entitySources` — 17 tables.

### @spatula/queue

BullMQ queue definitions and the high-level `JobManager` orchestrator. `spatula-saas` consumes these to schedule its own worker jobs (commercial-tier reconciliation, retention-policy enforcement) on the same Redis instance.

| Export                    | Kind             | Notes                                                                    |
| ------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `createQueues(redisOpts)` | `function`       | Returns the `SpatulaQueues` bundle                                       |
| `QUEUE_NAMES`             | `const` (object) | Queue-name constants — saas references when adding adjacent queues       |
| `DEFAULT_QUEUE_CONFIG`    | `const` (object) | Sensible BullMQ defaults — saas extends with retry/backoff overrides     |
| `QUEUE_JOB_OPTIONS`       | `const` (object) | Per-job-type opts (retries, backoff, removeOnComplete)                   |
| `JobManager`              | class            | High-level enqueue/cancel/status — saas wraps with rate-limit middleware |

### @spatula/shared

Cross-cutting primitives: logger, config loader, auth providers, scopes, and the post-carve rate-limit default.

| Export                   | Kind             | Notes                                                                                |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------ |
| `createLogger(name)`     | `function`       | Pino logger factory (saas configures Sentry transport in its bootstrap)              |
| `loadConfig()`           | `function`       | Reads `spatula.yaml` + env into a typed `SpatulaConfig`                              |
| `DEFAULT_RATE_LIMIT`     | `const` (object) | Replaces pre-carve `RATE_LIMIT_TIERS` — saas substitutes its own per-tenant resolver |
| `AuthProvider`           | interface        | Pluggable auth — saas implements a `BillingAwareAuthProvider` (saas-side only)       |
| `ApiKeyAuthProvider`     | class            | OSS API-key provider — saas reuses for service-account scenarios                     |
| `JwtAuthProvider`        | class            | OIDC JWT provider — saas reuses for browser auth                                     |
| `TenantQuotas`           | interface        | Per-tenant quotas (no `rateLimitTier` field as of v1.1)                              |
| `DEFAULT_TENANT_QUOTAS`  | `const` (object) | Used by saas for new-tenant onboarding                                               |
| `AUTH_SCOPES`            | array            | All valid scopes (no `billing:*` scopes as of v1.1)                                  |
| `DEFAULT_API_KEY_SCOPES` | array            | Default scopes for a fresh API key                                                   |

### @spatula/api

The Hono app factory and dependency-injection types. `spatula-saas` mounts its commercial-tier routes onto the OSS-returned Hono instance.

| Export                     | Kind       | Notes                                                                                             |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `createApp(deps: AppDeps)` | `function` | Returns the configured Hono instance — saas mounts `/api/v1/billing/*` onto the same instance     |
| `AppDeps`                  | type       | DI shape (no `quotaEnforcer`, `usageRecordRepo`, or payment-client fields as of v1.1)             |
| `authRoutes()`             | `function` | New in v1.1 — mounts `GET /api/v1/auth/me`. Saas may swap with its own auth-introspection variant |

---

## SQL Surface — consumed entities

`spatula-saas` defines additional tables (e.g. `subscriptions`, `usage_records`, `customer_payment_methods`) that FK against the OSS public schema. The OSS entities listed below MUST NOT have their column names, types, or FK-target columns changed without a coordinated `spatula-saas` PR.

| OSS Table                         | Columns referenced by saas FKs                   | Notes                                                             |
| --------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| `tenants`                         | `id (uuid PK)`                                   | saas `subscriptions.tenant_id`, `usage_records.tenant_id` FK here |
| `jobs`                            | `id (uuid PK)`, `tenant_id (uuid)`               | saas `usage_records.job_id` FK                                    |
| `api_keys`                        | `id (uuid PK)`                                   | saas key-rotation flows reference by primary key                  |
| `audit_log`                       | `tenant_id (uuid)`, `created_at`                 | saas writes commercial-tier event rows into this table            |
| `users` (via `user_tenants` join) | `user_tenants.user_id`, `user_tenants.tenant_id` | saas invite flow inserts into `user_tenants`                      |

The SQL schema lint (`tests/private-contract/schema-lint.test.ts`) snapshots the full schema via `pg_dump --schema-only --no-owner --no-acl`, normalizes it through `scripts/normalize-schema-dump.sh` (Wave-4 normalizer — strips pg_dump 14+ `\restrict`/`\unrestrict` random-token noise + journal-row noise), and asserts byte-equality against `tests/private-contract/baseline.schema.sql`. Any drift in tables, columns, FKs, indexes, or CHECK constraints fails the PR.

---

## Residual Risk Register

The `tests/private-contract/` suite catches TS-symbol and SQL-schema changes. It does **not** catch the items listed below. These are acknowledged residuals — `spatula-saas` integration testing must validate them at its release boundary, and OSS PR reviewers must hand-check the relevant change classes.

| Risk                                                                                                         | Severity | Why test doesn't catch                                                                                                                                   | Mitigation owner                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Runtime-behavior drift (same TS signature, different returned data shape or side-effect ordering)            | MEDIUM   | TS surface test asserts symbol presence + `typeof`, not behavior                                                                                         | spatula-saas integration suite                                                                                                     |
| RLS policy / trigger semantic changes on consumed tables                                                     | MEDIUM   | `pg_dump --schema-only` emits RLS/trigger declarations but the normalizer does not deeply compare trigger function bodies (signature changes ARE caught) | spatula-saas pre-release integration                                                                                               |
| Postgres stored-procedure semantic changes (function body edits that preserve signature)                     | LOW      | Not currently any such surface in OSS — flag if added                                                                                                    | n/a today; OSS PR review if added                                                                                                  |
| Column-default value changes that silently re-shape inserted rows                                            | MEDIUM   | Schema lint catches default _literal_ changes; downstream data-flow impact requires manual review                                                        | OSS PR review + spatula-saas integration                                                                                           |
| Drizzle ORM major-version drift changing query serialization                                                 | LOW      | Test runs against current Drizzle; major-version bump triggers a re-baseline regeneration                                                                | OSS dependency PR review                                                                                                           |
| TypeScript type-shape drift inside an unchanged symbol (e.g. parameter type narrowed, return shape modified) | MEDIUM   | TS surface test only asserts symbol existence and `typeof`; type-shape drift surfaces at saas-side `tsc` build time                                      | saas-side `tsc` build (consumer-side `pnpm build` is the catch-all)                                                                |
| Database-level grants and role changes                                                                       | LOW      | Stripped by `pg_dump --no-acl`                                                                                                                           | Out of scope — operator-managed                                                                                                    |
| Migration-journal divergence between OSS + saas                                                              | LOW      | Two journals (`__drizzle_migrations_oss` + `__drizzle_migrations_saas`) are non-overlapping by design                                                    | Tracking table naming is pinned in `packages/db/drizzle.config.ts`, `packages/db/src/migrate.ts`, `packages/db/src/run-migrate.ts` |

---

## Changing this surface

Any OSS PR that alters exports or schema entities listed above MUST:

1. Update this document (`docs/private-contract.md`).
2. Update `tests/private-contract/oss-surface.test.ts` and/or regenerate `tests/private-contract/baseline.schema.sql` to match (regeneration procedure documented in `tests/private-contract/README.md`).
3. Open a mirror PR in `accidentally-awesome-labs/spatula-saas` adapting the consumer code.
4. Apply the GitHub label `private-contract-change` to the OSS PR so reviewers know to wait for the spatula-saas mirror.
5. Block the OSS GA tag until the spatula-saas mirror PR is merged + its CI is green.

The OSS PR's description must include the spatula-saas mirror PR URL.

---

## Two-journal migration model

The OSS repo uses migration tracking table `__drizzle_migrations_oss` (configured in `packages/db/drizzle.config.ts` since v1.1, Phase 15). The private spatula-saas repo uses `__drizzle_migrations_saas`. The two journals never share state. A single Postgres instance can host both repos' migrations side-by-side without conflict — the `drizzle` schema's namespace allows distinct tracking tables alongside each other.

See [`docs/runbooks/upgrade.md`](./runbooks/upgrade.md) for the schema-change policy (expand-contract only, no-migration-downgrade) that governs all post-v1 changes to the consumed surface.

---

_Phase: 15-carveout-migration-squash_
_Authored: 2026-05-17 (Plan 15-06)_
