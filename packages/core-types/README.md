# @spatula/core-types

Type-only exports, zod schemas, and enums for Spatula. Zero runtime dependencies; `zod` is a peer dependency.

## Stability

**Frozen at v1; additive-only in 1.x.** Removing or renaming exports is a major-version break. New exports may be added in any 1.x release.

See `docs/compat-policy.md` for the full SDK ↔ server ↔ core-types compatibility matrix.

## Usage

```typescript
import type { JobConfig, FieldDef } from '@spatula/core-types';
import { ErrorCode, JobConfigSchema } from '@spatula/core-types';
```

> **Note** This package is **type-only** in spirit. Importing runtime values for use as runtime values is allowed by the package itself, but the Spatula monorepo enforces a stricter convention via ESLint (`eslint.config.mjs`): value imports from `@spatula/core-types` are blocked across the monorepo (`allowTypeImports: true`). Use `@spatula/shared` for runtime `ErrorCode` / `STATUS_MAP`, or `@spatula/core` for the zod schemas. zod schemas exported here are SOURCE-OF-TRUTH; consumers may use them at runtime, but the package itself does not depend on zod at runtime — it declares zod as a peer.

## Surface

- **Errors** — `ErrorCode` (frozen 25-entry const-object enum), `STATUS_MAP` (HTTP status mapping)
- **Enums** — `ActionType` (25 pipeline action types), `JobStatus` (lifecycle states), `Scope` (9 auth scopes)
- **Schemas** — `JobConfig` / `JobConfigSchema`, `FieldDefinition` / `FieldDef` / `FieldDefSchema`, `PipelineAction` / `Action` / `ActionSchema`, `ExtractionResult` / `ExtractionResultSchema`, plus sub-configs (CrawlConfig, SchemaConfig, EvolutionConfig, LLMConfig, ReconciliationConfig) and supporting types (NormalizationRule, FieldRelevance, FieldAlias, SchemaDefinition, EntityMatch, etc.)
