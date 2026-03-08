import { describe, it, expect } from 'vitest';
import * as interfaces from '../../../src/interfaces/index.js';
import type { LLMClient, LLMCompletionRequest, LLMCompletionResponse, LLMMessage, LLMUsage } from '../../../src/interfaces/llm-client.js';

describe('core interfaces are exported', () => {
  const expectedExports = [
    'CrawlResult',
    'CrawlOptions',
    'ExportOptions',
    'ExportResult',
    'ExportFormat',
    'ActionResult',
    'ActionPreview',
    'StateChange',
    'ConfigValidationResult',
    'ConfigDiff',
  ];

  for (const name of expectedExports) {
    it(`exports ${name}`, () => {
      expect((interfaces as Record<string, unknown>)[name]).toBeDefined();
    });
  }
});

describe('LLMClient interface', () => {
  it('can be implemented with complete method', () => {
    const mockClient: LLMClient = {
      complete: async (request: LLMCompletionRequest): Promise<LLMCompletionResponse> => {
        return {
          content: 'test',
          model: request.model,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        };
      },
    };
    expect(mockClient.complete).toBeDefined();
  });

  it('accepts all message roles', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    expect(messages).toHaveLength(3);
  });

  it('LLMUsage tracks token counts', () => {
    const usage: LLMUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };
    expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
  });
});
