# @accidentally-awesome-labs/spatula-core

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an internal Spatula implementation package. Breaking changes to its TypeScript surface may land in any **MINOR** release. External consumers should not import it directly. The public packages with semver-stable TypeScript surfaces are: `@accidentally-awesome-labs/spatula-client`, `@accidentally-awesome-labs/spatula-core-types`, and `@accidentally-awesome-labs/spatula`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

Pure orchestrators and pipeline logic for Spatula: crawl orchestrator, schema-evolution engine, reconciliation pipeline, export drivers, action interpreter. Zero HTTP/queue dependencies — `LocalPipelineRunner` (CLI) and BullMQ workers (server) both import from here.

## Stability

**No stable TS-API.** Use `@accidentally-awesome-labs/spatula-client` for programmatic API access or `@accidentally-awesome-labs/spatula` for command-line workflows.

## Compatibility

The TypeScript API is internal and may change between minor versions. Public compatibility guarantees live in `docs/compat-policy.md`.
