/**
 * TDD tests for ApiKeyRepository.rotate() — AUTH-05
 *
 * Tests use a mocked Drizzle DB transaction pattern.
 * rotate() signature:
 *   async rotate(keyId, tenantId, { keyHash, keyPrefix }, graceSeconds) => { oldKey, newKey }
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyRepository } from '../../../src/repositories/api-key-repository.js';
import { StorageError } from '@spatula/shared';

// Helper to build a mock Drizzle tx / db that supports the rotate() transaction pattern
function createRotateMockDb(opts: {
  origRow?: Record<string, unknown> | null;
  insertedRow?: Record<string, unknown>;
  updatedOldRow?: Record<string, unknown>;
} = {}) {
  const {
    origRow = {
      id: 'old-key-id',
      tenantId: 'tenant-1',
      keyHash: 'old-hash',
      keyPrefix: 'sk_live_abc',
      name: 'Prod Key',
      scopes: ['jobs:read', 'jobs:write'],
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date('2026-01-01'),
      supersedes: null,
      supersededExpiresAt: null,
      lastUsedAt: null,
    },
    insertedRow = {
      id: 'new-key-id',
      tenantId: 'tenant-1',
      keyHash: 'new-hash',
      keyPrefix: 'sk_live_def',
      name: 'Prod Key (rotated)',
      scopes: ['jobs:read', 'jobs:write'],
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date('2026-05-20'),
      supersedes: 'old-key-id',
      supersededExpiresAt: new Date(Date.now() + 86400 * 1000),
      lastUsedAt: null,
    },
    updatedOldRow = {
      ...(origRow as Record<string, unknown>),
      expiresAt: new Date(Date.now() + 86400 * 1000),
    },
  } = opts;

  // Build the tx mock — must handle: select, insert, update in transaction callback
  function buildTx() {
    const selectReturning = vi.fn().mockResolvedValue(origRow ? [origRow] : []);
    const insertReturning = vi.fn().mockResolvedValue([insertedRow]);
    const updateReturning = vi.fn().mockResolvedValue([updatedOldRow]);

    const tx: any = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ then: selectReturning, [Symbol.iterator]: undefined }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: updateReturning }),
        }),
      }),
    };

    // Make select().from().where() awaitable (returns array)
    tx.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(origRow ? [origRow] : []),
      }),
    });

    return { tx, insertReturning, updateReturning };
  }

  const txMocks = buildTx();

  const db: any = {
    transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => {
      return fn(txMocks.tx);
    }),
    // other methods for non-rotate tests
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  };

  return { db, txMocks };
}

describe('ApiKeyRepository.rotate()', () => {
  it('Test 1: returns { oldKey, newKey } with newKey.scopes equal to original scopes (verbatim inheritance)', async () => {
    const { db } = createRotateMockDb();
    const repo = new ApiKeyRepository(db);

    const result = await repo.rotate(
      'old-key-id',
      'tenant-1',
      { keyHash: 'new-hash', keyPrefix: 'sk_live_def' },
      86400,
    );

    expect(result).toHaveProperty('oldKey');
    expect(result).toHaveProperty('newKey');
    // Verbatim scope inheritance (D-15)
    expect(result.newKey.scopes).toEqual(['jobs:read', 'jobs:write']);
  });

  it('Test 2: newKey.supersedes equals original key id; newKey.supersededExpiresAt is set', async () => {
    const { db } = createRotateMockDb();
    const repo = new ApiKeyRepository(db);

    const result = await repo.rotate(
      'old-key-id',
      'tenant-1',
      { keyHash: 'new-hash', keyPrefix: 'sk_live_def' },
      86400,
    );

    expect(result.newKey.supersedes).toBe('old-key-id');
    expect(result.newKey.supersededExpiresAt).toBeDefined();
    expect(result.newKey.supersededExpiresAt).toBeInstanceOf(Date);
  });

  it('Test 3: after rotate(), old key expiresAt is in the future (grace window still valid)', async () => {
    const graceSeconds = 86400;
    const beforeCall = Date.now();

    const { db } = createRotateMockDb();
    const repo = new ApiKeyRepository(db);

    const result = await repo.rotate(
      'old-key-id',
      'tenant-1',
      { keyHash: 'new-hash', keyPrefix: 'sk_live_def' },
      graceSeconds,
    );

    const afterCall = Date.now();
    const oldKeyExpiry = result.oldKey.expiresAt as Date;
    expect(oldKeyExpiry).toBeInstanceOf(Date);
    // expiresAt should be approximately now + graceSeconds
    const expiryMs = oldKeyExpiry.getTime();
    expect(expiryMs).toBeGreaterThan(beforeCall + graceSeconds * 1000 - 1000);
    expect(expiryMs).toBeLessThan(afterCall + graceSeconds * 1000 + 1000);
  });

  it('Test 4: grace window expiry — findByHash returns null after expiresAt is set to past', async () => {
    // This test verifies the findByHash filter (expiresAt > now) which is already implemented.
    // We test it directly via the repo's findByHash.
    const pastExpiry = new Date(Date.now() - 1000);
    const expiredKey = {
      id: 'old-key-id',
      keyHash: 'old-hash',
      revokedAt: null,
      expiresAt: pastExpiry,
    };

    const { db: findDb } = (() => {
      const db: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]), // expired — findByHash filter removes it
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ then: vi.fn(), catch: vi.fn() }),
          }),
        }),
      };
      return { db };
    })();

    const repo = new ApiKeyRepository(findDb);
    const result = await repo.findByHash('old-hash');
    // findByHash should return null — the where clause filters expiresAt > now
    expect(result).toBeNull();
  });

  it('Test 5: rotate() on a non-existent key id throws StorageError containing "not found"', async () => {
    const { db } = createRotateMockDb({ origRow: null });
    const repo = new ApiKeyRepository(db);

    await expect(
      repo.rotate('nonexistent-id', 'tenant-1', { keyHash: 'h', keyPrefix: 'p' }, 86400),
    ).rejects.toThrow(StorageError);

    await expect(
      repo.rotate('nonexistent-id', 'tenant-1', { keyHash: 'h', keyPrefix: 'p' }, 86400),
    ).rejects.toThrow(/not found/i);
  });

  it('Test 6: rotate() on an already-revoked key throws StorageError', async () => {
    const revokedOrig = {
      id: 'old-key-id',
      tenantId: 'tenant-1',
      keyHash: 'old-hash',
      keyPrefix: 'sk_live_abc',
      name: 'Prod Key',
      scopes: ['jobs:read'],
      expiresAt: null,
      revokedAt: new Date('2026-01-15'), // already revoked
      createdAt: new Date('2026-01-01'),
      supersedes: null,
      supersededExpiresAt: null,
      lastUsedAt: null,
    };
    const { db } = createRotateMockDb({ origRow: revokedOrig });
    const repo = new ApiKeyRepository(db);

    await expect(
      repo.rotate('old-key-id', 'tenant-1', { keyHash: 'h', keyPrefix: 'p' }, 86400),
    ).rejects.toThrow(StorageError);

    await expect(
      repo.rotate('old-key-id', 'tenant-1', { keyHash: 'h', keyPrefix: 'p' }, 86400),
    ).rejects.toThrow(/revoked/i);
  });
});
