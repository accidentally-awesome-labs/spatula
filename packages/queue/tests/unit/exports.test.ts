import { describe, it, expect } from 'vitest';

describe('package exports', () => {
  it('exports state machine', async () => {
    const mod = await import('../../src/state-machine.js');
    expect(mod.JobStateMachine).toBeDefined();
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
    expect(root.StateError).toBeDefined();
    expect(root.createQueues).toBeDefined();
    expect(root.QUEUE_NAMES).toBeDefined();
    expect(root.JobManager).toBeDefined();
    expect(root.WorkerDeps).toBeDefined();
    expect(root.processCrawlJob).toBeDefined();
    expect(root.processSchemaEvolutionJob).toBeDefined();
  });
});
