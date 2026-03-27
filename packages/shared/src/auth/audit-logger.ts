import { createLogger } from '../logger.js';

const logger = createLogger('audit-logger');

export interface AuditLogRepo {
  insert(entry: AuditEvent): Promise<unknown>;
}

export interface AuditEvent {
  tenantId?: string;
  actorId: string;
  actorType: 'user' | 'api_key' | 'system';
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export class AuditLogger {
  constructor(private readonly repo: AuditLogRepo) {}

  log(event: AuditEvent): void {
    setImmediate(() => {
      this.repo.insert(event).catch((err) => {
        logger.warn({ err, event: event.action }, 'Failed to write audit log');
      });
    });
  }
}
