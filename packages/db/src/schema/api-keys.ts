import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    supersedes: uuid('supersedes'),
    supersededExpiresAt: timestamp('superseded_expires_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idx_api_keys_hash')
      .on(table.keyHash)
      .where(sql`revoked_at IS NULL`),
  ],
);
