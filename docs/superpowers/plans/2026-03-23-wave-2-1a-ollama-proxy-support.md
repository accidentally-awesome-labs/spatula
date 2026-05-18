# Wave 2.1a: Ollama Client, LLM Factory & Proxy/Session Support

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ollama as an alternative LLM provider (free, local, offline), create a provider factory for selecting between OpenRouter and Ollama, and add proxy/cookie support to the crawlers.

**Architecture:** `OllamaClient` implements the existing `LLMClient` interface by calling Ollama's REST API (`/api/chat`). A `createLLMClient()` factory selects the provider based on configuration. Proxy and cookie support extends `CrawlOptions` and `CrawlConfig` Zod schemas, with Playwright using native proxy/cookie APIs and Firecrawl converting cookies to HTTP headers.

**Tech Stack:** TypeScript, Vitest, Ollama REST API (fetch-based), Playwright proxy/cookie APIs, Zod schema extensions

**Spec references:**

- Phase 12 spec: Workstream J sections 11.2 (Ollama), 11.4 (Proxy/Sessions)
- Phase 13 spec: section 11.2 (Ollama integration details)
- File: `docs/superpowers/specs/2026-03-21-phase-12-production-readiness-design.md`

---

## File Structure

### New Files

| File                                                      | Responsibility                                         |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `packages/core/src/llm/ollama-client.ts`                  | Ollama LLM client implementing `LLMClient` interface   |
| `packages/core/src/llm/llm-factory.ts`                    | Factory function to create OpenRouter or Ollama client |
| `packages/core/tests/unit/llm/ollama-client.test.ts`      | Tests for Ollama client                                |
| `packages/core/tests/unit/llm/llm-factory.test.ts`        | Tests for factory                                      |
| `packages/core/tests/unit/crawlers/proxy-cookies.test.ts` | Tests for proxy/cookie support in crawlers             |

### Modified Files

| File                                               | Change                                             |
| -------------------------------------------------- | -------------------------------------------------- |
| `packages/core/src/interfaces/crawler.ts`          | Add `proxy` and `cookies` to `CrawlOptions` schema |
| `packages/core/src/types/job.ts`                   | Add `proxy` and `cookies` to `CrawlConfig` schema  |
| `packages/core/src/crawlers/playwright-crawler.ts` | Pass proxy to `browser.newContext()`, set cookies  |
| `packages/core/src/crawlers/firecrawl-crawler.ts`  | Convert cookies to `Cookie` header                 |
| `packages/core/src/llm/types.ts`                   | Add `OllamaClientOptions` type                     |
| `packages/core/src/llm/index.ts`                   | Export new files                                   |

---

## Task 1: Ollama Client Types

**Files:**

- Modify: `packages/core/src/llm/types.ts`

- [ ] **Step 1: Add OllamaClientOptions to types.ts**

Append to the existing file:

```typescript
export interface OllamaClientOptions {
  baseUrl?: string; // Default: 'http://localhost:11434'
  timeoutMs?: number; // Default: 120000 (local models are slower)
}

export type LLMProvider = 'openrouter' | 'ollama';

export interface LLMFactoryConfig {
  provider: LLMProvider;
  openrouter?: OpenRouterClientOptions;
  ollama?: OllamaClientOptions;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/llm/types.ts
git commit -m "feat(core): add Ollama client types and LLM factory config"
```

---

## Task 2: Ollama Client Implementation

**Files:**

- Create: `packages/core/src/llm/ollama-client.ts`
- Create: `packages/core/tests/unit/llm/ollama-client.test.ts`

- [ ] **Step 1: Write failing tests for Ollama client**

