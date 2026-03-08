# Phase 3: LLM Integration & Static Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement an OpenRouter-backed LLM client with multi-model routing, HTML preprocessing, and a static data extractor that classifies pages and extracts structured data using LLM intelligence.

**Architecture:** The LLM layer lives in `packages/core/src/llm/` with a provider-agnostic `LLMClient` interface, an OpenRouter implementation using native `fetch`, and a model router that selects fast/primary/smart models per task. The extraction layer lives in `packages/core/src/extraction/` with an HTML preprocessor (Cheerio-based), schema-to-prompt converter, page classifier, and a `StaticExtractor` implementing the `Extractor` interface from Phase 1. All LLM responses use JSON mode and are validated with Zod before returning.

**Tech Stack:** Native `fetch` (Node 18+), Cheerio (already installed), Zod (already installed), Vitest for testing

**Depends on:** Phase 1 complete (types, interfaces, shared utilities), Phase 2 complete (crawlers, link extraction)

---

## Task 1: LLM Client Interface

**Files:**

- Create: `packages/core/src/interfaces/llm-client.ts`
- Modify: `packages/core/src/interfaces/index.ts`
- Test: `packages/core/tests/unit/interfaces/interfaces.test.ts` (add to existing)

**Step 1: Write the failing test**

Add a new test to the existing interfaces test file:

```typescript
// Add to packages/core/tests/unit/interfaces/interfaces.test.ts

// At the top, add the import:
import type {
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMMessage,
  LLMUsage,
} from '../../../src/interfaces/llm-client.js';

// Add this describe block:
describe('LLMClient interface', () => {
  it('can be implemented with complete method', () => {
    const mockClient: LLMClient = {
      complete: async (request: LLMCompletionRequest): Promise<LLMCompletionResponse> => {
        return {
          content: 'test',
          model: request.model,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        };
      },
    };

    expect(mockClient.complete).toBeDefined();
  });

  it('accepts all message roles', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    expect(messages).toHaveLength(3);
  });

  it('LLMUsage tracks token counts', () => {
    const usage: LLMUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };

    expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/interfaces/interfaces.test.ts`
Expected: FAIL — cannot find module `llm-client.js`

**Step 3: Write the implementation**

Create `packages/core/src/interfaces/llm-client.ts`:

```typescript
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionRequest {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMCompletionResponse {
  content: string;
  model: string;
  usage: LLMUsage;
  finishReason: string;
}

export interface LLMClient {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}
```

Update `packages/core/src/interfaces/index.ts` — add this line:

```typescript
export * from './llm-client.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run tests/unit/interfaces/interfaces.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/interfaces/llm-client.ts packages/core/src/interfaces/index.ts packages/core/tests/unit/interfaces/interfaces.test.ts
git commit -m "feat(core): add LLMClient interface with message and usage types"
```

---

## Task 2: LLM Types & Model Router

**Files:**

- Create: `packages/core/src/llm/types.ts`
- Create: `packages/core/src/llm/model-router.ts`
- Create: `packages/core/tests/unit/llm/model-router.test.ts`

**Step 1: Write the failing test**

Create `packages/core/tests/unit/llm/model-router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../../src/llm/model-router.js';
import type { LLMConfig } from '../../../src/types/job.js';

describe('resolveModel', () => {
  const defaultConfig: LLMConfig = {
    primaryModel: 'anthropic/claude-sonnet-4-20250514',
  };

  it('returns primary model when no overrides configured', () => {
    expect(resolveModel(defaultConfig, 'extraction')).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('returns primary model for tasks without specific override', () => {
    const config: LLMConfig = {
      primaryModel: 'anthropic/claude-sonnet-4-20250514',
      modelOverrides: {
        pageRelevance: 'anthropic/claude-haiku-4-5-20251001',
      },
    };

    expect(resolveModel(config, 'extraction')).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('returns override model when set for specific task', () => {
    const config: LLMConfig = {
      primaryModel: 'anthropic/claude-sonnet-4-20250514',
      modelOverrides: {
        pageRelevance: 'anthropic/claude-haiku-4-5-20251001',
      },
    };

    expect(resolveModel(config, 'pageRelevance')).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  it('resolves all task types without error', () => {
    const tasks = [
      'pageRelevance',
      'extraction',
      'linkEvaluation',
      'schemaEvolution',
      'entityMatching',
      'conflictResolution',
      'qualityAudit',
      'documentation',
    ] as const;

    for (const task of tasks) {
      expect(() => resolveModel(defaultConfig, task)).not.toThrow();
    }
  });

  it('uses custom primary model when configured', () => {
    const config: LLMConfig = {
      primaryModel: 'openai/gpt-4o',
    };

    expect(resolveModel(config, 'extraction')).toBe('openai/gpt-4o');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/llm/model-router.test.ts`
Expected: FAIL — cannot find module `model-router.js`

**Step 3: Write the implementation**

Create `packages/core/src/llm/types.ts`:

```typescript
export type LLMTask =
  | 'pageRelevance'
  | 'extraction'
  | 'linkEvaluation'
  | 'schemaEvolution'
  | 'entityMatching'
  | 'conflictResolution'
  | 'qualityAudit'
  | 'documentation';

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  siteName?: string;
  siteUrl?: string;
}
```

Create `packages/core/src/llm/model-router.ts`:

```typescript
import type { LLMConfig } from '../types/job.js';
import type { LLMTask } from './types.js';

export function resolveModel(config: LLMConfig, task: LLMTask): string {
  const override = config.modelOverrides?.[task];
  return override ?? config.primaryModel;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run tests/unit/llm/model-router.test.ts`
Expected: PASS — all 5 tests

**Step 5: Commit**

```bash
git add packages/core/src/llm/types.ts packages/core/src/llm/model-router.ts packages/core/tests/unit/llm/model-router.test.ts
git commit -m "feat(core): add LLM types and model router for task-based model selection"
```

---

## Task 3: OpenRouter Client

**Files:**

- Create: `packages/core/src/llm/openrouter-client.ts`
- Create: `packages/core/tests/unit/llm/openrouter-client.test.ts`

**Step 1: Write the failing test**

