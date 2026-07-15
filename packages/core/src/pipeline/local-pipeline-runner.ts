/**
 * LocalPipelineRunner — single-process crawl pipeline for local mode.
 *
 * Orchestrates the full crawl -> extract -> evolve -> reconcile -> export
 * pipeline using in-memory concurrency primitives (PriorityQueue, Semaphore,
 * InMemoryPageBudget) rather than BullMQ/Redis.
 *
 * Execution flow:
 *  1. Acquire project lock
 *  2. Create run record
 *  3. Load config + seed URLs
 *  4. Crash recovery: reset in_progress tasks to pending
 *  5. Seed URL enqueue (if first run)
 *  6. Build in-memory priority queue from pending tasks
 *  7. Initialize page budget
 *  8. Crawl loop (with retry, rate limiting, robots.txt)
 *  9. Schema evolution (if schemaEvolver provided)
 * 10. Reconciliation (if reconciler provided)
 * 11. Auto-export (if config.export.autoExport)
 * 12. Finalize run record
 * 13. Release lock
 */
import { createLogger } from '@accidentally-awesome-labs/spatula-shared';
import { InMemoryPageBudget } from '../crawlers/page-budget.js';
import { PriorityQueue } from './priority-queue.js';
import { Semaphore } from './concurrency.js';
import { ProjectLock } from './project-lock.js';
import { PipelineEventEmitter } from './pipeline-events.js';
import { processCrawlTask, shouldTriggerSchemaEvolution } from './crawl-orchestrator.js';
import { processSchemaEvolution } from './schema-orchestrator.js';
import { processReconciliation } from './reconcile-orchestrator.js';
import { processExport } from './export-orchestrator.js';
import { diffConfigs } from '../config/config-differ.js';
import type { JobConfigDiff } from '../config/diff-types.js';
import type {
  CrawlOrchestratorDeps,
  SchemaOrchestratorDeps,
  ReconcileOrchestratorDeps,
  ExportOrchestratorDeps,
  SchemaRepo,
  CrawlTaskInput,
} from './types.js';
import type { ContentStore } from '../interfaces/content-store.js';

const logger = createLogger('local-pipeline-runner');

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000; // 2s, 4s, 8s exponential backoff
const DRAIN_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Structural type for ProjectAdapter (avoids circular dep on @accidentally-awesome-labs/spatula-db)
// ---------------------------------------------------------------------------

interface TaskRepoLike {
  updateStatus(taskId: string, tenantId: string, status: string): Promise<unknown>;
  updateClassification(taskId: string, tenantId: string, classification: string): Promise<unknown>;
  enqueue(data: {
    jobId: string;
    tenantId: string;
    url: string;
    depth: number;
    parentTaskId: string;
  }): Promise<{ id: string }>;
  findPending(
    jobId: string,
    options?: { limit?: number },
  ): Promise<
    Array<{
      id: string;
      url: string;
      depth: number;
      priorityScore: number | null;
      parentTaskId: string | null;
      createdAt: string;
    }>
  >;
  getJobStats(
    jobId: string,
    tenantId: string,
  ): Promise<{
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    skipped: number;
  }>;
}

interface RunRepoLike {
  create(data: {
    status: string;
    source: string;
    configSnapshot: Record<string, unknown>;
    startedAt: string;
  }): Promise<{ id: string }>;
  findLatestByStatus(
    statuses: string[],
  ): Promise<{ id: string; configSnapshot: Record<string, unknown> } | null>;
  updateStatus(id: string, status: string, completedAt?: string): Promise<void>;
  updateStats(id: string, stats: Record<string, unknown>): Promise<void>;
}

interface ExportRepoCreateLike {
  create(data: {
    runId?: string;
    format: string;
    filePath: string;
    includeProvenance?: boolean;
  }): Promise<{ id: string }>;
  updateStatus(
    exportId: string,
    tenantId: string,
    data: {
      status: 'processing' | 'completed' | 'failed';
      entityCount?: number;
      contentRef?: string;
      fileSize?: number;
      error?: string;
      completedAt?: Date;
    },
  ): Promise<unknown>;
}

