import { describe, it, expect, vi } from 'vitest';
import { PageClassifier } from '../../../src/extraction/page-classifier.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
    } satisfies LLMCompletionResponse),
  };
}

const config: LLMConfig = { primaryModel: 'test-model' };

describe('PageClassifier', () => {
  it('classifies a single product page', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'single_entry',
        strategy: 'full_extraction',
        estimatedEntryCount: 1,
        confidence: 0.95,
        reasoning: 'Product detail page with specs and pricing.',
      }),
    );
    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify(
      '<h1>Sony WH-1000XM5</h1><p>$379.99</p>',
      'https://example.com/product/123',
      'audiophile headphones',
    );
    expect(result.classification).toBe('single_entry');
    expect(result.strategy).toBe('full_extraction');
    expect(result.estimatedEntryCount).toBe(1);
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toBeDefined();
  });

  it('classifies a listing page', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'multiple_entries',
        strategy: 'list_extraction',
        estimatedEntryCount: 24,
        confidence: 0.88,
        reasoning: 'Category page with product grid.',
      }),
    );
    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify(
      '<div class="products"><div class="product">A</div></div>',
      'https://example.com/headphones',
      'audiophile headphones',
    );
    expect(result.classification).toBe('multiple_entries');
    expect(result.strategy).toBe('list_extraction');
    expect(result.estimatedEntryCount).toBe(24);
  });

  it('classifies a navigation page', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'navigation',
        strategy: 'links_only',
        confidence: 0.92,
        reasoning: 'Category index page.',
      }),
    );
    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify(
      '<nav><a href="/cat1">Cat 1</a></nav>',
      'https://example.com/categories',
      'audiophile products',
    );
    expect(result.classification).toBe('navigation');
    expect(result.strategy).toBe('links_only');
  });

  it('classifies an irrelevant page', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'irrelevant',
        strategy: 'skip',
        confidence: 0.97,
        reasoning: 'Privacy policy page.',
      }),
    );
    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify(
      '<h1>Privacy Policy</h1><p>We collect...</p>',
      'https://example.com/privacy',
      'audiophile products',
    );
    expect(result.classification).toBe('irrelevant');
    expect(result.strategy).toBe('skip');
  });

  it('uses fast model for page relevance via model router', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'single_entry',
        strategy: 'full_extraction',
        confidence: 0.9,
        reasoning: 'ok',
      }),
    );
    const configWithOverride: LLMConfig = {
      primaryModel: 'primary-model',
      modelOverrides: { pageRelevance: 'fast-model' },
    };
    const classifier = new PageClassifier(client, configWithOverride);
    await classifier.classify('<p>test</p>', 'https://example.com', 'test');
    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'fast-model' }));
  });

  it('enables JSON mode for LLM request', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'single_entry',
        strategy: 'full_extraction',
        confidence: 0.9,
        reasoning: 'ok',
      }),
    );
    const classifier = new PageClassifier(client, config);
    await classifier.classify('<p>test</p>', 'https://example.com', 'test');
    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({ jsonMode: true }));
  });

  it('returns safe defaults when LLM client throws', async () => {
    const failClient: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('network failure')),
    };
    const classifier = new PageClassifier(failClient, config);
    const result = await classifier.classify('<p>test</p>', 'https://example.com', 'products');
    expect(result.classification).toBe('irrelevant');
    expect(result.strategy).toBe('skip');
    expect(result.confidence).toBe(0);
  });

  it('returns safe defaults on invalid JSON from LLM', async () => {
    const client = createMockClient('not valid json at all');
    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify('<p>content</p>', 'https://example.com', 'products');
    expect(result.classification).toBe('irrelevant');
    expect(result.strategy).toBe('skip');
    expect(result.confidence).toBe(0);
  });
});