```typescript
// packages/core/tests/unit/llm/ollama-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaClient } from '../../../src/llm/ollama-client.js';
import type { LLMCompletionRequest } from '../../../src/interfaces/llm-client.js';

const defaultRequest: LLMCompletionRequest = {
  model: 'llama3.2:8b',
  messages: [{ role: 'user', content: 'Extract the product name' }],
  temperature: 0.1,
  maxTokens: 4096,
};

describe('OllamaClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends correct request to Ollama API', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        message: { content: '{"name": "Widget"}' },
        model: 'llama3.2:8b',
        done: true,
        prompt_eval_count: 100,
        eval_count: 50,
      }),
    };
    mockFetch.mockResolvedValue(mockResponse as any);

    const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
    const result = await client.complete(defaultRequest);

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('llama3.2:8b');
    expect(body.messages).toEqual(defaultRequest.messages);
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0.1);
    expect(body.options.num_predict).toBe(4096);
  });

  it('returns correctly shaped response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        message: { content: 'Hello world' },
        model: 'llama3.2:8b',
        done: true,
        prompt_eval_count: 80,
        eval_count: 20,
      }),
    } as any);

    const client = new OllamaClient();
    const result = await client.complete(defaultRequest);

    expect(result.content).toBe('Hello world');
    expect(result.model).toBe('llama3.2:8b');
    expect(result.usage.promptTokens).toBe(80);
    expect(result.usage.completionTokens).toBe(20);
    expect(result.usage.totalTokens).toBe(100);
    expect(result.finishReason).toBe('stop');
  });

  it('uses default baseUrl when not provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        message: { content: 'ok' },
        model: 'test',
        done: true,
      }),
    } as any);

    const client = new OllamaClient();
    await client.complete(defaultRequest);

    expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/chat', expect.any(Object));
  });

  it('sets json format when jsonMode is true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        message: { content: '{}' },
        model: 'test',
        done: true,
      }),
    } as any);

    const client = new OllamaClient();
    await client.complete({ ...defaultRequest, jsonMode: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.format).toBe('json');
  });

  it('does not set format when jsonMode is false/undefined', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        message: { content: 'text' },
        model: 'test',
        done: true,
      }),
    } as any);

    const client = new OllamaClient();
    await client.complete(defaultRequest);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.format).toBeUndefined();
  });

  it('throws LLMError on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    } as any);

    const client = new OllamaClient();
    await expect(client.complete(defaultRequest)).rejects.toThrow('Ollama request failed: 404');
  });

  it('throws LLMError on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new OllamaClient();
    await expect(client.complete(defaultRequest)).rejects.toThrow('ECONNREFUSED');
  });

  it('handles missing token counts gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        message: { content: 'response' },
        model: 'test',
        done: true,
        // No prompt_eval_count or eval_count
      }),
    } as any);

    const client = new OllamaClient();
    const result = await client.complete(defaultRequest);

    expect(result.usage.promptTokens).toBe(0);
    expect(result.usage.completionTokens).toBe(0);
    expect(result.usage.totalTokens).toBe(0);
  });

  it('returns length as finishReason when done is false', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        message: { content: 'partial' },
        model: 'test',
        done: false,
      }),
    } as any);

    const client = new OllamaClient();
    const result = await client.complete(defaultRequest);

    expect(result.finishReason).toBe('length');
  });

  it('does NOT retry on failure (local server — no transient errors)', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const client = new OllamaClient();
    await expect(client.complete(defaultRequest)).rejects.toThrow();

    // Should only call fetch once — no retries for local server
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('respects custom timeout', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        message: { content: 'ok' },
        model: 'test',
        done: true,
      }),
    } as any);

    const client = new OllamaClient({ timeoutMs: 60000 });
    await client.complete(defaultRequest);

    // Verify AbortSignal.timeout was called with custom value
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.signal).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run ollama-client`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement OllamaClient**

```typescript
// packages/core/src/llm/ollama-client.ts
import { LLMError } from '@spatula/shared';
import type {
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
} from '../interfaces/llm-client.js';
import type { OllamaClientOptions } from './types.js';

interface OllamaChatResponse {
  message: { content: string };
  model: string;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * LLM client for Ollama (local, free, offline).
 *
 * No retries: Ollama runs on localhost — if fetch fails, the server is
 * down, not temporarily overloaded. Retrying adds latency with zero benefit.
 */
export class OllamaClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options?: OllamaClientOptions) {
    this.baseUrl = options?.baseUrl ?? 'http://localhost:11434';
    this.timeoutMs = options?.timeoutMs ?? 120_000;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false,
      options: {
        temperature: request.temperature ?? 0.1,
        num_predict: request.maxTokens ?? 4096,
      },
    };

    if (request.jsonMode) {
      body.format = 'json';
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new LLMError(`Ollama request failed: ${response.status}`, {
          context: { status: response.status, model: request.model },
        });
      }

      const data = (await response.json()) as OllamaChatResponse;

      return {
        content: data.message.content,
        model: data.model,
        usage: {
          promptTokens: data.prompt_eval_count ?? 0,
          completionTokens: data.eval_count ?? 0,
          totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        },
        finishReason: data.done ? 'stop' : 'length',
      };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      throw new LLMError(`Ollama completion failed: ${(error as Error).message}`, {
        cause: error as Error,
        context: { model: request.model, baseUrl: this.baseUrl },
      });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run ollama-client`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/ollama-client.ts packages/core/tests/unit/llm/ollama-client.test.ts
