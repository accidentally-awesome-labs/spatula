import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExportRepository } from '../../../src/repositories/export-repository.js';

function createMockDb() {
  const chainable = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'export-id', status: 'pending' }]),
    then: undefined as unknown,
  };
  chainable.then = vi.fn((resolve: (v: unknown) => void) =>
    resolve([{ id: 'export-id', status: 'pending' }]),
  );

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'export-id', status: 'pending' }]),
      }),
    }),
    update: vi.fn().mockReturnValue(chainable),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
  };
}

describe('ExportRepository', () => {
  let repo: ExportRepository;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new ExportRepository(mockDb as any);
  });

  it('has create method', () => {
    expect(typeof repo.create).toBe('function');
  });

  it('has findById method', () => {
    expect(typeof repo.findById).toBe('function');
  });

  it('has findByJob method', () => {
    expect(typeof repo.findByJob).toBe('function');
  });

  it('has updateStatus method', () => {
    expect(typeof repo.updateStatus).toBe('function');
  });

  it('create calls db.insert', async () => {
    await repo.create({ jobId: 'j1', tenantId: 't1', format: 'json', includeProvenance: false });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('findById calls db.select', async () => {
    await repo.findById('export-id', 'tenant-id');
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('findByJob calls db.select', async () => {
    await repo.findByJob('job-id', 'tenant-id');
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('updateStatus calls db.update', async () => {
    await repo.updateStatus('export-id', 'tenant-id', {
      status: 'completed',
      entityCount: 42,
      contentRef: 'pg://abc',
      fileSize: 1024,
      completedAt: new Date(),
    });
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('create wraps errors in StorageError', async () => {
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('db error')),
      }),
    });

    await expect(
      repo.create({ jobId: 'j1', tenantId: 't1', format: 'json', includeProvenance: false }),
    ).rejects.toThrow('Failed to create export');
  });

  it('findById wraps errors in StorageError', async () => {
    const failChainable = {
      where: vi.fn().mockRejectedValue(new Error('db error')),
      then: undefined as unknown,
    };
    failChainable.then = vi.fn((_: unknown, reject: (v: unknown) => void) =>
      reject(new Error('db error')),
    );
    mockDb.select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(failChainable) });

    await expect(repo.findById('export-id', 'tenant-id')).rejects.toThrow('Failed to find export');
  });

  it('updateStatus wraps errors in StorageError', async () => {
    const failChainable = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockRejectedValue(new Error('db error')),
      then: undefined as unknown,
    };
    failChainable.then = vi.fn((_: unknown, reject: (v: unknown) => void) =>
      reject(new Error('db error')),
    );
    mockDb.update = vi.fn().mockReturnValue(failChainable);

    await expect(
      repo.updateStatus('export-id', 'tenant-id', { status: 'failed', error: 'oops' }),
    ).rejects.toThrow('Failed to update export');
  });
});

describe('ExportRepository.findByJobCursor', () => {
  const JOB_ID = 'job-1';
  const TENANT_ID = 'tenant-1';

  it('returns entities and nextCursor when batch is full', async () => {
    const rows = [
      { id: 'id-1', jobId: JOB_ID, tenantId: TENANT_ID },
      { id: 'id-2', jobId: JOB_ID, tenantId: TENANT_ID },
    ];
    const chainable = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: undefined as unknown,
    };
    chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve(rows));
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
      insert: vi.fn(),
      update: vi.fn(),
    };
    const repo = new ExportRepository(db as any);

    const result = await repo.findByJobCursor(JOB_ID, TENANT_ID, 2);

    expect(result.entities).toEqual(rows);
    expect(result.nextCursor).toBe('id-2');
  });

  it('returns null nextCursor on last page', async () => {
    const rows = [{ id: 'id-1', jobId: 'job-1', tenantId: 'tenant-1' }];
    const chainable = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: undefined as unknown,
    };
    chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve(rows));
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
      insert: vi.fn(),
      update: vi.fn(),
    };
    const repo = new ExportRepository(db as any);

    const result = await repo.findByJobCursor('job-1', 'tenant-1', 2);

    expect(result.entities).toEqual(rows);
    expect(result.nextCursor).toBeNull();
  });

  it('passes cursor and since to query', async () => {
    const chainable = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: undefined as unknown,
    };
    chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([]));
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
      insert: vi.fn(),
      update: vi.fn(),
    };
    const repo = new ExportRepository(db as any);

    await repo.findByJobCursor('job-1', 'tenant-1', 10, 'cursor-abc', '2026-03-01T00:00:00Z');

    expect(db.select).toHaveBeenCalled();
  });
});

describe('ExportRepository.countByJob', () => {
  it('returns count from db', async () => {
    const chainable = {
      where: vi.fn().mockReturnThis(),
      then: undefined as unknown,
    };
    chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([{ count: 5 }]));
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
      insert: vi.fn(),
      update: vi.fn(),
    };
    const repo = new ExportRepository(db as any);

    const count = await repo.countByJob('job-1', 'tenant-1');

    expect(count).toBe(5);
  });

  it('returns 0 when result is empty', async () => {
    const chainable = {
      where: vi.fn().mockReturnThis(),
      then: undefined as unknown,
    };
    chainable.then = vi.fn((resolve: (v: unknown) => void) => resolve([]));
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
      insert: vi.fn(),
      update: vi.fn(),
    };
    const repo = new ExportRepository(db as any);

    const count = await repo.countByJob('job-1', 'tenant-1');

    expect(count).toBe(0);
  });
});

describe('ExportRepository.findByJob with limit/offset', () => {
  it('calls db.select with limit and offset options', async () => {
    const chainable = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      then: undefined as unknown,
    };
    chainable.then = vi.fn((resolve: (v: unknown) => void) =>
      resolve([{ id: 'export-1', status: 'completed' }]),
    );
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue(chainable) }),
      insert: vi.fn(),
      update: vi.fn(),
    };
    const repo = new ExportRepository(db as any);

    const result = await repo.findByJob('job-1', 'tenant-1', { limit: 10, offset: 20 });

    expect(db.select).toHaveBeenCalled();
    expect(chainable.limit).toHaveBeenCalledWith(10);
    expect(chainable.offset).toHaveBeenCalledWith(20);
    expect(result).toEqual([{ id: 'export-1', status: 'completed' }]);
  });
});
