import { APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk';
import { buildLlmRequest, LLM_MAX_TOKENS, llmFields, SYSTEM_PROMPT } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createAnthropicLlm } from './llm-anthropic';

const product = testDefinition().recordTypes.product!;
const question = buildLlmRequest({
  url: 'https://maker-a.example/products/a1',
  text: 'A1 Impedance: 300 Ω',
  fields: llmFields(product, ['specs']),
});

/** A Messages API answer, with a thinking block first, as Opus 5.5 always thinks. */
function answer(text: string, stopReason = 'end_turn') {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text },
      ],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 80 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function setUp(
  reply: (init: RequestInit) => Response | Promise<Response>,
  limits: { timeoutMs?: number; deadlineMs?: number } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const llm = createAnthropicLlm({
    apiKey: 'test-key',
    model: 'claude-opus-5-5',
    baseURL: 'https://gateway.example/v1/account/spatula-llm/anthropic',
    gatewayToken: 'gateway-token',
    ...limits,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return reply(init ?? {});
    }) as typeof fetch,
  });
  return { llm, calls };
}

describe('createAnthropicLlm', () => {
  it('sends no x-api-key where the gateway holds the key', async () => {
    const calls: { init: RequestInit }[] = [];
    const llm = createAnthropicLlm({
      model: 'claude-opus-5-5',
      name: 'anthropic/claude-opus-5-5',
      baseURL: 'https://gateway.example/v1/account/spatula-llm/anthropic',
      gatewayToken: 'gateway-token',
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push({ init: init ?? {} });
        return answer('{"specs": []}');
      }) as typeof fetch,
    });
    expect(llm.model).toBe('anthropic/claude-opus-5-5');
    await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.has('x-api-key')).toBe(false);
    expect(headers.get('cf-aig-authorization')).toBe('Bearer gateway-token');
  });

  it('replaces a key an error echoes, keeping the status', async () => {
    const { llm } = setUp(
      () =>
        new Response(
          '{"type":"error","error":{"type":"invalid_request_error","message":"bad key test-key"}}',
          {
            status: 401,
          },
        ),
    );
    const failure = await llm
      .structured({ ...question, maxTokens: LLM_MAX_TOKENS })
      .catch((e) => e);
    expect(failure).toMatchObject({ status: 401 });
    expect(failure.message).not.toContain('test-key');
    expect(failure.message).toContain('[key]');
  });

  it('asks through the gateway with the schema, and returns the checked answer and its usage', async () => {
    const specs = [{ label: 'Impedance', value: '300 Ω' }];
    const { llm, calls } = setUp(() => answer(JSON.stringify({ specs })));
    expect(llm.model).toBe('claude-opus-5-5');
    expect(await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS })).toEqual({
      output: { specs },
      usage: { inputTokens: 1200, outputTokens: 80 },
    });

    const [call] = calls;
    expect(call!.url).toBe('https://gateway.example/v1/account/spatula-llm/anthropic/v1/messages');
    const headers = new Headers(call!.init.headers);
    expect(headers.get('x-api-key')).toBe('test-key');
    expect(headers.get('cf-aig-authorization')).toBe('Bearer gateway-token');
    const body = JSON.parse(String(call!.init.body));
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: LLM_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question.user }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    });
    expect(body.output_config.format.schema.properties.specs.type).toBe('array');
    // Opus 5.5 always thinks and refuses `thinking: { type: 'disabled' }`, so none is sent.
    expect(body).not.toHaveProperty('thinking');
  });

  it('returns no answer, with the usage, when the answer doesn’t fit the schema', async () => {
    const { llm } = setUp(() => answer(JSON.stringify({ specs: [{ label: 'Impedance' }] })));
    expect(await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS })).toEqual({
      output: null,
      usage: { inputTokens: 1200, outputTokens: 80 },
    });
  });

  it('returns no answer for a refusal or an answer cut off by the token limit', async () => {
    for (const stopReason of ['refusal', 'max_tokens']) {
      const { llm } = setUp(() => answer('{"specs": []}', stopReason));
      expect((await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS })).output).toBeNull();
    }
  });

  it('gives up on a call that never answers', { timeout: 15_000 }, async () => {
    // A hung connection: this fetch settles only when the client aborts the request at its timeout.
    const { llm, calls } = setUp(
      ({ signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
      { timeoutMs: 50 },
    );
    await expect(llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS })).rejects.toBeInstanceOf(
      APIConnectionTimeoutError,
    );
    // The first attempt and the SDK's two retries.
    expect(calls).toHaveLength(3);
  });

  it('allows each attempt 150 s unless told otherwise', async () => {
    const { llm, calls } = setUp(() => answer('{"specs": []}'));
    await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS });
    // The SDK tells the server the timeout it applies, in seconds.
    expect(new Headers(calls[0]!.init.headers).get('x-stainless-timeout')).toBe('150');
  });

  it('gives up at its deadline during a long retry-after', { timeout: 10_000 }, async () => {
    // A rate limit that asks to be left alone for a quarter of an hour. The SDK would sleep that
    // long before each retry, however short its own attempt timeout is.
    const { llm, calls } = setUp(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Slow down.' },
          }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '900' } },
        ),
      { deadlineMs: 300 },
    );
    await expect(llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS })).rejects.toBeInstanceOf(
      APIUserAbortError,
    );
    expect(calls).toHaveLength(1);
  });

  it('gives up at its deadline on an answer that stops arriving', { timeout: 10_000 }, async () => {
    // The headers come and the body never ends. Like a real fetch's, this body fails when aborted.
    const { llm, calls } = setUp(
      ({ signal }) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener('abort', () => controller.error(signal.reason));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      { deadlineMs: 300 },
    );
    await expect(llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS })).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
    expect(calls).toHaveLength(1);
  });

  it('bounds a whole call to 480 s unless told otherwise', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { llm } = setUp(() => answer('{"specs": []}'));
      await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS });
      expect(timeout).toHaveBeenCalledWith(480_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
