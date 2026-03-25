/**
 * SQLite crawl-task repository — local project mode.
 *
 * Implements BOTH CrawlTaskRepo from @spatula/core/pipeline/types.ts
 * AND TaskStatsRepo from @spatula/core/crawlers/completion-checker.ts.
 *
 * Per spec 5.7: constructor takes (db, projectId). The jobId/tenantId
 * parameters on interface methods are accepted but ignored — the
 * pre-bound projectId is always used.
 */
import { eq, and, desc, sql } from 'drizzle-orm';
import { createLogger } from '@spatula/shared';
import type { CrawlTaskRepo } from '@spatula/core/pipeline/types.js';
import type { TaskStatsRepo, TaskStats } from '@spatula/core/crawlers/completion-checker.js';
import type { ProjectDatabase } from '../connection.js';
import { crawlTasks } from '../../schema-sqlite/crawl-tasks.js';
import { wrapStorageError } from './utils.js';

const logger = createLogger('sqlite:crawl-task-repo');

export class SqliteCrawlTaskRepository implements CrawlTaskRepo, TaskStatsRepo {
  constructor(
    private readonly db: ProjectDatabase,
    private readonly projectId: string,
  ) {}

  async enqueue(data: {
    jobId: string;
    tenantId: string;
    url: string;
    depth: number;
    parentTaskId: string;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    wrapStorageError(() => {
      this.db
        .insert(crawlTasks)
        .values({
          id,
          jobId: this.projectId,
          url: data.url,
          depth: data.depth,
          status: 'pending',
          priority: 'medium',
          parentTaskId: data.parentTaskId || null,
          createdAt: new Date().toISOString(),
        })
        .run();
    }, { method: 'enqueue', table: 'crawl_tasks' });
    logger.debug({ id, url: data.url, depth: data.depth }, 'crawl task enqueued');
    return { id };
  }

  async updateStatus(
    taskId: string,
    _tenantId: string,
    status: string,
  ): Promise<unknown> {
    const timestamps: Record<string, string> = {};
    if (status === 'completed' || status === 'failed' || status === 'skipped') {
      const now = new Date().toISOString();
      timestamps.processedAt = now;
      timestamps.completedAt = now;
    }

    wrapStorageError(() => {
      this.db
        .update(crawlTasks)
        .set({ status, ...timestamps })
        .where(eq(crawlTasks.id, taskId))
        .run();
    }, { method: 'updateStatus', table: 'crawl_tasks', taskId });
    logger.debug({ taskId, status }, 'crawl task status updated');

    return {};
  }

  async updateClassification(
    taskId: string,
    _tenantId: string,
    classification: string,
  ): Promise<unknown> {
    this.db
      .update(crawlTasks)
      .set({ classification })
      .where(eq(crawlTasks.id, taskId))
      .run();

    return {};
  }

  async getJobStats(_jobId: string, _tenantId: string): Promise<TaskStats> {
    const rows = this.db
      .select({
        status: crawlTasks.status,
        count: sql<number>`count(*)`,
      })
      .from(crawlTasks)
      .where(eq(crawlTasks.jobId, this.projectId))
      .groupBy(crawlTasks.status)
      .all();

    const stats: TaskStats = { pending: 0, inProgress: 0, completed: 0, failed: 0, skipped: 0 };
    for (const row of rows) {
      // Map DB 'in_progress' to interface 'inProgress'
      const key = row.status === 'in_progress' ? 'inProgress' : row.status;
      if (key in stats) {
        stats[key as keyof TaskStats] = Number(row.count);
      }
    }
    return stats;
  }

  /**
   * Find pending tasks ordered by priority score descending.
   * Not part of the pipeline interface — used by local pipeline's priority queue.
   */
  async findPending(
    _jobId: string,
    options?: { limit?: number },
  ): Promise<Array<{
    id: string;
    url: string;
    depth: number;
    priorityScore: number | null;
    parentTaskId: string | null;
    createdAt: string;
  }>> {
    let query = this.db
      .select({
        id: crawlTasks.id,
        url: crawlTasks.url,
        depth: crawlTasks.depth,
        priorityScore: crawlTasks.priorityScore,
        parentTaskId: crawlTasks.parentTaskId,
        createdAt: crawlTasks.createdAt,
      })
      .from(crawlTasks)
      .where(
        and(
          eq(crawlTasks.jobId, this.projectId),
          eq(crawlTasks.status, 'pending'),
        ),
      )
      .orderBy(desc(crawlTasks.priorityScore));

    if (options?.limit) {
      query = query.limit(options.limit) as typeof query;
    }

    return query.all();
  }
}
