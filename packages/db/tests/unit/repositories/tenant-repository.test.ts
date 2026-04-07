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

  describe('updatePlan', () => {
    it('updates plan column', async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        update: vi.fn().mockReturnValue({ set: mockSet }),
      };

      const repo = new TenantRepository(db as any);
      await expect(repo.updatePlan('tenant-1', 'pro')).resolves.toBeUndefined();
      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ plan: 'pro' }));
    });

    it('updates plan and stripeCustomerId together', async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        update: vi.fn().mockReturnValue({ set: mockSet }),
      };

      const repo = new TenantRepository(db as any);
      await repo.updatePlan('tenant-1', 'starter', 'cus_abc');
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ plan: 'starter', stripeCustomerId: 'cus_abc' }));
    });

    it('invalidates cache on success', async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        update: vi.fn().mockReturnValue({ set: mockSet }),
      };
      const mockCache = { delete: vi.fn().mockResolvedValue(undefined), getOrFetch: vi.fn() };

      const repo = new TenantRepository(db as any);
      repo.setCache(mockCache as any);
      await repo.updatePlan('tenant-1', 'pro');
      expect(mockCache.delete).toHaveBeenCalledWith('tenant:tenant-1:quotas');
    });
  });

  describe('getPlan', () => {
    it('returns the plan for an existing tenant', async () => {
      const mockWhere = vi.fn().mockResolvedValue([{ plan: 'pro' }]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const result = await repo.getPlan('tenant-1');
      expect(result).toBe('pro');
    });

    it('throws StorageError for non-existent tenant', async () => {
      const mockWhere = vi.fn().mockResolvedValue([]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      await expect(repo.getPlan('nonexistent')).rejects.toThrow('Tenant nonexistent not found');
    });
  });

  describe('findByStripeCustomerId', () => {
    it('returns tenant when found', async () => {
      const tenant = { id: 'tenant-1', name: 'Corp', stripeCustomerId: 'cus_abc' };
      const mockWhere = vi.fn().mockResolvedValue([tenant]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const result = await repo.findByStripeCustomerId('cus_abc');
      expect(result).toEqual(tenant);
    });

    it('returns null when not found', async () => {
      const mockWhere = vi.fn().mockResolvedValue([]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const result = await repo.findByStripeCustomerId('cus_nonexistent');
      expect(result).toBeNull();
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

  describe('findAll', () => {
    it('returns paginated tenants with plan filter', async () => {
      const rows = [
        { id: 't1', name: 'Tenant 1', plan: 'free', config: {}, createdAt: new Date() },
      ];
      const mockOffset = vi.fn().mockResolvedValue(rows);
      const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockOrderBy = vi.fn().mockReturnValue({ where: mockWhere, limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const results = await repo.findAll({ plan: 'free', limit: 10, offset: 0 });
      expect(results).toHaveLength(1);
      expect(db.select).toHaveBeenCalled();
    });

    it('returns all tenants without plan filter', async () => {
      const rows = [
        { id: 't1', name: 'Tenant 1', plan: 'free', config: {}, createdAt: new Date() },
        { id: 't2', name: 'Tenant 2', plan: 'pro', config: {}, createdAt: new Date() },
      ];
      const mockOffset = vi.fn().mockResolvedValue(rows);
      const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
      const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const results = await repo.findAll();
      expect(results).toHaveLength(2);
    });
  });

  describe('countAll', () => {
    it('returns count of all tenants', async () => {
      const mockFrom = vi.fn().mockResolvedValue([{ count: 5 }]);
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const count = await repo.countAll();
      expect(count).toBe(5);
    });

    it('returns count filtered by plan', async () => {
      const mockWhere = vi.fn().mockResolvedValue([{ count: 3 }]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const count = await repo.countAll({ plan: 'free' });
      expect(count).toBe(3);
    });

    it('returns 0 when no rows returned', async () => {
      const mockFrom = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const count = await repo.countAll();
      expect(count).toBe(0);
    });
  });

  describe('getTotalStorage', () => {
    it('returns sum of storage_bytes_used across all tenants', async () => {
      const mockFrom = vi.fn().mockResolvedValue([{ total: 1048576 }]);
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const total = await repo.getTotalStorage();
      expect(total).toBe(1048576);
    });

    it('returns 0 when no tenants exist', async () => {
      const mockFrom = vi.fn().mockResolvedValue([{ total: 0 }]);
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new TenantRepository(db as any);
      const total = await repo.getTotalStorage();
      expect(total).toBe(0);
    });
  });
});