export interface ProjectAdapterForRunner {
  getProjectId(): string;
  jobRepo: {
    findById(
      jobId: string,
      tenantId: string,
    ): Promise<{ id: string; config: unknown; status?: string } | null>;
    updateStatus(jobId: string, tenantId: string, status: string): Promise<unknown>;
  };
  taskRepo: TaskRepoLike;
  pageRepo: {
    findByContentHash(hash: string, tenantId: string): Promise<{ id: string } | null>;
    findByIds(
      ids: string[],
      tenantId: string,
    ): Promise<Array<{ id: string; metadata: Record<string, unknown> | null; createdAt: Date }>>;
    create(data: {
      taskId: string;
      tenantId: string;
      contentRef: string;
      contentHash: string;
      metadata: Record<string, unknown>;
    }): Promise<{ id: string }>;
    /** Flag all pages for a job as needing re-extraction. Optional — re-extraction skipped if missing. */
    flagForReextraction?(jobId: string, reason: string): Promise<number>;
    /** Find pages flagged for re-extraction. Optional — re-extraction skipped if missing. */
    findNeedingReextraction?(
      jobId: string,
    ): Promise<Array<{ id: string; url: string | null; contentRef: string }>>;
    /** Clear re-extraction flags after processing. Optional. */
    clearReextractionFlag?(pageIds: string[]): Promise<void>;
  };
  extractionRepo: {
    store(data: unknown): Promise<unknown>;
    findByJob(
      jobId: string,
      tenantId: string,
      options?: { schemaVersion?: number; limit?: number; offset?: number },
    ): Promise<
      Array<{
        id: string;
        jobId: string;
        pageId: string;
        schemaVersion: number;
        data: unknown;
        metadata: unknown;
      }>
    >;
  };
  schemaRepo: {
    findLatest(
      jobId: string,
      tenantId: string,
    ): Promise<{ id: string; version: number; definition: unknown } | null>;
    create(data: unknown): Promise<unknown>;
  };
  entityRepo: {
    create(data: unknown): Promise<{ id: string }>;
    findByJob(
      jobId: string,
      tenantId: string,
      options?: { limit: number; offset: number },
    ): Promise<unknown[]>;
    findByJobWithProvenance(
      jobId: string,
      tenantId: string,
      options?: { limit: number; offset: number },
    ): Promise<unknown[]>;
    countByJob(jobId: string, tenantId: string): Promise<number>;
  };
  entitySourceRepo: {
    bulkLink(
      links: Array<{ entityId: string; extractionId: string; matchConfidence: number }>,
    ): Promise<unknown>;
  };
  sourceTrustRepo: {
    upsert(data: unknown): Promise<unknown>;
  };
  actionRepo: {
    create(data: unknown): Promise<unknown>;
  };
  exportRepo: ExportRepoCreateLike;
  runRepo: RunRepoLike;
}

// ---------------------------------------------------------------------------
// Public config interface
// ---------------------------------------------------------------------------

export interface LocalPipelineConfig {
  adapter: ProjectAdapterForRunner;
  config: any; // Resolved JobConfig
  projectDir: string;
  crawler: any;
  extractor: any;
  classifier: any;
  contentStore: ContentStore;
  schemaEvolver?: any;
  reconciler?: any;
  linkEvaluator?: any;
  robotsChecker?: { isAllowed(url: string): Promise<boolean> };
  rateLimiter?: { waitForSlot(url: string, crawlDelay?: number): Promise<void> };
  /** Optional lock override (defaults to ProjectLock). Useful for testing. */
  lock?: { acquire(force?: boolean): boolean; release(): void; isAcquired: boolean };
  /** Base retry delay in ms (default 2000). Set to 0 for tests. */
  retryBaseMs?: number;
  /** Skip the single-instance lock check (useful for debugging). */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Queue item type
// ---------------------------------------------------------------------------

interface CrawlQueueItem {
  taskId: string;
  url: string;
  depth: number;
  parentTaskId: string | null;
}

// ---------------------------------------------------------------------------
// LocalPipelineRunner
// ---------------------------------------------------------------------------

export class LocalPipelineRunner {
  private readonly cfg: LocalPipelineConfig;
  private readonly emitter = new PipelineEventEmitter();
  private isPaused = false;
  private runId: string | null = null;
  private lock: { acquire(force?: boolean): boolean; release(): void; isAcquired: boolean } | null =
    null;
  private inflightCount = 0;
  /** Track task IDs currently in-flight to prevent re-enqueue from loadPendingIntoQueue. */
  private readonly inflightTaskIds = new Set<string>();

