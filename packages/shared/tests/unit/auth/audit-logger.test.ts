import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger } from '../../../src/auth/audit-logger.js';

describe('AuditLogger', () => {
  let mockRepo: { insert: ReturnType<typeof vi.fn> };
  let auditLogger: AuditLogger;

  beforeEach(() => {
    mockRepo = { insert: vi.fn().mockResolvedValue({ id: 'log-1' }) };
    auditLogger = new AuditLogger(mockRepo as any);
  });

  it('logs an event fire-and-forget', async () => {
    auditLogger.log({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      actorType: 'user',
      action: 'job.created',
      resourceType: 'job',
      resourceId: 'job-1',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job.created', actorId: 'user-1' }),
    );
  });

  it('does not throw when repo insert fails', async () => {
    mockRepo.insert.mockRejectedValue(new Error('DB down'));
    auditLogger.log({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      actorType: 'system',
      action: 'auth.login_failure',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockRepo.insert).toHaveBeenCalled();
  });
});
