// packages/core/tests/unit/pipeline/schema-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processSchemaEvolution } from '../../../src/pipeline/schema-orchestrator.js';
import type {
  SchemaOrchestratorDeps,
  SchemaEvolutionInput,
} from '../../../src/pipeline/types.js';

function createMockSchema() {
  return {
    id: 'schema-1',
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
  };
}

function createMockJob(overrides?: Record<string, unknown>) {
  return {
    id: 'job-1',
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
    ...overrides,
  };
}

function createMockExtractions() {
  return [
    {
      id: 'ext-1',
      jobId: 'job-1',
      pageId: 'page-1',
      schemaVersion: 1,
      data: { title: 'Product 1', price: '$29.99' },
      metadata: {
        confidence: 0.95,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 500,
        extractionTimeMs: 200,
        unmappedFields: [{ name: 'price', value: '$29.99', suggestedType: 'currency' }],
      },
    },
    {
      id: 'ext-2',
      jobId: 'job-1',
      pageId: 'page-2',
      schemaVersion: 1,
      data: { title: 'Product 2', price: '$49.99' },
      metadata: {
        confidence: 0.92,
        modelUsed: 'anthropic/claude-sonnet-4-20250514',
        tokensUsed: 480,
        extractionTimeMs: 180,
        unmappedFields: [{ name: 'price', value: '$49.99', suggestedType: 'currency' }],
      },
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

function createMockDeps(): SchemaOrchestratorDeps {
  return {
    schemaEvolver: {
      evolve: vi.fn().mockResolvedValue([createAddFieldAction()]),
    },
    jobRepo: {
      findById: vi.fn().mockResolvedValue(createMockJob()),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    extractionRepo: {
      findByJob: vi.fn().mockResolvedValue(createMockExtractions()),
    } as any,
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue(createMockSchema()),
      create: vi.fn().mockResolvedValue(undefined),
    },
    actionRepo: {
      create: vi.fn().mockResolvedValue(undefined),
    },
    eventPublisher: {
      publish: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createInput(overrides?: Partial<SchemaEvolutionInput>): SchemaEvolutionInput {
  return {
    jobId: 'job-1',
    tenantId: 'tenant-1',
    extractionIds: ['ext-1', 'ext-2'],
    ...overrides,
  };
}

describe('processSchemaEvolution', () => {
  let deps: SchemaOrchestratorDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns evolved=false when job is not found', async () => {
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await processSchemaEvolution(createInput(), deps);

    expect(result).toEqual({ evolved: false, actionsApplied: 0 });
    expect(deps.schemaRepo.findLatest).not.toHaveBeenCalled();
    expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
  });

  it('returns evolved=false when evolution is disabled (no evolutionConfig)', async () => {
    const job = createMockJob();
    delete (job.config.schema as any).evolutionConfig;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(job);

    const result = await processSchemaEvolution(createInput(), deps);

    expect(result).toEqual({ evolved: false, actionsApplied: 0 });
    expect(deps.schemaRepo.findLatest).not.toHaveBeenCalled();
  });

  it('returns evolved=false when evolution is disabled (enabled: false)', async () => {
    const job = createMockJob();
    job.config.schema.evolutionConfig!.enabled = false;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(job);

    const result = await processSchemaEvolution(createInput(), deps);

    expect(result).toEqual({ evolved: false, actionsApplied: 0 });
    expect(deps.schemaRepo.findLatest).not.toHaveBeenCalled();
  });

  it('returns evolved=false when no schema found', async () => {
    (deps.schemaRepo.findLatest as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await processSchemaEvolution(createInput(), deps);

    expect(result).toEqual({ evolved: false, actionsApplied: 0 });
    expect(deps.extractionRepo.findByJob).not.toHaveBeenCalled();
  });

  it('returns evolved=false when no extractions found', async () => {
    (deps.extractionRepo.findByJob as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await processSchemaEvolution(createInput(), deps);

    expect(result).toEqual({ evolved: false, actionsApplied: 0 });
    expect(deps.schemaEvolver.evolve).not.toHaveBeenCalled();
  });

  it('returns evolved=false when no actions proposed', async () => {
    (deps.schemaEvolver.evolve as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await processSchemaEvolution(createInput(), deps);

    expect(result).toEqual({ evolved: false, actionsApplied: 0 });
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('returns evolved=false when actions produce no effective changes (no-op evolution)', async () => {
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

    const result = await processSchemaEvolution(createInput(), deps);

    expect(result).toEqual({ evolved: false, actionsApplied: 0 });
    expect(deps.schemaRepo.create).not.toHaveBeenCalled();
  });

  it('returns evolved=true with newVersion and actionsApplied on successful evolution', async () => {
    const result = await processSchemaEvolution(createInput(), deps);

    expect(result).toEqual({
      evolved: true,
      newVersion: 2,
      actionsApplied: 1,
    });
  });

  it('fetches job, schema, extractions and calls evolve()', async () => {
    await processSchemaEvolution(createInput(), deps);

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

  it('persists each action via actionRepo.create', async () => {
    await processSchemaEvolution(createInput(), deps);

    expect(deps.actionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        type: 'add_field',
        source: 'schema_evolution',
        status: 'applied',
        confidence: 0.9,
        reasoning: 'Price field found in multiple extractions',
      }),
    );
  });

  it('creates new schema version with correct data', async () => {
    await processSchemaEvolution(createInput(), deps);

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

  it('publishes schema_evolved event on successful evolution', async () => {
    await processSchemaEvolution(createInput(), deps);

    expect(deps.eventPublisher!.publish).toHaveBeenCalledWith('job-1', {
      type: 'schema_evolved',
      jobId: 'job-1',
      tenantId: 'tenant-1',
      data: expect.objectContaining({
        version: 2,
        fieldsAdded: expect.any(Array),
        fieldsMerged: expect.any(Array),
      }),
    });
  });

  it('does not publish event when evolution is a no-op', async () => {
    (deps.schemaEvolver.evolve as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await processSchemaEvolution(createInput(), deps);

    expect(deps.eventPublisher!.publish).not.toHaveBeenCalled();
  });

  it('uses custom batchSize from evolution config', async () => {
    const customJob = createMockJob();
    customJob.config.schema.evolutionConfig!.batchSize = 25;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(customJob);

    await processSchemaEvolution(createInput(), deps);

    expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
      limit: 25,
    });
  });

  it('defaults batchSize to 10 when not specified', async () => {
    const job = createMockJob();
    delete (job.config.schema.evolutionConfig as any).batchSize;
    (deps.jobRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(job);

    await processSchemaEvolution(createInput(), deps);

    expect(deps.extractionRepo.findByJob).toHaveBeenCalledWith('job-1', 'tenant-1', {
      limit: 10,
    });
  });

  it('maps extraction DB rows to ExtractionResult shape correctly', async () => {
    await processSchemaEvolution(createInput(), deps);

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

  it('works without eventPublisher (optional dependency)', async () => {
    deps.eventPublisher = undefined;

    const result = await processSchemaEvolution(createInput(), deps);

    expect(result.evolved).toBe(true);
    // Should not throw
  });
});
