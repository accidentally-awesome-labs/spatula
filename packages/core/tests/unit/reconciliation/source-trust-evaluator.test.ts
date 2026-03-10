import { describe, it, expect, vi } from 'vitest';
import { SourceTrustEvaluator } from '../../../src/reconciliation/source-trust-evaluator.js';
import type { LLMClient } from '../../../src/interfaces/llm-client.js';
import type { PipelineAction } from '../../../src/types/actions.js';

// ---------------------------------------------------------------------------
// Mock helper
// ---------------------------------------------------------------------------

function createMockClient(content: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: 'test-model',
      usage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
      finishReason: 'stop',
    }),
  };
}

const defaultLLMConfig = {
  primaryModel: 'anthropic/claude-sonnet-4-20250514',
};

// ---------------------------------------------------------------------------
// evaluate() — LLM-powered
// ---------------------------------------------------------------------------

describe('SourceTrustEvaluator.evaluate', () => {
  it('returns a set_source_trust action with rankings from LLM', async () => {
    const llmResponse = JSON.stringify({
      rankings: [
        {
          domain: 'amazon.com',
          trustLevel: 'authoritative',
          reasoning: 'Major e-commerce platform with verified product data',
        },
        {
          domain: 'blog.example.com',
          trustLevel: 'low',
          reasoning: 'User blog with unverified information',
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = await evaluator.evaluate(
      ['amazon.com', 'blog.example.com'],
      'Collect product pricing data',
    );

    expect(actions).toHaveLength(1);
    const action = actions[0] as PipelineAction & { type: 'set_source_trust' };
    expect(action.type).toBe('set_source_trust');
    expect(action.source).toBe('reconciliation');
    expect(action.payload.rankings).toHaveLength(2);
    expect(action.payload.rankings[0].domain).toBe('amazon.com');
    expect(action.payload.rankings[0].trustLevel).toBe('authoritative');
    expect(action.payload.rankings[1].domain).toBe('blog.example.com');
    expect(action.payload.rankings[1].trustLevel).toBe('low');
    expect(action.id).toBeDefined();
    expect(action.confidence).toBe(1);
  });

  it('returns empty array on LLM error', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM service unavailable')),
    };
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = await evaluator.evaluate(['amazon.com'], 'Collect product data');

    expect(actions).toEqual([]);
  });

  it('returns empty array on invalid JSON', async () => {
    const client = createMockClient('this is not valid JSON');
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = await evaluator.evaluate(['amazon.com'], 'Collect product data');

    expect(actions).toEqual([]);
  });

  it('returns empty array on wrong Zod shape', async () => {
    const client = createMockClient(JSON.stringify({ wrongField: 'not the right schema' }));
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = await evaluator.evaluate(['amazon.com'], 'Collect product data');

    expect(actions).toEqual([]);
  });

  it('includes domains and jobDescription in the LLM prompt', async () => {
    const llmResponse = JSON.stringify({
      rankings: [
        {
          domain: 'shop.example.com',
          trustLevel: 'medium',
          reasoning: 'Generic shop',
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    await evaluator.evaluate(
      ['shop.example.com', 'reviews.example.com'],
      'Collect electronics pricing data',
    );

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMessage = call.messages.find((m: { role: string }) => m.role === 'user');

    expect(userMessage.content).toContain('shop.example.com');
    expect(userMessage.content).toContain('reviews.example.com');
    expect(userMessage.content).toContain('Collect electronics pricing data');
  });

  it('uses jsonMode, temperature 0, and scales maxTokens with domain count', async () => {
    const llmResponse = JSON.stringify({
      rankings: [
        {
          domain: 'example.com',
          trustLevel: 'medium',
          reasoning: 'Generic source',
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    await evaluator.evaluate(['example.com'], 'Test job');

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.jsonMode).toBe(true);
    expect(call.temperature).toBe(0);
    expect(call.maxTokens).toBe(2048); // Math.max(2048, 1 * 200) = 2048
  });

  it('returns empty array for empty domains without calling LLM', async () => {
    const client = createMockClient('');
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = await evaluator.evaluate([], 'Collect product data');

    expect(actions).toEqual([]);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('returns empty array when rankings contain invalid trust level', async () => {
    const llmResponse = JSON.stringify({
      rankings: [
        {
          domain: 'example.com',
          trustLevel: 'super_high', // invalid enum value
          reasoning: 'Made up trust level',
        },
      ],
    });

    const client = createMockClient(llmResponse);
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = await evaluator.evaluate(['example.com'], 'Collect data');

    expect(actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// evaluateWithPriority() — non-LLM
// ---------------------------------------------------------------------------

describe('SourceTrustEvaluator.evaluateWithPriority', () => {
  it('first domain gets authoritative, second gets high, rest get medium', () => {
    const client = createMockClient('');
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = evaluator.evaluateWithPriority(
      ['amazon.com', 'bestbuy.com', 'walmart.com', 'random.com'],
      ['amazon.com', 'bestbuy.com', 'walmart.com'],
    );

    expect(actions).toHaveLength(1);
    const action = actions[0] as PipelineAction & { type: 'set_source_trust' };
    expect(action.type).toBe('set_source_trust');
    expect(action.source).toBe('reconciliation');

    const rankingMap = new Map(action.payload.rankings.map((r) => [r.domain, r.trustLevel]));

    expect(rankingMap.get('amazon.com')).toBe('authoritative');
    expect(rankingMap.get('bestbuy.com')).toBe('high');
    expect(rankingMap.get('walmart.com')).toBe('medium');
    expect(rankingMap.get('random.com')).toBe('medium');
  });

  it('domains not in priority list get medium', () => {
    const client = createMockClient('');
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = evaluator.evaluateWithPriority(
      ['known.com', 'unknown1.com', 'unknown2.com'],
      ['known.com'],
    );

    expect(actions).toHaveLength(1);
    const action = actions[0] as PipelineAction & { type: 'set_source_trust' };

    const rankingMap = new Map(action.payload.rankings.map((r) => [r.domain, r.trustLevel]));

    expect(rankingMap.get('known.com')).toBe('authoritative');
    expect(rankingMap.get('unknown1.com')).toBe('medium');
    expect(rankingMap.get('unknown2.com')).toBe('medium');
  });

  it('handles empty priority list — all domains get medium', () => {
    const client = createMockClient('');
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = evaluator.evaluateWithPriority(['a.com', 'b.com', 'c.com'], []);

    expect(actions).toHaveLength(1);
    const action = actions[0] as PipelineAction & { type: 'set_source_trust' };

    for (const ranking of action.payload.rankings) {
      expect(ranking.trustLevel).toBe('medium');
    }
    expect(action.payload.rankings).toHaveLength(3);
  });

  it('includes all domains in the output rankings', () => {
    const client = createMockClient('');
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = evaluator.evaluateWithPriority(
      ['a.com', 'b.com', 'c.com', 'd.com'],
      ['b.com', 'a.com'],
    );

    const action = actions[0] as PipelineAction & { type: 'set_source_trust' };
    const domains = action.payload.rankings.map((r) => r.domain).sort();
    expect(domains).toEqual(['a.com', 'b.com', 'c.com', 'd.com']);
  });

  it('returns empty array for empty domains without calling LLM', () => {
    const client = createMockClient('');
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = evaluator.evaluateWithPriority([], ['amazon.com']);

    expect(actions).toEqual([]);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('handles single domain in priority list', () => {
    const client = createMockClient('');
    const evaluator = new SourceTrustEvaluator(client, defaultLLMConfig);

    const actions = evaluator.evaluateWithPriority(['only.com'], ['only.com']);

    const action = actions[0] as PipelineAction & { type: 'set_source_trust' };
    expect(action.payload.rankings).toHaveLength(1);
    expect(action.payload.rankings[0].domain).toBe('only.com');
    expect(action.payload.rankings[0].trustLevel).toBe('authoritative');
  });
});
