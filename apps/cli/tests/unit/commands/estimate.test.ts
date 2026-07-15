import { describe, it, expect } from 'vitest';
import { formatCostEstimate } from '../../../src/commands/estimate.js';
import type { CostEstimate } from '@accidentally-awesome-labs/spatula-core';

describe('formatCostEstimate', () => {
  const estimate: CostEstimate = {
    estimatedPages: 50,
    totalTokens: 150000,
    totalCostUsd: 0.45,
    confidence: 'high',
    llmCallBreakdown: [
      { purpose: 'extraction', model: 'claude-sonnet', calls: 35, tokens: 105000, costUsd: 0.3 },
      { purpose: 'pageRelevance', model: 'claude-sonnet', calls: 50, tokens: 25000, costUsd: 0.1 },
      {
        purpose: 'schemaEvolution',
        model: 'claude-sonnet',
        calls: 5,
        tokens: 20000,
        costUsd: 0.05,
      },
    ],
    warnings: [],
  };

  it('includes total cost', () => {
    expect(formatCostEstimate(estimate)).toContain('$0.45');
  });
  it('includes estimated pages', () => {
    expect(formatCostEstimate(estimate)).toContain('50');
  });
  it('includes confidence level', () => {
    expect(formatCostEstimate(estimate)).toContain('high');
  });
  it('includes breakdown rows', () => {
    const o = formatCostEstimate(estimate);
    expect(o).toContain('extraction');
    expect(o).toContain('pageRelevance');
  });
  it('shows a provider-qualified model name without dropping its first character', () => {
    const deepseekEstimate: CostEstimate = {
      ...estimate,
      llmCallBreakdown: [
        {
          purpose: 'extraction',
          model: 'deepseek/deepseek-v4-flash',
          calls: 1,
          tokens: 100,
          costUsd: 0.001,
        },
      ],
    };

    expect(formatCostEstimate(deepseekEstimate)).toContain(' deepseek-v4-flash ');
  });
  it('shows warnings when present', () => {
    const w = { ...estimate, warnings: ['Wide crawl — cost may vary'] };
    expect(formatCostEstimate(w)).toContain('Wide crawl');
  });
  it('handles empty breakdown', () => {
    const empty: CostEstimate = {
      estimatedPages: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      confidence: 'high',
      llmCallBreakdown: [],
      warnings: [],
    };
    const o = formatCostEstimate(empty);
    expect(o).toContain('$0.000');
    expect(o).toContain('Estimated pages');
  });
});
