import { pgTable, text, uuid, varchar, timestamp, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';

// A user can belong to multiple tenants (as member/admin), but can only OWN one tenant.
// The partial unique index idx_user_tenants_owner enforces this — it prevents a user_id
// from having role='owner' on more than one tenant. This is intentional: each hosted user
// gets one personal workspace. They can be invited to other tenants as member/admin.
export const userTenants = pgTable(
  'user_tenants',
  {
    userId: text('user_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 20 }).notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.tenantId] }),
    index('idx_user_tenants_user').on(table.userId),
    uniqueIndex('idx_user_tenants_owner').on(table.userId).where(sql`role = 'owner'`),
  ],
);
