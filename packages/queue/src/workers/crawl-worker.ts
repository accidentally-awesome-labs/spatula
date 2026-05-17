// packages/queue/src/workers/crawl-worker.ts
import { createLoggerWithContext } from '@spatula/shared';
import { processCrawlTask, shouldTriggerSchemaEvolution } from '@spatula/core';
import type { CrawlJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

export async function processCrawlJob(data: CrawlJobData, deps: WorkerDeps): Promise<void> {
  const { taskId, jobId, tenantId, url, depth } = data;
  const logger = createLoggerWithContext('crawl-worker', { jobId, tenantId });

  try {
    // Pre-crawl checks (tenant quota → budget → robots → rate limit)

    // 1. Check tenant maxPagesPerJob quota
    if (deps.tenantRepo) {
      try {
        const quotas = await deps.tenantRepo.getQuotas(tenantId);
        const maxPages = (quotas as any).maxPagesPerJob;
        if (maxPages !== undefined) {
          // Count completed tasks for this job
          const tasks = await deps.taskRepo.findByJob(jobId, { status: 'completed' });
          if (tasks.length >= maxPages) {
            logger.info({ taskId, url, pageCount: tasks.length, maxPages }, 'Tenant page quota exceeded, skipping');
            await deps.taskRepo.updateStatus(taskId, tenantId, 'skipped');
            return;
          }
        }
      } catch (error) {
        // Fail-open: if quota check fails, allow the crawl to proceed
        logger.warn({ err: error, tenantId }, 'Failed to check tenant page quota');
      }
    }

    // 2. Check page budget (job-level)
    if (deps.pageBudget) {
      const allowed = await Promise.resolve(deps.pageBudget.tryIncrement());
      if (!allowed) {
        logger.info({ taskId, url }, 'Page budget exhausted, skipping');
        await deps.taskRepo.updateStatus(taskId, tenantId, 'skipped');
        return;
      }
    }

    // 3. Check robots.txt
    if (deps.robotsChecker) {
      const robotsAllowed = await deps.robotsChecker.isAllowed(url);
      if (!robotsAllowed) {
        logger.info({ taskId, url }, 'Blocked by robots.txt, skipping');
        await deps.taskRepo.updateStatus(taskId, tenantId, 'skipped');
        return;
      }
    }

    // 4. Wait for domain rate limit slot
    if (deps.rateLimiter) {
      const crawlDelay = deps.robotsChecker?.getCrawlDelay(url) ?? undefined;
      await deps.rateLimiter.waitForSlot(url, crawlDelay);
    }

    // 5. Delegate to pure orchestrator
    const result = await processCrawlTask(
      { taskId, jobId, tenantId, url, depth },
      {
        crawler: deps.crawler,
        classifier: deps.classifier,
        extractor: deps.extractor,
        contentStore: deps.contentStore,
        linkEvaluator: deps.linkEvaluator,
        taskRepo: deps.taskRepo,
        pageRepo: deps.pageRepo,
        jobRepo: deps.jobRepo,
        extractionRepo: deps.extractionRepo,
        schemaRepo: deps.schemaRepo,
        eventPublisher: deps.eventPublisher,
      },
    );

    // Orchestrator returns error field on failure instead of throwing
    if (result.error) {
      logger.error({ taskId, url, error: result.error }, 'crawl job failed');
      return;
    }

    // 2. Check if schema evolution should be triggered (queue-specific)
    if (result.extracted) {
      const evolution = await shouldTriggerSchemaEvolution(
        jobId,
        tenantId,
        { schemaVersion: result.schemaVersion, evolutionConfig: result.evolutionConfig },
        { extractionRepo: deps.extractionRepo },
      );

      if (evolution.trigger) {
        await deps.queues.schemaEvolution.add(
          `schema-evolution:${jobId}:v${evolution.schemaVersion}`,
          { jobId, tenantId, extractionIds: evolution.extractionIds },
        );
        logger.debug(
          { jobId, schemaVersion: evolution.schemaVersion, extractionCount: evolution.extractionIds.length },
          'schema evolution triggered',
        );
      }
    }

    // 3. Enqueue child crawl tasks (queue-specific)
    let enqueued = 0;
    for (const link of result.linksFound) {
      const childTask = await deps.taskRepo.enqueue({
        jobId,
        tenantId,
        url: link.url,
        depth: depth + 1,
        parentTaskId: taskId,
      });

      const bullmqPriority = link.priority
        ? ({ high: 1, medium: 5, low: 10 } as Record<string, number>)[link.priority]
        : undefined;

      const jobData: CrawlJobData = {
        taskId: childTask.id,
        jobId,
        tenantId,
        url: link.url,
        depth: depth + 1,
      };

      if (bullmqPriority !== undefined) {
        await deps.queues.crawl.add(`crawl:${link.url}`, jobData, { priority: bullmqPriority });
      } else {
        await deps.queues.crawl.add(`crawl:${link.url}`, jobData);
      }
      enqueued++;
    }

    if (enqueued > 0) {
      logger.debug({ taskId, linksEnqueued: enqueued }, 'links enqueued');
      await deps.eventPublisher?.publish(jobId, {
        type: 'crawl_progress',
        jobId,
        tenantId,
        data: { pagesFound: enqueued, taskId, url },
      });
    }

    // 5. Check crawl completion
    if (deps.completionChecker && !result.error) {
      const completion = await deps.completionChecker.isComplete(
        jobId, tenantId, deps.taskRepo,
      );
      if (completion.complete) {
        logger.info({ jobId, ...completion.stats }, 'Crawl naturally complete, triggering reconciliation');
        await deps.queues.reconciliation.add(
          `reconciliation:${jobId}`,
          { jobId, tenantId },
        );
      }
    }
  } catch (error) {
    // Safety net for unexpected errors in the worker's own logic (queue operations, etc.).
    // Orchestrator-level errors are returned via result.error and handled above.
    logger.error({ taskId, url, error }, 'crawl job failed');
  }
}
