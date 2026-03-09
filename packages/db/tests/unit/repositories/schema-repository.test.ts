import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaRepository } from '../../../src/repositories/schema-repository.js';

function createMockDb() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'schema-id', version: 1 }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'schema-id', version: 1 }]));

  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'schema-id', version: 1 }]) }) }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('SchemaRepository', () => {
  let repo: SchemaRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new SchemaRepository(mockDb as any);
  });

  it('has create method', () => {
    expect(typeof repo.create).toBe('function');
  });

  it('has findLatest method', () => {
    expect(typeof repo.findLatest).toBe('function');
  });

  it('has findByVersion method', () => {
    expect(typeof repo.findByVersion).toBe('function');
  });

  it('has findAllVersions method', () => {
    expect(typeof repo.findAllVersions).toBe('function');
  });

  it('create calls db.insert', async () => {
    await repo.create({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      version: 1,
      definition: {} as any,
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
