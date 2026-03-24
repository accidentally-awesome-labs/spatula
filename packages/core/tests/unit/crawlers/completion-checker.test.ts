// packages/core/tests/unit/crawlers/completion-checker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CrawlCompletionChecker } from '../../../src/crawlers/completion-checker.js';

function createMockTaskRepo(stats: { pending: number; inProgress: number; completed: number; failed: number; skipped: number }) {
  return {
    getJobStats: vi.fn().mockResolvedValue(stats),
  };
}

describe('CrawlCompletionChecker', () => {
  it('returns complete when no pending or in-progress tasks', async () => {
    const repo = createMockTaskRepo({ pending: 0, inProgress: 0, completed: 50, failed: 2, skipped: 3 });
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('all_tasks_done');
  });

  it('returns incomplete when tasks are pending', async () => {
    const repo = createMockTaskRepo({ pending: 5, inProgress: 2, completed: 50, failed: 0, skipped: 0 });
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.complete).toBe(false);
  });

  it('returns incomplete when tasks are in progress', async () => {
    const repo = createMockTaskRepo({ pending: 0, inProgress: 3, completed: 50, failed: 0, skipped: 0 });
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.complete).toBe(false);
  });

  it('accounts for the current task (inProgress <= 1 with pending 0)', async () => {
    // The current task is still "in_progress" when this check runs
    const repo = createMockTaskRepo({ pending: 0, inProgress: 1, completed: 49, failed: 0, skipped: 0 });
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('all_tasks_done');
  });

  it('returns stats in the result', async () => {
    const stats = { pending: 0, inProgress: 0, completed: 100, failed: 5, skipped: 10 };
    const repo = createMockTaskRepo(stats);
    const checker = new CrawlCompletionChecker();
    const result = await checker.isComplete('job-1', 'tenant-1', repo);
    expect(result.stats).toEqual(stats);
  });
});
