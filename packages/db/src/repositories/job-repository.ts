import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { createLogger, StorageError } from '@accidentally-awesome-labs/spatula-shared';
import type { JobConfig, JobStatus } from '@accidentally-awesome-labs/spatula-core';
import { jobs } from '../schema/jobs.js';
import { crawlTasks } from '../schema/crawl-tasks.js';
import { rawPages } from '../schema/raw-pages.js';
import { extractions } from '../schema/extractions.js';
import { entities, entitySources } from '../schema/entities.js';
import { actions } from '../schema/actions.js';
import { sourceTrust } from '../schema/source-trust.js';
import { schemasTable } from '../schema/schemas.js';
import { exports } from '../schema/exports.js';
import { contentStore } from '../schema/content.js';
import type { Database } from '../connection.js';
import type { RedisCache } from '../cache.js';

const logger = createLogger('job-repository');

export interface CreateJobInput {
  tenantId: string;
  name: string;
  description: string;
  config: JobConfig;
  schemaId?: string;
}

export class JobRepository {
  private cache?: RedisCache;

  constructor(private readonly db: Database) {}

  setCache(cache: RedisCache): void {
    this.cache = cache;
  }

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
    const cacheKey = `job:${id}:config`;
    if (this.cache) {
      return this.cache.getOrFetch(cacheKey, () => this._findByIdFromDb(id, tenantId), 60);
    }
    return this._findByIdFromDb(id, tenantId);
  }

  private async _findByIdFromDb(id: string, tenantId: string) {
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

  async findByTenant(
    tenantId: string,
    options?: { status?: JobStatus; limit?: number; offset?: number },
  ) {
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
      if (options?.offset !== undefined) {
        query = query.offset(options.offset) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to list jobs: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }

  async countByTenant(tenantId: string, options?: { status?: JobStatus }): Promise<number> {
    try {
      const conditions = [eq(jobs.tenantId, tenantId)];
      if (options?.status) {
        conditions.push(eq(jobs.status, options.status));
      }

      const [result] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(and(...conditions));

      return result?.count ?? 0;
    } catch (error) {
      throw new StorageError(`Failed to count jobs: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId },
      });
    }
  }

  async findByTenantCursor(
    tenantId: string,
    options?: {
      status?: JobStatus;
      limit?: number;
      cursor?: { id: string; sortValue?: string | number };
      since?: string;
    },
  ): Promise<{
    jobs: Array<typeof jobs.$inferSelect>;
    nextCursor: { id: string; sortValue: string } | null;
  }> {
    try {
      const limit = Math.max(1, options?.limit ?? 50);
      const conditions = [eq(jobs.tenantId, tenantId)];
      if (options?.status) {
        conditions.push(eq(jobs.status, options.status));
      }

      if (options?.cursor) {
        let cursorSortValue = options.cursor.sortValue;
        if (!cursorSortValue) {
          const [cursorRow] = await this.db
            .select({ createdAt: jobs.createdAt })
            .from(jobs)
            .where(and(eq(jobs.id, options.cursor.id), eq(jobs.tenantId, tenantId)));

          cursorSortValue = cursorRow?.createdAt?.toISOString();
        }

        if (!cursorSortValue) {
          conditions.push(sql`false`);
        } else {
          const cursorCreatedAt = new Date(String(cursorSortValue));
          conditions.push(
            sql`(${jobs.createdAt}, ${jobs.id}) < (${cursorCreatedAt}, ${options.cursor.id}::uuid)`,
          );
        }
      }

      if (options?.since) {
        conditions.push(sql`${jobs.createdAt} > ${new Date(options.since)}`);
      }

      const rows = await this.db
        .select()
        .from(jobs)
        .where(and(...conditions))
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > limit && last
          ? { id: last.id, sortValue: last.createdAt.toISOString() }
          : null;

      return { jobs: page, nextCursor };
    } catch (error) {
      throw new StorageError(`Failed to list jobs by cursor: ${(error as Error).message}`, {
        cause: error as Error,
        context: { tenantId, cursor: options?.cursor?.id },
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

      // Invalidate cached job config
      if (this.cache) {
        await this.cache.delete(`job:${id}:config`);
      }

      return row;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to update job status: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, tenantId, status },
      });
    }
  }

  async deleteWithData(jobId: string, tenantId: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        // Verify job exists and belongs to tenant
        const [job] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.id, jobId), eq(jobs.tenantId, tenantId)));

        if (!job) {
          throw new StorageError(`Job ${jobId} not found`, {
            context: { jobId, tenantId },
          });
        }

        // 1. Break circular FK: NULL out schemaId
        await tx.update(jobs).set({ schemaId: null }).where(eq(jobs.id, jobId));

        // 2. Collect content refs for later cleanup
        const taskSubq = tx
          .select({ id: crawlTasks.id })
          .from(crawlTasks)
          .where(eq(crawlTasks.jobId, jobId));

        const pageRefRows = await tx
          .select({ contentRef: rawPages.contentRef })
          .from(rawPages)
          .where(inArray(rawPages.taskId, taskSubq));

        const taskRefRows = await tx
          .select({ contentRef: crawlTasks.contentRef })
          .from(crawlTasks)
          .where(eq(crawlTasks.jobId, jobId));

        const exportRefRows = await tx
          .select({ contentRef: exports.contentRef })
          .from(exports)
          .where(eq(exports.jobId, jobId));

        // 3. Delete entity_sources (FK to entities + extractions)
        const entitySubq = tx
          .select({ id: entities.id })
          .from(entities)
          .where(eq(entities.jobId, jobId));

        await tx.delete(entitySources).where(inArray(entitySources.entityId, entitySubq));

        // 4. Delete entities
        await tx.delete(entities).where(eq(entities.jobId, jobId));

        // 5. Delete extractions (via raw_pages → crawl_tasks)
        const pageSubq = tx
          .select({ id: rawPages.id })
          .from(rawPages)
          .where(inArray(rawPages.taskId, taskSubq));

        await tx.delete(extractions).where(inArray(extractions.pageId, pageSubq));

        // 6. Delete raw_pages
        await tx.delete(rawPages).where(inArray(rawPages.taskId, taskSubq));

        // 7. Delete crawl_tasks (self-ref parentTaskId safe in single DELETE)
        await tx.delete(crawlTasks).where(eq(crawlTasks.jobId, jobId));

        // 8. Delete actions
        await tx.delete(actions).where(eq(actions.jobId, jobId));

        // 9. Delete source_trust
        await tx.delete(sourceTrust).where(eq(sourceTrust.jobId, jobId));

        // 10. Delete schemas (safe now — schemaId is NULL)
        await tx.delete(schemasTable).where(eq(schemasTable.jobId, jobId));

        // 11. Delete exports
        await tx.delete(exports).where(eq(exports.jobId, jobId));

        // 12. Best-effort content store cleanup
        const allRefs = [
          ...pageRefRows.map((r) => r.contentRef),
          ...taskRefRows.map((r) => r.contentRef),
          ...exportRefRows.map((r) => r.contentRef),
        ].filter((ref): ref is string => ref != null && ref.startsWith('pg://'));

        if (allRefs.length > 0) {
          const contentIds = allRefs.map((ref) => ref.slice(5));
          await tx.delete(contentStore).where(inArray(contentStore.id, contentIds));
        }

        // 13. Delete the job itself
        await tx.delete(jobs).where(eq(jobs.id, jobId));

        logger.info({ jobId, tenantId }, 'job and all related data deleted');
      });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(`Failed to delete job ${jobId}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId, tenantId },
      });
    }
  }

  /**
   * Cross-tenant job listing for admin endpoints.
   * Supports optional filters by status and tenantId.
   */
  async findAll(options?: {
    status?: JobStatus;
    tenantId?: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      const conditions = [];
      if (options?.status) conditions.push(eq(jobs.status, options.status));
      if (options?.tenantId) conditions.push(eq(jobs.tenantId, options.tenantId));

      let query = this.db.select().from(jobs).orderBy(desc(jobs.createdAt));

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as typeof query;
      }

      return await query.limit(options?.limit ?? 50).offset(options?.offset ?? 0);
    } catch (error) {
      throw new StorageError(`Failed to list all jobs: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  /**
   * Count all jobs across tenants with optional filters. For admin endpoints.
   */
  async countAll(options?: { status?: JobStatus; tenantId?: string }): Promise<number> {
    try {
      const conditions = [];
      if (options?.status) conditions.push(eq(jobs.status, options.status));
      if (options?.tenantId) conditions.push(eq(jobs.tenantId, options.tenantId));

      const query = this.db.select({ count: sql<number>`count(*)::int` }).from(jobs);

      const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;

      return (rows[0] as any)?.count ?? 0;
    } catch (error) {
      throw new StorageError(`Failed to count all jobs: ${(error as Error).message}`, {
        cause: error as Error,
      });
    }
  }

  /**
   * Force-cancel a job without tenant scoping. For admin use only.
   * Sets status to 'cancelled' and completedAt to now.
   */
  async forceCancel(jobId: string): Promise<typeof jobs.$inferSelect | null> {
    try {
      const [row] = await this.db
        .update(jobs)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(eq(jobs.id, jobId))
        .returning();

      if (row && this.cache) {
        await this.cache.delete(`job:${jobId}:config`);
      }

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to force-cancel job ${jobId}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
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

      // Invalidate cached job config
      if (this.cache) {
        await this.cache.delete(`job:${id}:config`);
      }

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to update job stats: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, tenantId },
      });
    }
  }
}
