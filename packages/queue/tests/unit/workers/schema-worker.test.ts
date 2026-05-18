import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/redis-lock.js', () => ({
  acquireLock: vi.fn().mockResolvedValue({ acquired: true, token: 'test-token' }),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

const mockProcessSchemaEvolution = vi.fn().mockResolvedValue({ actionsApplied: 0 });
vi.mock('@spatula/core', () => ({
  processSchemaEvolution: (...args: unknown[]) => mockProcessSchemaEvolution(...args),
}));

const mockEnqueueWebhook = vi.fn();
vi.mock('../../../src/webhook-sender.js', () => ({
  enqueueWebhookIfConfigured: (...args: unknown[]) => mockEnqueueWebhook(...args),
}));

import { acquireLock, releaseLock } from '../../../src/redis-lock.js';
import { processSchemaEvolutionJob } from '../../../src/workers/schema-worker.js';
import type { SchemaEvolutionJobData } from '../../../src/queues.js';

const JOB_ID = 'job-1';
const TENANT_ID = 'tenant-1';

function createMockDeps(overrides?: Record<string, unknown>) {
  return {
    schemaEvolver: {},
    jobRepo: {
      findById: vi.fn().mockResolvedValue({
        id: JOB_ID,
        config: { webhooks: { url: 'https://hooks.test' } },
      }),
    },
    extractionRepo: {},
    schemaRepo: {},
    actionRepo: {},
    eventPublisher: { publish: vi.fn() },
    queues: { webhook: { add: vi.fn() } },
    ...overrides,
  } as any;
}

const jobData: SchemaEvolutionJobData = {
  jobId: JOB_ID,
  tenantId: TENANT_ID,
  extractionIds: ['ext-1', 'ext-2'],
};

describe('processSchemaEvolutionJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessSchemaEvolution.mockResolvedValue({ actionsApplied: 0 });
    (acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue({
      acquired: true,
      token: 'test-token',
    });
  });

  // --- Lock tests (queue-specific concern) ---

  it('acquires and releases distributed lock when redis is provided', async () => {
    const deps = createMockDeps();
    const mockRedis = {} as any;

    await processSchemaEvolutionJob(jobData, deps, mockRedis);

    expect(acquireLock).toHaveBeenCalledWith(mockRedis, `schema-lock:${JOB_ID}`, 30);
    expect(releaseLock).toHaveBeenCalledWith(mockRedis, `schema-lock:${JOB_ID}`, 'test-token');
  });

  it('skips processing when lock cannot be acquired', async () => {
    (acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue({ acquired: false });
    const deps = createMockDeps();

    await processSchemaEvolutionJob(jobData, deps, {} as any);

    expect(mockProcessSchemaEvolution).not.toHaveBeenCalled();
  });

  it('releases lock even when processing throws', async () => {
    mockProcessSchemaEvolution.mockRejectedValue(new Error('Schema evolution failed'));
    const deps = createMockDeps();
    const mockRedis = {} as any;

    // Should not throw — error is caught internally
    await processSchemaEvolutionJob(jobData, deps, mockRedis);

    expect(releaseLock).toHaveBeenCalledWith(mockRedis, `schema-lock:${JOB_ID}`, 'test-token');
  });

  it('works without redis (no lock)', async () => {
    const deps = createMockDeps();

    await processSchemaEvolutionJob(jobData, deps);

    expect(acquireLock).not.toHaveBeenCalled();
    expect(mockProcessSchemaEvolution).toHaveBeenCalledTimes(1);
  });

  // --- Core delegation tests ---

  it('delegates to processSchemaEvolution with correct context and deps', async () => {
    const deps = createMockDeps();
    await processSchemaEvolutionJob(jobData, deps);

    expect(mockProcessSchemaEvolution).toHaveBeenCalledTimes(1);
    const [context, coreDeps] = mockProcessSchemaEvolution.mock.calls[0];
    expect(context).toEqual({
      jobId: JOB_ID,
      tenantId: TENANT_ID,
      extractionIds: ['ext-1', 'ext-2'],
    });
    expect(coreDeps).toMatchObject({
      schemaEvolver: deps.schemaEvolver,
      jobRepo: deps.jobRepo,
      schemaRepo: deps.schemaRepo,
      actionRepo: deps.actionRepo,
    });
  });

  it('fires action.pending webhook when actions were applied', async () => {
    mockProcessSchemaEvolution.mockResolvedValue({ actionsApplied: 3 });
    const deps = createMockDeps();

    await processSchemaEvolutionJob(jobData, deps);

    expect(mockEnqueueWebhook).toHaveBeenCalledWith(
      deps.queues.webhook,
      { url: 'https://hooks.test' },
      'action.pending',
      expect.objectContaining({ jobId: JOB_ID, tenantId: TENANT_ID }),
    );
  });

  it('skips webhook when no actions were applied', async () => {
    mockProcessSchemaEvolution.mockResolvedValue({ actionsApplied: 0 });
    const deps = createMockDeps();

    await processSchemaEvolutionJob(jobData, deps);

    expect(mockEnqueueWebhook).not.toHaveBeenCalled();
  });
});
