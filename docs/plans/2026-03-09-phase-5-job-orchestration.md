# Phase 5: Job Orchestration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire together Phases 2-4 (Crawler, LLM/Extraction, Storage) into a unified job execution pipeline using BullMQ queues, a job state machine, and worker implementations.

**Architecture:** BullMQ manages three queues (crawl, extract, schema-evolution) with tenant-scoped concurrency. A `JobManager` implements the `JobOrchestrator` interface as the entry point — it validates config, persists the job, seeds the crawl queue, and tracks progress. Workers are stateless processors that pull from queues, call the appropriate core interfaces (Crawler, Extractor), and store results via repositories. A `JobStateMachine` enforces valid state transitions. The pipeline flow for each URL: crawl → classify → extract → store → enqueue links.

**Tech Stack:** BullMQ + ioredis, existing core interfaces (Crawler, Extractor, PageClassifier), existing db repositories (JobRepository, CrawlTaskRepository, etc.)

---

## Prerequisites

- Phase 1-4 complete (core types, crawlers, extraction, storage layer)
- Redis available locally (or via Docker) for BullMQ
- `packages/queue` scaffolded with `@spatula/shared` and `@spatula/core` workspace deps

## Package Layout

```
packages/queue/
├── src/
│   ├── state-machine.ts         # Job state machine with valid transitions
│   ├── job-manager.ts           # JobOrchestrator implementation
│   ├── queues.ts                # BullMQ queue factory
│   ├── workers/
│   │   ├── crawl-worker.ts      # Crawl → classify → extract → store pipeline
│   │   └── schema-worker.ts     # Batched schema evolution (stub for Phase 6)
│   ├── worker-deps.ts           # Dependency container for workers
│   └── index.ts                 # Package barrel
├── tests/
│   ├── unit/
│   │   ├── state-machine.test.ts
│   │   ├── job-manager.test.ts
│   │   ├── queues.test.ts
│   │   └── workers/
│   │       ├── crawl-worker.test.ts
│   │       └── schema-worker.test.ts
│   └── unit/
│       └── exports.test.ts
└── package.json
```

---

## Task 1: Install Dependencies

**Files:**

- Modify: `packages/queue/package.json`

**Step 1: Install BullMQ and ioredis**

Run:

```bash
cd packages/queue && pnpm add bullmq ioredis && pnpm add -D @types/ioredis
```

Verify `package.json` has:

```json
{
  "dependencies": {
    "@spatula/shared": "workspace:*",
    "@spatula/core": "workspace:*",
    "@spatula/db": "workspace:*",
    "bullmq": "^5.0.0",
    "ioredis": "^5.0.0"
  }
}
```

Note: Also add `@spatula/db` as a workspace dependency since workers need repositories.

**Step 2: Verify install**

Run: `pnpm install && pnpm build`

**Step 3: Commit**

```bash
git add packages/queue/package.json pnpm-lock.yaml
git commit -m "feat(queue): add BullMQ, ioredis, and @spatula/db dependencies"
```

---

## Task 2: Job State Machine

**Files:**

- Create: `packages/queue/src/state-machine.ts`
- Create: `packages/queue/tests/unit/state-machine.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/queue/tests/unit/state-machine.test.ts
import { describe, it, expect } from 'vitest';
import { JobStateMachine, InvalidTransitionError } from '../../src/state-machine.js';

describe('JobStateMachine', () => {
  it('allows pending → queued', () => {
    expect(JobStateMachine.transition('pending', 'queued')).toBe('queued');
  });

  it('allows queued → running', () => {
    expect(JobStateMachine.transition('queued', 'running')).toBe('running');
  });

  it('allows running → paused', () => {
    expect(JobStateMachine.transition('running', 'paused')).toBe('paused');
  });

  it('allows paused → running (resume)', () => {
    expect(JobStateMachine.transition('paused', 'running')).toBe('running');
  });

  it('allows running → reconciling', () => {
    expect(JobStateMachine.transition('running', 'reconciling')).toBe('reconciling');
  });

  it('allows reconciling → completed', () => {
    expect(JobStateMachine.transition('reconciling', 'completed')).toBe('completed');
  });

  it('allows running → failed', () => {
    expect(JobStateMachine.transition('running', 'failed')).toBe('failed');
  });

  it('allows running → cancelled', () => {
    expect(JobStateMachine.transition('running', 'cancelled')).toBe('cancelled');
  });

  it('allows paused → cancelled', () => {
    expect(JobStateMachine.transition('paused', 'cancelled')).toBe('cancelled');
  });

  it('rejects invalid transitions', () => {
    expect(() => JobStateMachine.transition('pending', 'completed')).toThrow(
      InvalidTransitionError,
    );
  });

  it('rejects transitions from terminal states', () => {
    expect(() => JobStateMachine.transition('completed', 'running')).toThrow(
      InvalidTransitionError,
    );
    expect(() => JobStateMachine.transition('failed', 'running')).toThrow(InvalidTransitionError);
    expect(() => JobStateMachine.transition('cancelled', 'running')).toThrow(
      InvalidTransitionError,
    );
  });

  it('canTransition returns boolean', () => {
    expect(JobStateMachine.canTransition('pending', 'queued')).toBe(true);
    expect(JobStateMachine.canTransition('pending', 'completed')).toBe(false);
  });

  it('getValidTransitions returns allowed next states', () => {
    const from_running = JobStateMachine.getValidTransitions('running');
    expect(from_running).toContain('paused');
    expect(from_running).toContain('reconciling');
    expect(from_running).toContain('failed');
    expect(from_running).toContain('cancelled');
    expect(from_running).not.toContain('pending');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/queue && npx vitest run tests/unit/state-machine.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// packages/queue/src/state-machine.ts
import type { JobStatus } from '@spatula/core';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    super(`Invalid job state transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

