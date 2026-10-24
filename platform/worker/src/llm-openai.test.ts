import { buildLlmRequest, LLM_MAX_TOKENS, llmFields, SYSTEM_PROMPT } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOpenAiLlm, jsonSchemaFor, LlmHttpError } from './llm-openai';
import { gatewayBase, PROVIDERS } from './llm-providers';

const product = testDefinition().recordTypes.product!;
const question = buildLlmRequest({
  url: 'https://maker-a.example/products/a1',
  text: 'A1 Impedance: 300 Ω',
  fields: llmFields(product, ['specs']),
});

function completion(content: string | null, finish = 'stop', refusal: string | null = null) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      choices: [
        { index: 0, finish_reason: finish, message: { role: 'assistant', content, refusal } },
      ],
      usage: { prompt_tokens: 900, completion_tokens: 40 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function setUp(
  reply: (init: RequestInit, attempt: number) => Response | Promise<Response>,
  more: Partial<Parameters<typeof createOpenAiLlm>[0]> = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const llm = createOpenAiLlm({
    name: 'openrouter/deepseek/deepseek-v4-flash',
    model: 'deepseek/deepseek-v4-flash',
    url: 'https://gateway.example/v1/account/spatula-llm/openrouter/v1/chat/completions',
    apiKey: 'sk-test',
    gatewayToken: 'gateway-token',
    maxTokensField: 'max_tokens',
    extra: PROVIDERS.openrouter!.extra,
    sleep: async () => {},
    ...more,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return reply(init ?? {}, calls.length);
    }) as typeof fetch,
  });
  return { llm, calls };
}

describe('createOpenAiLlm', () => {
  it('asks through the gateway with a strict schema, and returns the checked answer and its usage', async () => {
    const specs = [{ label: 'Impedance', value: '300 Ω' }];
    const { llm, calls } = setUp(() => completion(JSON.stringify({ specs })));
    expect(llm.model).toBe('openrouter/deepseek/deepseek-v4-flash');
    expect(await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS })).toEqual({
      output: { specs },
      usage: { inputTokens: 900, outputTokens: 40 },
    });
    const [call] = calls;
    expect(call!.url).toBe(
      'https://gateway.example/v1/account/spatula-llm/openrouter/v1/chat/completions',
    );
    const headers = new Headers(call!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-test');
    expect(headers.get('cf-aig-authorization')).toBe('Bearer gateway-token');
    const body = JSON.parse(String(call!.init.body));
    expect(body).toMatchObject({
      model: 'deepseek/deepseek-v4-flash',
      max_tokens: LLM_MAX_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question.user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } },
      provider: { data_collection: 'deny', require_parameters: true },
    });
    expect(body.response_format.json_schema.schema).not.toHaveProperty('$schema');
  });

  it('sends no provider key where the gateway holds it', async () => {
    const { llm, calls } = setUp(() => completion('{"specs":[]}'), { apiKey: undefined });
    await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS });
    expect(new Headers(calls[0]!.init.headers).has('authorization')).toBe(false);
  });

  it('returns no answer for a refusal, a cut-off answer, bad JSON, or one that doesn’t fit', async () => {
    for (const reply of [
      () => completion('{"specs":[]}', 'length'),
      () => completion(null, 'stop', 'I can’t help with that.'),
      () => completion('not json'),
      () => completion(JSON.stringify({ specs: [{ label: 'Impedance' }] })),
    ]) {
      const { llm } = setUp(reply);
      const answer = await llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS });
      expect(answer.output).toBeNull();
      expect(answer.usage).toEqual({ inputTokens: 900, outputTokens: 40 });
    }
  });

  it('tries a 429 or a 5xx twice more, then fails with the status', async () => {
    const { llm, calls } = setUp(
      () => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 }),
    );
    const failure = await llm
      .structured({ ...question, maxTokens: LLM_MAX_TOKENS })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(LlmHttpError);
    expect(failure).toMatchObject({ status: 429, message: '429 Rate limit reached' });
    expect(calls).toHaveLength(3);

    const flaky = setUp((_init, attempt) =>
      attempt === 1 ? new Response('upstream', { status: 503 }) : completion('{"specs":[]}'),
    );
    expect((await flaky.llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS })).output).toEqual(
      { specs: [] },
    );
  });

  it('doesn’t retry what won’t pass: a quota, a refused key, a bad request', async () => {
    for (const [status, body] of [
      [429, '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}'],
      [401, '{"error":{"message":"Incorrect API key provided"}}'],
      [400, '{"error":{"message":"Invalid schema"}}'],
    ] as const) {
      const { llm, calls } = setUp(() => new Response(body, { status }));
      await expect(
        llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS }),
      ).rejects.toMatchObject({ status });
      expect(calls).toHaveLength(1);
    }
  });

  it('redacts keys and cuts long error bodies', async () => {
    const page = `<html>${'Bad gateway '.repeat(200)} Bearer sk-test gateway-token</html>`;
    const { llm } = setUp(() => new Response(page, { status: 502 }));
    const failure = await llm
      .structured({ ...question, maxTokens: LLM_MAX_TOKENS })
      .catch((error) => error);
    expect(failure.message.length).toBeLessThanOrEqual(320);
    expect(failure.message).not.toContain('sk-test');
    expect(failure.message).not.toContain('gateway-token');
  });

  it('gives up at its deadline during a long retry-after', { timeout: 10_000 }, async () => {
    const { llm, calls } = setUp(
      () =>
        new Response('{"error":{"message":"Slow down"}}', {
          status: 429,
          headers: { 'retry-after': '900' },
        }),
      { deadlineMs: 300, sleep: undefined },
    );
    await expect(llm.structured({ ...question, maxTokens: LLM_MAX_TOKENS })).rejects.toHaveProperty(
      'name',
      'TimeoutError',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('jsonSchemaFor', () => {
  it('is strict for an object whose every property is required', () => {
    const made = jsonSchemaFor(
      z.object({ a: z.string(), b: z.array(z.object({ c: z.number() })) }),
    );
    expect(made.strict).toBe(true);
    expect(made.schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('is not strict when a property is optional', () => {
    expect(jsonSchemaFor(z.object({ a: z.string().optional() })).strict).toBe(false);
  });
});

describe('gatewayBase', () => {
  it('drops a trailing /anthropic and slashes, so the secret keeps its value', () => {
    expect(gatewayBase('https://gateway.ai.cloudflare.com/v1/acct/spatula-llm/anthropic')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/spatula-llm',
    );
    expect(gatewayBase('https://gateway.ai.cloudflare.com/v1/acct/spatula-llm/')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/spatula-llm',
    );
  });
});
