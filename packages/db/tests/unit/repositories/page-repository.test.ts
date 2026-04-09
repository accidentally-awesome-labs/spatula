import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PageRepository } from '../../../src/repositories/page-repository.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'page-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'page-id' }]));

  return {
    insert: vi.fn().mockReturnValue({
      values: vi
        .fn()
        .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'page-id' }]) }),
    }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
    delete: vi.fn().mockReturnValue(chainable),
  };
}

describe('PageRepository', () => {
  let repo: PageRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new PageRepository(mockDb as any);
  });

  it('findByIds returns empty array for empty ids', async () => {
    const result = await repo.findByIds([], '550e8400-e29b-41d4-a716-446655440001');
    expect(result).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('create calls db.insert', async () => {
    await repo.create({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      contentRef: 'pg://content/abc123',
      contentHash: 'sha256-abc123',
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
