import { describe, it, expect, vi } from 'vitest';
import { ExtractionError } from '@spatula/shared';
import { StaticExtractor } from '../../../src/extraction/static-extractor.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      finishReason: 'stop',
    } satisfies LLMCompletionResponse),
  };
}

const config: LLMConfig = { primaryModel: 'test-model' };

const testSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'product_name', description: 'Product name', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'currency', required: false },
    { name: 'description', description: 'Description', type: 'string', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date('2026-01-01'),
  parentVersion: null,
};

const sampleHtml = `
<html><body>
  <h1>Sony WH-1000XM5</h1>
  <p class="price">$379.99</p>
  <p>Industry-leading noise cancellation headphones.</p>
</body></html>
`;

describe('StaticExtractor', () => {
  it('extracts data from HTML and returns ExtractionResult', async () => {
    const client = createMockClient(
      JSON.stringify({
        data: {
          product_name: 'Sony WH-1000XM5',
          price: { amount: 379.99, currency: 'USD' },
          description: 'Industry-leading noise cancellation headphones.',
        },
        _unmapped: [],
        confidence: 0.92,
      }),
    );
    const extractor = new StaticExtractor(client, config, 'job-id-123');
    const result = await extractor.extract(
      sampleHtml,
      'https://example.com/product/123',
      testSchema,
      'audiophile headphones',
    );
    expect(result.jobId).toBe('job-id-123');
    expect(result.schemaVersion).toBe(1);
    expect(result.data.product_name).toBe('Sony WH-1000XM5');
    expect(result.data.price).toEqual({ amount: 379.99, currency: 'USD' });
    expect(result.metadata.confidence).toBe(0.92);
    expect(result.metadata.modelUsed).toBe('test-model');
    expect(result.metadata.tokensUsed).toBe(300);
    expect(result.metadata.extractionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.unmappedFields).toEqual([]);
    expect(result.id).toBeDefined();
    expect(result.pageId).toBeDefined();
  });

  it('captures unmapped fields in metadata', async () => {
    const client = createMockClient(
      JSON.stringify({
        data: { product_name: 'Test' },
        _unmapped: [
          { name: 'driver_type', value: '40mm dynamic', suggestedType: 'string' },
          { name: 'weight', value: '250g', suggestedType: 'string' },
        ],
        confidence: 0.85,
      }),
    );
    const extractor = new StaticExtractor(client, config, 'job-1');
    const result = await extractor.extract(
      sampleHtml,
      'https://example.com',
      testSchema,
      'products',
    );
    expect(result.metadata.unmappedFields).toHaveLength(2);
    expect(result.metadata.unmappedFields[0].name).toBe('driver_type');
    expect(result.metadata.unmappedFields[1].name).toBe('weight');
  });

  it('uses extraction model from config', async () => {
    const client = createMockClient(JSON.stringify({ data: {}, _unmapped: [], confidence: 0.5 }));
    const configWithOverride: LLMConfig = {
      primaryModel: 'primary',
      modelOverrides: { extraction: 'extraction-model' },
    };
    const extractor = new StaticExtractor(client, configWithOverride, 'job-1');
    await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');
    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'extraction-model' }),
    );
  });

  it('enables JSON mode for LLM request', async () => {
    const client = createMockClient(JSON.stringify({ data: {}, _unmapped: [], confidence: 0.5 }));
    const extractor = new StaticExtractor(client, config, 'job-1');
    await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');
    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({ jsonMode: true }));
  });

  it('returns empty extraction on invalid JSON from LLM', async () => {
    const client = createMockClient('totally not json {}{}');
    const extractor = new StaticExtractor(client, config, 'job-1');
    const result = await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');
    expect(result.data).toEqual({});
    expect(result.metadata.confidence).toBe(0);
    expect(result.metadata.unmappedFields).toEqual([]);
  });

  it('throws ExtractionError when LLM client throws', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };
    const extractor = new StaticExtractor(client, config, 'job-1');
    await expect(
      extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test'),
    ).rejects.toThrow(ExtractionError);
  });

  it('generates unique ids for each extraction', async () => {
    const client = createMockClient(
      JSON.stringify({ data: { product_name: 'A' }, _unmapped: [], confidence: 0.9 }),
    );
    const extractor = new StaticExtractor(client, config, 'job-1');
    const r1 = await extractor.extract(sampleHtml, 'https://example.com/1', testSchema, 'test');
    const r2 = await extractor.extract(sampleHtml, 'https://example.com/2', testSchema, 'test');
    expect(r1.id).not.toBe(r2.id);
    expect(r1.pageId).not.toBe(r2.pageId);
  });

  it('includes schema fields description in LLM prompt', async () => {
    const client = createMockClient(JSON.stringify({ data: {}, _unmapped: [], confidence: 0.5 }));
    const extractor = new StaticExtractor(client, config, 'job-1');
    await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');
    const messages = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    const userMessage = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('product_name');
    expect(userMessage).toContain('price');
    expect(userMessage).toContain('REQUIRED');
  });
});
