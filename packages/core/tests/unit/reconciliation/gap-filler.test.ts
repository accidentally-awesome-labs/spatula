import { describe, it, expect, vi } from 'vitest';
import { GapFiller } from '../../../src/reconciliation/gap-filler.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';
import type { PipelineAction } from '../../../src/types/actions.js';

// ---------------------------------------------------------------------------
// Mock helper
// ---------------------------------------------------------------------------

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
      finishReason: 'stop',
    }),
  };
}

const defaultLLMConfig = {
  primaryModel: 'anthropic/claude-sonnet-4-20250514',
};

// ---------------------------------------------------------------------------
// Test schema helpers
// ---------------------------------------------------------------------------

function makeSchema(
  fields: Array<{ name: string; description: string; type: string; required: boolean }>,
): SchemaDefinition {
  return {
    version: 1,
    fields: fields.map((f) => ({
      name: f.name,
      description: f.description,
      type: f.type as
        | 'string'
        | 'number'
        | 'boolean'
        | 'url'
        | 'currency'
        | 'enum'
        | 'array'
        | 'object',
      required: f.required,
    })),
    fieldAliases: [],
    createdAt: new Date('2026-03-01'),
    parentVersion: null,
  };
}

// ---------------------------------------------------------------------------
// fillGaps — proposes inferred values for missing required fields
// ---------------------------------------------------------------------------

