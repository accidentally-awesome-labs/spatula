import { describe, it, expect } from 'vitest';
import { ConfigAction } from '../../../src/types/config-actions.js';

describe('ConfigAction', () => {
  const base = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    reasoning: 'User requested this change',
  };

  it('parses set_job_name', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'set_job_name',
      payload: { name: 'Audiophile Crawl' },
    });
    expect(result.type).toBe('set_job_name');
  });

  it('parses add_seed_urls', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'add_seed_urls',
      payload: {
        urls: [
          { url: 'https://head-fi.org', label: 'Head-Fi' },
          { url: 'https://audiosciencereview.com' },
        ],
      },
    });
    expect(result.payload.urls).toHaveLength(2);
  });

  it('parses set_crawl_depth', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'set_crawl_depth',
      payload: { maxDepth: 3 },
    });
    expect(result.payload.maxDepth).toBe(3);
  });

  it('parses add_user_field', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'add_user_field',
      payload: {
        field: { name: 'brand', description: 'Product brand', type: 'string', required: true },
      },
    });
    expect(result.payload.field.name).toBe('brand');
  });

  it('parses modify_user_field', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'modify_user_field',
      payload: {
        fieldName: 'price',
        changes: { required: true, type: 'currency' },
      },
    });
    expect(result.payload.changes.required).toBe(true);
  });

  it('parses set_schema_mode', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'set_schema_mode',
      payload: { mode: 'hybrid' },
    });
    expect(result.payload.mode).toBe('hybrid');
  });

  it('parses set_primary_model', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'set_primary_model',
      payload: { model: 'anthropic/claude-sonnet-4-20250514' },
    });
    expect(result.payload.model).toContain('claude');
  });

  it('parses set_model_override', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'set_model_override',
      payload: { task: 'pageRelevance', model: 'anthropic/claude-haiku-4-5-20251001' },
    });
    expect(result.payload.task).toBe('pageRelevance');
  });

  it('parses set_action_approval_policy', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'set_action_approval_policy',
      payload: { preset: 'trust_ai' },
    });
    expect(result.payload.preset).toBe('trust_ai');
  });

  it('parses save_as_template', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'save_as_template',
      payload: { templateName: 'audiophile-default', description: 'Default audiophile config' },
    });
    expect(result.payload.templateName).toBe('audiophile-default');
  });

  it('parses confirm_and_start', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'confirm_and_start',
      payload: {},
    });
    expect(result.type).toBe('confirm_and_start');
  });

  it('parses reset_config', () => {
    const result = ConfigAction.parse({
      ...base,
      type: 'reset_config',
      payload: { keepFields: ['name', 'seedUrls'] },
    });
    expect(result.payload.keepFields).toContain('name');
  });

  it('rejects unknown action type', () => {
    expect(() => ConfigAction.parse({ ...base, type: 'nonexistent', payload: {} })).toThrow();
  });
});
