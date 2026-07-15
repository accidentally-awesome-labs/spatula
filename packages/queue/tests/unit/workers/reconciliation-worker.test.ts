import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processReconciliationJob } from '../../../src/workers/reconciliation-worker.js';
import type { ReconciliationJobData } from '../../../src/queues.js';

// Mock @accidentally-awesome-labs/spatula-core's processReconciliation
const mockProcessReconciliation = vi.fn().mockResolvedValue({ entitiesCreated: 10 });
vi.mock('@accidentally-awesome-labs/spatula-core', () => ({
  processReconciliation: (...args: unknown[]) => mockProcessReconciliation(...args),
}));

// Mock webhook sender
const mockEnqueueWebhook = vi.fn();
vi.mock('../../../src/webhook-sender.js', () => ({
  enqueueWebhookIfConfigured: (...args: unknown[]) => mockEnqueueWebhook(...args),
}));

const JOB_ID = 'job-1';
const TENANT_ID = 'tenant-1';

function createMockDeps(overrides?: Record<string, unknown>) {
  return {
    reconciler: { reconcile: vi.fn() },
    jobRepo: {
      findById: vi.fn().mockResolvedValue({
        id: JOB_ID,
        config: { webhooks: { url: 'https://hooks.test' } },
      }),
    },
    schemaRepo: {},
    extractionRepo: {},
    pageRepo: {},
    entityRepo: {},
    entitySourceRepo: {},
    sourceTrustRepo: {},
    eventPublisher: { publish: vi.fn() },
    queues: { webhook: { add: vi.fn() } },
    ...overrides,
  } as any;
}

const jobData: ReconciliationJobData = { jobId: JOB_ID, tenantId: TENANT_ID };

describe('processReconciliationJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessReconciliation.mockResolvedValue({ entitiesCreated: 10 });
  });

  it('delegates to processReconciliation with correct job context and deps', async () => {
    const deps = createMockDeps();
    await processReconciliationJob(jobData, deps);

    expect(mockProcessReconciliation).toHaveBeenCalledTimes(1);
    const [context, coreDeps] = mockProcessReconciliation.mock.calls[0];
    expect(context).toEqual({ jobId: JOB_ID, tenantId: TENANT_ID });
    expect(coreDeps).toMatchObject({
      reconciler: deps.reconciler,
      jobRepo: deps.jobRepo,
      schemaRepo: deps.schemaRepo,
      entityRepo: deps.entityRepo,
      eventPublisher: deps.eventPublisher,
    });
  });

  it('fires job.completed webhook after successful reconciliation', async () => {
    const deps = createMockDeps();
    await processReconciliationJob(jobData, deps);

    expect(deps.jobRepo.findById).toHaveBeenCalledWith(JOB_ID, TENANT_ID);
    expect(mockEnqueueWebhook).toHaveBeenCalledWith(
      deps.queues.webhook,
      { url: 'https://hooks.test' },
      'job.completed',
      expect.objectContaining({ jobId: JOB_ID, tenantId: TENANT_ID, entityCount: 10 }),
    );
  });

  it('skips webhook when queues.webhook is not available', async () => {
    const deps = createMockDeps({ queues: undefined });
    await processReconciliationJob(jobData, deps);

    expect(mockProcessReconciliation).toHaveBeenCalledTimes(1);
    expect(mockEnqueueWebhook).not.toHaveBeenCalled();
  });

  it('propagates errors from processReconciliation', async () => {
    mockProcessReconciliation.mockRejectedValue(new Error('Reconciliation failed'));
    const deps = createMockDeps();

    await expect(processReconciliationJob(jobData, deps)).rejects.toThrow('Reconciliation failed');
    expect(mockEnqueueWebhook).not.toHaveBeenCalled();
  });
});
