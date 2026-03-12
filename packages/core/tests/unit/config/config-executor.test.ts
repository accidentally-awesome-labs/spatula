import { describe, it, expect } from 'vitest';
import { DefaultConfigExecutor } from '../../../src/config/config-executor.js';
import type { JobConfig } from '../../../src/types/job.js';
import type { ConfigAction } from '../../../src/types/config-actions.js';

function makeAction(overrides: Partial<ConfigAction> & Pick<ConfigAction, 'type' | 'payload'>): ConfigAction {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    reasoning: 'test',
    ...overrides,
  } as ConfigAction;
}

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    tenantId: '550e8400-e29b-41d4-a716-446655440001',
    name: '',
    description: '',
    seedUrls: [],
    crawl: {
      maxDepth: 2,
      maxPages: 1000,
      concurrency: 5,
      crawlerType: 'playwright',
    },
    schema: {
      mode: 'discovery',
    },
    llm: {
      primaryModel: 'anthropic/claude-sonnet-4-20250514',
    },
    ...overrides,
  };
}

describe('DefaultConfigExecutor', () => {
  const executor = new DefaultConfigExecutor();

  describe('apply — immutability', () => {
    it('does not mutate the original config', () => {
      const config = makeConfig({ name: 'original' });
      const action = makeAction({
        type: 'set_job_name',
        payload: { name: 'changed' },
      });
      const result = executor.apply(config, action);
      expect(result.name).toBe('changed');
      expect(config.name).toBe('original');
    });
  });

  // --- Metadata ---

  describe('set_job_name', () => {
    it('sets the job name', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({ type: 'set_job_name', payload: { name: 'Audiophile Crawl' } }),
      );
      expect(result.name).toBe('Audiophile Crawl');
    });
  });

  describe('set_job_description', () => {
    it('sets the job description', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({ type: 'set_job_description', payload: { description: 'Crawl audiophile forums' } }),
      );
      expect(result.description).toBe('Crawl audiophile forums');
    });
  });

  // --- Seed URLs ---

  describe('add_seed_urls', () => {
    it('adds seed URLs to an empty list', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({
          type: 'add_seed_urls',
          payload: {
            urls: [
              { url: 'https://head-fi.org' },
              { url: 'https://audiosciencereview.com', label: 'ASR' },
            ],
          },
        }),
      );
      expect(result.seedUrls).toEqual(['https://head-fi.org', 'https://audiosciencereview.com']);
    });

    it('deduplicates when adding URLs that already exist', () => {
      const config = makeConfig({ seedUrls: ['https://head-fi.org'] });
      const result = executor.apply(
        config,
        makeAction({
          type: 'add_seed_urls',
          payload: {
            urls: [
              { url: 'https://head-fi.org' },
              { url: 'https://audiosciencereview.com' },
            ],
          },
        }),
      );
      expect(result.seedUrls).toEqual(['https://head-fi.org', 'https://audiosciencereview.com']);
    });
  });

  describe('remove_seed_urls', () => {
    it('removes specified URLs', () => {
      const config = makeConfig({
        seedUrls: ['https://head-fi.org', 'https://audiosciencereview.com', 'https://reddit.com'],
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'remove_seed_urls',
          payload: { urls: ['https://head-fi.org', 'https://reddit.com'] },
        }),
      );
      expect(result.seedUrls).toEqual(['https://audiosciencereview.com']);
    });
  });

  describe('replace_seed_urls', () => {
    it('replaces all seed URLs', () => {
      const config = makeConfig({ seedUrls: ['https://old.com'] });
      const result = executor.apply(
        config,
        makeAction({
          type: 'replace_seed_urls',
          payload: {
            urls: [{ url: 'https://new1.com' }, { url: 'https://new2.com' }],
          },
        }),
      );
      expect(result.seedUrls).toEqual(['https://new1.com', 'https://new2.com']);
    });
  });

  // --- Crawl Settings ---

  describe('set_crawl_depth', () => {
    it('sets maxDepth', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({ type: 'set_crawl_depth', payload: { maxDepth: 5 } }),
      );
      expect(result.crawl.maxDepth).toBe(5);
    });
  });

  describe('set_max_pages', () => {
    it('sets maxPages', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({ type: 'set_max_pages', payload: { maxPages: 500 } }),
      );
      expect(result.crawl.maxPages).toBe(500);
    });
  });

  describe('set_concurrency', () => {
    it('sets concurrency', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({ type: 'set_concurrency', payload: { concurrency: 10 } }),
      );
      expect(result.crawl.concurrency).toBe(10);
    });
  });

  describe('set_crawler_type', () => {
    it('sets crawlerType', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_crawler_type',
          payload: { crawlerType: 'firecrawl', reason: 'JS-heavy pages' },
        }),
      );
      expect(result.crawl.crawlerType).toBe('firecrawl');
    });
  });

  // --- Schema Fields ---

  describe('add_user_field', () => {
    it('adds a field at last position by default', () => {
      const config = makeConfig({
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'brand', description: 'Brand', type: 'string', required: true },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'add_user_field',
          payload: {
            field: { name: 'price', description: 'Price', type: 'currency', required: true },
            position: 'last',
          },
        }),
      );
      expect(result.schema.userFields).toHaveLength(2);
      expect(result.schema.userFields![1].name).toBe('price');
    });

    it('adds a field at first position', () => {
      const config = makeConfig({
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'brand', description: 'Brand', type: 'string', required: true },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'add_user_field',
          payload: {
            field: { name: 'price', description: 'Price', type: 'currency', required: true },
            position: 'first',
          },
        }),
      );
      expect(result.schema.userFields).toHaveLength(2);
      expect(result.schema.userFields![0].name).toBe('price');
    });

    it('adds a field after a specified field', () => {
      const config = makeConfig({
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'brand', description: 'Brand', type: 'string', required: true },
            { name: 'model', description: 'Model', type: 'string', required: true },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'add_user_field',
          payload: {
            field: { name: 'price', description: 'Price', type: 'currency', required: true },
            position: 'after',
            afterField: 'brand',
          },
        }),
      );
      expect(result.schema.userFields).toHaveLength(3);
      expect(result.schema.userFields![0].name).toBe('brand');
      expect(result.schema.userFields![1].name).toBe('price');
      expect(result.schema.userFields![2].name).toBe('model');
    });

    it('initializes userFields if undefined', () => {
      const config = makeConfig({ schema: { mode: 'discovery' } });
      const result = executor.apply(
        config,
        makeAction({
          type: 'add_user_field',
          payload: {
            field: { name: 'brand', description: 'Brand', type: 'string', required: true },
            position: 'last',
          },
        }),
      );
      expect(result.schema.userFields).toHaveLength(1);
      expect(result.schema.userFields![0].name).toBe('brand');
    });
  });

  describe('add_multiple_user_fields', () => {
    it('adds multiple fields at once', () => {
      const config = makeConfig({ schema: { mode: 'discovery' } });
      const result = executor.apply(
        config,
        makeAction({
          type: 'add_multiple_user_fields',
          payload: {
            fields: [
              { name: 'brand', description: 'Brand', type: 'string', required: true },
              { name: 'price', description: 'Price', type: 'currency', required: true },
              { name: 'rating', description: 'Rating', type: 'number', required: false },
            ],
          },
        }),
      );
      expect(result.schema.userFields).toHaveLength(3);
      expect(result.schema.userFields!.map((f) => f.name)).toEqual(['brand', 'price', 'rating']);
    });
  });

  describe('remove_user_field', () => {
    it('removes a field by name', () => {
      const config = makeConfig({
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'brand', description: 'Brand', type: 'string', required: true },
            { name: 'price', description: 'Price', type: 'currency', required: true },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({ type: 'remove_user_field', payload: { fieldName: 'brand' } }),
      );
      expect(result.schema.userFields).toHaveLength(1);
      expect(result.schema.userFields![0].name).toBe('price');
    });
  });

  describe('modify_user_field', () => {
    it('modifies an existing field', () => {
      const config = makeConfig({
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'brand', description: 'Brand', type: 'string', required: false },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'modify_user_field',
          payload: {
            fieldName: 'brand',
            changes: { required: true, description: 'Product brand name' },
          },
        }),
      );
      expect(result.schema.userFields![0].required).toBe(true);
      expect(result.schema.userFields![0].description).toBe('Product brand name');
      expect(result.schema.userFields![0].type).toBe('string'); // unchanged
    });
  });

  describe('reorder_user_fields', () => {
    it('reorders fields by name list', () => {
      const config = makeConfig({
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'brand', description: 'Brand', type: 'string', required: true },
            { name: 'price', description: 'Price', type: 'currency', required: true },
            { name: 'rating', description: 'Rating', type: 'number', required: false },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'reorder_user_fields',
          payload: { fieldOrder: ['rating', 'brand', 'price'] },
        }),
      );
      expect(result.schema.userFields!.map((f) => f.name)).toEqual(['rating', 'brand', 'price']);
    });
  });

  describe('replace_all_user_fields', () => {
    it('replaces all fields', () => {
      const config = makeConfig({
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'old', description: 'Old field', type: 'string', required: false },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'replace_all_user_fields',
          payload: {
            fields: [
              { name: 'new1', description: 'New field 1', type: 'string', required: true },
              { name: 'new2', description: 'New field 2', type: 'number', required: false },
            ],
          },
        }),
      );
      expect(result.schema.userFields).toHaveLength(2);
      expect(result.schema.userFields!.map((f) => f.name)).toEqual(['new1', 'new2']);
    });
  });

  describe('define_nested_field', () => {
    it('sets objectFields on a parent field', () => {
      const config = makeConfig({
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'specs', description: 'Specifications', type: 'object', required: true },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'define_nested_field',
          payload: {
            parentFieldName: 'specs',
            subFields: [
              { name: 'weight', description: 'Weight in grams', type: 'number', required: false },
              { name: 'color', description: 'Color', type: 'string', required: false },
            ],
          },
        }),
      );
      expect(result.schema.userFields![0].objectFields).toHaveLength(2);
      expect(result.schema.userFields![0].objectFields![0].name).toBe('weight');
    });
  });

  // --- Schema Mode ---

  describe('set_schema_mode', () => {
    it('sets the schema mode', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({ type: 'set_schema_mode', payload: { mode: 'fixed' } }),
      );
      expect(result.schema.mode).toBe('fixed');
    });
  });

  describe('set_evolution_config', () => {
    it('creates evolution config with defaults when none exists', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_evolution_config',
          payload: { enabled: true, batchSize: 20 },
        }),
      );
      expect(result.schema.evolutionConfig).toBeDefined();
      expect(result.schema.evolutionConfig!.enabled).toBe(true);
      expect(result.schema.evolutionConfig!.batchSize).toBe(20);
    });

    it('merges with existing evolution config', () => {
      const config = makeConfig({
        schema: {
          mode: 'hybrid',
          evolutionConfig: {
            enabled: true,
            batchSize: 10,
            maxFields: 50,
            relevanceThresholds: {
              requiredMin: 0.85,
              optionalMin: 0.4,
              rareBelow: 0.4,
              minCategorySampleSize: 5,
            },
            tableStrategy: 'auto',
          },
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_evolution_config',
          payload: { maxFields: 100 },
        }),
      );
      expect(result.schema.evolutionConfig!.enabled).toBe(true); // preserved
      expect(result.schema.evolutionConfig!.batchSize).toBe(10); // preserved
      expect(result.schema.evolutionConfig!.maxFields).toBe(100); // updated
    });
  });

  // --- LLM Config ---

  describe('set_primary_model', () => {
    it('sets the primary model', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({ type: 'set_primary_model', payload: { model: 'openai/gpt-4o' } }),
      );
      expect(result.llm.primaryModel).toBe('openai/gpt-4o');
    });
  });

  describe('set_model_override', () => {
    it('sets a model override for a task', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_model_override',
          payload: { task: 'extraction', model: 'anthropic/claude-haiku-3.5' },
        }),
      );
      expect(result.llm.modelOverrides?.extraction).toBe('anthropic/claude-haiku-3.5');
    });

    it('preserves existing overrides when setting a new one', () => {
      const config = makeConfig({
        llm: {
          primaryModel: 'anthropic/claude-sonnet-4-20250514',
          modelOverrides: { extraction: 'anthropic/claude-haiku-3.5' },
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_model_override',
          payload: { task: 'qualityAudit', model: 'openai/gpt-4o' },
        }),
      );
      expect(result.llm.modelOverrides?.extraction).toBe('anthropic/claude-haiku-3.5');
      expect(result.llm.modelOverrides?.qualityAudit).toBe('openai/gpt-4o');
    });
  });

  describe('clear_model_override', () => {
    it('clears a model override for a task', () => {
      const config = makeConfig({
        llm: {
          primaryModel: 'anthropic/claude-sonnet-4-20250514',
          modelOverrides: {
            extraction: 'anthropic/claude-haiku-3.5',
            qualityAudit: 'openai/gpt-4o',
          },
        },
      });
      const result = executor.apply(
        config,
        makeAction({ type: 'clear_model_override', payload: { task: 'extraction' } }),
      );
      expect(result.llm.modelOverrides?.extraction).toBeUndefined();
      expect(result.llm.modelOverrides?.qualityAudit).toBe('openai/gpt-4o');
    });
  });

  // --- Reconciliation Config ---

  describe('set_match_strategy', () => {
    it('sets match strategy on a config without reconciliation', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_match_strategy',
          payload: { matchStrategy: 'fuzzy_name', fuzzyMatchThreshold: 0.7 },
        }),
      );
      expect(result.reconciliation).toBeDefined();
      expect(result.reconciliation!.matchStrategy).toBe('fuzzy_name');
      expect(result.reconciliation!.fuzzyMatchThreshold).toBe(0.7);
    });

    it('sets enableLLMMatching', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_match_strategy',
          payload: { matchStrategy: 'llm_assisted', enableLLMMatching: true },
        }),
      );
      expect(result.reconciliation!.matchStrategy).toBe('llm_assisted');
      expect(result.reconciliation!.enableLLMMatching).toBe(true);
    });
  });

  describe('set_conflict_resolution', () => {
    it('sets conflict resolution strategy', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_conflict_resolution',
          payload: { strategy: 'source_priority' },
        }),
      );
      expect(result.reconciliation).toBeDefined();
      expect(result.reconciliation!.conflictResolution).toBe('source_priority');
    });
  });

  describe('set_source_priority', () => {
    it('sets source priority rankings as domain strings', () => {
      const config = makeConfig();
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_source_priority',
          payload: {
            rankings: [
              { domain: 'manufacturer.com', trustLevel: 'authoritative' },
              { domain: 'retailer.com', trustLevel: 'high' },
            ],
          },
        }),
      );
      expect(result.reconciliation).toBeDefined();
      expect(result.reconciliation!.sourcePriority).toEqual(['manufacturer.com', 'retailer.com']);
    });
  });

  // --- Safety / Templates / Control (no-ops) ---

  describe('no-op actions', () => {
    it('set_action_approval_policy is a no-op', () => {
      const config = makeConfig({ name: 'test' });
      const result = executor.apply(
        config,
        makeAction({
          type: 'set_action_approval_policy',
          payload: { preset: 'cautious' },
        }),
      );
      expect(result).toEqual(config);
    });

    it('save_as_template is a no-op', () => {
      const config = makeConfig({ name: 'test' });
      const result = executor.apply(
        config,
        makeAction({
          type: 'save_as_template',
          payload: { templateName: 'my-template' },
        }),
      );
      expect(result).toEqual(config);
    });

    it('load_template is a no-op', () => {
      const config = makeConfig({ name: 'test' });
      const result = executor.apply(
        config,
        makeAction({
          type: 'load_template',
          payload: { templateName: 'my-template' },
        }),
      );
      expect(result).toEqual(config);
    });

    it('clone_job_config is a no-op', () => {
      const config = makeConfig({ name: 'test' });
      const result = executor.apply(
        config,
        makeAction({
          type: 'clone_job_config',
          payload: { sourceJobId: '550e8400-e29b-41d4-a716-446655440099' },
        }),
      );
      expect(result).toEqual(config);
    });

    it('confirm_and_start is a no-op', () => {
      const config = makeConfig({ name: 'test' });
      const result = executor.apply(
        config,
        makeAction({ type: 'confirm_and_start', payload: {} }),
      );
      expect(result).toEqual(config);
    });
  });

  // --- Reset ---

  describe('reset_config', () => {
    it('resets everything to empty defaults', () => {
      const config = makeConfig({
        name: 'Audiophile Crawl',
        description: 'Crawl audiophile forums',
        seedUrls: ['https://head-fi.org'],
        schema: {
          mode: 'fixed',
          userFields: [
            { name: 'brand', description: 'Brand', type: 'string', required: true },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({ type: 'reset_config', payload: {} }),
      );
      expect(result.name).toBe('');
      expect(result.description).toBe('');
      expect(result.seedUrls).toEqual([]);
      expect(result.schema.userFields).toBeUndefined();
      // Preserves tenantId
      expect(result.tenantId).toBe(config.tenantId);
    });

    it('preserves specified fields when keepFields is set', () => {
      const config = makeConfig({
        name: 'Audiophile Crawl',
        description: 'Crawl audiophile forums',
        seedUrls: ['https://head-fi.org'],
        schema: {
          mode: 'fixed',
          userFields: [
            { name: 'brand', description: 'Brand', type: 'string', required: true },
          ],
        },
      });
      const result = executor.apply(
        config,
        makeAction({
          type: 'reset_config',
          payload: { keepFields: ['name', 'seedUrls'] },
        }),
      );
      expect(result.name).toBe('Audiophile Crawl');
      expect(result.seedUrls).toEqual(['https://head-fi.org']);
      expect(result.description).toBe('');
      expect(result.schema.userFields).toBeUndefined();
    });
  });

  // --- applyBatch ---

  describe('applyBatch', () => {
    it('applies multiple actions in order', () => {
      const config = makeConfig();
      const actions: ConfigAction[] = [
        makeAction({ type: 'set_job_name', payload: { name: 'Audiophile Crawl' } }),
        makeAction({
          type: 'add_seed_urls',
          payload: { urls: [{ url: 'https://head-fi.org' }] },
        }),
        makeAction({ type: 'set_crawl_depth', payload: { maxDepth: 3 } }),
        makeAction({
          type: 'add_user_field',
          payload: {
            field: { name: 'brand', description: 'Brand', type: 'string', required: true },
            position: 'last',
          },
        }),
      ];
      const result = executor.applyBatch(config, actions);
      expect(result.name).toBe('Audiophile Crawl');
      expect(result.seedUrls).toEqual(['https://head-fi.org']);
      expect(result.crawl.maxDepth).toBe(3);
      expect(result.schema.userFields).toHaveLength(1);
    });

    it('does not mutate the original config', () => {
      const config = makeConfig({ name: 'original' });
      executor.applyBatch(config, [
        makeAction({ type: 'set_job_name', payload: { name: 'changed' } }),
      ]);
      expect(config.name).toBe('original');
    });
  });

  // --- validate ---

  describe('validate', () => {
    it('reports missing required fields for an empty config', () => {
      const config = makeConfig();
      const result = executor.validate(config);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('name');
      expect(result.missing).toContain('seedUrls');
    });

    it('returns valid for a complete config', () => {
      const config = makeConfig({
        name: 'Audiophile Crawl',
        description: 'Crawl audiophile forums',
        seedUrls: ['https://head-fi.org'],
        schema: {
          mode: 'discovery',
          userFields: [
            { name: 'brand', description: 'Brand', type: 'string', required: true },
          ],
        },
      });
      const result = executor.validate(config);
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('produces warnings for configs that are valid but could be better', () => {
      const config = makeConfig({
        name: 'Audiophile Crawl',
        seedUrls: ['https://head-fi.org'],
        schema: { mode: 'discovery' },
      });
      const result = executor.validate(config);
      // Valid because it has name and seedUrls, but warnings about no description or user fields
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  // --- diff ---

  describe('diff', () => {
    it('detects changed fields', () => {
      const before = makeConfig({ name: 'Old Name' });
      const after = makeConfig({ name: 'New Name' });
      const result = executor.diff(before, after);
      expect(result.changes.length).toBeGreaterThan(0);
      const nameChange = result.changes.find((c) => c.path === 'name');
      expect(nameChange).toBeDefined();
      expect(nameChange!.before).toBe('Old Name');
      expect(nameChange!.after).toBe('New Name');
    });

    it('returns empty changes for identical configs', () => {
      const config = makeConfig({ name: 'Same' });
      const result = executor.diff(config, config);
      expect(result.changes).toHaveLength(0);
    });

    it('detects seed URL changes', () => {
      const before = makeConfig({ seedUrls: ['https://a.com'] });
      const after = makeConfig({ seedUrls: ['https://a.com', 'https://b.com'] });
      const result = executor.diff(before, after);
      const seedChange = result.changes.find((c) => c.path === 'seedUrls');
      expect(seedChange).toBeDefined();
    });

    it('detects crawl setting changes', () => {
      const before = makeConfig();
      const after = makeConfig({
        crawl: { maxDepth: 5, maxPages: 1000, concurrency: 5, crawlerType: 'playwright' },
      });
      const result = executor.diff(before, after);
      const crawlChange = result.changes.find((c) => c.path === 'crawl.maxDepth');
      expect(crawlChange).toBeDefined();
      expect(crawlChange!.before).toBe(2);
      expect(crawlChange!.after).toBe(5);
    });
  });
});
