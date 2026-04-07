import { describe, it, expect, vi } from 'vitest';
import { JobRepository } from '../../../src/repositories/job-repository.js';

function createMockDb() {
  const chain: any = {};
  const methods = ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'update', 'set', 'returning'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.offset = vi.fn().mockResolvedValue([]);
  chain.returning = vi.fn().mockResolvedValue([]);
  chain.select = vi.fn().mockReturnValue(chain);
  return chain;
}

describe('JobRepository.findAll', () => {
  it('returns jobs without tenant scoping', async () => {
    const db = createMockDb();
    const jobs = [{ id: 'job-1', tenantId: 't1', status: 'running' }];
    db.offset = vi.fn().mockResolvedValue(jobs);
    const repo = new JobRepository(db as any);
    const result = await repo.findAll({ limit: 10, offset: 0 });
    expect(result).toEqual(jobs);
    expect(db.select).toHaveBeenCalled();
  });

  it('applies status filter when provided', async () => {
    const db = createMockDb();
    db.offset = vi.fn().mockResolvedValue([]);
    const repo = new JobRepository(db as any);
    await repo.findAll({ status: 'running' as any });
    expect(db.where).toHaveBeenCalled();
  });
});

describe('JobRepository.countAll', () => {
  it('returns count of all jobs', async () => {
    const db = createMockDb();
    db.from = vi.fn().mockResolvedValue([{ count: 42 }]);
    const repo = new JobRepository(db as any);
    const count = await repo.countAll();
    expect(count).toBe(42);
  });
});

describe('JobRepository.forceCancel', () => {
  it('returns updated job on success', async () => {
    const db = createMockDb();
    const cancelled = { id: 'job-1', status: 'cancelled', completedAt: new Date() };
    db.returning = vi.fn().mockResolvedValue([cancelled]);
    const repo = new JobRepository(db as any);
    const result = await repo.forceCancel('job-1');
    expect(result).toEqual(cancelled);
    expect(db.update).toHaveBeenCalled();
  });

  it('returns null when job not found', async () => {
    const db = createMockDb();
    db.returning = vi.fn().mockResolvedValue([]);
    const repo = new JobRepository(db as any);
    const result = await repo.forceCancel('nonexistent');
    expect(result).toBeNull();
  });
});
