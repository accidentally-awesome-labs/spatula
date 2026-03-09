import { createLogger } from '@spatula/shared';
import { createHash } from 'node:crypto';
import type { CrawlJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('crawl-worker');

const EXTRACTABLE_CLASSIFICATIONS = new Set(['single_entry', 'multiple_entries', 'partial']);

export async function processCrawlJob(data: CrawlJobData, deps: WorkerDeps): Promise<void> {
  const { taskId, jobId, tenantId, url, depth } = data;

  try {
    await deps.taskRepo.updateStatus(taskId, tenantId, 'in_progress');

    const crawlResult = await deps.crawler.crawl(url);
    logger.debug({ taskId, url, statusCode: crawlResult.statusCode }, 'page crawled');

    const contentHash = createHash('sha256').update(crawlResult.html).digest('hex');
    const contentRef = await deps.contentStore.store(`${jobId}/${contentHash}`, crawlResult.html);

    const existingPage = await deps.pageRepo.findByContentHash(contentHash, tenantId);
    const page =
      existingPage ??
      (await deps.pageRepo.create({
        taskId,
        tenantId,
        contentRef,
        contentHash,
        metadata: {
          url,
          title: crawlResult.title,
          statusCode: crawlResult.statusCode,
          responseTimeMs: crawlResult.metadata.responseTimeMs,
        },
      }));

    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      logger.warn({ jobId, tenantId }, 'job not found, skipping');
      await deps.taskRepo.updateStatus(taskId, tenantId, 'skipped');
      return;
    }

    const classification = await deps.classifier.classify(
      crawlResult.html,
      url,
      job.config.description,
    );
    await deps.taskRepo.updateClassification(taskId, tenantId, classification.classification);

    if (EXTRACTABLE_CLASSIFICATIONS.has(classification.classification)) {
      const schema = await deps.schemaRepo.findLatest(jobId, tenantId);
      if (schema) {
        const extraction = await deps.extractor.extract(
          crawlResult.html,
          url,
          schema.definition,
          job.config.description,
        );
        await deps.extractionRepo.store({
          jobId,
          tenantId,
          pageId: page.id,
          schemaVersion: schema.version,
          data: extraction.data,
          unmappedFields: extraction.metadata.unmappedFields,
          metadata: extraction.metadata,
        });
        logger.debug({ taskId, pageId: page.id }, 'extraction stored');
      }
    }

    const maxDepth = job.config.crawl.maxDepth;
    if (depth < maxDepth && crawlResult.links.length > 0) {
      for (const link of crawlResult.links) {
        if (link.url && link.url.startsWith('http')) {
          await deps.queues.crawl.add(`crawl:${link.url}`, {
            taskId: '',
            jobId,
            tenantId,
            url: link.url,
            depth: depth + 1,
          });
        }
      }
      logger.debug({ taskId, linksEnqueued: crawlResult.links.length }, 'links enqueued');
    }

    await deps.taskRepo.updateStatus(taskId, tenantId, 'completed');
  } catch (error) {
    logger.error({ taskId, url, error }, 'crawl job failed');
    await deps.taskRepo.updateStatus(taskId, tenantId, 'failed').catch((e) => {
      logger.error({ taskId, error: e }, 'failed to mark task as failed');
    });
  }
}
