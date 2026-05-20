# M2M OIDC `client_credentials` E2E Suite

**Plan:** Phase 17 plan 17-07  
**Requirement:** AUTH-08  
**What it proves:** The full D-20 OIDC machine-to-machine chain — Dex service token → `createJob` → `listJobs` → `getEntities` via `@spatula/client`.

## Prerequisites

All three services must be running before you execute this suite:

### 1. Dex (local OIDC IDP)

```sh
cd examples/auth-dex
docker compose up -d
# Wait for healthy (< 10 seconds)
docker compose ps
```

Requires Docker 29+ and Compose v2+. Uses `ghcr.io/dexidp/dex:latest` (v2.46.0+) — the `client_credentials` grant was added in v2.46.0.

### 2. Postgres

Set `TEST_DATABASE_URL` or `DATABASE_URL`:

```sh
export TEST_DATABASE_URL=postgresql://spatula:spatula@localhost:5432/spatula_test
```

The suite runs against the same test database as the contract and isolation suites.

### 3. Redis

Set `REDIS_URL` (defaults to `redis://localhost:6379`):

```sh
export REDIS_URL=redis://localhost:6379
```

## Run Command

```sh
pnpm exec vitest run --config tests/e2e/m2m/vitest.config.ts
```

Or from the repo root:

```sh
pnpm dlx tsx examples/auth-dex/smoke/check-dex.ts  # verify Dex is up first
pnpm exec vitest run --config tests/e2e/m2m/vitest.config.ts
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_DATABASE_URL` | — | Postgres connection string (required; falls back to `DATABASE_URL`) |
| `DATABASE_URL` | — | Postgres fallback |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |

Dex constants are hardcoded to the dev-only values from `examples/auth-dex/config/dex.yaml`:

| Constant | Value |
|----------|-------|
| `DEX_ISSUER` | `http://localhost:5556/dex` |
| `M2M_CLIENT_ID` | `spatula-m2m` |
| `M2M_CLIENT_SECRET` | `dev-only-secret-m2m` (committed dev-only — DO NOT use in production) |

## CI Lane

This suite runs on the **e2e CI lane** (triggered on `main` and version tags), **not** on every PR. PRs run unit + contract + isolation suites only (no Docker dependency).

```yaml
# .github/workflows/e2e.yml (not yet created — add in Phase 20 CI plan)
on:
  push:
    branches: [main]
    tags: ['v*']
jobs:
  m2m-e2e:
    services:
      postgres: ...
      redis: ...
    steps:
      - run: cd examples/auth-dex && docker compose up -d
      - run: pnpm exec vitest run --config tests/e2e/m2m/vitest.config.ts
```

## What the Suite Tests

1. **Gate check**: Dex discovery doc is reachable (`http://localhost:5556/dex/.well-known/openid-configuration`). If Dex is not running, all steps emit a `console.warn` and return early without failing.
2. **Step 1 — Token grant**: `POST /token` with `grant_type=client_credentials`, `client_id=spatula-m2m`, `client_secret=dev-only-secret-m2m`. Asserts `access_token` is returned.
3. **Step 2 — JWT claims**: Decodes the JWT payload and asserts `iss`, `aud` includes `spatula-m2m`, and `sub` encodes `spatula-m2m` (Dex encodes `sub` as a base64url-encoded protobuf blob for client_credentials grants — see plan 17-05 SUMMARY deviation #2).
4. **Step 3 — createJob**: Boots a `JwtAuthProvider`-wired API server; calls `SpatulaClient.createJob()`. This exercises the `JwtAuthProvider` `user_tenants` auto-provision path (new M2M sub → tenant created automatically on first use).
5. **Step 4 — listJobs**: Calls `listJobs()` and asserts the just-created job appears.
6. **Step 5 — getEntities**: Calls `getEntities(jobId)` and asserts the response is a well-formed cursor envelope (empty list expected — the job hasn't crawled).

## Reference

- `examples/auth-dex/smoke/m2m-flow.ts` — the D-11 reference script this suite extends.
- `examples/auth-dex/smoke/check-dex.ts` — lightweight Dex health probe.
- Plan 17-05 SUMMARY — Dex `client_credentials` fix (v2.46.0+, protobuf sub encoding).
