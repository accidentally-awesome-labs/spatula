import { describe, expect, it } from 'vitest';
import { parseDefinition } from './definition';
import {
  acceptFor,
  describeSteps,
  downReason,
  jobSteps,
  MODEL_NAME,
  modelChanges,
  namedModels,
  providerModel,
  providerOf,
  stepAccept,
  usdOf,
} from './models';
import { testDefinitionInput } from './testing/definitions';

function withModels(models: unknown, decisions?: unknown) {
  const parsed = parseDefinition({
    ...testDefinitionInput('models-test'),
    models,
    ...(decisions === undefined ? {} : { decisions }),
  });
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
  return parsed.definition;
}

describe('model names', () => {
  it('splits at the first slash', () => {
    expect(providerOf('openrouter/deepseek/deepseek-v4-flash')).toBe('openrouter');
    expect(providerModel('openrouter/deepseek/deepseek-v4-flash')).toBe(
      'deepseek/deepseek-v4-flash',
    );
    expect(providerOf('anthropic/claude-opus-5-5')).toBe('anthropic');
  });

  it('takes provider/model and nothing looser', () => {
    for (const ok of [
      'anthropic/claude-opus-5-5',
      'openrouter/deepseek/deepseek-v4-flash',
      'groq/llama-4:70b',
    ])
      expect(MODEL_NAME.test(ok)).toBe(true);
    for (const bad of [
      'claude-opus-5-5',
      'Anthropic/x',
      '/x',
      'anthropic/',
      'anthropic//x',
      'anthropic/a b',
      'anthropic/\u0000x',
      `anthropic/${'x'.repeat(201)}`,
    ])
      expect(MODEL_NAME.test(bad)).toBe(false);
  });
});

describe('jobSteps', () => {
  it('uses the default as one step for a job the definition leaves out', () => {
    expect(jobSteps(withModels(undefined), 'match', 'anthropic/claude-opus-5-5')).toEqual([
      { model: 'anthropic/claude-opus-5-5', backup: null, accept: null },
    ]);
  });

  it('reads bare names and objects, in order', () => {
    const definition = withModels({
      extract: 'openai/small',
      classify: [
        { model: 'cerebras/cheap', backup: 'groq/cheap', accept: 0.96 },
        'anthropic/claude-opus-5-5',
      ],
      taxonomyReview: { model: 'anthropic/claude-opus-5-5', backup: 'openai/strong' },
    });
    expect(jobSteps(definition, 'extract', 'x/y')).toEqual([
      { model: 'openai/small', backup: null, accept: null },
    ]);
    expect(jobSteps(definition, 'classify', 'x/y')).toEqual([
      { model: 'cerebras/cheap', backup: 'groq/cheap', accept: 0.96 },
      { model: 'anthropic/claude-opus-5-5', backup: null, accept: null },
    ]);
    expect(jobSteps(definition, 'taxonomyReview', 'x/y')).toEqual([
      { model: 'anthropic/claude-opus-5-5', backup: 'openai/strong', accept: null },
    ]);
  });
});

describe('thresholds', () => {
  const definition = withModels({
    classify: [
      { model: 'cerebras/cheap', backup: 'groq/cheap', accept: 0.96 },
      'anthropic/claude-opus-5-5',
    ],
  });
  const [cheap, opus] = jobSteps(definition, 'classify', 'x/y');

  it('holds a step to its own threshold, or the job’s', () => {
    expect(stepAccept(definition, 'classify', cheap!)).toBe(0.96);
    expect(stepAccept(definition, 'classify', opus!)).toBe(0.9);
  });

  it('holds an answer to the threshold of the step whose model or backup gave it', () => {
    expect(acceptFor(definition, 'classify', 'llm:cerebras/cheap')).toBe(0.96);
    expect(acceptFor(definition, 'classify', 'llm:groq/cheap')).toBe(0.96);
    expect(acceptFor(definition, 'classify', 'llm:anthropic/claude-opus-5-5')).toBe(0.9);
    // Earlier records, a rule, a person, or a model no longer named: the job's.
    expect(acceptFor(definition, 'classify', 'llm:claude-opus-5-5')).toBe(0.9);
    expect(acceptFor(definition, 'classify', null)).toBe(0.9);
    expect(acceptFor(definition, 'match', 'llm:cerebras/cheap')).toBe(0.95);
  });
});

