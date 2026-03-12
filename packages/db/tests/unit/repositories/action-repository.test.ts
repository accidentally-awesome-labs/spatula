import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionRepository } from '../../../src/repositories/action-repository.js';

function createMockDb() {
  const chainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'action-id', status: 'pending_review' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) =>
    resolve([{ id: 'action-id', status: 'pending_review' }]),
  );

  return {
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('ActionRepository', () => {
  let repo: ActionRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new ActionRepository(mockDb as any);
  });

  it('findByJob calls db.select', async () => {
    await repo.findByJob(
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
    );
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('findById calls db.select', async () => {
    await repo.findById('action-id', '550e8400-e29b-41d4-a716-446655440001');
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('updateStatus calls db.update', async () => {
    await repo.updateStatus(
      'action-id',
      '550e8400-e29b-41d4-a716-446655440001',
      'approved',
    );
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('batchUpdateStatus calls db.update', async () => {
    await repo.batchUpdateStatus(
      ['action-1', 'action-2'],
      '550e8400-e29b-41d4-a716-446655440001',
      'approved',
      'admin',
    );
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('findByJob wraps errors in StorageError', async () => {
    const failChainable = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      then: undefined as unknown,
    };
    failChainable.then = vi.fn((_: unknown, reject: (v: unknown) => void) =>
      reject(new Error('db error')),
    );
    mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(failChainable) });

    await expect(
      repo.findByJob('job-id', 'tenant-id'),
    ).rejects.toThrow('Failed to find actions');
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
      repo.updateStatus('action-id', 'tenant-id', 'approved'),
    ).rejects.toThrow('Failed to update action status');
  });
});
