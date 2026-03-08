import { describe, it, expect } from 'vitest';

describe('package exports', () => {
  it('exports LLM modules', async () => {
    const llm = await import('../../src/llm/index.js');
    expect(llm.OpenRouterClient).toBeDefined();
    expect(llm.resolveModel).toBeDefined();
  });

  it('exports extraction modules', async () => {
    const extraction = await import('../../src/extraction/index.js');
    expect(extraction.preprocessHTML).toBeDefined();
    expect(extraction.schemaToPrompt).toBeDefined();
    expect(extraction.schemaToJsonSchema).toBeDefined();
    expect(extraction.PageClassifier).toBeDefined();
    expect(extraction.StaticExtractor).toBeDefined();
  });

  it('exports everything from root index', async () => {
    const root = await import('../../src/index.js');
    // LLM
    expect(root.OpenRouterClient).toBeDefined();
    expect(root.resolveModel).toBeDefined();
    // Extraction
    expect(root.preprocessHTML).toBeDefined();
    expect(root.PageClassifier).toBeDefined();
    expect(root.StaticExtractor).toBeDefined();
  });
});
