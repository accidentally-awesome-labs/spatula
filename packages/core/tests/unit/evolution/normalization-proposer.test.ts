import { describe, it, expect, vi } from 'vitest';
import {
  NormalizationProposer,
  collectValueSamples,
} from '../../../src/evolution/normalization-proposer.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { ExtractionResult } from '../../../src/types/extraction.js';

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
      finishReason: 'stop',
    } satisfies LLMCompletionResponse),
  };
}

const config: LLMConfig = { primaryModel: 'test-model' };

const baseSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'product_name', description: 'Product name', type: 'string', required: true },
    { name: 'price', description: 'Product price', type: 'currency', required: true },
    { name: 'color', description: 'Color option', type: 'enum', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date('2026-01-01'),
  parentVersion: null,
};

function makeExtraction(data: Record<string, unknown>, index: number): ExtractionResult {
  return {
    id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    jobId: '00000000-0000-0000-0000-000000000001',
    pageId: `00000000-0000-0000-0000-${String(index + 100).padStart(12, '0')}`,
    schemaVersion: 1,
    data,
    metadata: {
      confidence: 0.9,
      modelUsed: 'test-model',
      tokensUsed: 500,
      extractionTimeMs: 120,
      unmappedFields: [],
    },
  };
}

const sampleExtractions: ExtractionResult[] = [
  makeExtraction({ product_name: 'Sony XM5', price: '$379.99', color: 'Black' }, 1),
  makeExtraction({ product_name: 'Bose QC45', price: '329.00 USD', color: 'black' }, 2),
  makeExtraction({ product_name: 'AirPods Max', price: '549', color: 'Silver' }, 3),
  makeExtraction({ product_name: 'Sennheiser HD 660S', price: '$499.95', color: 'MIDNIGHT' }, 4),
];

const validLLMResponse = JSON.stringify({
  rules: [
    {
      fieldName: 'price',
      rule: {
        type: 'currency',
        config: { targetCurrency: 'USD', decimalPlaces: 2 },
      },
      examples: [
        { before: '$379.99', after: 379.99 },
        { before: '329.00 USD', after: 329.0 },
      ],
      reasoning: 'Price values are in inconsistent formats — standardize to numeric USD.',
      confidence: 0.95,
    },
    {
      fieldName: 'color',
      rule: {
        type: 'enum',
        config: {
          canonicalValues: ['Black', 'Silver', 'Midnight'],
          synonymMap: { black: 'Black', MIDNIGHT: 'Midnight' },
        },
      },
      examples: [
        { before: 'black', after: 'Black' },
        { before: 'MIDNIGHT', after: 'Midnight' },
      ],
      reasoning: 'Color values have inconsistent casing — map to canonical forms.',
      confidence: 0.88,
    },
  ],
  enumUpdates: [
    {
      fieldName: 'color',
      additions: { silver: 'Silver', white: 'White' },
      newCanonicalValues: ['White'],
      reasoning: 'New color variants observed that need synonym mappings.',
      confidence: 0.82,
    },
  ],
});

