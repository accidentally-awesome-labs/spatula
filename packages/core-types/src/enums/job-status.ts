/**
 * Frozen v1 job-status enum.
 *
 * Mirrors the `JobStatus` zod enum in `./schemas/job.ts` as a lightweight
 * const-object so callers can import it without pulling in zod. Frozen at v1;
 * additive-only in 1.x.
 */
export const JobStatus = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  RECONCILING: 'reconciling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];
