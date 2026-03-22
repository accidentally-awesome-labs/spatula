// packages/queue/src/workers/crawl-worker.ts
import { createLoggerWithContext } from '@spatula/shared';
import { processCrawlTask, shouldTriggerSchemaEvolution } from '@spatula/core';
import type { CrawlJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

export async function processCrawlJob(data: CrawlJobData, deps: WorkerDeps): Promise<void> {
  const { taskId, jobId, tenantId, url, depth } = data;
  const logger = createLoggerWithContext('crawl-worker', { jobId, tenantId });

  try {
    // 1. Delegate to pure orchestrator
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
  } catch (error) {
    // Orchestrator already marked task as failed and logged the error.
    // Worker wrapper just ensures the error doesn't crash the BullMQ worker.
    logger.error({ taskId, url, error }, 'crawl job failed');
  }
}
