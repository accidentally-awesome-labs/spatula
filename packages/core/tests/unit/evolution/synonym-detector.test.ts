import { describe, it, expect, vi } from 'vitest';
import { SynonymDetector } from '../../../src/evolution/synonym-detector.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { AggregatedField } from '../../../src/evolution/unmapped-aggregator.js';

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

const baseSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'product_name', description: 'Product name', type: 'string', required: true },
    { name: 'price', description: 'Price in dollars', type: 'currency', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date('2026-01-01'),
  parentVersion: null,
};

const sampleAggregatedFields: AggregatedField[] = [
  {
    normalizedName: 'cost',
    observedNames: ['Cost', 'cost'],
    occurrences: 7,
    frequency: 0.7,
    dominantType: 'currency',
    typeCounts: { currency: 7 },
    sampleValues: ['$29.99', '$49.99', '$14.50'],
  },
  {
    normalizedName: 'colour',
    observedNames: ['Colour', 'colour'],
    occurrences: 5,
    frequency: 0.5,
    dominantType: 'string',
    typeCounts: { string: 5 },
    sampleValues: ['Red', 'Blue', 'Green'],
  },
];

const validLLMResponse = JSON.stringify({
  merges: [
    {
      canonicalName: 'price',
      aliasNames: ['cost'],
      canonicalDefinition: {
        name: 'price',
        description: 'Product price in dollars',
        type: 'currency',
        required: false,
      },
      reasoning: 'Both "price" and "cost" represent the monetary value of the product.',
      confidence: 0.95,
    },
  ],
});

describe('SynonymDetector', () => {
  it('detects synonym pairs and proposes merge_fields actions', async () => {
    const client = createMockClient(validLLMResponse);
    const detector = new SynonymDetector(client, config);

    const actions = await detector.detect(baseSchema, sampleAggregatedFields, 'product catalog');

    expect(actions).toHaveLength(1);

    const action = actions[0];
    expect(action.type).toBe('merge_fields');
    expect(action.source).toBe('schema_evolution');
    expect(action.confidence).toBe(0.95);
    expect(action.reasoning).toContain('price');
    expect(action.reasoning).toContain('cost');
    expect(action.id).toBeDefined();
    expect(action.jobId).toBeDefined();

    // Verify payload structure
    if (action.type !== 'merge_fields') throw new Error('expected merge_fields');
    expect(action.payload.canonicalName).toBe('price');
    expect(action.payload.aliasNames).toEqual(['cost']);
    expect(action.payload.canonicalDefinition.name).toBe('price');
    expect(action.payload.canonicalDefinition.type).toBe('currency');
    expect(action.payload.valueMappings).toEqual({});

    // Verify LLM was called with correct parameters
    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test-model',
        jsonMode: true,
        temperature: 0,
      }),
    );
  });

  it('returns empty when no synonyms found', async () => {
    const noMergesResponse = JSON.stringify({ merges: [] });
    const client = createMockClient(noMergesResponse);
    const detector = new SynonymDetector(client, config);

    const actions = await detector.detect(baseSchema, sampleAggregatedFields, 'product catalog');

    expect(actions).toEqual([]);
    // LLM should still have been called
    expect(client.complete).toHaveBeenCalled();
  });

  it('returns empty on LLM error', async () => {
    const failClient: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('network failure')),
    };
    const detector = new SynonymDetector(failClient, config);

    const actions = await detector.detect(baseSchema, sampleAggregatedFields, 'product catalog');

    expect(actions).toEqual([]);
  });

  it('returns empty when fewer than 2 total fields', async () => {
    const client = createMockClient(validLLMResponse);
    const detector = new SynonymDetector(client, config);

    const singleFieldSchema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'product_name', description: 'Product name', type: 'string', required: true },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-01-01'),
      parentVersion: null,
    };

    const actions = await detector.detect(singleFieldSchema, [], 'product catalog');

    expect(actions).toEqual([]);
    // LLM should NOT have been called
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('returns empty on non-JSON LLM response', async () => {
    const client = createMockClient('this is not valid json');
    const detector = new SynonymDetector(client, config);

    const actions = await detector.detect(baseSchema, sampleAggregatedFields, 'product catalog');

    expect(actions).toEqual([]);
  });

  it('returns empty when LLM returns valid JSON with wrong shape', async () => {
    const client = createMockClient(JSON.stringify({ wrong: 'shape' }));
    const detector = new SynonymDetector(client, config);

    const actions = await detector.detect(baseSchema, sampleAggregatedFields, 'product catalog');

    expect(actions).toEqual([]);
  });

  it('includes schema fields, unmapped fields, and job description in LLM prompt', async () => {
    const client = createMockClient(validLLMResponse);
    const detector = new SynonymDetector(client, config);

    await detector.detect(baseSchema, sampleAggregatedFields, 'audiophile headphones');

    const messages = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    const userMessage = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';

    // Current schema fields should appear in the prompt
    expect(userMessage).toContain('product_name');
    expect(userMessage).toContain('price');

    // Unmapped fields should appear in the prompt
    expect(userMessage).toContain('cost');
    expect(userMessage).toContain('colour');

    // Sample values should appear
    expect(userMessage).toContain('$29.99');

    // Job description should appear
    expect(userMessage).toContain('audiophile headphones');
  });

  it('handles multiple merge proposals', async () => {
    const multiMergeResponse = JSON.stringify({
      merges: [
        {
          canonicalName: 'price',
          aliasNames: ['cost', 'unit_price'],
          canonicalDefinition: {
            name: 'price',
            description: 'Product price',
            type: 'currency',
            required: false,
          },
          reasoning: 'All represent monetary cost',
          confidence: 0.92,
        },
        {
          canonicalName: 'color',
          aliasNames: ['colour'],
          canonicalDefinition: {
            name: 'color',
            description: 'Product color',
            type: 'string',
            required: false,
          },
          reasoning: 'British vs American spelling',
          confidence: 0.99,
        },
      ],
    });

    const client = createMockClient(multiMergeResponse);
    const detector = new SynonymDetector(client, config);

    const actions = await detector.detect(baseSchema, sampleAggregatedFields, 'product catalog');

    expect(actions).toHaveLength(2);

    // Verify both are merge_fields actions
    expect(actions[0].type).toBe('merge_fields');
    expect(actions[1].type).toBe('merge_fields');

    // Verify they have distinct IDs
    expect(actions[0].id).not.toBe(actions[1].id);

    // Verify second merge
    if (actions[1].type !== 'merge_fields') throw new Error('expected merge_fields');
    expect(actions[1].payload.canonicalName).toBe('color');
    expect(actions[1].payload.aliasNames).toEqual(['colour']);
    expect(actions[1].confidence).toBe(0.99);
  });
});
