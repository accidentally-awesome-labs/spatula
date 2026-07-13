import { describe, it, expect } from 'vitest';

// Dynamic `import()` of the root barrel pulls in crawlers, exporters, DuckDB,
// Playwright, Firecrawl, and other heavy transitive modules. Cold full-suite
// runs can exceed Vitest's 5s default, matching db/queue export smoke tests.
describe('package exports', { timeout: 30_000 }, () => {
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
    // Core types still exported
    expect(root.ExtractionResult).toBeDefined();
    expect(root.PageClassification).toBeDefined();
    // Crawlers still exported
    expect(root.PlaywrightCrawler).toBeDefined();
    expect(root.FirecrawlCrawler).toBeDefined();
  });
});