const TRANSITIONS: Record<string, JobStatus[]> = {
  pending: ['queued'],
  queued: ['running', 'cancelled'],
  running: ['paused', 'reconciling', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  reconciling: ['completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const JobStateMachine = {
  transition(from: JobStatus, to: JobStatus): JobStatus {
    const allowed = TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new InvalidTransitionError(from, to);
    }
    return to;
  },

  canTransition(from: JobStatus, to: JobStatus): boolean {
    const allowed = TRANSITIONS[from];
    return !!allowed && allowed.includes(to);
  },

  getValidTransitions(from: JobStatus): JobStatus[] {
    return TRANSITIONS[from] ?? [];
  },
};
```

**Step 4: Run tests**

Run: `cd packages/queue && npx vitest run tests/unit/state-machine.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/queue/src/state-machine.ts packages/queue/tests/unit/state-machine.test.ts
git commit -m "feat(queue): add job state machine with valid transitions"
```

---

## Task 3: Queue Factory

**Files:**

- Create: `packages/queue/src/queues.ts`
- Create: `packages/queue/tests/unit/queues.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/queue/tests/unit/queues.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name, opts) => ({
    name,
    opts,
    add: vi.fn(),
    close: vi.fn(),
  })),
}));

import { createQueues, QUEUE_NAMES } from '../../src/queues.js';

