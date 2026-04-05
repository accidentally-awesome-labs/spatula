/**
 * Tier 2 Conversation Tests — ConfigConversationService with mock Ollama.
 *
 * Validates 3-turn conversation flow and error handling without
 * requiring Playwright or any crawling infrastructure.
 */

import { describe, it, expect } from 'vitest';
import { startMockOllama, type MockOllamaServer } from './mock-ollama.js';

describe('ConfigConversationService with mock Ollama', () => {
  it('3-turn conversation produces valid config', async () => {
    let mockOllama: MockOllamaServer | undefined;

    try {
      mockOllama = await startMockOllama({ mode: 'happy' });

      const { createLLMClient } = await import('@spatula/core');
      const llmClient = createLLMClient({
        provider: 'ollama',
        ollama: { baseUrl: `http://localhost:${mockOllama.port}` },
      });

      const { ConfigConversationService } = await import(
        '../../../src/services/config-conversation.js'
      );
      const service = new ConfigConversationService(llmClient, 'llama3.2:1b');

      const { DefaultConfigExecutor } = await import('@spatula/core');
      const executor = new DefaultConfigExecutor();

      // Start with empty config
      let config = {
        tenantId: 'test',
        name: '',
        description: '',
        seedUrls: [] as string[],
        crawl: {
          maxDepth: 2,
          maxPages: 1000,
          concurrency: 5,
          crawlerType: 'playwright' as const,
        },
        schema: { mode: 'discovery' as const },
        llm: { primaryModel: 'llama3.2:1b' },
      };

      // Turn 1: User describes what they want
      const r1 = await service.processMessage(
        'I want to scrape products from example.com',
        config,
        [],
      );
      expect(r1.responseText).toBeTruthy();
      expect(r1.actions.length).toBeGreaterThan(0);
      config = executor.applyBatch(config, r1.actions);

      // Turn 2: User adds a field
      const r2 = await service.processMessage(
        'also track the brand',
        config,
        [
          { role: 'user' as const, content: 'I want to scrape products from example.com' },
          { role: 'assistant' as const, content: r1.responseText },
        ],
      );
      expect(r2.actions.length).toBeGreaterThan(0);
      config = executor.applyBatch(config, r2.actions);

      // Turn 3: User confirms
      const r3 = await service.processMessage(
        'looks good, start',
        config,
        [
          { role: 'user' as const, content: 'I want to scrape products from example.com' },
          { role: 'assistant' as const, content: r1.responseText },
          { role: 'user' as const, content: 'also track the brand' },
          { role: 'assistant' as const, content: r2.responseText },
        ],
      );

      // Verify config has expected values after turns 1-2
      expect(config.name).toBeTruthy();
      expect(config.seedUrls.length).toBeGreaterThan(0);

      // Verify the confirm_and_start action from turn 3
      const confirmAction = r3.actions.find(
        (a: { type: string }) => a.type === 'confirm_and_start',
      );
      expect(confirmAction).toBeDefined();
    } finally {
      if (mockOllama) await mockOllama.close();
    }
  }, 30_000);

  it('handles LLM error gracefully in conversation', async () => {
    let mockOllama: MockOllamaServer | undefined;

    try {
      mockOllama = await startMockOllama({
        mode: 'malformed-json',
        failOnComponent: 'conversation',
        failOnNthCall: 1,
      });

      const { createLLMClient } = await import('@spatula/core');
      const llmClient = createLLMClient({
        provider: 'ollama',
        ollama: { baseUrl: `http://localhost:${mockOllama.port}` },
      });

      const { ConfigConversationService } = await import(
        '../../../src/services/config-conversation.js'
      );
      const service = new ConfigConversationService(llmClient, 'llama3.2:1b');

      const config = {
        tenantId: 'test',
        name: '',
        description: '',
        seedUrls: [] as string[],
        crawl: {
          maxDepth: 2,
          maxPages: 1000,
          concurrency: 5,
          crawlerType: 'playwright' as const,
        },
        schema: { mode: 'discovery' as const },
        llm: { primaryModel: 'llama3.2:1b' },
      };

      const result = await service.processMessage('hello', config, []);

      // Should return an error message, not crash
      expect(result.responseText).toBeTruthy();
      expect(result.actions).toHaveLength(0);
    } finally {
      if (mockOllama) await mockOllama.close();
    }
  }, 30_000);
});
