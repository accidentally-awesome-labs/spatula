# API Authentication & Authorization

> **Authoritative reference for auth strategies, scopes, token lifecycle, CORS,
> and related security policies.** This document supersedes scattered scope
> mentions in package READMEs. Requirements: AUTH-06, D-21.

---

## Authentication strategies

Spatula's API uses a pluggable `AuthProvider` interface. The active strategy is
selected via the `AUTH_STRATEGY` environment variable.

| Strategy     | `AUTH_STRATEGY` value | How to authenticate                              | When to use                                          |
| ------------ | --------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| **NoAuth**   | `none` (default)      | `X-Tenant-Id: <uuid>` header — no token required | Local development only. **Never use in production.** |
| **API key**  | `api-key`             | `Authorization: Bearer sk_live_<...>`            | Machine-to-machine, CI, CLI                          |
| **JWT-OIDC** | `jwt`                 | `Authorization: Bearer <jwt>`                    | Browser apps, OIDC SSO, M2M client_credentials       |

### NoAuth (`AUTH_STRATEGY=none`)

`NoAuthProvider` reads the `X-Tenant-Id` header as the caller's identity. All
scopes are granted (equivalent to `admin`). This mode is intentionally open and
is only safe on a loopback interface.

### API key (`ApiKeyAuthProvider`)

Keys carry the prefix `sk_live_` and are shown exactly once on creation. The
raw key is never stored — the API persists a `sha256` hash. On each request the
server re-hashes the `Bearer` value and compares it to the stored hash.

