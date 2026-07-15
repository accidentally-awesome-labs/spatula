import { describe, it, expect } from 'vitest';
import { ConfigError } from '@accidentally-awesome-labs/spatula-shared';
import { createLLMClient } from '../../../src/llm/llm-factory.js';
import { OpenRouterClient } from '../../../src/llm/openrouter-client.js';
import { OllamaClient } from '../../../src/llm/ollama-client.js';
import type { LLMFactoryConfig } from '../../../src/llm/types.js';

describe('createLLMClient', () => {
  it('creates OpenRouterClient when provider is openrouter', () => {
    const config: LLMFactoryConfig = {
      provider: 'openrouter',
      openrouter: { apiKey: 'test-key' },
    };

    const client = createLLMClient(config);
    expect(client).toBeInstanceOf(OpenRouterClient);
  });

  it('creates OllamaClient when provider is ollama', () => {
    const config: LLMFactoryConfig = {
      provider: 'ollama',
      ollama: { baseUrl: 'http://localhost:11434' },
    };

    const client = createLLMClient(config);
    expect(client).toBeInstanceOf(OllamaClient);
  });

  it('creates OllamaClient with default options when ollama config omitted', () => {
    const config: LLMFactoryConfig = {
      provider: 'ollama',
    };

    const client = createLLMClient(config);
    expect(client).toBeInstanceOf(OllamaClient);
  });

  it('throws ConfigError for unknown provider', () => {
    const config = {
      provider: 'unknown' as any,
    };

    expect(() => createLLMClient(config)).toThrow(ConfigError);
    expect(() => createLLMClient(config)).toThrow('Unknown LLM provider');
  });

  it('throws ConfigError when openrouter selected but no API key provided', () => {
    const config: LLMFactoryConfig = {
      provider: 'openrouter',
      openrouter: { apiKey: '' },
    };

    expect(() => createLLMClient(config)).toThrow(ConfigError);
  });

  it('throws ConfigError when openrouter selected with whitespace-only API key', () => {
    const config: LLMFactoryConfig = {
      provider: 'openrouter',
      openrouter: { apiKey: '   ' },
    };

    expect(() => createLLMClient(config)).toThrow(ConfigError);
  });

  it('throws ConfigError when openrouter selected with no openrouter config', () => {
    const config: LLMFactoryConfig = {
      provider: 'openrouter',
    };

    expect(() => createLLMClient(config)).toThrow(ConfigError);
  });
});
