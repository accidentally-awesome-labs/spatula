import { describe, it, expect, vi } from 'vitest';
import { FieldProposer } from '../../../src/evolution/field-proposer.js';
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
    { name: 'price', description: 'Price', type: 'currency', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date('2026-01-01'),
  parentVersion: null,
};

const sampleAggregatedFields: AggregatedField[] = [
  {
    normalizedName: 'weight',
    observedNames: ['Weight', 'weight'],
    occurrences: 8,
    frequency: 0.8,
    dominantType: 'string',
    typeCounts: { string: 8 },
    sampleValues: ['250g', '300g', '280g'],
  },
  {
    normalizedName: 'color',
    observedNames: ['Color', 'Colour', 'color'],
    occurrences: 6,
    frequency: 0.6,
    dominantType: 'enum',
    typeCounts: { enum: 5, string: 1 },
    sampleValues: ['Black', 'Silver', 'Blue'],
  },
];

const validLLMResponse = JSON.stringify({
  proposals: [
    {
      name: 'weight',
      description: 'Product weight',
      type: 'string',
      required: false,
      reasoning: 'Frequently observed across extractions and relevant to product comparison.',
      confidence: 0.85,
      relevance: {
        globalFrequency: 0.8,
        categoryBreakdown: [],
        classification: 'universal_optional',
        applicableCategories: null,
      },
    },
    {
      name: 'color',
      description: 'Product color option',
      type: 'enum',
      required: false,
      enumValues: ['Black', 'Silver', 'Blue'],
      reasoning: 'Common product attribute useful for filtering.',
      confidence: 0.78,
      relevance: {
        globalFrequency: 0.6,
        categoryBreakdown: [],
        classification: 'universal_optional',
        applicableCategories: null,
      },
    },
  ],
});

describe('FieldProposer', () => {
  it('proposes add_field actions from unmapped fields', async () => {
    const client = createMockClient(validLLMResponse);
    const proposer = new FieldProposer(client, config);

    const actions = await proposer.propose(
      baseSchema,
      sampleAggregatedFields,
      'audiophile headphones',
    );

    expect(actions).toHaveLength(2);

    // Verify first action structure
    const first = actions[0];
    expect(first.type).toBe('add_field');
    expect(first.source).toBe('schema_evolution');
    expect(first.confidence).toBe(0.85);
    expect(first.reasoning).toContain('Frequently observed');
    expect(first.id).toBeDefined();
    expect(first.jobId).toBeDefined();

    // Verify payload
    if (first.type !== 'add_field') throw new Error('expected add_field');
    expect(first.payload.field.name).toBe('weight');
    expect(first.payload.field.description).toBe('Product weight');
    expect(first.payload.field.type).toBe('string');
    expect(first.payload.field.required).toBe(false);
    expect(first.payload.relevance.globalFrequency).toBe(0.8);
    expect(first.payload.relevance.classification).toBe('universal_optional');

    // Verify second action has enum values
    const second = actions[1];
    if (second.type !== 'add_field') throw new Error('expected add_field');
    expect(second.payload.field.name).toBe('color');
    expect(second.payload.field.type).toBe('enum');
    expect(second.payload.field.enumValues).toEqual(['Black', 'Silver', 'Blue']);

    // Verify LLM was called with correct parameters
    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test-model',
        jsonMode: true,
        temperature: 0,
      }),
    );
  });

  it('skips fields already in schema', async () => {
    const client = createMockClient(validLLMResponse);
    const proposer = new FieldProposer(client, config);

    // Aggregated fields that match existing schema fields
    const alreadyInSchema: AggregatedField[] = [
      {
        normalizedName: 'product_name',
        observedNames: ['Product Name'],
        occurrences: 10,
        frequency: 1.0,
        dominantType: 'string',
        typeCounts: { string: 10 },
        sampleValues: ['Sony XM5'],
      },
      {
        normalizedName: 'price',
        observedNames: ['Price'],
        occurrences: 9,
        frequency: 0.9,
        dominantType: 'currency',
        typeCounts: { currency: 9 },
        sampleValues: ['$379.99'],
      },
    ];

    const actions = await proposer.propose(baseSchema, alreadyInSchema, 'audiophile headphones');

    expect(actions).toEqual([]);
    // LLM should NOT have been called since all candidates were filtered
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('returns empty array on LLM parse error', async () => {
    const client = createMockClient('this is not valid json at all');
    const proposer = new FieldProposer(client, config);

    const actions = await proposer.propose(
      baseSchema,
      sampleAggregatedFields,
      'audiophile headphones',
    );

    expect(actions).toEqual([]);
  });

  it('returns empty array on LLM call failure', async () => {
    const failClient: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('network failure')),
    };
    const proposer = new FieldProposer(failClient, config);

    const actions = await proposer.propose(
      baseSchema,
      sampleAggregatedFields,
      'audiophile headphones',
    );

    expect(actions).toEqual([]);
  });

  it('uses schemaEvolution model override when configured', async () => {
    const client = createMockClient(validLLMResponse);
    const configWithOverride: LLMConfig = {
      primaryModel: 'primary-model',
      modelOverrides: { schemaEvolution: 'smart-model' },
    };
    const proposer = new FieldProposer(client, configWithOverride);

    await proposer.propose(baseSchema, sampleAggregatedFields, 'test');

    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'smart-model' }));
  });

  it('returns empty array when LLM returns valid JSON with wrong shape', async () => {
    const client = createMockClient(JSON.stringify({ wrong: 'shape' }));
    const proposer = new FieldProposer(client, config);

    const actions = await proposer.propose(baseSchema, sampleAggregatedFields, 'test');

    expect(actions).toEqual([]);
  });

  it('includes current schema fields and candidates in LLM prompt', async () => {
    const client = createMockClient(validLLMResponse);
    const proposer = new FieldProposer(client, config);

    await proposer.propose(baseSchema, sampleAggregatedFields, 'audiophile headphones');

    const messages = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    const userMessage = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';

    // Current schema fields should appear in the prompt
    expect(userMessage).toContain('product_name');
    expect(userMessage).toContain('price');

    // Candidate fields should appear in the prompt
    expect(userMessage).toContain('weight');
    expect(userMessage).toContain('color');

    // Sample values should appear
    expect(userMessage).toContain('250g');

    // Job description should appear
    expect(userMessage).toContain('audiophile headphones');
  });
});
