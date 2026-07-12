import { LLMError } from '@spatula/shared';
import { createLogger, sleep } from '@spatula/shared';
import type {
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMUsageRecorder,
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
    // Actual cost in OpenRouter credits (1 credit = 1 USD). Always included for
    // non-streaming responses; no request opt-in needed.
    cost?: number;
  };
}

export class OpenRouterClient implements LLMClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly siteName: string;
  private readonly siteUrl: string;
  private usageRecorder?: LLMUsageRecorder;

  constructor(options: OpenRouterClientOptions) {
    if (!options.apiKey?.trim()) {
      throw new LLMError('OpenRouter API key is required');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.siteName = options.siteName ?? 'Spatula';
    this.siteUrl = options.siteUrl ?? 'https://spatula.dev';
  }

  setUsageRecorder(recorder: LLMUsageRecorder): void {
    this.usageRecorder = recorder;
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
        const start = performance.now();
        const response = await this.doFetch(body);
        const data = (await response.json()) as OpenRouterAPIResponse;
        const duration = performance.now() - start;
        // OpenRouter reports the real USD cost in the response body (usage.cost,
        // in credits = USD) — always present for non-streaming requests. The old
        // header read ('x-openrouter-cost') was a non-existent header, so every
        // recorded cost was $0 regardless of model (llm_usage cost / sizing dead).
        const costUsd = data.usage?.cost ?? 0;

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

        // Record usage (fire-and-forget)
        if (this.usageRecorder) {
          this.usageRecorder.record({
            model: result.model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            costUsd,
            durationMs: duration,
          });
        }

        return result;
      } catch (error) {
        lastError = error as Error;

        if (this.isRetryable(lastError)) {
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