Create `packages/core/tests/unit/llm/openrouter-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMError } from '@spatula/shared';
import { OpenRouterClient } from '../../../src/llm/openrouter-client.js';
import type { LLMCompletionRequest } from '../../../src/interfaces/llm-client.js';

function mockResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  } as unknown as Response;
}

function successBody(content: string, model = 'test-model') {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    model,
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe('OpenRouterClient', () => {
  let client: OpenRouterClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    client = new OpenRouterClient({ apiKey: 'test-key-123' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const basicRequest: LLMCompletionRequest = {
    model: 'anthropic/claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  it('sends correct request to OpenRouter API', async () => {
    mockFetch.mockResolvedValue(mockResponse(successBody('Hi there')));

    await client.complete(basicRequest);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key-123',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('includes OpenRouter-specific headers', async () => {
    mockFetch.mockResolvedValue(mockResponse(successBody('Hi')));

    await client.complete(basicRequest);

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['HTTP-Referer']).toBe('https://spatula.dev');
    expect(callArgs.headers['X-Title']).toBe('Spatula');
  });

  it('parses successful response correctly', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(successBody('{"result": "test"}', 'anthropic/claude-sonnet-4-20250514')),
    );

    const result = await client.complete(basicRequest);

    expect(result.content).toBe('{"result": "test"}');
    expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
    expect(result.usage.totalTokens).toBe(150);
    expect(result.finishReason).toBe('stop');
  });

  it('sends json mode request format when enabled', async () => {
    mockFetch.mockResolvedValue(mockResponse(successBody('{}')));

    await client.complete({ ...basicRequest, jsonMode: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('does not include response_format when jsonMode is false', async () => {
    mockFetch.mockResolvedValue(mockResponse(successBody('text response')));

    await client.complete(basicRequest);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toBeUndefined();
  });

  it('passes temperature and maxTokens', async () => {
    mockFetch.mockResolvedValue(mockResponse(successBody('{}')));

    await client.complete({ ...basicRequest, temperature: 0.5, maxTokens: 2048 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(2048);
  });

  it('defaults temperature to 0 and maxTokens to 4096', async () => {
    mockFetch.mockResolvedValue(mockResponse(successBody('{}')));

    await client.complete(basicRequest);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
  });

  it('throws LLMError on HTTP 400', async () => {
    mockFetch.mockResolvedValue(mockResponse('Bad request', false, 400));

    await expect(client.complete(basicRequest)).rejects.toThrow(LLMError);
  });

  it('retries on HTTP 429 and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse('Rate limited', false, 429))
      .mockResolvedValueOnce(mockResponse(successBody('OK')));

    const result = await client.complete(basicRequest);

    expect(result.content).toBe('OK');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on HTTP 500 and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse('Server error', false, 500))
      .mockResolvedValueOnce(mockResponse(successBody('OK')));

    const result = await client.complete(basicRequest);

    expect(result.content).toBe('OK');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws LLMError after max retries exhausted', async () => {
    const client3 = new OpenRouterClient({ apiKey: 'key', maxRetries: 2 });
    mockFetch.mockResolvedValue(mockResponse('error', false, 500));

    await expect(client3.complete(basicRequest)).rejects.toThrow(LLMError);
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('throws LLMError on empty response choices', async () => {
    mockFetch.mockResolvedValue(mockResponse({ choices: [], model: 'test', usage: {} }));

    await expect(client.complete(basicRequest)).rejects.toThrow(LLMError);
  });

  it('throws LLMError on network error', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    await expect(client.complete(basicRequest)).rejects.toThrow(LLMError);
  });

  it('uses custom baseUrl when configured', async () => {
    const customClient = new OpenRouterClient({
      apiKey: 'key',
      baseUrl: 'https://custom.api.com/v1',
    });
    mockFetch.mockResolvedValue(mockResponse(successBody('OK')));

    await customClient.complete(basicRequest);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://custom.api.com/v1/chat/completions',
      expect.anything(),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/llm/openrouter-client.test.ts`
Expected: FAIL — cannot find module `openrouter-client.js`

**Step 3: Write the implementation**

Create `packages/core/src/llm/openrouter-client.ts`:

```typescript
import { LLMError } from '@spatula/shared';
import { createLogger, sleep } from '@spatula/shared';
import type {
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
} from '../interfaces/llm-client.js';
import type { OpenRouterClientOptions } from './types.js';

const logger = createLogger('openrouter-client');

interface OpenRouterAPIResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenRouterClient implements LLMClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly siteName: string;
  private readonly siteUrl: string;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.siteName = options.siteName ?? 'Spatula';
    this.siteUrl = options.siteUrl ?? 'https://spatula.dev';
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (request.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        logger.debug({ attempt, delay }, 'retrying LLM call');
        await sleep(delay);
      }

      try {
        const response = await this.doFetch(body);
        const data = (await response.json()) as OpenRouterAPIResponse;

        const choice = data.choices?.[0];
        if (!choice?.message?.content) {
          throw new Error('Empty response from LLM');
        }

        const result: LLMCompletionResponse = {
          content: choice.message.content,
          model: data.model ?? request.model,
          usage: {
            promptTokens: data.usage?.prompt_tokens ?? 0,
            completionTokens: data.usage?.completion_tokens ?? 0,
            totalTokens: data.usage?.total_tokens ?? 0,
          },
          finishReason: choice.finish_reason ?? 'stop',
        };

        logger.debug(
          { model: result.model, tokens: result.usage.totalTokens },
          'LLM call completed',
        );

        return result;
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.maxRetries && this.isRetryable(lastError)) {
          logger.warn({ error: lastError.message, attempt }, 'retryable LLM error');
          continue;
        }

        break;
      }
    }

    throw new LLMError(`LLM completion failed: ${lastError?.message ?? 'unknown error'}`, {
      cause: lastError,
      context: { model: request.model },
    });
  }

  private async doFetch(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': this.siteUrl,
          'X-Title': this.siteName,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'unknown');
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  private isRetryable(error: Error): boolean {
    const msg = error.message;
    if (msg.includes('HTTP 429')) return true;
    if (msg.includes('HTTP 500') || msg.includes('HTTP 502')) return true;
    if (msg.includes('HTTP 503') || msg.includes('HTTP 504')) return true;
    if (error.name === 'AbortError') return true;
    if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT')) return true;
    if (msg.includes('fetch failed')) return true;
    return false;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run tests/unit/llm/openrouter-client.test.ts`
Expected: PASS — all 14 tests

**Step 5: Commit**

