import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  LLMClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  JobConfig,
  ConfigAction,
} from '@accidentally-awesome-labs/spatula-core';
import { ConfigConversationService } from '../../../src/services/config-conversation.js';
import type { ChatMessage } from '../../../src/store/index.js';

function createMockLLMClient(response?: Partial<LLMCompletionResponse>): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content: response?.content ?? '{}',
      model: response?.model ?? 'test-model',
      usage: response?.usage ?? { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: response?.finishReason ?? 'stop',
    }),
  };
}

function createMinimalConfig(): Partial<JobConfig> {
  return {
    name: '',
    description: '',
    seedUrls: [],
    schema: { mode: 'discovery' as const },
  };
}

describe('ConfigConversationService', () => {
  let service: ConfigConversationService;
  let mockLLM: LLMClient;

  beforeEach(() => {
    mockLLM = createMockLLMClient({
      content: JSON.stringify({
        response: 'I can help you set up a crawling job. What would you like to scrape?',
        actions: [],
      }),
    });
    service = new ConfigConversationService(mockLLM, 'test-model');
  });

  it('sends user message and returns parsed response with actions', async () => {
    const setNameAction = {
      type: 'set_job_name',
      id: '550e8400-e29b-41d4-a716-446655440000',
      reasoning: 'User wants to name the job',
      payload: { name: 'Product Scraper' },
    };

    mockLLM = createMockLLMClient({
      content: JSON.stringify({
        response: 'I\'ve set the job name to "Product Scraper".',
        actions: [setNameAction],
      }),
    });
    service = new ConfigConversationService(mockLLM, 'test-model');

    const result = await service.processMessage(
      'Name this job "Product Scraper"',
      createMinimalConfig() as JobConfig,
      [],
    );

    expect(result.responseText).toBe('I\'ve set the job name to "Product Scraper".');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'set_job_name',
      id: '550e8400-e29b-41d4-a716-446655440000',
      payload: { name: 'Product Scraper' },
    });
  });

  it('includes current config in system prompt', async () => {
    const config = createMinimalConfig() as JobConfig;
    config.name = 'My Job';
    config.seedUrls = ['https://example.com'];

    await service.processMessage('hello', config, []);

    const call = (mockLLM.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as LLMCompletionRequest;
    const systemMessage = call.messages.find((m) => m.role === 'system');
    expect(systemMessage).toBeDefined();
    expect(systemMessage!.content).toContain('My Job');
    expect(systemMessage!.content).toContain('https://example.com');
  });

  it('includes message history in request', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'I want to scrape products', timestamp: Date.now() - 2000 },
      { role: 'assistant', content: 'Sure, what URL?', timestamp: Date.now() - 1000 },
    ];

    await service.processMessage(
      'https://shop.example.com',
      createMinimalConfig() as JobConfig,
      history,
    );

    const call = (mockLLM.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as LLMCompletionRequest;
    // System prompt + 2 history messages + current user message = 4
    expect(call.messages).toHaveLength(4);
    expect(call.messages[1]).toEqual({ role: 'user', content: 'I want to scrape products' });
    expect(call.messages[2]).toEqual({ role: 'assistant', content: 'Sure, what URL?' });
    expect(call.messages[3]).toEqual({ role: 'user', content: 'https://shop.example.com' });
  });

  it('uses jsonMode: true', async () => {
    await service.processMessage('hello', createMinimalConfig() as JobConfig, []);

    const call = (mockLLM.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as LLMCompletionRequest;
    expect(call.jsonMode).toBe(true);
  });

  it('uses temperature: 0.3', async () => {
    await service.processMessage('hello', createMinimalConfig() as JobConfig, []);

    const call = (mockLLM.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as LLMCompletionRequest;
    expect(call.temperature).toBe(0.3);
  });

  it('uses the configured model', async () => {
    service = new ConfigConversationService(mockLLM, 'anthropic/claude-sonnet-4-20250514');

    await service.processMessage('hello', createMinimalConfig() as JobConfig, []);

    const call = (mockLLM.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as LLMCompletionRequest;
    expect(call.model).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('handles LLM returning no actions (clarifying question)', async () => {
    mockLLM = createMockLLMClient({
      content: JSON.stringify({
        response: 'Could you tell me what kind of data you want to extract?',
        actions: [],
      }),
    });
    service = new ConfigConversationService(mockLLM, 'test-model');

    const result = await service.processMessage(
      'I want to scrape some websites',
      createMinimalConfig() as JobConfig,
      [],
    );

    expect(result.responseText).toBe('Could you tell me what kind of data you want to extract?');
    expect(result.actions).toEqual([]);
  });

  it('handles malformed JSON gracefully', async () => {
    mockLLM = createMockLLMClient({
      content: 'This is not valid JSON at all {{{',
    });
    service = new ConfigConversationService(mockLLM, 'test-model');

    const result = await service.processMessage('hello', createMinimalConfig() as JobConfig, []);

    expect(result.responseText).toBeTruthy();
    expect(typeof result.responseText).toBe('string');
    expect(result.actions).toEqual([]);
  });

  it('handles LLM call failure gracefully', async () => {
    mockLLM = {
      complete: vi.fn().mockRejectedValue(new Error('Network timeout')),
    };
    service = new ConfigConversationService(mockLLM, 'test-model');

    const result = await service.processMessage('hello', createMinimalConfig() as JobConfig, []);

    expect(result.responseText).toBeTruthy();
    expect(typeof result.responseText).toBe('string');
    expect(result.actions).toEqual([]);
  });

  it('handles confirm_and_start action', async () => {
    const confirmAction = {
      type: 'confirm_and_start',
      id: '550e8400-e29b-41d4-a716-446655440001',
      reasoning: 'User confirmed the config looks good',
      payload: {},
    };

    mockLLM = createMockLLMClient({
      content: JSON.stringify({
        response: 'Great, starting the job now!',
        actions: [confirmAction],
      }),
    });
    service = new ConfigConversationService(mockLLM, 'test-model');

    const result = await service.processMessage(
      "Looks good, let's start!",
      createMinimalConfig() as JobConfig,
      [],
    );

    expect(result.responseText).toBe('Great, starting the job now!');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'confirm_and_start',
      payload: {},
    });
  });

  it('skips invalid actions but keeps valid ones', async () => {
    mockLLM = createMockLLMClient({
      content: JSON.stringify({
        response: 'Applied some settings.',
        actions: [
          {
            type: 'set_job_name',
            id: '550e8400-e29b-41d4-a716-446655440002',
            reasoning: 'Setting name',
            payload: { name: 'Valid Job' },
          },
          { garbage: true }, // no type
          {
            type: 'set_crawl_depth',
            // missing id
            payload: { maxDepth: 3 },
          },
          {
            type: 'set_concurrency',
            id: '550e8400-e29b-41d4-a716-446655440004',
            // missing reasoning
            payload: { concurrency: 10 },
          },
          {
            type: 'set_max_pages',
            id: '550e8400-e29b-41d4-a716-446655440003',
            reasoning: 'Setting max pages',
            payload: { maxPages: 500 },
          },
        ],
      }),
    });
    service = new ConfigConversationService(mockLLM, 'test-model');

    const result = await service.processMessage(
      'Configure job',
      createMinimalConfig() as JobConfig,
      [],
    );

    expect(result.responseText).toBe('Applied some settings.');
    // Only the two valid actions (with type, id, and payload) should be kept
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toMatchObject({ type: 'set_job_name' });
    expect(result.actions[1]).toMatchObject({ type: 'set_max_pages' });
  });

  it('includes ConfigAction type documentation in system prompt', async () => {
    await service.processMessage('hello', createMinimalConfig() as JobConfig, []);

    const call = (mockLLM.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as LLMCompletionRequest;
    const systemMessage = call.messages.find((m) => m.role === 'system');
    expect(systemMessage).toBeDefined();
    // Should document action types
    expect(systemMessage!.content).toContain('set_job_name');
    expect(systemMessage!.content).toContain('add_seed_urls');
    expect(systemMessage!.content).toContain('confirm_and_start');
    expect(systemMessage!.content).toContain('set_schema_mode');
  });

  it('specifies the required response format in system prompt', async () => {
    await service.processMessage('hello', createMinimalConfig() as JobConfig, []);

    const call = (mockLLM.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as LLMCompletionRequest;
    const systemMessage = call.messages.find((m) => m.role === 'system');
    expect(systemMessage).toBeDefined();
    expect(systemMessage!.content).toContain('"response"');
    expect(systemMessage!.content).toContain('"actions"');
  });

  it('handles response with missing actions field', async () => {
    mockLLM = createMockLLMClient({
      content: JSON.stringify({
        response: 'Just a text response without actions field.',
      }),
    });
    service = new ConfigConversationService(mockLLM, 'test-model');

    const result = await service.processMessage('hello', createMinimalConfig() as JobConfig, []);

    expect(result.responseText).toBe('Just a text response without actions field.');
    expect(result.actions).toEqual([]);
  });

  it('handles multiple actions in a single response', async () => {
    mockLLM = createMockLLMClient({
      content: JSON.stringify({
        response: "I've configured the job with all your settings.",
        actions: [
          {
            type: 'set_job_name',
            id: '550e8400-e29b-41d4-a716-446655440010',
            reasoning: 'User specified name',
            payload: { name: 'E-commerce Scraper' },
          },
          {
            type: 'add_seed_urls',
            id: '550e8400-e29b-41d4-a716-446655440011',
            reasoning: 'User provided URL',
            payload: { urls: [{ url: 'https://shop.example.com' }] },
          },
          {
            type: 'set_crawl_depth',
            id: '550e8400-e29b-41d4-a716-446655440012',
            reasoning: 'Default depth',
            payload: { maxDepth: 3 },
          },
        ],
      }),
    });
    service = new ConfigConversationService(mockLLM, 'test-model');

    const result = await service.processMessage(
      'Set up an e-commerce scraper for shop.example.com with depth 3',
      createMinimalConfig() as JobConfig,
      [],
    );

    expect(result.actions).toHaveLength(3);
    expect(result.actions[0]).toMatchObject({ type: 'set_job_name' });
    expect(result.actions[1]).toMatchObject({ type: 'add_seed_urls' });
    expect(result.actions[2]).toMatchObject({ type: 'set_crawl_depth' });
  });
});
