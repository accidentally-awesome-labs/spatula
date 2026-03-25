import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DlqRepository } from '../../../src/repositories/dlq-repository.js';

/**
 * Mock DB that captures the arguments passed to each Drizzle method.
 * The chain pattern (select().from().where()...) returns `this` at each
 * step, so we can inspect which methods were called and with what args.
 */
function createMockDb() {
  const mock = {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'dlq-1', queueName: 'spatula.crawl', jobId: 'bullmq-123', resolvedAt: null }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return mock;
}

describe('DlqRepository', () => {
  let db: ReturnType<typeof createMockDb>;
  let repo: DlqRepository;

  beforeEach(() => {
    db = createMockDb();
    repo = new DlqRepository(db as any);
  });

  it('insert passes all fields to Drizzle insert().values()', async () => {
    const input = {
      queueName: 'spatula.crawl',
      jobId: 'bullmq-job-123',
      tenantId: 'tenant-1',
      spatulaJobId: 'job-1',
      payload: { taskId: 'task-1', url: 'https://example.com' },
      errorMessage: 'Network timeout',
      errorStack: 'Error: Network timeout\n    at ...',
      attempts: 3,
    };

    const result = await repo.insert(input);

    expect(result).toEqual({ id: 'dlq-1' });
    expect(db.insert).toHaveBeenCalled();
    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({
      queueName: 'spatula.crawl',
      jobId: 'bullmq-job-123',
      tenantId: 'tenant-1',
      spatulaJobId: 'job-1',
      payload: { taskId: 'task-1', url: 'https://example.com' },
      errorMessage: 'Network timeout',
      errorStack: expect.stringContaining('Network timeout'),
      attempts: 3,
    }));
    expect(db.returning).toHaveBeenCalled();
  });

  it('insert wraps DB errors in StorageError', async () => {
    db.returning = vi.fn().mockRejectedValue(new Error('connection refused'));

    await expect(
      repo.insert({ queueName: 'q', jobId: 'j', payload: {}, attempts: 1 }),
    ).rejects.toThrow('Failed to insert DLQ entry');
  });

  it('findUnresolved applies default limit=50, offset=0', async () => {
    await repo.findUnresolved();

    expect(db.select).toHaveBeenCalled();
    expect(db.where).toHaveBeenCalled();
    expect(db.orderBy).toHaveBeenCalled();
    expect(db.limit).toHaveBeenCalledWith(50);
    expect(db.offset).toHaveBeenCalledWith(0);
  });

  it('findUnresolved passes queue filter and pagination', async () => {
    await repo.findUnresolved({ queueName: 'spatula.crawl', limit: 10, offset: 20 });

    expect(db.limit).toHaveBeenCalledWith(10);
    expect(db.offset).toHaveBeenCalledWith(20);
    // where() is called with combined conditions (isNull + eq)
    expect(db.where).toHaveBeenCalled();
  });

  it('findById returns null when no row found', async () => {
    db.limit = vi.fn().mockResolvedValue([]);

    const result = await repo.findById('nonexistent');

    expect(result).toBeNull();
  });

  it('findById returns entry when found', async () => {
    const entry = { id: 'dlq-1', queueName: 'spatula.crawl' };
    db.limit = vi.fn().mockResolvedValue([entry]);

    const result = await repo.findById('dlq-1');

    expect(result).toEqual(entry);
  });

  it('resolve calls update with resolution and resolvedAt', async () => {
    const resolved = { id: 'dlq-1', resolvedAt: new Date(), resolution: 'retried' };
    db.returning = vi.fn().mockResolvedValue([resolved]);

    const result = await repo.resolve('dlq-1', 'retried');

    expect(result).toEqual(resolved);
    expect(db.update).toHaveBeenCalled();
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({
      resolution: 'retried',
      resolvedAt: expect.any(Date),
    }));
    expect(db.where).toHaveBeenCalled();
  });

  it('resolve throws StorageError when entry not found', async () => {
    db.returning = vi.fn().mockResolvedValue([]);

    await expect(repo.resolve('nonexistent', 'discarded')).rejects.toThrow('DLQ entry not found');
  });

  it('countUnresolved returns numeric count', async () => {
    // countUnresolved uses select({ value: sql`count(*)` }) which returns [{ value }]
    db.where = vi.fn().mockResolvedValue([{ value: 42 }]);

    const count = await repo.countUnresolved();

    expect(count).toBe(42);
    expect(db.select).toHaveBeenCalled();
  });

  it('countUnresolved filters by queueName when provided', async () => {
    db.where = vi.fn().mockResolvedValue([{ value: 5 }]);

    const count = await repo.countUnresolved('spatula.export');

    expect(count).toBe(5);
    expect(db.where).toHaveBeenCalled();
  });
});
