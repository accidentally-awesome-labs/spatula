# Wave 1a: Orchestrator Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract business logic from 4 BullMQ workers into pure orchestrator functions in `@spatula/core/pipeline`, then refactor workers into thin wrappers that delegate to orchestrators.

**Architecture:** Each worker currently mixes BullMQ-specific concerns (job data parsing, queue references, Redis locks) with pure business logic (content dedup, classification, extraction, link evaluation, schema evolution, reconciliation, export formatting). We split each worker into: (1) a pure orchestrator function in `@spatula/core` that accepts repositories and services via DI — no BullMQ/Redis/queue imports, and (2) a thin worker wrapper in `@spatula/queue` that parses job data, calls the orchestrator, and handles queue-specific status updates. Zero behavior change — all existing tests must continue to pass.

**Tech Stack:** TypeScript, Vitest, `@spatula/core`, `@spatula/queue`, `@spatula/db` (repository interfaces), `@spatula/shared` (logging, errors)

**Spec references:**

- Phase 12 spec: section 2.5 (Extract Shared Pipeline Orchestrators)
- Phase 13 spec: section 4.1.1 (Prerequisite Refactoring)

---

## File Structure

### New Files

| File                                                               | Responsibility                                                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/crawl-orchestrator.ts`                 | Pure crawl logic: URL validation, content dedup, classify, extract, link evaluation, schema evolution trigger check                                                                                      |
| `packages/core/src/pipeline/schema-orchestrator.ts`                | Pure schema evolution logic: config check, extraction batching, evolve, action persistence, version bump                                                                                                 |
| `packages/core/src/pipeline/reconcile-orchestrator.ts`             | Pure reconciliation logic: load extractions, enrich with page metadata, reconcile, persist entities + trust                                                                                              |
| `packages/core/src/pipeline/export-orchestrator.ts`                | Pure export logic: validate job, fetch entities, select exporter, format output, store result                                                                                                            |
| `packages/core/src/pipeline/types.ts`                              | Shared types: `CrawlOrchestratorDeps`, `SchemaOrchestratorDeps`, `ReconcileOrchestratorDeps`, `ExportOrchestratorDeps`, `CrawlTaskInput`, `CrawlTaskResult`, `LinkToEnqueue`, `EventPublisher` interface |
| `packages/core/src/pipeline/index.ts`                              | Barrel export                                                                                                                                                                                            |
| `packages/core/tests/unit/pipeline/crawl-orchestrator.test.ts`     | Tests for crawl orchestrator                                                                                                                                                                             |
| `packages/core/tests/unit/pipeline/schema-orchestrator.test.ts`    | Tests for schema orchestrator                                                                                                                                                                            |
| `packages/core/tests/unit/pipeline/reconcile-orchestrator.test.ts` | Tests for reconciliation orchestrator                                                                                                                                                                    |
| `packages/core/tests/unit/pipeline/export-orchestrator.test.ts`    | Tests for export orchestrator                                                                                                                                                                            |

### Modified Files

| File                                                  | Change                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `packages/queue/src/workers/crawl-worker.ts`          | Replace business logic with call to `processCrawlTask()`       |
| `packages/queue/src/workers/schema-worker.ts`         | Replace business logic with call to `processSchemaEvolution()` |
| `packages/queue/src/workers/reconciliation-worker.ts` | Replace business logic with call to `processReconciliation()`  |
| `packages/queue/src/workers/export-worker.ts`         | Replace business logic with call to `processExport()`          |
| `packages/core/src/index.ts`                          | Add pipeline barrel export                                     |

### Unchanged Files (but referenced)

| File                                                 | Why Referenced                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/queue/src/worker-deps.ts`                  | `WorkerDeps` type — workers continue to use this, orchestrators use narrower dep types |
| `packages/queue/src/queues.ts`                       | Job data interfaces (`CrawlJobData`, etc.) — still used by worker wrappers             |
| `packages/queue/src/redis-lock.ts`                   | Lock functions — still called by schema worker wrapper                                 |
| `packages/queue/src/events.ts`                       | `EventPublisher` — re-exported via pipeline types                                      |
| All existing worker tests in `packages/queue/tests/` | Must continue to pass after refactoring                                                |

---

## Task 1: Define Pipeline Types

**Files:**

- Create: `packages/core/src/pipeline/types.ts`
- Create: `packages/core/src/pipeline/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create the pipeline types file**

```typescript
// packages/core/src/pipeline/types.ts
import type {
  Crawler,
  Extractor,
  ContentStore,
  SchemaEvolver,
  LinkEvaluator,
  PageClassifier,
  DataReconciler,
  Exporter,
  SchemaDefinition,
} from '../index.js';
import type { Entity } from '@spatula/shared';

// Re-export EventPublisher interface so orchestrators don't import from @spatula/queue
export interface EventPublisher {
  publish(
    jobId: string,
    event: { type: string; jobId: string; tenantId: string; data: unknown },
  ): Promise<void>;
}

