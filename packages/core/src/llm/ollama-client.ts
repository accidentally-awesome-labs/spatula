import { LLMError, TimeoutError } from '@spatula/shared';
import type {
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
} from '../interfaces/llm-client.js';
import type { OllamaClientOptions } from './types.js';

interface OllamaChatResponse {
  message: { content: string };
  model: string;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * LLM client for Ollama (local, free, offline).
 *
 * No retries: Ollama runs on localhost — if fetch fails, the server is
 * down, not temporarily overloaded. Retrying adds latency with zero benefit.
 */
export class OllamaClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options?: OllamaClientOptions) {
    this.baseUrl = options?.baseUrl ?? 'http://localhost:11434';
    this.timeoutMs = options?.timeoutMs ?? 120_000;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false,
      options: {
        temperature: request.temperature ?? 0.1,
        num_predict: request.maxTokens ?? 4096,
      },
    };

    if (request.jsonMode) {
      body.format = 'json';
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new LLMError(`Ollama request failed: ${response.status}`, {
          context: { status: response.status, model: request.model },
        });
      }

      const data = (await response.json()) as OllamaChatResponse;

      return {
        content: data.message.content,
        model: data.model,
        usage: {
          promptTokens: data.prompt_eval_count ?? 0,
          completionTokens: data.eval_count ?? 0,
          totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        },
        finishReason: data.done ? 'stop' : 'length',
      };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      // AbortSignal.timeout() throws a DOMException with name 'TimeoutError'
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new TimeoutError(`Ollama request timed out after ${this.timeoutMs}ms`, {
          context: { model: request.model, baseUrl: this.baseUrl },
        });
      }
      throw new LLMError(`Ollama completion failed: ${(error as Error).message}`, {
        cause: error as Error,
        context: { model: request.model, baseUrl: this.baseUrl },
      });
    }
  }
}
