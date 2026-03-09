import { pgEnum } from 'drizzle-orm/pg-core';

export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'queued',
  'running',
  'paused',
  'reconciling',
  'completed',
  'failed',
  'cancelled',
]);

export const crawlTaskStatusEnum = pgEnum('crawl_task_status', [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
]);

export const taskPriorityEnum = pgEnum('task_priority', ['high', 'medium', 'low']);

export const pageClassificationEnum = pgEnum('page_classification', [
  'single_entry',
  'multiple_entries',
  'navigation',
  'irrelevant',
  'partial',
]);

export const crawlerTypeEnum = pgEnum('crawler_type', ['playwright', 'firecrawl']);

export const actionSourceEnum = pgEnum('action_source', [
  'extraction',
  'schema_evolution',
  'reconciliation',
  'quality_audit',
]);

export const actionStatusEnum = pgEnum('action_status', [
  'pending_review',
  'approved',
  'applied',
  'rejected',
  'rolled_back',
]);

export const trustLevelEnum = pgEnum('trust_level', ['authoritative', 'high', 'medium', 'low']);
