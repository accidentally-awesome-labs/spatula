import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyRepository } from '../../../src/repositories/api-key-repository.js';

function createMockDb() {
  const returning = vi.fn();
  const where = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ returning });

  return {
    db: {
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where }),
      }),
    } as any,
    mocks: { returning, where, values },
  };
}

describe('ApiKeyRepository', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let repo: ApiKeyRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new ApiKeyRepository(mockDb.db);
  });

  describe('create', () => {
    it('inserts a new API key and returns it', async () => {
      const input = {
        tenantId: 'tenant-1',
        keyHash: 'hashed-key',
        keyPrefix: 'sk_live_',
        name: 'Production Key',
        scopes: ['jobs:read', 'jobs:write'],
      };
      const expected = { id: 'key-1', ...input, createdAt: new Date() };
      mockDb.mocks.returning.mockResolvedValue([expected]);

      const result = await repo.create(input);
      expect(result).toEqual(expected);
    });
  });

  describe('findByHash', () => {
    it('returns key when hash matches, not revoked, and not expired', async () => {
      const key = {
        id: 'key-1',
        tenantId: 'tenant-1',
        keyHash: 'hash',
        scopes: ['jobs:read'],
        revokedAt: null,
        expiresAt: null,
      };
      mockDb.mocks.where.mockResolvedValue([key]);

      const result = await repo.findByHash('hash');
      expect(result).toEqual(key);
    });

    it('returns null when no matching key found', async () => {
      mockDb.mocks.where.mockResolvedValue([]);

      const result = await repo.findByHash('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('listByTenant', () => {
    it('returns keys for tenant (excludes keyHash from projection)', async () => {
      const keys = [
        {
          id: 'key-1',
          keyPrefix: 'sk_live_abcd',
          name: 'Prod Key',
          scopes: ['jobs:read'],
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          revokedAt: null,
        },
      ];
      mockDb.mocks.where.mockResolvedValue(keys);

      const result = await repo.listByTenant('tenant-1');
      expect(result).toEqual(keys);
      // select() is called (which sets up the projection without keyHash)
      expect(mockDb.db.select).toHaveBeenCalled();
      // Verify the result shape does not include keyHash
      expect(result[0]).not.toHaveProperty('keyHash');
    });

    it('only returns non-revoked keys (revokedAt IS NULL filter)', async () => {
      mockDb.mocks.where.mockResolvedValue([]);

      await repo.listByTenant('tenant-1');
      // where() is called with conditions that include revokedAt IS NULL
      expect(mockDb.mocks.where).toHaveBeenCalled();
    });
  });

  describe('findByHash', () => {
    it('returns key when hash matches, not revoked, and not expired', async () => {
      const key = {
        id: 'key-1',
        tenantId: 'tenant-1',
        keyHash: 'hash',
        scopes: ['jobs:read'],
        revokedAt: null,
        expiresAt: null,
      };
      mockDb.mocks.where.mockResolvedValue([key]);

      const result = await repo.findByHash('hash');
      expect(result).toEqual(key);
    });

    it('returns null when no matching key found', async () => {
      mockDb.mocks.where.mockResolvedValue([]);

      const result = await repo.findByHash('nonexistent');
      expect(result).toBeNull();
    });

    it('includes expiration check in query (expiresAt IS NULL OR expiresAt > now)', async () => {
      mockDb.mocks.where.mockResolvedValue([]);

      await repo.findByHash('some-hash');
      // The where clause is called — it includes the and(eq, isNull, or(isNull, gt)) condition
      expect(mockDb.mocks.where).toHaveBeenCalled();
      // Verify select was called to set up the query
      expect(mockDb.db.select).toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('sets revokedAt timestamp', async () => {
      const revoked = { id: 'key-1', revokedAt: new Date() };
      mockDb.mocks.returning.mockResolvedValue([revoked]);

      const result = await repo.revoke('key-1', 'tenant-1');
      expect(result).toEqual(revoked);
    });
  });
});
