import { describe, it, expect, vi } from 'vitest';
import { createDlqHandler } from '../../src/dlq-handler.js';

describe('createDlqHandler', () => {
  it('inserts into DLQ when job has exhausted all attempts', async () => {
    const dlqRepo = { insert: vi.fn().mockResolvedValue({ id: 'dlq-1' }) };
    const handler = createDlqHandler(dlqRepo as any);

    const mockJob = {
      id: 'bullmq-123',
      name: 'crawl:https://example.com',
      data: { taskId: 'task-1', jobId: 'job-1', tenantId: 'tenant-1', url: 'https://example.com', depth: 0 },
      attemptsMade: 3,
      opts: { attempts: 3 },
      queueName: 'spatula.crawl',
    };
    const error = new Error('Network timeout after 3 retries');

    await handler(mockJob as any, error);

    expect(dlqRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      queueName: 'spatula.crawl',
      jobId: 'bullmq-123',
      tenantId: 'tenant-1',
      spatulaJobId: 'job-1',
      errorMessage: 'Network timeout after 3 retries',
      attempts: 3,
    }));
  });

  it('does NOT insert when job has remaining attempts', async () => {
    const dlqRepo = { insert: vi.fn() };
    const handler = createDlqHandler(dlqRepo as any);

    const mockJob = {
      id: 'bullmq-123',
      data: { taskId: 'task-1', jobId: 'job-1', tenantId: 'tenant-1' },
      attemptsMade: 1,
      opts: { attempts: 3 },
      queueName: 'spatula.crawl',
    };

    await handler(mockJob as any, new Error('transient'));

    expect(dlqRepo.insert).not.toHaveBeenCalled();
  });

  it('handles missing tenantId/jobId gracefully', async () => {
    const dlqRepo = { insert: vi.fn().mockResolvedValue({ id: 'dlq-1' }) };
    const handler = createDlqHandler(dlqRepo as any);

    const mockJob = {
      id: 'bullmq-456',
      data: { someField: 'value' }, // no tenantId or jobId
      attemptsMade: 2,
      opts: { attempts: 2 },
      queueName: 'spatula.export',
    };

    await handler(mockJob as any, new Error('failed'));

    expect(dlqRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: undefined,
      spatulaJobId: undefined,
    }));
  });

  it('does not throw if DLQ insert fails', async () => {
    const dlqRepo = { insert: vi.fn().mockRejectedValue(new Error('DB down')) };
    const handler = createDlqHandler(dlqRepo as any);

    const mockJob = {
      id: 'bullmq-789',
      data: {},
      attemptsMade: 3,
      opts: { attempts: 3 },
      queueName: 'spatula.crawl',
    };

    // Should not throw — DLQ insertion failure should be logged, not propagated
    await expect(handler(mockJob as any, new Error('original'))).resolves.toBeUndefined();
  });
});
