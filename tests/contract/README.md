# tests/contract/

Public REST contract test suite. Gates the v1 API surface on every PR.

## What this proves

- Every 4xx/5xx response from the OSS API matches the v1 error envelope
  (`{ error: { code, message, requestId, details? } }`) — API-01.
- Every OpenAPI example in the served `/api/v1/openapi.json` validates against
  its own schema via Ajv2020, which catches response/example drift before it
  reaches users.
- Every auth'd success carries the four rate-limit headers
  (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`,
  `Retry-After`) — API-02.
- Offset-paginated routes emit `Deprecation` + `Sunset` + `Link` headers;
  cursor-mode requests do NOT — API-04.
- All timestamps parse as ISO 8601 UTC (trailing `Z` or `+00:00`) — API-07.
- Every public route lives under `/api/v1/` (or the `/.well-known/`
  sibling-root) — API-10.
- `client.experimental.forensic` resolves to the one v1 experimental surface,
  while every other `client.experimental.*` property throws — API-13.

## How it works

Boots a single apps/api server with a randomly-assigned port using the
Node-builtin `http.Server` adapter (carry-forward from
`tests/carveout/fixtures/server.ts` — no `@hono/node-server` at the workspace
root). Once-per-suite:

1. `beforeAll`: start the server, fetch `/api/v1/openapi.json`, cache the
   served spec, seed one tenant + one admin-scoped API key.
2. The matrix driver (`generated.test.ts`) iterates every
   `(path, method, status, example)` tuple from the cached spec and validates
   shapes via Ajv2020.
3. Per-REQ suites (`errors.test.ts`, `headers.test.ts`,
   `deprecation.test.ts`, `timestamps.test.ts`, `versioning.test.ts`,
   `experimental.test.ts`) hit explicit fixed paths to assert non-spec
   invariants (e.g., that the four rate-limit headers appear on a non-spec'd
   path like `/api/v1/health`).
4. `afterAll`: close the server + pg pool.

## Ajv import path

The default `import Ajv from 'ajv'` uses the draft-07 validator and silently
mis-validates `nullable: true` + tuple-form `prefixItems` keywords used by the
zod-openapi-emitted schemas. ALWAYS import via the 2020 sub-path:

```typescript
import Ajv2020 from 'ajv/dist/2020.js';
```

See `helpers/ajv-setup.ts` for the single shared instance factory.

## Run locally

```bash
pnpm test:contract                  # full suite (~60–120s)
pnpm test:contract -- errors        # single file
```

Requires Postgres + Redis from the repo's `docker-compose.yml` running (same
as `tests/carveout/`). The harness reads `TEST_DATABASE_URL` (preferred) or
`DATABASE_URL`.

## Files

- `vitest.config.ts` — test runner config (30s timeout, workspace aliases).
- `helpers/ajv-setup.ts` — shared Ajv2020 instance factory.
- `helpers/server-harness.ts` — `startServer()` + Node http adapter.
- `helpers/fixtures.ts` — `seedFixtures()`, `resolvePath()`, `authHeaders()`.
- `generated.test.ts` — matrix driver over the served OpenAPI spec.
- `errors.test.ts` — error-envelope conformance (5 distinct codes).
- `headers.test.ts` — rate-limit header set + Retry-After on 429.
- `deprecation.test.ts` — RFC 8594 headers on offset routes only.
- `timestamps.test.ts` — ISO 8601 UTC sweep across response bodies.
- `versioning.test.ts` — every spec path under `/api/v1/` or `/.well-known/`.
- `experimental.test.ts` — `client.experimental.forensic` exists; all other experimental properties throw.
