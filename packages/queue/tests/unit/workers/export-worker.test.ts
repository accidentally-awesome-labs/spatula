// packages/queue/tests/unit/workers/export-worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processExportJob } from '../../../src/workers/export-worker.js';
import type { ExportJobPayload } from '../../../src/queues.js';
import type { WorkerDeps } from '../../../src/worker-deps.js';

function createMockDeps(): WorkerDeps {
  return {
    jobRepo: {
      findById: vi.fn().mockResolvedValue({ id: 'job-1', status: 'completed' }),
    },
    exportRepo: {
      updateStatus: vi.fn().mockResolvedValue({ id: 'exp-1', status: 'completed' }),
    },
    schemaRepo: {
      findLatest: vi.fn().mockResolvedValue({
        definition: {
          version: 1,
          fields: [{ name: 'name', description: 'Name', type: 'string', required: true }],
          fieldAliases: [],
          createdAt: new Date(),
          parentVersion: null,
        },
      }),
    },
    entityRepo: {
      findByJob: vi.fn().mockResolvedValue([]),
      findByJobWithProvenance: vi.fn().mockResolvedValue([]),
      countByJob: vi.fn().mockResolvedValue(0),
    },
    contentStore: {
      store: vi.fn().mockResolvedValue('pg://ref-1'),
    },
    actionRepo: {
      create: vi.fn().mockResolvedValue({ id: 'action-1' }),
      findByJob: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn().mockResolvedValue(null),
      batchUpdateStatus: vi.fn().mockResolvedValue([]),
    },
  } as unknown as WorkerDeps;
}

const payload: ExportJobPayload = {
  exportId: 'exp-1',
  jobId: 'job-1',
  tenantId: 'tenant-1',
  format: 'json',
  includeProvenance: false,
};

describe('processExportJob', () => {
  it('updates status to processing then completed', async () => {
    const deps = createMockDeps();
    await processExportJob(payload, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'processing' }),
    );
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('stores content in content store', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.findByJob as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);

    await processExportJob(payload, deps);
    expect(deps.contentStore.store).toHaveBeenCalled();
  });

  it('sets status to failed on error', async () => {
    const deps = createMockDeps();
    (deps.schemaRepo.findLatest as any).mockRejectedValue(new Error('db error'));

    await processExportJob(payload, deps);
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'failed', error: expect.any(String) }),
    );
  });

  it('fails when job is not completed', async () => {
    const deps = createMockDeps();
    (deps.jobRepo.findById as any).mockResolvedValue({ id: 'job-1', status: 'running' });

    await processExportJob(payload, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('not completed'),
      }),
    );
    // Should not attempt to process export
    expect(deps.contentStore.store).not.toHaveBeenCalled();
  });

  it('fails when content store write fails', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.findByJob as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);
    (deps.contentStore.store as any).mockRejectedValue(new Error('S3 write timeout'));

    await processExportJob(payload, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('S3 write timeout'),
      }),
    );
  });

  it('fails when schema is not found', async () => {
    const deps = createMockDeps();
    (deps.schemaRepo.findLatest as any).mockResolvedValue(null);

    await processExportJob(payload, deps);

    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('No schema found'),
      }),
    );
    // Should not attempt to fetch entities or store content
    expect(deps.entityRepo.findByJob).not.toHaveBeenCalled();
    expect(deps.contentStore.store).not.toHaveBeenCalled();
  });

  it('processes CSV format', async () => {
    const deps = createMockDeps();
    (deps.entityRepo.findByJob as any).mockResolvedValue([
      { id: 'e1', mergedData: { name: 'Test' }, qualityScore: 0.9, categories: [], sourceCount: 1 },
    ]);
    (deps.entityRepo.countByJob as any).mockResolvedValue(1);

    const csvPayload = { ...payload, format: 'csv' as const };
    await processExportJob(csvPayload, deps);

    // Should still store content and complete
    expect(deps.contentStore.store).toHaveBeenCalledWith(
      expect.stringContaining('.csv'),
      expect.any(String),
    );
    expect(deps.exportRepo.updateStatus).toHaveBeenCalledWith(
      'exp-1', 'tenant-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });
});
