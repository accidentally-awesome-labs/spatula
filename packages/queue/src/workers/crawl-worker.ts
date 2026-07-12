// packages/queue/src/workers/crawl-worker.ts
import { createLoggerWithContext, type Logger } from '@spatula/shared';
import { processCrawlTask, shouldTriggerSchemaEvolution } from '@spatula/core';
import type { LLMClient } from '@spatula/core';
import type { CrawlJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';
import { resolveJobDeps } from '../derive-job-deps.js';

export async function processCrawlJob(data: CrawlJobData, deps: WorkerDeps): Promise<void> {
  const { taskId, jobId, tenantId, url, depth } = data;
  const logger = createLoggerWithContext('crawl-worker', { jobId, tenantId });

  // Derive per-job deps from the job's LLMConfig over the shared llmClient.
  // When no llmClient is threaded (test-injection path), resolveJobDeps returns
  // base deps unchanged so all existing unit tests continue to pass.
  const sharedClient = (deps as any).llmClient as LLMClient | undefined;
  const jobDeps = await resolveJobDeps(deps, sharedClient, jobId, tenantId);

  try {
    // Pre-crawl checks (tenant quota → budget → robots → rate limit)
    // These checks do NOT use LLM components, so we keep them on base `deps`.

    // 1. Check tenant maxPagesPerJob quota
    if (deps.tenantRepo) {
      try {
        const quotas = await deps.tenantRepo.getQuotas(tenantId);
        const maxPages = (quotas as any).maxPagesPerJob;
        if (maxPages !== undefined) {
          // Count completed tasks for this job
          const tasks = await deps.taskRepo.findByJob(jobId, { status: 'completed' });
          if (tasks.length >= maxPages) {
            logger.info(
              { taskId, url, pageCount: tasks.length, maxPages },
              'Tenant page quota exceeded, skipping',
            );
            await deps.taskRepo.updateStatus(taskId, tenantId, 'skipped');
            await finalizeCrawlIfComplete(jobId, tenantId, jobDeps, logger);
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
        await finalizeCrawlIfComplete(jobId, tenantId, jobDeps, logger);
        return;
      }
    }

    // 3. Check robots.txt
    if (deps.robotsChecker) {
      const robotsAllowed = await deps.robotsChecker.isAllowed(url);
      if (!robotsAllowed) {
        logger.info({ taskId, url }, 'Blocked by robots.txt, skipping');
        await deps.taskRepo.updateStatus(taskId, tenantId, 'skipped');
        await finalizeCrawlIfComplete(jobId, tenantId, jobDeps, logger);
        return;
      }
    }

    // 4. Wait for domain rate limit slot
    if (deps.rateLimiter) {
      const crawlDelay = deps.robotsChecker?.getCrawlDelay(url) ?? undefined;
      await deps.rateLimiter.waitForSlot(url, crawlDelay);
    }

    // 5. Delegate to pure orchestrator using per-job deps (honors job's LLM model tier)
    const result = await processCrawlTask(
      { taskId, jobId, tenantId, url, depth },
      {
        crawler: jobDeps.crawler,
        classifier: jobDeps.classifier,
        extractor: jobDeps.extractor,
        contentStore: jobDeps.contentStore,
        linkEvaluator: jobDeps.linkEvaluator,
        taskRepo: jobDeps.taskRepo,
        pageRepo: jobDeps.pageRepo,
        jobRepo: jobDeps.jobRepo,
        extractionRepo: jobDeps.extractionRepo,
        schemaRepo: jobDeps.schemaRepo,
        eventPublisher: jobDeps.eventPublisher,
      },
    );

    // Orchestrator returns error field on failure instead of throwing
    if (result.error) {
      logger.error({ taskId, url, error: result.error }, 'crawl job failed');
      await finalizeCrawlIfComplete(jobId, tenantId, jobDeps, logger);
      return;
    }

    // 2. Check if schema evolution should be triggered (queue-specific)
    if (result.extracted) {
      const evolution = await shouldTriggerSchemaEvolution(
        jobId,
        tenantId,
        { schemaVersion: result.schemaVersion, evolutionConfig: result.evolutionConfig },
        { extractionRepo: jobDeps.extractionRepo },
      );

      if (evolution.trigger) {
        await jobDeps.queues.schemaEvolution.add(
          `schema-evolution:${jobId}:v${evolution.schemaVersion}`,
          { jobId, tenantId, extractionIds: evolution.extractionIds },
        );
        logger.debug(
          {
            jobId,
            schemaVersion: evolution.schemaVersion,
            extractionCount: evolution.extractionIds.length,
          },
          'schema evolution triggered',
        );
      }
    }

    // 3. Enqueue child crawl tasks (queue-specific)
    const linksToEnqueue = await capLinksByJobPageBudget(
      result.linksFound,
      jobId,
      tenantId,
      jobDeps,
    );
    let enqueued = 0;
    for (const link of linksToEnqueue) {
      const childTask = await jobDeps.taskRepo.enqueue({
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
        await jobDeps.queues.crawl.add(`crawl:${link.url}`, jobData, { priority: bullmqPriority });
      } else {
        await jobDeps.queues.crawl.add(`crawl:${link.url}`, jobData);
      }
      enqueued++;
    }

    if (enqueued > 0) {
      logger.debug({ taskId, linksEnqueued: enqueued }, 'links enqueued');
      await jobDeps.eventPublisher?.publish(jobId, {
        type: 'crawl_progress',
        jobId,
        tenantId,
        data: { pagesFound: enqueued, taskId, url },
      });
    }

    // 5. Check crawl completion
    await finalizeCrawlIfComplete(jobId, tenantId, jobDeps, logger);
  } catch (error) {
    // Safety net for unexpected errors in the worker's own logic (queue operations, etc.).
    // Orchestrator-level errors are returned via result.error and handled above.
    logger.error({ taskId, url, error }, 'crawl job failed');
  }
}

async function finalizeCrawlIfComplete(
  jobId: string,
  tenantId: string,
  deps: WorkerDeps,
  logger: Logger,
): Promise<void> {
  if (!deps.completionChecker) return;

  const completion = await deps.completionChecker.isComplete(jobId, tenantId, deps.taskRepo);
  if (!completion.complete) return;

  const { stats } = completion;
  if (stats.completed === 0 && stats.failed > 0) {
    logger.info({ jobId, ...stats }, 'Crawl complete with no successful pages, marking job failed');
    await deps.jobRepo.updateStatus(jobId, tenantId, 'failed');
    await deps.eventPublisher?.publish(jobId, {
      type: 'job_status_changed',
      jobId,
      tenantId,
      data: { from: 'running', to: 'failed' },
    });
    return;
  }

  logger.info({ jobId, ...stats }, 'Crawl naturally complete, triggering reconciliation');
  await deps.queues.reconciliation.add(`reconciliation:${jobId}`, { jobId, tenantId });
}

async function capLinksByJobPageBudget<T extends { url: string }>(
  links: T[],
  jobId: string,
  tenantId: string,
  deps: WorkerDeps,
): Promise<T[]> {
  const job = await deps.jobRepo.findById(jobId, tenantId);
  const maxPages = (job?.config as any)?.crawl?.maxPages;
  if (typeof maxPages !== 'number' || !Number.isFinite(maxPages)) {
    return links;
  }

  const stats = await deps.taskRepo.getJobStats(jobId, tenantId);
  const accountedPages = stats.completed + stats.inProgress + stats.pending;
  const remaining = Math.max(0, Math.floor(maxPages) - accountedPages);
  return links.slice(0, remaining);
}
