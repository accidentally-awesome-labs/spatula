import { buildLlmRequest, LLM_MAX_TOKENS, llmFields, SYSTEM_PROMPT } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { describe, expect, it } from 'vitest';
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

function setUp(reply: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const llm = createAnthropicLlm({
    apiKey: 'test-key',
    model: 'claude-opus-5-5',
    baseURL: 'https://gateway.example/v1/account/spatula-llm/anthropic',
    gatewayToken: 'gateway-token',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return reply();
    }) as typeof fetch,
  });
  return { llm, calls };
}

describe('createAnthropicLlm', () => {
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
});
