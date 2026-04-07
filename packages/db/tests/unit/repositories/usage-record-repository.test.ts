import { describe, it, expect, vi } from 'vitest';
import { UsageRecordRepository } from '../../../src/repositories/usage-record-repository.js';

function createMockDb() {
  const mockValues = vi.fn().mockResolvedValue(undefined);
  const mockGroupBy = vi.fn().mockResolvedValue([]);
  const mockLimit = vi.fn().mockResolvedValue([]);
  const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

  // where() returns an object supporting both .orderBy() (getUnreported) and .groupBy() (aggregate)
  // It also resolves directly for getCurrentUsage
  const mockWhere = vi.fn().mockImplementation(() => {
    const result = Promise.resolve([]);
    (result as any).orderBy = mockOrderBy;
    (result as any).groupBy = mockGroupBy;
    return result;
  });

  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  const db = {
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    select: mockSelect,
    update: vi.fn().mockReturnValue({ set: mockSet }),
    _mocks: { mockValues, mockWhere, mockFrom, mockSelect, mockGroupBy, mockOrderBy, mockLimit },
  };
  return db;
}

describe('UsageRecordRepository', () => {
  it('record() inserts a usage record', async () => {
    const db = createMockDb();
    const repo = new UsageRecordRepository(db as any);
    await repo.record('tenant-1', 'pages', 50);
    expect(db.insert).toHaveBeenCalled();
    expect(db._mocks.mockValues).toHaveBeenCalled();
  });

  it('getCurrentUsage() queries with tenant, dimension, and period', async () => {
    const db = createMockDb();
    const mockResult = Promise.resolve([{ total: 150 }]);
    (mockResult as any).orderBy = vi.fn();
    (mockResult as any).groupBy = vi.fn();
    db._mocks.mockWhere.mockReturnValue(mockResult);
    const repo = new UsageRecordRepository(db as any);
    const result = await repo.getCurrentUsage('tenant-1', 'pages');
    expect(result).toBe(150);
    expect(db.select).toHaveBeenCalled();
  });

  it('getCurrentUsage() returns 0 for null result', async () => {
    const db = createMockDb();
    const mockResult = Promise.resolve([{ total: null }]);
    (mockResult as any).orderBy = vi.fn();
    (mockResult as any).groupBy = vi.fn();
    db._mocks.mockWhere.mockReturnValue(mockResult);
    const repo = new UsageRecordRepository(db as any);
    const result = await repo.getCurrentUsage('tenant-1', 'pages');
    expect(result).toBe(0);
  });

  it('getUnreported() returns unreported records', async () => {
    const db = createMockDb();
    db._mocks.mockLimit.mockResolvedValue([
      { id: 'r1', tenantId: 'tenant-1', dimension: 'pages', quantity: 50, reportedToStripe: false },
    ]);
    const repo = new UsageRecordRepository(db as any);
    const result = await repo.getUnreported(100);
    expect(result).toHaveLength(1);
  });

  it('markReported() updates records', async () => {
    const db = createMockDb();
    const repo = new UsageRecordRepository(db as any);
    await repo.markReported(['r1', 'r2']);
    expect(db.update).toHaveBeenCalled();
  });

  it('markReported() skips empty array', async () => {
    const db = createMockDb();
    const repo = new UsageRecordRepository(db as any);
    await repo.markReported([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('aggregateByTenant() returns grouped results', async () => {
    const db = createMockDb();
    const groupByResult = [
      { dimension: 'pages', total: 500 },
      { dimension: 'llm_tokens', total: 10000 },
    ];
    const mockResult = Promise.resolve([]);
    (mockResult as any).orderBy = vi.fn();
    (mockResult as any).groupBy = vi.fn().mockResolvedValue(groupByResult);
    db._mocks.mockWhere.mockReturnValue(mockResult);
    const repo = new UsageRecordRepository(db as any);
    const result = await repo.aggregateByTenant('tenant-1', new Date('2026-03-01'), new Date('2026-03-31'));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ dimension: 'pages', total: 500 });
    expect(result[1]).toEqual({ dimension: 'llm_tokens', total: 10000 });
  });
});
