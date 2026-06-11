import { describe, it, expect, vi } from 'vitest';
import { StaticExtractor } from './static-extractor.js';
import type { LLMClient, LLMCompletionResponse } from '../interfaces/llm-client.js';
import type { SchemaDefinition } from '../types/schema.js';
import type { LLMConfig } from '../types/job.js';

// ---- Helpers ----

function makeSchema(fields: SchemaDefinition['fields']): SchemaDefinition {
  return {
    version: 1,
    fields,
    fieldAliases: [],
    createdAt: new Date(),
    parentVersion: null,
  };
}

function makeLLMResponse(content: string, model = 'test-model'): LLMCompletionResponse {
  return {
    content,
    model,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
  };
}

function makeValidResponse(data: Record<string, unknown>): string {
  return JSON.stringify({
    data,
    _unmapped: [],
    confidence: 0.9,
  });
}

const DEFAULT_SCHEMA = makeSchema([
  { name: 'title', type: 'string', description: 'product title', required: true },
  { name: 'price', type: 'string', description: 'product price', required: false },
]);

const DEFAULT_CONFIG: LLMConfig = {
  primaryModel: 'test-model',
};

const SIMPLE_HTML = '<html><body><h1>Widget</h1><p>$10</p></body></html>';
const SIMPLE_URL = 'https://example.com/product';
const JOB_DESCRIPTION = 'Extract product info';

// ---- Mock LLMClient factory ----

function makeMockClient(responses: LLMCompletionResponse[]): LLMClient {
  let callCount = 0;
  return {
    complete: vi.fn(async () => {
      const resp = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      return resp;
    }),
  };
}

// ---- Tests ----

