import { describe, it, expect, vi } from 'vitest';
import { WorkerDeps } from '../../src/worker-deps.js';

describe('WorkerDeps', () => {
  it('stores all injected dependencies', () => {
    const deps = new WorkerDeps({
      crawler: { type: 'playwright', crawl: vi.fn(), close: vi.fn() } as any,
      extractor: { extract: vi.fn() } as any,
      classifier: { classify: vi.fn() } as any,
      contentStore: { store: vi.fn(), retrieve: vi.fn(), delete: vi.fn() } as any,
      schemaEvolver: { evolve: vi.fn() } as any,
      reconciler: { reconcile: vi.fn() } as any,
      jobRepo: {} as any,
      taskRepo: {} as any,
      pageRepo: {} as any,
      extractionRepo: {} as any,
      schemaRepo: {} as any,
      entityRepo: {} as any,
      sourceTrustRepo: {} as any,
      entitySourceRepo: {} as any,
      exportRepo: {} as any,
      actionRepo: {} as any,
      queues: {
        crawl: {},
        extract: {},
        schemaEvolution: {},
        reconciliation: {},
        closeAll: vi.fn(),
      } as any,
    });

    expect(deps.crawler).toBeDefined();
    expect(deps.extractor).toBeDefined();
    expect(deps.classifier).toBeDefined();
    expect(deps.contentStore).toBeDefined();
    expect(deps.schemaEvolver).toBeDefined();
    expect(deps.reconciler).toBeDefined();
    expect(deps.jobRepo).toBeDefined();
    expect(deps.taskRepo).toBeDefined();
    expect(deps.pageRepo).toBeDefined();
    expect(deps.extractionRepo).toBeDefined();
    expect(deps.schemaRepo).toBeDefined();
    expect(deps.entityRepo).toBeDefined();
    expect(deps.sourceTrustRepo).toBeDefined();
    expect(deps.entitySourceRepo).toBeDefined();
    expect(deps.exportRepo).toBeDefined();
    expect(deps.actionRepo).toBeDefined();
    expect(deps.queues).toBeDefined();
  });
});
