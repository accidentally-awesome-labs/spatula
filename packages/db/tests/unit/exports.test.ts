import { describe, it, expect } from 'vitest';

// Dynamic `import()` of the package barrel pulls in pg, drizzle, etc. —
// first-load on a cold CI runner can exceed vitest's 5s default. Mirrors
// the queue package's exports.test.ts timeout bump.
describe('package exports', { timeout: 30_000 }, () => {
  it('exports connection factory', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.createDatabase).toBeDefined();
  });

  it('exports all schema tables', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.tenants).toBeDefined();
    expect(mod.jobs).toBeDefined();
    expect(mod.schemasTable).toBeDefined();
    expect(mod.crawlTasks).toBeDefined();
    expect(mod.rawPages).toBeDefined();
    expect(mod.extractions).toBeDefined();
    expect(mod.entities).toBeDefined();
    expect(mod.entitySources).toBeDefined();
    expect(mod.actions).toBeDefined();
    expect(mod.sourceTrust).toBeDefined();
    expect(mod.contentStore).toBeDefined();
  });

  it('exports all enums', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.jobStatusEnum).toBeDefined();
    expect(mod.crawlTaskStatusEnum).toBeDefined();
    expect(mod.actionSourceEnum).toBeDefined();
  });

  it('exports all repositories', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.JobRepository).toBeDefined();
    expect(mod.CrawlTaskRepository).toBeDefined();
    expect(mod.SchemaRepository).toBeDefined();
    expect(mod.ExtractionRepository).toBeDefined();
    expect(mod.PageRepository).toBeDefined();
  });

  it('exports PgContentStore', async () => {
    const mod = await import('../../src/index.js');
    expect(mod.PgContentStore).toBeDefined();
  });
});
