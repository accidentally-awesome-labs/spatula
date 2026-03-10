import { createLogger } from '@spatula/shared';
import { createHash } from 'node:crypto';
import type { JobConfig } from '@spatula/core';
import type { CrawlJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('crawl-worker');

const EXTRACTABLE_CLASSIFICATIONS = new Set(['single_entry', 'multiple_entries', 'partial']);

function isValidCrawlUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function processCrawlJob(data: CrawlJobData, deps: WorkerDeps): Promise<void> {
  const { taskId, jobId, tenantId, url, depth } = data;

  try {
    await deps.taskRepo.updateStatus(taskId, tenantId, 'in_progress');

    const crawlResult = await deps.crawler.crawl(url);
    logger.debug({ taskId, url, statusCode: crawlResult.statusCode }, 'page crawled');

    const contentHash = createHash('sha256').update(crawlResult.html).digest('hex');

    // Dedup check before storing content to avoid orphaned blobs
    const existingPage = await deps.pageRepo.findByContentHash(contentHash, tenantId);
    let page;
    if (existingPage) {
      page = existingPage;
      logger.debug({ taskId, contentHash }, 'duplicate content found, skipping store');
    } else {
      const contentRef = await deps.contentStore.store(`${jobId}/${contentHash}`, crawlResult.html);
      page = await deps.pageRepo.create({
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
      });
    }

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

        // After storing the extraction, check if we should trigger schema evolution
        const evolutionConfig = (job.config as JobConfig).schema.evolutionConfig;
        if (evolutionConfig?.enabled) {
          const batchSize = evolutionConfig.batchSize ?? 10;
          const recentExtractions = await deps.extractionRepo.findByJob(jobId, tenantId, {
            schemaVersion: schema.version,
            limit: batchSize,
          });

          if (recentExtractions.length >= batchSize) {
            const extractionIds = recentExtractions.map((e: { id: string }) => e.id);
            // Use schema version in job name for natural dedup: one evolution per schema version
            await deps.queues.schemaEvolution.add(`schema-evolution:${jobId}:v${schema.version}`, {
              jobId,
              tenantId,
              extractionIds,
            });
            logger.debug(
              { jobId, schemaVersion: schema.version, extractionCount: recentExtractions.length },
              'schema evolution triggered',
            );
          }
        }
      }
    }

    const maxDepth = job.config.crawl.maxDepth;
    if (depth < maxDepth && crawlResult.links.length > 0) {
      let enqueued = 0;
      for (const link of crawlResult.links) {
        if (!link.url || !isValidCrawlUrl(link.url)) continue;

        const childTask = await deps.taskRepo.enqueue({
          jobId,
          tenantId,
          url: link.url,
          depth: depth + 1,
          parentTaskId: taskId,
        });

        await deps.queues.crawl.add(`crawl:${link.url}`, {
          taskId: childTask.id,
          jobId,
          tenantId,
          url: link.url,
          depth: depth + 1,
        });
        enqueued++;
      }
      logger.debug({ taskId, linksEnqueued: enqueued }, 'links enqueued');
    }

    await deps.taskRepo.updateStatus(taskId, tenantId, 'completed');
  } catch (error) {
    logger.error({ taskId, url, error }, 'crawl job failed');
    await deps.taskRepo.updateStatus(taskId, tenantId, 'failed').catch((e) => {
      logger.error({ taskId, error: e }, 'failed to mark task as failed');
    });
  }
}
