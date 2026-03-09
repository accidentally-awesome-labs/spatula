import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PageClassifier } from '../../../src/extraction/page-classifier.js';
import { StaticExtractor } from '../../../src/extraction/static-extractor.js';
import { preprocessHTML } from '../../../src/extraction/html-preprocessor.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const fixturesDir = resolve(import.meta.dirname, '../../fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), 'utf-8');
}

function createMockClient(responses: Record<string, string>): LLMClient {
  let callCount = 0;
  const keys = Object.keys(responses);

  return {
    complete: vi.fn().mockImplementation(async () => {
      const key = keys[callCount % keys.length];
      callCount++;
      return {
        content: responses[key],
        model: 'test-model',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
      } satisfies LLMCompletionResponse;
    }),
  };
}

const config: LLMConfig = { primaryModel: 'test-model' };

const audioSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'product_name', description: 'Product name', type: 'string', required: true },
    { name: 'price', description: 'Product price', type: 'currency', required: false },
    { name: 'description', description: 'Product description', type: 'string', required: false },
    {
      name: 'type',
      description: 'Product type',
      type: 'enum',
      required: false,
      enumValues: ['headphones', 'amplifier', 'dac', 'speaker'],
    },
  ],
  fieldAliases: [],
  createdAt: new Date('2026-01-01'),
  parentVersion: null,
};

describe('Extraction Pipeline Integration', () => {
  describe('HTML preprocessor with fixtures', () => {
    it('preprocesses single product page', () => {
      const html = loadFixture('single-product.html');
      const result = preprocessHTML(html);

      expect(result.title).toBeDefined();
      expect(result.content).toContain('$');
      expect(result.content.length).toBeGreaterThan(100);
      expect(result.truncated).toBe(false);
      expect(result.content).not.toContain('<script');
    });

    it('preprocesses product listing page', () => {
      const html = loadFixture('product-listing.html');
      const result = preprocessHTML(html);

      expect(result.title).toBeDefined();
      expect(result.content.length).toBeGreaterThan(100);
      expect(result.truncated).toBe(false);
    });

    it('preprocesses navigation page', () => {
      const html = loadFixture('navigation-page.html');
      const result = preprocessHTML(html);

      expect(result.content).toContain('Headphones');
      expect(result.content).toContain('Amplifiers');
      expect(result.content).toContain('DACs');
    });

    it('preprocesses irrelevant page', () => {
      const html = loadFixture('irrelevant-page.html');
      const result = preprocessHTML(html);

      expect(result.content).toContain('Privacy Policy');
      expect(result.content).toContain('Cookie');
    });
  });

  describe('Page classifier with mock LLM', () => {
    it('classifies single product fixture as single_entry', async () => {
      const client = createMockClient({
        classify: JSON.stringify({
          classification: 'single_entry',
          strategy: 'full_extraction',
          estimatedEntryCount: 1,
          confidence: 0.95,
          reasoning: 'Product detail page with specs and pricing.',
        }),
      });

      const classifier = new PageClassifier(client, config);
      const html = loadFixture('single-product.html');
      const result = await classifier.classify(
        html,
        'https://audiostore.com/products/hd650',
        'audiophile headphones',
      );

      expect(result.classification).toBe('single_entry');
      expect(result.strategy).toBe('full_extraction');
      expect(client.complete).toHaveBeenCalledTimes(1);
    });

    it('classifies product listing fixture as multiple_entries', async () => {
      const client = createMockClient({
        classify: JSON.stringify({
          classification: 'multiple_entries',
          strategy: 'list_extraction',
          estimatedEntryCount: 3,
          confidence: 0.9,
          reasoning: 'Product listing with multiple items.',
        }),
      });

      const classifier = new PageClassifier(client, config);
      const html = loadFixture('product-listing.html');
      const result = await classifier.classify(
        html,
        'https://audiostore.com/headphones',
        'audiophile headphones',
      );

      expect(result.classification).toBe('multiple_entries');
      expect(result.strategy).toBe('list_extraction');
    });
  });

  describe('Static extractor with mock LLM', () => {
    it('extracts data from single product fixture', async () => {
      const client = createMockClient({
        extract: JSON.stringify({
          data: {
            product_name: 'Sennheiser HD 650',
            price: { amount: 349.95, currency: 'USD' },
            description: 'Open-back audiophile headphones',
            type: 'headphones',
          },
          _unmapped: [
            { name: 'impedance', value: '300 ohms', suggestedType: 'string' },
            { name: 'driver_type', value: 'dynamic', suggestedType: 'string' },
          ],
          confidence: 0.93,
        }),
      });

      const extractor = new StaticExtractor(client, config, 'test-job-id');
      const html = loadFixture('single-product.html');
      const result = await extractor.extract(
        html,
        'https://audiostore.com/products/hd650',
        audioSchema,
        'audiophile headphones',
      );

      expect(result.data.product_name).toBe('Sennheiser HD 650');
      expect(result.data.price).toEqual({ amount: 349.95, currency: 'USD' });
      expect(result.metadata.unmappedFields).toHaveLength(2);
      expect(result.metadata.confidence).toBe(0.93);
      expect(result.jobId).toBe('test-job-id');
      expect(result.schemaVersion).toBe(1);
    });

    it('handles full classify-then-extract pipeline', async () => {
      const classifyClient = createMockClient({
        response: JSON.stringify({
          classification: 'single_entry',
          strategy: 'full_extraction',
          estimatedEntryCount: 1,
          confidence: 0.95,
          reasoning: 'Product page',
        }),
      });

      const extractClient = createMockClient({
        response: JSON.stringify({
          data: { product_name: 'Test Product' },
          _unmapped: [],
          confidence: 0.88,
        }),
      });

      const html = loadFixture('single-product.html');

      // Step 1: Classify
      const classifier = new PageClassifier(classifyClient, config);
      const classification = await classifier.classify(
        html,
        'https://audiostore.com/products/hd650',
        'audiophile headphones',
      );
      expect(classification.strategy).toBe('full_extraction');

      // Step 2: Extract (only if strategy is full_extraction or list_extraction)
      if (
        classification.strategy === 'full_extraction' ||
        classification.strategy === 'list_extraction'
      ) {
        const extractor = new StaticExtractor(extractClient, config, 'job-1');
        const result = await extractor.extract(
          html,
          'https://audiostore.com/products/hd650',
          audioSchema,
          'audiophile headphones',
        );
        expect(result.data.product_name).toBe('Test Product');
        expect(result.metadata.confidence).toBe(0.88);
      }
    });
  });
});