```bash
git add packages/core/src/llm/openrouter-client.ts packages/core/tests/unit/llm/openrouter-client.test.ts
git commit -m "feat(core): add OpenRouter LLM client with retry and JSON mode support"
```

---

## Task 4: HTML Preprocessor

**Files:**

- Create: `packages/core/src/extraction/html-preprocessor.ts`
- Create: `packages/core/tests/unit/extraction/html-preprocessor.test.ts`

**Step 1: Write the failing test**

Create `packages/core/tests/unit/extraction/html-preprocessor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { preprocessHTML } from '../../../src/extraction/html-preprocessor.js';

describe('preprocessHTML', () => {
  it('extracts title from <title> tag', () => {
    const html = '<html><head><title>My Page</title></head><body><p>Hello</p></body></html>';
    const result = preprocessHTML(html);
    expect(result.title).toBe('My Page');
  });

  it('falls back to first h1 for title', () => {
    const html = '<html><body><h1>Main Heading</h1><p>Content</p></body></html>';
    const result = preprocessHTML(html);
    expect(result.title).toBe('Main Heading');
  });

  it('removes script tags', () => {
    const html = '<body><p>Keep</p><script>alert("remove")</script><p>Also keep</p></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('Keep');
    expect(result.content).toContain('Also keep');
    expect(result.content).not.toContain('alert');
  });

  it('removes style tags', () => {
    const html = '<body><style>.foo { color: red; }</style><p>Visible</p></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('Visible');
    expect(result.content).not.toContain('color');
  });

  it('removes noscript, svg, iframe, canvas tags', () => {
    const html = `<body>
      <noscript>No JS</noscript>
      <svg><rect/></svg>
      <iframe src="ad.html"></iframe>
      <canvas></canvas>
      <p>Real content</p>
    </body>`;
    const result = preprocessHTML(html);
    expect(result.content).toContain('Real content');
    expect(result.content).not.toContain('No JS');
    expect(result.content).not.toContain('rect');
  });

  it('preserves heading structure as markdown', () => {
    const html = '<body><h1>Title</h1><h2>Section</h2><h3>Sub</h3></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('# Title');
    expect(result.content).toContain('## Section');
    expect(result.content).toContain('### Sub');
  });

  it('preserves list items', () => {
    const html = '<body><ul><li>Item A</li><li>Item B</li></ul></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('- Item A');
    expect(result.content).toContain('- Item B');
  });

  it('preserves table content as pipe-separated rows', () => {
    const html = `<body><table>
      <tr><th>Name</th><th>Price</th></tr>
      <tr><td>Widget</td><td>$10</td></tr>
    </table></body>`;
    const result = preprocessHTML(html);
    expect(result.content).toContain('Name');
    expect(result.content).toContain('Price');
    expect(result.content).toContain('Widget');
    expect(result.content).toContain('$10');
  });

  it('collapses excessive whitespace', () => {
    const html = '<body><p>Hello</p>\n\n\n\n\n<p>World</p></body>';
    const result = preprocessHTML(html);
    expect(result.content).not.toMatch(/\n{3,}/);
  });

  it('estimates token count approximately', () => {
    const html = '<body><p>' + 'word '.repeat(100) + '</p></body>';
    const result = preprocessHTML(html);
    // ~500 chars / 4 ≈ 125 tokens
    expect(result.estimatedTokens).toBeGreaterThan(50);
    expect(result.estimatedTokens).toBeLessThan(300);
  });

  it('truncates when exceeding maxTokens', () => {
    const longText = 'a'.repeat(10000);
    const html = `<body><p>${longText}</p></body>`;
    const result = preprocessHTML(html, { maxTokens: 500 }); // ~2000 chars max
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[...truncated]');
    expect(result.content.length).toBeLessThan(3000);
  });

  it('does not truncate short content', () => {
    const html = '<body><p>Short content</p></body>';
    const result = preprocessHTML(html);
    expect(result.truncated).toBe(false);
    expect(result.content).not.toContain('[...truncated]');
  });

  it('handles empty body gracefully', () => {
    const html = '<html><head><title>Empty</title></head><body></body></html>';
    const result = preprocessHTML(html);
    expect(result.title).toBe('Empty');
    expect(result.content).toBe('');
    expect(result.estimatedTokens).toBe(0);
  });

  it('removes hidden elements', () => {
    const html = '<body><div hidden>Secret</div><p>Visible</p></body>';
    const result = preprocessHTML(html);
    expect(result.content).toContain('Visible');
    expect(result.content).not.toContain('Secret');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/extraction/html-preprocessor.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

Create `packages/core/src/extraction/html-preprocessor.ts`:

```typescript
import * as cheerio from 'cheerio';

export interface PreprocessedHTML {
  content: string;
  title?: string;
  estimatedTokens: number;
  truncated: boolean;
}

export interface PreprocessOptions {
  maxTokens?: number;
}

const REMOVE_TAGS = 'script, style, noscript, svg, iframe, canvas, [hidden]';

export function preprocessHTML(html: string, options?: PreprocessOptions): PreprocessedHTML {
  const maxChars = (options?.maxTokens ?? 25000) * 4;
  const $ = cheerio.load(html);

  $(REMOVE_TAGS).remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || undefined;

  const body = $('body');
  const raw = body.length ? walkNode($, body[0]) : '';

  const cleaned = raw
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = cleaned.length > maxChars;
  const finalContent = truncated ? cleaned.slice(0, maxChars) + '\n[...truncated]' : cleaned;

  return {
    content: finalContent,
    title,
    estimatedTokens: finalContent.length ? Math.ceil(finalContent.length / 4) : 0,
    truncated,
  };
}

