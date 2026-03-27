import { describe, it, expect, vi } from 'vitest';
import { TenantRepository } from '../../../src/repositories/tenant-repository.js';

function createMockDb() {
  const mockReturning = vi.fn();
  const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });

  const db = {
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
    _mocks: { mockReturning, mockWhere, mockSet, mockValues },
  };

  return db;
}

describe('TenantRepository', () => {
  describe('create', () => {
    it('inserts a tenant with name and optional config', async () => {
      const db = createMockDb();
      db._mocks.mockReturning.mockResolvedValue([
        { id: 'tenant-1', name: 'Test Corp', config: {}, createdAt: new Date() },
      ]);

      const repo = new TenantRepository(db as any);
      const result = await repo.create({ name: 'Test Corp' });

      expect(result.id).toBe('tenant-1');
      expect(result.name).toBe('Test Corp');
    });
  });

  describe('findById', () => {
    it('returns null when not found', async () => {
      const db = createMockDb();
      const repo = new TenantRepository(db as any);
      const result = await repo.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('updates tenant fields and returns updated row', async () => {
      const db = createMockDb();
      db._mocks.mockReturning.mockResolvedValue([
        { id: 'tenant-1', name: 'Updated Corp', config: { key: 'val' }, createdAt: new Date() },
      ]);

      const repo = new TenantRepository(db as any);
      const result = await repo.update('tenant-1', { name: 'Updated Corp', config: { key: 'val' } });

      expect(result.name).toBe('Updated Corp');
    });
  });

  describe('getQuotas', () => {
    it('returns quotas for an existing tenant', async () => {
      const quotas = { maxConcurrentJobs: 5, maxPagesPerJob: 1000 };
      const mockWhere = vi.fn().mockResolvedValue([{ quotas }]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const result = await repo.getQuotas('tenant-1');

      expect(result).toEqual(quotas);
    });

    it('throws StorageError for non-existent tenant', async () => {
      const mockWhere = vi.fn().mockResolvedValue([]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      await expect(repo.getQuotas('nonexistent')).rejects.toThrow('Tenant nonexistent not found');
    });
  });

  describe('incrementStorageBytes', () => {
    it('updates the storage counter', async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        update: vi.fn().mockReturnValue({ set: mockSet }),
      };

      const repo = new TenantRepository(db as any);
      await expect(repo.incrementStorageBytes('tenant-1', 1024)).resolves.toBeUndefined();

      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalled();
    });
  });
});
