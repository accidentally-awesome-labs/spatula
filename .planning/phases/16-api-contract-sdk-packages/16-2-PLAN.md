---
phase: 16-api-contract-sdk-packages
plan: 2
type: execute
wave: 2
depends_on:
  - 16-1
files_modified:
  - packages/core-types/package.json
  - packages/core-types/tsconfig.json
  - packages/core-types/vitest.config.ts
  - packages/core-types/src/index.ts
  - packages/core-types/src/errors/codes.ts
  - packages/core-types/src/errors/codes.test.ts
  - packages/core-types/src/schemas/job.ts
  - packages/core-types/src/schemas/field.ts
  - packages/core-types/src/schemas/action.ts
  - packages/core-types/src/schemas/extraction.ts
  - packages/core-types/src/enums/action-type.ts
  - packages/core-types/src/enums/job-status.ts
  - packages/core-types/src/enums/scope.ts
  - packages/core-types/README.md
  - packages/client/package.json
  - packages/client/tsconfig.json
  - packages/client/vitest.config.ts
  - packages/client/size-limit.json
  - packages/client/src/index.ts
  - packages/client/src/client.ts
  - packages/client/src/errors/base.ts
  - packages/client/src/errors/generated.ts
  - packages/client/src/methods/create-job.ts
  - packages/client/src/methods/list-jobs.ts
  - packages/client/src/methods/get-entities.ts
  - packages/client/src/methods/get-job-events.ts
  - packages/client/src/experimental/index.ts
  - packages/client/scripts/gen-error-classes.ts
  - packages/client/tests/unit/client.test.ts
  - packages/client/tests/unit/errors-generated.test.ts
  - packages/client/tests/unit/experimental-namespace.test.ts
  - packages/client/README.md
  - packages/shared/src/index.ts
  - packages/shared/src/error-codes.ts
  - packages/core/src/index.ts
  - eslint.config.mjs
  - tests/private-contract/oss-surface.test.ts
  - apps/api/src/schemas/responses.ts
  - turbo.json
  - pnpm-workspace.yaml
autonomous: true
requirements:
  - SDK-01
  - SDK-02
  - SDK-03

must_haves:
  truths:
    - "`@spatula/core-types` package is buildable and publishable (`pnpm --filter @spatula/core-types build` succeeds)"
    - "`@spatula/client` package is buildable; `import { SpatulaClient, createJob, listJobs, getEntities } from '@spatula/client'` resolves"
    - "Frozen `ErrorCode` enum lives in `@spatula/core-types/src/errors/codes.ts` (MOVED from plan 16-1's staging location in `@spatula/shared`)"
    - "Class-per-code typed errors (`JobNotFoundError`, `RateLimitExceededError`, etc.) are generated into `packages/client/src/errors/generated.ts` and COMMITTED"
    - "ESLint rule blocks non-type imports from `@spatula/core-types` across the entire monorepo"
    - "`size-limit` reports `< 50 kB` gzipped for `{ SpatulaClient, createJob, listJobs, getEntities }` built via esbuild ESM browser (SI lowercase kB matches research Pattern 4 + size-limit.json limit string)"
    - "`@spatula/core-types` has zero runtime dependencies (only `zod` as peer)"
    - "`tests/private-contract/oss-surface.test.ts` remains green — `@spatula/core` re-export shim preserves the surface that `spatula-saas` consumes"
  artifacts:
    - path: "packages/core-types/package.json"
      provides: "Publishable npm scoped package with `peerDependencies.zod` only and `sideEffects:false`"
      contains: "@spatula/core-types"
    - path: "packages/core-types/src/errors/codes.ts"
      provides: "Frozen ErrorCode enum + STATUS_MAP (MOVED from packages/shared in plan 16-1)"
      contains: "ErrorCode"
    - path: "packages/client/package.json"
      provides: "Publishable npm scoped package; ESM-only; explicit `exports`; `sideEffects:false`; `engines.node>=22`"
      contains: "@spatula/client"
    - path: "packages/client/src/client.ts"
      provides: "`SpatulaClient` class with fetch-based request method + error decoding"
      contains: "class SpatulaClient"
    - path: "packages/client/src/errors/generated.ts"
      provides: "Class-per-code typed error subclasses generated from `@spatula/core-types/src/errors/codes.ts`. COMMITTED OUTPUT (per D-11)."
      contains: "class JobNotFoundError"
    - path: "packages/client/scripts/gen-error-classes.ts"
      provides: "Codegen script reading ErrorCode enum from @spatula/core-types and emitting generated.ts; CI verifies via `git diff --exit-code`"
      contains: "ErrorCode"
    - path: "packages/client/size-limit.json"
      provides: "50 kB gzipped budget with explicit `esbuild` config (ESM + browser + es2022 + minify + treeShaking) per research Pattern 4"
      contains: "50 kB"
    - path: "eslint.config.mjs"
      provides: "`no-restricted-imports` rule with `allowTypeImports: true` blocking value imports from `@spatula/core-types`"
      contains: "@spatula/core-types"
    - path: "packages/client/src/experimental/index.ts"
      provides: "Empty Proxy scaffolding for `client.experimental.*` namespace (Phase 18 first surface; throws 'no experimental surfaces in v1.0' on any access)"
      contains: "Proxy"
  key_links:
    - from: "packages/core/src/index.ts"
      to: "packages/core-types/src/index.ts"
      via: "Re-export shim — `export type { JobConfig, FieldDef, ActionType, ErrorCode } from '@spatula/core-types'`"
      pattern: "from '@spatula/core-types'"
    - from: "packages/client/scripts/gen-error-classes.ts"
      to: "packages/core-types/src/errors/codes.ts"
      via: "Reads ErrorCode at codegen time, writes one class per value to packages/client/src/errors/generated.ts"
      pattern: "ErrorCode"
    - from: "packages/client/src/client.ts"
      to: "packages/client/src/errors/generated.ts"
      via: "Decodes API error envelope `{error:{code,...}}` to the matching subclass instance"
      pattern: "decodeError"
    - from: "apps/api/src/schemas/responses.ts"
      to: "packages/core-types/src/errors/codes.ts"
      via: "errorResponseSchema's `code` field references ErrorCode union (typing)"
      pattern: "@spatula/core-types"
    - from: "packages/shared/src/error-codes.ts"
      to: "packages/core-types/src/errors/codes.ts"
      via: "Re-export shim — `@spatula/shared` continues to expose ErrorCode for legacy consumers, but the source of truth is core-types"
      pattern: "from '@spatula/core-types'"
