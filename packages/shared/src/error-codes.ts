/**
 * @spatula/shared: error-codes.ts (re-export shim)
 *
 * The frozen `ErrorCode` enum + `STATUS_MAP` live in `@spatula/core-types`
 * This shim
 * preserves the legacy import path `@spatula/shared` for both the runtime
 * value AND the type.
 *
 * Consumers MUST import the runtime VALUE via `@spatula/shared` (or
 * `@spatula/core`), NOT directly from `@spatula/core-types` — the monorepo
 * ESLint rule (`no-restricted-imports` + `allowTypeImports: true`) blocks
 * value imports from `@spatula/core-types` directly. Type imports may still
 * go either way.
 *
 * The companion test (`tests/error-codes.test.ts`) continues to import from
 * this module and is therefore implicitly testing the @spatula/core-types
 * source through the shim. The canonical test lives next to the source at
 * `packages/core-types/src/errors/codes.test.ts`.
 */
export { ErrorCode, STATUS_MAP } from '@spatula/core-types';
export type { ErrorCode as ErrorCodeType } from '@spatula/core-types';