function walkNode($: cheerio.CheerioAPI, node: unknown): string {
  const n = node as { type?: string; data?: string; tagName?: string };

  if (n.type === 'text') {
    return n.data ?? '';
  }

  if (n.type !== 'tag') return '';

  const tag = n.tagName?.toLowerCase() ?? '';
  const $el = $(node as cheerio.Element);
  const children = $el
    .contents()
    .toArray()
    .map((child) => walkNode($, child))
    .join('');

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `\n${'#'.repeat(parseInt(tag[1]))} ${children.trim()}\n`;
    case 'p':
      return `\n${children.trim()}\n`;
    case 'li':
      return `\n- ${children.trim()}`;
    case 'ul':
    case 'ol':
      return `\n${children}\n`;
    case 'br':
      return '\n';
    case 'tr': {
      const cells = $el
        .children('td, th')
        .map((_, td) => $(td).text().trim())
        .get();
      return cells.length ? `\n${cells.join(' | ')}` : children;
    }
    case 'table':
    case 'thead':
    case 'tbody':
      return `\n${children}\n`;
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'aside':
      return `\n${children}\n`;
    default:
      return children;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run tests/unit/extraction/html-preprocessor.test.ts`
Expected: PASS — all 14 tests

**Step 5: Commit**

```bash
git add packages/core/src/extraction/html-preprocessor.ts packages/core/tests/unit/extraction/html-preprocessor.test.ts
git commit -m "feat(core): add HTML preprocessor for LLM-ready text extraction"
```

---

## Task 5: Schema-to-Prompt Converter

**Files:**

- Create: `packages/core/src/extraction/schema-to-prompt.ts`
- Create: `packages/core/tests/unit/extraction/schema-to-prompt.test.ts`

**Step 1: Write the failing test**

Create `packages/core/tests/unit/extraction/schema-to-prompt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { schemaToPrompt, schemaToJsonSchema } from '../../../src/extraction/schema-to-prompt.js';
import type { FieldDefinitionOutput } from '../../../src/types/schema.js';

describe('schemaToPrompt', () => {
  it('formats a simple string field', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'title', description: 'Product title', type: 'string', required: true },
    ];

    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('title');
    expect(prompt).toContain('string');
    expect(prompt).toContain('REQUIRED');
    expect(prompt).toContain('Product title');
  });

  it('marks optional fields without REQUIRED', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'notes', description: 'Extra notes', type: 'string', required: false },
    ];

    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('notes');
    expect(prompt).not.toContain('REQUIRED');
  });

  it('formats enum field with allowed values', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'category',
        description: 'Product category',
        type: 'enum',
        required: true,
        enumValues: ['headphones', 'speakers', 'amplifiers'],
      },
    ];

    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('headphones');
    expect(prompt).toContain('speakers');
    expect(prompt).toContain('amplifiers');
  });

  it('formats nested object fields', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'specs',
        description: 'Technical specifications',
        type: 'object',
        required: false,
        objectFields: [
          { name: 'weight', description: 'Weight in grams', type: 'number', required: false },
          { name: 'color', description: 'Product color', type: 'string', required: false },
        ],
      },
    ];

    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('specs');
    expect(prompt).toContain('weight');
    expect(prompt).toContain('color');
  });

  it('formats array field with item type', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'features',
        description: 'Product features',
        type: 'array',
        required: false,
        arrayItemType: {
          name: 'feature',
          description: 'A feature',
          type: 'string',
          required: false,
        },
      },
    ];

    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('features');
    expect(prompt).toContain('array');
    expect(prompt).toContain('string');
  });

  it('handles multiple fields', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'name', description: 'Name', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'currency', required: false },
      { name: 'url', description: 'URL', type: 'url', required: false },
    ];

    const prompt = schemaToPrompt(fields);
    expect(prompt).toContain('name');
    expect(prompt).toContain('price');
    expect(prompt).toContain('url');
  });
});

