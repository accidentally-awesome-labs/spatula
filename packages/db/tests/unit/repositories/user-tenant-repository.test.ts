import { describe, it, expect, vi } from 'vitest';
import { UserTenantRepository } from '../../../src/repositories/user-tenant-repository.js';

function createMockDb() {
  const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
  const mockWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });

  const db = {
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
    delete: vi.fn().mockReturnValue({ where: mockWhere }),
    _mocks: { mockOnConflictDoNothing, mockValues, mockWhere, mockSet },
  };

  return db;
}

describe('UserTenantRepository', () => {
  describe('create', () => {
    it('calls insert with onConflictDoNothing', async () => {
      const db = createMockDb();
      const repo = new UserTenantRepository(db as any);

      await repo.create('user-1', 'tenant-1', 'member');

      expect(db.insert).toHaveBeenCalled();
      expect(db._mocks.mockValues).toHaveBeenCalledWith({
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'member',
      });
      expect(db._mocks.mockOnConflictDoNothing).toHaveBeenCalled();
    });
  });

  describe('findByUserId', () => {
    it('returns matching entries for a user', async () => {
      const now = new Date();
      const entries = [
        { tenantId: 'tenant-1', role: 'owner', createdAt: now },
        { tenantId: 'tenant-2', role: 'member', createdAt: now },
      ];

      const mockWhere = vi.fn().mockResolvedValue(entries);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new UserTenantRepository(db as any);
      const result = await repo.findByUserId('user-1');

      expect(result).toHaveLength(2);
      expect(result[0].tenantId).toBe('tenant-1');
      expect(result[1].role).toBe('member');
    });

    it('returns empty array for unknown user', async () => {
      const db = createMockDb();
      const repo = new UserTenantRepository(db as any);
      const result = await repo.findByUserId('unknown-user');

      expect(result).toEqual([]);
    });
  });

  describe('findByTenantId', () => {
    it('returns matching entries for a tenant', async () => {
      const now = new Date();
      const entries = [
        { userId: 'user-1', role: 'owner', createdAt: now },
        { userId: 'user-2', role: 'member', createdAt: now },
      ];

      const mockWhere = vi.fn().mockResolvedValue(entries);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      };

      const repo = new UserTenantRepository(db as any);
      const result = await repo.findByTenantId('tenant-1');

      expect(result).toHaveLength(2);
      expect(result[0].userId).toBe('user-1');
      expect(result[1].userId).toBe('user-2');
    });
  });

  describe('updateRole', () => {
    it('calls update with new role', async () => {
      const db = createMockDb();
      const repo = new UserTenantRepository(db as any);

      await repo.updateRole('user-1', 'tenant-1', 'admin');

      expect(db.update).toHaveBeenCalled();
      expect(db._mocks.mockSet).toHaveBeenCalledWith({ role: 'admin' });
      expect(db._mocks.mockWhere).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('calls delete with correct conditions', async () => {
      const db = createMockDb();
      const repo = new UserTenantRepository(db as any);

      await repo.remove('user-1', 'tenant-1');

      expect(db.delete).toHaveBeenCalled();
      expect(db._mocks.mockWhere).toHaveBeenCalled();
    });
  });

  describe('isAdmin', () => {
    it('returns true for owner role', async () => {
      const mockWhere = vi.fn().mockResolvedValue([{ role: 'owner' }]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = { select: vi.fn().mockReturnValue({ from: mockFrom }) };

      const repo = new UserTenantRepository(db as any);
      const result = await repo.isAdmin('user-1', 'tenant-1');

      expect(result).toBe(true);
    });

    it('returns true for admin role', async () => {
      const mockWhere = vi.fn().mockResolvedValue([{ role: 'admin' }]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = { select: vi.fn().mockReturnValue({ from: mockFrom }) };

      const repo = new UserTenantRepository(db as any);
      const result = await repo.isAdmin('user-1', 'tenant-1');

      expect(result).toBe(true);
    });

    it('returns false for member role', async () => {
      const mockWhere = vi.fn().mockResolvedValue([{ role: 'member' }]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = { select: vi.fn().mockReturnValue({ from: mockFrom }) };

      const repo = new UserTenantRepository(db as any);
      const result = await repo.isAdmin('user-1', 'tenant-1');

      expect(result).toBe(false);
    });

    it('returns false for unknown user (empty result)', async () => {
      const mockWhere = vi.fn().mockResolvedValue([]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = { select: vi.fn().mockReturnValue({ from: mockFrom }) };

      const repo = new UserTenantRepository(db as any);
      const result = await repo.isAdmin('unknown-user', 'tenant-1');

      expect(result).toBe(false);
    });
  });

  describe('error handling', () => {
    it('throws StorageError when create fails', async () => {
      const db = createMockDb();
      db._mocks.mockOnConflictDoNothing.mockRejectedValue(new Error('DB down'));
      const repo = new UserTenantRepository(db as any);

      await expect(repo.create('user-1', 'tenant-1', 'member')).rejects.toThrow(
        'Failed to create user-tenant relationship',
      );
    });

    it('throws StorageError when findByUserId fails', async () => {
      const mockWhere = vi.fn().mockRejectedValue(new Error('DB down'));
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = { select: vi.fn().mockReturnValue({ from: mockFrom }) };
      const repo = new UserTenantRepository(db as any);

      await expect(repo.findByUserId('user-1')).rejects.toThrow('Failed to find tenants for user');
    });

    it('throws StorageError when isAdmin fails', async () => {
      const mockWhere = vi.fn().mockRejectedValue(new Error('DB down'));
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = { select: vi.fn().mockReturnValue({ from: mockFrom }) };
      const repo = new UserTenantRepository(db as any);

      await expect(repo.isAdmin('user-1', 'tenant-1')).rejects.toThrow(
        'Failed to check admin status',
      );
    });
  });
});
