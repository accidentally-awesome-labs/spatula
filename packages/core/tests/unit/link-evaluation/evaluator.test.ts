import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMLinkEvaluator } from '../../../src/link-evaluation/evaluator.js';
import type { ExtractedLink } from '../../../src/crawlers/link-extractor.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';

const MOCK_SCHEMA: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'title', description: 'Product title', type: 'string', required: true },
    { name: 'price', description: 'Product price', type: 'currency', required: true },
  ],
  fieldAliases: [],
  createdAt: new Date(),
  parentVersion: null,
};

const MOCK_CONTEXT = {
  description: 'Scrape product listings from an electronics store',
  seedDomains: ['shop.example.com'],
  currentDepth: 1,
  maxDepth: 3,
};

function createMockLLM(response: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content: response,
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
    }),
  };
}

describe('LLMLinkEvaluator', () => {
  it('returns scored links from LLM response', async () => {
    const links: ExtractedLink[] = [
      { url: 'https://shop.example.com/products/laptop', text: 'Gaming Laptop' },
      { url: 'https://shop.example.com/about', text: 'About Us' },
    ];

    const llmResponse = JSON.stringify([
      {
        url: 'https://shop.example.com/products/laptop',
        relevanceScore: 0.95,
        expectedContent: 'single_entry',
        priority: 'high',
        reasoning: 'Product detail page matching target schema',
      },
      {
        url: 'https://shop.example.com/about',
        relevanceScore: 0.1,
        expectedContent: 'unknown',
        priority: 'low',
        reasoning: 'About page, unlikely to contain product data',
      },
    ]);

    const llm = createMockLLM(llmResponse);
    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    const result = await evaluator.evaluate(links, MOCK_CONTEXT, MOCK_SCHEMA);

    expect(result).toHaveLength(2);
    expect(result[0].relevanceScore).toBe(0.95);
    expect(result[0].priority).toBe('high');
    expect(result[1].relevanceScore).toBe(0.1);
    expect(result[1].priority).toBe('low');
  });

  it('batches links in groups of 20', async () => {
    const links: ExtractedLink[] = Array.from({ length: 25 }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      text: `Page ${i}`,
    }));

    const batchResponse = (count: number) =>
      JSON.stringify(
        Array.from({ length: count }, (_, i) => ({
          url: links[i]?.url ?? `https://example.com/page-${i}`,
          relevanceScore: 0.5,
          expectedContent: 'unknown',
          priority: 'medium',
          reasoning: 'Generic page',
        })),
      );

    const llm = createMockLLM(batchResponse(20));
    (llm.complete as any)
      .mockResolvedValueOnce({
        content: batchResponse(20),
        model: 'test-model',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        content: batchResponse(5),
        model: 'test-model',
        usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        finishReason: 'stop',
      });

    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    const result = await evaluator.evaluate(links, MOCK_CONTEXT, MOCK_SCHEMA);

    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(25);
  });

  it('returns empty array for empty input', async () => {
    const llm = createMockLLM('[]');
    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    const result = await evaluator.evaluate([], MOCK_CONTEXT, MOCK_SCHEMA);

    expect(result).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('falls back to low-confidence scores on LLM failure', async () => {
    const links: ExtractedLink[] = [{ url: 'https://example.com/page', text: 'Page' }];

    const llm = createMockLLM('invalid json');
    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    const result = await evaluator.evaluate(links, MOCK_CONTEXT, MOCK_SCHEMA);

    expect(result).toHaveLength(1);
    expect(result[0].relevanceScore).toBe(0.5);
    expect(result[0].priority).toBe('medium');
    expect(result[0].expectedContent).toBe('unknown');
  });

  it('includes schema field names and job description in prompt', async () => {
    const links: ExtractedLink[] = [{ url: 'https://example.com/page', text: 'Test' }];

    const llm = createMockLLM(
      JSON.stringify([
        {
          url: 'https://example.com/page',
          relevanceScore: 0.5,
          expectedContent: 'unknown',
          priority: 'medium',
          reasoning: 'test',
        },
      ]),
    );

    const evaluator = new LLMLinkEvaluator(llm, 'test-model');
    await evaluator.evaluate(links, MOCK_CONTEXT, MOCK_SCHEMA);

    const userPrompt = (llm.complete as any).mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain('title');
    expect(userPrompt).toContain('price');
    expect(userPrompt).toContain('electronics store');
  });
});