describe('namedModels', () => {
  it('names each model with where it is named', () => {
    const definition = withModels({
      extract: { model: 'openai/small', backup: 'anthropic/claude-haiku-5-5' },
      match: ['anthropic/claude-opus-5-5'],
    });
    expect(namedModels(definition)).toEqual([
      { at: 'models.extract.model', model: 'openai/small' },
      { at: 'models.extract.backup', model: 'anthropic/claude-haiku-5-5' },
      { at: 'models.match[0].model', model: 'anthropic/claude-opus-5-5' },
    ]);
    expect(namedModels(withModels(undefined))).toEqual([]);
  });
});

describe('usdOf', () => {
  it('prices tokens per million', () => {
    expect(usdOf({ inputTokens: 1_000_000, outputTokens: 500_000 }, { input: 4, output: 20 })).toBe(
      14,
    );
    expect(usdOf({ inputTokens: 0, outputTokens: 0 }, { input: 4, output: 20 })).toBe(0);
  });
});

describe('downReason', () => {
  it('marks a provider down for a refused key, a payment, or a limit in any provider’s words', () => {
    expect(downReason({ status: 401, message: 'invalid x-api-key' })).toBe('the key was refused');
    expect(downReason({ status: 403, message: 'forbidden' })).toBe('the key was refused');
    expect(downReason({ status: 402, message: 'Insufficient credits' })).toBe('payment required');
    expect(
      downReason({
        status: 400,
        message:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."}}',
      }),
    ).toBe('usage limit');
    expect(
      downReason({
        status: 429,
        message: '429 You exceeded your current quota (insufficient_quota)',
      }),
    ).toBe('usage limit');
  });

  it('leaves a provider up for what may pass', () => {
    expect(downReason({ status: 429, message: 'Rate limit reached for requests' })).toBeNull();
    expect(downReason({ status: 500, message: 'Internal error' })).toBeNull();
    expect(downReason({ status: 400, message: 'invalid schema' })).toBeNull();
    expect(
      downReason({ status: null, message: 'The operation was aborted due to timeout' }),
    ).toBeNull();
  });
});

describe('describeSteps and modelChanges', () => {
  it('says a job’s models in words', () => {
    expect(
      describeSteps([
        { model: 'cerebras/cheap', backup: 'groq/cheap', accept: 0.96 },
        { model: 'anthropic/claude-opus-5-5', backup: null, accept: null },
      ]),
    ).toBe('cerebras/cheap (backup groq/cheap, at 0.96), then anthropic/claude-opus-5-5');
  });

  it('lists the jobs whose models change, reading a stored definition leniently', () => {
    const after = withModels({ classify: ['cerebras/cheap', 'anthropic/claude-opus-5-5'] });
    // A definition stored before ADR 0010 names no models, and still has llmTokensPerRun.
    const before = {
      ...testDefinitionInput('models-test'),
      budget: { itemsPerRun: 10, llmTokensPerRun: 5 },
    };
    expect(modelChanges(before, after)).toEqual([
      {
        job: 'classify',
        before: 'the default',
        after: 'cerebras/cheap, then anthropic/claude-opus-5-5',
      },
    ]);
    expect(modelChanges({ ...before, models: { classify: 'not a list' } }, after)).toEqual([
      {
        job: 'classify',
        before: 'the default',
        after: 'cerebras/cheap, then anthropic/claude-opus-5-5',
      },
    ]);
    expect(modelChanges(after, after)).toEqual([]);
  });
});