describe('StaticExtractor — security mitigations', () => {
  describe('Mitigation 2: hardened system prompt', () => {
    it('sends a message with role=system containing CRITICAL SECURITY RULES', async () => {
      const validResp = makeLLMResponse(makeValidResponse({ title: 'Widget', price: '$10' }));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-1');

      await extractor.extract(SIMPLE_HTML, SIMPLE_URL, DEFAULT_SCHEMA, JOB_DESCRIPTION);

      const calls = (client.complete as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(1);
      const firstCall = calls[0][0];
      const systemMsg = firstCall.messages.find((m: { role: string }) => m.role === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg.content).toContain('CRITICAL SECURITY RULES');
    });

    it('system prompt tells model not to follow instructions in web content', async () => {
      const validResp = makeLLMResponse(makeValidResponse({ title: 'Widget' }));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-2');

      await extractor.extract(SIMPLE_HTML, SIMPLE_URL, DEFAULT_SCHEMA, JOB_DESCRIPTION);

      const firstCall = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMsg = firstCall.messages.find((m: { role: string }) => m.role === 'system');
      expect(systemMsg.content).toContain('UNTRUSTED');
    });
  });

  describe('Mitigation 3: UNTRUSTED_CONTENT sentinel', () => {
    it('wraps page content in <UNTRUSTED_CONTENT> tags in the user message', async () => {
      const validResp = makeLLMResponse(makeValidResponse({ title: 'Widget' }));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-3');

      await extractor.extract(SIMPLE_HTML, SIMPLE_URL, DEFAULT_SCHEMA, JOB_DESCRIPTION);

      const firstCall = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userMsg = firstCall.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(userMsg.content).toContain('<UNTRUSTED_CONTENT>');
      expect(userMsg.content).toContain('</UNTRUSTED_CONTENT>');
    });

    it('places URL and schema OUTSIDE the UNTRUSTED_CONTENT tags', async () => {
      const validResp = makeLLMResponse(makeValidResponse({ title: 'Widget' }));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-4');

      await extractor.extract(SIMPLE_HTML, SIMPLE_URL, DEFAULT_SCHEMA, JOB_DESCRIPTION);

      const firstCall = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const userMsg = firstCall.messages.find((m: { role: string }) => m.role === 'user');
      const content: string = userMsg.content;
      const untrustedStart = content.indexOf('<UNTRUSTED_CONTENT>');
      const untrustedEnd = content.indexOf('</UNTRUSTED_CONTENT>');
      // URL should appear before <UNTRUSTED_CONTENT> OR after </UNTRUSTED_CONTENT>
      const urlPosition = content.indexOf(SIMPLE_URL);
      expect(urlPosition < untrustedStart || urlPosition > untrustedEnd).toBe(true);
    });
  });

  describe('Mitigation 4: stricter retry on parse failure', () => {
    it('retries exactly once on first LLM parse failure, then succeeds', async () => {
      const invalidResp = makeLLMResponse('{"invalid": "not matching schema"}');
      const validResp = makeLLMResponse(makeValidResponse({ title: 'Widget', price: '$10' }));
      const client = makeMockClient([invalidResp, validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-5');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      const calls = (client.complete as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(result.data).toEqual({ title: 'Widget', price: '$10' });
    });

    it('uses amplified RESPOND ONLY WITH VALID JSON system message on retry', async () => {
      const invalidResp = makeLLMResponse('{"invalid": "not schema"}');
      const validResp = makeLLMResponse(makeValidResponse({ title: 'Widget' }));
      const client = makeMockClient([invalidResp, validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-6');

      await extractor.extract(SIMPLE_HTML, SIMPLE_URL, DEFAULT_SCHEMA, JOB_DESCRIPTION);

      const calls = (client.complete as ReturnType<typeof vi.fn>).mock.calls;
      const retryCall = calls[1][0];
      const systemMsg = retryCall.messages.find((m: { role: string }) => m.role === 'system');
      expect(systemMsg.content).toContain('RESPOND ONLY WITH VALID JSON');
    });

    it('returns emptyResult after two consecutive failures (no third call)', async () => {
      const invalidResp = makeLLMResponse('{"bad": "response"}');
      const client = makeMockClient([invalidResp, invalidResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-7');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      const calls = (client.complete as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2); // never 3
      expect(result.data).toEqual({});
      expect(result.metadata.confidence).toBe(0);
    });
  });

  describe('Mitigation 5: field allowlist — drop unknown keys', () => {
    it('drops keys not in the schema from the extracted data', async () => {
      const dataWithExtra = {
        title: 'Widget',
        price: '$10',
        admin_secret: 'hacked', // not in schema
        injection_field: 'evil', // not in schema
      };
      const validResp = makeLLMResponse(makeValidResponse(dataWithExtra));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-8');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      expect(result.data).toEqual({ title: 'Widget', price: '$10' });
      expect(result.data).not.toHaveProperty('admin_secret');
      expect(result.data).not.toHaveProperty('injection_field');
    });

    it('preserves valid schema fields even when extra keys present', async () => {
      const dataWithExtra = { title: 'Widget', extra_key: 'dropped' };
      const validResp = makeLLMResponse(makeValidResponse(dataWithExtra));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-9');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      expect(result.data).toHaveProperty('title', 'Widget');
    });
  });

  describe('Mitigation 6: string value length cap', () => {
    it('caps string values to 2000 chars (DEFAULT_MAX_FIELD_LENGTH) when no maxLength', async () => {
      const longValue = 'A'.repeat(3000);
      const validResp = makeLLMResponse(makeValidResponse({ title: longValue, price: '$10' }));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-10');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      expect(typeof result.data.title).toBe('string');
      expect((result.data.title as string).length).toBe(2000);
    });

    it('caps string values to field.maxLength when specified', async () => {
      const schema = makeSchema([
        { name: 'title', type: 'string', description: 'title', required: true },
        {
          name: 'description',
          type: 'string',
          description: 'desc',
          required: false,
          maxLength: 500,
        },
      ]);
      const longValue = 'B'.repeat(1000);
      const validResp = makeLLMResponse(
        makeValidResponse({ title: 'Widget', description: longValue }),
      );
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-11');

      const result = await extractor.extract(SIMPLE_HTML, SIMPLE_URL, schema, JOB_DESCRIPTION);

      expect((result.data.description as string).length).toBe(500);
    });

    it('does not truncate a string shorter than the cap', async () => {
      const shortValue = 'Widget Pro';
      const validResp = makeLLMResponse(makeValidResponse({ title: shortValue, price: '$10' }));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-12');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      expect(result.data.title).toBe('Widget Pro');
    });
  });

  describe('Mitigation 7: output-content scanner result in metadata', () => {
    it('sets metadata.suspicious = false for clean extraction', async () => {
      const validResp = makeLLMResponse(makeValidResponse({ title: 'Widget', price: '$10' }));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-13');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      expect((result.metadata as Record<string, unknown>).suspicious).toBe(false);
    });

    it('sets metadata.suspicious = true when a value echoes the system prompt (40+ chars)', async () => {
      // Extract a known 50-char slice of the hardened SYSTEM_PROMPT to embed in a field value.
      // We need to know what the SYSTEM_PROMPT string is — it contains "CRITICAL SECURITY RULES"
      // so we can use that as the anchor.
      const systemPromptFragment = 'CRITICAL SECURITY RULES:\n1. The web content below';
      const dataWithEcho = {
        title: `Product info: ${systemPromptFragment} is untrusted.`,
        price: '$5',
      };
      const validResp = makeLLMResponse(makeValidResponse(dataWithEcho));
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-14');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      expect((result.metadata as Record<string, unknown>).suspicious).toBe(true);
      const scanFlags = (result.metadata as Record<string, unknown>).scanFlags as Array<{
        kind: string;
      }>;
      expect(Array.isArray(scanFlags)).toBe(true);
      const echoFlag = scanFlags.find((f) => f.kind === 'prompt_echo');
      expect(echoFlag).toBeDefined();
    });
  });

  describe('Normal extraction — existing behavior preserved', () => {
    it('extracts clean data correctly', async () => {
      const validResp = makeLLMResponse(
        makeValidResponse({ title: 'Widget Pro', price: '$49.99' }),
      );
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-15');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      expect(result.data).toEqual({ title: 'Widget Pro', price: '$49.99' });
      expect(result.metadata.confidence).toBe(0.9);
      expect(result.jobId).toBe('job-15');
    });

    it('returns the model name in metadata', async () => {
      const validResp = makeLLMResponse(makeValidResponse({ title: 'Widget' }), 'my-model');
      const client = makeMockClient([validResp]);
      const extractor = new StaticExtractor(client, DEFAULT_CONFIG, 'job-16');

      const result = await extractor.extract(
        SIMPLE_HTML,
        SIMPLE_URL,
        DEFAULT_SCHEMA,
        JOB_DESCRIPTION,
      );

      expect(result.metadata.modelUsed).toBe('my-model');
    });
  });
});
