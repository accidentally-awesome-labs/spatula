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
});
