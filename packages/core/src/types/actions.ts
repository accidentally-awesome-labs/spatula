// Re-export shim: moved to @spatula/core-types in plan 16-2.
// Internal callers import from this path; the canonical source lives in
// `@spatula/core-types/src/schemas/action.ts`.
export { ActionSource, ActionStatus, SafetyPolicy, PipelineAction } from '@spatula/core-types';
