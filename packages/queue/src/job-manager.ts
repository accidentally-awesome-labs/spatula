import { createLogger, StorageError } from '@spatula/shared';
import type { JobConfig, JobStatus } from '@spatula/core';
import type { JobRepository, CrawlTaskRepository, SchemaRepository } from '@spatula/db';
import type { SpatulaQueues } from './queues.js';
import { JobStateMachine } from './state-machine.js';

const logger = createLogger('job-manager');

export interface JobManagerConfig {
  jobRepo: JobRepository;
  taskRepo: CrawlTaskRepository;
  schemaRepo: SchemaRepository;
  queues: SpatulaQueues;
}

export class JobManager {
  private readonly jobRepo: JobRepository;
  private readonly taskRepo: CrawlTaskRepository;
  private readonly schemaRepo: SchemaRepository;
  private readonly queues: SpatulaQueues;

  constructor(config: JobManagerConfig) {
    this.jobRepo = config.jobRepo;
    this.taskRepo = config.taskRepo;
    this.schemaRepo = config.schemaRepo;
    this.queues = config.queues;
  }

  async createJob(config: JobConfig): Promise<string> {
    const job = await this.jobRepo.create({
      tenantId: config.tenantId,
      name: config.name,
      description: config.description,
      config,
    });
    logger.info({ jobId: job.id }, 'job created');
    return job.id;
  }

  async startJob(jobId: string, tenantId: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);

    // Validate the full transition chain, then write the final state atomically
    JobStateMachine.transition(job.status as JobStatus, 'queued');
    JobStateMachine.transition('queued', 'running');
    await this.jobRepo.updateStatus(jobId, tenantId, 'running');

    const config = job.config as JobConfig;
    const initialFields = config.schema.userFields ?? [];
    await this.schemaRepo.create({
      jobId,
      tenantId,
      version: 1,
      definition: {
        version: 1,
        fields: initialFields,
        fieldAliases: [],
        createdAt: new Date(),
        parentVersion: null,
      },
    });

    for (const url of config.seedUrls) {
      const task = await this.taskRepo.enqueue({
        jobId,
        tenantId,
        url,
        depth: 0,
        priority: 'high',
      });

      await this.queues.crawl.add(`crawl:${url}`, {
        taskId: task.id,
        jobId,
        tenantId,
        url,
        depth: 0,
      });
    }

    logger.info({ jobId, seedUrls: config.seedUrls.length }, 'job started');
  }

  async pauseJob(jobId: string, tenantId: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    JobStateMachine.transition(job.status as JobStatus, 'paused');
    await this.jobRepo.updateStatus(jobId, tenantId, 'paused');
    logger.info({ jobId }, 'job paused');
  }

  async resumeJob(jobId: string, tenantId: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    JobStateMachine.transition(job.status as JobStatus, 'running');
    await this.jobRepo.updateStatus(jobId, tenantId, 'running');
    logger.info({ jobId }, 'job resumed');
  }

  async cancelJob(jobId: string, tenantId: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    JobStateMachine.transition(job.status as JobStatus, 'cancelled');
    await this.jobRepo.updateStatus(jobId, tenantId, 'cancelled');
    logger.info({ jobId }, 'job cancelled');
  }

  async getJobStatus(jobId: string, tenantId: string): Promise<JobStatus> {
    const job = await this.getJob(jobId, tenantId);
    return job.status as JobStatus;
  }

  private async getJob(jobId: string, tenantId: string) {
    const job = await this.jobRepo.findById(jobId, tenantId);
    if (!job) {
      throw new StorageError(`Job not found: ${jobId}`, {
        context: { jobId, tenantId },
      });
    }
    return job;
  }
}
