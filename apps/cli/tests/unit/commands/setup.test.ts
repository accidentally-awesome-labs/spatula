import { describe, it, expect } from 'vitest';
import { buildGlobalConfig } from '../../../src/commands/setup.js';

describe('buildGlobalConfig', () => {
  it('builds config from openrouter answers', () => {
    const config = buildGlobalConfig({
      provider: 'openrouter',
      openrouterApiKey: 'sk-test',
      model: 'anthropic/claude-sonnet-4-20250514',
      crawler: 'playwright',
    });
    expect(config.version).toBe(1);
    expect(config.openrouterApiKey).toBe('sk-test');
    expect(config.llm?.provider).toBe('openrouter');
    expect(config.llm?.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(config.crawler).toBe('playwright');
  });

  it('builds config for ollama provider', () => {
    const config = buildGlobalConfig({
      provider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      model: 'llama3.1',
      crawler: 'playwright',
    });
    expect(config.openrouterApiKey).toBeUndefined();
    expect(config.llm?.provider).toBe('ollama');
    expect(config.ollamaBaseUrl).toBe('http://localhost:11434');
  });

  it('omits empty optional fields', () => {
    const config = buildGlobalConfig({ provider: 'ollama', model: '', crawler: 'playwright' });
    expect(config.llm?.model).toBeUndefined();
  });
});
