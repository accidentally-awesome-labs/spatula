import { describe, it, expect } from 'vitest';
import {
  getModelPricing,
  MODEL_PRICING,
  DEFAULT_PRICING,
  OLLAMA_PRICING,
  AVG_TOKENS_PER_CALL,
} from '../../../src/cost/pricing.js';

describe('pricing', () => {
  describe('getModelPricing', () => {
    it('returns known model pricing for Anthropic models', () => {
      const pricing = getModelPricing('anthropic/claude-sonnet-4-20250514');
      expect(pricing.promptPer1M).toBe(3.00);
      expect(pricing.completionPer1M).toBe(15.00);
    });

    it('returns known model pricing for Google models', () => {
      const pricing = getModelPricing('google/gemini-2.5-flash');
      expect(pricing.promptPer1M).toBe(0.15);
      expect(pricing.completionPer1M).toBe(0.60);
    });

    it('returns OLLAMA_PRICING for models without provider prefix', () => {
      const pricing = getModelPricing('llama3.2:8b');
      expect(pricing).toBe(OLLAMA_PRICING);
      expect(pricing.promptPer1M).toBe(0);
      expect(pricing.completionPer1M).toBe(0);
    });

    it('returns OLLAMA_PRICING for plain model names', () => {
      expect(getModelPricing('mistral')).toBe(OLLAMA_PRICING);
      expect(getModelPricing('codellama:13b')).toBe(OLLAMA_PRICING);
    });

    it('returns DEFAULT_PRICING for unknown provider/model combos', () => {
      const pricing = getModelPricing('unknown-provider/some-model');
      expect(pricing).toBe(DEFAULT_PRICING);
      expect(pricing.promptPer1M).toBe(1.00);
      expect(pricing.completionPer1M).toBe(5.00);
    });
  });

  describe('MODEL_PRICING', () => {
    it('has positive pricing for all listed models', () => {
      for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
        expect(pricing.promptPer1M, `${model} promptPer1M`).toBeGreaterThan(0);
        expect(pricing.completionPer1M, `${model} completionPer1M`).toBeGreaterThan(0);
      }
    });

    it('completion pricing exceeds prompt pricing for all models', () => {
      for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
        expect(pricing.completionPer1M, `${model}`).toBeGreaterThanOrEqual(pricing.promptPer1M);
      }
    });
  });

  describe('AVG_TOKENS_PER_CALL', () => {
    it('covers all expected LLM task types', () => {
      const expectedTasks = [
        'pageRelevance', 'extraction', 'linkEvaluation', 'schemaEvolution',
        'entityMatching', 'conflictResolution', 'qualityAudit', 'documentation',
      ];
      for (const task of expectedTasks) {
        expect(AVG_TOKENS_PER_CALL[task as keyof typeof AVG_TOKENS_PER_CALL], task).toBeDefined();
      }
    });

    it('has positive prompt and completion token counts for all tasks', () => {
      for (const [task, tokens] of Object.entries(AVG_TOKENS_PER_CALL)) {
        expect(tokens.prompt, `${task} prompt`).toBeGreaterThan(0);
        expect(tokens.completion, `${task} completion`).toBeGreaterThan(0);
      }
    });
  });
});
