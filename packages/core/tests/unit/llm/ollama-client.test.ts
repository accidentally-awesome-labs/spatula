import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMError, TimeoutError } from '@spatula/shared';
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
    await client.complete(defaultRequest);

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
    mockFetch.mockResolvedValue({ ok: false, status: 404 } as any);

    const client = new OllamaClient();
    const error = await client.complete(defaultRequest).catch((e) => e);

    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('404');
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
    // Note: AbortSignal.timeout() returns an opaque signal — the timeout value
    // is not inspectable. We verify the signal is passed to fetch; the actual
    // timeout behavior is tested in the 'throws TimeoutError' test case.
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

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.signal).toBeDefined();
  });

  it('wraps errors as LLMError instances', async () => {
    mockFetch.mockRejectedValue(new Error('network failure'));

    const client = new OllamaClient();
    await expect(client.complete(defaultRequest)).rejects.toBeInstanceOf(LLMError);
  });

  it('throws TimeoutError when request times out', async () => {
    const timeoutError = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    mockFetch.mockRejectedValue(timeoutError);

    const client = new OllamaClient({ timeoutMs: 1000 });
    await expect(client.complete(defaultRequest)).rejects.toThrow('timed out');
    await expect(client.complete(defaultRequest)).rejects.toBeInstanceOf(TimeoutError);
  });
});
