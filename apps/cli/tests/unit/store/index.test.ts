import { describe, it, expect, beforeEach } from 'vitest';
import type { ConfigAction, JobConfig, ConfigValidationResult } from '@spatula/core';
import { createCliStore, type CliStore, type ChatMessage, type CliMode, type CliState } from '../../../src/store/index.js';

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeAction(
  type: string,
  payload: Record<string, unknown>,
  overrides?: Partial<ConfigAction>,
): ConfigAction {
  return {
    type,
    id: crypto.randomUUID(),
    reasoning: `Test action: ${type}`,
    payload,
    ...overrides,
  } as ConfigAction;
}

describe('CliStore', () => {
  let store: CliStore;

  beforeEach(() => {
    store = createCliStore(TEST_TENANT_ID);
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts in conversational mode', () => {
      expect(store.getState().mode).toBe('conversational');
    });

    it('has empty config with tenant id and defaults', () => {
      const { config } = store.getState();
      expect(config.tenantId).toBe(TEST_TENANT_ID);
      expect(config.name).toBe('');
      expect(config.description).toBe('');
      expect(config.seedUrls).toEqual([]);
      expect(config.crawl).toEqual({
        maxDepth: 2,
        maxPages: 1000,
        concurrency: 5,
        crawlerType: 'playwright',
      });
      expect(config.schema).toEqual({ mode: 'discovery' });
      expect(config.llm).toEqual({ primaryModel: 'anthropic/claude-sonnet-4-20250514' });
    });

    it('has empty messages', () => {
      expect(store.getState().messages).toEqual([]);
    });

    it('has empty action history', () => {
      expect(store.getState().actionHistory).toEqual([]);
    });

    it('is not loading', () => {
      expect(store.getState().isLoading).toBe(false);
    });

    it('has no active job id', () => {
      expect(store.getState().activeJobId).toBeNull();
    });

    it('has no error', () => {
      expect(store.getState().error).toBeNull();
    });

    it('has null job data', () => {
      expect(store.getState().jobData).toBeNull();
    });

    it('has empty pending actions', () => {
      expect(store.getState().pendingActions).toEqual([]);
    });

    it('has null schema data', () => {
      expect(store.getState().schemaData).toBeNull();
    });

    it('has empty entity previews', () => {
      expect(store.getState().entityPreviews).toEqual([]);
    });

    it('has review index at 0', () => {
      expect(store.getState().reviewIndex).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Mode switching
  // -------------------------------------------------------------------------

  describe('mode switching', () => {
    it('switches to dashboard mode', () => {
      store.getState().setMode('dashboard');
      expect(store.getState().mode).toBe('dashboard');
    });

    it('switches to review mode', () => {
      store.getState().setMode('review');
      expect(store.getState().mode).toBe('review');
    });

    it('switches to explorer mode', () => {
      store.getState().setMode('explorer');
      expect(store.getState().mode).toBe('explorer');
    });

    it('switches back to conversational mode', () => {
      store.getState().setMode('dashboard');
      store.getState().setMode('conversational');
      expect(store.getState().mode).toBe('conversational');
    });
  });

  // -------------------------------------------------------------------------
  // Apply config actions
  // -------------------------------------------------------------------------

  describe('applyActions', () => {
    it('applies a single config action', () => {
      const action = makeAction('set_job_name', { name: 'Test Job' });
      store.getState().applyActions([action]);
      expect(store.getState().config.name).toBe('Test Job');
    });

    it('applies multiple config actions', () => {
      const actions = [
        makeAction('set_job_name', { name: 'Multi-Action Job' }),
        makeAction('set_job_description', { description: 'A test description' }),
        makeAction('add_seed_urls', {
          urls: [{ url: 'https://example.com' }],
        }),
      ];
      store.getState().applyActions(actions);

      const { config } = store.getState();
      expect(config.name).toBe('Multi-Action Job');
      expect(config.description).toBe('A test description');
      expect(config.seedUrls).toEqual(['https://example.com']);
    });

    it('tracks actions in actionHistory', () => {
      const action1 = makeAction('set_job_name', { name: 'Job 1' });
      const action2 = makeAction('set_crawl_depth', { maxDepth: 5 });

      store.getState().applyActions([action1]);
      store.getState().applyActions([action2]);

      const { actionHistory } = store.getState();
      expect(actionHistory).toHaveLength(2);
      expect(actionHistory[0]).toBe(action1);
      expect(actionHistory[1]).toBe(action2);
    });

    it('accumulates actions across multiple applyActions calls', () => {
      const actions1 = [
        makeAction('set_job_name', { name: 'Accumulated' }),
        makeAction('set_crawl_depth', { maxDepth: 3 }),
      ];
      const actions2 = [makeAction('set_max_pages', { maxPages: 500 })];

      store.getState().applyActions(actions1);
      store.getState().applyActions(actions2);

      expect(store.getState().actionHistory).toHaveLength(3);
      expect(store.getState().config.name).toBe('Accumulated');
      expect(store.getState().config.crawl.maxDepth).toBe(3);
      expect(store.getState().config.crawl.maxPages).toBe(500);
    });

    it('does not mutate config on empty actions array', () => {
      const before = store.getState().config;
      store.getState().applyActions([]);
      const after = store.getState().config;
      // Config should be unchanged (but may be a new reference from structuredClone)
      expect(after.name).toBe(before.name);
      expect(after.seedUrls).toEqual(before.seedUrls);
    });
  });

  // -------------------------------------------------------------------------
  // Config reset
  // -------------------------------------------------------------------------

  describe('resetConfig', () => {
    it('resets config to empty defaults', () => {
      store.getState().applyActions([
        makeAction('set_job_name', { name: 'To Be Reset' }),
        makeAction('add_seed_urls', { urls: [{ url: 'https://example.com' }] }),
      ]);

      store.getState().resetConfig();

      const { config } = store.getState();
      expect(config.tenantId).toBe(TEST_TENANT_ID);
      expect(config.name).toBe('');
      expect(config.seedUrls).toEqual([]);
      expect(config.crawl).toEqual({
        maxDepth: 2,
        maxPages: 1000,
        concurrency: 5,
        crawlerType: 'playwright',
      });
    });

    it('clears action history on reset', () => {
      store.getState().applyActions([
        makeAction('set_job_name', { name: 'Job' }),
      ]);
      expect(store.getState().actionHistory).toHaveLength(1);

      store.getState().resetConfig();
      expect(store.getState().actionHistory).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Chat messages
  // -------------------------------------------------------------------------

  describe('messages', () => {
    it('adds a user message with automatic timestamp', () => {
      const before = Date.now();
      store.getState().addMessage({ role: 'user', content: 'Hello' });
      const after = Date.now();

      const { messages } = store.getState();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');
      expect(messages[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(messages[0].timestamp).toBeLessThanOrEqual(after);
    });

    it('adds an assistant message with actions', () => {
      const actions = [makeAction('set_job_name', { name: 'From Chat' })];
      store.getState().addMessage({
        role: 'assistant',
        content: 'Setting the name.',
        actions,
      });

      const { messages } = store.getState();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].actions).toEqual(actions);
    });

    it('adds a system message', () => {
      store.getState().addMessage({ role: 'system', content: 'System prompt' });
      expect(store.getState().messages).toHaveLength(1);
      expect(store.getState().messages[0].role).toBe('system');
    });

    it('accumulates messages in order', () => {
      store.getState().addMessage({ role: 'user', content: 'First' });
      store.getState().addMessage({ role: 'assistant', content: 'Second' });
      store.getState().addMessage({ role: 'user', content: 'Third' });

      const { messages } = store.getState();
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });

    it('clears all messages', () => {
      store.getState().addMessage({ role: 'user', content: 'Hello' });
      store.getState().addMessage({ role: 'assistant', content: 'Hi' });
      expect(store.getState().messages).toHaveLength(2);

      store.getState().clearMessages();
      expect(store.getState().messages).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  describe('loading state', () => {
    it('sets loading to true', () => {
      store.getState().setLoading(true);
      expect(store.getState().isLoading).toBe(true);
    });

    it('sets loading to false', () => {
      store.getState().setLoading(true);
      store.getState().setLoading(false);
      expect(store.getState().isLoading).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Active job id
  // -------------------------------------------------------------------------

  describe('active job id', () => {
    it('sets an active job id', () => {
      store.getState().setActiveJobId('job-123');
      expect(store.getState().activeJobId).toBe('job-123');
    });

    it('clears the active job id', () => {
      store.getState().setActiveJobId('job-123');
      store.getState().setActiveJobId(null);
      expect(store.getState().activeJobId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------

  describe('error state', () => {
    it('sets an error message', () => {
      store.getState().setError('Something went wrong');
      expect(store.getState().error).toBe('Something went wrong');
    });

    it('clears the error', () => {
      store.getState().setError('Some error');
      store.getState().setError(null);
      expect(store.getState().error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe('validateConfig', () => {
    it('returns invalid for empty config', () => {
      const result = store.getState().validateConfig();
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('name');
      expect(result.missing).toContain('seedUrls');
    });

    it('returns valid for a complete config', () => {
      store.getState().applyActions([
        makeAction('set_job_name', { name: 'Valid Job' }),
        makeAction('add_seed_urls', {
          urls: [{ url: 'https://example.com' }],
        }),
      ]);

      const result = store.getState().validateConfig();
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('includes warnings for missing description', () => {
      store.getState().applyActions([
        makeAction('set_job_name', { name: 'Job' }),
        makeAction('add_seed_urls', {
          urls: [{ url: 'https://example.com' }],
        }),
      ]);

      const result = store.getState().validateConfig();
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Job runtime state
  // -------------------------------------------------------------------------

  describe('job runtime state', () => {
    it('stores and retrieves job data', () => {
      const jobData = { id: 'job-1', status: 'running', progress: 42 };
      store.getState().setJobData(jobData);
      expect(store.getState().jobData).toEqual(jobData);
    });

    it('clears job data', () => {
      store.getState().setJobData({ id: 'job-1', status: 'running' });
      store.getState().setJobData(null);
      expect(store.getState().jobData).toBeNull();
    });

    it('stores pending actions', () => {
      const actions = [
        { id: 'a1', type: 'schema_change', payload: {} },
        { id: 'a2', type: 'review_entity', payload: {} },
      ];
      store.getState().setPendingActions(actions);
      expect(store.getState().pendingActions).toEqual(actions);
      expect(store.getState().pendingActions).toHaveLength(2);
    });

    it('removes action from pending list', () => {
      const actions = [
        { id: 'a1', type: 'schema_change', payload: {} },
        { id: 'a2', type: 'review_entity', payload: {} },
        { id: 'a3', type: 'approve', payload: {} },
      ];
      store.getState().setPendingActions(actions);
      store.getState().removeAction('a2');

      const remaining = store.getState().pendingActions;
      expect(remaining).toHaveLength(2);
      expect(remaining.map((a) => a.id)).toEqual(['a1', 'a3']);
    });

    it('stores schema data', () => {
      const schema = { fields: [{ name: 'title', type: 'string' }], version: 3 };
      store.getState().setSchemaData(schema);
      expect(store.getState().schemaData).toEqual(schema);
    });

    it('stores entity previews', () => {
      const entities = [
        { id: 'e1', name: 'Apple Inc.', type: 'company' },
        { id: 'e2', name: 'Google LLC', type: 'company' },
      ];
      store.getState().setEntityPreviews(entities);
      expect(store.getState().entityPreviews).toEqual(entities);
      expect(store.getState().entityPreviews).toHaveLength(2);
    });

    it('tracks current review index', () => {
      store.getState().setReviewIndex(5);
      expect(store.getState().reviewIndex).toBe(5);

      store.getState().setReviewIndex(10);
      expect(store.getState().reviewIndex).toBe(10);
    });

    it('clamps review index to 0 minimum', () => {
      store.getState().setReviewIndex(-3);
      expect(store.getState().reviewIndex).toBe(0);

      store.getState().setReviewIndex(-100);
      expect(store.getState().reviewIndex).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Store isolation
  // -------------------------------------------------------------------------

  describe('store isolation', () => {
    it('creates independent store instances', () => {
      const store1 = createCliStore(TEST_TENANT_ID);
      const store2 = createCliStore('660e8400-e29b-41d4-a716-446655440001');

      store1.getState().applyActions([
        makeAction('set_job_name', { name: 'Store 1 Job' }),
      ]);

      expect(store1.getState().config.name).toBe('Store 1 Job');
      expect(store2.getState().config.name).toBe('');
      expect(store2.getState().config.tenantId).toBe('660e8400-e29b-41d4-a716-446655440001');
    });
  });
});
