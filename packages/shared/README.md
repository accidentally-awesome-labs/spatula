# @spatula/shared

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an **INTERNAL** Spatula package published to npm so the private `spatula-saas` repo can install it. Breaking changes to its TypeScript surface may land in any **MINOR** release. Outside consumers should not rely on it. The PUBLIC packages with semver-stable TypeScript surfaces are: `@spatula/client`, `@spatula/core-types`, `@spatula/cli`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

Cross-cutting utilities for Spatula: structured logging (pino), OpenTelemetry instrumentation, Sentry adapter, typed error subclasses, auth scope definitions, quota enforcement helpers. Imported by every other internal package.

## Stability

**No stable TS-API.** `ErrorCode` is canonical in `@spatula/core-types`; this package re-exports it via a back-compat shim. New consumers should import `ErrorCode` from `@spatula/core-types` directly.

## Compatibility

This package is published to satisfy the private `spatula-saas` `import { ... } from '@spatula/shared'` contract documented in [`docs/private-contract.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/private-contract.md). Forward-contract enforcement lives in `tests/private-contract/`.
