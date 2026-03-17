import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExportRepository } from '../../../src/repositories/export-repository.js';

function createMockDb() {
  const chainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'export-id', status: 'pending' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) =>
    resolve([{ id: 'export-id', status: 'pending' }]),
  );

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'export-id', status: 'pending' }]),
      }),
    }),
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('ExportRepository', () => {
  let repo: ExportRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new ExportRepository(mockDb as any);
  });

  it('has create method', () => {
    expect(typeof repo.create).toBe('function');
  });

  it('has findById method', () => {
    expect(typeof repo.findById).toBe('function');
  });

  it('has findByJob method', () => {
    expect(typeof repo.findByJob).toBe('function');
  });

  it('has updateStatus method', () => {
    expect(typeof repo.updateStatus).toBe('function');
  });

  it('create calls db.insert', async () => {
    await repo.create({ jobId: 'j1', tenantId: 't1', format: 'json', includeProvenance: false });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('findById calls db.select', async () => {
    await repo.findById('export-id', 'tenant-id');
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('findByJob calls db.select', async () => {
    await repo.findByJob('job-id', 'tenant-id');
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('updateStatus calls db.update', async () => {
    await repo.updateStatus('export-id', 'tenant-id', {
      status: 'completed',
      entityCount: 42,
      contentRef: 'pg://abc',
      fileSize: 1024,
      completedAt: new Date(),
    });
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('create wraps errors in StorageError', async () => {
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('db error')),
      }),
    });

    await expect(
      repo.create({ jobId: 'j1', tenantId: 't1', format: 'json', includeProvenance: false }),
    ).rejects.toThrow('Failed to create export');
  });

  it('findById wraps errors in StorageError', async () => {
    const failChainable = {
      where: vi.fn().mockRejectedValue(new Error('db error')),
      then: undefined as unknown,
    };
    failChainable.then = vi.fn((_: unknown, reject: (v: unknown) => void) =>
      reject(new Error('db error')),
    );
    mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(failChainable) });

    await expect(repo.findById('export-id', 'tenant-id')).rejects.toThrow('Failed to find export');
  });

  it('updateStatus wraps errors in StorageError', async () => {
    const failChainable = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockRejectedValue(new Error('db error')),
      then: undefined as unknown,
    };
    failChainable.then = vi.fn((_: unknown, reject: (v: unknown) => void) =>
      reject(new Error('db error')),
    );
    mockDb.update = vi.fn().mockReturnValue(failChainable);

    await expect(
      repo.updateStatus('export-id', 'tenant-id', { status: 'failed', error: 'oops' }),
    ).rejects.toThrow('Failed to update export');
  });
});