---

<objective>
Create `@spatula/core-types` (type-only + zod + enums, zero runtime deps) and `@spatula/client` (ESM-only fetch-based SDK with `SpatulaClient` class + class-per-code typed errors generated via codegen). Add the ESLint rule blocking non-type imports from `@spatula/core-types`. Wire the `size-limit` CI gate at 50 KB gzipped. Move the frozen `ErrorCode` enum from plan 16-1's staging in `@spatula/shared` to its permanent home in `@spatula/core-types`, with a re-export shim from `@spatula/core` to keep the reverse-contract test green.

Purpose: This is the package extraction that makes Phase 16's deliverables _shippable_. The error-code enum, action enum, JobConfig shape, FieldDef shape, and status enums all need a tiny zero-runtime-deps home. The `@spatula/client` SDK is what every downstream consumer (browser web UI, Phase 17 SSE client, Phase 18 experimental surfaces) will import.

Output:
- New `packages/core-types/` directory + package
- New `packages/client/` directory + package + codegen + size-limit config
- Frozen ErrorCode + class-per-code generated errors
- ESLint rule + re-export shim in `@spatula/core` so `tests/private-contract/` stays green
- `client.experimental.*` namespace scaffolding (empty Proxy) for Phase 18 first surface
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@.planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md
@.planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md
@.planning/phases/16-api-contract-sdk-packages/16-VALIDATION.md
@.planning/phases/16-api-contract-sdk-packages/16-1-SUMMARY.md
@docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md
@docs/private-contract.md
@.planning/codebase/CONVENTIONS.md
@.planning/codebase/STRUCTURE.md

<interfaces>
<!-- Key contracts the executor needs. Extracted from codebase. -->

From `packages/shared/src/error-codes.ts` (plan 16-1 output — MOVED in Task 1 of this plan):
```typescript
export const ErrorCode = {
  JOB_NOT_FOUND: 'JOB.NOT_FOUND',
  JOB_CONFLICT: 'JOB.CONFLICT',
  // ... ~24 codes per plan 16-1's curated list
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
export const STATUS_MAP: Record<ErrorCode, number> = { /* ... */ };
```

From `packages/shared/package.json` (template for the two new packages):
```json
{
  "name": "@spatula/shared",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": { "build": "tsc", "test": "vitest run", "typecheck": "tsc --noEmit", "clean": "rm -rf dist .turbo" },
  "private": true,
  ...
}
```

From `packages/core/src/index.ts` (CURRENT — re-exports drive what `tests/private-contract/oss-surface.test.ts` pins):
```typescript
// Current state — pins many type exports that move to @spatula/core-types in Task 4.
// Task 4 adds a re-export shim: `export type { JobConfig, FieldDef, ActionType } from '@spatula/core-types';`
// so spatula-saas's `import { JobConfig } from '@spatula/core'` continues resolving.
```

From `tests/private-contract/oss-surface.test.ts` (PRECEDENT — what must stay green):
```typescript
// Imports * as core from '@spatula/core' and pins runtime fns (processCrawlTask, etc.)
// + a small set of types (JobConfig, ActionType, ErrorCode).
// Task 4 extends this with one new describe block asserting types resolve via the
// `@spatula/core` → `@spatula/core-types` re-export shim.
```

Spec §3.2.2 (verbatim) — `@spatula/core-types` boundary:
> "type-only exports + zod schemas + enums; zero runtime deps (zod as peer)"

Spec §3.2.1 (verbatim) — `@spatula/client` properties:
> "ESM-only; `sideEffects: false`; explicit `exports` field; engines: node>=22; bundle size measured by `size-limit` ≤ 50KB gzipped for `{SpatulaClient, createJob, listJobs, getEntities}` built with `esbuild --bundle --minify --format=esm --platform=browser`"
</interfaces>

