# @spatula/api

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an internal Spatula implementation package. Breaking changes to its TypeScript surface may land in any **MINOR** release. External consumers should not import it directly. The public packages with semver-stable TypeScript surfaces are: `@spatula/client`, `@spatula/core-types`, and `@spatula/cli`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

Hono-based REST API server for Spatula. Tenant-scoped middleware, OpenAPI runtime (`GET /api/v1/openapi.json`), well-known version probe (`GET /.well-known/spatula-version`), Bull Board admin UI, WebSocket + SSE adapters.

**Note:** The TS-API surface is internal. The **HTTP API contract** is the public surface; it is governed by [`docs/api-errors.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/api-errors.md), [`docs/api-idempotency.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/api-idempotency.md), [`docs/api-auth.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/api-auth.md), and the OpenAPI document served at runtime, all of which are stable per the [compat policy](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md). Self-hosters should consume the HTTP API via `@spatula/client`, not by importing this package directly.

## Stability

**No stable TS-API.** Use `@spatula/client` for programmatic API access.

## Compatibility

The TypeScript API is internal and may change between minor versions. The stable public API is the REST contract documented by OpenAPI and `docs/compat-policy.md`.
