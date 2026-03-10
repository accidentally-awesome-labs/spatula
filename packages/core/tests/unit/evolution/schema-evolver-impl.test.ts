import { describe, it, expect, vi } from 'vitest';
import { SchemaEvolverImpl } from '../../../src/evolution/schema-evolver-impl.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { ExtractionResult } from '../../../src/types/extraction.js';

const config: LLMConfig = { primaryModel: 'test-model' };

const baseSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'product_name', description: 'Product name', type: 'string', required: true },
    { name: 'price', description: 'Product price', type: 'currency', required: true },
  ],
  fieldAliases: [],
  createdAt: new Date('2026-01-01'),
  parentVersion: null,
};

function makeExtraction(
  unmappedFields: Array<{ name: string; value: unknown; suggestedType: string }>,
  data: Record<string, unknown>,
  index: number,
): ExtractionResult {
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
      unmappedFields,
    },
  };
}

function makeResponse(content: string): LLMCompletionResponse {
  return {
    content,
    model: 'test-model',
    usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    finishReason: 'stop',
  };
}

// --- LLM response payloads ---

const fieldProposerResponse = JSON.stringify({
  proposals: [
    {
      name: 'weight',
      description: 'Product weight',
      type: 'string',
      required: false,
      reasoning: 'Frequently observed product attribute.',
      confidence: 0.85,
      relevance: {
        globalFrequency: 0.8,
        categoryBreakdown: [],
        classification: 'universal_optional',
        applicableCategories: null,
      },
    },
  ],
});

const synonymDetectorEmptyResponse = JSON.stringify({ merges: [] });

const synonymDetectorMergeResponse = JSON.stringify({
  merges: [
    {
      canonicalName: 'price',
      aliasNames: ['cost'],
      canonicalDefinition: {
        name: 'price',
        description: 'Product price',
        type: 'currency',
        required: true,
      },
      reasoning: 'Price and cost represent the same concept.',
      confidence: 0.92,
    },
  ],
});

const normalizationEmptyResponse = JSON.stringify({ rules: [], enumUpdates: [] });

/**
 * Create a mock LLM client that returns different responses on sequential calls.
 * The call counter determines which response to return:
 *   Call 1 = field proposer
 *   Call 2 = synonym detector
 *   Call 3 = normalization proposer
 *
 * Because Promise.all fires all three concurrently, the order they arrive at the
 * mock is deterministic within the test runner (single-threaded) — each
 * sub-analyzer calls complete() once, so we get exactly 3 invocations.
 */
function createSequentialMockClient(responses: string[]): LLMClient {
  let callIndex = 0;
  return {
    complete: vi.fn().mockImplementation(() => {
      const idx = callIndex++;
      const content = responses[idx] ?? JSON.stringify({});
      return Promise.resolve(makeResponse(content));
    }),
  };
}

describe('SchemaEvolverImpl', () => {
  it('returns add_field actions from the full pipeline', async () => {
    const client = createSequentialMockClient([
      fieldProposerResponse,
      synonymDetectorEmptyResponse,
      normalizationEmptyResponse,
    ]);
    const evolver = new SchemaEvolverImpl(client, config);

    const extractions = [
      makeExtraction(
        [{ name: 'Weight', value: '250g', suggestedType: 'string' }],
        { product_name: 'Headphones', price: 99.99 },
        1,
      ),
      makeExtraction(
        [{ name: 'weight', value: '300g', suggestedType: 'string' }],
        { product_name: 'Speaker', price: 149.99 },
        2,
      ),
    ];

    const actions = await evolver.evolve(baseSchema, extractions, 'audiophile headphones');

    // Should have the single add_field from the field proposer
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('add_field');
    expect(actions[0].source).toBe('schema_evolution');
    expect(actions[0].confidence).toBe(0.85);

    if (actions[0].type !== 'add_field') throw new Error('expected add_field');
    expect(actions[0].payload.field.name).toBe('weight');

    // LLM was called 3 times (one per analyzer)
    expect(client.complete).toHaveBeenCalledTimes(3);
  });

  it('returns empty when no unmapped fields exist', async () => {
    // Even though field proposer would produce results, the aggregator
    // returns nothing when extractions have no unmapped fields — so the
    // field proposer and synonym detector see 0 candidates.
    const client = createSequentialMockClient([
      JSON.stringify({ proposals: [] }),
      synonymDetectorEmptyResponse,
      normalizationEmptyResponse,
    ]);
    const evolver = new SchemaEvolverImpl(client, config);

    const extractions = [
      makeExtraction(
        [],
        { product_name: 'Headphones', price: 99.99 },
        1,
      ),
    ];

    const actions = await evolver.evolve(baseSchema, extractions, 'audiophile headphones');

    expect(actions).toHaveLength(0);
  });

  it('combines actions from all sub-analyzers', async () => {
    const client = createSequentialMockClient([
      fieldProposerResponse,
      synonymDetectorMergeResponse,
      normalizationEmptyResponse,
    ]);
    const evolver = new SchemaEvolverImpl(client, config);

    const extractions = [
      makeExtraction(
        [
          { name: 'Weight', value: '250g', suggestedType: 'string' },
          { name: 'cost', value: '$99.99', suggestedType: 'currency' },
        ],
        { product_name: 'Headphones', price: 99.99 },
        1,
      ),
      makeExtraction(
        [
          { name: 'weight', value: '300g', suggestedType: 'string' },
          { name: 'Cost', value: '$149.99', suggestedType: 'currency' },
        ],
        { product_name: 'Speaker', price: 149.99 },
        2,
      ),
    ];

    const actions = await evolver.evolve(baseSchema, extractions, 'audiophile headphones');

    // 1 add_field from field proposer + 1 merge_fields from synonym detector = 2
    expect(actions).toHaveLength(2);

    const types = actions.map((a) => a.type);
    expect(types).toContain('add_field');
    expect(types).toContain('merge_fields');

    // Verify ordering: field proposals come first, then synonym merges
    expect(actions[0].type).toBe('add_field');
    expect(actions[1].type).toBe('merge_fields');

    // All actions have schema_evolution source
    for (const action of actions) {
      expect(action.source).toBe('schema_evolution');
    }

    // LLM called exactly 3 times
    expect(client.complete).toHaveBeenCalledTimes(3);
  });
});
