import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtractionRepository } from '../../../src/repositories/extraction-repository.js';

function createMockDb(resolveValue?: unknown) {
  const value = resolveValue ?? [{ id: 'extraction-id' }];
  const chainable = {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(value),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve(value));

  return {
    insert: vi.fn().mockReturnValue({
      values: vi
        .fn()
        .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'extraction-id' }]) }),
    }),
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

  it('store calls db.insert', async () => {
    await repo.store({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      pageId: '550e8400-e29b-41d4-a716-446655440002',
      schemaVersion: 1,
      data: { name: 'Test' },
      unmappedFields: [],
      metadata: {
        confidence: 0.9,
        modelUsed: 'test',
        tokensUsed: 100,
        extractionTimeMs: 50,
        unmappedFields: [],
      },
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});

describe('ExtractionRepository.findByJobCursor', () => {
  const JOB_ID = '550e8400-e29b-41d4-a716-446655440000';
  const TENANT_ID = '550e8400-e29b-41d4-a716-446655440001';

  it('returns entities and nextCursor when batch is full', async () => {
    const rows = [
      { id: 'id-1', jobId: JOB_ID, tenantId: TENANT_ID },
      { id: 'id-2', jobId: JOB_ID, tenantId: TENANT_ID },
    ];
    const db = createMockDb(rows);
    const repo = new ExtractionRepository(db as any);

    const result = await repo.findByJobCursor(JOB_ID, TENANT_ID, 2);

    expect(result.entities).toEqual(rows);
    expect(result.nextCursor).toBe('id-2');
  });

  it('returns null nextCursor on last page', async () => {
    const rows = [{ id: 'id-1', jobId: JOB_ID, tenantId: TENANT_ID }];
    const db = createMockDb(rows);
    const repo = new ExtractionRepository(db as any);

    const result = await repo.findByJobCursor(JOB_ID, TENANT_ID, 2);

    expect(result.entities).toEqual(rows);
    expect(result.nextCursor).toBeNull();
  });

  it('passes cursor and since to query', async () => {
    const db = createMockDb([]);
    const repo = new ExtractionRepository(db as any);

    await repo.findByJobCursor(JOB_ID, TENANT_ID, 10, 'cursor-abc', '2026-03-01T00:00:00Z');

    expect(db.select).toHaveBeenCalled();
  });
});

describe('ExtractionRepository.countByJob', () => {
  const JOB_ID = '550e8400-e29b-41d4-a716-446655440000';
  const TENANT_ID = '550e8400-e29b-41d4-a716-446655440001';

  it('returns count from db', async () => {
    const db = createMockDb([{ count: 42 }]);
    const repo = new ExtractionRepository(db as any);

    const count = await repo.countByJob(JOB_ID, TENANT_ID);

    expect(count).toBe(42);
  });

  it('returns 0 when result is empty', async () => {
    const db = createMockDb([]);
    const repo = new ExtractionRepository(db as any);

    const count = await repo.countByJob(JOB_ID, TENANT_ID);

    expect(count).toBe(0);
  });
});
