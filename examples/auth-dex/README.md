# auth-dex — Local Dex OIDC IDP

A self-contained local [Dex](https://dexidp.io/) OIDC identity provider for developing and testing Spatula's browser-OIDC and M2M auth flows. `docker compose up` produces a working IDP with no environment surgery — no accounts, no env vars, no external services.

**Not for production.** All credentials here are committed dev-only secrets. See the Security banner below.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with [Docker Compose](https://docs.docker.com/compose/) (Compose v2 / `docker compose` command)
- No other dependencies, env vars, or accounts required

> **Note on image version:** This kit uses `ghcr.io/dexidp/dex:latest` (v2.46.0+). The `client_credentials` grant was not implemented in the v2.45.x release series; it shipped in v2.46.0. The `DEX_CLIENT_CREDENTIAL_GRANT_ENABLED_BY_DEFAULT=true` env var (set in `docker-compose.yml`) is required to enable it alongside the `grantTypes` config key in `config/dex.yaml`.

---

## Boot it

```bash
cd examples/auth-dex

# (First run only) Pull the image so boot time is not skewed by download
docker compose pull

# Start Dex in the background
docker compose up -d

# Confirm healthy (should reach "healthy" within ~10 seconds)
docker compose ps
```

Expected outcome:

- Dex is healthy at `http://localhost:5556/dex`
- Discovery doc resolves at `http://localhost:5556/dex/.well-known/openid-configuration`
- Ready in **< 10 seconds** on a clean machine (image already pulled)

Tear down:

```bash
docker compose down
```

---

## Clients

| Client ID         | Type         | Grant                       | Redirect URI                     | Secret                 |
| ----------------- | ------------ | --------------------------- | -------------------------------- | ---------------------- |
| `spatula-browser` | Public       | `authorization_code` + PKCE | `http://localhost:3000/callback` | _(none — PKCE client)_ |
| `spatula-m2m`     | Confidential | `client_credentials`        | _(none)_                         | `dev-only-secret-m2m`  |

---

## Dev login

When prompted for credentials by the Dex browser flow:

| Field    | Value             |
| -------- | ----------------- |
| Email    | `dev@example.com` |
| Password | `password`        |

---

## Smoke scripts

Three scripts in `smoke/` let you verify the IDP is working and exercise both auth flows:

### `smoke/check-dex.ts` — discovery-doc health probe

Fetches the OIDC discovery doc and exits 0 on success, 1 on failure. Dependency-free (global `fetch`).

```bash
npx tsx smoke/check-dex.ts
# Prints: dex-ok
```

Use this as a readiness gate in e2e suites before driving flows.

### `smoke/browser-flow.ts` — browser OIDC reference flow

A Playwright-based runnable reference script that drives the full `spatula-browser` PKCE authorization-code flow against Dex. Requires `playwright install chromium` first.

```bash
npx playwright install chromium   # one-time setup
npx tsx smoke/browser-flow.ts
# Prints: browser-flow-ok + decoded JWT claims
```

The [browser E2E suite](../../tests/e2e/browser/) extends this into the full OIDC -> ws-token -> SSE subscribe -> reconnect flow.

### `smoke/m2m-flow.ts` — M2M client_credentials reference flow

A dependency-free Node script that POSTs a `client_credentials` grant to the Dex token endpoint and decodes the resulting JWT. No Playwright needed.

```bash
npx tsx smoke/m2m-flow.ts
# Prints: m2m-flow-ok + decoded JWT claims
```

The [M2M E2E suite](../../tests/e2e/m2m/) extends this into the full service-token -> createJob -> listJobs -> getEntities SDK chain.

---

## Pointing Spatula at this IDP

To configure the Spatula API server to trust tokens issued by this local Dex instance, set the following environment variables:

```bash
AUTH_STRATEGY=jwt
JWT_ISSUER=http://localhost:5556/dex
JWT_JWKS_URL=http://localhost:5556/dex/keys

# Browser flow: tokens issued to the browser client
JWT_AUDIENCE=spatula-browser

# M2M flow: tokens issued to the M2M client (sub = spatula-m2m)
# JWT_AUDIENCE=spatula-m2m
```

The `JwtAuthProvider` in `apps/api/src/auth/jwt-provider.ts` handles JWKS verification and tenant resolution automatically via the `user_tenants` table.

---

## Security banner

**All credentials in this directory are committed dev-only secrets.** They exist solely to make `docker compose up` work without any setup. Never reuse them in a real environment:

- `dev-only-secret-m2m` — the `spatula-m2m` client secret, committed to git intentionally
- `dev@example.com` / `password` — static login credentials for the local password connector

---

## Used by

- `tests/e2e/browser/` — full browser OIDC + SSE e2e suite; extends `smoke/browser-flow.ts`
- `tests/e2e/m2m/` — full M2M SDK chain e2e suite; extends `smoke/m2m-flow.ts`
