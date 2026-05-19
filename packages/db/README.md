# @spatula/db

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an **INTERNAL** Spatula package published to npm so the private `spatula-saas` repo can install it. Breaking changes to its TypeScript surface may land in any **MINOR** release. Outside consumers should not rely on it. The PUBLIC packages with semver-stable TypeScript surfaces are: `@spatula/client`, `@spatula/core-types`, `@spatula/cli`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

Drizzle ORM schemas, repositories, and migrations for Spatula. Backs both PostgreSQL (production, `__drizzle_migrations_oss`) and SQLite (local-mode projects). All tables tenant-scoped from day one.

## Stability

**No stable TS-API.** Use `@spatula/client` for programmatic API access. Schema migrations follow expand-contract policy per [`docs/runbooks/upgrade.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/runbooks/upgrade.md); the SQL surface is forward-only post-v1 (no migration downgrade).

## Compatibility

This package is published to satisfy the private `spatula-saas` `import { ... } from '@spatula/db'` contract documented in [`docs/private-contract.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/private-contract.md). Forward-contract enforcement lives in `tests/private-contract/`.
