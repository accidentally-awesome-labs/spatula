import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtractionRepository } from '../../../src/repositories/extraction-repository.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'extraction-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'extraction-id' }]));

  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'extraction-id' }]) }) }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('ExtractionRepository', () => {
  let repo: ExtractionRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new ExtractionRepository(mockDb as any);
  });

  it('has store method', () => {
    expect(typeof repo.store).toBe('function');
  });

  it('has findByJob method', () => {
    expect(typeof repo.findByJob).toBe('function');
  });

  it('has findByPage method', () => {
    expect(typeof repo.findByPage).toBe('function');
  });

  it('store calls db.insert', async () => {
    await repo.store({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      pageId: '550e8400-e29b-41d4-a716-446655440002',
      schemaVersion: 1,
      data: { name: 'Test' },
      unmappedFields: [],
      metadata: { confidence: 0.9, modelUsed: 'test', tokensUsed: 100, extractionTimeMs: 50, unmappedFields: [] },
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
