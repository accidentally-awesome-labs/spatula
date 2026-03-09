import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrawlTaskRepository } from '../../../src/repositories/crawl-task-repository.js';

function createMockDb() {
  const chainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'task-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'task-id' }]));

  return {
    insert: vi.fn().mockReturnValue({
      values: vi
        .fn()
        .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'task-id' }]) }),
    }),
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('CrawlTaskRepository', () => {
  let repo: CrawlTaskRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new CrawlTaskRepository(mockDb as any);
  });

  it('has enqueue method', () => {
    expect(typeof repo.enqueue).toBe('function');
  });

  it('has findByJob method', () => {
    expect(typeof repo.findByJob).toBe('function');
  });

  it('has updateStatus method', () => {
    expect(typeof repo.updateStatus).toBe('function');
  });

  it('has updateClassification method', () => {
    expect(typeof repo.updateClassification).toBe('function');
  });

  it('enqueue calls db.insert', async () => {
    await repo.enqueue({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      url: 'https://example.com',
      depth: 0,
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
