import type { RunSummary } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { describe, expect, it } from 'vitest';
import { budgetLeft, decisionsOf, emptyDecisions, tokensSpent, type Context } from './pipeline';

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

const spent = summaryOf({
  llm: { ran: 1, reused: 0, skipped: 0, failed: 0, inputTokens: 1000, outputTokens: 50 },
  classify: { ...emptyDecisions(), inputTokens: 500, outputTokens: 20 },
  match: { ...emptyDecisions(), inputTokens: 300, outputTokens: 10 },
});

describe('the run’s LLM budget', () => {
  it('counts what reading pages, classifying them, and matching them spent', () => {
    expect(tokensSpent(summaryOf())).toBe(0);
    expect(tokensSpent(spent)).toBe(1880);
    // A kind of decision the run hasn't made yet has spent nothing.
    expect(tokensSpent({ ...spent, match: undefined })).toBe(1570);
    expect(tokensSpent({ ...spent, classify: undefined })).toBe(1360);
  });

  it('is what the definition allows less what the run spent, and can end below zero', () => {
    const definition = testDefinition('pipeline-budget');
    const context: Context = {
      runId: 'pipeline-budget-202610100000',
      datasetId: 'pipeline-budget',
      revision: 1,
      definition: { ...definition, budget: { ...definition.budget, llmTokensPerRun: 2000 } },
      startedAt: new Date(Date.UTC(2026, 9, 10)),
    };
    expect(budgetLeft(context, summaryOf())).toBe(2000);
    expect(budgetLeft(context, spent)).toBe(120);
    // The call that passes the budget isn't cut short, so what's left can be less than nothing.
    expect(
      budgetLeft(context, { ...spent, match: { ...emptyDecisions(), inputTokens: 900 } }),
    ).toBe(-470);
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
