import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogRepository } from '../../../src/repositories/audit-log-repository.js';

function createMockDb() {
  const returning = vi.fn();
  const values = vi.fn().mockReturnValue({ returning });

  return {
    db: {
      insert: vi.fn().mockReturnValue({ values }),
    } as any,
    mocks: { returning, values },
  };
}

describe('AuditLogRepository', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let repo: AuditLogRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new AuditLogRepository(mockDb.db);
  });

  describe('insert', () => {
    it('inserts an audit log entry', async () => {
      const entry = {
        tenantId: 'tenant-1',
        actorId: 'user-1',
        actorType: 'user' as const,
        action: 'job.created',
        resourceType: 'job',
        resourceId: 'job-1',
      };
      mockDb.mocks.returning.mockResolvedValue([{ id: 'log-1', ...entry }]);

      const result = await repo.insert(entry);
      expect(result.id).toBe('log-1');
    });
  });
});
