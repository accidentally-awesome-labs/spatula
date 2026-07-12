# @spatula/shared

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an internal Spatula implementation package. Breaking changes to its TypeScript surface may land in any **MINOR** release. External consumers should not import it directly. The public packages with semver-stable TypeScript surfaces are: `@spatula/client`, `@spatula/core-types`, and `@spatula/cli`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

Cross-cutting utilities for Spatula: structured logging (pino), OpenTelemetry instrumentation, Sentry adapter, typed error subclasses, auth scope definitions, quota enforcement helpers. Imported by every other internal package.

## Stability

**No stable TS-API.** `ErrorCode` is canonical in `@spatula/core-types`; this package re-exports it via a back-compat shim. New consumers should import `ErrorCode` from `@spatula/core-types` directly.

## Compatibility

The TypeScript API is internal and may change between minor versions. Public compatibility guarantees live in `docs/compat-policy.md`.
