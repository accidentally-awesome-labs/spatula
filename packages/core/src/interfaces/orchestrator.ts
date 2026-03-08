import type { JobConfig, JobStatus } from '../types/job.js';

export interface JobOrchestrator {
  createJob(config: JobConfig): Promise<string>;
  startJob(jobId: string): Promise<void>;
  pauseJob(jobId: string): Promise<void>;
  resumeJob(jobId: string): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
  getJobStatus(jobId: string): Promise<JobStatus>;
}