  // Stats
  private pagesProcessed = 0;
  private errors = 0;

  constructor(config: LocalPipelineConfig) {
    this.cfg = config;
  }

  /** The event emitter — consumers (CLI) can listen for progress etc. */
  get events(): PipelineEventEmitter {
    return this.emitter;
  }

  /**
   * Run the full pipeline. Resolves when the crawl loop, reconciliation,
   * and optional export are all complete (or when stop() is called).
   */
  async run(): Promise<void> {
    const { adapter, config } = this.cfg;
    const projectId = adapter.getProjectId();

    // Step 1: Acquire lock
    if (this.cfg.lock) {
      this.lock = this.cfg.lock as any;
    } else {
      this.lock = new ProjectLock(this.cfg.projectDir);
    }
    if (!this.lock!.acquire(this.cfg.force ?? false)) {
      throw new Error('Another spatula process is already running for this project');
    }

    try {
      // Step 2: Create run record
      const runRecord = await adapter.runRepo.create({
        status: 'running',
        source: 'local',
        configSnapshot: config as Record<string, unknown>,
        startedAt: new Date().toISOString(),
      });
      this.runId = runRecord.id;

      // Step 3: Load config (already available as this.cfg.config)
      const jobConfig = config;
      const crawlConfig = jobConfig.crawl ?? { maxDepth: 2, maxPages: 100, concurrency: 5 };
      const maxPages = crawlConfig.maxPages ?? 100;
      const concurrency = crawlConfig.concurrency ?? 5;
      const seedUrls: string[] = jobConfig.seedUrls ?? [];

      // Step 4: Crash recovery — reset in_progress tasks to pending
      await this.recoverCrashedTasks(projectId);

      // Step 5: Config diff against last run
      const configDiff = await this.diffConfigWithLastRun(projectId, jobConfig);

      // Step 5b: Seed URL enqueue — first run or new seeds from config diff
      const stats = await adapter.taskRepo.getJobStats(projectId, projectId);
      const totalExistingTasks =
        stats.pending + stats.inProgress + stats.completed + stats.failed + stats.skipped;

      if (totalExistingTasks === 0) {
        // First run — enqueue all seeds
        for (const url of seedUrls) {
          await adapter.taskRepo.enqueue({
            jobId: projectId,
            tenantId: projectId,
            url,
            depth: 0,
            parentTaskId: '',
          });
        }
        logger.info({ seedCount: seedUrls.length }, 'seed URLs enqueued');
      } else if (configDiff?.seedsAdded.length) {
        // Subsequent run — enqueue only new seeds
        for (const url of configDiff.seedsAdded) {
          await adapter.taskRepo.enqueue({
            jobId: projectId,
            tenantId: projectId,
            url,
            depth: 0,
            parentTaskId: '',
          });
        }
        logger.info(
          { seedCount: configDiff.seedsAdded.length },
          'new seed URLs enqueued from config diff',
        );
      }

      // Step 7: Initialize page budget
      const budget = new InMemoryPageBudget(maxPages);

      // Account for already-completed pages from previous runs
      for (let i = 0; i < stats.completed; i++) {
        budget.tryIncrement();
      }

      // Step 8: Crawl loop
      await this.crawlLoop(projectId, budget, concurrency, jobConfig);

      // If stopped/paused, skip post-processing
      if (this.isPaused) {
        await this.finalizeRun('paused');
        return;
      }

      // Step 7b: Re-extraction pass for pages flagged by config diff
      if (configDiff && this.cfg.extractor) {
        await this.runReextraction(projectId, jobConfig);
      }

      // Step 9: Schema evolution
      if (this.cfg.schemaEvolver) {
        await this.runSchemaEvolution(projectId);
      }

      // Step 10: Reconciliation
      if (this.cfg.reconciler) {
        await this.runReconciliation(projectId);
      }

      // Step 11: Auto-export
      if (jobConfig.export?.autoExport) {
        await this.runAutoExport(projectId, jobConfig);
      }

      // Step 12-13: Finalize
      await this.finalizeRun('completed');
    } catch (err) {
      logger.error({ error: err }, 'pipeline run failed');
      await this.finalizeRun('failed', (err as Error).message);
      throw err;
    }
  }

