import { pgTable, uuid, jsonb, text, real, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { jobs } from './jobs.js';
import { extractions } from './extractions.js';
import { tenants } from './tenants.js';

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => jobs.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    mergedData: jsonb('merged_data').$type<Record<string, unknown>>().notNull(),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull(),
    categories: text('categories').array().notNull().default(sql`'{}'::text[]`),
    qualityScore: real('quality_score').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('entities_job_categories_idx').using('gin', table.categories),
    index('entities_job_quality_idx').on(table.jobId, table.qualityScore),
  ],
);

export const entitySources = pgTable(
  'entity_sources',
  {
    entityId: uuid('entity_id').notNull().references(() => entities.id),
    extractionId: uuid('extraction_id').notNull().references(() => extractions.id),
    matchConfidence: real('match_confidence').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entityId, table.extractionId] }),
  ],
);
