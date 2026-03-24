// packages/core/src/crawlers/completion-checker.ts
import { createLogger } from '@spatula/shared';

const logger = createLogger('completion-checker');

export interface TaskStats {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface CompletionResult {
  complete: boolean;
  reason?: 'all_tasks_done' | 'budget_exhausted';
  stats: TaskStats;
}

export interface TaskStatsRepo {
  getJobStats(jobId: string, tenantId: string): Promise<TaskStats>;
}

/**
 * Detects when a crawl job has naturally completed.
 *
 * A job is complete when:
 * - No pending crawl tasks remain
 * - At most 1 in-progress task (the current one calling this check)
 * - All tasks are completed, failed, or skipped
 */
export class CrawlCompletionChecker {
  async isComplete(
    jobId: string,
    tenantId: string,
    taskRepo: TaskStatsRepo,
  ): Promise<CompletionResult> {
    const stats = await taskRepo.getJobStats(jobId, tenantId);

    // No pending tasks, and at most 1 in-progress (the current task)
    const complete = stats.pending === 0 && stats.inProgress <= 1;

    if (complete) {
      logger.info(
        { jobId, ...stats },
        'Crawl naturally complete — all tasks processed',
      );
    }

    return {
      complete,
      reason: complete ? 'all_tasks_done' : undefined,
      stats,
    };
  }
}