API keys carry an explicit scope list (see [Scope catalog](#scope-catalog)).
Default scopes for a newly created key are the six listed in
`DEFAULT_API_KEY_SCOPES` (see table below).

### JWT-OIDC (`JwtAuthProvider`)

`JwtAuthProvider` verifies JWTs using [jose](https://github.com/panva/jose)
with JWKS key material fetched from `JWT_JWKS_URL`. It validates:

- `iss` claim against `JWT_ISSUER`
- `aud` claim against `JWT_AUDIENCE`
- Standard `exp` / `nbf` / `iat` fields

After successful verification the `sub` claim is looked up in the
`user_tenants` table to resolve the tenant. First-time JWT users are
auto-provisioned with a new tenant on the first authenticated request.

The `scopes` claim (if present) restricts API access; omitting `scopes` grants
no implicit permissions.

---

## Scope catalog

<!-- SCOPE_TABLE_START -->

| Scope                 | Description                                             | In default API-key scopes? |
| --------------------- | ------------------------------------------------------- | -------------------------- |
| `jobs:read`           | List and retrieve crawl jobs                            | Yes                        |
| `jobs:write`          | Create, start, pause, resume, cancel crawl jobs         | Yes                        |
| `exports:read`        | List and retrieve exports                               | Yes                        |
| `exports:write`       | Create and trigger exports                              | Yes                        |
| `actions:read`        | List and retrieve pending review actions                | Yes                        |
| `actions:write`       | Approve, reject, and batch-update actions               | Yes                        |
| `tenants:admin`       | Manage tenant settings and quotas                       | No                         |
| `keys:manage`         | Create, list, revoke, and rotate API keys               | No                         |
| `admin`               | Full access including admin-only routes                 | No                         |
| `admin:forensic:read` | Read access to the forensic-extractions admin endpoint. | No                         |

<!-- SCOPE_TABLE_END -->

Scopes are enforced by `requireScope` middleware on every protected route. A
request with insufficient scope receives `403 AUTH.INSUFFICIENT_SCOPE`.

**Admin scopes** (`tenants:admin`, `keys:manage`, `admin`) are not granted to
keys created through the public API by default. They must be explicitly
requested at creation time by a caller that already holds the relevant admin
scope.

---

## Token lifecycle

### API key creation

```
POST /api/v1/api-keys
Authorization: Bearer <key-with-keys:manage-scope>
```

The response includes a `key` field (`sk_live_<random>`) — this is the **only
time the raw key is returned**. The server stores only the `sha256` hash. Store
the key securely on creation; it cannot be retrieved later.

### API key expiry and revocation

Keys can carry an `expiresAt` timestamp. After expiry the key is rejected with
`401 AUTH.INVALID_TOKEN`. Explicit revocation via `DELETE /api/v1/api-keys/:id`
sets `revokedAt` immediately.

### API key rotation (zero-downtime, AUTH-05)

```
POST /api/v1/api-keys/:id/rotate
Authorization: Bearer <key-with-keys:manage-scope>
Content-Type: application/json
{ "graceSeconds": 86400 }
```

Rotation issues a new key and keeps the **old key valid during a grace window**:

- `graceSeconds` default: **86400** (24 hours).
- `graceSeconds` minimum: `0` (old key invalidated immediately).
- `graceSeconds` maximum: **604800** (7 days) — server clamps values above this.

The old key's `expiresAt` is set to `now + graceSeconds`. Both keys validate
during the grace window. This allows zero-downtime secret rotation: deploy the
new key, let old consumers drain, then the old key expires automatically.

Rotation **inherits scopes verbatim** from the original key. Rotation is not a
rescope path — to change scopes, create a new key with the desired scopes.

Response shape:

```json
{
  "data": {
    "id": "<new-key-id>",
    "key": "sk_live_<new-raw-key>",
    "keyPrefix": "sk_live_xxx",
    "scopes": ["jobs:read", "jobs:write"],
    "expiresAt": null,
    "createdAt": "2026-05-20T00:00:00Z",
    "supersedes": "<old-key-id>",
    "supersededExpiresAt": "2026-05-21T00:00:00Z"
  }
}
```

---

## Refresh tokens — IDP's job

**Spatula does not issue or rotate refresh tokens.**

This is an explicit design decision (DEFER-07). Refresh-token issuance and
rotation are the OIDC provider's responsibility. Clients that hold an OIDC
access token should re-acquire it from their IDP when it expires — using the
IDP's standard `refresh_token` grant or `client_credentials` flow for M2M.

Spatula's API consumes JWTs and verifies them against the IDP's JWKS endpoint.
It does not participate in the OIDC session lifecycle.

---

## CSRF — N/A for Bearer auth

**CSRF protection does not apply to this API.**

The API authenticates via the `Authorization` header (or a single-use
`?token=` query parameter for stream endpoints). A cross-site request cannot
attach a `Bearer` token — browsers do not automatically include custom headers
with cross-site requests, and ambient cookies are not used for authentication.

Therefore, no CSRF token or `SameSite` cookie policy is required.

---

## Stream tokens (WebSocket + SSE)

Browser clients cannot attach `Authorization: Bearer` headers to
`EventSource` connections or WebSocket upgrades. Both are authenticated with a
**single-use stream token** issued by:

```
POST /api/v1/ws-token
Authorization: Bearer <valid-api-key-or-jwt>
```

Response:

```json
{ "data": { "token": "<random-base64url>", "expiresIn": 60 } }
```

The token is stored in Redis under `ws-token:<token>` with a **60-second TTL**.
It is consumed atomically via `GETDEL` on first use — it cannot be replayed.

### Using the stream token

| Endpoint                                | How to pass token                |
| --------------------------------------- | -------------------------------- |
| `GET /ws/jobs/:id/progress` (WebSocket) | `?token=<token>` query parameter |
| `GET /api/v1/jobs/:id/events` (SSE)     | `?token=<token>` query parameter |

### Security note — token in URL

Single-use tokens passed via `?token=` may appear in access logs. The 60-second
TTL and single-use guarantee mean that a token recorded in a log cannot be
replayed. Reverse-proxy access-log masking is **recommended** and is documented
in `docs/runbooks/reverse-proxy.md` (Phase 19 deliverable).

### Browser HTTP/1.1 EventSource connection limit

Browsers enforce a **limit of 6 concurrent connections per origin** for HTTP/1.1
EventSource. Users with multiple tabs open on the same origin may exhaust this
limit, causing new connections to queue or fail silently.

**Mitigation:** Enable HTTP/2 on your reverse proxy (nginx, Caddy, etc.).
HTTP/2 multiplexes SSE streams over a single TCP connection, removing the 6-connection
browser limit. The local development server uses HTTP/1.1; the limit applies
only in that context and is a Phase 19 reverse-proxy concern.

---

## CORS

CORS is configured via the `CORS_ALLOWED_ORIGINS` environment variable.

### Format

Comma-separated list of allowed origins. Three supported forms:

**(a) Single explicit origin:**

```
CORS_ALLOWED_ORIGINS=https://app.example.com
```

**(b) Comma-separated list:**

```
CORS_ALLOWED_ORIGINS=https://app.example.com,https://dashboard.example.com
```

Whitespace around commas is ignored.

**(c) Wildcard subdomain (`https://*.domain.com`):**

```
CORS_ALLOWED_ORIGINS=https://*.spatula.dev
```

The wildcard substitutes exactly **one subdomain label**. It matches:

- `https://app.spatula.dev` (one label)
- `https://docs.spatula.dev` (one label)

And **does NOT match**:

- `https://foo.bar.spatula.dev` (two labels — rejected)
- `https://spatula.dev` (no subdomain label — rejected)
- `https://evil.spatula.dev.attacker.com` (suffix attack — rejected)

### Rules

- A bare `*` is **not allowed**. Passing `CORS_ALLOWED_ORIGINS=*` causes a
  boot-time failure.
- Preflight cache is **86400 seconds** (24 hours). Browsers do not repeat
  preflight checks within this window.
- Misconfiguration (empty value, whitespace-only, or bare `*`) causes the API
  to fail at boot with the error:
  ```
  CORS_CONFIG_INVALID: CORS_ALLOWED_ORIGINS is empty or malformed (a bare "*" is not allowed)
  ```

### Combined example

```
CORS_ALLOWED_ORIGINS=https://app.example.com,https://*.spatula.dev
```

This accepts `https://app.example.com` (exact) and any single-label subdomain
of `spatula.dev` (wildcard).

---

## M2M (client_credentials)

Service-to-service callers (CI pipelines, backend services) authenticate using
the OIDC `client_credentials` grant rather than an API key:

1. The confidential client calls the IDP's token endpoint with its
   `client_id` + `client_secret`.
2. The IDP returns a signed JWT where `sub` = the `client_id`.
3. The JWT is passed to the API as `Authorization: Bearer <jwt>`.
4. `JwtAuthProvider` verifies the JWT and resolves the tenant via the
   `user_tenants` table. On first use the tenant is auto-provisioned.

No user is involved — the `sub` claim identifies the M2M client, not a human.

**Scopes** are taken from the `scopes` claim in the JWT (if present), or can be
further restricted by issuing the M2M client an API key.

### Local Dex recipe

See `examples/auth-dex/` for a self-contained `docker compose up` recipe that
spins up a [Dex](https://dexidp.io) identity provider with:

- A `spatula-browser` client (PKCE `authorization_code` flow)
- A `spatula-m2m` client (`client_credentials` flow)

Running `docker compose up` in `examples/auth-dex/` is sufficient to get a
working local OIDC stack for development and M2M testing.

---

_Last updated: Phase 17 (browser-auth-sse-cors). Maintained alongside `packages/shared/src/auth/types.ts`._
