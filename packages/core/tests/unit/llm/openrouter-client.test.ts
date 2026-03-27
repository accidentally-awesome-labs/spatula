import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMError } from '@spatula/shared';
import { OpenRouterClient } from '../../../src/llm/openrouter-client.js';
import type { LLMCompletionRequest } from '../../../src/interfaces/llm-client.js';

vi.mock('@spatula/shared', async () => {
  const actual = await vi.importActual('@spatula/shared');
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

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
      expect.objectContaining({ method: 'POST' }),
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

  it('throws if API key is empty', () => {
    expect(() => new OpenRouterClient({ apiKey: '' })).toThrow(LLMError);
  });

  it('throws if API key is whitespace only', () => {
    expect(() => new OpenRouterClient({ apiKey: '   ' })).toThrow(LLMError);
  });

  it('uses exponential back-off between retries', async () => {
    const { sleep } = await import('@spatula/shared');
    (sleep as ReturnType<typeof vi.fn>).mockClear();

    mockFetch
      .mockResolvedValueOnce(mockResponse('err', false, 429))
      .mockResolvedValueOnce(mockResponse('err', false, 429))
      .mockResolvedValueOnce(mockResponse(successBody('result')));

    await client.complete(basicRequest);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000); // 1000 * 2^0
    expect(sleep).toHaveBeenNthCalledWith(2, 2000); // 1000 * 2^1
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

  describe('UsageRecorder integration', () => {
    it('calls recorder.record() with token counts after successful complete()', async () => {
      const recorder = { record: vi.fn() };
      client.setUsageRecorder(recorder);
      mockFetch.mockResolvedValue(mockResponse(successBody('Hello', 'anthropic/claude-sonnet-4-20250514')));

      await client.complete(basicRequest);

      expect(recorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'anthropic/claude-sonnet-4-20250514',
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }),
      );
    });

    it('works normally without setUsageRecorder (no error)', async () => {
      // client has no usage recorder set (default)
      mockFetch.mockResolvedValue(mockResponse(successBody('Hello')));

      const result = await client.complete(basicRequest);
      expect(result.content).toBe('Hello');
    });
  });
});
