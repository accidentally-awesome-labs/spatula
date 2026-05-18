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

  describe('findByTenant', () => {
    it('returns entries ordered by createdAt desc with default limit', async () => {
      const now = new Date();
      const entries = [
        { id: 'log-2', tenantId: 'tenant-1', action: 'job.started', createdAt: now },
        {
          id: 'log-1',
          tenantId: 'tenant-1',
          action: 'job.created',
          createdAt: new Date(now.getTime() - 1000),
        },
      ];

      const mockOffset = vi.fn().mockResolvedValue(entries);
      const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
      const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      const db = {
        select: vi.fn().mockReturnValue({ from: mockFrom }),
      } as any;

      const repo2 = new AuditLogRepository(db);
      const result = await repo2.findByTenant('tenant-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('log-2');
      expect(result[1].id).toBe('log-1');
      // Default limit of 50
      expect(mockLimit).toHaveBeenCalledWith(50);
      // Default offset of 0
      expect(mockOffset).toHaveBeenCalledWith(0);
    });
  });
});
