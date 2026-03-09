import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../../src/llm/model-router.js';
import type { LLMConfig } from '../../../src/types/job.js';

describe('resolveModel', () => {
  const defaultConfig: LLMConfig = {
    primaryModel: 'anthropic/claude-sonnet-4-20250514',
  };

  it('returns primary model when no overrides configured', () => {
    expect(resolveModel(defaultConfig, 'extraction')).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('returns primary model for tasks without specific override', () => {
    const config: LLMConfig = {
      primaryModel: 'anthropic/claude-sonnet-4-20250514',
      modelOverrides: {
        pageRelevance: 'anthropic/claude-haiku-4-5-20251001',
      },
    };
    expect(resolveModel(config, 'extraction')).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('returns override model when set for specific task', () => {
    const config: LLMConfig = {
      primaryModel: 'anthropic/claude-sonnet-4-20250514',
      modelOverrides: {
        pageRelevance: 'anthropic/claude-haiku-4-5-20251001',
      },
    };
    expect(resolveModel(config, 'pageRelevance')).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  it('resolves all task types without error', () => {
    const tasks = [
      'pageRelevance',
      'extraction',
      'linkEvaluation',
      'schemaEvolution',
      'entityMatching',
      'conflictResolution',
      'qualityAudit',
      'documentation',
    ] as const;
    for (const task of tasks) {
      expect(() => resolveModel(defaultConfig, task)).not.toThrow();
    }
  });

  it('uses custom primary model when configured', () => {
    const config: LLMConfig = { primaryModel: 'openai/gpt-4o' };
    expect(resolveModel(config, 'extraction')).toBe('openai/gpt-4o');
  });
});
