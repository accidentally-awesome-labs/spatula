import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceTrustRepository } from '../../../src/repositories/source-trust-repository.js';

function createMockTx() {
  const chainable = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'trust-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'trust-id' }]));

  return {
    insert: vi.fn().mockReturnValue({
      values: vi
        .fn()
        .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'trust-id' }]) }),
    }),
    delete: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

function createMockDb() {
  const tx = createMockTx();
  const chainable = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'trust-id' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ id: 'trust-id' }]));

  return {
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(tx)),
    insert: vi.fn().mockReturnValue({
      values: vi
        .fn()
        .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'trust-id' }]) }),
    }),
    delete: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
    _tx: tx,
  };
}

describe('SourceTrustRepository', () => {
  let repo: SourceTrustRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new SourceTrustRepository(mockDb as any);
  });

  it('has upsert method', () => {
    expect(typeof repo.upsert).toBe('function');
  });

  it('has findByJob method', () => {
    expect(typeof repo.findByJob).toBe('function');
  });

  it('has findByDomain method', () => {
    expect(typeof repo.findByDomain).toBe('function');
  });

  it('upsert wraps delete+insert in a transaction', async () => {
    await repo.upsert({
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      domain: 'example.com',
      trustLevel: 'high',
      reasoning: 'Well-known source',
    });
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockDb._tx.delete).toHaveBeenCalled();
    expect(mockDb._tx.insert).toHaveBeenCalled();
  });

  it('findByJob calls db.select', async () => {
    await repo.findByJob(
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
    );
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('findByDomain calls db.select', async () => {
    await repo.findByDomain(
      'example.com',
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
    );
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('upsert wraps errors in StorageError', async () => {
    mockDb.transaction = vi.fn().mockRejectedValue(new Error('db error'));

    await expect(
      repo.upsert({
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        tenantId: '550e8400-e29b-41d4-a716-446655440001',
        domain: 'example.com',
        trustLevel: 'medium',
        reasoning: 'test',
      }),
    ).rejects.toThrow('Failed to upsert source trust');
  });

  it('findByJob wraps errors in StorageError', async () => {
    const failChainable = {
      where: vi.fn().mockRejectedValue(new Error('db error')),
      then: vi.fn((_: unknown, reject: (v: unknown) => void) => reject(new Error('db error'))),
    };
    mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(failChainable) });

    await expect(repo.findByJob('job-id', 'tenant-id')).rejects.toThrow(
      'Failed to find source trust records',
    );
  });

  it('findByDomain wraps errors in StorageError', async () => {
    const failChainable = {
      where: vi.fn().mockRejectedValue(new Error('db error')),
      then: vi.fn((_: unknown, reject: (v: unknown) => void) => reject(new Error('db error'))),
    };
    mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(failChainable) });

    await expect(repo.findByDomain('example.com', 'job-id', 'tenant-id')).rejects.toThrow(
      'Failed to find source trust for domain',
    );
  });
});
