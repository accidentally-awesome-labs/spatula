import { pgTable, uuid, text, jsonb, timestamp, index, inet } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    actorId: text('actor_id').notNull(),
    actorType: text('actor_type').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_audit_tenant_time').on(table.tenantId, table.createdAt),
    index('idx_audit_action_time').on(table.action, table.createdAt),
  ],
);
