import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mock for @spatula/core — prevents real browser/LLM instantiation
// ---------------------------------------------------------------------------

vi.mock('@spatula/core', () => {
  const mockLLMClient = {
    complete: vi.fn(),
    completeWithSchema: vi.fn(),
  };

  return {
    createLLMClient: vi.fn().mockReturnValue(mockLLMClient),
    PlaywrightCrawler: vi.fn().mockImplementation(() => ({
      crawl: vi.fn(),
      close: vi.fn(),
    })),
    FirecrawlCrawler: vi.fn().mockImplementation(() => ({
      crawl: vi.fn(),
      close: vi.fn(),
    })),
    PageClassifier: vi.fn().mockImplementation(() => ({
      classify: vi.fn(),
    })),
    StaticExtractor: vi.fn().mockImplementation(() => ({
      extract: vi.fn(),
    })),
    preprocessHTML: vi.fn().mockReturnValue({ content: '<html/>' }),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('testUrl error paths', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Prevent process.exit from terminating the test process
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${_code})`);
    });

    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Use ollama so no OPENROUTER_API_KEY is required
    process.env.LLM_PROVIDER = 'ollama';

    // Ensure no Firecrawl key is set (clean slate)
    delete process.env.FIRECRAWL_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LLM_PROVIDER;
    delete process.env.FIRECRAWL_API_KEY;
  });

  it('exits with code 1 when --skip-llm is used without --schema', async () => {
    const { testUrl } = await import('../../../src/commands/test-url.js');

    await expect(
      testUrl({ url: 'https://example.com', skipLlm: true }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);

    // Verify the error message mentions the requirement
    const errorMessages = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
    expect(errorMessages).toContain('--skip-llm requires --schema');
  });

  it('exits with code 1 when firecrawl crawler is used without FIRECRAWL_API_KEY', async () => {
    const { testUrl } = await import('../../../src/commands/test-url.js');

    await expect(
      testUrl({ url: 'https://example.com', crawler: 'firecrawl' }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);

    const errorMessages = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
    expect(errorMessages).toContain('FIRECRAWL_API_KEY');
  });
});
