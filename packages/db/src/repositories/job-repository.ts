import { eq, and, desc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import type { JobConfig, JobStatus } from '@spatula/core';
import { jobs } from '../schema/jobs.js';
import type { Database } from '../connection.js';

const logger = createLogger('job-repository');

export interface CreateJobInput {
  tenantId: string;
  name: string;
  description: string;
  config: JobConfig;
  schemaId?: string;
}

export class JobRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateJobInput) {
    try {
      const [row] = await this.db
        .insert(jobs)
        .values({
          tenantId: input.tenantId,
          name: input.name,
          description: input.description,
          config: input.config,
          schemaId: input.schemaId,
        })
        .returning();

      logger.debug({ jobId: row.id }, 'job created');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to create job: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId: input.tenantId },
      });
    }
  }

  async findById(id: string, tenantId: string) {
    try {
      const [row] = await this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.tenantId, tenantId)));

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to find job ${id}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, tenantId },
      });
    }
  }

  async findByTenant(tenantId: string, options?: { status?: JobStatus; limit?: number }) {
    try {
      let query = this.db
        .select()
        .from(jobs)
        .where(
          options?.status
            ? and(eq(jobs.tenantId, tenantId), eq(jobs.status, options.status))
            : eq(jobs.tenantId, tenantId),
        )
        .orderBy(desc(jobs.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to list jobs: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }

  async updateStatus(id: string, tenantId: string, status: JobStatus) {
    try {
      const timestamps: Record<string, Date> = {};
      if (status === 'running') timestamps.startedAt = new Date();
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        timestamps.completedAt = new Date();
      }

      const [row] = await this.db
        .update(jobs)
        .set({ status, ...timestamps })
        .where(and(eq(jobs.id, id), eq(jobs.tenantId, tenantId)))
        .returning();

      if (!row) {
        throw new StorageError(`Job ${id} not found`, { context: { id, tenantId } });
      }

      logger.debug({ jobId: id, status }, 'job status updated');
      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update job status: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, tenantId, status },
      });
    }
  }

  async updateStats(id: string, tenantId: string, stats: Record<string, number>) {
    try {
      const [row] = await this.db
        .update(jobs)
        .set({ stats })
        .where(and(eq(jobs.id, id), eq(jobs.tenantId, tenantId)))
        .returning();

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to update job stats: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, tenantId },
      });
    }
  }
}
