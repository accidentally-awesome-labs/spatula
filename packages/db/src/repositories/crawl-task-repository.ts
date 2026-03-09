import { eq, and, asc } from 'drizzle-orm';
import { createLogger, StorageError } from '@spatula/shared';
import type { PageClassification } from '@spatula/core';
import { crawlTasks } from '../schema/crawl-tasks.js';
import type { crawlTaskStatusEnum, taskPriorityEnum, crawlerTypeEnum } from '../schema/enums.js';
import type { Database } from '../connection.js';

const logger = createLogger('crawl-task-repository');

type CrawlTaskStatus = (typeof crawlTaskStatusEnum.enumValues)[number];
type TaskPriority = (typeof taskPriorityEnum.enumValues)[number];
type CrawlerType = (typeof crawlerTypeEnum.enumValues)[number];

export interface EnqueueTaskInput {
  jobId: string;
  tenantId: string;
  url: string;
  depth: number;
  priority?: TaskPriority;
  parentTaskId?: string;
  crawlerType?: CrawlerType;
}

export class CrawlTaskRepository {
  constructor(private readonly db: Database) {}

  async enqueue(input: EnqueueTaskInput) {
    try {
      const [row] = await this.db
        .insert(crawlTasks)
        .values({
          jobId: input.jobId,
          tenantId: input.tenantId,
          url: input.url,
          depth: input.depth,
          priority: input.priority ?? 'medium',
          parentTaskId: input.parentTaskId,
          crawlerType: input.crawlerType,
        })
        .returning();

      logger.debug({ taskId: row.id, url: input.url }, 'crawl task enqueued');
      return row;
    } catch (error) {
      throw new StorageError(`Failed to enqueue task: ${(error as Error).message}`, {
        cause: error as Error,
        context: { url: input.url, jobId: input.jobId },
      });
    }
  }

  async findByJob(jobId: string, options?: { status?: CrawlTaskStatus; limit?: number }) {
    try {
      let query = this.db
        .select()
        .from(crawlTasks)
        .where(
          options?.status
            ? and(eq(crawlTasks.jobId, jobId), eq(crawlTasks.status, options.status))
            : eq(crawlTasks.jobId, jobId),
        )
        .orderBy(asc(crawlTasks.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }

      return await query;
    } catch (error) {
      throw new StorageError(`Failed to find tasks: ${(error as Error).message}`, {
        cause: error as Error,
        context: { jobId },
      });
    }
  }

  async updateStatus(id: string, tenantId: string, status: CrawlTaskStatus) {
    try {
      const timestamps: Record<string, Date> = {};
      if (status === 'completed' || status === 'failed' || status === 'skipped') {
        timestamps.processedAt = new Date();
      }

      const [row] = await this.db
        .update(crawlTasks)
        .set({ status, ...timestamps })
        .where(and(eq(crawlTasks.id, id), eq(crawlTasks.tenantId, tenantId)))
        .returning();

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to update task status: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, status },
      });
    }
  }

  async updateClassification(id: string, tenantId: string, classification: PageClassification) {
    try {
      const [row] = await this.db
        .update(crawlTasks)
        .set({ classification })
        .where(and(eq(crawlTasks.id, id), eq(crawlTasks.tenantId, tenantId)))
        .returning();

      return row ?? null;
    } catch (error) {
      throw new StorageError(`Failed to update classification: ${(error as Error).message}`, {
        cause: error as Error,
        context: { id, classification },
      });
    }
  }
}
