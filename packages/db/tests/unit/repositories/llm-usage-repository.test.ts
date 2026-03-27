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

  describe('insert', () => {
    it('records an LLM usage entry', async () => {
      const entry = {
        tenantId: 'tenant-1', jobId: 'job-1', model: 'anthropic/claude-3-haiku',
        promptTokens: 100, completionTokens: 50, totalTokens: 150,
        costUsd: '0.000150', purpose: 'extraction',
      };
      mockDb.mocks.returning.mockResolvedValue([{ id: 'usage-1', ...entry }]);
      const result = await repo.insert(entry);
      expect(result.id).toBe('usage-1');
    });
  });
});
