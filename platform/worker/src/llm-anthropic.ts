import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LlmPort } from '@spatula/core';
import { redact } from './llm-providers';

/*
 * The LLM port over Anthropic's Messages API. In a deployment, `baseURL` is the Anthropic endpoint
 * of the `spatula-llm` AI Gateway, which logs each call and records its cost; `gatewayToken`
 * authenticates to the gateway. The schema goes out as JSON Schema, and the answer is checked
 * here against the same zod schema, so an answer that doesn't fit is no answer. A refusal or an
 * answer cut off by the token limit is no answer either.
 */

/**
 * How long one attempt may wait for its answer. A hung attempt is cut off after 150 s and tried
 * again, and a normal extraction answer takes well under a minute.
 */
export const LLM_TIMEOUT_MS = 150_000;

/**
 * How long the whole call may take: its attempts, the waits a server asks for between them, and
 * reading the answer. The SDK's timeout ends when the response headers arrive and doesn't limit a
 * server's `retry-after`, so this is what keeps a call from outliving a Workflow step's 10-minute
 * timeout. It stops 2 minutes short, so the step can still record the failure. A step that times
 * out is killed and repeated, and a late answer is billed and thrown away.
 */
export const LLM_CALL_DEADLINE_MS = 480_000;

/** An error from the Messages API with any key it echoed replaced, and the status it carried. */
export class AnthropicCallError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'AnthropicCallError';
  }
}

export function createAnthropicLlm(options: {
  /** Absent where the gateway holds the key (ADR 0010): then no x-api-key is sent. */
  apiKey?: string;
  model: string;
  /** The model's full name, provider/model, as the run records it; the model's own name if absent. */
  name?: string;
  baseURL?: string;
  gatewayToken?: string;
  timeoutMs?: number;
  deadlineMs?: number;
  fetch?: typeof fetch;
}): LlmPort {
  const client = new Anthropic({
    // Where the gateway holds the key (ADR 0010), none is sent: a null x-api-key tells the SDK
    // that's intended, and an empty or made-up key would be forwarded and refused.
    apiKey: options.apiKey ?? null,
    baseURL: options.baseURL,
    defaultHeaders: {
      ...(options.apiKey === undefined ? { 'x-api-key': null } : {}),
      ...(options.gatewayToken === undefined
        ? {}
        : { 'cf-aig-authorization': `Bearer ${options.gatewayToken}` }),
    },
    fetch: options.fetch,
    timeout: options.timeoutMs ?? LLM_TIMEOUT_MS,
    maxRetries: 2,
  });

  return {
    model: options.name ?? options.model,
    async structured(request) {
      // `messages.create`, not `messages.parse`: create returns the answer and its usage whatever
      // the answer is, and the local schema check decides.
      const response = await client.messages
        .create(
          {
            model: options.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
            output_config: { format: zodOutputFormat(request.schema) },
          },
          // The deadline starts with the call and stays armed through retries and reading the answer.
          { signal: AbortSignal.timeout(options.deadlineMs ?? LLM_CALL_DEADLINE_MS) },
        )
        .catch((error: unknown) => {
          throw redacted(error, [options.apiKey, options.gatewayToken]);
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

/**
 * The error itself, unless its message holds a secret: then a copy without it, keeping the status.
 * The original stays as it is, so callers can still tell a timeout from an abort.
 */
function redacted(error: unknown, secrets: readonly (string | undefined)[]): unknown {
  if (!(error instanceof Error)) return error;
  const message = redact(error.message, secrets);
  if (message === error.message) return error;
  const status = (error as { status?: unknown }).status;
  return new AnthropicCallError(typeof status === 'number' ? status : null, message);
}
