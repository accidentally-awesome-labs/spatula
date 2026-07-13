# Browser E2E Suite: OIDC + SSE Reconnect Chain

Tests the full browser OIDC + SSE reconnect chain end-to-end:

> **OIDC login via Dex → ws-token → SSE subscribe → disconnect → reconnect with Last-Event-ID → resume**

This is a **heavy** suite. It requires Docker, Playwright Chromium binaries, a live PostgreSQL database, and a live Redis instance. It is not included in the default `pnpm test:e2e` glob or PR CI; run it explicitly with the command below.

## Prerequisites

### 1. Playwright Chromium Binaries (one-time setup)

```bash
npx playwright install chromium
# or, if you are in the monorepo:
pnpm --filter @spatula/cli exec playwright install chromium
```

### 2. Docker + Dex IDP

The Dex local OIDC IDP must be running. The test suite will attempt to start it automatically if it is not already running. To start it manually:

```bash
cd examples/auth-dex
docker compose up -d
docker compose ps   # wait until status shows "healthy"
```

**Client IDs configured in Dex:**

| Client  | ID                | Type          | Redirect URI                     |
| ------- | ----------------- | ------------- | -------------------------------- |
| Browser | `spatula-browser` | Public (PKCE) | `http://localhost:3000/callback` |
| M2M     | `spatula-m2m`     | Confidential  | —                                |

**Dev login credentials:** `dev@example.com` / `password`

### 3. PostgreSQL

Set `TEST_DATABASE_URL` or `DATABASE_URL` (defaults to `postgresql://spatula:spatula@localhost:5432/spatula_test`).

The schema must be migrated:

```bash
pnpm --filter @spatula/db run migrate
```

### 4. Redis

Set `REDIS_URL` (defaults to `redis://localhost:6379`).

## Run Command

```bash
pnpm exec vitest run --config tests/e2e/browser/vitest.config.ts
```

## Environment Variables

| Variable            | Default                                                    | Purpose                                    |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| `TEST_DATABASE_URL` | `postgresql://spatula:spatula@localhost:5432/spatula_test` | Postgres for the API server                |
| `DATABASE_URL`      | same fallback                                              | Alternative Postgres env var               |
| `REDIS_URL`         | `redis://localhost:6379`                                   | Redis for SSE stream tokens + event buffer |

The suite sets these JWT env vars automatically at test start:

| Variable        | Value                            |
| --------------- | -------------------------------- |
| `AUTH_STRATEGY` | `jwt`                            |
| `JWT_ISSUER`    | `http://localhost:5556/dex`      |
| `JWT_AUDIENCE`  | `spatula-browser`                |
| `JWT_JWKS_URL`  | `http://localhost:5556/dex/keys` |

## What the Suite Proves

The test `oidc-sse-flow.spec.ts` drives the full chain without manual intervention:

1. **Step 1 — OIDC login**: Playwright launches Chromium, navigates to the Dex authorization endpoint, fills the dev login form, captures the authorization code at `localhost:3000/callback`, and exchanges it for a JWT access token. PKCE S256 is used throughout.

2. **Step 2 — Create a job**: Uses the OIDC access token to `POST /api/v1/jobs`.

3. **Step 3 — Get stream token**: `POST /api/v1/ws-token` → single-use `{ token }`.

4. **Step 4 — SSE subscribe**: Opens `GET /api/v1/jobs/:id/events?token=<token>` via the `subscribeJobEvents` SDK method. Asserts that events arrive with monotonically increasing Redis stream ids.

5. **Step 5 — Disconnect**: Closes the SSE connection after capturing the last received event id.

6. **Step 6 — Reconnect with Last-Event-ID**: Opens a new SSE connection with a fresh token and `lastEventId=<captured>`. Asserts:
   - Resumed events are strictly after the captured id (no duplicates)
   - Events published during the disconnect window (gap events) are replayed

## CI Topology

The default CI `test-e2e` job runs `pnpm test:e2e`, which matches `tests/e2e/**/*.test.ts` and does not include this browser suite. Use this suite as an explicit release or local validation step in an environment with Docker, Chromium, Postgres, and Redis available.

The normal PR jobs run unit, contract, and infrastructure-light test suites on every commit.

## Troubleshooting

**`chromium: launch failed` or `browser: executable not found`**
→ Run `npx playwright install chromium`

**`Failed to start Dex IDP`**
→ Ensure Docker is running and `docker compose` v2 is available (`docker compose version`)

**`ECONNREFUSED redis://localhost:6379`**
→ Start Redis locally (`brew services start redis` or `docker run -p 6379:6379 redis`)

**SSE returns 0 events (timeout)**
→ The `RedisEventPublisher.publish` must be writing to the Redis stream (via `XADD jobs:{jobId}:events`). Confirm the API server is configured with Redis event publishing and `AUTH_STRATEGY=jwt` (not `none` — the SSE route requires token auth).

**`401 AUTH.INVALID_TOKEN` on SSE**
→ The stream token has already been consumed (single-use via `GETDEL`). The test already re-fetches a fresh token before each SSE connection.
