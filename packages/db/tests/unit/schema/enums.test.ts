import { describe, it, expect } from 'vitest';
import {
  jobStatusEnum,
  crawlTaskStatusEnum,
  taskPriorityEnum,
  pageClassificationEnum,
  crawlerTypeEnum,
  actionSourceEnum,
  actionStatusEnum,
  trustLevelEnum,
} from '../../../src/schema/enums.js';

describe('schema enums', () => {
  it('jobStatusEnum has all statuses', () => {
    expect(jobStatusEnum.enumValues).toEqual([
      'pending', 'queued', 'running', 'paused',
      'reconciling', 'completed', 'failed', 'cancelled',
    ]);
  });

  it('crawlTaskStatusEnum has all statuses', () => {
    expect(crawlTaskStatusEnum.enumValues).toEqual([
      'pending', 'in_progress', 'completed', 'failed', 'skipped',
    ]);
  });

  it('taskPriorityEnum has all priorities', () => {
    expect(taskPriorityEnum.enumValues).toEqual(['high', 'medium', 'low']);
  });

  it('pageClassificationEnum has all classifications', () => {
    expect(pageClassificationEnum.enumValues).toEqual([
      'single_entry', 'multiple_entries', 'navigation', 'irrelevant', 'partial',
    ]);
  });

  it('crawlerTypeEnum has all types', () => {
    expect(crawlerTypeEnum.enumValues).toEqual(['playwright', 'firecrawl']);
  });

  it('actionSourceEnum has all sources', () => {
    expect(actionSourceEnum.enumValues).toEqual([
      'extraction', 'schema_evolution', 'reconciliation', 'quality_audit',
    ]);
  });

  it('actionStatusEnum has all statuses', () => {
    expect(actionStatusEnum.enumValues).toEqual([
      'pending_review', 'approved', 'applied', 'rejected', 'rolled_back',
    ]);
  });

  it('trustLevelEnum has all levels', () => {
    expect(trustLevelEnum.enumValues).toEqual([
      'authoritative', 'high', 'medium', 'low',
    ]);
  });
});
