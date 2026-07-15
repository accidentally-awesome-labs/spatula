# @accidentally-awesome-labs/spatula-db

> **NO COMPAT GUARANTEE AT TS-API LEVEL.** This is an internal Spatula implementation package. Breaking changes to its TypeScript surface may land in any **MINOR** release. External consumers should not import it directly. The public packages with semver-stable TypeScript surfaces are: `@accidentally-awesome-labs/spatula-client`, `@accidentally-awesome-labs/spatula-core-types`, and `@accidentally-awesome-labs/spatula`. See [`docs/compat-policy.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/compat-policy.md) for the full matrix.

## Purpose

Drizzle ORM schemas, repositories, and migrations for Spatula. Backs both PostgreSQL (production, `__drizzle_migrations_oss`) and SQLite (local-mode projects). All tables tenant-scoped from day one.

## Stability

**No stable TS-API.** Use `@accidentally-awesome-labs/spatula-client` for programmatic API access. Schema migrations follow expand-contract policy per [`docs/runbooks/upgrade.md`](https://github.com/accidentally-awesome-labs/spatula/blob/main/docs/runbooks/upgrade.md); the SQL surface is forward-only post-v1 (no migration downgrade).

## Compatibility

The TypeScript API is internal and may change between minor versions. Public database upgrade guarantees live in `docs/runbooks/upgrade.md`.
