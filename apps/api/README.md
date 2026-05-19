# @spatula/api

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an **INTERNAL** Spatula package published to npm so the private `spatula-saas` repo can install it. Breaking changes to its TypeScript surface may land in any **MINOR** release. Outside consumers should not rely on it. The PUBLIC packages with semver-stable TypeScript surfaces are: `@spatula/client`, `@spatula/core-types`, `@spatula/cli`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

Hono-based REST API server for Spatula. Tenant-scoped middleware, OpenAPI runtime (`GET /api/v1/openapi.json`), well-known version probe (`GET /.well-known/spatula-version`), Bull Board admin UI, WebSocket + SSE adapters.

**Note:** The TS-API surface is internal. The **HTTP API contract** is the public surface; it is governed by [`docs/api-errors.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/api-errors.md), [`docs/api-idempotency.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/api-idempotency.md), [`docs/api-auth.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/api-auth.md), and the OpenAPI document served at runtime, all of which are stable per the [compat policy](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md). Self-hosters should consume the HTTP API via `@spatula/client`, not by importing this package directly.

## Stability

**No stable TS-API.** Use `@spatula/client` for programmatic API access.

## Compatibility

This package is published to satisfy the private `spatula-saas` `import { ... } from '@spatula/api'` contract documented in [`docs/private-contract.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/private-contract.md). Forward-contract enforcement lives in `tests/private-contract/`.
