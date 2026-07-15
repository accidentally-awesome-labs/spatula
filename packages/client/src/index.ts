/**
 * @accidentally-awesome-labs/spatula-client — Spatula API client (TypeScript SDK).
 *
 * ESM-only. Browser + Node 22+ compatible. fetch-based. `sideEffects: false`.
 *
 * Measured surface (target: <= 50 KB gzipped):
 *   { SpatulaClient, createJob, listJobs, getEntities }
 *
 * Importing the full module pulls in additional methods + the 26 generated
 * error subclasses; rely on your bundler's tree-shaking to drop unused ones.
 */
export { SpatulaClient, SpatulaApiError } from './client.js';
export type { SpatulaClientOptions, HttpMethod, ApiErrorEnvelope } from './client.js';

export { createJob } from './methods/create-job.js';
export type { CreateJobInput, CreateJobResult } from './methods/create-job.js';

export { listJobs } from './methods/list-jobs.js';
export type { ListJobsParams, ListJobsResult, JobListItem } from './methods/list-jobs.js';

export { getEntities } from './methods/get-entities.js';
export type {
  GetEntitiesParams,
  GetEntitiesResult,
  EntityListItem,
} from './methods/get-entities.js';

export { getJobEvents, subscribeJobEvents } from './methods/get-job-events.js';
export type {
  JobEvent,
  SubscribeJobEventsOptions,
  ReplayTruncatedPayload,
  UnsubscribeFn,
} from './methods/get-job-events.js';

export { SpatulaVersionMismatchError, FeatureUnavailableError } from './errors/base.js';
export type { SpatulaApiErrorOpts } from './errors/base.js';

// Lazy version probe. Exported for advanced consumers who want to drive
// `ensure()` manually (e.g., a `doctor`-style command that wants to surface
// major-mismatch ahead of any user-visible request). Most callers use
// `SpatulaClient` directly.
export { VersionProbe } from './version-probe.js';
export type { VersionProbeOptions } from './version-probe.js';

export * from './errors/generated.js';