</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create `@spatula/core-types` package (skeleton + ErrorCode move + JobConfig/FieldDef/Action zod schemas + enums)</name>
  <files>
    packages/core-types/package.json,
    packages/core-types/tsconfig.json,
    packages/core-types/vitest.config.ts,
    packages/core-types/src/index.ts,
    packages/core-types/src/errors/codes.ts,
    packages/core-types/src/errors/codes.test.ts,
    packages/core-types/src/schemas/job.ts,
    packages/core-types/src/schemas/field.ts,
    packages/core-types/src/schemas/action.ts,
    packages/core-types/src/schemas/extraction.ts,
    packages/core-types/src/enums/action-type.ts,
    packages/core-types/src/enums/job-status.ts,
    packages/core-types/src/enums/scope.ts,
    packages/core-types/README.md,
    packages/shared/src/error-codes.ts,
    packages/shared/src/index.ts,
    pnpm-workspace.yaml,
    turbo.json
  </files>
  <read_first>
    - packages/shared/package.json (template for the new package.json shape; copy `type: module`, `exports`, scripts; differences: NEW package is not private, has `peerDependencies` not `dependencies`)
    - packages/shared/tsconfig.json (template for the new tsconfig — same compiler options, different `include`)
    - packages/shared/vitest.config.ts (template)
    - packages/shared/src/error-codes.ts (plan 16-1 output — the enum being MOVED to core-types)
    - packages/core/src/types/* and packages/core/src/index.ts (find existing zod schemas + interfaces for JobConfig, FieldDef, ActionType — these MOVE to core-types and get re-exported from core)
    - pnpm-workspace.yaml (workspace package globs — confirm `packages/*` matches; no changes needed if already broad)
    - turbo.json (task graph — new package inherits automatically via `packages/*`)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Architecture Patterns" Pattern 3 + "Standard Stack"
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.2.2 (core-types boundary)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § D-09 (boundary), D-10 (ESLint rule — Task 2), D-11 (codegen — Task 3)
  </read_first>
  <behavior>
    - New directory `packages/core-types/` with the listed files.
    - `package.json`:
      ```json
      {
        "name": "@spatula/core-types",
        "version": "0.0.1",
        "description": "Spatula type-only exports, zod schemas, and enums. Zero runtime dependencies; zod as peer. Frozen at v1; additive-only in 1.x.",
        "license": "MIT",
        "repository": { "type": "git", "url": "https://github.com/accidentally-awesome-labs/spatula.git", "directory": "packages/core-types" },
        "type": "module",
        "main": "./dist/index.js",
        "types": "./dist/index.d.ts",
        "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
        "files": ["dist", "README.md"],
        "engines": { "node": ">=22" },
        "sideEffects": false,
        "publishConfig": { "access": "public", "provenance": true },
        "peerDependencies": { "zod": ">=3.22.0 <5.0.0" },
        "devDependencies": { "typescript": "^5.7.0", "vitest": "^2.1.0", "zod": "^3.24.0", "@types/node": "^22.0.0" },
        "scripts": { "build": "tsc", "test": "vitest run", "typecheck": "tsc --noEmit", "clean": "rm -rf dist .turbo" }
      }
      ```
    - `tsconfig.json`: extend the root tsconfig pattern from `packages/shared/tsconfig.json`. `outDir: "./dist"`, `rootDir: "./src"`, `declaration: true`, `declarationMap: true`, `composite: true`.
    - `src/errors/codes.ts`: receives the entire `ErrorCode` enum + `STATUS_MAP` from `packages/shared/src/error-codes.ts` VERBATIM (plan 16-1 staged here for exactly this reason).
    - `src/enums/action-type.ts`: action-type enum (52 action types per PROJECT.md). Identify existing source in `packages/core/src/` and MOVE.
    - `src/enums/job-status.ts`: job status enum.
    - `src/enums/scope.ts`: auth scope enum (`jobs:read`, `entities:write`, `admin:tenants:write`, etc.).
    - `src/schemas/job.ts`: `JobConfigSchema` (zod) + `JobConfig` (type inferred). MOVE from `packages/core/`.
    - `src/schemas/field.ts`: `FieldDefSchema` + `FieldDef`. MOVE.
    - `src/schemas/action.ts`: `ActionSchema` + `Action`. MOVE.
    - `src/schemas/extraction.ts`: `ExtractionResultSchema` + `ExtractionResult`. MOVE.
    - `src/index.ts`: re-exports all of the above:
      ```typescript
      export { ErrorCode, STATUS_MAP } from './errors/codes.js';
      export type { ErrorCode } from './errors/codes.js';
      export { ActionType } from './enums/action-type.js';
      export { JobStatus } from './enums/job-status.js';
      export { Scope } from './enums/scope.js';
      export { JobConfigSchema } from './schemas/job.js';
      export type { JobConfig } from './schemas/job.js';
      export { FieldDefSchema } from './schemas/field.js';
      export type { FieldDef } from './schemas/field.js';
      export { ActionSchema } from './schemas/action.js';
      export type { Action } from './schemas/action.js';
      export { ExtractionResultSchema } from './schemas/extraction.js';
      export type { ExtractionResult } from './schemas/extraction.js';
      ```
    - `src/errors/codes.test.ts`: identical to plan 16-1's test (regex `^[A-Z_]+\.[A-Z_]+$` + STATUS_MAP completeness check).
    - `packages/shared/src/error-codes.ts`: replaced with a re-export shim that exposes BOTH the runtime value AND the type from `@spatula/core-types`. This is the canonical consumer-side route for value imports — the ESLint rule (Task 2) blocks consumers from importing values directly from `@spatula/core-types`, so every value-consumer (including the codegen script in Task 3) imports via `@spatula/shared`:
      ```typescript
      // Backward-compat shim. The frozen ErrorCode enum lives in @spatula/core-types,
      // but consumers MUST import the runtime value via @spatula/shared because the
      // monorepo ESLint rule (no-restricted-imports + allowTypeImports) blocks value
      // imports from @spatula/core-types directly. Type imports may still go either way.
      export { ErrorCode, STATUS_MAP } from '@spatula/core-types';
      export type { ErrorCode as ErrorCodeType } from '@spatula/core-types';
      ```
    - `packages/shared/src/index.ts`: keeps the existing `export * from './error-codes.js'` AND additionally MUST re-export `ErrorCode` (as a value) and `ErrorCodeType` (as a type) at the top level so consumers can write `import { ErrorCode } from '@spatula/shared'` directly. Concretely, ensure the barrel file contains a line of the form `export { ErrorCode, STATUS_MAP } from './error-codes.js';` and `export type { ErrorCodeType } from './error-codes.js';`.
    - `packages/shared/package.json` MUST be updated by Task 1 to add `"@spatula/core-types": "workspace:*"` to dependencies, so the runtime can resolve the import.
  </behavior>
  <action>
    Step 1: `mkdir -p packages/core-types/src/{errors,schemas,enums} packages/core-types/tests`

    Step 2: Write `packages/core-types/package.json` per <behavior>. Note `"private": false` is implied (omitted) — this is the FIRST public package. `publishConfig.access: public` + `provenance: true` per spec §3.6.

    Step 3: Write `packages/core-types/tsconfig.json`:
    ```json
    {
      "extends": "../../tsconfig.base.json",
      "compilerOptions": {
        "outDir": "./dist",
        "rootDir": "./src",
        "declaration": true,
        "declarationMap": true,
        "composite": true,
        "tsBuildInfoFile": "./dist/.tsbuildinfo"
      },
      "include": ["src/**/*"],
      "exclude": ["**/*.test.ts", "node_modules", "dist"]
    }
    ```
    (If `tsconfig.base.json` doesn't exist at the root, copy compiler options from `packages/shared/tsconfig.json` and inline.)

    Step 4: Write `packages/core-types/vitest.config.ts` — copy `packages/shared/vitest.config.ts` verbatim.

    Step 5: MOVE `packages/shared/src/error-codes.ts` contents into `packages/core-types/src/errors/codes.ts`. Replace `packages/shared/src/error-codes.ts` with the shim re-export shown in <behavior>. Update `packages/shared/package.json` to add `"@spatula/core-types": "workspace:*"` to `dependencies`.

    Step 6: MOVE the existing JobConfig/FieldDef/Action/ExtractionResult zod schemas + interfaces from `packages/core/src/types/*` (find exact paths via grep) into `packages/core-types/src/schemas/`. Update `packages/core/` to import them back via:
    ```typescript
    // packages/core/src/types/index.ts
    export type { JobConfig, FieldDef, Action, ExtractionResult } from '@spatula/core-types';
    export { JobConfigSchema, FieldDefSchema, ActionSchema, ExtractionResultSchema } from '@spatula/core-types';
    ```
    (Add `"@spatula/core-types": "workspace:*"` to `packages/core/package.json` dependencies.)

    Step 7: Same MOVE for the action-type / job-status / scope enums. Identify their current location in `packages/core/src/` or `packages/shared/src/` via grep and migrate.

    Step 8: Write `packages/core-types/src/index.ts` barrel per <behavior>.

    Step 9: Write `packages/core-types/src/errors/codes.test.ts` (same assertions as plan 16-1's test).

    Step 10: Write `packages/core-types/README.md`:
    ```markdown
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

    ⚠️ This package is **type-only**. Importing runtime values for use as runtime values violates the package contract. The Spatula monorepo enforces this via ESLint (see `eslint.config.mjs`). zod schemas exported here are SOURCE-OF-TRUTH; consumers may use them at runtime, but the package itself does not depend on zod at runtime — it declares zod as a peer.
    ```

    Step 11: Run `pnpm install` to wire workspace dependencies. Then `pnpm --filter @spatula/core-types build && pnpm --filter @spatula/core-types test` — both must succeed.

    Step 12: Run `pnpm --filter @spatula/core build` to confirm the re-export shim works (no broken imports).
  </action>
  <verify>
    <automated>pnpm install --frozen-lockfile=false && pnpm --filter @spatula/core-types build && pnpm --filter @spatula/core-types test && pnpm --filter @spatula/core build && pnpm --filter @spatula/shared build && grep -q "ErrorCode" packages/core-types/src/errors/codes.ts && grep -q "from '@spatula/core-types'" packages/shared/src/error-codes.ts && test -f packages/core-types/README.md</automated>
  </verify>
  <acceptance_criteria>
    - `packages/core-types/package.json` exists with `"name": "@spatula/core-types"` and `"peerDependencies": { "zod": ... }` and NO `dependencies` field (zero runtime deps per D-09) — `grep -A 2 '"dependencies"' packages/core-types/package.json` returns NO match for a non-empty deps block (or the field is absent)
    - `packages/core-types/package.json` contains `"sideEffects": false` and `"publishConfig": { "access": "public", "provenance": true }`
    - `packages/core-types/src/errors/codes.ts` contains the full `ErrorCode` const-object from plan 16-1
    - `packages/shared/src/error-codes.ts` contains the string `from '@spatula/core-types'` (re-export shim) — `grep -q "from '@spatula/core-types'" packages/shared/src/error-codes.ts`
    - `packages/shared/src/index.ts` re-exports `ErrorCode` (value) and `type ErrorCodeType` from `@spatula/core-types` (transitively via `./error-codes.js`). Verified by `grep -q "export { ErrorCode" packages/shared/src/index.ts` AND `grep -q "ErrorCodeType" packages/shared/src/index.ts`. This shim is the canonical value-import route for the codegen script in Task 3 (which would otherwise self-violate the ESLint rule added in Task 2).
    - `packages/core-types/src/index.ts` exports `JobConfig` type, `JobConfigSchema`, `ErrorCode`, `STATUS_MAP`, `ActionType` — `for sym in JobConfig JobConfigSchema ErrorCode STATUS_MAP ActionType; do grep -q "$sym" packages/core-types/src/index.ts || exit 1; done`
    - `pnpm --filter @spatula/core-types build` succeeds; `dist/index.js` and `dist/index.d.ts` exist
    - `pnpm --filter @spatula/core-types test` passes (the codes-shape unit test)
    - `pnpm --filter @spatula/core build` succeeds (re-export shim resolves)
    - `pnpm --filter @spatula/shared build` succeeds (shim works)
    - Implements per D-09 (boundary), and stages SDK-01 for the ESLint rule in Task 2 to enforce.
  </acceptance_criteria>
  <done>
    `@spatula/core-types` package exists, builds, and is the canonical home for ErrorCode + JobConfig/FieldDef/Action schemas + enums. `@spatula/shared` and `@spatula/core` re-export from it for backward compat.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add ESLint rule blocking non-type imports from `@spatula/core-types`; verify reverse-contract test stays green</name>
  <files>
    eslint.config.mjs,
    tests/private-contract/oss-surface.test.ts,
    packages/core/src/index.ts,
    apps/api/src/schemas/responses.ts
  </files>
  <read_first>
    - eslint.config.mjs (current root ESLint config; the rule lives here so it applies to the whole monorepo)
    - tests/private-contract/oss-surface.test.ts (Phase 15 reverse-contract test — Task 2 EXTENDS with one new describe block per 16-RESEARCH "Open Questions" #2)
    - packages/core/src/index.ts (verify the re-export shim from Task 1 covers what oss-surface.test.ts pins)
    - apps/api/src/schemas/responses.ts (errorResponseSchema — Task 2 changes `code` from `z.string()` to a type-narrowed alternative via JSDoc; NOTE: changing to `z.nativeEnum(ErrorCode)` would couple OpenAPI generation tightly — keep as `z.string()` with an OpenAPI `enum` annotation pulled from ErrorCode values)
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § D-10 (ESLint rule design)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Code Examples" `eslint.config.mjs` for the rule + § "Don't Hand-Roll" entry (use `@typescript-eslint/no-restricted-imports`, NOT a custom plugin)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Open Questions" #2 (oss-surface.test.ts extension recommendation)
  </read_first>
  <behavior>
    - `eslint.config.mjs` ADD (or extend) a rule under the `@typescript-eslint/no-restricted-imports` config:
      ```javascript
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{
          name: '@spatula/core-types',
          allowTypeImports: true,
          message: '@spatula/core-types is type-only. Use `import type { X }` or move runtime values to @spatula/core / @spatula/shared.',
        }],
      }],
      ```
    - Run `pnpm lint` and fix any violations. EXPECTED violations (and fix):
      - Anywhere a `.ts` file does `import { ErrorCode } from '@spatula/core-types'` — change to `import { ErrorCode } from '@spatula/shared'` (the shared shim still exports it for runtime use). Reason: `ErrorCode` is a const object — it IS a runtime value. core-types declares it but the ESLint rule blocks value-imports from core-types directly. Consumers use it via `@spatula/shared`.
      - Any `import { JobConfigSchema } from '@spatula/core-types'` — change to `import { JobConfigSchema } from '@spatula/core'` (which re-exports it transitively).
    - The ESLint rule is the OS-side enforcement of D-10. Combined with the const-object pattern in core-types (NOT a TS enum, NOT a class), value-imports from core-types become an organizational/convention issue, not a runtime risk.
    - `tests/private-contract/oss-surface.test.ts` gets a new describe block:
      ```typescript
      describe('@spatula/core-types extract preserves @spatula/core type surface', () => {
        it('re-exports JobConfig type via @spatula/core', () => {
          // Compilation gate — if this file compiles, the type is visible.
          type _Test = import('@spatula/core').JobConfig;
          expect(true).toBe(true);
        });
        it('re-exports ActionType type via @spatula/core', () => {
          type _Test = import('@spatula/core').ActionType;
          expect(true).toBe(true);
        });
        it('re-exports ErrorCode (const object) via @spatula/core', async () => {
          const core = await import('@spatula/core');
          expect(typeof core.ErrorCode).toBe('object');
        });
      });
      ```
    - `apps/api/src/schemas/responses.ts` (`errorResponseSchema`): the `code` field stays as `z.string()` BUT add an `openapi({ enum: [...Object.values(ErrorCode)] })` annotation so the OpenAPI document declares the closed set. The `enum` source needs ErrorCode imported as a TYPE only (per ESLint rule, since `responses.ts` is the schema source-of-truth). Use:
      ```typescript
      import { ErrorCode } from '@spatula/shared';   // VALUE import from shared (allowed; the rule only blocks core-types direct value imports)
      // ...
      code: z.string().openapi({ description: 'DOMAIN.CODE — frozen at v1', enum: Object.values(ErrorCode) }),
      ```
  </behavior>
  <action>
    Step 1: Read current `eslint.config.mjs`. Identify the TypeScript-rules block (the one that already applies to `**/*.ts`).

    Step 2: Add the `no-restricted-imports` rule with `allowTypeImports: true`. If the rule already exists for OTHER paths, append a new `paths` entry — do NOT remove existing entries.

    Step 3: Run `pnpm lint 2>&1 | tee /tmp/lint-violations.txt`. Read each violation. For each `import { X } from '@spatula/core-types'` (value import):
    - If `X` is a const-object (`ErrorCode`, `STATUS_MAP`, `ActionType`, `JobStatus`, `Scope`) — change to `from '@spatula/shared'` (or `@spatula/core` for action-related values; `@spatula/shared` re-exports the error codes).
    - If `X` is a zod schema (`JobConfigSchema`, `FieldDefSchema`, etc.) — change to `from '@spatula/core'` (which re-exports them).
    - If `X` is a type — change `import {` to `import type {` (the rule allows this).

    Step 4: Update `apps/api/src/schemas/responses.ts` `errorResponseSchema.code` to include the OpenAPI `enum` annotation derived from `Object.values(ErrorCode)`. Import path: `from '@spatula/shared'` (since `responses.ts` USES it at runtime to enumerate values).

    Step 5: Extend `tests/private-contract/oss-surface.test.ts` with the new describe block per <behavior>.

    Step 6: Run `pnpm lint && pnpm test:private-contract && pnpm --filter @spatula/api typecheck` — all three must be green.
  </action>
  <verify>
    <automated>pnpm lint && pnpm test:private-contract && pnpm --filter @spatula/api typecheck && grep -q "@spatula/core-types" eslint.config.mjs && grep -q "allowTypeImports" eslint.config.mjs && grep -q "core-types extract preserves" tests/private-contract/oss-surface.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `eslint.config.mjs` contains a `no-restricted-imports` rule entry naming `@spatula/core-types` with `allowTypeImports: true` — `grep -A 5 "no-restricted-imports" eslint.config.mjs | grep -q "@spatula/core-types"` AND `grep -q "allowTypeImports" eslint.config.mjs`
    - `pnpm lint` passes (no violations of the new rule remain)
    - `tests/private-contract/oss-surface.test.ts` contains the new describe block — `grep -q "core-types extract preserves" tests/private-contract/oss-surface.test.ts`
    - `pnpm test:private-contract` passes (reverse-contract test green; carve-out from Phase 15 not regressed by the type extraction)
    - `apps/api/src/schemas/responses.ts` annotates errorResponseSchema with OpenAPI `enum: Object.values(ErrorCode)` — `grep -A 2 "errorResponseSchema" apps/api/src/schemas/responses.ts | grep -q "enum"`
    - **Verification of D-10 enforcement** — attempt to add a value import in a scratch file:
      ```bash
      echo "import { ErrorCode } from '@spatula/core-types';" > /tmp/violation.ts
      cp /tmp/violation.ts packages/shared/src/__lint_test.ts && pnpm lint packages/shared/src/__lint_test.ts; rm packages/shared/src/__lint_test.ts
      ```
      should EXIT NON-ZERO (rule fires). This is the proof D-10 holds.
    - Implements per D-10 (ESLint rule) and addresses 16-RESEARCH "Open Question" #2 (oss-surface.test.ts extension).
  </acceptance_criteria>
  <done>
    The ESLint rule actively forbids value imports from `@spatula/core-types`; the reverse-contract test (extended) is green; downstream consumers route through `@spatula/shared` or `@spatula/core` for runtime values.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Create `@spatula/client` package skeleton + SpatulaClient class + class-per-code codegen + size-limit gate + experimental namespace scaffolding</name>
  <files>
    packages/client/package.json,
    packages/client/tsconfig.json,
    packages/client/vitest.config.ts,
    packages/client/size-limit.json,
    packages/client/src/index.ts,
    packages/client/src/client.ts,
    packages/client/src/errors/base.ts,
    packages/client/src/errors/generated.ts,
    packages/client/src/methods/create-job.ts,
    packages/client/src/methods/list-jobs.ts,
    packages/client/src/methods/get-entities.ts,
    packages/client/src/methods/get-job-events.ts,
    packages/client/src/experimental/index.ts,
    packages/client/scripts/gen-error-classes.ts,
    packages/client/tests/unit/client.test.ts,
    packages/client/tests/unit/errors-generated.test.ts,
    packages/client/tests/unit/experimental-namespace.test.ts,
    packages/client/README.md
  </files>
  <read_first>
    - packages/core-types/src/errors/codes.ts (Task 1 output — codegen reads ErrorCode + STATUS_MAP from here)
    - packages/core-types/src/index.ts (re-export structure)
    - apps/cli/src/api/spatula-api-client.ts and apps/cli/src/api/client.ts (existing fetch-based API client — REUSE the request/response patterns; the CLI keeps its own client for Phase 16, full migration deferred per CONTEXT.md)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Architecture Patterns" Pattern 4 (size-limit config) + Pattern 6 (lazy version probe — NOTE: version probe is plan 16-3, not this plan)
    - .planning/phases/16-api-contract-sdk-packages/16-RESEARCH.md § "Common Pitfalls" Pitfall #5 (size-limit measures imported surface, NOT full export) + Pitfall #6 (codegen drift) + Anti-Pattern "Constructor I/O" + "Generated-at-build-time"
    - .planning/phases/16-api-contract-sdk-packages/16-CONTEXT.md § D-11 (codegen committed output), D-12 (lazy probe — plan 16-3 wires it; this plan reserves the spot)
    - docs/superpowers/specs/2026-04-20-wave-6-phase-14-public-launch-design.md § 3.2.1 (client properties), § 3.2.5 (compat matrix), § 3.3.11 (experimental tag policy)
  </read_first>
  <behavior>
    - `packages/client/package.json`:
      ```json
      {
        "name": "@spatula/client",
        "version": "0.0.1",
        "description": "Spatula API client — TypeScript SDK for the Spatula REST API. ESM-only, browser+Node compatible, fetch-based.",
        "license": "MIT",
        "type": "module",
        "main": "./dist/index.js",
        "types": "./dist/index.d.ts",
        "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
        "files": ["dist", "README.md"],
        "engines": { "node": ">=22" },
        "sideEffects": false,
        "publishConfig": { "access": "public", "provenance": true },
        "peerDependencies": { "@spatula/core-types": "0.x", "zod": ">=3.22.0 <5.0.0" },
        "devDependencies": {
          "typescript": "^5.7.0",
          "vitest": "^2.1.0",
          "zod": "^3.24.0",
          "@spatula/core-types": "workspace:*",
          "size-limit": "^12.1.0",
          "@size-limit/esbuild": "^12.1.0",
          "@size-limit/preset-small-lib": "^12.1.0"
        },
        "scripts": {
          "build": "tsc",
          "test": "vitest run",
          "typecheck": "tsc --noEmit",
          "size": "size-limit",
          "gen:errors": "tsx scripts/gen-error-classes.ts",
          "clean": "rm -rf dist .turbo"
        },
        "size-limit": "./size-limit.json"
      }
      ```
    - `size-limit.json` (per 16-RESEARCH Pattern 4 — uses SI lowercase `kB` to match the research snippet's budget baseline; size-limit accepts both `KB` and `kB`, but locking to `kB` keeps the gate aligned with the research's 50 kB measurement):
      ```json
      [
        {
          "name": "core client surface",
          "path": "dist/index.js",
          "import": "{ SpatulaClient, createJob, listJobs, getEntities }",
          "limit": "50 kB",
          "gzip": true,
          "esbuild": {
            "format": "esm",
            "platform": "browser",
            "target": "es2022",
            "bundle": true,
            "minify": true,
            "treeShaking": true
          }
        }
      ]
      ```
      (`@size-limit/preset-small-lib` provides esbuild adapter defaults; the explicit `esbuild` block locks the measurement to ESM + browser platform + es2022 + minify + tree-shake, mirroring spec §3.2.1's "esbuild --bundle --minify --format=esm --platform=browser" wording exactly. Do NOT omit the `esbuild` block — preset defaults vary across size-limit versions and the explicit form makes the measurement reproducible.)
    - `src/errors/base.ts`:
      ```typescript
      export class SpatulaApiError extends Error {
        readonly code: string;
        readonly status: number;
        readonly requestId: string;
        readonly details?: Record<string, unknown>;
        constructor(opts: { code: string; message: string; status: number; requestId: string; details?: Record<string, unknown> }) {
          super(opts.message);
          this.name = 'SpatulaApiError';
          this.code = opts.code;
          this.status = opts.status;
          this.requestId = opts.requestId;
          this.details = opts.details;
        }
      }
      export class SpatulaVersionMismatchError extends SpatulaApiError {
        constructor(opts: ConstructorParameters<typeof SpatulaApiError>[0]) {
          super(opts);
          this.name = 'SpatulaVersionMismatchError';
        }
      }
      export class FeatureUnavailableError extends SpatulaApiError {
        constructor(opts: ConstructorParameters<typeof SpatulaApiError>[0]) {
          super(opts);
          this.name = 'FeatureUnavailableError';
        }
      }
      ```
    - `src/errors/generated.ts`: codegen output. One class per ErrorCode value. Example:
      ```typescript
      // GENERATED by scripts/gen-error-classes.ts. Edit codes.ts instead. CI verifies via git diff --exit-code.
      // Source: @spatula/core-types ErrorCode @ <hash>
      import { SpatulaApiError } from './base.js';
      export class JobNotFoundError extends SpatulaApiError { static readonly code = 'JOB.NOT_FOUND'; constructor(opts: Omit<ConstructorParameters<typeof SpatulaApiError>[0], 'code'>) { super({ ...opts, code: 'JOB.NOT_FOUND' }); this.name = 'JobNotFoundError'; } }
      // ... one per code (~24 classes)
      export const ERROR_CLASS_BY_CODE: Record<string, typeof SpatulaApiError> = {
        'JOB.NOT_FOUND': JobNotFoundError,
        // ... full map
      };
      export function decodeError(envelope: { code: string; message: string; requestId: string; details?: Record<string, unknown> }, status: number): SpatulaApiError {
        const Ctor = ERROR_CLASS_BY_CODE[envelope.code] ?? SpatulaApiError;
        return new Ctor({ ...envelope, status });
      }
      ```
    - `scripts/gen-error-classes.ts`: tsx script that imports `ErrorCode` from `@spatula/core-types` and writes `src/errors/generated.ts`. Idempotent — same input → byte-identical output.
    - `src/client.ts`: `SpatulaClient` class with constructor `{ baseUrl, apiKey, fetch? }`. Constructor stores params — NO I/O (D-12 / Anti-Pattern "Constructor I/O"). `request<T>(method, path, body?)` → fetch wrapper that:
      - Adds `Authorization: Bearer ${apiKey}` header
      - On non-2xx: parses response body as `{error:{code,message,requestId,details?}}`, calls `decodeError(envelope, status)`, throws the result
      - On 2xx: returns parsed JSON
    - `src/methods/{create-job,list-jobs,get-entities,get-job-events}.ts`: standalone helper functions that take a `SpatulaClient` instance and typed params; call `client.request(...)`. These are the four "measured surface" methods named in the size-limit config. Stubs are sufficient at this plan (full method bodies + integration tests in plan 16-5; minimal happy path here so the size-limit gate can measure something real).
    - `src/experimental/index.ts`:
      ```typescript
      export function createExperimentalNamespace(): Record<string, never> {
        return new Proxy({} as Record<string, never>, {
          get(_target, prop) {
            throw new Error(
              `client.experimental.${String(prop)} is not available — Spatula v1.0 ships with zero experimental surfaces. ` +
              `See docs/deprecation-policy.md. First experimental surface (forensic-extractions admin endpoint) lands in Phase 18.`
            );
          },
        });
      }
      ```
      The `SpatulaClient` instance exposes `this.experimental = createExperimentalNamespace()`.
    - `src/index.ts`:
      ```typescript
      export { SpatulaClient } from './client.js';
      export { createJob } from './methods/create-job.js';
      export { listJobs } from './methods/list-jobs.js';
      export { getEntities } from './methods/get-entities.js';
      export { getJobEvents } from './methods/get-job-events.js';
      export * from './errors/base.js';
      export * from './errors/generated.js';
      ```
    - Tests:
      - `tests/unit/client.test.ts`: assert constructor doesn't fire I/O (mock fetch + observe zero calls until `request()` invoked); assert `request()` on 404 with `{error:{code:'JOB.NOT_FOUND',message:'...',requestId:'r1'}}` body THROWS a `JobNotFoundError` instance with `.code === 'JOB.NOT_FOUND'`.
      - `tests/unit/errors-generated.test.ts`: assert `ERROR_CLASS_BY_CODE` keys are exactly equal to `Object.values(ErrorCode)`; assert `decodeError` returns the matching subclass; assert unknown codes fall back to `SpatulaApiError`.
      - `tests/unit/experimental-namespace.test.ts`: assert `(new SpatulaClient(...)).experimental.foo` throws an Error whose message contains `'zero experimental surfaces'`.
  </behavior>
  <action>
    Step 1: `mkdir -p packages/client/src/{errors,methods,experimental} packages/client/tests/unit packages/client/scripts`

    Step 2: Write `packages/client/package.json`, `tsconfig.json`, `vitest.config.ts`, `size-limit.json` per <behavior>.

    Step 3: Install client deps: `pnpm --filter @spatula/client add -D size-limit@^12.1.0 @size-limit/esbuild@^12.1.0 @size-limit/preset-small-lib@^12.1.0 tsx@latest` and `pnpm --filter @spatula/client add @spatula/core-types@workspace:*` (peer).

    Step 4: Write `src/errors/base.ts`, `src/experimental/index.ts`, `src/client.ts`, `src/methods/*.ts` per <behavior>.

    Step 5: Write `scripts/gen-error-classes.ts`:
    ```typescript
    #!/usr/bin/env -S pnpm tsx
    import { writeFileSync } from 'node:fs';
    import { resolve } from 'node:path';
    // Import ErrorCode VALUE via @spatula/shared (which re-exports it from @spatula/core-types).
    // The monorepo ESLint rule added in Task 2 blocks value-imports from @spatula/core-types
    // directly; this codegen script complies by going through the @spatula/shared shim.
    import { ErrorCode } from '@spatula/shared';

    const HEADER = `// GENERATED by scripts/gen-error-classes.ts on ${new Date().toISOString().slice(0, 10)}. Edit @spatula/core-types/src/errors/codes.ts instead. CI verifies via git diff --exit-code.\nimport { SpatulaApiError } from './base.js';\n\n`;

    function classNameFor(code: string): string {
      // 'JOB.NOT_FOUND' -> 'JobNotFoundError'
      return code.split(/[._]/).map(p => p[0] + p.slice(1).toLowerCase()).join('') + 'Error';
    }

    const lines: string[] = [HEADER];
    const mapEntries: string[] = [];
    for (const [_key, code] of Object.entries(ErrorCode)) {
      const cls = classNameFor(code);
      lines.push(
        `export class ${cls} extends SpatulaApiError {\n` +
        `  static readonly code = '${code}';\n` +
        `  constructor(opts: Omit<ConstructorParameters<typeof SpatulaApiError>[0], 'code'>) {\n` +
        `    super({ ...opts, code: '${code}' });\n` +
        `    this.name = '${cls}';\n` +
        `  }\n` +
        `}\n`
      );
      mapEntries.push(`  '${code}': ${cls},`);
    }
    lines.push(`\nexport const ERROR_CLASS_BY_CODE: Record<string, typeof SpatulaApiError> = {\n${mapEntries.join('\n')}\n};\n`);
    lines.push(`\nexport function decodeError(envelope: { code: string; message: string; requestId: string; details?: Record<string, unknown> }, status: number): SpatulaApiError {\n  const Ctor = ERROR_CLASS_BY_CODE[envelope.code] ?? SpatulaApiError;\n  return new Ctor({ ...envelope, status });\n}\n`);

    const out = resolve(import.meta.dirname, '../src/errors/generated.ts');
    writeFileSync(out, lines.join(''));
    console.log(`Wrote ${out} (${Object.values(ErrorCode).length} classes)`);
    ```

    Step 6: Run codegen once: `pnpm --filter @spatula/client gen:errors`. Verify `src/errors/generated.ts` is written. **Commit the generated file** (D-11 — committed output, NOT build-time generated).

    Step 7: Write `src/index.ts` barrel per <behavior>.

    Step 8: Write the three unit test files per <behavior>. Mock `globalThis.fetch` via `vi.stubGlobal('fetch', mockFn)`.

    Step 9: Write `packages/client/README.md`:
    ```markdown
    # @spatula/client

    Spatula API client — TypeScript SDK for the Spatula REST API.

    ## Properties

    - ESM-only (no CommonJS shim — use `@spatula/cli`'s dual build if you need CJS)
    - Browser + Node 22+ compatible
    - Fetch-based — uses global `fetch` (override via constructor option)
    - `sideEffects: false` — fully tree-shakeable
    - **Measured surface ≤ 50 KB gzipped** for `{ SpatulaClient, createJob, listJobs, getEntities }` (see `size-limit.json`)

    ## Stability

    See `docs/compat-policy.md` for the full SDK ↔ server ↔ @spatula/core-types compatibility matrix.

    ## Size budget

    The 50KB limit measures ONLY the named surface above (`SpatulaClient` + 3 methods). Importing the full module (e.g., `import * as client from '@spatula/client'`) pulls in additional methods + class-per-code error subclasses (~25 classes) and will exceed 50KB. This is by design — tree-shaking in your bundler eliminates unused subclasses.

    ## Experimental namespace

    `client.experimental` is reserved. v1.0 ships zero experimental surfaces. The first surface (admin forensic-extractions endpoint) lands in Phase 18 per `docs/deprecation-policy.md`. Until then, any access throws.

    ## Generated error classes

    Class-per-code error subclasses live in `src/errors/generated.ts` and are checked into git. The generator script (`scripts/gen-error-classes.ts`) is the source of truth and runs in CI via `pnpm gen:errors && git diff --exit-code` to catch drift.
    ```

    Step 10: Build, test, size: `pnpm --filter @spatula/client build && pnpm --filter @spatula/client test && pnpm --filter @spatula/client size`. The size check must pass at < 50KB.

    Step 11: Update `apps/api/src/schemas/responses.ts` to import `ErrorCode` from `@spatula/core-types` AS A TYPE (no value import — ESLint blocks). For the `enum: Object.values(ErrorCode)` annotation needed in Task 2, value-import from `@spatula/shared` (the shim). This is consistent with Task 2.
  </action>
  <verify>
    <automated>pnpm --filter @spatula/client build && pnpm --filter @spatula/client test && pnpm --filter @spatula/client size && pnpm --filter @spatula/client gen:errors && git diff --exit-code packages/client/src/errors/generated.ts && grep -q "class SpatulaClient" packages/client/src/client.ts && grep -q "decodeError" packages/client/src/errors/generated.ts && grep -q "zero experimental surfaces" packages/client/src/experimental/index.ts && test -f packages/client/size-limit.json</automated>
  </verify>
  <acceptance_criteria>
    - `packages/client/package.json` contains `"sideEffects": false`, `"type": "module"`, `"engines": { "node": ">=22" }`, explicit `"exports"` mapping, `"publishConfig": { "access": "public", "provenance": true }` — verified by grep
    - `packages/client/src/client.ts` defines a `class SpatulaClient` — `grep -q "class SpatulaClient" packages/client/src/client.ts`
    - `packages/client/src/errors/generated.ts` exists AND is committed AND `pnpm gen:errors && git diff --exit-code packages/client/src/errors/generated.ts` returns clean (codegen is idempotent — Pitfall #6 protection)
    - `packages/client/scripts/gen-error-classes.ts` imports `ErrorCode` from `@spatula/shared` (NOT `@spatula/core-types`) — `grep -q "from '@spatula/shared'" packages/client/scripts/gen-error-classes.ts` succeeds AND `! grep -q "from '@spatula/core-types'" packages/client/scripts/gen-error-classes.ts` (the script must NOT directly value-import from core-types; the Task 2 ESLint rule would fail it otherwise — the shim form is the contract)
    - `packages/client/src/errors/generated.ts` contains AT LEAST 10 class declarations + `decodeError` + `ERROR_CLASS_BY_CODE` — `grep -c "^export class.*Error extends SpatulaApiError" packages/client/src/errors/generated.ts` ≥ 10
    - `packages/client/size-limit.json` exists with `"limit": "50 kB"` (SI lowercase per research Pattern 4 snippet) AND `"gzip": true` AND `"import": "{ SpatulaClient, createJob, listJobs, getEntities }"` — verified by `grep -q '"limit": "50 kB"' packages/client/size-limit.json`
    - `packages/client/size-limit.json` contains an `"esbuild"` block with `"platform": "browser"` (locking the measurement to the spec §3.2.1 build target). Verified by `jq -e '.[0].esbuild.platform == "browser"' packages/client/size-limit.json`
    - `pnpm --filter @spatula/client size` reports `< 50 KB` (under budget) AND exits 0
    - `packages/client/src/experimental/index.ts` contains `'zero experimental surfaces'` string AND a `Proxy` — `grep -q "Proxy" packages/client/src/experimental/index.ts`
    - Constructor I/O test passes: `SpatulaClient` constructor doesn't trigger fetch (Anti-Pattern protection per D-12)
    - `pnpm --filter @spatula/client test` passes — all three unit test files green
    - Implements SDK-01 (zero runtime deps for core-types — verified by `! grep -q '"dependencies"' packages/core-types/package.json | head -1`), SDK-02 (SpatulaClient class + typed errors), SDK-03 (size-limit < 50KB).
  </acceptance_criteria>
  <done>
    `@spatula/client` package exists, builds, has class-per-code generated errors COMMITTED, passes the 50KB size budget, scaffolds `experimental` namespace. CI gate (size + codegen drift) is ready to wire in plan 16-4's CI workflow update.
  </done>
</task>

</tasks>

<verification>
1. `pnpm --filter @spatula/core-types build && pnpm --filter @spatula/client build && pnpm build` — full monorepo build is green (no broken imports from the type extraction).
2. `pnpm --filter @spatula/core-types test && pnpm --filter @spatula/client test && pnpm test:private-contract` — all three suites green.
3. `pnpm --filter @spatula/client size` reports < 50KB.
4. `pnpm --filter @spatula/client gen:errors && git diff --exit-code packages/client/src/errors/generated.ts` — codegen is byte-stable.
5. `pnpm lint` — green, including the new `no-restricted-imports` rule.
6. Manual: ensure `@spatula/core-types/dist/index.d.ts` exports `JobConfig`, `FieldDef`, `ActionType`, `ErrorCode`. `cat packages/core-types/dist/index.d.ts | grep -E "(JobConfig|FieldDef|ActionType|ErrorCode)"` returns ≥ 4 lines.
</verification>

<success_criteria>
- SDK-01: `@spatula/core-types` has zero runtime deps (only zod as peer); ESLint rule blocks non-type imports. Verified by package.json grep + `pnpm lint`.
- SDK-02: `SpatulaClient` class exists, exposes `{createJob, listJobs, getEntities, getJobEvents}` as helper methods, throws class-per-code subclasses on 4xx/5xx. Verified by unit tests.
- SDK-03: `pnpm --filter @spatula/client size` reports < 50KB gzipped for the measured surface. Verified by CI gate config + manual run.
- ErrorCode enum + STATUS_MAP MOVED from `@spatula/shared` to `@spatula/core-types`; re-export shim keeps `@spatula/shared.ErrorCode` working.
- `tests/private-contract/oss-surface.test.ts` extended with `@spatula/core-types` re-export assertions; remains green.
- `client.experimental.*` namespace scaffolding (empty Proxy) is in place for Phase 18 first surface (forensic-extractions).
</success_criteria>

<output>
After completion, create `.planning/phases/16-api-contract-sdk-packages/16-2-SUMMARY.md` recording:
- Final `@spatula/core-types` export inventory (count of types, schemas, enums, error codes)
- Final `@spatula/client` measured-surface size (gzipped KB number)
- Number of generated error classes (should match ErrorCode enum size from 16-1)
- Any ESLint rule violations encountered + how resolved (which packages had to refactor imports)
- `tests/private-contract/oss-surface.test.ts` line count delta (extended block size)
- Note: version probe (D-12) wires in plan 16-3
- Note: SDK integration test suite (SDK-08) lands in plan 16-5
</output>
