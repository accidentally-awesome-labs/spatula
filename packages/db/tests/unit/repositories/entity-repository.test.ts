import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntityRepository } from '../../../src/repositories/entity-repository.js';

function createMockDb() {
  const chainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'entity-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'entity-id' }]));

  return {
    insert: vi.fn().mockReturnValue({
      values: vi
        .fn()
        .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'entity-id' }]) }),
    }),
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('EntityRepository', () => {
  let repo: EntityRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new EntityRepository(mockDb as any);
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

  it('has updateQualityScore method', () => {
    expect(typeof repo.updateQualityScore).toBe('function');
  });

  it('create calls db.insert', async () => {
    await repo.create({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      mergedData: { name: 'Test Entity' },
      provenance: { source: 'test' },
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('create passes categories and qualityScore when provided', async () => {
    await repo.create({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      mergedData: { name: 'Test Entity' },
      provenance: { source: 'test' },
      categories: ['restaurant', 'food'],
      qualityScore: 0.85,
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('findById calls db.select', async () => {
    await repo.findById('entity-id', '550e8400-e29b-41d4-a716-446655440001');
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('findByJob calls db.select', async () => {
    await repo.findByJob(
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
    );
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('updateQualityScore calls db.update', async () => {
    await repo.updateQualityScore('entity-id', '550e8400-e29b-41d4-a716-446655440001', 0.95);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('create wraps errors in StorageError', async () => {
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('db error')),
      }),
    });

    await expect(
      repo.create({
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        tenantId: '550e8400-e29b-41d4-a716-446655440001',
        mergedData: {},
        provenance: {},
      }),
    ).rejects.toThrow('Failed to create entity');
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

    await expect(repo.findById('id', 'tenant')).rejects.toThrow('Failed to find entity');
  });

  it('updateQualityScore wraps errors in StorageError', async () => {
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

    await expect(repo.updateQualityScore('id', 'tenant', 0.5)).rejects.toThrow(
      'Failed to update entity quality score',
    );
  });

  it('has countByJob method', () => {
    expect(typeof repo.countByJob).toBe('function');
  });

  it('countByJob calls db.select', async () => {
    await repo.countByJob(
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
    );
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('findByJob accepts search option', async () => {
    await repo.findByJob(
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
      { search: 'bluetooth' },
    );
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('countByJob wraps errors in StorageError', async () => {
    const failChainable = {
      where: vi.fn().mockRejectedValue(new Error('db error')),
      from: vi.fn().mockReturnThis(),
      then: undefined as unknown,
    };
    failChainable.then = vi.fn((_: unknown, reject: (v: unknown) => void) =>
      reject(new Error('db error')),
    );
    mockDb.select = vi.fn().mockReturnValue(failChainable);

    await expect(
      repo.countByJob('job-id', 'tenant-id'),
    ).rejects.toThrow('Failed to count entities');
  });

  it('updateMergedData updates data and provenance', async () => {
    const updateChainable = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{
        id: 'entity-1',
        mergedData: { name: 'Updated' },
        provenance: { name: { provenanceType: 'merged' } },
      }]),
    };
    mockDb.update = vi.fn().mockReturnValue(updateChainable);

    const result = await repo.updateMergedData('entity-1', 'tenant-1', {
      mergedData: { name: 'Updated' },
      provenance: { name: { provenanceType: 'merged' } },
    });

    expect(mockDb.update).toHaveBeenCalled();
    expect(result.mergedData).toEqual({ name: 'Updated' });
  });

  it('updateMergedData throws StorageError when entity not found', async () => {
    const updateChainable = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };
    mockDb.update = vi.fn().mockReturnValue(updateChainable);

    await expect(
      repo.updateMergedData('nonexistent', 'tenant-1', {
        mergedData: { name: 'x' },
      }),
    ).rejects.toThrow('not found');
  });

  it('updateMergedData wraps DB errors in StorageError', async () => {
    const updateChainable = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockRejectedValue(new Error('connection lost')),
    };
    mockDb.update = vi.fn().mockReturnValue(updateChainable);

    await expect(
      repo.updateMergedData('entity-1', 'tenant-1', {
        mergedData: { name: 'x' },
      }),
    ).rejects.toThrow('Failed to update entity data');
  });

  it('updateMergedData with only mergedData calls update', async () => {
    const updateChainable = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{
        id: 'entity-1',
        mergedData: { name: 'Updated' },
      }]),
    };
    mockDb.update = vi.fn().mockReturnValue(updateChainable);

    const result = await repo.updateMergedData('entity-1', 'tenant-1', {
      mergedData: { name: 'Updated' },
    });

    expect(mockDb.update).toHaveBeenCalled();
    expect(updateChainable.set).toHaveBeenCalled();
    expect(result.mergedData).toEqual({ name: 'Updated' });
  });

  it('updateMergedData with only categories calls update', async () => {
    const updateChainable = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{
        id: 'entity-1',
        categories: ['electronics'],
      }]),
    };
    mockDb.update = vi.fn().mockReturnValue(updateChainable);

    const result = await repo.updateMergedData('entity-1', 'tenant-1', {
      categories: ['electronics'],
    });

    expect(mockDb.update).toHaveBeenCalled();
    expect(updateChainable.set).toHaveBeenCalled();
    expect(result.categories).toEqual(['electronics']);
  });

  describe('findByJobCursor', () => {
    it('returns entities and nextCursor when batch is full', async () => {
      const fullBatch = Array.from({ length: 3 }, (_, i) => ({
        id: `entity-${i}`,
        jobId: 'job-1',
        tenantId: 'tenant-1',
        mergedData: { name: `Entity ${i}` },
      }));

      const cursorChainable = {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(fullBatch),
        then: undefined as unknown,
      };
      cursorChainable.then = vi.fn((resolve: (v: unknown) => void) => resolve(fullBatch));
      mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(cursorChainable) });

      const result = await repo.findByJobCursor('job-1', 'tenant-1', 3);

      expect(mockDb.select).toHaveBeenCalled();
      expect(result.entities).toEqual(fullBatch);
      expect(result.nextCursor).toBe('entity-2');
    });

    it('returns entities and null nextCursor when batch is partial', async () => {
      const partialBatch = [
        { id: 'entity-0', jobId: 'job-1', tenantId: 'tenant-1', mergedData: { name: 'Only' } },
      ];

      const cursorChainable = {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(partialBatch),
        then: undefined as unknown,
      };
      cursorChainable.then = vi.fn((resolve: (v: unknown) => void) => resolve(partialBatch));
      mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(cursorChainable) });

      const result = await repo.findByJobCursor('job-1', 'tenant-1', 3);

      expect(result.entities).toEqual(partialBatch);
      expect(result.nextCursor).toBeNull();
    });

    it('wraps errors in StorageError', async () => {
      const failChainable = {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockRejectedValue(new Error('db error')),
        then: undefined as unknown,
      };
      failChainable.then = vi.fn((_: unknown, reject: (v: unknown) => void) =>
        reject(new Error('db error')),
      );
      mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(failChainable) });

      await expect(
        repo.findByJobCursor('job-1', 'tenant-1', 10),
      ).rejects.toThrow('Failed to fetch entities by cursor');
    });
  });
});
