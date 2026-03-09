import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobRepository } from '../../../src/repositories/job-repository.js';

// We test the repository against a mock db object to verify query construction
// Integration tests against real Postgres come in Task 13

function createMockDb() {
  const chainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]),
    then: undefined as unknown,
  };
  // Make chainable thenable so await works
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'test-id' }]));

  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]) }) }),
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
    delete: vi.fn().mockReturnValue(chainable),
  };
}

describe('JobRepository', () => {
  let repo: JobRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new JobRepository(mockDb as any);
  });

  it('has create method', () => {
    expect(typeof repo.create).toBe('function');
  });

  it('has findById method', () => {
    expect(typeof repo.findById).toBe('function');
  });

  it('has findByTenant method', () => {
    expect(typeof repo.findByTenant).toBe('function');
  });

  it('has updateStatus method', () => {
    expect(typeof repo.updateStatus).toBe('function');
  });

  it('has updateStats method', () => {
    expect(typeof repo.updateStats).toBe('function');
  });

  it('create calls db.insert', async () => {
    await repo.create({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Test Job',
      description: 'Test',
      config: {} as any,
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
