import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { tenants } from '../../../src/schema/tenants.js';
import { jobs } from '../../../src/schema/jobs.js';
import { schemasTable } from '../../../src/schema/schemas.js';
import { crawlTasks } from '../../../src/schema/crawl-tasks.js';
import { rawPages } from '../../../src/schema/raw-pages.js';
import { extractions } from '../../../src/schema/extractions.js';
import { entities, entitySources } from '../../../src/schema/entities.js';
import { actions } from '../../../src/schema/actions.js';
import { sourceTrust } from '../../../src/schema/source-trust.js';

describe('core table schemas', () => {
  it('tenants table has correct name and columns', () => {
    expect(getTableName(tenants)).toBe('tenants');
    expect(tenants.id).toBeDefined();
    expect(tenants.name).toBeDefined();
    expect(tenants.config).toBeDefined();
    expect(tenants.createdAt).toBeDefined();
  });

  it('jobs table has correct name and all columns', () => {
    expect(getTableName(jobs)).toBe('jobs');
    expect(jobs.id).toBeDefined();
    expect(jobs.tenantId).toBeDefined();
    expect(jobs.name).toBeDefined();
    expect(jobs.description).toBeDefined();
    expect(jobs.config).toBeDefined();
    expect(jobs.status).toBeDefined();
    expect(jobs.schemaId).toBeDefined();
    expect(jobs.stats).toBeDefined();
    expect(jobs.createdAt).toBeDefined();
    expect(jobs.startedAt).toBeDefined();
    expect(jobs.completedAt).toBeDefined();
  });

  it('schemas table has correct name and all columns', () => {
    expect(getTableName(schemasTable)).toBe('schemas');
    expect(schemasTable.id).toBeDefined();
    expect(schemasTable.jobId).toBeDefined();
    expect(schemasTable.tenantId).toBeDefined();
    expect(schemasTable.version).toBeDefined();
    expect(schemasTable.definition).toBeDefined();
    expect(schemasTable.parentId).toBeDefined();
    expect(schemasTable.createdAt).toBeDefined();
  });
});

describe('crawl & page table schemas', () => {
  it('crawl_tasks table has correct name and all columns', () => {
    expect(getTableName(crawlTasks)).toBe('crawl_tasks');
    expect(crawlTasks.id).toBeDefined();
    expect(crawlTasks.jobId).toBeDefined();
    expect(crawlTasks.tenantId).toBeDefined();
    expect(crawlTasks.url).toBeDefined();
    expect(crawlTasks.depth).toBeDefined();
    expect(crawlTasks.status).toBeDefined();
    expect(crawlTasks.priority).toBeDefined();
    expect(crawlTasks.classification).toBeDefined();
    expect(crawlTasks.parentTaskId).toBeDefined();
    expect(crawlTasks.crawlerType).toBeDefined();
    expect(crawlTasks.contentRef).toBeDefined();
    expect(crawlTasks.metadata).toBeDefined();
    expect(crawlTasks.createdAt).toBeDefined();
    expect(crawlTasks.processedAt).toBeDefined();
  });

  it('raw_pages table has correct name and all columns', () => {
    expect(getTableName(rawPages)).toBe('raw_pages');
    expect(rawPages.id).toBeDefined();
    expect(rawPages.taskId).toBeDefined();
    expect(rawPages.tenantId).toBeDefined();
    expect(rawPages.contentRef).toBeDefined();
    expect(rawPages.contentHash).toBeDefined();
    expect(rawPages.metadata).toBeDefined();
    expect(rawPages.createdAt).toBeDefined();
  });
});

describe('extraction & entity table schemas', () => {
  it('extractions table has correct name and all columns', () => {
    expect(getTableName(extractions)).toBe('extractions');
    expect(extractions.id).toBeDefined();
    expect(extractions.jobId).toBeDefined();
    expect(extractions.tenantId).toBeDefined();
    expect(extractions.pageId).toBeDefined();
    expect(extractions.schemaVersion).toBeDefined();
    expect(extractions.data).toBeDefined();
    expect(extractions.unmappedFields).toBeDefined();
    expect(extractions.metadata).toBeDefined();
    expect(extractions.createdAt).toBeDefined();
  });

  it('entities table has correct name and all columns', () => {
    expect(getTableName(entities)).toBe('entities');
    expect(entities.id).toBeDefined();
    expect(entities.jobId).toBeDefined();
    expect(entities.tenantId).toBeDefined();
    expect(entities.mergedData).toBeDefined();
    expect(entities.provenance).toBeDefined();
    expect(entities.categories).toBeDefined();
    expect(entities.qualityScore).toBeDefined();
    expect(entities.createdAt).toBeDefined();
  });

  it('entity_sources join table has correct name and columns', () => {
    expect(getTableName(entitySources)).toBe('entity_sources');
    expect(entitySources.entityId).toBeDefined();
    expect(entitySources.extractionId).toBeDefined();
    expect(entitySources.matchConfidence).toBeDefined();
  });
});

describe('actions & source trust table schemas', () => {
  it('actions table has correct name and all columns', () => {
    expect(getTableName(actions)).toBe('actions');
    expect(actions.id).toBeDefined();
    expect(actions.jobId).toBeDefined();
    expect(actions.tenantId).toBeDefined();
    expect(actions.type).toBeDefined();
    expect(actions.payload).toBeDefined();
    expect(actions.source).toBeDefined();
    expect(actions.status).toBeDefined();
    expect(actions.confidence).toBeDefined();
    expect(actions.reasoning).toBeDefined();
    expect(actions.stateChanges).toBeDefined();
    expect(actions.reviewedBy).toBeDefined();
    expect(actions.createdAt).toBeDefined();
    expect(actions.appliedAt).toBeDefined();
  });

  it('source_trust table has correct name and all columns', () => {
    expect(getTableName(sourceTrust)).toBe('source_trust');
    expect(sourceTrust.id).toBeDefined();
    expect(sourceTrust.jobId).toBeDefined();
    expect(sourceTrust.tenantId).toBeDefined();
    expect(sourceTrust.domain).toBeDefined();
    expect(sourceTrust.trustLevel).toBeDefined();
    expect(sourceTrust.reasoning).toBeDefined();
  });
});