describe('GapFiller.fillGaps', () => {
  it('proposes inferred values for missing required fields', async () => {
    const llmResponse = JSON.stringify({
      inferences: [
        {
          fieldName: 'brand',
          inferredValue: 'Sony',
          inferredFrom: 'Product name contains "Sony WH-1000XM5"',
          confidence: 0.95,
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'number', required: true },
    ]);

    const mergedData = {
      name: 'Sony WH-1000XM5',
      price: 349.99,
      // brand is missing
    };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone product data',
    );

    expect(actions).toHaveLength(1);
    const action = actions[0] as PipelineAction & { type: 'infer_value' };
    expect(action.type).toBe('infer_value');
    expect(action.source).toBe('reconciliation');
    expect(action.payload.entityId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(action.payload.fieldName).toBe('brand');
    expect(action.payload.inferredValue).toBe('Sony');
    expect(action.payload.inferredFrom).toBe('Product name contains "Sony WH-1000XM5"');
    expect(action.confidence).toBe(0.95);
    expect(action.reasoning).toBe('Product name contains "Sony WH-1000XM5"');
    expect(action.id).toBeDefined();
  });

  it('does NOT call LLM when all required fields are present', async () => {
    const client = createMockClient('{}');
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
    ]);

    const mergedData = {
      name: 'Sony WH-1000XM5',
      brand: 'Sony',
    };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone data',
    );

    expect(actions).toEqual([]);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('does NOT call LLM when only optional fields are missing', async () => {
    const client = createMockClient('{}');
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
      { name: 'color', description: 'Color', type: 'string', required: false },
      { name: 'weight', description: 'Weight', type: 'number', required: false },
    ]);

    const mergedData = {
      name: 'Sony WH-1000XM5',
      brand: 'Sony',
      // color and weight are optional and missing — should not trigger LLM
    };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone data',
    );

    expect(actions).toEqual([]);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('returns empty array on LLM error', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM service unavailable')),
    };
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
    ]);

    const mergedData = { name: 'Sony WH-1000XM5' };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone data',
    );

    expect(actions).toEqual([]);
  });

  it('returns empty array on invalid JSON response', async () => {
    const client = createMockClient('this is not valid JSON at all');
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
    ]);

    const mergedData = { name: 'Sony WH-1000XM5' };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone data',
    );

    expect(actions).toEqual([]);
  });

  it('returns empty array on wrong Zod shape', async () => {
    const client = createMockClient(JSON.stringify({ wrongField: 'not the right schema' }));
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
    ]);

    const mergedData = { name: 'Sony WH-1000XM5' };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone data',
    );

    expect(actions).toEqual([]);
  });

  it('filters out inferences for non-missing fields (LLM hallucination)', async () => {
    const llmResponse = JSON.stringify({
      inferences: [
        {
          fieldName: 'brand',
          inferredValue: 'Sony',
          inferredFrom: 'Derived from product name',
          confidence: 0.95,
        },
        {
          fieldName: 'name',
          inferredValue: 'Sony WH-1000XM5 Headphones',
          inferredFrom: 'Hallucinated replacement for existing field',
          confidence: 0.8,
        },
        {
          fieldName: 'color',
          inferredValue: 'Black',
          inferredFrom: 'Hallucinated field not in missing list',
          confidence: 0.7,
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
      { name: 'color', description: 'Color', type: 'string', required: false },
    ]);

    const mergedData = {
      name: 'Sony WH-1000XM5',
      // brand is missing (required)
      // color is missing but optional
    };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone data',
    );

    // Only 'brand' should survive — 'name' already present, 'color' not in missing required list
    expect(actions).toHaveLength(1);
    expect((actions[0] as PipelineAction & { type: 'infer_value' }).payload.fieldName).toBe(
      'brand',
    );
  });

  it('includes entity data and missing fields in LLM prompt', async () => {
    const llmResponse = JSON.stringify({
      inferences: [
        {
          fieldName: 'brand',
          inferredValue: 'Sony',
          inferredFrom: 'Derived from product name',
          confidence: 0.9,
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
      { name: 'category', description: 'Product category', type: 'string', required: true },
    ]);

    const mergedData = {
      name: 'Sony WH-1000XM5',
      // brand and category missing
    };

    await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone product data',
    );

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMessage = call.messages.find((m: { role: string }) => m.role === 'user');
    const systemMessage = call.messages.find((m: { role: string }) => m.role === 'system');

    // System prompt should mention data quality
    expect(systemMessage.content).toContain('data quality');

    // User prompt should contain existing entity data
    expect(userMessage.content).toContain('Sony WH-1000XM5');

    // User prompt should mention missing fields
    expect(userMessage.content).toContain('brand');
    expect(userMessage.content).toContain('category');

    // User prompt should include field descriptions
    expect(userMessage.content).toContain('Brand name');
    expect(userMessage.content).toContain('Product category');

    // User prompt should include job description
    expect(userMessage.content).toContain('Collect headphone product data');

    // Should use correct LLM settings
    expect(call.jsonMode).toBe(true);
    expect(call.temperature).toBe(0);
    expect(call.maxTokens).toBe(2048);
  });

  it('treats null values as missing', async () => {
    const llmResponse = JSON.stringify({
      inferences: [
        {
          fieldName: 'brand',
          inferredValue: 'Apple',
          inferredFrom: 'Product name contains "AirPods"',
          confidence: 0.98,
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
    ]);

    const mergedData = {
      name: 'AirPods Pro',
      brand: null, // explicitly null — should be treated as missing
    };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect audio product data',
    );

    expect(actions).toHaveLength(1);
    const action = actions[0] as PipelineAction & { type: 'infer_value' };
    expect(action.payload.fieldName).toBe('brand');
    expect(action.payload.inferredValue).toBe('Apple');
  });

  it('handles multiple missing required fields', async () => {
    const llmResponse = JSON.stringify({
      inferences: [
        {
          fieldName: 'brand',
          inferredValue: 'Sony',
          inferredFrom: 'Derived from product name',
          confidence: 0.95,
        },
        {
          fieldName: 'category',
          inferredValue: 'Headphones',
          inferredFrom: 'Product name suggests headphones category',
          confidence: 0.85,
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
      { name: 'category', description: 'Product category', type: 'string', required: true },
    ]);

    const mergedData = {
      name: 'Sony WH-1000XM5',
      // brand and category missing
    };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone data',
    );

    expect(actions).toHaveLength(2);

    const fieldNames = actions.map(
      (a) => (a as PipelineAction & { type: 'infer_value' }).payload.fieldName,
    );
    expect(fieldNames).toContain('brand');
    expect(fieldNames).toContain('category');
  });

  it('filters out inferences with null inferredValue', async () => {
    const llmResponse = JSON.stringify({
      inferences: [
        {
          fieldName: 'brand',
          inferredValue: null,
          inferredFrom: 'Could not determine brand',
          confidence: 0.9,
        },
        {
          fieldName: 'category',
          inferredValue: 'Headphones',
          inferredFrom: 'Product name suggests headphones category',
          confidence: 0.85,
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
      { name: 'category', description: 'Product category', type: 'string', required: true },
    ]);

    const mergedData = {
      name: 'Sony WH-1000XM5',
      // brand and category missing
    };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone data',
    );

    // brand inference has null value — should be filtered out
    expect(actions).toHaveLength(1);
    expect((actions[0] as PipelineAction & { type: 'infer_value' }).payload.fieldName).toBe(
      'category',
    );
  });

  it('filters out inferences with confidence below 0.5', async () => {
    const llmResponse = JSON.stringify({
      inferences: [
        {
          fieldName: 'brand',
          inferredValue: 'Sony',
          inferredFrom: 'Wild guess based on price range',
          confidence: 0.2,
        },
        {
          fieldName: 'category',
          inferredValue: 'Headphones',
          inferredFrom: 'Product name suggests headphones category',
          confidence: 0.85,
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const filler = new GapFiller(client, defaultLLMConfig);

    const schema = makeSchema([
      { name: 'name', description: 'Product name', type: 'string', required: true },
      { name: 'brand', description: 'Brand name', type: 'string', required: true },
      { name: 'category', description: 'Product category', type: 'string', required: true },
    ]);

    const mergedData = {
      name: 'WH-1000XM5',
      // brand and category missing
    };

    const actions = await filler.fillGaps(
      '550e8400-e29b-41d4-a716-446655440000',
      mergedData,
      schema,
      'Collect headphone data',
    );

    // brand inference has confidence 0.2 — below 0.5 threshold, should be filtered out
    expect(actions).toHaveLength(1);
    expect((actions[0] as PipelineAction & { type: 'infer_value' }).payload.fieldName).toBe(
      'category',
    );
  });
});
