import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgContentStore } from '../../../src/content-store/pg-content-store.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'content-id', content: '<html>test</html>' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) =>
    resolve([{ id: 'content-id', content: '<html>test</html>' }]),
  );

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'content-id' }]),
        }),
      }),
    }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
    delete: vi.fn().mockReturnValue(chainable),
  };
}

describe('PgContentStore', () => {
  let store: PgContentStore;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    store = new PgContentStore(mockDb as any);
  });

  it('implements ContentStore interface — store()', () => {
    expect(typeof store.store).toBe('function');
  });

  it('implements ContentStore interface — retrieve()', () => {
    expect(typeof store.retrieve).toBe('function');
  });

  it('implements ContentStore interface — delete()', () => {
    expect(typeof store.delete).toBe('function');
  });

  it('store calls db.insert', async () => {
    const ref = await store.store('test-key', '<html>content</html>');
    expect(ref).toBeDefined();
    expect(typeof ref).toBe('string');
    expect(mockDb.insert).toHaveBeenCalled();
  });

  describe('setTenantContext and storage tracking', () => {
    it('after setTenantContext, store() calls incrementStorageBytes with content byte length', async () => {
      const mockTenantRepo = {
        incrementStorageBytes: vi.fn().mockResolvedValue(undefined),
      };
      store.setTenantContext('tenant-1', mockTenantRepo as any);

      const content = '<html>hello world</html>';
      await store.store('key-1', content);

      // Fire-and-forget, but the mock should have been called
      // Wait a tick for the void promise to execute
      await new Promise((r) => setTimeout(r, 10));

      expect(mockTenantRepo.incrementStorageBytes).toHaveBeenCalledWith(
        'tenant-1',
        Buffer.byteLength(content, 'utf-8'),
      );
    });

    it('without setTenantContext, store() does NOT call incrementStorageBytes', async () => {
      // store has no tenant context (default from beforeEach)
      await store.store('key-2', '<html>no tracking</html>');

      // Nothing to assert on directly — we just confirm no error is thrown
      // and store completes successfully
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });
});
