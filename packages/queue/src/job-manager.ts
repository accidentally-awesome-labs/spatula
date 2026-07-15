import {
  createLogger,
  StorageError,
  ValidationSchemaError,
} from '@accidentally-awesome-labs/spatula-shared';
import type { AuditLogger } from '@accidentally-awesome-labs/spatula-shared';
import {
  isValidCrawlUrl,
  type JobConfig,
  type JobStatus,
} from '@accidentally-awesome-labs/spatula-core';
import type {
  JobRepository,
  CrawlTaskRepository,
  SchemaRepository,
} from '@accidentally-awesome-labs/spatula-db';
import type { TenantRepository } from '@accidentally-awesome-labs/spatula-db';
import { QuotaExceededError } from '@accidentally-awesome-labs/spatula-shared';
import type { SpatulaQueues } from './queues.js';
import { JobStateMachine } from './state-machine.js';
import { enqueueWebhookIfConfigured } from './webhook-sender.js';

const logger = createLogger('job-manager');

function shouldRejectPrivateSeedUrls(): boolean {
  if (process.env.SPATULA_ALLOW_PRIVATE_CRAWL_URLS === '1') return false;
  if (process.env.SPATULA_ALLOW_PRIVATE_CRAWL_URLS === '0') return true;
  return process.env.NODE_ENV === 'production';
}

export interface JobManagerConfig {
  jobRepo: JobRepository;
  taskRepo: CrawlTaskRepository;
  schemaRepo: SchemaRepository;
  queues: SpatulaQueues;
  tenantRepo?: TenantRepository;
  auditLogger?: AuditLogger;
}

export class JobManager {
  private readonly jobRepo: JobRepository;
  private readonly taskRepo: CrawlTaskRepository;
  private readonly schemaRepo: SchemaRepository;
  private readonly queues: SpatulaQueues;
  private readonly tenantRepo?: TenantRepository;
  private readonly auditLogger?: AuditLogger;

  constructor(config: JobManagerConfig) {
    this.jobRepo = config.jobRepo;
    this.taskRepo = config.taskRepo;
    this.schemaRepo = config.schemaRepo;
    this.queues = config.queues;
    this.tenantRepo = config.tenantRepo;
    this.auditLogger = config.auditLogger;
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

    // Check concurrent job quota (config-driven; limits simultaneous running jobs)
    if (this.tenantRepo) {
      try {
        const quotas = await this.tenantRepo.getQuotas(tenantId);
        const maxConcurrent = (quotas as any).maxConcurrentJobs ?? 2;
        const runningCount = await this.jobRepo.countByTenant(tenantId, { status: 'running' });
        if (runningCount >= maxConcurrent) {
          if (this.auditLogger) {
            this.auditLogger.log({
              action: 'quota.exceeded',
              actorId: 'system',
              actorType: 'system',
              tenantId,
              metadata: { dimension: 'concurrent_jobs', current: runningCount, max: maxConcurrent },
            });
          }
          throw new QuotaExceededError(
            `Concurrent job limit reached: ${runningCount}/${maxConcurrent}`,
            { context: { tenantId, current: runningCount, max: maxConcurrent } },
          );
        }
      } catch (error) {
        // QUOTA.EXCEEDED is the Phase-16 frozen code; QUOTA_EXCEEDED retained
        // for defense-in-depth in case any in-flight stack still throws legacy.
        if ((error as any).code === 'QUOTA.EXCEEDED' || (error as any).code === 'QUOTA_EXCEEDED')
          throw error;
        logger.warn({ err: error, tenantId }, 'Failed to check job quota');
      }
    }

    const config = job.config as JobConfig;
    if (shouldRejectPrivateSeedUrls()) {
      const blockedUrl = config.seedUrls.find((url) => !isValidCrawlUrl(url));
      if (blockedUrl) {
        throw new ValidationSchemaError(
          'Private, loopback, link-local, and reserved seed URLs are disabled in production',
          { context: { url: blockedUrl } },
        );
      }
    }

    // Validate the full transition chain, then write the final state atomically
    JobStateMachine.transition(job.status as JobStatus, 'queued');
    JobStateMachine.transition('queued', 'running');
    await this.jobRepo.updateStatus(jobId, tenantId, 'running');

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

    // Fire webhook: job.cancelled
    if (this.queues.webhook) {
      enqueueWebhookIfConfigured(
        this.queues.webhook,
        (job.config as any)?.webhooks,
        'job.cancelled',
        { jobId, tenantId, status: 'cancelled' },
      );
    }
  }

  async triggerReconciliation(jobId: string, tenantId: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    JobStateMachine.transition(job.status as JobStatus, 'reconciling');
    await this.jobRepo.updateStatus(jobId, tenantId, 'reconciling');

    await this.queues.reconciliation.add(`reconciliation:${jobId}`, {
      jobId,
      tenantId,
    });

    logger.info({ jobId }, 'reconciliation triggered');
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
