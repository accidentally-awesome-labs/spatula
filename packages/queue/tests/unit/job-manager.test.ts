import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobManager } from '../../src/job-manager.js';
import { StateError } from '@spatula/shared';

function createMockJobRepo() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByTenant: vi.fn(),
    updateStatus: vi.fn(),
    updateStats: vi.fn(),
  };
}

function createMockTaskRepo() {
  return {
    enqueue: vi.fn(),
    findByJob: vi.fn(),
    updateStatus: vi.fn(),
    updateClassification: vi.fn(),
  };
}

function createMockSchemaRepo() {
  return {
    create: vi.fn(),
    findLatest: vi.fn(),
    findByVersion: vi.fn(),
    findAllVersions: vi.fn(),
  };
}

function createMockQueues() {
  return {
    crawl: { add: vi.fn() },
    extract: { add: vi.fn() },
    schemaEvolution: { add: vi.fn() },
    reconciliation: { add: vi.fn() },
    closeAll: vi.fn(),
  };
}

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const JOB_ID = 'job-001';

const baseConfig = {
  tenantId: TENANT_ID,
  name: 'Test Job',
  description: 'A test crawl job',
  seedUrls: ['https://a.com', 'https://b.com'],
  crawl: { maxDepth: 2, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' as const },
  schema: {
    mode: 'fixed' as const,
    userFields: [
      {
        name: 'title',
        description: 'Page title',
        type: 'string' as const,
        required: true,
      },
    ],
  },
  llm: { primaryModel: 'anthropic/claude-sonnet-4-20250514' },
};

describe('JobManager', () => {
  let jobRepo: ReturnType<typeof createMockJobRepo>;
  let taskRepo: ReturnType<typeof createMockTaskRepo>;
  let schemaRepo: ReturnType<typeof createMockSchemaRepo>;
  let queues: ReturnType<typeof createMockQueues>;
  let manager: JobManager;

  beforeEach(() => {
    jobRepo = createMockJobRepo();
    taskRepo = createMockTaskRepo();
    schemaRepo = createMockSchemaRepo();
    queues = createMockQueues();

    manager = new JobManager({
      jobRepo: jobRepo as any,
      taskRepo: taskRepo as any,
      schemaRepo: schemaRepo as any,
      queues: queues as any,
    });
  });

  it('createJob persists job and returns ID', async () => {
    jobRepo.create.mockResolvedValue({ id: JOB_ID });

    const id = await manager.createJob(baseConfig);

    expect(id).toBe(JOB_ID);
    expect(jobRepo.create).toHaveBeenCalledOnce();
    expect(jobRepo.create).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      name: 'Test Job',
      description: 'A test crawl job',
      config: baseConfig,
    });
  });

  it('startJob transitions pending→running, creates schema, enqueues seed URLs', async () => {
    jobRepo.findById.mockResolvedValue({
      id: JOB_ID,
      tenantId: TENANT_ID,
      status: 'pending',
      config: baseConfig,
    });
    jobRepo.updateStatus.mockResolvedValue({ id: JOB_ID });
    schemaRepo.create.mockResolvedValue({ id: 'schema-001' });
    taskRepo.enqueue
      .mockResolvedValueOnce({ id: 'task-001' })
      .mockResolvedValueOnce({ id: 'task-002' });
    queues.crawl.add.mockResolvedValue({});

    await manager.startJob(JOB_ID, TENANT_ID);

    // Verify state transition: pending→running (validated through queued internally)
    expect(jobRepo.updateStatus).toHaveBeenCalledTimes(1);
    expect(jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'running');

    // Verify schema creation
    expect(schemaRepo.create).toHaveBeenCalledOnce();
    expect(schemaRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        tenantId: TENANT_ID,
        version: 1,
        definition: expect.objectContaining({
          version: 1,
          fields: baseConfig.schema.userFields,
          fieldAliases: [],
          parentVersion: null,
        }),
      }),
    );

    // Verify task enqueueing (once per seed URL)
    expect(taskRepo.enqueue).toHaveBeenCalledTimes(2);
    expect(taskRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        tenantId: TENANT_ID,
        url: 'https://a.com',
        depth: 0,
        priority: 'high',
      }),
    );
    expect(taskRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        tenantId: TENANT_ID,
        url: 'https://b.com',
        depth: 0,
        priority: 'high',
      }),
    );

    // Verify queue jobs added (once per seed URL)
    expect(queues.crawl.add).toHaveBeenCalledTimes(2);
    expect(queues.crawl.add).toHaveBeenCalledWith('crawl:https://a.com', {
      taskId: 'task-001',
      jobId: JOB_ID,
      tenantId: TENANT_ID,
      url: 'https://a.com',
      depth: 0,
    });
    expect(queues.crawl.add).toHaveBeenCalledWith('crawl:https://b.com', {
      taskId: 'task-002',
      jobId: JOB_ID,
      tenantId: TENANT_ID,
      url: 'https://b.com',
      depth: 0,
    });
  });

  it('pauseJob transitions running→paused', async () => {
    jobRepo.findById.mockResolvedValue({
      id: JOB_ID,
      tenantId: TENANT_ID,
      status: 'running',
      config: baseConfig,
    });
    jobRepo.updateStatus.mockResolvedValue({ id: JOB_ID });

    await manager.pauseJob(JOB_ID, TENANT_ID);

    expect(jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'paused');
  });

  it('resumeJob transitions paused→running', async () => {
    jobRepo.findById.mockResolvedValue({
      id: JOB_ID,
      tenantId: TENANT_ID,
      status: 'paused',
      config: baseConfig,
    });
    jobRepo.updateStatus.mockResolvedValue({ id: JOB_ID });

    await manager.resumeJob(JOB_ID, TENANT_ID);

    expect(jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'running');
  });

  it('cancelJob transitions running→cancelled', async () => {
    jobRepo.findById.mockResolvedValue({
      id: JOB_ID,
      tenantId: TENANT_ID,
      status: 'running',
      config: baseConfig,
    });
    jobRepo.updateStatus.mockResolvedValue({ id: JOB_ID });

    await manager.cancelJob(JOB_ID, TENANT_ID);

    expect(jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'cancelled');
  });

  it('throws StateError for invalid state transitions', async () => {
    jobRepo.findById.mockResolvedValue({
      id: JOB_ID,
      tenantId: TENANT_ID,
      status: 'completed',
      config: baseConfig,
    });

    await expect(manager.pauseJob(JOB_ID, TENANT_ID)).rejects.toThrow(StateError);
    await expect(manager.pauseJob(JOB_ID, TENANT_ID)).rejects.toMatchObject({
      code: 'STATE_ERROR',
      context: { from: 'completed', to: 'paused' },
    });
  });

  it('getJobStatus returns current status', async () => {
    jobRepo.findById.mockResolvedValue({
      id: JOB_ID,
      tenantId: TENANT_ID,
      status: 'running',
      config: baseConfig,
    });

    const status = await manager.getJobStatus(JOB_ID, TENANT_ID);

    expect(status).toBe('running');
  });

  describe('quota enforcement in startJob', () => {
    it('throws QuotaExceededError when running job count >= maxConcurrentJobs', async () => {
      const tenantRepo = {
        getQuotas: vi.fn().mockResolvedValue({ maxConcurrentJobs: 2 }),
      };
      const managerWithTenant = new JobManager({
        jobRepo: jobRepo as any,
        taskRepo: taskRepo as any,
        schemaRepo: schemaRepo as any,
        queues: queues as any,
        tenantRepo: tenantRepo as any,
      });

      jobRepo.findById.mockResolvedValue({
        id: JOB_ID,
        tenantId: TENANT_ID,
        status: 'pending',
        config: baseConfig,
      });
      (jobRepo as any).countByTenant = vi.fn().mockResolvedValue(2);

      await expect(managerWithTenant.startJob(JOB_ID, TENANT_ID)).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });
    });

    it('allows job start when running count is under quota', async () => {
      const tenantRepo = {
        getQuotas: vi.fn().mockResolvedValue({ maxConcurrentJobs: 5 }),
      };
      const managerWithTenant = new JobManager({
        jobRepo: jobRepo as any,
        taskRepo: taskRepo as any,
        schemaRepo: schemaRepo as any,
        queues: queues as any,
        tenantRepo: tenantRepo as any,
      });

      jobRepo.findById.mockResolvedValue({
        id: JOB_ID,
        tenantId: TENANT_ID,
        status: 'pending',
        config: baseConfig,
      });
      (jobRepo as any).countByTenant = vi.fn().mockResolvedValue(2);
      jobRepo.updateStatus.mockResolvedValue({ id: JOB_ID });
      schemaRepo.create.mockResolvedValue({ id: 'schema-001' });
      taskRepo.enqueue
        .mockResolvedValueOnce({ id: 'task-001' })
        .mockResolvedValueOnce({ id: 'task-002' });
      queues.crawl.add.mockResolvedValue({});

      await expect(managerWithTenant.startJob(JOB_ID, TENANT_ID)).resolves.toBeUndefined();

      expect(jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'running');
    });

    it('fails open when quota check errors (job still starts)', async () => {
      const tenantRepo = {
        getQuotas: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      };
      const managerWithTenant = new JobManager({
        jobRepo: jobRepo as any,
        taskRepo: taskRepo as any,
        schemaRepo: schemaRepo as any,
        queues: queues as any,
        tenantRepo: tenantRepo as any,
      });

      jobRepo.findById.mockResolvedValue({
        id: JOB_ID,
        tenantId: TENANT_ID,
        status: 'pending',
        config: baseConfig,
      });
      jobRepo.updateStatus.mockResolvedValue({ id: JOB_ID });
      schemaRepo.create.mockResolvedValue({ id: 'schema-001' });
      taskRepo.enqueue
        .mockResolvedValueOnce({ id: 'task-001' })
        .mockResolvedValueOnce({ id: 'task-002' });
      queues.crawl.add.mockResolvedValue({});

      await expect(managerWithTenant.startJob(JOB_ID, TENANT_ID)).resolves.toBeUndefined();

      expect(jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'running');
    });

    it('skips quota check when tenantRepo is not provided', async () => {
      // manager (from beforeEach) has no tenantRepo
      jobRepo.findById.mockResolvedValue({
        id: JOB_ID,
        tenantId: TENANT_ID,
        status: 'pending',
        config: baseConfig,
      });
      jobRepo.updateStatus.mockResolvedValue({ id: JOB_ID });
      schemaRepo.create.mockResolvedValue({ id: 'schema-001' });
      taskRepo.enqueue
        .mockResolvedValueOnce({ id: 'task-001' })
        .mockResolvedValueOnce({ id: 'task-002' });
      queues.crawl.add.mockResolvedValue({});

      await expect(manager.startJob(JOB_ID, TENANT_ID)).resolves.toBeUndefined();

      // No quota check was attempted — there's no tenantRepo to call
      expect(jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'running');
    });
  });

  describe('audit logging for concurrent quota exceeded events', () => {
    function createMockAuditLogger() {
      return { log: vi.fn() };
    }

    it('logs audit event when concurrent job quota is exceeded', async () => {
      const tenantRepo = {
        getQuotas: vi.fn().mockResolvedValue({ maxConcurrentJobs: 2 }),
      };
      const auditLogger = createMockAuditLogger();
      const managerWithAudit = new JobManager({
        jobRepo: jobRepo as any,
        taskRepo: taskRepo as any,
        schemaRepo: schemaRepo as any,
        queues: queues as any,
        tenantRepo: tenantRepo as any,
        auditLogger: auditLogger as any,
      });

      jobRepo.findById.mockResolvedValue({
        id: JOB_ID,
        tenantId: TENANT_ID,
        status: 'pending',
        config: baseConfig,
      });
      (jobRepo as any).countByTenant = vi.fn().mockResolvedValue(2);

      await expect(managerWithAudit.startJob(JOB_ID, TENANT_ID)).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });

      expect(auditLogger.log).toHaveBeenCalledOnce();
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'quota.exceeded',
          actorId: 'system',
          actorType: 'system',
          tenantId: TENANT_ID,
          metadata: expect.objectContaining({
            dimension: 'concurrent_jobs',
            current: 2,
            max: 2,
          }),
        }),
      );
    });
  });

  it('triggerReconciliation transitions running→reconciling and enqueues reconciliation job', async () => {
    jobRepo.findById.mockResolvedValue({
      id: JOB_ID,
      tenantId: TENANT_ID,
      status: 'running',
      config: baseConfig,
    });
    jobRepo.updateStatus.mockResolvedValue({ id: JOB_ID });

    await manager.triggerReconciliation(JOB_ID, TENANT_ID);

    expect(jobRepo.updateStatus).toHaveBeenCalledWith(JOB_ID, TENANT_ID, 'reconciling');
    expect(queues.reconciliation.add).toHaveBeenCalledWith(`reconciliation:${JOB_ID}`, {
      jobId: JOB_ID,
      tenantId: TENANT_ID,
    });
  });
});