describe('NormalizationProposer', () => {
  it('proposes normalization rules and enum updates', async () => {
    const client = createMockClient(validLLMResponse);
    const proposer = new NormalizationProposer(client, config);

    const actions = await proposer.propose(baseSchema, sampleExtractions, 'audiophile headphones');

    // Should have 2 set_normalization_rule + 1 update_enum_map = 3 actions
    expect(actions).toHaveLength(3);

    // First action: set_normalization_rule for price
    const priceRule = actions[0];
    expect(priceRule.type).toBe('set_normalization_rule');
    expect(priceRule.source).toBe('schema_evolution');
    expect(priceRule.confidence).toBe(0.95);
    expect(priceRule.reasoning).toContain('Price values');
    expect(priceRule.id).toBeDefined();
    expect(priceRule.jobId).toBeDefined();

    if (priceRule.type !== 'set_normalization_rule')
      throw new Error('expected set_normalization_rule');
    expect(priceRule.payload.fieldName).toBe('price');
    expect(priceRule.payload.rule.type).toBe('currency');
    expect(priceRule.payload.examples).toHaveLength(2);
    expect(priceRule.payload.examples[0].before).toBe('$379.99');
    expect(priceRule.payload.examples[0].after).toBe(379.99);

    // Second action: set_normalization_rule for color
    const colorRule = actions[1];
    expect(colorRule.type).toBe('set_normalization_rule');
    if (colorRule.type !== 'set_normalization_rule')
      throw new Error('expected set_normalization_rule');
    expect(colorRule.payload.fieldName).toBe('color');
    expect(colorRule.payload.rule.type).toBe('enum');
    expect(colorRule.confidence).toBe(0.88);

    // Third action: update_enum_map for color
    const enumUpdate = actions[2];
    expect(enumUpdate.type).toBe('update_enum_map');
    if (enumUpdate.type !== 'update_enum_map') throw new Error('expected update_enum_map');
    expect(enumUpdate.payload.fieldName).toBe('color');
    expect(enumUpdate.payload.additions).toEqual({ silver: 'Silver', white: 'White' });
    expect(enumUpdate.payload.newCanonicalValues).toEqual(['White']);
    expect(enumUpdate.confidence).toBe(0.82);

    // Verify LLM was called with correct parameters
    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'test-model',
        jsonMode: true,
        temperature: 0,
      }),
    );
  });

  it('returns empty array on LLM error', async () => {
    const failClient: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('network failure')),
    };
    const proposer = new NormalizationProposer(failClient, config);

    const actions = await proposer.propose(baseSchema, sampleExtractions, 'audiophile headphones');

    expect(actions).toEqual([]);
  });

  it('skips fields that already have normalization rules', async () => {
    const client = createMockClient(validLLMResponse);
    const proposer = new NormalizationProposer(client, config);

    // All fields already have normalization
    const fullyNormalizedSchema: SchemaDefinition = {
      version: 1,
      fields: [
        {
          name: 'product_name',
          description: 'Product name',
          type: 'string',
          required: true,
          normalization: {
            type: 'text',
            config: { casing: 'title', trim: true, collapseWhitespace: true },
          },
        },
        {
          name: 'price',
          description: 'Product price',
          type: 'currency',
          required: true,
          normalization: { type: 'currency', config: { targetCurrency: 'USD', decimalPlaces: 2 } },
        },
        {
          name: 'color',
          description: 'Color option',
          type: 'enum',
          required: false,
          normalization: {
            type: 'enum',
            config: { canonicalValues: ['Black'], synonymMap: { black: 'Black' } },
          },
        },
      ],
      fieldAliases: [],
      createdAt: new Date('2026-01-01'),
      parentVersion: null,
    };

    const actions = await proposer.propose(
      fullyNormalizedSchema,
      sampleExtractions,
      'audiophile headphones',
    );

    expect(actions).toEqual([]);
    // LLM should NOT have been called since all fields already have normalization
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('returns empty array when no sample values found', async () => {
    const client = createMockClient(validLLMResponse);
    const proposer = new NormalizationProposer(client, config);

    // Extractions with no matching field data
    const emptyExtractions: ExtractionResult[] = [makeExtraction({}, 1), makeExtraction({}, 2)];

    const actions = await proposer.propose(baseSchema, emptyExtractions, 'audiophile headphones');

    expect(actions).toEqual([]);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('returns empty array on invalid JSON response', async () => {
    const client = createMockClient('this is not valid json');
    const proposer = new NormalizationProposer(client, config);

    const actions = await proposer.propose(baseSchema, sampleExtractions, 'test');

    expect(actions).toEqual([]);
  });

  it('returns empty array when LLM returns valid JSON with wrong shape', async () => {
    const client = createMockClient(JSON.stringify({ wrong: 'shape' }));
    const proposer = new NormalizationProposer(client, config);

    const actions = await proposer.propose(baseSchema, sampleExtractions, 'test');

    expect(actions).toEqual([]);
  });

  it('includes field info and sample values in LLM prompt', async () => {
    const client = createMockClient(validLLMResponse);
    const proposer = new NormalizationProposer(client, config);

    await proposer.propose(baseSchema, sampleExtractions, 'audiophile headphones');

    const messages = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    const userMessage = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';

    // Field names should appear in the prompt
    expect(userMessage).toContain('product_name');
    expect(userMessage).toContain('price');
    expect(userMessage).toContain('color');

    // Sample values should appear
    expect(userMessage).toContain('Sony XM5');
    expect(userMessage).toContain('$379.99');
    expect(userMessage).toContain('Black');

    // Job description should appear
    expect(userMessage).toContain('audiophile headphones');
  });
});

describe('collectValueSamples', () => {
  it('collects up to 10 values per field', () => {
    const extractions = Array.from({ length: 15 }, (_, i) =>
      makeExtraction({ name: `item-${i}`, score: i * 10 }, i),
    );

    const samples = collectValueSamples(['name', 'score'], extractions);

    expect(samples.name).toHaveLength(10);
    expect(samples.score).toHaveLength(10);
    // Values should be from the first 10 extractions
    expect(samples.name[0]).toBe('item-0');
    expect(samples.name[9]).toBe('item-9');
  });

  it('skips null and undefined values', () => {
    const extractions = [
      makeExtraction({ name: 'Alice', score: null }, 1),
      makeExtraction({ name: undefined, score: 100 }, 2),
      makeExtraction({ name: 'Bob', score: 200 }, 3),
    ];

    const samples = collectValueSamples(['name', 'score'], extractions);

    expect(samples.name).toEqual(['Alice', 'Bob']);
    expect(samples.score).toEqual([100, 200]);
  });

  it('returns empty arrays for fields with no values', () => {
    const extractions = [makeExtraction({}, 1)];

    const samples = collectValueSamples(['missing_field'], extractions);

    expect(samples.missing_field).toEqual([]);
  });
});
