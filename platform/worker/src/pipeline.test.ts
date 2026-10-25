import type { RunSummary } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { describe, expect, it } from 'vitest';
import {
  countCalls,
  decisionsOf,
  emptyDecisions,
  llmState,
  usdSpent,
  type Context,
} from './pipeline';

const summaryOf = (more: Partial<RunSummary> = {}): RunSummary => ({
  items: 0,
  fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
  statements: { added: 0, reseen: 0, withdrawn: 0 },
  llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
  entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
  snapshot: { published: false, reason: 'the run didn’t reach publishing', excluded: [] },
  notes: [],
  ...more,
});

const emptySummaryForTest = () => summaryOf();

// 1,880 tokens at $1 per million each way.
const spent = summaryOf({
  spend: {
    classify: { 'b/y': { calls: 1, failed: 0, inputTokens: 500, outputTokens: 20, usd: 0.00052 } },
    extract: { 'b/y': { calls: 1, failed: 0, inputTokens: 1000, outputTokens: 50, usd: 0.00105 } },
    match: { 'b/y': { calls: 1, failed: 0, inputTokens: 300, outputTokens: 10, usd: 0.00031 } },
  },
});

describe('the run’s LLM budget', () => {
  it('counts what the run’s models cost, in dollars', () => {
    expect(usdSpent(summaryOf())).toBe(0);
    expect(usdSpent(spent)).toBe(0.00188);
  });

  it('is what the definition allows less what the run spent, and can end below zero', () => {
    const definition = testDefinition('pipeline-budget');
    const context: Context = {
      runId: 'pipeline-budget-202610100000',
      datasetId: 'pipeline-budget',
      revision: 1,
      definition: { ...definition, budget: { ...definition.budget, llmUsdPerRun: 0.002 } },
      startedAt: new Date(Date.UTC(2026, 9, 10)),
    };
    expect(llmState(context, summaryOf()).usdLeft).toBe(0.002);
    expect(llmState(context, spent).usdLeft).toBe(0.00012);
    // The call that passes the budget isn't cut short, so what's left can be less than nothing.
    const over = summaryOf({
      spend: {
        match: { 'b/y': { calls: 1, failed: 0, inputTokens: 0, outputTokens: 0, usd: 0.0025 } },
      },
    });
    expect(llmState(context, over).usdLeft).toBe(-0.0005);
  });

  it('reads the providers found down from the summary', () => {
    const definition = testDefinition('pipeline-down');
    const context: Context = {
      runId: 'pipeline-down-202610100000',
      datasetId: 'pipeline-down',
      revision: 1,
      definition,
      startedAt: new Date(Date.UTC(2026, 9, 10)),
    };
    const down = { a: { at: '2026-10-24T12:31:00.000Z', reason: 'usage limit' } };
    expect(llmState(context, summaryOf()).down).toEqual({});
    expect(llmState(context, summaryOf({ llm: { ...summaryOf().llm, down } })).down).toEqual(down);
  });
});

describe('the run’s LLM state', () => {
  const price = (model: string) =>
    model === 'a/x' ? { input: 4, output: 20 } : model === 'b/y' ? { input: 1, output: 1 } : null;

  it('counts each call’s dollars by job and model, and keeps the first mark for a provider', () => {
    const summary = emptySummaryForTest();
    countCalls(
      summary,
      'classify',
      {
        calls: [
          { model: 'a/x', inputTokens: 1_000_000, outputTokens: 100_000, failed: false },
          { model: 'a/x', inputTokens: 0, outputTokens: 0, failed: true },
          { model: 'b/y', inputTokens: 500_000, outputTokens: 0, failed: false },
        ],
        down: { a: { at: '2026-10-24T12:31:00.000Z', reason: 'usage limit' } },
      },
      price,
    );
    countCalls(summary, 'match', { down: { a: { at: 'later', reason: 'other' } } }, price);
    expect(summary.spend).toEqual({
      classify: {
        'a/x': { calls: 2, failed: 1, inputTokens: 1_000_000, outputTokens: 100_000, usd: 6 },
        'b/y': { calls: 1, failed: 0, inputTokens: 500_000, outputTokens: 0, usd: 0.5 },
      },
    });
    expect(summary.llm.down).toEqual({
      a: { at: '2026-10-24T12:31:00.000Z', reason: 'usage limit' },
    });
    expect(usdSpent(summary)).toBe(6.5);
  });

  it('fails closed when the spend is not a finite number', () => {
    const definition = testDefinition('pipeline-nan');
    const context: Context = {
      runId: 'pipeline-nan-202610100000',
      datasetId: 'pipeline-nan',
      revision: 1,
      definition,
      startedAt: new Date(Date.UTC(2026, 9, 10)),
    };
    const corrupt = summaryOf({
      spend: {
        match: { 'b/y': { calls: 1, failed: 0, inputTokens: 0, outputTokens: 0, usd: Number.NaN } },
      },
    });
    expect(llmState(context, corrupt).usdLeft).toBe(0);
  });

  it('an old step result adds no spend', () => {
    const summary = emptySummaryForTest();
    countCalls(summary, 'match', {}, price);
    expect(summary.spend).toBeUndefined();
    expect(summary.llm.down).toBeUndefined();
    expect(usdSpent(summary)).toBe(0);
  });

  it('a model without a price counts its calls but no dollars', () => {
    const summary = emptySummaryForTest();
    countCalls(
      summary,
      'extract',
      { calls: [{ model: 'c/z', inputTokens: 10, outputTokens: 1, failed: false }] },
      price,
    );
    expect(summary.spend?.extract?.['c/z']).toEqual({
      calls: 1,
      failed: 0,
      inputTokens: 10,
      outputTokens: 1,
      usd: 0,
    });
  });

  it('rounds spend so that a budget met exactly is spent', () => {
    const summary = emptySummaryForTest();
    for (let i = 0; i < 5; i += 1)
      countCalls(
        summary,
        'classify',
        { calls: [{ model: 'b/y', inputTokens: 500, outputTokens: 20, failed: false }] },
        price,
      );
    expect(usdSpent(summary)).toBe(0.0026);
  });
});

describe('a run’s counts of decisions', () => {
  it('start at the run’s first decision of a kind, and are the same counts after', () => {
    const run = summaryOf();
    expect(run.classify).toBeUndefined();
    const counts = decisionsOf(run, 'classify');
    counts.accepted += 1;
    expect(decisionsOf(run, 'classify')).toBe(counts);
    expect(run.classify).toEqual({ ...emptyDecisions(), accepted: 1 });
    // Matching has made none.
    expect(run.match).toBeUndefined();
  });

  it('start from zero every time, and are never shared', () => {
    expect(emptyDecisions()).toEqual({
      rule: 0,
      accepted: 0,
      escalated: 0,
      reused: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(emptyDecisions()).not.toBe(emptyDecisions());
  });
});
