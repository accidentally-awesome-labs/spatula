// apps/cli/src/commands/test-url.ts
import {
  createLLMClient,
  preprocessHTML,
  PageClassifier,
  StaticExtractor,
  PlaywrightCrawler,
  FirecrawlCrawler,
} from '@spatula/core';
import type { LLMClient, LLMFactoryConfig, Crawler, SchemaDefinition } from '@spatula/core';

export interface TestUrlArgs {
  url: string;
  crawler?: 'playwright' | 'firecrawl';
  format?: 'json' | 'table' | 'raw';
  schema?: string; // Path to schema JSON file
  showHtml?: boolean;
  showLinks?: boolean;
  model?: string;
  skipLlm?: boolean;
}

export async function testUrl(args: TestUrlArgs): Promise<void> {
  const {
    url,
    crawler: crawlerType = 'playwright',
    format = 'table',
    showLinks = false,
    model,
    skipLlm = false,
  } = args;
  let showHtml = args.showHtml ?? false;

  // Handle --format raw as equivalent to --show-html
  if (format === 'raw') {
    showHtml = true;
  }

  // 0b. Load schema file if provided
  let userSchema: SchemaDefinition | undefined;
  if (args.schema) {
    try {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(args.schema, 'utf-8');
      const parsed = JSON.parse(content);
      userSchema = parsed as SchemaDefinition;
    } catch (err) {
      console.error(`Failed to load schema from ${args.schema}: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // 1. Create LLM client (unless --skip-llm)
  let llmClient: LLMClient | null = null;
  const primaryModel =
    model ?? process.env.LLM_PRIMARY_MODEL ?? 'anthropic/claude-sonnet-4-20250514';

  if (!skipLlm) {
    const provider = process.env.LLM_PROVIDER ?? 'openrouter';
    try {
      const factoryConfig: LLMFactoryConfig = {
        provider: provider as 'openrouter' | 'ollama',
        openrouter:
          provider === 'openrouter' ? { apiKey: process.env.OPENROUTER_API_KEY ?? '' } : undefined,
        ollama: provider === 'ollama' ? { baseUrl: process.env.OLLAMA_BASE_URL } : undefined,
      };
      llmClient = createLLMClient(factoryConfig);
    } catch (err) {
      console.error(`Failed to create LLM client: ${(err as Error).message}`);
      console.error(
        'Run with --skip-llm for CSS-selector-only extraction, or set LLM_PROVIDER=ollama',
      );
      process.exit(1);
    }
  }

  // 2. Create crawler
  let crawler: Crawler;
  try {
    if (crawlerType === 'firecrawl') {
      const apiKey = process.env.FIRECRAWL_API_KEY;
      if (!apiKey) {
        console.error('FIRECRAWL_API_KEY is required for firecrawl crawler');
        process.exit(1);
      }
      crawler = new FirecrawlCrawler({ apiKey });
    } else {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      crawler = new PlaywrightCrawler(browser);
    }
  } catch (err) {
    console.error(`Failed to create crawler: ${(err as Error).message}`);
    process.exit(1);
  }

  try {
    // 3. Crawl the URL
    console.log(`\n  Crawling: ${url}`);
    const startTime = Date.now();
    const result = await crawler.crawl(url);
    const crawlTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `  Crawled in ${crawlTime}s (${(result.metadata.contentLength / 1024).toFixed(0)}KB, ${result.contentType ?? 'text/html'})`,
    );

    // 4. Show raw HTML if requested
    if (showHtml) {
      const preprocessed = preprocessHTML(result.html);
      console.log('\n--- Preprocessed HTML ---');
      console.log(preprocessed.content);
      console.log('--- End HTML ---\n');
      return;
    }

    // 5. Classify page (if LLM available)
    let classification: string | undefined;
    if (llmClient) {
      const classifier = new PageClassifier(llmClient, { primaryModel });
      const classResult = await classifier.classify(
        result.html,
        url,
        'Extract data from this page',
      );
      classification = classResult.classification;
      console.log(
        `  Classification: ${classification} (${(classResult.confidence * 100).toFixed(0)}%)`,
      );
    }

    // 6. Show evaluated links if requested
    if (showLinks) {
      console.log(`\n  Links found: ${result.links.length}`);
      for (const link of result.links.slice(0, 20)) {
        console.log(`    ${link.url}`);
        if (link.text) console.log(`      text: ${link.text}`);
      }
      if (result.links.length > 20) {
        console.log(`    ... and ${result.links.length - 20} more`);
      }
      return;
    }

    // 7. Extract data (if LLM available)
    if (llmClient) {
      // Use user-provided schema or build a minimal one for discovery mode
      const schema: SchemaDefinition = userSchema ?? {
        version: 1,
        fields: [],
        fieldAliases: [],
        createdAt: new Date(),
        parentVersion: null,
      };

      const extractor = new StaticExtractor(llmClient, { primaryModel }, 'test');
      const extraction = await extractor.extract(
        result.html,
        url,
        schema,
        'Extract all relevant data from this page',
      );

      // 8. Output results
      if (format === 'json') {
        console.log(
          JSON.stringify(
            {
              url,
              crawl: {
                statusCode: result.statusCode,
                responseTimeMs: result.metadata.responseTimeMs,
                contentLength: result.metadata.contentLength,
              },
              classification,
              extraction: {
                fields: extraction.data,
                unmapped: extraction.metadata.unmappedFields,
              },
              model: { provider: process.env.LLM_PROVIDER ?? 'openrouter', model: primaryModel },
            },
            null,
            2,
          ),
        );
      } else {
        // Table format
        console.log('\n  Extracted Fields');
        console.log('  ' + '-'.repeat(60));
        const data = extraction.data as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          const valueStr =
            typeof value === 'string'
              ? value.length > 50
                ? value.slice(0, 47) + '...'
                : value
              : JSON.stringify(value);
          console.log(`  ${key.padEnd(20)} ${valueStr}`);
        }

        if (extraction.metadata.unmappedFields?.length > 0) {
          console.log('\n  Unmapped Content (potential fields)');
          for (const field of extraction.metadata.unmappedFields.slice(0, 5)) {
            console.log(`    "${field.value}" -> ${field.name} (${field.suggestedType})`);
          }
        }
      }
    } else {
      // No LLM — use CSS-only extractor
      const { CssExtractor } = await import('@spatula/core');
      const cssExtractor = new CssExtractor();

      const schema: SchemaDefinition = userSchema ?? {
        version: 1,
        fields: [],
        fieldAliases: [],
        createdAt: new Date(),
        parentVersion: null,
      };

      console.log('\n  Running CSS-only extraction (no LLM configured)');
      if (!userSchema) {
        console.log('  Hint: configure an LLM provider for better extraction results.');
        console.log('  Set LLM_PROVIDER=ollama or OPENROUTER_API_KEY=...\n');
      }

      const extraction = await cssExtractor.extract(result.html, url, schema, 'Extract data');

      if (format === 'json') {
        console.log(
          JSON.stringify(
            {
              url,
              crawl: {
                statusCode: result.statusCode,
                responseTimeMs: result.metadata.responseTimeMs,
                contentLength: result.metadata.contentLength,
              },
              extractor: 'css-only',
              extraction: {
                fields: extraction.data,
                unmapped: extraction.metadata.unmappedFields,
              },
            },
            null,
            2,
          ),
        );
      } else {
        console.log('\n  Extracted Fields (CSS-only)');
        console.log('  ' + '-'.repeat(60));
        const data = extraction.data as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          const valueStr =
            typeof value === 'string'
              ? value.length > 50
                ? value.slice(0, 47) + '...'
                : value
              : JSON.stringify(value);
          console.log(`  ${key.padEnd(20)} ${valueStr}`);
        }
        if (Object.keys(data).length === 0) {
          console.log('  (no data extracted — try providing a --schema file)');
        }
      }
    }
  } finally {
    await crawler.close();
  }
}
