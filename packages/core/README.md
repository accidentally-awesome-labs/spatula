# @spatula/core

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an **INTERNAL** Spatula package published to npm so the private `spatula-saas` repo can install it. Breaking changes to its TypeScript surface may land in any **MINOR** release. Outside consumers should not rely on it. The PUBLIC packages with semver-stable TypeScript surfaces are: `@spatula/client`, `@spatula/core-types`, `@spatula/cli`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

Pure orchestrators and pipeline logic for Spatula: crawl orchestrator, schema-evolution engine, reconciliation pipeline, export drivers, action interpreter. Zero HTTP/queue dependencies — `LocalPipelineRunner` (CLI) and BullMQ workers (server) both import from here.

## Stability

**No stable TS-API.** Use `@spatula/client` for programmatic API access or `@spatula/cli` for command-line workflows.

## Compatibility

This package is published to satisfy the private `spatula-saas` `import { ... } from '@spatula/core'` contract documented in [`docs/private-contract.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/private-contract.md). Forward-contract enforcement lives in `tests/private-contract/`.
