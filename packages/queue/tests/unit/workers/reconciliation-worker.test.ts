import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processReconciliationJob } from '../../../src/workers/reconciliation-worker.js';
import type { ReconciliationJobData } from '../../../src/queues.js';
import type { WorkerDeps } from '../../../src/worker-deps.js';

const JOB_ID = 'job-1';
const TENANT_ID = 'tenant-1';

function createMockJob(overrides?: Record<string, unknown>) {
  return {
    id: JOB_ID,
    tenantId: TENANT_ID,
    name: 'Test Job',
    description: 'Scrape product data',
    status: 'running' as const,
    config: {
      tenantId: TENANT_ID,
      name: 'Test Job',
      description: 'Scrape product data',
      seedUrls: ['https://example.com'],
      crawl: {
        maxDepth: 3,
        maxPages: 100,
        concurrency: 5,
        crawlerType: 'playwright' as const,
      },
      schema: {
        mode: 'discovery' as const,
        evolutionConfig: {
          enabled: true,
          batchSize: 10,
          maxFields: 50,
          relevanceThresholds: {
            requiredMin: 0.85,
            optionalMin: 0.4,
            rareBelow: 0.4,
            minCategorySampleSize: 5,
          },
          tableStrategy: 'auto' as const,
        },
      },
      llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
      reconciliation: {
        matchStrategy: 'composite_key' as const,
        conflictResolution: 'most_complete' as const,
        fuzzyMatchThreshold: 0.85,
        enableLLMMatching: true,
      },
    },
    stats: {},
    schemaId: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockSchema() {
  return {
    id: 'schema-1',
    jobId: JOB_ID,
    tenantId: TENANT_ID,
    version: 1,
    definition: {
      version: 1,
      fields: [
        {
          name: 'name',
          description: 'Product name',
          type: 'string' as const,
          required: true,
        },
        {
          name: 'price',
          description: 'Product price',
          type: 'currency' as const,
          required: false,
        },
      ],
      fieldAliases: [],
      createdAt: new Date(),
      parentVersion: null,
    },
    parentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createMockExtractions() {
  return [
    {
      id: 'ext-1',
      jobId: JOB_ID,
      tenantId: TENANT_ID,
      pageId: 'page-1',
      schemaVersion: 1,
      data: { name: 'Test Product', price: '$29.99' },
      unmappedFields: [],
      metadata: {
        confidence: 0.95,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 500,
        extractionTimeMs: 200,
        unmappedFields: [],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'ext-2',
      jobId: JOB_ID,
      tenantId: TENANT_ID,
      pageId: 'page-2',
      schemaVersion: 1,
      data: { name: 'Test Product', price: '$31.99' },
      unmappedFields: [],
      metadata: {
        confidence: 0.92,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 480,
        extractionTimeMs: 180,
        unmappedFields: [],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];
}

function createMockPages() {
  return [
    {
      id: 'page-1',
      taskId: 'task-1',
      tenantId: TENANT_ID,
      contentRef: 'pg://content/abc',
      contentHash: 'hash-1',
      metadata: { url: 'https://a.com/p1', title: 'Page 1', statusCode: 200, responseTimeMs: 100 },
      createdAt: new Date('2026-03-01'),
    },
    {
      id: 'page-2',
      taskId: 'task-2',
      tenantId: TENANT_ID,
      contentRef: 'pg://content/def',
      contentHash: 'hash-2',
      metadata: { url: 'https://b.com/p2', title: 'Page 2', statusCode: 200, responseTimeMs: 150 },
      createdAt: new Date('2026-03-02'),
    },
  ];
}

function createMockReconciliationResult() {
  return {
    entities: [
      {
        entityId: 'entity-1',
        sourceExtractions: [
          {
            extractionId: 'ext-1',
            sourceUrl: 'https://a.com/p1',
            sourceDomain: 'a.com',
            crawledAt: new Date('2026-03-01'),
            fieldsCovered: ['name', 'price'],
          },
          {
            extractionId: 'ext-2',
            sourceUrl: 'https://b.com/p2',
            sourceDomain: 'b.com',
            crawledAt: new Date('2026-03-02'),
            fieldsCovered: ['name', 'price'],
          },
        ],
        mergedData: { name: 'Test Product', price: '$29.99' },
        fieldProvenance: {
          name: {
            finalValue: 'Test Product',
            provenanceType: 'extracted',
            sources: [],
            hadConflict: false,
          },
          price: {
            finalValue: '$29.99',
            provenanceType: 'resolved',
            sources: [],
            hadConflict: true,
            resolution: 'most_complete',
          },
        },
      },
    ],
    actions: [
      {
        id: 'act-1',
        jobId: 'placeholder',
        type: 'match_entities',
        source: 'reconciliation',
        reasoning: 'Matched by composite key',
        confidence: 1,
        payload: {
          entityId: 'entity-1',
          extractionIds: ['ext-1', 'ext-2'],
          matchedOn: ['name'],
        },
      },
      {
        id: 'act-2',
        jobId: 'placeholder',
        type: 'set_source_trust',
        source: 'reconciliation',
        reasoning: 'Evaluated source reliability',
        confidence: 1,
        payload: {
          rankings: [
            { domain: 'a.com', trustLevel: 'high', reasoning: 'reputable source' },
            { domain: 'b.com', trustLevel: 'medium', reasoning: 'secondary source' },
          ],
        },
      },
    ],
  };
}

function createMockDeps(): WorkerDeps {
  return {
    crawler: {
      type: 'playwright' as const,
      crawl: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    },
    classifier: {
      classify: vi.fn().mockResolvedValue({}),
    } as any,
    extractor: {
      extract: vi.fn().mockResolvedValue({}),
    },
    contentStore: {
      store: vi.fn().mockResolvedValue(''),
      retrieve: vi.fn().mockResolvedValue(''),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    schemaEvolver: {
      evolve: vi.fn().mockResolvedValue([]),
    },
    reconciler: {
      reconcile: vi.fn().mockResolvedValue(createMockReconciliationResult()),
    },
    jobRepo: {
      findById: vi.fn().mockResolvedValue(createMockJob()),
      updateStatus: vi.fn().mockResolvedValue({ id: JOB_ID }),
    } as any,
    taskRepo: {
      updateStatus: vi.fn().mockResolvedValue(null),
      updateClassification: vi.fn().mockResolvedValue(null),
      enqueue: vi.fn().mockResolvedValue({ id: 'task-1' }),
    } as any,
    pageRepo: {
      findByContentHash: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'page-1' }),
      findByIds: vi.fn().mockResolvedValue(createMockPages()),
    } as any,
    extractionRepo: {
      store: vi.fn().mockResolvedValue({ id: 'ext-1' }),
      findByJob: vi.fn().mockResolvedValue(createMockExtractions()),
    } as any,
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(createMockSchema()),
      create: vi.fn().mockResolvedValue({ id: 'schema-2', version: 2 }),
    } as any,
    entityRepo: {
      create: vi.fn().mockResolvedValue({ id: 'db-entity-1' }),
    } as any,
    sourceTrustRepo: {
      upsert: vi.fn().mockResolvedValue({ id: 'trust-1' }),
    } as any,
    entitySourceRepo: {
      bulkLink: vi.fn().mockResolvedValue([]),
    } as any,
    queues: {
      crawl: { add: vi.fn().mockResolvedValue(undefined) },
      extract: { add: vi.fn().mockResolvedValue(undefined) },
      schemaEvolution: { add: vi.fn().mockResolvedValue(undefined) },
      reconciliation: { add: vi.fn().mockResolvedValue(undefined) },
      closeAll: vi.fn().mockResolvedValue(undefined),
    } as any,
  } as unknown as WorkerDeps;
}

function createJobData(overrides?: Partial<ReconciliationJobData>): ReconciliationJobData {
  return {
    jobId: JOB_ID,
    tenantId: TENANT_ID,
    ...overrides,
  };
}

describe('processReconciliationJob', () => {
  let deps: WorkerDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('loads extractions, reconciles, and persists entities', async () => {
    const data = createJobData();

    await processReconciliationJob(data, deps);

    // Verify it loaded job, schema, extractions, and pages
    expect(deps.jobRepo.findById).toHaveBeenCalledWith(JOB_ID, TENANT_ID);
    expect(deps.schemaRepo.findLatest).toHaveBeenCalledWith(JOB_ID, TENANT_ID);
    expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith(JOB_ID, TENANT_ID);
    expect(deps.pageRepo.findByIds).toHaveBeenCalledWith(['page-1', 'page-2'], TENANT_ID);

    // Verify reconciler was called
    expect(deps.reconciler.reconcile).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ext-1', sourceUrl: 'https://a.com/p1' }),
        expect.objectContaining({ id: 'ext-2', sourceUrl: 'https://b.com/p2' }),
      ]),
      expect.objectContaining({ version: 1 }),
      expect.objectContaining({ matchStrategy: 'composite_key' }),
      'Scrape product data',
    );

    // Verify entity was persisted
    expect(deps.entityRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        tenantId: TENANT_ID,
        mergedData: { name: 'Test Product', price: '$29.99' },
      }),
    );
  });

  it('transitions job to completed on success', async () => {
    const data = createJobData();

    await processReconciliationJob(data, deps);

    expect(deps.jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'completed');
  });

  it('transitions job to failed on error', async () => {
    (deps.reconciler.reconcile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Reconciliation failed'),
    );

    const data = createJobData();

    await processReconciliationJob(data, deps);

    expect(deps.jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'failed');
  });

  it('skips if job not found', async () => {
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const data = createJobData();
    await processReconciliationJob(data, deps);

    expect(deps.schemaRepo.findLatest).not.toHaveBeenCalled();
    expect(deps.reconciler.reconcile).not.toHaveBeenCalled();
    expect(deps.entityRepo.create).not.toHaveBeenCalled();
  });

  it('skips if no schema found', async () => {
    (deps.schemaRepo.findLatest as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const data = createJobData();
    await processReconciliationJob(data, deps);

    expect(deps.extractionRepo.findByJob).not.toHaveBeenCalled();
    expect(deps.reconciler.reconcile).not.toHaveBeenCalled();
    expect(deps.entityRepo.create).not.toHaveBeenCalled();
  });

  it('skips if no extractions found and sets status to completed', async () => {
    (deps.extractionRepo.findByJob as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const data = createJobData();
    await processReconciliationJob(data, deps);

    expect(deps.reconciler.reconcile).not.toHaveBeenCalled();
    expect(deps.jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'completed');
  });

  it('enriches extractions with page metadata', async () => {
    const data = createJobData();

    await processReconciliationJob(data, deps);

    const reconcileCall = (deps.reconciler.reconcile as ReturnType<typeof vi.fn>).mock.calls[0];
    const enrichedExtractions = reconcileCall[0];

    expect(enrichedExtractions).toHaveLength(2);
    expect(enrichedExtractions[0]).toEqual(
      expect.objectContaining({
        id: 'ext-1',
        sourceUrl: 'https://a.com/p1',
        sourceDomain: 'a.com',
        crawledAt: new Date('2026-03-01'),
      }),
    );
    expect(enrichedExtractions[1]).toEqual(
      expect.objectContaining({
        id: 'ext-2',
        sourceUrl: 'https://b.com/p2',
        sourceDomain: 'b.com',
        crawledAt: new Date('2026-03-02'),
      }),
    );
  });

  it('persists source trust from set_source_trust actions', async () => {
    const data = createJobData();

    await processReconciliationJob(data, deps);

    expect(deps.sourceTrustRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        tenantId: TENANT_ID,
        domain: 'a.com',
        trustLevel: 'high',
        reasoning: 'reputable source',
      }),
    );
    expect(deps.sourceTrustRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        tenantId: TENANT_ID,
        domain: 'b.com',
        trustLevel: 'medium',
        reasoning: 'secondary source',
      }),
    );
  });

  it('stamps jobId on all returned actions', async () => {
    const data = createJobData();

    await processReconciliationJob(data, deps);

    const reconcileCall = (deps.reconciler.reconcile as ReturnType<typeof vi.fn>).mock.calls[0];
    // The reconciler returns actions with placeholder jobId.
    // After processReconciliationJob runs, the actions should have been stamped.
    // We verify indirectly via the result object being mutated.
    const result = await (deps.reconciler.reconcile as ReturnType<typeof vi.fn>).mock.results[0]
      .value;
    for (const action of result.actions) {
      expect(action.jobId).toBe(JOB_ID);
    }
  });

  it('links extractions to entities via entitySourceRepo', async () => {
    const data = createJobData();

    await processReconciliationJob(data, deps);

    expect(deps.entitySourceRepo.bulkLink).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ extractionId: 'ext-1' }),
        expect.objectContaining({ extractionId: 'ext-2' }),
      ]),
    );
  });

  it('uses default reconciliation config when not provided in job config', async () => {
    const job = createMockJob();
    delete (job.config as any).reconciliation;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(job);

    const data = createJobData();
    await processReconciliationJob(data, deps);

    const reconcileCall = (deps.reconciler.reconcile as ReturnType<typeof vi.fn>).mock.calls[0];
    const config = reconcileCall[2];
    expect(config).toEqual({
      matchStrategy: 'composite_key',
      conflictResolution: 'most_complete',
      fuzzyMatchThreshold: 0.85,
      enableLLMMatching: true,
    });
  });

  it('handles errors gracefully without crashing', async () => {
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database connection failed'),
    );

    const data = createJobData();

    // Should not throw
    await expect(processReconciliationJob(data, deps)).resolves.toBeUndefined();
  });
});