describe('Queue Factory', () => {
  it('exports queue name constants', () => {
    expect(QUEUE_NAMES.CRAWL).toBe('spatula:crawl');
    expect(QUEUE_NAMES.EXTRACT).toBe('spatula:extract');
    expect(QUEUE_NAMES.SCHEMA_EVOLUTION).toBe('spatula:schema-evolution');
  });

  it('creates all three queues', () => {
    const queues = createQueues({ host: 'localhost', port: 6379 });
    expect(queues.crawl).toBeDefined();
    expect(queues.extract).toBeDefined();
    expect(queues.schemaEvolution).toBeDefined();
  });

  it('passes Redis connection to queues', () => {
    const connection = { host: 'localhost', port: 6379 };
    const queues = createQueues(connection);
    expect(queues.crawl.opts.connection).toEqual(connection);
  });

  it('closeAll closes all queues', async () => {
    const queues = createQueues({ host: 'localhost', port: 6379 });
    await queues.closeAll();
    expect(queues.crawl.close).toHaveBeenCalled();
    expect(queues.extract.close).toHaveBeenCalled();
    expect(queues.schemaEvolution.close).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/queue && npx vitest run tests/unit/queues.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// packages/queue/src/queues.ts
import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';

export const QUEUE_NAMES = {
  CRAWL: 'spatula:crawl',
  EXTRACT: 'spatula:extract',
  SCHEMA_EVOLUTION: 'spatula:schema-evolution',
} as const;

export interface CrawlJobData {
  taskId: string;
  jobId: string;
  tenantId: string;
  url: string;
  depth: number;
}

export interface ExtractJobData {
  taskId: string;
  jobId: string;
  tenantId: string;
  pageId: string;
  contentRef: string;
  url: string;
}

export interface SchemaEvolutionJobData {
  jobId: string;
  tenantId: string;
  extractionIds: string[];
}

export interface SpatulaQueues {
  crawl: Queue<CrawlJobData>;
  extract: Queue<ExtractJobData>;
  schemaEvolution: Queue<SchemaEvolutionJobData>;
  closeAll(): Promise<void>;
}

export function createQueues(connection: ConnectionOptions): SpatulaQueues {
  const crawl = new Queue<CrawlJobData>(QUEUE_NAMES.CRAWL, { connection });
  const extract = new Queue<ExtractJobData>(QUEUE_NAMES.EXTRACT, { connection });
  const schemaEvolution = new Queue<SchemaEvolutionJobData>(QUEUE_NAMES.SCHEMA_EVOLUTION, {
    connection,
  });

  return {
    crawl,
    extract,
    schemaEvolution,
    async closeAll() {
      await Promise.all([crawl.close(), extract.close(), schemaEvolution.close()]);
    },
  };
}
```

**Step 4: Run tests**

Run: `cd packages/queue && npx vitest run tests/unit/queues.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/queue/src/queues.ts packages/queue/tests/unit/queues.test.ts
git commit -m "feat(queue): add BullMQ queue factory with typed job data"
```

---

## Task 4: Worker Dependencies Container

**Files:**

- Create: `packages/queue/src/worker-deps.ts`
- Create: `packages/queue/tests/unit/worker-deps.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/queue/tests/unit/worker-deps.test.ts
import { describe, it, expect, vi } from 'vitest';
import { WorkerDeps } from '../../src/worker-deps.js';

describe('WorkerDeps', () => {
  it('stores all injected dependencies', () => {
    const deps = new WorkerDeps({
      crawler: { type: 'playwright', crawl: vi.fn(), close: vi.fn() } as any,
      extractor: { extract: vi.fn() } as any,
      classifier: { classify: vi.fn() } as any,
      contentStore: { store: vi.fn(), retrieve: vi.fn(), delete: vi.fn() } as any,
      jobRepo: {} as any,
      taskRepo: {} as any,
      pageRepo: {} as any,
      extractionRepo: {} as any,
      schemaRepo: {} as any,
      queues: { crawl: {}, extract: {}, schemaEvolution: {}, closeAll: vi.fn() } as any,
    });

    expect(deps.crawler).toBeDefined();
    expect(deps.extractor).toBeDefined();
    expect(deps.classifier).toBeDefined();
    expect(deps.contentStore).toBeDefined();
    expect(deps.jobRepo).toBeDefined();
    expect(deps.taskRepo).toBeDefined();
    expect(deps.pageRepo).toBeDefined();
    expect(deps.extractionRepo).toBeDefined();
    expect(deps.schemaRepo).toBeDefined();
    expect(deps.queues).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/queue && npx vitest run tests/unit/worker-deps.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// packages/queue/src/worker-deps.ts
import type { Crawler, Extractor, ContentStore } from '@spatula/core';
import type { PageClassifier } from '@spatula/core';
import type {
  JobRepository,
  CrawlTaskRepository,
  PageRepository,
  ExtractionRepository,
  SchemaRepository,
} from '@spatula/db';
import type { SpatulaQueues } from './queues.js';

export interface WorkerDepsConfig {
  crawler: Crawler;
  extractor: Extractor;
  classifier: PageClassifier;
  contentStore: ContentStore;
  jobRepo: JobRepository;
  taskRepo: CrawlTaskRepository;
  pageRepo: PageRepository;
  extractionRepo: ExtractionRepository;
  schemaRepo: SchemaRepository;
  queues: SpatulaQueues;
}

export class WorkerDeps {
  readonly crawler: Crawler;
  readonly extractor: Extractor;
  readonly classifier: PageClassifier;
  readonly contentStore: ContentStore;
  readonly jobRepo: JobRepository;
  readonly taskRepo: CrawlTaskRepository;
  readonly pageRepo: PageRepository;
  readonly extractionRepo: ExtractionRepository;
  readonly schemaRepo: SchemaRepository;
  readonly queues: SpatulaQueues;

  constructor(config: WorkerDepsConfig) {
    this.crawler = config.crawler;
    this.extractor = config.extractor;
    this.classifier = config.classifier;
    this.contentStore = config.contentStore;
    this.jobRepo = config.jobRepo;
    this.taskRepo = config.taskRepo;
    this.pageRepo = config.pageRepo;
    this.extractionRepo = config.extractionRepo;
    this.schemaRepo = config.schemaRepo;
    this.queues = config.queues;
  }
}
```

**Step 4: Run tests**

Run: `cd packages/queue && npx vitest run tests/unit/worker-deps.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/queue/src/worker-deps.ts packages/queue/tests/unit/worker-deps.test.ts
git commit -m "feat(queue): add WorkerDeps dependency container"
```

---

## Task 5: Crawl Worker

**Files:**

- Create: `packages/queue/src/workers/crawl-worker.ts`
- Create: `packages/queue/tests/unit/workers/crawl-worker.test.ts`

This is the core pipeline worker. For each crawl task it:

1. Fetches the page via Crawler
2. Stores raw HTML via ContentStore
3. Creates a raw_pages record
4. Classifies the page via PageClassifier
5. If relevant: extracts data via Extractor, stores extraction
6. Enqueues discovered links (if within depth/page limits)

**Step 1: Write the failing test**

```typescript
// packages/queue/tests/unit/workers/crawl-worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processCrawlJob } from '../../../src/workers/crawl-worker.js';

function createMockDeps() {
  return {
    crawler: {
      type: 'playwright' as const,
      crawl: vi.fn().mockResolvedValue({
        url: 'https://example.com/product',
        html: '<html><body>Product</body></html>',
        title: 'Product Page',
        statusCode: 200,
        contentType: 'text/html',
        links: [{ url: 'https://example.com/product-2', text: 'Next Product' }],
        metadata: {
          crawledAt: new Date(),
          responseTimeMs: 150,
          contentLength: 1000,
          crawlerType: 'playwright',
        },
      }),
      close: vi.fn(),
    },
    contentStore: {
      store: vi.fn().mockResolvedValue('pg://content-1'),
      retrieve: vi.fn(),
      delete: vi.fn(),
    },
    classifier: {
      classify: vi.fn().mockResolvedValue({
        classification: 'single_entry',
        confidence: 0.95,
        strategy: 'full_extraction',
        reasoning: 'Product detail page',
      }),
    },
    extractor: {
      extract: vi.fn().mockResolvedValue({
        id: 'ext-1',
        jobId: 'job-1',
        pageId: 'page-1',
        schemaVersion: 1,
        data: { name: 'Product' },
        metadata: {
          confidence: 0.9,
          modelUsed: 'test-model',
          tokensUsed: 100,
          extractionTimeMs: 50,
          unmappedFields: [],
        },
      }),
    },
    taskRepo: {
      updateStatus: vi.fn().mockResolvedValue({ id: 'task-1' }),
      updateClassification: vi.fn().mockResolvedValue({ id: 'task-1' }),
    },
    pageRepo: {
      create: vi.fn().mockResolvedValue({ id: 'page-1' }),
      findByContentHash: vi.fn().mockResolvedValue(null),
    },
    extractionRepo: {
      store: vi.fn().mockResolvedValue({ id: 'ext-1' }),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        id: 'schema-1',
        version: 1,
        definition: {
          version: 1,
          fields: [],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      }),
    },
    jobRepo: {
      findById: vi.fn().mockResolvedValue({
        id: 'job-1',
        tenantId: 'tenant-1',
        config: {
          tenantId: 'tenant-1',
          name: 'Test Job',
          description: 'Find products',
          seedUrls: ['https://example.com'],
          crawl: { maxDepth: 2, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
          schema: { mode: 'discovery' },
          llm: { primaryModel: 'test' },
        },
        status: 'running',
      }),
      updateStats: vi.fn().mockResolvedValue({}),
    },
    queues: {
      crawl: { add: vi.fn() },
      extract: { add: vi.fn() },
      schemaEvolution: { add: vi.fn() },
      closeAll: vi.fn(),
    },
  };
}

describe('processCrawlJob', () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('crawls the URL and stores content', async () => {
    await processCrawlJob(
      {
        taskId: 'task-1',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product',
        depth: 0,
      },
      deps as any,
    );

    expect(deps.crawler.crawl).toHaveBeenCalledWith('https://example.com/product', undefined);
    expect(deps.contentStore.store).toHaveBeenCalled();
    expect(deps.pageRepo.create).toHaveBeenCalled();
  });

  it('classifies the page', async () => {
    await processCrawlJob(
      {
        taskId: 'task-1',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product',
        depth: 0,
      },
      deps as any,
    );

    expect(deps.classifier.classify).toHaveBeenCalled();
    expect(deps.taskRepo.updateClassification).toHaveBeenCalled();
  });

  it('extracts data for relevant pages', async () => {
    await processCrawlJob(
      {
        taskId: 'task-1',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product',
        depth: 0,
      },
      deps as any,
    );

    expect(deps.extractor.extract).toHaveBeenCalled();
    expect(deps.extractionRepo.store).toHaveBeenCalled();
  });

  it('skips extraction for irrelevant pages', async () => {
    deps.classifier.classify.mockResolvedValue({
      classification: 'irrelevant',
      confidence: 0.95,
      strategy: 'skip',
      reasoning: 'Not relevant',
    });

    await processCrawlJob(
      {
        taskId: 'task-1',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product',
        depth: 0,
      },
      deps as any,
    );

    expect(deps.extractor.extract).not.toHaveBeenCalled();
    expect(deps.extractionRepo.store).not.toHaveBeenCalled();
  });

  it('enqueues discovered links within depth limit', async () => {
    await processCrawlJob(
      {
        taskId: 'task-1',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product',
        depth: 0,
      },
      deps as any,
    );

    expect(deps.queues.crawl.add).toHaveBeenCalled();
  });

  it('does not enqueue links at max depth', async () => {
    deps.jobRepo.findById.mockResolvedValue({
      id: 'job-1',
      tenantId: 'tenant-1',
      config: {
        tenantId: 'tenant-1',
        name: 'Test',
        description: 'Test',
        seedUrls: ['https://example.com'],
        crawl: { maxDepth: 1, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
        schema: { mode: 'discovery' },
        llm: { primaryModel: 'test' },
      },
      status: 'running',
    });

    await processCrawlJob(
      {
        taskId: 'task-1',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product',
        depth: 1,
      },
      deps as any,
    );

    expect(deps.queues.crawl.add).not.toHaveBeenCalled();
  });

  it('marks task as completed on success', async () => {
    await processCrawlJob(
      {
        taskId: 'task-1',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product',
        depth: 0,
      },
      deps as any,
    );

    expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith('task-1', 'tenant-1', 'completed');
  });

  it('marks task as failed on error', async () => {
    deps.crawler.crawl.mockRejectedValue(new Error('Connection refused'));

    await processCrawlJob(
      {
        taskId: 'task-1',
        jobId: 'job-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/product',
        depth: 0,
      },
      deps as any,
    );

    expect(deps.taskRepo.updateStatus).toHaveBeenCalledWith('task-1', 'tenant-1', 'failed');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/queue && npx vitest run tests/unit/workers/crawl-worker.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// packages/queue/src/workers/crawl-worker.ts
import { createLogger } from '@spatula/shared';
import { createHash } from 'node:crypto';
import type { CrawlJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('crawl-worker');

const EXTRACTABLE_CLASSIFICATIONS = new Set(['single_entry', 'multiple_entries', 'partial']);

export async function processCrawlJob(data: CrawlJobData, deps: WorkerDeps): Promise<void> {
  const { taskId, jobId, tenantId, url, depth } = data;

  try {
    // Mark task as in_progress
    await deps.taskRepo.updateStatus(taskId, tenantId, 'in_progress');

    // 1. Fetch the page
    const crawlResult = await deps.crawler.crawl(url);
    logger.debug({ taskId, url, statusCode: crawlResult.statusCode }, 'page crawled');

    // 2. Store raw HTML
    const contentHash = createHash('sha256').update(crawlResult.html).digest('hex');
    const contentRef = await deps.contentStore.store(`${jobId}/${contentHash}`, crawlResult.html);

    // 3. Create raw_pages record (dedup check)
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

    // 4. Classify the page
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

    // 5. Extract data if page is relevant
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
        logger.debug({ taskId, extractionId: extraction.id }, 'extraction stored');
      }
    }

    // 6. Enqueue discovered links (within depth limit)
    const maxDepth = job.config.crawl.maxDepth;
    if (depth < maxDepth && crawlResult.links.length > 0) {
      for (const link of crawlResult.links) {
        if (link.url && link.url.startsWith('http')) {
          await deps.queues.crawl.add(`crawl:${link.url}`, {
            taskId: '', // will be assigned when enqueued via taskRepo
            jobId,
            tenantId,
            url: link.url,
            depth: depth + 1,
          });
        }
      }
      logger.debug({ taskId, linksEnqueued: crawlResult.links.length }, 'links enqueued');
    }

    // 7. Mark task as completed
    await deps.taskRepo.updateStatus(taskId, tenantId, 'completed');
  } catch (error) {
    logger.error({ taskId, url, error }, 'crawl job failed');
    await deps.taskRepo.updateStatus(taskId, tenantId, 'failed').catch((e) => {
      logger.error({ taskId, error: e }, 'failed to mark task as failed');
    });
  }
}
```

**Step 4: Run tests**

Run: `cd packages/queue && npx vitest run tests/unit/workers/crawl-worker.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/queue/src/workers/crawl-worker.ts packages/queue/tests/unit/workers/crawl-worker.test.ts
git commit -m "feat(queue): add crawl worker with full pipeline (crawl → classify → extract → store)"
```

---

## Task 6: Schema Evolution Worker (Stub)

**Files:**

- Create: `packages/queue/src/workers/schema-worker.ts`
- Create: `packages/queue/tests/unit/workers/schema-worker.test.ts`

The schema evolution logic is Phase 6. This task creates the worker shell that receives batched extraction IDs and delegates to a SchemaEvolver interface.

**Step 1: Write the failing test**

```typescript
// packages/queue/tests/unit/workers/schema-worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processSchemaEvolutionJob } from '../../../src/workers/schema-worker.js';

describe('processSchemaEvolutionJob', () => {
  it('is a function', () => {
    expect(typeof processSchemaEvolutionJob).toBe('function');
  });

  it('logs a stub message and returns without error', async () => {
    await expect(
      processSchemaEvolutionJob(
        { jobId: 'job-1', tenantId: 'tenant-1', extractionIds: ['ext-1'] },
        {} as any,
      ),
    ).resolves.toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/queue && npx vitest run tests/unit/workers/schema-worker.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// packages/queue/src/workers/schema-worker.ts
import { createLogger } from '@spatula/shared';
import type { SchemaEvolutionJobData } from '../queues.js';
import type { WorkerDeps } from '../worker-deps.js';

const logger = createLogger('schema-worker');

export async function processSchemaEvolutionJob(
  data: SchemaEvolutionJobData,
  _deps: WorkerDeps,
): Promise<void> {
  logger.info(
    { jobId: data.jobId, extractionCount: data.extractionIds.length },
    'schema evolution job received — implementation in Phase 6',
  );
}
```

**Step 4: Run tests**

Run: `cd packages/queue && npx vitest run tests/unit/workers/schema-worker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/queue/src/workers/schema-worker.ts packages/queue/tests/unit/workers/schema-worker.test.ts
git commit -m "feat(queue): add schema evolution worker stub (Phase 6)"
```

---

## Task 7: Job Manager

**Files:**

- Create: `packages/queue/src/job-manager.ts`
- Create: `packages/queue/tests/unit/job-manager.test.ts`

The `JobManager` implements the `JobOrchestrator` interface. It validates job config, persists to DB, seeds the crawl queue with seed URLs, and manages pause/resume/cancel.

**Step 1: Write the failing test**

```typescript
// packages/queue/tests/unit/job-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobManager } from '../../src/job-manager.js';
import { InvalidTransitionError } from '../../src/state-machine.js';

function createMockJobRepo() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }),
    findById: vi.fn().mockResolvedValue({ id: 'job-1', status: 'pending', tenantId: 'tenant-1' }),
    updateStatus: vi
      .fn()
      .mockImplementation((_id, _tid, status) => Promise.resolve({ id: 'job-1', status })),
    updateStats: vi.fn(),
    findByTenant: vi.fn(),
  };
}

function createMockTaskRepo() {
  return {
    enqueue: vi.fn().mockResolvedValue({ id: 'task-1' }),
    findByJob: vi.fn(),
    updateStatus: vi.fn(),
    updateClassification: vi.fn(),
  };
}

function createMockSchemaRepo() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'schema-1', version: 1 }),
    findLatest: vi.fn(),
    findByVersion: vi.fn(),
    findAllVersions: vi.fn(),
  };
}

function createMockQueues() {
  return {
    crawl: { add: vi.fn() },
    extract: { add: vi.fn() },
    schemaEvolution: { add: vi.fn() },
    closeAll: vi.fn(),
  };
}

describe('JobManager', () => {
  let manager: JobManager;
  let jobRepo: ReturnType<typeof createMockJobRepo>;
  let taskRepo: ReturnType<typeof createMockTaskRepo>;
  let schemaRepo: ReturnType<typeof createMockSchemaRepo>;
  let queues: ReturnType<typeof createMockQueues>;

  beforeEach(() => {
    jobRepo = createMockJobRepo();
    taskRepo = createMockTaskRepo();
    schemaRepo = createMockSchemaRepo();
    queues = createMockQueues();
    manager = new JobManager({
      jobRepo: jobRepo as any,
      taskRepo: taskRepo as any,
      schemaRepo: schemaRepo as any,
      queues: queues as any,
    });
  });

  it('creates a job and returns its id', async () => {
    const config = {
      tenantId: 'tenant-1',
      name: 'Test Job',
      description: 'Find products',
      seedUrls: ['https://example.com'],
      schema: { mode: 'discovery' as const },
    };

    const jobId = await manager.createJob(config as any);
    expect(jobId).toBe('job-1');
    expect(jobRepo.create).toHaveBeenCalled();
  });

  it('starts a job: transitions to queued then running, seeds crawl queue', async () => {
    jobRepo.findById.mockResolvedValue({
      id: 'job-1',
      status: 'pending',
      tenantId: 'tenant-1',
      config: {
        tenantId: 'tenant-1',
        name: 'Test',
        description: 'Test',
        seedUrls: ['https://a.com', 'https://b.com'],
        crawl: { maxDepth: 2, maxPages: 100, concurrency: 5, crawlerType: 'playwright' },
        schema: {
          mode: 'discovery',
          userFields: [{ name: 'title', type: 'string', description: 'Title', required: true }],
        },
        llm: { primaryModel: 'test' },
      },
    });

    await manager.startJob('job-1', 'tenant-1');

    // Should transition pending → queued → running
    expect(jobRepo.updateStatus).toHaveBeenCalledWith('job-1', 'tenant-1', 'queued');
    expect(jobRepo.updateStatus).toHaveBeenCalledWith('job-1', 'tenant-1', 'running');

    // Should create initial schema version
    expect(schemaRepo.create).toHaveBeenCalled();

    // Should enqueue seed URLs as crawl tasks
    expect(taskRepo.enqueue).toHaveBeenCalledTimes(2);

    // Should add crawl jobs to queue
    expect(queues.crawl.add).toHaveBeenCalledTimes(2);
  });

  it('pauses a running job', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'running', tenantId: 'tenant-1' });

    await manager.pauseJob('job-1', 'tenant-1');

    expect(jobRepo.updateStatus).toHaveBeenCalledWith('job-1', 'tenant-1', 'paused');
  });

  it('resumes a paused job', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'paused', tenantId: 'tenant-1' });

    await manager.resumeJob('job-1', 'tenant-1');

    expect(jobRepo.updateStatus).toHaveBeenCalledWith('job-1', 'tenant-1', 'running');
  });

  it('cancels a running job', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'running', tenantId: 'tenant-1' });

    await manager.cancelJob('job-1', 'tenant-1');

    expect(jobRepo.updateStatus).toHaveBeenCalledWith('job-1', 'tenant-1', 'cancelled');
  });

  it('throws InvalidTransitionError for invalid state changes', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'completed', tenantId: 'tenant-1' });

    await expect(manager.pauseJob('job-1', 'tenant-1')).rejects.toThrow(InvalidTransitionError);
  });

  it('getJobStatus returns current status', async () => {
    jobRepo.findById.mockResolvedValue({ id: 'job-1', status: 'running', tenantId: 'tenant-1' });

    const status = await manager.getJobStatus('job-1', 'tenant-1');
    expect(status).toBe('running');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/queue && npx vitest run tests/unit/job-manager.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// packages/queue/src/job-manager.ts
import { createLogger, StorageError } from '@spatula/shared';
import type { JobConfig, JobStatus } from '@spatula/core';
import type { JobRepository, CrawlTaskRepository, SchemaRepository } from '@spatula/db';
import type { SpatulaQueues } from './queues.js';
import { JobStateMachine } from './state-machine.js';

const logger = createLogger('job-manager');

export interface JobManagerConfig {
  jobRepo: JobRepository;
  taskRepo: CrawlTaskRepository;
  schemaRepo: SchemaRepository;
  queues: SpatulaQueues;
}

export class JobManager {
  private readonly jobRepo: JobRepository;
  private readonly taskRepo: CrawlTaskRepository;
  private readonly schemaRepo: SchemaRepository;
  private readonly queues: SpatulaQueues;

  constructor(config: JobManagerConfig) {
    this.jobRepo = config.jobRepo;
    this.taskRepo = config.taskRepo;
    this.schemaRepo = config.schemaRepo;
    this.queues = config.queues;
  }

  async createJob(config: JobConfig): Promise<string> {
    const job = await this.jobRepo.create({
      tenantId: config.tenantId,
      config,
    });
    logger.info({ jobId: job.id }, 'job created');
    return job.id;
  }

  async startJob(jobId: string, tenantId: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);

    // Transition pending → queued → running
    JobStateMachine.transition(job.status as JobStatus, 'queued');
    await this.jobRepo.updateStatus(jobId, tenantId, 'queued');

    JobStateMachine.transition('queued', 'running');
    await this.jobRepo.updateStatus(jobId, tenantId, 'running');

    // Create initial schema version from user fields (if any)
    const initialFields = job.config.schema.userFields ?? [];
    await this.schemaRepo.create({
      jobId,
      tenantId,
      version: 1,
      definition: {
        version: 1,
        fields: initialFields,
        fieldAliases: [],
        createdAt: new Date(),
        parentVersion: null,
      },
    });

    // Enqueue seed URLs as crawl tasks
    for (const url of job.config.seedUrls) {
      const task = await this.taskRepo.enqueue({
        jobId,
        tenantId,
        url,
        depth: 0,
        priority: 'high',
      });

      await this.queues.crawl.add(`crawl:${url}`, {
        taskId: task.id,
        jobId,
        tenantId,
        url,
        depth: 0,
      });
    }

    logger.info({ jobId, seedUrls: job.config.seedUrls.length }, 'job started');
  }

  async pauseJob(jobId: string, tenantId: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    JobStateMachine.transition(job.status as JobStatus, 'paused');
    await this.jobRepo.updateStatus(jobId, tenantId, 'paused');
    logger.info({ jobId }, 'job paused');
  }

  async resumeJob(jobId: string, tenantId: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    JobStateMachine.transition(job.status as JobStatus, 'running');
    await this.jobRepo.updateStatus(jobId, tenantId, 'running');
    logger.info({ jobId }, 'job resumed');
  }

  async cancelJob(jobId: string, tenantId: string): Promise<void> {
    const job = await this.getJob(jobId, tenantId);
    JobStateMachine.transition(job.status as JobStatus, 'cancelled');
    await this.jobRepo.updateStatus(jobId, tenantId, 'cancelled');
    logger.info({ jobId }, 'job cancelled');
  }

  async getJobStatus(jobId: string, tenantId: string): Promise<JobStatus> {
    const job = await this.getJob(jobId, tenantId);
    return job.status as JobStatus;
  }

  private async getJob(jobId: string, tenantId: string) {
    const job = await this.jobRepo.findById(jobId, tenantId);
    if (!job) {
      throw new StorageError(`Job not found: ${jobId}`, {
        context: { jobId, tenantId },
      });
    }
    return job;
  }
}
```

**Step 4: Run tests**

Run: `cd packages/queue && npx vitest run tests/unit/job-manager.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/queue/src/job-manager.ts packages/queue/tests/unit/job-manager.test.ts
git commit -m "feat(queue): add JobManager implementing job lifecycle (create/start/pause/resume/cancel)"
```

---

## Task 8: Package Barrel Export

**Files:**

- Modify: `packages/queue/src/index.ts`
- Create: `packages/queue/tests/unit/exports.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/queue/tests/unit/exports.test.ts
import { describe, it, expect } from 'vitest';

describe('package exports', () => {
  it('exports JobStateMachine and InvalidTransitionError', async () => {
    const mod = await import('../../src/state-machine.js');
    expect(mod.JobStateMachine).toBeDefined();
    expect(mod.InvalidTransitionError).toBeDefined();
  });

  it('exports queue factory and names', async () => {
    const mod = await import('../../src/queues.js');
    expect(mod.createQueues).toBeDefined();
    expect(mod.QUEUE_NAMES).toBeDefined();
  });

  it('exports JobManager', async () => {
    const mod = await import('../../src/job-manager.js');
    expect(mod.JobManager).toBeDefined();
  });

  it('exports WorkerDeps', async () => {
    const mod = await import('../../src/worker-deps.js');
    expect(mod.WorkerDeps).toBeDefined();
  });

  it('exports crawl worker', async () => {
    const mod = await import('../../src/workers/crawl-worker.js');
    expect(mod.processCrawlJob).toBeDefined();
  });

  it('exports schema worker', async () => {
    const mod = await import('../../src/workers/schema-worker.js');
    expect(mod.processSchemaEvolutionJob).toBeDefined();
  });

  it('exports everything from root index', async () => {
    const root = await import('../../src/index.js');
    expect(root.JobStateMachine).toBeDefined();
    expect(root.InvalidTransitionError).toBeDefined();
    expect(root.createQueues).toBeDefined();
    expect(root.QUEUE_NAMES).toBeDefined();
    expect(root.JobManager).toBeDefined();
    expect(root.WorkerDeps).toBeDefined();
    expect(root.processCrawlJob).toBeDefined();
    expect(root.processSchemaEvolutionJob).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/queue && npx vitest run tests/unit/exports.test.ts`
Expected: FAIL — index.ts is a stub

**Step 3: Write the barrel export**

```typescript
// packages/queue/src/index.ts
// State Machine
export { JobStateMachine, InvalidTransitionError } from './state-machine.js';

// Queues
export { createQueues, QUEUE_NAMES } from './queues.js';
export type {
  CrawlJobData,
  ExtractJobData,
  SchemaEvolutionJobData,
  SpatulaQueues,
} from './queues.js';

// Job Manager
export { JobManager } from './job-manager.js';
export type { JobManagerConfig } from './job-manager.js';

// Worker Dependencies
export { WorkerDeps } from './worker-deps.js';
export type { WorkerDepsConfig } from './worker-deps.js';

// Workers
export { processCrawlJob } from './workers/crawl-worker.js';
export { processSchemaEvolutionJob } from './workers/schema-worker.js';
```

**Step 4: Run tests**

Run: `cd packages/queue && npx vitest run tests/unit/exports.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add packages/queue/src/index.ts packages/queue/tests/unit/exports.test.ts
git commit -m "feat(queue): add package barrel exports"
```

---

## Task 9: Final Verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass across all packages (shared, core, db, queue)

**Step 2: Build all packages**

Run: `pnpm build`
Expected: Clean build, no type errors

**Step 3: Lint all packages**

Run: `pnpm lint`
Expected: No errors

**Step 4: Check formatting**

Run: `pnpm format:check`
If issues: `npx prettier --write <files>`

**Step 5: Commit any formatting fixes**

```bash
git add -A
git commit -m "chore: format Phase 5 files"
```

---

## Notes

### What's Deferred to Phase 6+

- **Schema evolution logic** — The `processSchemaEvolutionJob` is a stub. Phase 6 implements the full schema analysis engine, category detection, and dynamic field discovery.
- **Link relevance scoring** — Currently enqueues all HTTP links. Phase 6+ adds AI-powered link evaluation using the fast model.
- **Rate limiting** — BullMQ supports rate limiters natively. Add per-tenant rate limiting when the API layer (Phase 8) adds tenant management.
- **Worker process startup** — The actual BullMQ `Worker` class instantiation (connecting to Redis, starting the event loop) is deferred to Phase 8 when the API server orchestrates startup.

### Key Design Decisions

1. **`processCrawlJob` is a pure function** — Takes data + deps, returns nothing. This makes it testable without Redis. The actual BullMQ `Worker` wrapper (Phase 8) will call this function.
2. **`JobManager` takes tenantId explicitly** — Rather than extracting it from JWT/session, the manager requires tenantId on every operation. The API layer handles auth.
3. **State machine is a static utility** — No instance needed, just `JobStateMachine.transition(from, to)`. Simple and testable.
4. **WorkerDeps is explicit** — All dependencies injected, no service locator pattern. Makes testing straightforward.