// --- Repository interfaces (narrowed from full repo types) ---
// These match the existing @spatula/db repository method signatures
// but are declared here so @spatula/core has no dependency on @spatula/db

export interface CrawlTaskRepo {
  updateStatus(taskId: string, tenantId: string, status: string): Promise<void>;
  updateClassification(taskId: string, tenantId: string, classification: string): Promise<void>;
  enqueue(data: {
    jobId: string;
    tenantId: string;
    url: string;
    depth: number;
    parentTaskId: string;
  }): Promise<{ id: string }>;
}

export interface PageRepo {
  findByContentHash(hash: string, tenantId: string): Promise<{ id: string } | null>;
  findByIds(
    ids: string[],
    tenantId: string,
  ): Promise<Array<{ id: string; metadata: Record<string, unknown>; createdAt: Date }>>;
  create(data: {
    taskId: string;
    tenantId: string;
    contentRef: string;
    contentHash: string;
    metadata: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export interface ExtractionRepo {
  store(data: {
    jobId: string;
    tenantId: string;
    pageId: string;
    schemaVersion: number;
    data: Record<string, unknown>;
    unmappedFields: unknown[];
    metadata: unknown;
  }): Promise<void>;
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
}

export interface SchemaRepo {
  findLatest(
    jobId: string,
    tenantId: string,
  ): Promise<{ id: string; version: number; definition: SchemaDefinition } | null>;
  create(data: {
    jobId: string;
    tenantId: string;
    version: number;
    definition: SchemaDefinition;
    parentId?: string;
  }): Promise<void>;
}

export interface JobRepo {
  findById(
    jobId: string,
    tenantId: string,
  ): Promise<{ id: string; config: unknown; status?: string } | null>;
  updateStatus(jobId: string, tenantId: string, status: string): Promise<void>;
}

export interface EntityRepo {
  create(data: {
    jobId: string;
    tenantId: string;
    mergedData: Record<string, unknown>;
    provenance: unknown;
    qualityScore: number;
  }): Promise<{ id: string }>;
  findByJob(
    jobId: string,
    tenantId: string,
    options?: { limit: number; offset: number },
  ): Promise<Entity[]>;
  findByJobWithProvenance(
    jobId: string,
    tenantId: string,
    options?: { limit: number; offset: number },
  ): Promise<Entity[]>;
  countByJob(jobId: string, tenantId: string): Promise<number>;
}

export interface EntitySourceRepo {
  bulkLink(
    links: Array<{ entityId: string; extractionId: string; matchConfidence: number }>,
  ): Promise<void>;
}

export interface SourceTrustRepo {
  upsert(data: {
    jobId: string;
    tenantId: string;
    domain: string;
    trustLevel: string;
    reasoning: string;
  }): Promise<void>;
}

export interface ActionRepo {
  create(data: {
    jobId: string;
    tenantId: string;
    type: string;
    payload: unknown;
    source: string;
    status: string;
    confidence?: number;
    reasoning?: string;
  }): Promise<void>;
}

export interface ExportRepo {
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
  ): Promise<void>;
}

// --- Orchestrator dependency bundles ---

export interface CrawlOrchestratorDeps {
  crawler: Crawler;
  classifier: PageClassifier;
  extractor: Extractor;
  contentStore: ContentStore;
  linkEvaluator?: LinkEvaluator;
  taskRepo: CrawlTaskRepo;
  pageRepo: PageRepo;
  jobRepo: JobRepo;
  extractionRepo: ExtractionRepo;
  schemaRepo: SchemaRepo;
  eventPublisher?: EventPublisher;
}

export interface SchemaOrchestratorDeps {
  schemaEvolver: SchemaEvolver;
  jobRepo: JobRepo;
  extractionRepo: ExtractionRepo;
  schemaRepo: SchemaRepo;
  actionRepo: ActionRepo;
  eventPublisher?: EventPublisher;
}

export interface ReconcileOrchestratorDeps {
  reconciler: DataReconciler;
  jobRepo: JobRepo;
  schemaRepo: SchemaRepo;
  extractionRepo: ExtractionRepo;
  pageRepo: PageRepo;
  entityRepo: EntityRepo;
  entitySourceRepo: EntitySourceRepo;
  sourceTrustRepo: SourceTrustRepo;
  eventPublisher?: EventPublisher;
}

export interface ExportOrchestratorDeps {
  jobRepo: JobRepo;
  schemaRepo: SchemaRepo;
  entityRepo: EntityRepo;
  exportRepo: ExportRepo;
  contentStore: ContentStore;
}

// --- Input/Output types ---

export interface CrawlTaskInput {
  taskId: string;
  jobId: string;
  tenantId: string;
  url: string;
  depth: number;
}

export interface LinkToEnqueue {
  url: string;
  text?: string;
  rel?: string;
  priority?: string;
  relevanceScore?: number;
}

export interface CrawlTaskResult {
  pageId: string;
  classification: string;
  extracted: boolean;
  linksFound: LinkToEnqueue[];
  contentHash: string;
  deduplicated: boolean;
  schemaVersion: number | null; // For schema evolution trigger check — avoids re-fetching
  evolutionConfig: { enabled: boolean; batchSize: number } | null; // From job config
}

export interface SchemaEvolutionInput {
  jobId: string;
  tenantId: string;
  extractionIds: string[]; // Note: currently unused by the orchestrator (it fetches latest batch from DB).
  // Preserved for backward compat with queue job data. Future optimization:
  // use these IDs to fetch specific extractions instead of latest N.
}

export interface SchemaEvolutionResult {
  evolved: boolean;
  newVersion?: number;
  actionsApplied: number;
}

export interface ReconciliationInput {
  jobId: string;
  tenantId: string;
}

export interface ReconciliationResult {
  entitiesCreated: number;
  actionsGenerated: number;
}

export interface ExportInput {
  exportId: string;
  jobId: string;
  tenantId: string;
  format: 'json' | 'csv' | 'parquet' | 'duckdb' | 'sqlite';
  includeProvenance: boolean;
}

export interface ExportResult {
  entityCount: number;
  fileSize: number;
  contentRef: string;
}
```

- [ ] **Step 2: Create the barrel export**

```typescript
// packages/core/src/pipeline/index.ts
export * from './types.js';
export { processCrawlTask } from './crawl-orchestrator.js';
export { processSchemaEvolution } from './schema-orchestrator.js';
export { processReconciliation } from './reconcile-orchestrator.js';
export { processExport } from './export-orchestrator.js';
```

- [ ] **Step 3: Add pipeline export to core index**

In `packages/core/src/index.ts`, add:

```typescript
export * from './pipeline/index.js';
```

- [ ] **Step 4: Verify build passes**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build`
Expected: Build succeeds (types only, no implementations yet)

Note: Build will fail because the orchestrator files don't exist yet. That's expected. We'll fix it in the next tasks.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline/types.ts packages/core/src/pipeline/index.ts packages/core/src/index.ts
git commit -m "feat(core): add pipeline orchestrator types and interfaces"
```

---

## Task 2: Extract Crawl Orchestrator

**Files:**

- Create: `packages/core/src/pipeline/crawl-orchestrator.ts`
- Create: `packages/core/tests/unit/pipeline/crawl-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test for URL validation**

```typescript
// packages/core/tests/unit/pipeline/crawl-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processCrawlTask, isValidCrawlUrl } from '../../src/pipeline/crawl-orchestrator.js';
import type { CrawlOrchestratorDeps, CrawlTaskInput } from '../../src/pipeline/types.js';

describe('isValidCrawlUrl', () => {
  it('accepts valid HTTP URLs', () => {
    expect(isValidCrawlUrl('https://example.com/page')).toBe(true);
    expect(isValidCrawlUrl('http://example.com')).toBe(true);
  });

  it('rejects non-HTTP protocols', () => {
    expect(isValidCrawlUrl('ftp://example.com')).toBe(false);
    expect(isValidCrawlUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects localhost and private IPs', () => {
    expect(isValidCrawlUrl('http://localhost/admin')).toBe(false);
    expect(isValidCrawlUrl('http://127.0.0.1/admin')).toBe(false);
    expect(isValidCrawlUrl('http://192.168.1.1/admin')).toBe(false);
    expect(isValidCrawlUrl('http://10.0.0.1/admin')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isValidCrawlUrl('not-a-url')).toBe(false);
    expect(isValidCrawlUrl('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run crawl-orchestrator`
Expected: FAIL — module not found

- [ ] **Step 3: Write the crawl orchestrator implementation**

```typescript
// packages/core/src/pipeline/crawl-orchestrator.ts
import { createLoggerWithContext, CrawlError, NetworkError } from '@spatula/shared';
import { createHash } from 'node:crypto';
import type { JobConfig, LinkEvaluationContext } from '../index.js';
import type {
  CrawlOrchestratorDeps,
  CrawlTaskInput,
  CrawlTaskResult,
  LinkToEnqueue,
} from './types.js';

const EXTRACTABLE_CLASSIFICATIONS = new Set(['single_entry', 'multiple_entries', 'partial']);

export function isValidCrawlUrl(url: string): boolean {
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
        metadata: {
          url,
          title: crawlResult.title,
          statusCode: crawlResult.statusCode,
          responseTimeMs: crawlResult.metadata.responseTimeMs,
        },
      });
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
      (job.config as JobConfig).description,
    );
    await deps.taskRepo.updateClassification(taskId, tenantId, classification.classification);

    // 5. Publish task_completed event
    await deps.eventPublisher?.publish(jobId, {
      type: 'task_completed',
      jobId,
      tenantId,
      data: { taskId, url, classification: classification.classification },
    });

    // 6. Extract if page is extractable
    let extracted = false;
    if (EXTRACTABLE_CLASSIFICATIONS.has(classification.classification)) {
      const schema = await deps.schemaRepo.findLatest(jobId, tenantId);
      if (schema) {
        const extraction = await deps.extractor.extract(
          crawlResult.html,
          url,
          schema.definition,
          (job.config as JobConfig).description,
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
        extracted = true;
        logger.debug({ taskId, pageId: page.id }, 'extraction stored');
      }
    }

    // 7. Evaluate links (if within depth and evaluator available)
    const maxDepth = config.crawl.maxDepth;
    let linksFound: LinkToEnqueue[] = [];

    if (depth < maxDepth && crawlResult.links.length > 0) {
      if (deps.linkEvaluator) {
        const schema = await deps.schemaRepo.findLatest(jobId, tenantId);
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

    // Cache job config values for schema evolution trigger check (avoids re-fetching)
    const schema = await deps.schemaRepo.findLatest(jobId, tenantId);
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
        : new CrawlError('Crawl task failed', { cause: error as Error, context: { taskId, url } });
    logger.error({ taskId, url, error: wrappedError }, 'crawl task failed');
    await deps.taskRepo.updateStatus(taskId, tenantId, 'failed').catch((e) => {
      logger.error({ taskId, error: e }, 'failed to mark task as failed');
    });
    throw wrappedError;
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
```

- [ ] **Step 4: Write the full test suite for crawl orchestrator**

```typescript
// packages/core/tests/unit/pipeline/crawl-orchestrator.test.ts
// (append to the file from Step 1)
import {
  processCrawlTask,
  shouldTriggerSchemaEvolution,
} from '../../src/pipeline/crawl-orchestrator.js';

function createMockDeps(): CrawlOrchestratorDeps {
  return {
    crawler: {
      type: 'playwright' as const,
      crawl: vi.fn().mockResolvedValue({
        url: 'https://example.com/product/1',
        html: '<html><body><h1>Product 1</h1></body></html>',
        title: 'Product 1',
        statusCode: 200,
        contentType: 'text/html',
        links: [{ url: 'https://example.com/product/2', text: 'Product 2' }],
        metadata: {
          crawledAt: new Date(),
          responseTimeMs: 250,
          contentLength: 45,
          crawlerType: 'playwright' as const,
        },
      }),
      close: vi.fn(),
    },
    classifier: {
      classify: vi.fn().mockResolvedValue({ classification: 'single_entry', confidence: 0.9 }),
    },
    extractor: {
      extract: vi.fn().mockResolvedValue({
        data: { title: 'Product 1' },
        metadata: {
          confidence: 0.95,
          modelUsed: 'test-model',
          tokensUsed: 100,
          extractionTimeMs: 500,
          unmappedFields: [],
        },
      }),
    },
    contentStore: {
      store: vi.fn().mockResolvedValue('ref-abc'),
      retrieve: vi.fn(),
      delete: vi.fn(),
      storeBinary: vi.fn(),
      retrieveBinary: vi.fn(),
    },
    linkEvaluator: undefined,
    taskRepo: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
      updateClassification: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn().mockResolvedValue({ id: 'child-task-1' }),
    },
    pageRepo: {
      findByContentHash: vi.fn().mockResolvedValue(null),
      findByIds: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'page-1' }),
    },
    jobRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 'job-1',
        config: {
          tenantId: 'tenant-1',
          name: 'Test',
          description: 'Scrape products',
          seedUrls: ['https://example.com'],
          crawl: { maxDepth: 3, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
          schema: { mode: 'discovery' },
        },
      }),
      updateStatus: vi.fn(),
    },
    extractionRepo: {
      store: vi.fn().mockResolvedValue(undefined),
      findByJob: vi.fn().mockResolvedValue([]),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        id: 'schema-1',
        version: 1,
        definition: {
          version: 1,
          fields: [{ name: 'title', type: 'string', required: true, description: 'Title' }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      }),
      create: vi.fn(),
    },
    eventPublisher: { publish: vi.fn() },
  };
}

const defaultInput: CrawlTaskInput = {
  taskId: 'task-1',
  jobId: 'job-1',
  tenantId: 'tenant-1',
  url: 'https://example.com/product/1',
  depth: 0,
};

describe('processCrawlTask', () => {
  it('crawls URL, classifies, and extracts data', async () => {
    const deps = createMockDeps();
    const result = await processCrawlTask(defaultInput, deps);

    expect(deps.crawler.crawl).toHaveBeenCalledWith('https://example.com/product/1');
    expect(deps.classifier.classify).toHaveBeenCalled();
    expect(deps.extractor.extract).toHaveBeenCalled();
    expect(deps.extractionRepo.store).toHaveBeenCalled();
    expect(result.extracted).toBe(true);
    expect(result.classification).toBe('single_entry');
  });

  it('deduplicates content by hash', async () => {
    const deps = createMockDeps();
    (deps.pageRepo.findByContentHash as any).mockResolvedValue({ id: 'existing-page' });

    const result = await processCrawlTask(defaultInput, deps);

    expect(deps.contentStore.store).not.toHaveBeenCalled();
    expect(deps.pageRepo.create).not.toHaveBeenCalled();
    expect(result.deduplicated).toBe(true);
    expect(result.pageId).toBe('existing-page');
  });

  it('skips extraction for non-extractable classifications', async () => {
    const deps = createMockDeps();
    (deps.classifier.classify as any).mockResolvedValue({
      classification: 'navigation',
      confidence: 0.8,
    });

    const result = await processCrawlTask(defaultInput, deps);

    expect(deps.extractor.extract).not.toHaveBeenCalled();
    expect(result.extracted).toBe(false);
  });

  it('returns valid links filtered by URL validation', async () => {
    const deps = createMockDeps();
    (deps.crawler.crawl as any).mockResolvedValue({
      url: 'https://example.com',
      html: '<html></html>',
      title: '',
      statusCode: 200,
      links: [
        { url: 'https://example.com/valid', text: 'Valid' },
        { url: 'http://localhost/admin', text: 'Invalid' },
        { url: 'javascript:alert(1)', text: 'XSS' },
      ],
      metadata: {
        crawledAt: new Date(),
        responseTimeMs: 100,
        contentLength: 10,
        crawlerType: 'playwright',
      },
    });
    (deps.classifier.classify as any).mockResolvedValue({
      classification: 'navigation',
      confidence: 0.8,
    });

    const result = await processCrawlTask(defaultInput, deps);

    expect(result.linksFound).toHaveLength(1);
    expect(result.linksFound[0].url).toBe('https://example.com/valid');
  });

  it('does not return links when at max depth', async () => {
    const deps = createMockDeps();
    const input = { ...defaultInput, depth: 3 }; // maxDepth is 3

    const result = await processCrawlTask(input, deps);

    expect(result.linksFound).toHaveLength(0);
  });

  it('marks task as skipped when job not found', async () => {
    const deps = createMockDeps();
    (deps.jobRepo.findById as any).mockResolvedValue(null);

    const result = await processCrawlTask(defaultInput, deps);

    expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith('task-1', 'tenant-1', 'skipped');
    expect(result.classification).toBe('unknown');
  });

  it('marks task as failed and throws on crawl error', async () => {
    const deps = createMockDeps();
    (deps.crawler.crawl as any).mockRejectedValue(new Error('Network timeout'));

    await expect(processCrawlTask(defaultInput, deps)).rejects.toThrow();
    expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith('task-1', 'tenant-1', 'failed');
  });

  it('publishes task_completed event', async () => {
    const deps = createMockDeps();
    await processCrawlTask(defaultInput, deps);

    expect(deps.eventPublisher!.publish).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ type: 'task_completed' }),
    );
  });
});

describe('shouldTriggerSchemaEvolution', () => {
  it('returns false when evolution is disabled', async () => {
    const deps = createMockDeps();
    (deps.jobRepo.findById as any).mockResolvedValue({
      id: 'job-1',
      config: { schema: { mode: 'fixed' } },
    });

    const result = await shouldTriggerSchemaEvolution('job-1', 'tenant-1', deps);
    expect(result.trigger).toBe(false);
  });

  it('returns true when batch size is met', async () => {
    const deps = createMockDeps();
    (deps.jobRepo.findById as any).mockResolvedValue({
      id: 'job-1',
      config: { schema: { mode: 'hybrid', evolutionConfig: { enabled: true, batchSize: 3 } } },
    });
    (deps.extractionRepo.findByJob as any).mockResolvedValue([
      { id: 'e1' },
      { id: 'e2' },
      { id: 'e3' },
    ]);

    const result = await shouldTriggerSchemaEvolution('job-1', 'tenant-1', deps);
    expect(result.trigger).toBe(true);
    expect(result.extractionIds).toEqual(['e1', 'e2', 'e3']);
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run crawl-orchestrator`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pipeline/crawl-orchestrator.ts packages/core/tests/unit/pipeline/crawl-orchestrator.test.ts
git commit -m "feat(core): add crawl orchestrator with pure business logic extraction"
```

---

## Task 3: Refactor Crawl Worker to Thin Wrapper

**Files:**

- Modify: `packages/queue/src/workers/crawl-worker.ts`

- [ ] **Step 1: Replace crawl worker with thin wrapper**

```typescript
// packages/queue/src/workers/crawl-worker.ts
import { createLoggerWithContext } from '@spatula/shared';
import { processCrawlTask, shouldTriggerSchemaEvolution, isValidCrawlUrl } from '@spatula/core';
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
```

- [ ] **Step 2: Run existing crawl worker tests to verify no behavior change**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run crawl-worker`
Expected: Most tests PASS. Some may need mock adjustments (see Step 3).

- [ ] **Step 3: Fix any failing tests and add wrapper-specific tests**

**Known behavior change:** The refactored wrapper guards `crawl_progress` event publishing with `if (enqueued > 0)`. The original worker published even when all discovered links were filtered out by URL validation. This is an intentional improvement — no event for zero-result enqueue. Add a test:

```typescript
it('does not publish crawl_progress when all links are filtered out', async () => {
  const deps = createMockDeps();
  // Mock orchestrator returning links that are all invalid (filtered in wrapper by isValidCrawlUrl)
  // ... verify eventPublisher.publish is NOT called with type 'crawl_progress'
});
```

**Wrapper-specific test to add:**

```typescript
it('does not throw when orchestrator throws on crawl error', async () => {
  const deps = createMockDeps();
  (deps.crawler.crawl as any).mockRejectedValue(new Error('timeout'));
  // Wrapper catches orchestrator's rethrow — must not propagate to BullMQ
  await expect(processCrawlJob(data, deps)).resolves.toBeUndefined();
});
```

The key principle: test the WORKER's responsibility (job data parsing, queue enqueuing, error catching) not the orchestrator's logic (that's tested in Task 2). If tests assert internal orchestrator behavior (e.g., `deps.contentStore.store` was called), they still pass because the same mock objects are passed through the wrapper to the orchestrator.

- [ ] **Step 4: Run the full test suite to verify nothing is broken**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/workers/crawl-worker.ts packages/queue/tests/
git commit -m "refactor(queue): crawl worker delegates to core orchestrator"
```

---

## Task 4: Extract Schema Orchestrator

**Files:**

- Create: `packages/core/src/pipeline/schema-orchestrator.ts`
- Create: `packages/core/tests/unit/pipeline/schema-orchestrator.test.ts`

- [ ] **Step 1: Write failing tests for schema orchestrator**

Write tests following the same mock factory pattern as Task 2. Test cases: evolution disabled skips, no schema skips, no extractions skips, successful evolution returns new version, actions are persisted, event is published, no-op evolution (version unchanged) returns evolved=false.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run schema-orchestrator`
Expected: FAIL — module not found

- [ ] **Step 3: Write the schema orchestrator implementation**

```typescript
// packages/core/src/pipeline/schema-orchestrator.ts
import { createLoggerWithContext } from '@spatula/shared';
import { applySchemaActions } from '../index.js';
import type { JobConfig } from '../index.js';
import type {
  SchemaOrchestratorDeps,
  SchemaEvolutionInput,
  SchemaEvolutionResult,
} from './types.js';

/**
 * Pure schema evolution logic. No BullMQ/Redis references.
 *
 * The caller is responsible for acquiring any distributed lock
 * before calling this function (server mode uses Redis lock,
 * local mode needs no lock since it's single-process).
 */
export async function processSchemaEvolution(
  input: SchemaEvolutionInput,
  deps: SchemaOrchestratorDeps,
): Promise<SchemaEvolutionResult> {
  const { jobId, tenantId } = input;
  const logger = createLoggerWithContext('schema-orchestrator', { jobId, tenantId });

  // 1. Load job config
  const job = await deps.jobRepo.findById(jobId, tenantId);
  if (!job) {
    logger.warn({ jobId, tenantId }, 'job not found, skipping schema evolution');
    return { evolved: false, actionsApplied: 0 };
  }

  const config = job.config as JobConfig;
  if (!config.schema.evolutionConfig?.enabled) {
    logger.debug({ jobId }, 'schema evolution not enabled, skipping');
    return { evolved: false, actionsApplied: 0 };
  }

  // 2. Load current schema
  const currentSchema = await deps.schemaRepo.findLatest(jobId, tenantId);
  if (!currentSchema) {
    logger.debug({ jobId }, 'no schema found, skipping evolution');
    return { evolved: false, actionsApplied: 0 };
  }

  // 3. Fetch recent extractions
  const batchSize = config.schema.evolutionConfig.batchSize ?? 10;
  const extractions = await deps.extractionRepo.findByJob(jobId, tenantId, { limit: batchSize });
  if (extractions.length === 0) {
    logger.debug({ jobId }, 'no extractions found, skipping evolution');
    return { evolved: false, actionsApplied: 0 };
  }

  // 4. Map DB rows to ExtractionResult shape
  const extractionResults = extractions.map((e) => ({
    id: e.id,
    jobId: e.jobId,
    pageId: e.pageId,
    schemaVersion: e.schemaVersion,
    data: e.data as Record<string, unknown>,
    metadata: e.metadata as {
      confidence: number;
      modelUsed: string;
      tokensUsed: number;
      extractionTimeMs: number;
      unmappedFields: Array<{ name: string; value: unknown; suggestedType: string }>;
    },
  }));

  // 5. Call schema evolver
  const actions = await deps.schemaEvolver.evolve(
    currentSchema.definition,
    extractionResults,
    config.description,
  );

  if (actions.length === 0) {
    logger.debug({ jobId }, 'no evolution actions proposed');
    return { evolved: false, actionsApplied: 0 };
  }

  // 6. Stamp jobId on all actions
  for (const action of actions) {
    action.jobId = jobId;
  }

  // 7. Persist each action to the audit log
  for (const action of actions) {
    await deps.actionRepo.create({
      jobId,
      tenantId,
      type: action.type,
      payload: 'payload' in action ? (action as any).payload : {},
      source: action.source ?? 'schema_evolution',
      status: 'applied',
      confidence: action.confidence,
      reasoning: action.reasoning,
    });
  }

  // 8. Apply actions to create new schema version
  const evolvedSchema = applySchemaActions(currentSchema.definition, actions);
  if (evolvedSchema.version === currentSchema.definition.version) {
    logger.debug({ jobId }, 'no effective schema changes after applying actions');
    return { evolved: false, actionsApplied: 0 };
  }

  // 9. Persist new schema version
  await deps.schemaRepo.create({
    jobId,
    tenantId,
    version: evolvedSchema.version,
    definition: evolvedSchema,
    parentId: currentSchema.id,
  });

  logger.info(
    { jobId, newVersion: evolvedSchema.version, actionsApplied: actions.length },
    'schema evolved',
  );

  // 10. Publish event
  await deps.eventPublisher?.publish(jobId, {
    type: 'schema_evolved',
    jobId,
    tenantId,
    data: {
      version: evolvedSchema.version,
      fieldsAdded: actions
        .filter((a) => a.type === 'add_field')
        .map((a) => (a as any).payload?.name ?? ''),
      fieldsMerged: actions
        .filter((a) => a.type === 'merge_fields')
        .map((a) => (a as any).payload?.canonicalName ?? ''),
    },
  });

  return {
    evolved: true,
    newVersion: evolvedSchema.version,
    actionsApplied: actions.length,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run schema-orchestrator`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline/schema-orchestrator.ts packages/core/tests/unit/pipeline/schema-orchestrator.test.ts
git commit -m "feat(core): add schema evolution orchestrator"
```

---

## Task 5: Refactor Schema Worker to Thin Wrapper

**Files:**

- Modify: `packages/queue/src/workers/schema-worker.ts`

- [ ] **Step 1: Replace schema worker with thin wrapper**

The worker retains ONLY the Redis lock acquisition/release (queue-specific concern). All business logic delegates to `processSchemaEvolution()`.

```typescript
// packages/queue/src/workers/schema-worker.ts
import { createLoggerWithContext } from '@spatula/shared';
import { processSchemaEvolution } from '@spatula/core';
import type Redis from 'ioredis';
import type { SchemaEvolutionJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';
import { acquireLock, releaseLock } from '../redis-lock.js';

export async function processSchemaEvolutionJob(
  data: SchemaEvolutionJobData,
  deps: WorkerDeps,
  redis?: Redis,
): Promise<void> {
  const logger = createLoggerWithContext('schema-worker', {
    jobId: data.jobId,
    tenantId: data.tenantId,
  });
  const lockKey = `schema-lock:${data.jobId}`;
  let lockToken = '';

  // Acquire distributed lock (queue-specific concern)
  if (redis) {
    const lock = await acquireLock(redis, lockKey, 30);
    if (!lock.acquired) {
      logger.debug({ jobId: data.jobId }, 'could not acquire schema evolution lock, skipping');
      return;
    }
    lockToken = lock.token;
  }

  try {
    await processSchemaEvolution(
      { jobId: data.jobId, tenantId: data.tenantId, extractionIds: data.extractionIds },
      {
        schemaEvolver: deps.schemaEvolver,
        jobRepo: deps.jobRepo,
        extractionRepo: deps.extractionRepo,
        schemaRepo: deps.schemaRepo,
        actionRepo: deps.actionRepo,
        eventPublisher: deps.eventPublisher,
      },
    );
  } catch (error) {
    logger.error({ jobId: data.jobId, error }, 'schema evolution job failed');
  } finally {
    if (redis && lockToken) {
      await releaseLock(redis, lockKey, lockToken);
    }
  }
}
```

- [ ] **Step 2: Run existing schema worker tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run schema-worker`
Expected: All tests PASS (adjust mocks if needed)

- [ ] **Step 3: Commit**

```bash
git add packages/queue/src/workers/schema-worker.ts packages/queue/tests/
git commit -m "refactor(queue): schema worker delegates to core orchestrator"
```

---

## Task 6: Extract Reconciliation Orchestrator + Refactor Worker

**Files:**

- Create: `packages/core/src/pipeline/reconcile-orchestrator.ts`
- Create: `packages/core/tests/unit/pipeline/reconcile-orchestrator.test.ts`
- Modify: `packages/queue/src/workers/reconciliation-worker.ts`

- [ ] **Step 1: Write the reconciliation orchestrator**

Extract all logic from `processReconciliationJob` into `processReconciliation()`. The orchestrator handles: job/schema/extraction loading, page metadata enrichment, reconciliation execution, entity persistence with source links, source trust persistence, job status update, event publishing.

The worker wrapper becomes a one-liner that maps `WorkerDeps` to `ReconcileOrchestratorDeps` and calls `processReconciliation()`.

- [ ] **Step 2: Write tests for reconciliation orchestrator**

Test cases: job not found skips, no schema skips, no extractions completes job, successful reconciliation creates entities and links sources, source trust is persisted, job status updated to completed, event published, error marks job as failed.

**Mock guidance:** Reference `packages/queue/tests/unit/workers/reconciliation-worker.test.ts` for mock shapes. Key detail: `pageRepo.findByIds` must return pages with `metadata: { url: 'https://...' }` and `createdAt: Date` so the enrichment path (`sourceUrl`, `sourceDomain`, `crawledAt` on `ExtractionWithSource`) is exercised. The `reconciler.reconcile` mock must return `{ entities: [...], actions: [...] }` with entity objects containing `mergedData`, `fieldProvenance`, and `sourceExtractions: [{ extractionId: '...' }]`.

- [ ] **Step 3: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run reconcile-orchestrator`
Expected: All tests PASS

- [ ] **Step 4: Refactor reconciliation worker to thin wrapper**

Worker retains only the `WorkerDeps` to `ReconcileOrchestratorDeps` mapping and error catching.

- [ ] **Step 5: Run existing reconciliation worker tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run reconciliation-worker`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pipeline/reconcile-orchestrator.ts packages/core/tests/unit/pipeline/reconcile-orchestrator.test.ts packages/queue/src/workers/reconciliation-worker.ts packages/queue/tests/
git commit -m "feat(core): add reconciliation orchestrator, refactor worker to wrapper"
```

---

## Task 7: Extract Export Orchestrator + Refactor Worker

**Files:**

- Create: `packages/core/src/pipeline/export-orchestrator.ts`
- Create: `packages/core/tests/unit/pipeline/export-orchestrator.test.ts`
- Modify: `packages/queue/src/workers/export-worker.ts`

- [ ] **Step 1: Write the export orchestrator**

Extract all logic from `processExportJob` into `processExport()`. The orchestrator handles: job status validation, schema fetching, entity count check (MAX_EXPORT_ENTITIES), batched entity fetching, documentation generation, exporter selection + execution, content storage (binary or text), export status updates.

The `getExporter()` helper function moves to the orchestrator (it has no queue dependencies).

- [ ] **Step 2: Write tests for export orchestrator**

Test cases: job not found throws, job not completed throws, entity count exceeds max throws, JSON export with documentation, CSV export, binary format (sqlite) stores via storeBinary, status updated to processing then completed, error marks as failed.

**Mock guidance:** Reference `packages/queue/tests/unit/workers/export-worker.test.ts` for mock shapes. Key detail: `generateDocumentation` is imported from `@spatula/core` — mock it via `vi.mock()` at the module level. The JSON export path constructs an envelope with `metadata`, `schema`, `documentation`, `entities` — test that the envelope structure is correct. Binary exports (parquet, sqlite, duckdb) return `result.binaryData` as `Uint8Array` — test that `contentStore.storeBinary` is called instead of `contentStore.store`.

- [ ] **Step 3: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run export-orchestrator`
Expected: All tests PASS

- [ ] **Step 4: Refactor export worker to thin wrapper**

Worker becomes a simple delegation with error catching.

- [ ] **Step 5: Run existing export worker tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run export-worker`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pipeline/export-orchestrator.ts packages/core/tests/unit/pipeline/export-orchestrator.test.ts packages/queue/src/workers/export-worker.ts packages/queue/tests/
git commit -m "feat(core): add export orchestrator, refactor worker to wrapper"
```

---

## Task 8: Full Integration Verification

**Files:**

- No new files — verification only

- [ ] **Step 1: Run complete core package tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run`
Expected: All tests PASS (existing + new orchestrator tests)

- [ ] **Step 2: Run complete queue package tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All tests PASS (existing worker tests work with refactored wrappers)

- [ ] **Step 3: Run full monorepo build**

Run: `cd /Users/salar/Projects/spatula && pnpm run build`
Expected: All packages build successfully

- [ ] **Step 4: Run full monorepo test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm run test`
Expected: All tests across all packages PASS

- [ ] **Step 5: Run E2E tests if available**

Run: `cd /Users/salar/Projects/spatula && pnpm run test:e2e`
Expected: All E2E tests PASS

- [ ] **Step 6: Final commit with verification note**

```bash
git add -A
git commit -m "test: verify orchestrator extraction — all tests passing

All 4 workers refactored to thin wrappers delegating to pure
orchestrator functions in @spatula/core/pipeline. Zero behavior
change confirmed by full test suite passing."
```
