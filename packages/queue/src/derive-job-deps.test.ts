// packages/queue/src/derive-job-deps.test.ts
// Unit tests for deriveJobDeps() and resolveJobDeps().
// Four behaviour tests proving per-job model resolution + singleton preservation.

import { describe, it, expect, vi } from 'vitest';

// We mock @spatula/core entirely (no importOriginal) to avoid triggering
// a real Playwright launch in the vitest worker pool.
vi.mock('@spatula/core', () => {
  const resolveModel = (
    config: { primaryModel: string; modelOverrides?: Record<string, string> },
    task: string,
  ): string => {
    return config.modelOverrides?.[task] ?? config.primaryModel;
  };

  class PageClassifier {
    constructor(
      public llmClient: unknown,
      public config: unknown,
    ) {}
  }
  class StaticExtractor {
    constructor(
      public llmClient: unknown,
      public config: unknown,
      public jobId: string,
    ) {}
  }
  class SchemaEvolverImpl {
    constructor(
      public llmClient: unknown,
      public config: unknown,
    ) {}
  }
  class DataReconcilerImpl {
    constructor(
      public llmClient: unknown,
      public config: unknown,
    ) {}
  }
  class LLMLinkEvaluator {
    constructor(
      public llmClient: unknown,
      public model: string,
    ) {}
  }

  return {
    resolveModel,
    PageClassifier,
    StaticExtractor,
    SchemaEvolverImpl,
    DataReconcilerImpl,
    LLMLinkEvaluator,
  };
});

vi.mock('./worker-deps.js', () => {
  class WorkerDeps {
    [key: string]: unknown;
    constructor(config: Record<string, unknown>) {
      Object.assign(this, config);
    }
  }
  return { WorkerDeps };
});

import { deriveJobDeps, resolveJobDeps } from './derive-job-deps.js';
import type { WorkerDeps } from './worker-deps.js';

function createBaseWorkerDeps(): WorkerDeps {
  // Stub objects — identity equality is all that matters for singletons
  const stub = (name: string) => ({ _stub: name });
  return {
    dbPool: stub('dbPool'),
    crawler: stub('crawler'),
    contentStore: stub('contentStore'),
    jobRepo: stub('jobRepo'),
    taskRepo: stub('taskRepo'),
    pageRepo: stub('pageRepo'),
    extractionRepo: stub('extractionRepo'),
    schemaRepo: stub('schemaRepo'),
    entityRepo: stub('entityRepo'),
    sourceTrustRepo: stub('sourceTrustRepo'),
    entitySourceRepo: stub('entitySourceRepo'),
    exportRepo: stub('exportRepo'),
    actionRepo: stub('actionRepo'),
    queues: stub('queues'),
    eventPublisher: stub('eventPublisher'),
    robotsChecker: stub('robotsChecker'),
    rateLimiter: stub('rateLimiter'),
    pageBudget: stub('pageBudget'),
    completionChecker: stub('completionChecker'),
    tenantRepo: stub('tenantRepo'),
    // base LLM-config-dependent components — these should be REPLACED by deriveJobDeps
    classifier: stub('base-classifier'),
    extractor: stub('base-extractor'),
    schemaEvolver: stub('base-schemaEvolver'),
    reconciler: stub('base-reconciler'),
    linkEvaluator: stub('base-linkEvaluator'),
  } as unknown as WorkerDeps;
}

