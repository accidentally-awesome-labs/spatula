import { parseDefinition, type LlmUsage } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { describe, expect, it } from 'vitest';
import {
  failureOf,
  gather,
  modelIssues,
  noneAsked,
  savedCalls,
  tryStep,
  workerModels,
  type ModelSetup,
} from './models';
import { LlmHttpError } from './llm-openai';

const env = (vars: Record<string, unknown>) => vars as unknown as Env;
const setup = (problems: Record<string, string> = {}): ModelSetup => ({
  defaultModel: 'anthropic/claude-opus-5-5',
  problem: (model) => problems[model] ?? null,
  price: () => ({ input: 1, output: 1 }),
});
const usage: LlmUsage = { inputTokens: 100, outputTokens: 10 };
const NOW = new Date('2026-10-24T12:31:00Z');

describe('workerModels', () => {
  const base = {
    LLM_MODEL: 'anthropic/claude-opus-5-5',
    LLM_PRICES: { 'anthropic/claude-opus-5-5': [4, 20], 'openai/strong': [2, 8] },
    LLM_GATEWAY_KEYS: '',
    AI_GATEWAY_URL: 'https://gateway.example/v1/acct/spatula-llm/anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  };

  it('prices from LLM_PRICES, and gives a model with a bad or missing price none', () => {
    const { setup: made } = workerModels(
      env({
        ...base,
        LLM_PRICES: {
          'anthropic/claude-opus-5-5': [4, 20],
          'a/neg': [-1, 2],
          'a/nan': ['x', 1],
          'a/short': [1],
        },
      }),
    );
    expect(made.price('anthropic/claude-opus-5-5')).toEqual({ input: 4, output: 20 });
    for (const model of ['a/neg', 'a/nan', 'a/short', 'a/missing'])
      expect(made.price(model)).toBeNull();
    expect(
      workerModels(env({ ...base, LLM_PRICES: 'not json' })).setup.price(
        'anthropic/claude-opus-5-5',
      ),
    ).toBeNull();
    // A JSON string as wrangler may hand a variable over still reads.
    expect(
      workerModels(
        env({ ...base, LLM_PRICES: '{"anthropic/claude-opus-5-5":[4,20]}' }),
      ).setup.price('anthropic/claude-opus-5-5'),
    ).toEqual({ input: 4, output: 20 });
  });

  it('says what keeps a model from being asked', () => {
    const { setup: made } = workerModels(env(base));
    expect(made.problem('anthropic/claude-opus-5-5')).toBeNull();
    expect(made.problem('claude-opus-5-5')).toBe('it isn’t named provider/model');
    expect(made.problem('mystery/model')).toBe('Spatula has no provider called mystery');
    expect(made.problem('openai/unpriced')).toBe('it has no price: add it to LLM_PRICES');
    expect(made.problem('openai/strong')).toBe(
      'no key: set OPENAI_API_KEY, or name openai in LLM_GATEWAY_KEYS',
    );
  });

  it('takes a gateway-held key only with the gateway token', () => {
    const held = { ...base, LLM_GATEWAY_KEYS: 'openai, cerebras' };
    expect(workerModels(env(held)).setup.problem('openai/strong')).toBe(
      'its key is held by the gateway, which needs AI_GATEWAY_TOKEN',
    );
    expect(
      workerModels(env({ ...held, AI_GATEWAY_TOKEN: 'gateway-token' })).setup.problem(
        'openai/strong',
      ),
    ).toBeNull();
  });

  it('checks no key without a gateway, and gives no ports: such a Worker asks no model', () => {
    const { setup: made, ports } = workerModels(env({ ...base, AI_GATEWAY_URL: '' }));
    expect(ports).toBeNull();
    expect(made.problem('openai/strong')).toBeNull();
    expect(made.problem('openai/unpriced')).toBe('it has no price: add it to LLM_PRICES');
  });

  it('gives each model its ports, named in full, once', () => {
    const { ports } = workerModels(
      env({ ...base, AI_GATEWAY_TOKEN: 'gateway-token', OPENAI_API_KEY: 'sk-test' }),
    );
    const opus = ports!('anthropic/claude-opus-5-5');
    expect(opus.llm.model).toBe('anthropic/claude-opus-5-5');
    expect(opus.decider.name).toBe('llm:anthropic/claude-opus-5-5');
    expect(ports!('anthropic/claude-opus-5-5')).toBe(opus);
    expect(ports!('openai/strong').taxonomyDecider.name).toBe('llm:openai/strong');
  });
});

describe('tryStep', () => {
  const step = { model: 'anthropic/claude-opus-5-5', backup: 'openai/strong', accept: null };

  it('asks the model, and leaves the backup alone when it answers', async () => {
    const asked: string[] = [];
    const tried = await tryStep({
      step,
      setup: setup(),
      down: {},
      now: NOW,
      ask: async (model) => (asked.push(model), { value: 'yes', usage }),
    });
    expect(asked).toEqual(['anthropic/claude-opus-5-5']);
    expect(tried).toEqual({
      answered: { model: 'anthropic/claude-opus-5-5', value: 'yes' },
      calls: [
        { model: 'anthropic/claude-opus-5-5', inputTokens: 100, outputTokens: 10, failed: false },
      ],
      down: {},
      failures: [],
    });
  });

  it('asks the backup when the model fails, and marks a provider down for a limit', async () => {
    const tried = await tryStep({
      step,
      setup: setup(),
      down: {},
      now: NOW,
      ask: async (model) => {
        if (model.startsWith('anthropic/')) {
          throw new LlmHttpError(400, '400 You have reached your specified API usage limits.');
        }
        return { value: 'backup says', usage };
      },
    });
    expect(tried.answered).toEqual({ model: 'openai/strong', value: 'backup says' });
    expect(tried.down).toEqual({
      anthropic: { at: '2026-10-24T12:31:00.000Z', reason: 'usage limit' },
    });
    expect(tried.calls.map((call) => [call.model, call.failed])).toEqual([
      ['anthropic/claude-opus-5-5', true],
      ['openai/strong', false],
    ]);
    expect(tried.failures).toEqual([
      'anthropic/claude-opus-5-5: 400 You have reached your specified API usage limits.',
    ]);
  });

  it('sends nothing to a provider that’s down, or to a model with a problem', async () => {
    const asked: string[] = [];
    const tried = await tryStep({
      step,
      setup: setup({ 'openai/strong': 'no key: set OPENAI_API_KEY' }),
      down: { anthropic: { at: '2026-10-24T12:31:00.000Z', reason: 'usage limit' } },
      now: NOW,
      ask: async (model) => (asked.push(model), { value: 'never', usage }),
    });
    expect(asked).toEqual([]);
    expect(tried.answered).toBeNull();
    expect(tried.failures).toEqual([
      'anthropic/claude-opus-5-5: anthropic is down since 2026-10-24T12:31:00.000Z: usage limit',
      'openai/strong: no key: set OPENAI_API_KEY',
    ]);
    expect(tried.calls).toEqual([
      { model: 'anthropic/claude-opus-5-5', inputTokens: 0, outputTokens: 0, failed: true },
      { model: 'openai/strong', inputTokens: 0, outputTokens: 0, failed: true },
    ]);
  });

  it('gathers what steps asked, keeping the first mark for a provider', () => {
    const into = noneAsked();
    gather(into, {
      answered: null,
      calls: [{ model: 'a/x', inputTokens: 0, outputTokens: 0, failed: true }],
      down: { a: { at: '1', reason: 'r1' } },
      failures: [],
    });
    gather(into, {
      answered: null,
      calls: [],
      down: { a: { at: '2', reason: 'r2' } },
      failures: [],
    });
    expect(into).toEqual({
      calls: [{ model: 'a/x', inputTokens: 0, outputTokens: 0, failed: true }],
      down: { a: { at: '1', reason: 'r1' } },
    });
  });
});

describe('failureOf', () => {
  it('reads a status where the error has one', () => {
    expect(failureOf(new LlmHttpError(429, '429 Slow down'))).toEqual({
      status: 429,
      message: '429 Slow down',
    });
    expect(failureOf(new Error('socket hang up'))).toEqual({
      status: null,
      message: 'socket hang up',
    });
    expect(failureOf('odd')).toEqual({ status: null, message: 'odd' });
  });
});

describe('modelIssues', () => {
  it('names each model the definition names that the deployment can’t ask, and where', () => {
    const parsed = parseDefinition({
      ...JSON.parse(JSON.stringify(testDefinition('issues'))),
      models: { match: [{ model: 'anthropic/claude-opus-5-5', backup: 'cerebras/fast' }] },
    });
    if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
    expect(
      modelIssues(
        parsed.definition,
        setup({
          'cerebras/fast': 'no key: set CEREBRAS_API_KEY, or name cerebras in LLM_GATEWAY_KEYS',
        }),
      ),
    ).toEqual([
      'models.match[0].backup: cerebras/fast: no key: set CEREBRAS_API_KEY, or name cerebras in LLM_GATEWAY_KEYS.',
    ]);
  });
});

describe('savedCalls', () => {
  it('charges a model’s decision to the model that answered', () => {
    expect(savedCalls({ adapter: 'llm:a/x', inputTokens: 500, outputTokens: 20 })).toEqual([
      { model: 'a/x', inputTokens: 500, outputTokens: 20, failed: false },
    ]);
  });

  it('reports nothing for a rule, a person, or a decision without tokens', () => {
    expect(savedCalls({ adapter: null, inputTokens: 500, outputTokens: 20 })).toEqual([]);
    expect(savedCalls({ adapter: 'person', inputTokens: 5, outputTokens: 2 })).toEqual([]);
    expect(savedCalls({ adapter: 'llm:a/x', inputTokens: 0, outputTokens: 0 })).toEqual([]);
  });
});