  /**
   * Signal the runner to stop gracefully. Waits for in-flight tasks
   * to complete (up to 10s), then releases the lock.
   */
  stop(): void {
    this.isPaused = true;
    logger.info('stop requested — waiting for in-flight tasks to drain');
  }

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------

  private async recoverCrashedTasks(projectId: string): Promise<void> {
    const stats = await this.cfg.adapter.taskRepo.getJobStats(projectId, projectId);
    if (stats.inProgress === 0) return;

    logger.info({ count: stats.inProgress }, 'recovering crashed in-progress tasks');

    // The task repo may support querying by status directly. We probe for the
    // optional findByStatus method which the SqliteCrawlTaskRepository provides.
    const repo = this.cfg.adapter.taskRepo as any;

    if (typeof repo.resetInProgressToPending === 'function') {
      await repo.resetInProgressToPending(projectId);
    } else if (typeof repo.findByStatus === 'function') {
      const inProgressTasks: Array<{ id: string }> = await repo.findByStatus(
        projectId,
        'in_progress',
      );
      for (const task of inProgressTasks) {
        await this.cfg.adapter.taskRepo.updateStatus(task.id, projectId, 'pending');
      }
    } else {
      logger.warn(
        { inProgress: stats.inProgress },
        'cannot find in_progress tasks to reset — they may remain stuck. Consider using `spatula reset` to clear them.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Config diff
  // -------------------------------------------------------------------------

  private async diffConfigWithLastRun(
    projectId: string,
    currentConfig: any,
  ): Promise<JobConfigDiff | null> {
    const previousRun = await this.cfg.adapter.runRepo.findLatestByStatus(['completed', 'paused']);
    if (!previousRun) return null;

    try {
      const diff = diffConfigs(currentConfig, previousRun.configSnapshot as any);
      if (!diff.hasChanges) {
        logger.debug('config unchanged since last run');
        return null;
      }

      logger.info(
        {
          seedsAdded: diff.seedsAdded.length,
          seedsRemoved: diff.seedsRemoved.length,
          fieldsAdded: diff.fieldsAdded.length,
          fieldsRemoved: diff.fieldsRemoved.length,
          fieldsModified: diff.fieldsModified.length,
          crawlChanged: diff.crawlChanged.proxyChanged || diff.crawlChanged.cookiesChanged,
          llmChanged: diff.llmChanged,
        },
        'config changes detected since last run',
      );

      // Flag pages for re-extraction if schema fields changed
      const needsReextraction =
        diff.fieldsAdded.length > 0 ||
        diff.fieldsRemoved.length > 0 ||
        diff.fieldsModified.length > 0 ||
        diff.schemaModeChanged != null;

      if (needsReextraction && this.cfg.adapter.pageRepo.flagForReextraction) {
        const reason = [
          diff.fieldsAdded.length > 0 && `${diff.fieldsAdded.length} fields added`,
          diff.fieldsRemoved.length > 0 && `${diff.fieldsRemoved.length} fields removed`,
          diff.fieldsModified.length > 0 && `${diff.fieldsModified.length} fields modified`,
          diff.schemaModeChanged &&
            `schema mode changed: ${diff.schemaModeChanged.from} → ${diff.schemaModeChanged.to}`,
        ]
          .filter(Boolean)
          .join(', ');

        const flagged = await this.cfg.adapter.pageRepo.flagForReextraction(projectId, reason);
        logger.info({ flagged, reason }, 'pages flagged for re-extraction');
      }

      return diff;
    } catch (err) {
      logger.warn(
        { error: (err as Error).message },
        'config diff failed — continuing without diff',
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Re-extraction
  // -------------------------------------------------------------------------

  private async runReextraction(projectId: string, jobConfig: any): Promise<void> {
    const { adapter, extractor, contentStore } = this.cfg;

    if (!adapter.pageRepo.findNeedingReextraction) {
      logger.debug('page repo does not support re-extraction queries — skipping');
      return;
    }

    const flaggedPages = await adapter.pageRepo.findNeedingReextraction(projectId);
    if (flaggedPages.length === 0) return;

    logger.info({ count: flaggedPages.length }, 'running re-extraction on flagged pages');

    const schema = await adapter.schemaRepo.findLatest(projectId, projectId);
    if (!schema) {
      logger.warn('no schema found — skipping re-extraction');
      return;
    }

    let reextracted = 0;

    for (const page of flaggedPages) {
      if (this.isPaused) break;

      try {
        const html = await contentStore.retrieve(page.contentRef);
        const result = await extractor.extract(
          html,
          page.url ?? '',
          schema.definition,
          jobConfig.description ?? '',
        );

        await adapter.extractionRepo.store({
          jobId: projectId,
          tenantId: projectId,
          pageId: page.id,
          schemaVersion: schema.version,
          data: result.data,
          unmappedFields: result.metadata?.unmappedFields ?? [],
          metadata: result.metadata,
        });

        reextracted++;
      } catch (err) {
        logger.warn(
          { pageId: page.id, error: (err as Error).message },
          're-extraction failed for page — skipping',
        );
        this.errors++;
      }
    }

    // Clear flags for processed pages
    if (adapter.pageRepo.clearReextractionFlag) {
      await adapter.pageRepo.clearReextractionFlag(flaggedPages.map((p) => p.id));
    }

    // Update run stats
    if (this.runId) {
      await adapter.runRepo.updateStats(this.runId, { pagesReextracted: reextracted });
    }

    logger.info({ reextracted, total: flaggedPages.length }, 're-extraction complete');
  }

  // -------------------------------------------------------------------------
  // Crawl loop
  // -------------------------------------------------------------------------

  private async crawlLoop(
    projectId: string,
    budget: InMemoryPageBudget,
    concurrency: number,
    jobConfig: any,
  ): Promise<void> {
    const sem = new Semaphore(concurrency);
    const queue = new PriorityQueue<CrawlQueueItem>();

    // Load initial pending tasks from DB into the in-memory priority queue
    await this.loadPendingIntoQueue(projectId, queue);

    // Process loop
    while (!this.isPaused) {
      // If queue is empty, try to load more from DB (in case of enqueued links)
      if (queue.isEmpty) {
        await this.loadPendingIntoQueue(projectId, queue);
        if (queue.isEmpty) break; // Truly done
      }

      // Check budget before dequeuing
      if (budget.isExhausted) {
        logger.info({ processed: budget.count, max: budget.maxPages }, 'page budget exhausted');
        break;
      }

      const item = queue.dequeue();
      if (!item) break;

      // Attempt to consume a page from the budget
      if (!budget.tryIncrement()) {
        logger.info({ url: item.url }, 'page budget exhausted, skipping task');
        break;
      }

      // Acquire semaphore slot
      await sem.acquire();
      this.inflightCount++;
      this.inflightTaskIds.add(item.taskId);

      // Fire-and-forget (bounded by semaphore)
      this.processTaskWithRetry(item, projectId, jobConfig, queue, budget).finally(() => {
        sem.release();
        this.inflightCount--;
        this.inflightTaskIds.delete(item.taskId);
      });
    }

    // Wait for in-flight tasks to drain
    await this.drainInflight();
  }

  private async processTaskWithRetry(
    item: CrawlQueueItem,
    projectId: string,
    _jobConfig: any,
    queue: PriorityQueue<CrawlQueueItem>,
    budget: InMemoryPageBudget,
  ): Promise<void> {
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      attempt++;

      try {
        // Optional robots.txt check
        if (this.cfg.robotsChecker) {
          const allowed = await this.cfg.robotsChecker.isAllowed(item.url);
          if (!allowed) {
            logger.debug({ url: item.url }, 'blocked by robots.txt, skipping');
            await this.cfg.adapter.taskRepo.updateStatus(item.taskId, projectId, 'skipped');
            return;
          }
        }

        // Optional rate limiting
        if (this.cfg.rateLimiter) {
          await this.cfg.rateLimiter.waitForSlot(item.url);
        }

        // Build the CrawlOrchestratorDeps bundle
        const crawlDeps: CrawlOrchestratorDeps = {
          crawler: this.cfg.crawler,
          classifier: this.cfg.classifier,
          extractor: this.cfg.extractor,
          contentStore: this.cfg.contentStore,
          linkEvaluator: this.cfg.linkEvaluator,
          taskRepo: this.cfg.adapter.taskRepo,
          pageRepo: this.cfg.adapter.pageRepo,
          jobRepo: this.cfg.adapter.jobRepo,
          extractionRepo: this.cfg.adapter.extractionRepo,
          schemaRepo: this.cfg.adapter.schemaRepo as SchemaRepo,
        };

        const input: CrawlTaskInput = {
          taskId: item.taskId,
          jobId: projectId,
          tenantId: projectId,
          url: item.url,
          depth: item.depth,
        };

        const result = await processCrawlTask(input, crawlDeps);

        // Check if the orchestrator signalled an error
        if (result.error) {
          if (attempt < MAX_RETRIES) {
            const retryBase = this.cfg.retryBaseMs ?? RETRY_BASE_MS;
            const backoff = retryBase * Math.pow(2, attempt - 1);
            logger.warn(
              { taskId: item.taskId, attempt, backoffMs: backoff, error: result.error.message },
              'crawl task failed, retrying',
            );
            // Reset status to pending for retry
            await this.cfg.adapter.taskRepo.updateStatus(item.taskId, projectId, 'pending');
            await sleep(backoff);
            continue;
          }
          // Max retries exhausted
          logger.error(
            { taskId: item.taskId, attempts: attempt },
            'crawl task permanently failed after max retries',
          );
          await this.cfg.adapter.taskRepo.updateStatus(item.taskId, projectId, 'failed');
          this.errors++;
          return;
        }

        // Success
        this.pagesProcessed++;
        this.emitter.emit('task:completed', {
          id: item.taskId,
          url: item.url,
          status: 'completed',
        });
        this.emitter.emit('progress', {
          pagesProcessed: this.pagesProcessed,
          totalPages: budget.maxPages,
          entitiesCreated: 0, // Updated later after reconciliation
          errors: this.errors,
        });

        // Enqueue discovered links
        if (result.linksFound.length > 0) {
          for (const link of result.linksFound) {
            const enqueued = await this.cfg.adapter.taskRepo.enqueue({
              jobId: projectId,
              tenantId: projectId,
              url: link.url,
              depth: item.depth + 1,
              parentTaskId: item.taskId,
            });
            queue.enqueue(
              {
                taskId: enqueued.id,
                url: link.url,
                depth: item.depth + 1,
                parentTaskId: item.taskId,
              },
              link.relevanceScore ?? 0.5,
              item.depth + 1,
            );
          }
          logger.debug(
            { taskId: item.taskId, linksEnqueued: result.linksFound.length },
            'discovered links enqueued',
          );
        }

        // Check schema evolution trigger
        if (result.evolutionConfig?.enabled && this.cfg.schemaEvolver) {
          const evolution = await shouldTriggerSchemaEvolution(
            projectId,
            projectId,
            { schemaVersion: result.schemaVersion, evolutionConfig: result.evolutionConfig },
            { extractionRepo: this.cfg.adapter.extractionRepo },
          );
          if (evolution.trigger) {
            await this.runSchemaEvolution(projectId);
          }
        }

        return; // Done with this task
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const retryBase = this.cfg.retryBaseMs ?? RETRY_BASE_MS;
          const backoff = retryBase * Math.pow(2, attempt - 1);
          logger.warn(
            { taskId: item.taskId, attempt, backoffMs: backoff, error: (err as Error).message },
            'crawl task threw, retrying',
          );
          await this.cfg.adapter.taskRepo.updateStatus(item.taskId, projectId, 'pending');
          await sleep(backoff);
          continue;
        }
        logger.error(
          { taskId: item.taskId, attempts: attempt, error: err },
          'crawl task permanently failed after max retries (thrown)',
        );
        await this.cfg.adapter.taskRepo.updateStatus(item.taskId, projectId, 'failed');
        this.errors++;
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Post-crawl phases
  // -------------------------------------------------------------------------

  private async runSchemaEvolution(projectId: string): Promise<void> {
    logger.info('running schema evolution');
    const deps: SchemaOrchestratorDeps = {
      schemaEvolver: this.cfg.schemaEvolver,
      jobRepo: this.cfg.adapter.jobRepo,
      extractionRepo: this.cfg.adapter.extractionRepo,
      schemaRepo: this.cfg.adapter.schemaRepo as SchemaRepo,
      actionRepo: this.cfg.adapter.actionRepo,
    };
    const result = await processSchemaEvolution(
      { jobId: projectId, tenantId: projectId, extractionIds: [] },
      deps,
    );
    if (result.evolved) {
      logger.info(
        { newVersion: result.newVersion, actions: result.actionsApplied },
        'schema evolved',
      );
      this.emitter.emit('schema:evolved', {
        version: result.newVersion ?? 0,
        fields: [],
      });
    }
  }

  private async runReconciliation(projectId: string): Promise<void> {
    logger.info('running reconciliation');
    const deps: ReconcileOrchestratorDeps = {
      reconciler: this.cfg.reconciler,
      jobRepo: this.cfg.adapter.jobRepo,
      schemaRepo: this.cfg.adapter.schemaRepo as SchemaRepo,
      extractionRepo: this.cfg.adapter.extractionRepo,
      pageRepo: this.cfg.adapter.pageRepo,
      entityRepo: this.cfg.adapter.entityRepo,
      entitySourceRepo: this.cfg.adapter.entitySourceRepo,
      sourceTrustRepo: this.cfg.adapter.sourceTrustRepo,
    };
    const result = await processReconciliation({ jobId: projectId, tenantId: projectId }, deps);
    logger.info(
      { entitiesCreated: result.entitiesCreated, actions: result.actionsGenerated },
      'reconciliation complete',
    );
  }

  private async runAutoExport(projectId: string, jobConfig: any): Promise<void> {
    logger.info('running auto-export');
    const exportConfig = jobConfig.export ?? {};
    const format = exportConfig.format ?? 'json';
    const includeProvenance = exportConfig.includeProvenance ?? false;

    // Create export record
    const exportRecord = await this.cfg.adapter.exportRepo.create({
      runId: this.runId ?? undefined,
      format,
      filePath: `${this.cfg.projectDir}/exports`,
      includeProvenance,
    });

    const deps: ExportOrchestratorDeps = {
      jobRepo: this.cfg.adapter.jobRepo,
      schemaRepo: this.cfg.adapter.schemaRepo as SchemaRepo,
      entityRepo: this.cfg.adapter.entityRepo,
      exportRepo: this.cfg.adapter.exportRepo,
      contentStore: this.cfg.contentStore,
    };

    await processExport(
      {
        exportId: exportRecord.id,
        jobId: projectId,
        tenantId: projectId,
        format,
        includeProvenance,
      },
      deps,
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async loadPendingIntoQueue(
    projectId: string,
    queue: PriorityQueue<CrawlQueueItem>,
  ): Promise<void> {
    const pending = await this.cfg.adapter.taskRepo.findPending(projectId, { limit: 100 });
    for (const task of pending) {
      // Skip tasks that are already in-flight (prevents re-enqueue race)
      if (this.inflightTaskIds.has(task.id)) continue;
      queue.enqueue(
        {
          taskId: task.id,
          url: task.url,
          depth: task.depth,
          parentTaskId: task.parentTaskId,
        },
        task.priorityScore ?? 50,
        task.depth,
      );
    }
  }

  private async drainInflight(): Promise<void> {
    if (this.inflightCount === 0) return;

    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.inflightCount > 0 && Date.now() < deadline) {
      await sleep(100);
    }

    if (this.inflightCount > 0) {
      logger.warn(
        { remaining: this.inflightCount },
        'drain timeout reached, some tasks may not have completed',
      );
    }
  }

  private async finalizeRun(
    status: 'completed' | 'failed' | 'paused',
    errorMessage?: string,
  ): Promise<void> {
    if (this.runId) {
      await this.cfg.adapter.runRepo.updateStatus(this.runId, status, new Date().toISOString());
      await this.cfg.adapter.runRepo.updateStats(this.runId, {
        pagesCrawled: this.pagesProcessed,
        errorMessage: errorMessage ?? null,
      });
    }

    // Release lock
    if (this.lock) {
      this.lock.release();
      this.lock = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
