import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntitySourceRepository } from '../../../src/repositories/entity-source-repository.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ entityId: 'e-id', extractionId: 'x-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) =>
    resolve([{ entityId: 'e-id', extractionId: 'x-id' }]),
  );

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ entityId: 'e-id', extractionId: 'x-id' }]),
      }),
    }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('EntitySourceRepository', () => {
  let repo: EntitySourceRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new EntitySourceRepository(mockDb as any);
  });

  it('has link method', () => {
    expect(typeof repo.link).toBe('function');
  });

  it('has bulkLink method', () => {
    expect(typeof repo.bulkLink).toBe('function');
  });

  it('has findByEntity method', () => {
    expect(typeof repo.findByEntity).toBe('function');
  });

  it('link calls db.insert', async () => {
    await repo.link('entity-id', 'extraction-id', 0.9);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('bulkLink calls db.insert', async () => {
    await repo.bulkLink([
      { entityId: 'e1', extractionId: 'x1', matchConfidence: 0.9 },
      { entityId: 'e2', extractionId: 'x2', matchConfidence: 0.85 },
    ]);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('bulkLink with empty array does not call db.insert', async () => {
    await repo.bulkLink([]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('findByEntity calls db.select', async () => {
    await repo.findByEntity('entity-id');
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('link wraps errors in StorageError', async () => {
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('db error')),
      }),
    });

    await expect(repo.link('e-id', 'x-id', 0.9)).rejects.toThrow('Failed to link entity source');
  });

  it('bulkLink wraps errors in StorageError', async () => {
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('db error')),
      }),
    });

    await expect(
      repo.bulkLink([{ entityId: 'e1', extractionId: 'x1', matchConfidence: 0.9 }]),
    ).rejects.toThrow('Failed to bulk link entity sources');
  });

  it('findByEntity wraps errors in StorageError', async () => {
    const failChainable = {
      where: vi.fn().mockRejectedValue(new Error('db error')),
      then: vi.fn((_: unknown, reject: (v: unknown) => void) => reject(new Error('db error'))),
    };
    mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(failChainable) });

    await expect(repo.findByEntity('entity-id')).rejects.toThrow('Failed to find entity sources');
  });

  describe('findByJobCursor composite cursor', () => {
    function makeCursorMockDb(rows: Array<{ entityId: string; extractionId: string; matchConfidence: number }>) {
      const orderBy = vi.fn().mockReturnThis();
      const limit = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ orderBy, limit });
      const innerJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ innerJoin });
      return {
        select: vi.fn().mockReturnValue({ from }),
        _orderBy: orderBy,
        _where: where,
      };
    }

    it('returns composite nextCursor (entityId + extractionId) when page is full', async () => {
      const rows = [
        { entityId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', extractionId: '11111111-1111-1111-1111-111111111111', matchConfidence: 0.9 },
        { entityId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', extractionId: '22222222-2222-2222-2222-222222222222', matchConfidence: 0.8 },
      ];
      const db = makeCursorMockDb(rows);
      const r = new EntitySourceRepository(db as any);

      const result = await r.findByJobCursor('job-1', 'tenant-1', 2);

      expect(result.nextCursor).toEqual({
        entityId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        extractionId: '22222222-2222-2222-2222-222222222222',
      });
      // Order by BOTH columns — prevents dropping rows split across page boundary
      expect(db._orderBy).toHaveBeenCalled();
      const orderByArgs = db._orderBy.mock.calls[0];
      expect(orderByArgs.length).toBe(2);
    });

    it('returns null nextCursor when rows < limit', async () => {
      const db = makeCursorMockDb([
        { entityId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', extractionId: '11111111-1111-1111-1111-111111111111', matchConfidence: 0.9 },
      ]);
      const r = new EntitySourceRepository(db as any);
      const result = await r.findByJobCursor('job-1', 'tenant-1', 10);
      expect(result.nextCursor).toBeNull();
    });

    it('accepts composite cursor object (not plain string)', async () => {
      const db = makeCursorMockDb([]);
      const r = new EntitySourceRepository(db as any);
      // Must not throw — proves signature change landed
      await r.findByJobCursor('job-1', 'tenant-1', 10, {
        entityId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        extractionId: '11111111-1111-1111-1111-111111111111',
      });
      expect(db._where).toHaveBeenCalled();
    });
  });
});
