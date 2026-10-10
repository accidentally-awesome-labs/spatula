import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LlmPort } from '@spatula/core';

/*
 * The LLM port over Anthropic's Messages API. In a deployment, `baseURL` is the Anthropic endpoint
 * of the `spatula-llm` AI Gateway, which logs each call and records its cost; `gatewayToken`
 * authenticates to the gateway. The schema goes out as JSON Schema, and the answer is checked
 * here against the same zod schema, so an answer that doesn't fit is no answer. A refusal or an
 * answer cut off by the token limit is no answer either.
 */

/**
 * How long one attempt may take. Three attempts of 150 s, with the SDK's short backoff between
 * them, stay inside a Workflow step's 10-minute timeout. A normal extraction answer takes well
 * under a minute.
 */
export const LLM_TIMEOUT_MS = 150_000;

export function createAnthropicLlm(options: {
  apiKey: string;
  model: string;
  baseURL?: string;
  gatewayToken?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): LlmPort {
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultHeaders:
      options.gatewayToken === undefined
        ? undefined
        : { 'cf-aig-authorization': `Bearer ${options.gatewayToken}` },
    fetch: options.fetch,
    timeout: options.timeoutMs ?? LLM_TIMEOUT_MS,
    maxRetries: 2,
  });

  return {
    model: options.model,
    async structured(request) {
      // `messages.create`, not `messages.parse`: create returns the answer and its usage whatever
      // the answer is, and the local schema check decides.
      const response = await client.messages.create({
        model: options.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        output_config: { format: zodOutputFormat(request.schema) },
      });
      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      if (response.stop_reason !== 'end_turn') return { output: null, usage };
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { output: null, usage };
      }
      const checked = request.schema.safeParse(parsed);
      return { output: checked.success ? checked.data : null, usage };
    },
  };
}