describe('schemaToJsonSchema', () => {
  it('generates valid JSON schema for simple fields', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'title', description: 'Title', type: 'string', required: true },
      { name: 'price', description: 'Price', type: 'number', required: false },
    ];

    const schema = schemaToJsonSchema(fields);

    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect((schema.properties as Record<string, unknown>).title).toBeDefined();
    expect((schema.properties as Record<string, unknown>).price).toBeDefined();
    expect(schema.required).toContain('title');
    expect(schema.required).not.toContain('price');
  });

  it('maps currency type to object with amount and currency', () => {
    const fields: FieldDefinitionOutput[] = [
      { name: 'price', description: 'Price', type: 'currency', required: false },
    ];

    const schema = schemaToJsonSchema(fields);
    const priceProp = (schema.properties as Record<string, Record<string, unknown>>).price;
    expect(priceProp.type).toBe('object');
    expect(priceProp.properties).toBeDefined();
  });

  it('maps enum type to string with enum values', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'status',
        description: 'Status',
        type: 'enum',
        required: false,
        enumValues: ['active', 'inactive'],
      },
    ];

    const schema = schemaToJsonSchema(fields);
    const prop = (schema.properties as Record<string, Record<string, unknown>>).status;
    expect(prop.type).toBe('string');
    expect(prop.enum).toEqual(['active', 'inactive']);
  });

  it('maps object type with nested properties', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'dimensions',
        description: 'Dimensions',
        type: 'object',
        required: false,
        objectFields: [
          { name: 'width', description: 'Width', type: 'number', required: false },
          { name: 'height', description: 'Height', type: 'number', required: false },
        ],
      },
    ];

    const schema = schemaToJsonSchema(fields);
    const prop = (schema.properties as Record<string, Record<string, unknown>>).dimensions;
    expect(prop.type).toBe('object');
    expect(prop.properties).toBeDefined();
  });

  it('maps array type with item schema', () => {
    const fields: FieldDefinitionOutput[] = [
      {
        name: 'tags',
        description: 'Tags',
        type: 'array',
        required: false,
        arrayItemType: {
          name: 'tag',
          description: 'A tag',
          type: 'string',
          required: false,
        },
      },
    ];

    const schema = schemaToJsonSchema(fields);
    const prop = (schema.properties as Record<string, Record<string, unknown>>).tags;
    expect(prop.type).toBe('array');
    expect(prop.items).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/extraction/schema-to-prompt.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

Create `packages/core/src/extraction/schema-to-prompt.ts`:

```typescript
import type { FieldDefinitionOutput } from '../types/schema.js';

export function schemaToPrompt(fields: FieldDefinitionOutput[]): string {
  return fields.map((f) => fieldToLine(f, 0)).join('\n');
}

function fieldToLine(field: FieldDefinitionOutput, indent: number): string {
  const prefix = '  '.repeat(indent);
  const req = field.required ? ' (REQUIRED)' : '';

  let typeStr = field.type as string;
  if (field.type === 'enum' && field.enumValues?.length) {
    typeStr = `enum: ${field.enumValues.map((v) => `"${v}"`).join(', ')}`;
  }
  if (field.type === 'array' && field.arrayItemType) {
    typeStr = `array of ${field.arrayItemType.type}`;
  }

  let line = `${prefix}- ${field.name} (${typeStr}${req}): ${field.description}`;

  if (field.type === 'object' && field.objectFields?.length) {
    const subLines = field.objectFields.map((f) => fieldToLine(f, indent + 1));
    line += '\n' + subLines.join('\n');
  }

  return line;
}

type JsonSchemaProperty = {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export function schemaToJsonSchema(
  fields: FieldDefinitionOutput[],
): JsonSchemaProperty & { required: string[] } {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const field of fields) {
    properties[field.name] = fieldToJsonSchema(field);
    if (field.required) {
      required.push(field.name);
    }
  }

  return { type: 'object', properties, required };
}

function fieldToJsonSchema(field: FieldDefinitionOutput): JsonSchemaProperty {
  switch (field.type) {
    case 'string':
    case 'url':
      return { type: 'string', description: field.description };

    case 'number':
      return { type: 'number', description: field.description };

    case 'boolean':
      return { type: 'boolean', description: field.description };

    case 'currency':
      return {
        type: 'object',
        description: field.description,
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string' },
        },
      };

    case 'enum':
      return {
        type: 'string',
        description: field.description,
        enum: field.enumValues ?? [],
      };

    case 'array': {
      const items = field.arrayItemType
        ? fieldToJsonSchema(field.arrayItemType)
        : { type: 'string' };
      return { type: 'array', description: field.description, items };
    }

    case 'object': {
      const props: Record<string, JsonSchemaProperty> = {};
      const req: string[] = [];
      for (const sub of field.objectFields ?? []) {
        props[sub.name] = fieldToJsonSchema(sub);
        if (sub.required) req.push(sub.name);
      }
      return {
        type: 'object',
        description: field.description,
        properties: props,
        ...(req.length ? { required: req } : {}),
      };
    }

    default:
      return { type: 'string', description: field.description };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run tests/unit/extraction/schema-to-prompt.test.ts`
Expected: PASS — all 11 tests

**Step 5: Commit**

```bash
git add packages/core/src/extraction/schema-to-prompt.ts packages/core/tests/unit/extraction/schema-to-prompt.test.ts
git commit -m "feat(core): add schema-to-prompt and schema-to-JSON-schema converters"
```

---

## Task 6: Page Classifier

**Files:**

- Create: `packages/core/src/extraction/page-classifier.ts`
- Create: `packages/core/tests/unit/extraction/page-classifier.test.ts`

**Step 1: Write the failing test**

Create `packages/core/tests/unit/extraction/page-classifier.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PageClassifier } from '../../../src/extraction/page-classifier.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
    } satisfies LLMCompletionResponse),
  };
}

const config: LLMConfig = { primaryModel: 'test-model' };

describe('PageClassifier', () => {
  it('classifies a single product page', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'single_entry',
        strategy: 'full_extraction',
        estimatedEntryCount: 1,
        confidence: 0.95,
        reasoning: 'Product detail page with specs and pricing.',
      }),
    );

    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify(
      '<h1>Sony WH-1000XM5</h1><p>$379.99</p>',
      'https://example.com/product/123',
      'audiophile headphones',
    );

    expect(result.classification).toBe('single_entry');
    expect(result.strategy).toBe('full_extraction');
    expect(result.estimatedEntryCount).toBe(1);
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toBeDefined();
  });

  it('classifies a listing page', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'multiple_entries',
        strategy: 'list_extraction',
        estimatedEntryCount: 24,
        confidence: 0.88,
        reasoning: 'Category page with product grid.',
      }),
    );

    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify(
      '<div class="products"><div class="product">A</div></div>',
      'https://example.com/headphones',
      'audiophile headphones',
    );

    expect(result.classification).toBe('multiple_entries');
    expect(result.strategy).toBe('list_extraction');
    expect(result.estimatedEntryCount).toBe(24);
  });

  it('classifies a navigation page', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'navigation',
        strategy: 'links_only',
        confidence: 0.92,
        reasoning: 'Category index page.',
      }),
    );

    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify(
      '<nav><a href="/cat1">Cat 1</a></nav>',
      'https://example.com/categories',
      'audiophile products',
    );

    expect(result.classification).toBe('navigation');
    expect(result.strategy).toBe('links_only');
  });

  it('classifies an irrelevant page', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'irrelevant',
        strategy: 'skip',
        confidence: 0.97,
        reasoning: 'Privacy policy page.',
      }),
    );

    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify(
      '<h1>Privacy Policy</h1><p>We collect...</p>',
      'https://example.com/privacy',
      'audiophile products',
    );

    expect(result.classification).toBe('irrelevant');
    expect(result.strategy).toBe('skip');
  });

  it('uses fast model for page relevance via model router', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'single_entry',
        strategy: 'full_extraction',
        confidence: 0.9,
        reasoning: 'ok',
      }),
    );

    const configWithOverride: LLMConfig = {
      primaryModel: 'primary-model',
      modelOverrides: { pageRelevance: 'fast-model' },
    };

    const classifier = new PageClassifier(client, configWithOverride);
    await classifier.classify('<p>test</p>', 'https://example.com', 'test');

    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'fast-model' }));
  });

  it('enables JSON mode for LLM request', async () => {
    const client = createMockClient(
      JSON.stringify({
        classification: 'single_entry',
        strategy: 'full_extraction',
        confidence: 0.9,
        reasoning: 'ok',
      }),
    );

    const classifier = new PageClassifier(client, config);
    await classifier.classify('<p>test</p>', 'https://example.com', 'test');

    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({ jsonMode: true }));
  });

  it('returns safe defaults on invalid JSON from LLM', async () => {
    const client = createMockClient('not valid json at all');

    const classifier = new PageClassifier(client, config);
    const result = await classifier.classify('<p>content</p>', 'https://example.com', 'products');

    expect(result.classification).toBe('irrelevant');
    expect(result.strategy).toBe('skip');
    expect(result.confidence).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/extraction/page-classifier.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

Create `packages/core/src/extraction/page-classifier.ts`:

```typescript
import { z } from 'zod';
import { createLogger } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMConfig } from '../types/job.js';
import { PageClassification, ExtractionStrategy } from '../types/extraction.js';
import { resolveModel } from '../llm/model-router.js';
import { preprocessHTML } from './html-preprocessor.js';

const logger = createLogger('page-classifier');

const ClassificationResponse = z.object({
  classification: PageClassification,
  strategy: ExtractionStrategy,
  estimatedEntryCount: z.number().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type PageClassificationResult = z.infer<typeof ClassificationResponse>;

export class PageClassifier {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
  ) {}

  async classify(
    html: string,
    url: string,
    jobDescription: string,
  ): Promise<PageClassificationResult> {
    const preprocessed = preprocessHTML(html, { maxTokens: 8000 });

    const prompt = buildClassificationPrompt(url, jobDescription, preprocessed.content);

    try {
      const response = await this.llmClient.complete({
        model: resolveModel(this.config, 'pageRelevance'),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 512,
      });

      const parsed = ClassificationResponse.safeParse(JSON.parse(response.content));

      if (!parsed.success) {
        logger.warn({ url, errors: parsed.error.issues }, 'invalid classification response');
        return safeDefault();
      }

      logger.debug(
        { url, classification: parsed.data.classification, confidence: parsed.data.confidence },
        'page classified',
      );

      return parsed.data;
    } catch (error) {
      logger.error({ url, error }, 'page classification failed');
      return safeDefault();
    }
  }
}

function safeDefault(): PageClassificationResult {
  return {
    classification: 'irrelevant',
    strategy: 'skip',
    confidence: 0,
    reasoning: 'Classification failed — defaulting to skip.',
  };
}

const SYSTEM_PROMPT = `You are a web page classifier. Your job is to determine what type of content a page contains relative to a data collection goal. Respond with JSON only.`;

function buildClassificationPrompt(url: string, jobDescription: string, content: string): string {
  return `Classify this web page for data collection.

## Data Collection Goal
${jobDescription}

## Page URL
${url}

## Page Content
${content}

## Instructions
Classify this page into one of these categories:
- "single_entry": Detailed information about ONE item (e.g., product detail page)
- "multiple_entries": A list or grid of MULTIPLE items (e.g., category/listing page)
- "navigation": Category index or navigation page with links but little extractable data
- "irrelevant": No content relevant to the data collection goal
- "partial": Some relevant data but incomplete

Choose the extraction strategy:
- "full_extraction": For single_entry or partial pages with detailed data
- "list_extraction": For multiple_entries pages
- "links_only": For navigation pages (discover links to follow)
- "skip": For irrelevant pages

Respond with JSON:
{
  "classification": "single_entry|multiple_entries|navigation|irrelevant|partial",
  "strategy": "full_extraction|list_extraction|links_only|skip",
  "estimatedEntryCount": 1,
  "confidence": 0.95,
  "reasoning": "Brief explanation"
}`;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run tests/unit/extraction/page-classifier.test.ts`
Expected: PASS — all 7 tests

**Step 5: Commit**

```bash
git add packages/core/src/extraction/page-classifier.ts packages/core/tests/unit/extraction/page-classifier.test.ts
git commit -m "feat(core): add LLM-powered page classifier with safe fallback"
```

---

## Task 7: Static Extractor

**Files:**

- Create: `packages/core/src/extraction/static-extractor.ts`
- Create: `packages/core/tests/unit/extraction/static-extractor.test.ts`

**Step 1: Write the failing test**

Create `packages/core/tests/unit/extraction/static-extractor.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ExtractionError } from '@spatula/shared';
import { StaticExtractor } from '../../../src/extraction/static-extractor.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

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

const testSchema: SchemaDefinition = {
  version: 1,
  fields: [
    { name: 'product_name', description: 'Product name', type: 'string', required: true },
    { name: 'price', description: 'Price', type: 'currency', required: false },
    { name: 'description', description: 'Description', type: 'string', required: false },
  ],
  fieldAliases: [],
  createdAt: new Date('2026-01-01'),
  parentVersion: null,
};

const sampleHtml = `
<html><body>
  <h1>Sony WH-1000XM5</h1>
  <p class="price">$379.99</p>
  <p>Industry-leading noise cancellation headphones.</p>
</body></html>
`;

describe('StaticExtractor', () => {
  it('extracts data from HTML and returns ExtractionResult', async () => {
    const client = createMockClient(
      JSON.stringify({
        data: {
          product_name: 'Sony WH-1000XM5',
          price: { amount: 379.99, currency: 'USD' },
          description: 'Industry-leading noise cancellation headphones.',
        },
        _unmapped: [],
        confidence: 0.92,
      }),
    );

    const extractor = new StaticExtractor(client, config, 'job-id-123');
    const result = await extractor.extract(
      sampleHtml,
      'https://example.com/product/123',
      testSchema,
      'audiophile headphones',
    );

    expect(result.jobId).toBe('job-id-123');
    expect(result.schemaVersion).toBe(1);
    expect(result.data.product_name).toBe('Sony WH-1000XM5');
    expect(result.data.price).toEqual({ amount: 379.99, currency: 'USD' });
    expect(result.metadata.confidence).toBe(0.92);
    expect(result.metadata.modelUsed).toBe('test-model');
    expect(result.metadata.tokensUsed).toBe(300);
    expect(result.metadata.extractionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.unmappedFields).toEqual([]);
    expect(result.id).toBeDefined();
    expect(result.pageId).toBeDefined();
  });

  it('captures unmapped fields in metadata', async () => {
    const client = createMockClient(
      JSON.stringify({
        data: { product_name: 'Test' },
        _unmapped: [
          { name: 'driver_type', value: '40mm dynamic', suggestedType: 'string' },
          { name: 'weight', value: '250g', suggestedType: 'string' },
        ],
        confidence: 0.85,
      }),
    );

    const extractor = new StaticExtractor(client, config, 'job-1');
    const result = await extractor.extract(
      sampleHtml,
      'https://example.com',
      testSchema,
      'products',
    );

    expect(result.metadata.unmappedFields).toHaveLength(2);
    expect(result.metadata.unmappedFields[0].name).toBe('driver_type');
    expect(result.metadata.unmappedFields[1].name).toBe('weight');
  });

  it('uses extraction model from config', async () => {
    const client = createMockClient(JSON.stringify({ data: {}, _unmapped: [], confidence: 0.5 }));

    const configWithOverride: LLMConfig = {
      primaryModel: 'primary',
      modelOverrides: { extraction: 'extraction-model' },
    };

    const extractor = new StaticExtractor(client, configWithOverride, 'job-1');
    await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');

    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'extraction-model' }),
    );
  });

  it('enables JSON mode for LLM request', async () => {
    const client = createMockClient(JSON.stringify({ data: {}, _unmapped: [], confidence: 0.5 }));

    const extractor = new StaticExtractor(client, config, 'job-1');
    await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');

    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({ jsonMode: true }));
  });

  it('returns empty extraction on invalid JSON from LLM', async () => {
    const client = createMockClient('totally not json {}{}');

    const extractor = new StaticExtractor(client, config, 'job-1');
    const result = await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');

    expect(result.data).toEqual({});
    expect(result.metadata.confidence).toBe(0);
    expect(result.metadata.unmappedFields).toEqual([]);
  });

  it('throws ExtractionError when LLM client throws', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };

    const extractor = new StaticExtractor(client, config, 'job-1');
    await expect(
      extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test'),
    ).rejects.toThrow(ExtractionError);
  });

  it('generates unique ids for each extraction', async () => {
    const client = createMockClient(
      JSON.stringify({ data: { product_name: 'A' }, _unmapped: [], confidence: 0.9 }),
    );

    const extractor = new StaticExtractor(client, config, 'job-1');
    const r1 = await extractor.extract(sampleHtml, 'https://example.com/1', testSchema, 'test');
    const r2 = await extractor.extract(sampleHtml, 'https://example.com/2', testSchema, 'test');

    expect(r1.id).not.toBe(r2.id);
    expect(r1.pageId).not.toBe(r2.pageId);
  });

  it('includes schema fields description in LLM prompt', async () => {
    const client = createMockClient(JSON.stringify({ data: {}, _unmapped: [], confidence: 0.5 }));

    const extractor = new StaticExtractor(client, config, 'job-1');
    await extractor.extract(sampleHtml, 'https://example.com', testSchema, 'test');

    const messages = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    const userMessage = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('product_name');
    expect(userMessage).toContain('price');
    expect(userMessage).toContain('REQUIRED');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/extraction/static-extractor.test.ts`
Expected: FAIL — cannot find module

**Step 3: Write the implementation**

Create `packages/core/src/extraction/static-extractor.ts`:

```typescript
import { z } from 'zod';
import { ExtractionError, createLogger, generateId } from '@spatula/shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { Extractor } from '../interfaces/extractor.js';
import type { LLMConfig } from '../types/job.js';
import type { SchemaDefinition, FieldDefinitionOutput } from '../types/schema.js';
import type { ExtractionResult } from '../types/extraction.js';
import { UnmappedField } from '../types/extraction.js';
import { resolveModel } from '../llm/model-router.js';
import { preprocessHTML } from './html-preprocessor.js';
import { schemaToPrompt } from './schema-to-prompt.js';

const logger = createLogger('static-extractor');

const LLMExtractionResponse = z.object({
  data: z.record(z.unknown()),
  _unmapped: z.array(UnmappedField).optional().default([]),
  confidence: z.number().min(0).max(1),
});

export class StaticExtractor implements Extractor {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly config: LLMConfig,
    private readonly jobId: string,
  ) {}

  async extract(
    html: string,
    url: string,
    schema: SchemaDefinition,
    jobDescription: string,
  ): Promise<ExtractionResult> {
    const startTime = Date.now();
    const preprocessed = preprocessHTML(html);
    const schemaPrompt = schemaToPrompt(schema.fields as FieldDefinitionOutput[]);
    const prompt = buildExtractionPrompt(url, jobDescription, schemaPrompt, preprocessed.content);

    try {
      const response = await this.llmClient.complete({
        model: resolveModel(this.config, 'extraction'),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 4096,
      });

      const extractionTimeMs = Date.now() - startTime;

      let parsed: z.infer<typeof LLMExtractionResponse>;
      try {
        parsed = LLMExtractionResponse.parse(JSON.parse(response.content));
      } catch {
        logger.warn({ url }, 'invalid extraction response from LLM');
        return this.emptyResult(schema.version, extractionTimeMs, response.model, 0);
      }

      logger.debug(
        { url, confidence: parsed.confidence, fields: Object.keys(parsed.data).length },
        'extraction completed',
      );

      return {
        id: generateId(),
        jobId: this.jobId,
        pageId: generateId(),
        schemaVersion: schema.version,
        data: parsed.data,
        metadata: {
          confidence: parsed.confidence,
          modelUsed: response.model,
          tokensUsed: response.usage.totalTokens,
          extractionTimeMs,
          unmappedFields: parsed._unmapped ?? [],
        },
      };
    } catch (error) {
      if (error instanceof ExtractionError) throw error;

      throw new ExtractionError(`Extraction failed for ${url}: ${(error as Error).message}`, {
        cause: error as Error,
        context: { url, jobId: this.jobId },
      });
    }
  }

  private emptyResult(
    schemaVersion: number,
    extractionTimeMs: number,
    model: string,
    tokensUsed: number,
  ): ExtractionResult {
    return {
      id: generateId(),
      jobId: this.jobId,
      pageId: generateId(),
      schemaVersion,
      data: {},
      metadata: {
        confidence: 0,
        modelUsed: model,
        tokensUsed,
        extractionTimeMs,
        unmappedFields: [],
      },
    };
  }
}

const SYSTEM_PROMPT = `You are a data extraction expert. Extract structured information from web pages according to a provided schema. Return JSON only.`;

function buildExtractionPrompt(
  url: string,
  jobDescription: string,
  schemaPrompt: string,
  content: string,
): string {
  return `Extract structured data from this web page.

## Data Description
${jobDescription}

## Schema
${schemaPrompt}

## Rules
1. Extract values exactly as they appear on the page.
2. For REQUIRED fields, make every effort to find the value. If truly absent, set to null.
3. For optional fields, include them only if clearly present on the page.
4. If you discover data on the page that doesn't fit any schema field but seems relevant to "${jobDescription}", include it in the _unmapped array.
5. Return your confidence (0.0-1.0) in the overall extraction quality.

## Page
URL: ${url}

${content}

## Response Format
Return JSON:
{
  "data": { /* extracted fields matching the schema */ },
  "_unmapped": [
    { "name": "field_name", "value": "extracted_value", "suggestedType": "string|number|boolean|url|currency|enum|array|object" }
  ],
  "confidence": 0.95
}`;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run tests/unit/extraction/static-extractor.test.ts`
Expected: PASS — all 8 tests

**Step 5: Commit**

```bash
git add packages/core/src/extraction/static-extractor.ts packages/core/tests/unit/extraction/static-extractor.test.ts
git commit -m "feat(core): add StaticExtractor implementing Extractor interface with LLM-powered extraction"
```

---

## Task 8: Barrel Exports & Package Integration

**Files:**

- Create: `packages/core/src/llm/index.ts`
- Create: `packages/core/src/extraction/index.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

Add import tests to verify public API. Create `packages/core/tests/unit/exports.test.ts`:

```typescript
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
    // Phase 1 types still exported
    expect(root.ExtractionResult).toBeDefined();
    expect(root.PageClassification).toBeDefined();
    // Phase 2 crawlers still exported
    expect(root.PlaywrightCrawler).toBeDefined();
    expect(root.FirecrawlCrawler).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/unit/exports.test.ts`
Expected: FAIL — cannot find modules

**Step 3: Write the implementation**

Create `packages/core/src/llm/index.ts`:

```typescript
export { OpenRouterClient } from './openrouter-client.js';
export { resolveModel } from './model-router.js';
export type { LLMTask, OpenRouterClientOptions } from './types.js';
```

Create `packages/core/src/extraction/index.ts`:

```typescript
export { preprocessHTML } from './html-preprocessor.js';
export type { PreprocessedHTML, PreprocessOptions } from './html-preprocessor.js';
export { schemaToPrompt, schemaToJsonSchema } from './schema-to-prompt.js';
export { PageClassifier } from './page-classifier.js';
export type { PageClassificationResult } from './page-classifier.js';
export { StaticExtractor } from './static-extractor.js';
```

Update `packages/core/src/index.ts`:

```typescript
// Types
export * from './types/index.js';

// Interfaces
export * from './interfaces/index.js';

// Crawlers
export * from './crawlers/index.js';

// LLM
export * from './llm/index.js';

// Extraction
export * from './extraction/index.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run tests/unit/exports.test.ts`
Expected: PASS — all 3 tests

**Step 5: Commit**

```bash
git add packages/core/src/llm/index.ts packages/core/src/extraction/index.ts packages/core/src/index.ts packages/core/tests/unit/exports.test.ts
git commit -m "feat(core): add barrel exports for LLM and extraction modules"
```

---

## Task 9: Integration Tests with HTML Fixtures

**Files:**

- Create: `packages/core/tests/fixtures/navigation-page.html`
- Create: `packages/core/tests/fixtures/irrelevant-page.html`
- Create: `packages/core/tests/integration/extraction/extraction-pipeline.test.ts`

**Step 1: Create HTML fixtures**

Create `packages/core/tests/fixtures/navigation-page.html`:

```html
<!doctype html>
<html>
  <head>
    <title>Audio Equipment Categories - AudioStore</title>
  </head>
  <body>
    <header>
      <nav>
        <a href="/">Home</a>
        <a href="/categories">Categories</a>
      </nav>
    </header>
    <main>
      <h1>Browse Audio Equipment</h1>
      <div class="category-grid">
        <a href="/headphones" class="category-card">
          <h2>Headphones</h2>
          <p>Over-ear, on-ear, and in-ear monitors</p>
        </a>
        <a href="/amplifiers" class="category-card">
          <h2>Amplifiers</h2>
          <p>Desktop and portable headphone amps</p>
        </a>
        <a href="/dacs" class="category-card">
          <h2>DACs</h2>
          <p>Digital-to-analog converters</p>
        </a>
        <a href="/speakers" class="category-card">
          <h2>Speakers</h2>
          <p>Bookshelf, floor-standing, and powered</p>
        </a>
      </div>
    </main>
    <footer>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </footer>
  </body>
</html>
```

Create `packages/core/tests/fixtures/irrelevant-page.html`:

```html
<!doctype html>
<html>
  <head>
    <title>Privacy Policy - AudioStore</title>
  </head>
  <body>
    <h1>Privacy Policy</h1>
    <p>Last updated: January 1, 2026</p>
    <h2>Information We Collect</h2>
    <p>
      We collect information you provide directly to us, such as when you create an account, make a
      purchase, or contact us for support.
    </p>
    <h2>How We Use Your Information</h2>
    <p>
      We use the information we collect to provide, maintain, and improve our services, process
      transactions, and send you technical notices.
    </p>
    <h2>Cookie Policy</h2>
    <p>We use cookies and similar tracking technologies to track activity on our website.</p>
    <h2>Contact Us</h2>
    <p>
      If you have questions about this Privacy Policy, please contact us at privacy@audiostore.com
    </p>
  </body>
</html>
```

**Step 2: Write the integration tests**

Create `packages/core/tests/integration/extraction/extraction-pipeline.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PageClassifier } from '../../../src/extraction/page-classifier.js';
import { StaticExtractor } from '../../../src/extraction/static-extractor.js';
import { preprocessHTML } from '../../../src/extraction/html-preprocessor.js';
import type { LLMClient, LLMCompletionResponse } from '../../../src/interfaces/llm-client.js';
import type { LLMConfig } from '../../../src/types/job.js';
import type { SchemaDefinition } from '../../../src/types/schema.js';

const fixturesDir = join(__dirname, '../../fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
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
```

**Step 3: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run tests/integration/extraction/extraction-pipeline.test.ts`
Expected: PASS — all 7 tests

**Step 4: Commit**

```bash
git add packages/core/tests/fixtures/navigation-page.html packages/core/tests/fixtures/irrelevant-page.html packages/core/tests/integration/extraction/extraction-pipeline.test.ts
git commit -m "feat(core): add extraction pipeline integration tests with HTML fixtures"
```

---

## Task 10: Final Verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass across all packages

**Step 2: Run typecheck**

Run: `pnpm build`
Expected: Clean build, no errors

**Step 3: Run linter**

Run: `pnpm lint`
Expected: No lint errors

**Step 4: Run formatter**

Run: `pnpm format:check` (or `npx prettier --check "packages/core/src/**/*.ts" "packages/core/tests/**/*.ts"`)
Expected: All files formatted. If not, run `npx prettier --write` on the offending files.

**Step 5: Verify test count**

Expected: ~135+ tests total across the monorepo (112 from Phase 2 + new tests from Phase 3)

**Step 6: Commit any format fixes**

```bash
git add -A
git commit -m "chore: format Phase 3 files"
```
