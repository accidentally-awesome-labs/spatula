// packages/core/tests/unit/pipeline/reconcile-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processReconciliation } from '../../../src/pipeline/reconcile-orchestrator.js';
import type {
  ReconcileOrchestratorDeps,
  ReconciliationInput,
} from '../../../src/pipeline/types.js';

const JOB_ID = 'job-1';
const TENANT_ID = 'tenant-1';

function createMockJob(overrides?: Record<string, unknown>) {
  return {
    id: JOB_ID,
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
    ...overrides,
  };
}

function createMockSchema() {
  return {
    id: 'schema-1',
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
  };
}

function createMockExtractions() {
  return [
    {
      id: 'ext-1',
      jobId: JOB_ID,
      pageId: 'page-1',
      schemaVersion: 1,
      data: { name: 'Test Product', price: '$29.99' },
      metadata: {
        confidence: 0.95,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 500,
        extractionTimeMs: 200,
        unmappedFields: [],
      },
    },
    {
      id: 'ext-2',
      jobId: JOB_ID,
      pageId: 'page-2',
      schemaVersion: 1,
      data: { name: 'Test Product', price: '$31.99' },
      metadata: {
        confidence: 0.92,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 480,
        extractionTimeMs: 180,
        unmappedFields: [],
      },
    },
  ];
}

