import { ConfigError } from '@accidentally-awesome-labs/spatula-shared';
import type { LLMClient } from '../interfaces/llm-client.js';
import type { LLMFactoryConfig } from './types.js';
import { OpenRouterClient } from './openrouter-client.js';
import { OllamaClient } from './ollama-client.js';

/**
 * Create an LLM client based on provider configuration.
 * Supports OpenRouter (cloud) and Ollama (local).
 */
export function createLLMClient(config: LLMFactoryConfig): LLMClient {
  switch (config.provider) {
    case 'openrouter': {
      const apiKey = config.openrouter?.apiKey?.trim();
      if (!apiKey) {
        throw new ConfigError(
          'OpenRouter API key is required when provider is "openrouter". ' +
            'Set OPENROUTER_API_KEY or use provider "ollama" for local inference.',
        );
      }
      return new OpenRouterClient({
        apiKey,
        baseUrl: config.openrouter?.baseUrl,
        maxRetries: config.openrouter?.maxRetries,
        timeoutMs: config.openrouter?.timeoutMs,
      });
    }

    case 'ollama':
      return new OllamaClient({
        baseUrl: config.ollama?.baseUrl,
        timeoutMs: config.ollama?.timeoutMs,
      });

    default:
      throw new ConfigError(`Unknown LLM provider: ${config.provider}`);
  }
}
