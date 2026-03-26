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

  describe('revoke', () => {
    it('sets revokedAt timestamp', async () => {
      const revoked = { id: 'key-1', revokedAt: new Date() };
      mockDb.mocks.returning.mockResolvedValue([revoked]);

      const result = await repo.revoke('key-1', 'tenant-1');
      expect(result).toEqual(revoked);
    });
  });
});