function createMockPages() {
  return [
    {
      id: 'page-1',
      metadata: { url: 'https://a.com/p1', title: 'Page 1', statusCode: 200 },
      createdAt: new Date('2026-03-01'),
    },
    {
      id: 'page-2',
      metadata: { url: 'https://b.com/p2', title: 'Page 2', statusCode: 200 },
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

function createMockDeps(): ReconcileOrchestratorDeps {
  return {
    reconciler: {
      reconcile: vi.fn().mockResolvedValue(createMockReconciliationResult()),
    },
    jobRepo: {
      findById: vi.fn().mockResolvedValue(createMockJob()),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(createMockSchema()),
    } as any,
    extractionRepo: {
      findByJob: vi.fn().mockResolvedValue(createMockExtractions()),
    } as any,
    pageRepo: {
      findByIds: vi.fn().mockResolvedValue(createMockPages()),
    } as any,
    entityRepo: {
      create: vi.fn().mockResolvedValue({ id: 'db-entity-1' }),
    } as any,
    entitySourceRepo: {
      bulkLink: vi.fn().mockResolvedValue([]),
    },
    sourceTrustRepo: {
      upsert: vi.fn().mockResolvedValue(undefined),
    },
    eventPublisher: {
      publish: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createInput(overrides?: Partial<ReconciliationInput>): ReconciliationInput {
  return {
    jobId: JOB_ID,
    tenantId: TENANT_ID,
    ...overrides,
  };
}

describe('processReconciliation', () => {
  let deps: ReconcileOrchestratorDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns { entitiesCreated: 0 } when job is not found', async () => {
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await processReconciliation(createInput(), deps);

    expect(result).toEqual({ entitiesCreated: 0, actionsGenerated: 0 });
    expect(deps.schemaRepo.findLatest).not.toHaveBeenCalled();
    expect(deps.reconciler.reconcile).not.toHaveBeenCalled();
    expect(deps.entityRepo.create).not.toHaveBeenCalled();
  });

  it('returns { entitiesCreated: 0 } when no schema found', async () => {
    (deps.schemaRepo.findLatest as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await processReconciliation(createInput(), deps);

    expect(result).toEqual({ entitiesCreated: 0, actionsGenerated: 0 });
    expect(deps.extractionRepo.findByJob).not.toHaveBeenCalled();
    expect(deps.reconciler.reconcile).not.toHaveBeenCalled();
    expect(deps.entityRepo.create).not.toHaveBeenCalled();
  });

  it('completes job and returns { entitiesCreated: 0 } when no extractions found', async () => {
    (deps.extractionRepo.findByJob as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await processReconciliation(createInput(), deps);

    expect(result).toEqual({ entitiesCreated: 0, actionsGenerated: 0 });
    expect(deps.reconciler.reconcile).not.toHaveBeenCalled();
    expect(deps.entityRepo.create).not.toHaveBeenCalled();
    expect(deps.jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'completed');
  });

  it('loads extractions, reconciles, and persists entities on success', async () => {
    const result = await processReconciliation(createInput(), deps);

    // Verify it loaded job, schema, extractions, and pages
    expect(deps.jobRepo.findById).toHaveBeenCalledWith(JOB_ID, TENANT_ID);
    expect(deps.schemaRepo.findLatest).toHaveBeenCalledWith(JOB_ID, TENANT_ID);
    expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith(JOB_ID, TENANT_ID);
    expect(deps.pageRepo.findByIds).toHaveBeenCalledWith(['page-1', 'page-2'], TENANT_ID);

    // Verify reconciler was called with enriched extractions
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

    // Verify correct return
    expect(result).toEqual({ entitiesCreated: 1, actionsGenerated: 2 });
  });

  it('enriches extractions with page metadata (sourceUrl, sourceDomain, crawledAt)', async () => {
    await processReconciliation(createInput(), deps);

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

  it('links extractions to entities via entitySourceRepo.bulkLink', async () => {
    await processReconciliation(createInput(), deps);

    expect(deps.entitySourceRepo.bulkLink).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: 'db-entity-1',
          extractionId: 'ext-1',
          matchConfidence: 1.0,
        }),
        expect.objectContaining({
          entityId: 'db-entity-1',
          extractionId: 'ext-2',
          matchConfidence: 1.0,
        }),
      ]),
    );
  });

  it('persists source trust from set_source_trust actions', async () => {
    await processReconciliation(createInput(), deps);

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

  it('updates job status to completed on success', async () => {
    await processReconciliation(createInput(), deps);

    expect(deps.jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'completed');
  });

  it('publishes entity_created event for each entity', async () => {
    await processReconciliation(createInput(), deps);

    expect(deps.eventPublisher!.publish).toHaveBeenCalledWith(JOB_ID, {
      type: 'entity_created',
      jobId: JOB_ID,
      tenantId: TENANT_ID,
      data: {
        entityId: 'db-entity-1',
        name: 'Test Product',
      },
    });
  });

  it('publishes job_status_changed event on success', async () => {
    await processReconciliation(createInput(), deps);

    expect(deps.eventPublisher!.publish).toHaveBeenCalledWith(JOB_ID, {
      type: 'job_status_changed',
      jobId: JOB_ID,
      tenantId: TENANT_ID,
      data: { from: 'reconciling', to: 'completed' },
    });
  });

  it('marks job as failed on error and does not throw', async () => {
    (deps.reconciler.reconcile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Reconciliation failed'),
    );

    const result = await processReconciliation(createInput(), deps);

    expect(result).toEqual({ entitiesCreated: 0, actionsGenerated: 0 });
    expect(deps.jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'failed');
    expect(deps.entityRepo.create).not.toHaveBeenCalled();
  });

  it('marks job as failed when entity creation throws', async () => {
    (deps.entityRepo.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unique constraint violation'),
    );

    const result = await processReconciliation(createInput(), deps);

    expect(result).toEqual({ entitiesCreated: 0, actionsGenerated: 0 });
    expect(deps.reconciler.reconcile).toHaveBeenCalled();
    expect(deps.jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'failed');
  });

  it('handles errors gracefully when jobRepo.findById throws', async () => {
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database connection failed'),
    );

    const result = await processReconciliation(createInput(), deps);

    expect(result).toEqual({ entitiesCreated: 0, actionsGenerated: 0 });
  });

  it('uses default reconciliation config when not provided in job config', async () => {
    const job = createMockJob();
    delete (job.config as any).reconciliation;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(job);

    await processReconciliation(createInput(), deps);

    const reconcileCall = (deps.reconciler.reconcile as ReturnType<typeof vi.fn>).mock.calls[0];
    const config = reconcileCall[2];
    expect(config).toEqual({
      matchStrategy: 'composite_key',
      conflictResolution: 'most_complete',
      fuzzyMatchThreshold: 0.85,
      enableLLMMatching: true,
    });
  });

  it('stamps jobId on all returned actions', async () => {
    await processReconciliation(createInput(), deps);

    const result = await (deps.reconciler.reconcile as ReturnType<typeof vi.fn>).mock.results[0]
      .value;
    for (const action of result.actions) {
      expect(action.jobId).toBe(JOB_ID);
    }
  });

  it('works without eventPublisher (optional dependency)', async () => {
    deps.eventPublisher = undefined;

    const result = await processReconciliation(createInput(), deps);

    expect(result).toEqual({ entitiesCreated: 1, actionsGenerated: 2 });
    // Should not throw
  });
});