describe('deriveJobDeps', () => {
  const stubLlmClient = { complete: vi.fn() } as any;

  it('returns new instances for the 5 LLM-config-dependent components', () => {
    const base = createBaseWorkerDeps();
    const config = { primaryModel: 'model-X' };

    const derived = deriveJobDeps(base, stubLlmClient, config, 'job-1');

    // All 5 should be NEW instances — not the base stubs
    expect(derived.extractor).not.toBe(base.extractor);
    expect(derived.classifier).not.toBe(base.classifier);
    expect(derived.schemaEvolver).not.toBe(base.schemaEvolver);
    expect(derived.reconciler).not.toBe(base.reconciler);
    expect(derived.linkEvaluator).not.toBe(base.linkEvaluator);
  });

  it('linkEvaluator is built with resolveModel(config, "linkEvaluation") = primaryModel when no override', () => {
    const base = createBaseWorkerDeps();
    const config = { primaryModel: 'model-X' };

    const derived = deriveJobDeps(base, stubLlmClient, config, 'job-1');

    // resolveModel({primaryModel:'model-X'}, 'linkEvaluation') === 'model-X' (no override)
    expect((derived.linkEvaluator as any).model).toBe('model-X');
  });

  it('preserves all shared singletons on the derived deps', () => {
    const base = createBaseWorkerDeps();
    const config = { primaryModel: 'model-X' };

    const derived = deriveJobDeps(base, stubLlmClient, config, 'job-1');

    // Singletons must be exactly the same object references
    expect(derived.crawler).toBe(base.crawler);
    expect(derived.contentStore).toBe(base.contentStore);
    expect(derived.jobRepo).toBe(base.jobRepo);
    expect(derived.taskRepo).toBe(base.taskRepo);
    expect(derived.queues).toBe(base.queues);
    expect(derived.dbPool).toBe(base.dbPool);
    expect(derived.pageRepo).toBe(base.pageRepo);
    expect(derived.extractionRepo).toBe(base.extractionRepo);
    expect(derived.schemaRepo).toBe(base.schemaRepo);
    expect(derived.entityRepo).toBe(base.entityRepo);
    expect(derived.sourceTrustRepo).toBe(base.sourceTrustRepo);
    expect(derived.entitySourceRepo).toBe(base.entitySourceRepo);
    expect(derived.exportRepo).toBe(base.exportRepo);
    expect(derived.actionRepo).toBe(base.actionRepo);
    expect(derived.eventPublisher).toBe(base.eventPublisher);
  });

  it('modelOverrides win — extraction uses override, linkEvaluation falls back to primaryModel', () => {
    const base = createBaseWorkerDeps();
    const config = {
      primaryModel: 'P',
      modelOverrides: { extraction: 'E' },
    };

    const derived = deriveJobDeps(base, stubLlmClient, config, 'job-override');

    // StaticExtractor is constructed with jobLlmConfig — its internal config has modelOverrides
    // resolveModel({primaryModel:'P', modelOverrides:{extraction:'E'}}, 'extraction') === 'E'
    const extractor = derived.extractor as any;
    expect(extractor.config.modelOverrides?.extraction).toBe('E');
    expect(extractor.config.primaryModel).toBe('P');

    // linkEvaluator: resolveModel({primaryModel:'P', modelOverrides:{extraction:'E'}}, 'linkEvaluation')
    // === 'P' (no linkEvaluation override)
    expect((derived.linkEvaluator as any).model).toBe('P');
  });
});

describe('resolveJobDeps', () => {
  it('returns base deps unchanged when sharedClient is undefined (test path / no LLM client)', async () => {
    const base = createBaseWorkerDeps();

    const result = await resolveJobDeps(base, undefined, 'job-1', 'tenant-1');

    expect(result).toBe(base);
  });

  it('derives per-job deps from job.config.llm when sharedClient is provided', async () => {
    const base = createBaseWorkerDeps();
    const stubClient = { complete: vi.fn() } as any;

    // Wire jobRepo.findById to return a job with llm config
    (base.jobRepo as any).findById = vi.fn().mockResolvedValue({
      config: {
        llm: { primaryModel: 'job-specific-model' },
      },
    });

    const result = await resolveJobDeps(base, stubClient, 'job-1', 'tenant-1');

    // Should be a new WorkerDeps (derived), not the base
    expect(result).not.toBe(base);
    // The linkEvaluator should use the job's model
    expect((result.linkEvaluator as any).model).toBe('job-specific-model');
  });
});
