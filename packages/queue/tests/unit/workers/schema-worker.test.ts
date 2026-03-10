import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processSchemaEvolutionJob } from '../../../src/workers/schema-worker.js';
import type { SchemaEvolutionJobData } from '../../../src/queues.js';
import type { WorkerDeps } from '../../../src/worker-deps.js';

function createMockSchema() {
  return {
    id: 'schema-1',
    jobId: 'job-1',
    tenantId: 'tenant-1',
    version: 1,
    definition: {
      version: 1,
      fields: [
        {
          name: 'title',
          description: 'Product title',
          type: 'string' as const,
          required: true,
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

function createMockJob(overrides?: Record<string, unknown>) {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    name: 'Test Job',
    description: 'Scrape product data',
    status: 'running' as const,
    config: {
      tenantId: 'tenant-1',
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
      llm: {
        primaryModel: 'anthropic/claude-sonnet-4-20250514',
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

function createMockExtractions() {
  return [
    {
      id: 'ext-1',
      jobId: 'job-1',
      tenantId: 'tenant-1',
      pageId: 'page-1',
      schemaVersion: 1,
      data: { title: 'Product 1', price: '$29.99' },
      unmappedFields: [{ name: 'price', value: '$29.99', suggestedType: 'currency' }],
      metadata: {
        confidence: 0.95,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 500,
        extractionTimeMs: 200,
        unmappedFields: [{ name: 'price', value: '$29.99', suggestedType: 'currency' }],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'ext-2',
      jobId: 'job-1',
      tenantId: 'tenant-1',
      pageId: 'page-2',
      schemaVersion: 1,
      data: { title: 'Product 2', price: '$49.99' },
      unmappedFields: [{ name: 'price', value: '$49.99', suggestedType: 'currency' }],
      metadata: {
        confidence: 0.92,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 480,
        extractionTimeMs: 180,
        unmappedFields: [{ name: 'price', value: '$49.99', suggestedType: 'currency' }],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];
}

function createAddFieldAction() {
  return {
    type: 'add_field' as const,
    reasoning: 'Price field found in multiple extractions',
    confidence: 0.9,
    payload: {
      field: {
        name: 'price',
        description: 'Product price',
        type: 'currency' as const,
        required: false,
      },
    },
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
      evolve: vi.fn().mockResolvedValue([createAddFieldAction()]),
    },
    jobRepo: {
      findById: vi.fn().mockResolvedValue(createMockJob()),
    } as any,
    taskRepo: {
      updateStatus: vi.fn().mockResolvedValue(null),
      updateClassification: vi.fn().mockResolvedValue(null),
      enqueue: vi.fn().mockResolvedValue({ id: 'task-1' }),
    } as any,
    pageRepo: {
      findByContentHash: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'page-1' }),
    } as any,
    extractionRepo: {
      store: vi.fn().mockResolvedValue({ id: 'ext-1' }),
      findByJob: vi.fn().mockResolvedValue(createMockExtractions()),
    } as any,
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(createMockSchema()),
      create: vi.fn().mockResolvedValue({ id: 'schema-2', version: 2 }),
    } as any,
    queues: {
      crawl: { add: vi.fn().mockResolvedValue(undefined) },
      extract: { add: vi.fn().mockResolvedValue(undefined) },
      schemaEvolution: { add: vi.fn().mockResolvedValue(undefined) },
      closeAll: vi.fn().mockResolvedValue(undefined),
    } as any,
  } as unknown as WorkerDeps;
}

function createJobData(overrides?: Partial<SchemaEvolutionJobData>): SchemaEvolutionJobData {
  return {
    jobId: 'job-1',
    tenantId: 'tenant-1',
    extractionIds: ['ext-1', 'ext-2'],
    ...overrides,
  };
}

describe('processSchemaEvolutionJob', () => {
  let deps: WorkerDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('fetches job, schema, extractions and calls evolve()', async () => {
    const data = createJobData();

    await processSchemaEvolutionJob(data, deps);

    expect(deps.jobRepo.findById).toHaveBeenCalledWith('job-1', 'tenant-1');
    expect(deps.schemaRepo.findLatest).toHaveBeenCalledWith('job-1', 'tenant-1');
    expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
      limit: 10,
    });
    expect(deps.schemaEvolver.evolve).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, fields: expect.any(Array) }),
      expect.arrayContaining([
        expect.objectContaining({ id: 'ext-1', jobId: 'job-1' }),
        expect.objectContaining({ id: 'ext-2', jobId: 'job-1' }),
      ]),
      'Scrape product data',
    );
  });

  it('creates new schema version when actions are produced', async () => {
    const data = createJobData();

    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        version: 2,
        parentId: 'schema-1',
        definition: expect.objectContaining({
          version: 2,
          parentVersion: 1,
          fields: expect.arrayContaining([
            expect.objectContaining({ name: 'title' }),
            expect.objectContaining({ name: 'price', type: 'currency' }),
          ]),
        }),
      }),
    );
  });

  it('uses custom batchSize from evolution config', async () => {
    const customJob = createMockJob();
    customJob.config.schema.evolutionConfig!.batchSize = 25;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(customJob);

    const data = createJobData();
    await processSchemaEvolutionJob(data, deps);

    expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
      limit: 25,
    });
  });

  it('defaults batchSize to 10 when not specified', async () => {
    const job = createMockJob();
    delete (job.config.schema.evolutionConfig as any).batchSize;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(job);

    const data = createJobData();
    await processSchemaEvolutionJob(data, deps);

    expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
      limit: 10,
    });
  });

  it('skips when job is not found', async () => {
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const data = createJobData();
    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaRepo.findLatest).not.toHaveBeenCalled();
    expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('skips when evolution is disabled (no evolutionConfig)', async () => {
    const job = createMockJob();
    delete (job.config.schema as any).evolutionConfig;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(job);

    const data = createJobData();
    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaRepo.findLatest).not.toHaveBeenCalled();
    expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('skips when evolution is disabled (enabled: false)', async () => {
    const job = createMockJob();
    job.config.schema.evolutionConfig!.enabled = false;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(job);

    const data = createJobData();
    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaRepo.findLatest).not.toHaveBeenCalled();
    expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('skips when no schema exists yet', async () => {
    (deps.schemaRepo.findLatest as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const data = createJobData();
    await processSchemaEvolutionJob(data, deps);

    expect(deps.extractionRepo.findByJob).not.toHaveBeenCalled();
    expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('skips when no extractions are found', async () => {
    (deps.extractionRepo.findByJob as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const data = createJobData();
    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('skips schema creation when no actions returned', async () => {
    (deps.schemaEvolver.evolve as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const data = createJobData();
    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('skips schema creation when actions produce no effective changes', async () => {
    // Return an action that targets a non-existent field (remove_field on unknown)
    // applySchemaActions will skip it and return the same version
    (deps.schemaEvolver.evolve as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        type: 'remove_field' as const,
        reasoning: 'Remove obsolete field',
        confidence: 0.8,
        payload: { fieldName: 'nonexistent_field' },
      },
    ]);

    const data = createJobData();
    await processSchemaEvolutionJob(data, deps);

    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('handles errors gracefully without crashing', async () => {
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database connection failed'),
    );

    const data = createJobData();

    // Should not throw
    await expect(processSchemaEvolutionJob(data, deps)).resolves.toBeUndefined();

    // Should not have proceeded to create schema
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('handles schema evolver errors gracefully', async () => {
    (deps.schemaEvolver.evolve as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('LLM API timeout'),
    );

    const data = createJobData();

    await expect(processSchemaEvolutionJob(data, deps)).resolves.toBeUndefined();
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('handles schema repo create errors gracefully', async () => {
    (deps.schemaRepo.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unique constraint violation'),
    );

    const data = createJobData();

    await expect(processSchemaEvolutionJob(data, deps)).resolves.toBeUndefined();
  });

  it('maps extraction DB rows to ExtractionResult shape correctly', async () => {
    const data = createJobData();

    await processSchemaEvolutionJob(data, deps);

    const evolveCall = (deps.schemaEvolver.evolve as ReturnType<typeof vi.fn>).mock.calls[0];
    const extractionResults = evolveCall[1];

    expect(extractionResults).toHaveLength(2);
    expect(extractionResults[0]).toEqual({
      id: 'ext-1',
      jobId: 'job-1',
      pageId: 'page-1',
      schemaVersion: 1,
      data: { title: 'Product 1', price: '$29.99' },
      metadata: expect.objectContaining({
        confidence: 0.95,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 500,
        extractionTimeMs: 200,
        unmappedFields: [{ name: 'price', value: '$29.99', suggestedType: 'currency' }],
      }),
    });
  });
});
