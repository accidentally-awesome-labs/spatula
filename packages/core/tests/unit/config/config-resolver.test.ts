import { describe, it, expect } from 'vitest';
import { yamlToJobConfig } from '../../../src/config/config-resolver.js';
import type { SpatulaYaml } from '../../../src/config/types.js';
import type { GlobalConfig } from '../../../src/config/types.js';

const minimalYaml: SpatulaYaml = {
  seeds: ['https://example.com/products'],
};

describe('yamlToJobConfig', () => {
  it('converts minimal YAML to valid JobConfig', () => {
    const result = yamlToJobConfig(minimalYaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test/project',
    });

    expect(result.tenantId).toBe('00000000-0000-0000-0000-000000000001');
    expect(result.seedUrls).toEqual(['https://example.com/products']);
    expect(result.name).toBeDefined(); // defaults to directory name
    expect(result.description).toBeDefined();
    expect(result.crawl.maxDepth).toBe(2); // default
    expect(result.crawl.maxPages).toBe(1000); // default
    expect(result.schema.mode).toBe('discovery'); // default
  });

  it('maps user-friendly field names to internal names', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      depth: 3,
      limit: 500,
      crawler: 'firecrawl',
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test/project',
    });

    expect(result.crawl.maxDepth).toBe(3);
    expect(result.crawl.maxPages).toBe(500);
    expect(result.crawl.crawlerType).toBe('firecrawl');
  });

  it('expands field shorthand to FieldDefinition', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      fields: [{ product_name: 'string' }, { field: 'price', type: 'currency', required: true }],
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
    });

    expect(result.schema.userFields).toHaveLength(2);
    expect(result.schema.userFields![0].name).toBe('product_name');
    expect(result.schema.userFields![0].type).toBe('string');
    expect(result.schema.userFields![1].name).toBe('price');
    expect(result.schema.userFields![1].required).toBe(true);
  });

  it('maps nested config sections correctly', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      schema: { mode: 'hybrid', evolution: { batchSize: 20 } },
      llm: { model: 'llama3.2:8b', overrides: { linkEvaluation: 'llama3.2:3b' } },
      reconciliation: { strategy: 'fuzzy_name', fuzzyThreshold: 0.9 },
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
    });

    expect(result.schema.mode).toBe('hybrid');
    expect(result.schema.evolutionConfig?.batchSize).toBe(20);
    expect(result.llm.primaryModel).toBe('llama3.2:8b');
    expect(result.llm.modelOverrides?.linkEvaluation).toBe('llama3.2:3b');
    expect(result.reconciliation?.matchStrategy).toBe('fuzzy_name');
    expect(result.reconciliation?.fuzzyMatchThreshold).toBe(0.9);
  });

  it('applies global config defaults when project config omits values', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
    };

    const globalConfig: GlobalConfig = {
      version: 1,
      llm: { provider: 'ollama', model: 'llama3.2:8b' },
      crawler: 'firecrawl',
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
      globalConfig,
    });

    expect(result.llm.primaryModel).toBe('llama3.2:8b');
    expect(result.crawl.crawlerType).toBe('firecrawl');
  });

  it('project config overrides global config', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      crawler: 'playwright',
      llm: { model: 'anthropic/claude-sonnet-4-20250514' },
    };

    const globalConfig: GlobalConfig = {
      version: 1,
      crawler: 'firecrawl',
      llm: { model: 'llama3.2:8b' },
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
      globalConfig,
    });

    expect(result.crawl.crawlerType).toBe('playwright');
    expect(result.llm.primaryModel).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('applies CLI flag overrides over project config', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      depth: 3,
      limit: 2000,
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
      cliFlags: { depth: 1, limit: 100 },
    });

    expect(result.crawl.maxDepth).toBe(1);
    expect(result.crawl.maxPages).toBe(100);
  });

  it('defaults schema mode to discovery when no fields provided', () => {
    const result = yamlToJobConfig(minimalYaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
    });
    expect(result.schema.mode).toBe('discovery');
  });

  it('defaults schema mode to hybrid when fields are provided', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      fields: [{ product_name: 'string' }],
    };
    const result = yamlToJobConfig(yaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/test',
    });
    expect(result.schema.mode).toBe('hybrid');
  });

  it('full priority stack: CLI > project YAML > global config > defaults', () => {
    const yaml: SpatulaYaml = {
      seeds: ['https://example.com'],
      depth: 3, // project overrides default (2)
      limit: 500, // project overrides default (1000)
      crawler: 'firecrawl', // project overrides global
    };

    const globalConfig: GlobalConfig = {
      version: 1,
      crawler: 'playwright', // global sets crawler — overridden by project
      llm: { model: 'llama3.2:8b' }, // global sets model — not overridden by project
    };

    const result = yamlToJobConfig(yaml, {
      tenantId: 'tenant-1',
      projectRoot: '/test',
      globalConfig,
      cliFlags: { depth: 1 }, // CLI overrides project depth (3 → 1)
    });

    // CLI wins over project
    expect(result.crawl.maxDepth).toBe(1);
    // Project wins over global
    expect(result.crawl.crawlerType).toBe('firecrawl');
    // Project wins over default
    expect(result.crawl.maxPages).toBe(500);
    // Global fills in when project doesn't specify
    expect(result.llm.primaryModel).toBe('llama3.2:8b');
    // Default fills in when nobody specifies
    expect(result.schema.mode).toBe('discovery');
  });

  it('derives name from project root directory when not specified', () => {
    const result = yamlToJobConfig(minimalYaml, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      projectRoot: '/home/user/projects/acme-scraper',
    });
    expect(result.name).toBe('acme-scraper');
  });
});