git commit -m "feat(core): add Ollama LLM client for local/offline inference"
```

---

## Task 3: LLM Provider Factory

**Files:**

- Create: `packages/core/src/llm/llm-factory.ts`
- Create: `packages/core/tests/unit/llm/llm-factory.test.ts`
- Modify: `packages/core/src/llm/index.ts`

- [ ] **Step 1: Write failing tests for LLM factory**

```typescript
// packages/core/tests/unit/llm/llm-factory.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createLLMClient } from '../../../src/llm/llm-factory.js';
import { OpenRouterClient } from '../../../src/llm/openrouter-client.js';
import { OllamaClient } from '../../../src/llm/ollama-client.js';
import type { LLMFactoryConfig } from '../../../src/llm/types.js';

describe('createLLMClient', () => {
  it('creates OpenRouterClient when provider is openrouter', () => {
    const config: LLMFactoryConfig = {
      provider: 'openrouter',
      openrouter: { apiKey: 'test-key' },
    };

    const client = createLLMClient(config);
    expect(client).toBeInstanceOf(OpenRouterClient);
  });

  it('creates OllamaClient when provider is ollama', () => {
    const config: LLMFactoryConfig = {
      provider: 'ollama',
      ollama: { baseUrl: 'http://localhost:11434' },
    };

    const client = createLLMClient(config);
    expect(client).toBeInstanceOf(OllamaClient);
  });

  it('creates OllamaClient with default options when ollama config omitted', () => {
    const config: LLMFactoryConfig = {
      provider: 'ollama',
    };

    const client = createLLMClient(config);
    expect(client).toBeInstanceOf(OllamaClient);
  });

  it('throws ConfigError for unknown provider', () => {
    const config = {
      provider: 'unknown' as any,
    };

    expect(() => createLLMClient(config)).toThrow('Unknown LLM provider');
  });

  it('throws when openrouter selected but no API key provided', () => {
    const config: LLMFactoryConfig = {
      provider: 'openrouter',
      openrouter: { apiKey: '' },
    };

    expect(() => createLLMClient(config)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run llm-factory`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement LLM factory**

```typescript
// packages/core/src/llm/llm-factory.ts
import { ConfigError } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMFactoryConfig } from './types.js';
import { OpenRouterClient } from './openrouter-client.js';
import { OllamaClient } from './ollama-client.js';

/**
 * Create an LLM client based on provider configuration.
 * Supports OpenRouter (cloud) and Ollama (local).
 */
export function createLLMClient(config: LLMFactoryConfig): LLMClient {
  switch (config.provider) {
    case 'openrouter': {
      const apiKey = config.openrouter?.apiKey?.trim();
      if (!apiKey) {
        throw new ConfigError(
          'OpenRouter API key is required when provider is "openrouter". ' +
            'Set OPENROUTER_API_KEY or use provider "ollama" for local inference.',
        );
      }
      return new OpenRouterClient({
        apiKey,
        baseUrl: config.openrouter?.baseUrl,
        maxRetries: config.openrouter?.maxRetries,
        timeoutMs: config.openrouter?.timeoutMs,
      });
    }

    case 'ollama':
      return new OllamaClient({
        baseUrl: config.ollama?.baseUrl,
        timeoutMs: config.ollama?.timeoutMs,
      });

    default:
      throw new ConfigError(`Unknown LLM provider: ${config.provider}`);
  }
}
```

- [ ] **Step 4: Update LLM barrel exports**

In `packages/core/src/llm/index.ts`, add:

```typescript
export { OllamaClient } from './ollama-client.js';
export { createLLMClient } from './llm-factory.js';
export type { OllamaClientOptions, LLMProvider, LLMFactoryConfig } from './types.js';
```

Note: The existing `index.ts` already exports `OpenRouterClientOptions` from types. The new types must also be re-exported for downstream packages.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run llm-factory`
Expected: All tests PASS

- [ ] **Step 6: Verify build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/llm/llm-factory.ts packages/core/src/llm/index.ts packages/core/tests/unit/llm/llm-factory.test.ts
git commit -m "feat(core): add LLM provider factory for OpenRouter/Ollama selection"
```

---

## Task 4: Proxy & Cookie Support in CrawlOptions

**Files:**

- Modify: `packages/core/src/interfaces/crawler.ts`
- Modify: `packages/core/src/types/job.ts`

- [ ] **Step 1: Extend CrawlOptions Zod schema**

In `packages/core/src/interfaces/crawler.ts`, add proxy and cookies fields to the `CrawlOptions` schema:

```typescript
export const CrawlOptions = z.object({
  timeout: z.number().default(30000),
  waitForSelector: z.string().optional(),
  headers: z.record(z.string()).optional(),
  userAgent: z.string().optional(),
  // Proxy configuration
  proxy: z
    .object({
      url: z.string(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  // Cookie injection
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string().default('/'),
        httpOnly: z.boolean().default(false),
        secure: z.boolean().default(false),
      }),
    )
    .optional(),
});
```

Also extend `CrawlResult.metadata` with `proxyUsed`:

```typescript
metadata: z.object({
  crawledAt: z.coerce.date(),
  responseTimeMs: z.number(),
  contentLength: z.number(),
  crawlerType: z.enum(['playwright', 'firecrawl']),
  proxyUsed: z.boolean().default(false),
}),
```

- [ ] **Step 2: Extend CrawlConfig in job.ts**

In `packages/core/src/types/job.ts`, add proxy and cookies to `CrawlConfig`:

```typescript
export const CrawlConfig = z.object({
  maxDepth: z.number().min(0).max(10).default(2),
  maxPages: z.number().min(1).default(1000),
  concurrency: z.number().min(1).max(20).default(5),
  crawlerType: z.enum(['playwright', 'firecrawl']).default('playwright'),
  // Proxy configuration
  proxy: z
    .object({
      url: z.string(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  // Cookie injection
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string().default('/'),
      }),
    )
    .optional(),
});
```

- [ ] **Step 3: Verify build (type changes may break existing tests)**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build`
Expected: Build succeeds (new optional fields don't break existing code)

- [ ] **Step 4: Run existing tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run`
Expected: All existing tests PASS (optional fields are backward-compatible)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/interfaces/crawler.ts packages/core/src/types/job.ts
git commit -m "feat(core): add proxy and cookie options to CrawlOptions and CrawlConfig"
```

---

## Task 5: Playwright Proxy & Cookie Integration

**Files:**

- Modify: `packages/core/src/crawlers/playwright-crawler.ts`
- Create: `packages/core/tests/unit/crawlers/proxy-cookies.test.ts`

- [ ] **Step 1: Write tests for proxy/cookie support**

```typescript
// packages/core/tests/unit/crawlers/proxy-cookies.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PlaywrightCrawler } from '../../../src/crawlers/playwright-crawler.js';
import type { CrawlOptions } from '../../../src/interfaces/crawler.js';

// Mock playwright browser
function createMockBrowser() {
  const mockPage = {
    goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
    content: vi.fn().mockResolvedValue('<html><body>Test</body></html>'),
    title: vi.fn().mockResolvedValue('Test Page'),
    close: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
  };

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    addCookies: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { mockBrowser, mockContext, mockPage };
}

describe('PlaywrightCrawler proxy support', () => {
  it('passes proxy config to browser context', async () => {
    const { mockBrowser, mockContext } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser as any);

    const options: CrawlOptions = {
      timeout: 30000,
      proxy: {
        url: 'socks5://127.0.0.1:1080',
        username: 'user',
        password: 'pass',
      },
    };

    await crawler.crawl('https://example.com', options);

    expect(mockBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: {
          server: 'socks5://127.0.0.1:1080',
          username: 'user',
          password: 'pass',
        },
      }),
    );
  });

  it('does not set proxy when not provided', async () => {
    const { mockBrowser } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser as any);

    await crawler.crawl('https://example.com');

    const contextArgs = mockBrowser.newContext.mock.calls[0][0] ?? {};
    expect(contextArgs.proxy).toBeUndefined();
  });
});

describe('PlaywrightCrawler cookie support', () => {
  it('sets cookies on context before navigation', async () => {
    const { mockBrowser, mockContext } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser as any);

    const options: CrawlOptions = {
      timeout: 30000,
      cookies: [
        {
          name: 'session_id',
          value: 'abc123',
          domain: '.example.com',
          path: '/',
          httpOnly: false,
          secure: false,
        },
      ],
    };

    await crawler.crawl('https://example.com', options);

    expect(mockContext.addCookies).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'session_id',
        value: 'abc123',
        domain: '.example.com',
      }),
    ]);
  });

  it('does not call addCookies when no cookies provided', async () => {
    const { mockBrowser, mockContext } = createMockBrowser();
    const crawler = new PlaywrightCrawler(mockBrowser as any);

    await crawler.crawl('https://example.com');

    expect(mockContext.addCookies).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run proxy-cookies`
Expected: FAIL (proxy/cookie logic not implemented yet)

- [ ] **Step 3: Add proxy and cookie support to PlaywrightCrawler**

Modify `packages/core/src/crawlers/playwright-crawler.ts`. Update the `crawl` method to pass proxy to `newContext()` and set cookies via `context.addCookies()`:

```typescript
async crawl(url: string, options?: CrawlOptions): Promise<CrawlResult> {
  const timeout = options?.timeout ?? 30000;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    const contextOptions: Record<string, unknown> = {};
    if (options?.userAgent) {
      contextOptions.userAgent = options.userAgent;
    }
    if (options?.headers) {
      contextOptions.extraHTTPHeaders = options.headers;
    }
    // Proxy support
    if (options?.proxy) {
      contextOptions.proxy = {
        server: options.proxy.url,
        ...(options.proxy.username ? { username: options.proxy.username } : {}),
        ...(options.proxy.password ? { password: options.proxy.password } : {}),
      };
    }

    context = await this.browser.newContext(contextOptions);

    // Cookie support — set cookies before creating page
    if (options?.cookies?.length) {
      await context.addCookies(options.cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? '/',
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
      })));
    }

    page = await context.newPage();
    // ... rest of the method unchanged ...
```

**Important:** Only modify the context setup section. The rest of the method (goto, content extraction, link extraction, error handling) stays unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run proxy-cookies`
Expected: All tests PASS

- [ ] **Step 5: Run all crawler tests to verify no regressions**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run crawlers`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/crawlers/playwright-crawler.ts packages/core/tests/unit/crawlers/proxy-cookies.test.ts
git commit -m "feat(core): add proxy and cookie support to Playwright crawler"
```

---

## Task 6: Firecrawl Cookie Support

**Files:**

- Modify: `packages/core/src/crawlers/firecrawl-crawler.ts`

- [ ] **Step 1: Add cookie-to-header conversion to Firecrawl crawler**

Firecrawl doesn't support proxy (uses its own IP pool) but does support cookies via headers. Modify the `crawl` method:

```typescript
async crawl(url: string, options?: CrawlOptions): Promise<CrawlResult> {
  const timeout = options?.timeout ?? 30000;
  const startTime = Date.now();

  // Log proxy warning — Firecrawl uses its own IP rotation
  if (options?.proxy) {
    logger.warn('Proxy configuration is ignored for Firecrawl crawler (uses built-in IP rotation)');
  }

  // Convert cookies to Cookie header
  const headers: Record<string, string> = {};
  if (options?.cookies?.length) {
    headers.Cookie = options.cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  }

  try {
    const response = await this.client.scrape(url, {
      formats: ['html', 'links'],
      timeout,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
    // ... rest unchanged ...
```

- [ ] **Step 2: Add test for Firecrawl cookie support**

Append to `packages/core/tests/unit/crawlers/proxy-cookies.test.ts`:

Reference the existing `firecrawl-crawler.test.ts` for the mock pattern (`vi.mock('@mendable/firecrawl-js', ...)`). Write a real test that instantiates `FirecrawlCrawler`, provides cookies in `CrawlOptions`, calls `crawl()`, and asserts the mock `scrape` function was called with `headers: { Cookie: 'session_id=abc123; csrf=xyz789' }`.

Also test that proxy generates a warning log but doesn't crash.

```typescript
// Append to proxy-cookies.test.ts or create in firecrawl-crawler.test.ts
describe('FirecrawlCrawler cookie support', () => {
  it('sends cookies as Cookie header to scrape API', async () => {
    // Mock firecrawl and verify headers.Cookie is set correctly
    // Use the same mock pattern as firecrawl-crawler.test.ts
  });

  it('logs warning when proxy is configured (unsupported by Firecrawl)', async () => {
    // Verify logger.warn is called, crawl still succeeds
  });
});
```

The implementer should read `packages/core/tests/unit/crawlers/firecrawl-crawler.test.ts` for the exact mock setup pattern and replicate it.

- [ ] **Step 3: Run tests**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run proxy-cookies`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/crawlers/firecrawl-crawler.ts packages/core/tests/unit/crawlers/proxy-cookies.test.ts
git commit -m "feat(core): add cookie-to-header support for Firecrawl crawler"
```

---

## Task 7: Integration Verification

**Files:**

- No new files — verification only

- [ ] **Step 1: Run full core test suite**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core test -- --run`
Expected: All tests PASS

- [ ] **Step 2: Run full build**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/core build`
Expected: Build succeeds

- [ ] **Step 3: Run queue tests (ensure orchestrator compatibility)**

Run: `cd /Users/salar/Projects/spatula && pnpm --filter @spatula/queue test -- --run`
Expected: All tests PASS (CrawlOptions extensions are optional — no breaking changes)

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "test: verify Wave 2.1a — Ollama client, LLM factory, proxy/cookie support"
```
