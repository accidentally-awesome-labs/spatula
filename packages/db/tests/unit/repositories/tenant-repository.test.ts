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
});
