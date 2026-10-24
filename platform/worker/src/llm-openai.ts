import type { LlmPort } from '@spatula/core';
import { z } from 'zod';
import { LLM_CALL_DEADLINE_MS, LLM_TIMEOUT_MS } from './llm-anthropic';
import { redact } from './llm-providers';

export { redact };

/*
 * The LLM port over OpenAI's Chat Completions format, which OpenAI, OpenRouter, Cerebras, and Groq
 * speak, through their routes in the `spatula-llm` AI Gateway (ADR 0010). The schema goes out as
 * JSON Schema, strict where OpenAI's strict mode takes it, and the answer is checked here against
 * the same zod schema, so an answer that doesn't fit is no answer. So is a refusal, and an answer
 * that stopped for any reason but its end. A 429 or a 5xx is tried twice more, honouring
 * retry-after, all within the call's deadline; anything else fails at once. An error names the
 * status and the provider's message, cut short, with any key it echoes replaced.
 */

/** An HTTP error from a model's API: its status, and the provider's message without headers. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

const RETRIES = 2;
const MESSAGE_MAX = 300;
/** A 429 that is a quota, not a rate: it won't pass, so it isn't tried again. */
const QUOTA = /quota|credit|billing/iu;

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }),
      }),
    )
    .min(1),
  usage: z
    .object({ prompt_tokens: z.number().int().min(0), completion_tokens: z.number().int().min(0) })
    .optional(),
});

export function createOpenAiLlm(options: {
  /** The model's full name, provider/model, as the run records it. */
  name: string;
  /** The provider's own name for it. */
  model: string;
  /** The chat completions address, under the gateway. */
  url: string;
  /** Absent where the gateway supplies the key (ADR 0010): then no Authorization is sent. */
  apiKey?: string;
  gatewayToken?: string;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  extra?: Record<string, unknown>;
  timeoutMs?: number;
  deadlineMs?: number;
  fetch?: typeof fetch;
  /** Waits between attempts, ended early by the deadline; the tests pass one that doesn't wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): LlmPort {
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const secrets = [options.apiKey, options.gatewayToken];
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;
  if (options.gatewayToken !== undefined) {
    headers['cf-aig-authorization'] = `Bearer ${options.gatewayToken}`;
  }
  return {
    model: options.name,
    async structured(request) {
      const { schema, strict } = jsonSchemaFor(request.schema);
      // The extras come first, so none can replace the model, the messages, or the format.
      const body = JSON.stringify({
        ...options.extra,
        model: options.model,
        [options.maxTokensField ?? 'max_completion_tokens']: request.maxTokens,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', schema, ...(strict ? { strict: true } : {}) },
        },
      });
      // The deadline starts with the call and covers its attempts, its waits, and its answer.
      const deadline = AbortSignal.timeout(options.deadlineMs ?? LLM_CALL_DEADLINE_MS);
      let text: string;
      for (let attempt = 0; ; attempt += 1) {
        const signal = AbortSignal.any([
          deadline,
          AbortSignal.timeout(options.timeoutMs ?? LLM_TIMEOUT_MS),
        ]);
        let response: Response;
        try {
          response = await send(options.url, { method: 'POST', headers, body, signal });
        } catch (error) {
          if (deadline.aborted || attempt >= RETRIES)
            throw deadline.aborted ? deadline.reason : error;
          await sleep(backoff(attempt), deadline);
          continue;
        }
        if (response.ok) {
          text = await response.text();
          break;
        }
        const message = await errorMessage(response, secrets);
        const retryable =
          response.status >= 500 || (response.status === 429 && !QUOTA.test(message));
        if (!retryable || attempt >= RETRIES) {
          throw new LlmHttpError(response.status, `${response.status} ${message}`);
        }
        await sleep(
          retryAfterMs(response.headers.get('retry-after')) ?? backoff(attempt),
          deadline,
        );
      }
      let parsed: z.output<typeof completionSchema>;
      try {
        parsed = completionSchema.parse(JSON.parse(text));
      } catch {
        return { output: null, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      const usage = {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
      };
      const [choice] = parsed.choices;
      const content = choice?.message.content;
      if (
        choice?.finish_reason !== 'stop' ||
        choice.message.refusal ||
        typeof content !== 'string'
      ) {
        return { output: null, usage };
      }
      let answer: unknown;
      try {
        answer = JSON.parse(content);
      } catch {
        return { output: null, usage };
      }
      const checked = request.schema.safeParse(answer);
      return { output: checked.success ? checked.data : null, usage };
    },
  };
}

/**
 * A zod schema as the JSON Schema a chat request sends, and whether OpenAI's strict mode takes it:
 * every object lists all its properties as required. Objects allow no other properties, which
 * changes nothing, since zod drops what it doesn't know.
 */
export function jsonSchemaFor(schema: z.ZodType): {
  schema: Record<string, unknown>;
  strict: boolean;
} {
  const made = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  delete made.$schema;
  return { schema: made, strict: closeObjects(made) };
}

/** Sets additionalProperties: false on every object, and says whether each requires all its properties. */
function closeObjects(node: unknown): boolean {
  if (Array.isArray(node)) return node.map(closeObjects).every(Boolean);
  if (node === null || typeof node !== 'object') return true;
  const record = node as Record<string, unknown>;
  let strict = true;
  if (record.type === 'object' && record.properties !== undefined) {
    record.additionalProperties = false;
    const required = new Set(Array.isArray(record.required) ? record.required : []);
    strict = Object.keys(record.properties as object).every((key) => required.has(key));
  }
  for (const value of Object.values(record)) strict = closeObjects(value) && strict;
  return strict;
}

/** The provider's message, from OpenAI's error shape or the body's text, on one line, cut short. */
async function errorMessage(
  response: Response,
  secrets: readonly (string | undefined)[],
): Promise<string> {
  const body = await response.text().catch(() => '');
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') message = parsed.error.message;
  } catch {
    // Not JSON: a gateway's or a proxy's page. Its text is cut below.
  }
  // Redacted before it is cut, so a key can't be left half-shown at the cut.
  return (
    redact(message.replace(/\s+/gu, ' ').trim(), secrets).slice(0, MESSAGE_MAX) ||
    response.statusText
  );
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt;
}

/** retry-after in seconds, or as a date, in ms; null when absent or unreadable. */
function retryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
