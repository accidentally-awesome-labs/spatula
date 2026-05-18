import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmUsageRepository } from '../../../src/repositories/llm-usage-repository.js';

function createMockDb() {
  const returning = vi.fn();
  const values = vi.fn().mockReturnValue({ returning });
  return {
    db: { insert: vi.fn().mockReturnValue({ values }) } as any,
    mocks: { returning, values },
  };
}

describe('LlmUsageRepository', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let repo: LlmUsageRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new LlmUsageRepository(mockDb.db);
  });

  describe('aggregateByTenant', () => {
    it('method exists with correct signature', () => {
      expect(repo.aggregateByTenant).toBeTypeOf('function');
    });

    it('calls db.select() and returns correct shape with canned data', async () => {
      // Build a mock db chain that supports 4 sequential queries
      const limit = vi.fn().mockResolvedValue([{ jobId: 'job-1', tokens: 300, costUsd: 0.003 }]);
      const orderBy = vi.fn().mockReturnValue({ limit });
      const groupBy3 = vi.fn().mockReturnValue({ orderBy });
      const where3 = vi.fn().mockReturnValue({ groupBy: groupBy3 });
      const from3 = vi.fn().mockReturnValue({ where: where3 });

      const groupBy2 = vi
        .fn()
        .mockResolvedValue([{ purpose: 'extraction', tokens: 300, costUsd: 0.003 }]);
      const where2 = vi.fn().mockReturnValue({ groupBy: groupBy2 });
      const from2 = vi.fn().mockReturnValue({ where: where2 });

      const groupBy1 = vi
        .fn()
        .mockResolvedValue([{ model: 'anthropic/claude-3-haiku', tokens: 300, costUsd: 0.003 }]);
      const where1 = vi.fn().mockReturnValue({ groupBy: groupBy1 });
      const from1 = vi.fn().mockReturnValue({ where: where1 });

      const totalsWhere = vi.fn().mockResolvedValue([{ totalTokens: 300, totalCostUsd: 0.003 }]);
      const totalsFrom = vi.fn().mockReturnValue({ where: totalsWhere });

      const selectFn = vi
        .fn()
        .mockReturnValueOnce({ from: totalsFrom }) // totals
        .mockReturnValueOnce({ from: from1 }) // byModel
        .mockReturnValueOnce({ from: from2 }) // byPurpose
        .mockReturnValueOnce({ from: from3 }); // byJob

      const chainDb = {
        select: selectFn,
        insert: vi
          .fn()
          .mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn() }) }),
      } as any;
      const chainRepo = new LlmUsageRepository(chainDb);

      const result = await chainRepo.aggregateByTenant('tenant-1', new Date('2026-01-01'));

      expect(selectFn).toHaveBeenCalledTimes(4);
      expect(result).toEqual({
        totalTokens: 300,
        totalCostUsd: 0.003,
        byModel: { 'anthropic/claude-3-haiku': { tokens: 300, costUsd: 0.003 } },
        byPurpose: { extraction: { tokens: 300, costUsd: 0.003 } },
        byJob: [{ jobId: 'job-1', tokens: 300, costUsd: 0.003 }],
      });
    });
  });

  describe('insert', () => {
    it('records an LLM usage entry', async () => {
      const entry = {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        model: 'anthropic/claude-3-haiku',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        costUsd: '0.000150',
        purpose: 'extraction',
      };
      mockDb.mocks.returning.mockResolvedValue([{ id: 'usage-1', ...entry }]);
      const result = await repo.insert(entry);
      expect(result.id).toBe('usage-1');
    });
  });
});
