// packages/core/src/pipeline/crawl-orchestrator.ts
import {
  createLoggerWithContext,
  CrawlError,
  NetworkError,
} from '@accidentally-awesome-labs/spatula-shared';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { JobConfig, LinkEvaluationContext } from '../index.js';
import type {
  CrawlOrchestratorDeps,
  CrawlTaskInput,
  CrawlTaskResult,
  LinkToEnqueue,
} from './types.js';
import { isMeaningfulRecord } from './record-utils.js';

const EXTRACTABLE_CLASSIFICATIONS = new Set(['single_entry', 'multiple_entries', 'partial']);

function isRetryableHttpStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function ipv4ToParts(hostname: string): number[] | null {
  if (isIP(hostname) !== 4) return null;
  const parts = hostname.split('.').map((part) => Number(part));
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isBlockedPrivateHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;

  const ipv4 = ipv4ToParts(normalized);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('::ffff:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab][0-9a-f]?:/i.test(normalized)
    );
  }

  return false;
}

export function isValidCrawlUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (isBlockedPrivateHostname(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure crawl task processing logic. No BullMQ/Redis/queue references.
 *
 * Handles: URL crawling, content dedup, page classification, extraction,
 * link evaluation, and schema evolution trigger check.
 *
 * Returns the task result (links to enqueue, classification, etc.)
 * but does NOT enqueue child tasks — that's the caller's responsibility.
 * This separation allows server mode to use BullMQ queues and local mode
 * to use an in-process priority queue.
 */
export async function processCrawlTask(
  input: CrawlTaskInput,
  deps: CrawlOrchestratorDeps,
): Promise<CrawlTaskResult> {
  const { taskId, jobId, tenantId, url, depth } = input;
  const logger = createLoggerWithContext('crawl-orchestrator', { jobId, tenantId });

  await deps.taskRepo.updateStatus(taskId, tenantId, 'in_progress');

  try {
    // 1. Crawl the URL
    const crawlResult = await deps.crawler.crawl(url);
    logger.debug({ taskId, url, statusCode: crawlResult.statusCode }, 'page crawled');

    // 2. Content dedup via SHA-256 hash
    const contentHash = createHash('sha256').update(crawlResult.html).digest('hex');
    const existingPage = await deps.pageRepo.findByContentHash(contentHash, tenantId);

    let page: { id: string };
    let deduplicated = false;

    if (existingPage) {
      page = existingPage;
      deduplicated = true;
      logger.debug({ taskId, contentHash }, 'duplicate content found, skipping store');
    } else {
      const contentRef = await deps.contentStore.store(`${jobId}/${contentHash}`, crawlResult.html);
      page = await deps.pageRepo.create({
        taskId,
        tenantId,
        contentRef,
        contentHash,
        url,
        statusCode: crawlResult.statusCode,
        title: crawlResult.title,
        metadata: {
          url,
          title: crawlResult.title,
          statusCode: crawlResult.statusCode,
          responseTimeMs: crawlResult.metadata.responseTimeMs,
        },
      });
    }

    // HTTP error pages are useful diagnostic artifacts, so archive them above,
    // but never spend LLM calls classifying/extracting them or follow their links.
    if (crawlResult.statusCode >= 400) {
      const error = new CrawlError(`HTTP ${crawlResult.statusCode} while crawling ${url}`, {
        context: { taskId, url, statusCode: crawlResult.statusCode },
        retryable: isRetryableHttpStatus(crawlResult.statusCode),
      });
      logger.warn(
        { taskId, url, statusCode: crawlResult.statusCode, retryable: error.retryable },
        'HTTP error response archived; task failed before LLM processing',
      );
      await deps.taskRepo.updateStatus(taskId, tenantId, 'failed');
      return {
        pageId: page.id,
        classification: 'unknown',
        extracted: false,
        linksFound: [],
        contentHash,
        deduplicated,
        schemaVersion: null,
        evolutionConfig: null,
        error,
      };
    }

    // 3. Load job config
    const job = await deps.jobRepo.findById(jobId, tenantId);
    if (!job) {
      logger.warn({ jobId, tenantId }, 'job not found, skipping');
      await deps.taskRepo.updateStatus(taskId, tenantId, 'skipped');
      return {
        pageId: page.id,
        classification: 'unknown',
        extracted: false,
        linksFound: [],
        contentHash,
        deduplicated,
        schemaVersion: null,
        evolutionConfig: null,
      };
    }

    const config = job.config as JobConfig;

    // 4. Classify the page
    const classification = await deps.classifier.classify(
      crawlResult.html,
      url,
      config.description,
    );
    await deps.taskRepo.updateClassification(taskId, tenantId, classification.classification);

    // 5. Publish task_completed event
    await deps.eventPublisher?.publish(jobId, {
      type: 'task_completed',
      jobId,
      tenantId,
      data: { taskId, url, classification: classification.classification },
    });

    // Cache schema lookup (used in extraction, link evaluation, and return value)
    const schema = await deps.schemaRepo.findLatest(jobId, tenantId);

    // 6. Extract if page is extractable
    let extracted = false;
    if (EXTRACTABLE_CLASSIFICATIONS.has(classification.classification)) {
      if (schema) {
        const extractionResults =
          classification.classification === 'multiple_entries' && deps.extractor.extractMany
            ? await deps.extractor.extractMany(
                crawlResult.html,
                url,
                schema.definition,
                config.description,
              )
            : [
                await deps.extractor.extract(
                  crawlResult.html,
                  url,
                  schema.definition,
                  config.description,
                ),
              ];

        let storedCount = 0;
        for (const extraction of extractionResults) {
          if (!isMeaningfulRecord(extraction.data)) {
            logger.debug({ taskId, pageId: page.id }, 'empty extraction skipped');
            continue;
          }

          await deps.extractionRepo.store({
            jobId,
            tenantId,
            pageId: page.id,
            schemaVersion: schema.version,
            data: extraction.data,
            unmappedFields: extraction.metadata.unmappedFields,
            metadata: extraction.metadata,
          });
          storedCount++;
        }
        extracted = storedCount > 0;
        logger.debug({ taskId, pageId: page.id, storedCount }, 'extraction pass complete');
      }
    }

    // 7. Evaluate links (if within depth and evaluator available)
    const maxDepth = config.crawl.maxDepth;
    let linksFound: LinkToEnqueue[] = [];

    if (depth < maxDepth && crawlResult.links.length > 0) {
      if (deps.linkEvaluator) {
        if (schema) {
          const context: LinkEvaluationContext = {
            description: config.description,
            seedDomains: config.seedUrls.map((u: string) => new URL(u).hostname),
            currentDepth: depth,
            maxDepth,
          };
          const evaluated = await deps.linkEvaluator.evaluate(
            crawlResult.links,
            context,
            schema.definition,
          );
          linksFound = evaluated
            .filter((l) => l.relevanceScore > 0.3)
            .filter((l) => l.url && isValidCrawlUrl(l.url));
          logger.debug(
            { taskId, total: crawlResult.links.length, accepted: linksFound.length },
            'links evaluated',
          );
        }
      } else {
        // No evaluator — use all valid links
        linksFound = crawlResult.links.filter((l) => l.url && isValidCrawlUrl(l.url));
      }
    }

    // 8. Mark task completed
    await deps.taskRepo.updateStatus(taskId, tenantId, 'completed');

    const evolutionCfg = config.schema.evolutionConfig;

    return {
      pageId: page.id,
      classification: classification.classification,
      extracted,
      linksFound,
      contentHash,
      deduplicated,
      schemaVersion: schema?.version ?? null,
      evolutionConfig: evolutionCfg?.enabled
        ? { enabled: true, batchSize: evolutionCfg.batchSize ?? 10 }
        : null,
    };
  } catch (error) {
    const wrappedError =
      error instanceof CrawlError || error instanceof NetworkError
        ? error
        : new CrawlError('Crawl task failed', {
            cause: error as Error,
            context: { taskId, url },
            retryable: true,
          });
    logger.error({ taskId, url, error: wrappedError }, 'crawl task failed');
    await deps.taskRepo.updateStatus(taskId, tenantId, 'failed').catch((e) => {
      logger.error({ taskId, error: e }, 'failed to mark task as failed');
    });
    // Return a failure result instead of throwing — let the caller decide whether to rethrow
    return {
      pageId: '',
      classification: 'unknown',
      extracted: false,
      linksFound: [],
      contentHash: '',
      deduplicated: false,
      schemaVersion: null,
      evolutionConfig: null,
      error: wrappedError,
    };
  }
}

/**
 * Check if schema evolution should be triggered based on extraction count.
 * Returns true if the caller should enqueue a schema evolution job.
 *
 * Accepts cached values from CrawlTaskResult to avoid redundant DB calls
 * (the orchestrator already loaded job config and schema during processing).
 *
 * Separated from processCrawlTask because the trigger mechanism differs:
 * server mode enqueues a BullMQ job, local mode calls processSchemaEvolution directly.
 */
export async function shouldTriggerSchemaEvolution(
  jobId: string,
  tenantId: string,
  cached: {
    schemaVersion: number | null;
    evolutionConfig: { enabled: boolean; batchSize: number } | null;
  },
  deps: {
    extractionRepo: CrawlOrchestratorDeps['extractionRepo'];
  },
): Promise<{ trigger: boolean; extractionIds: string[]; schemaVersion: number }> {
  if (!cached.evolutionConfig?.enabled || cached.schemaVersion === null) {
    return { trigger: false, extractionIds: [], schemaVersion: cached.schemaVersion ?? 0 };
  }

  const batchSize = cached.evolutionConfig.batchSize;
  const recentExtractions = await deps.extractionRepo.findByJob(jobId, tenantId, {
    schemaVersion: cached.schemaVersion,
    limit: batchSize,
  });

  if (recentExtractions.length >= batchSize) {
    return {
      trigger: true,
      extractionIds: recentExtractions.map((e) => e.id),
      schemaVersion: cached.schemaVersion,
    };
  }

  return { trigger: false, extractionIds: [], schemaVersion: cached.schemaVersion };
}
