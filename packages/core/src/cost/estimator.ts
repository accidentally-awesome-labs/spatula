import { resolveModel } from '../llm/model-router.js';
import { getModelPricing, AVG_TOKENS_PER_CALL } from './pricing.js';
import type { JobConfig, LLMConfig } from '../types/job.js';
import type { LLMTask } from '../llm/types.js';

export interface CostBreakdownEntry {
  purpose: string;
  model: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

export interface CostEstimate {
  estimatedPages: number;
  totalTokens: number;
  totalCostUsd: number;
  confidence: 'low' | 'medium' | 'high';
  llmCallBreakdown: CostBreakdownEntry[];  // Array (not Record) — includes model per entry
  warnings: string[];
}

/**
 * Estimate the LLM cost of a crawl job based on its configuration.
 *
 * Uses heuristics for page count estimation and average token counts
 * per call type. The estimate is rough but useful for cost visibility
 * before starting a crawl.
 */
export function estimateCost(config: JobConfig): CostEstimate {
  const pages = estimatePageCount(config);
  const llmConfig: LLMConfig = config.llm ?? { primaryModel: 'anthropic/claude-sonnet-4-20250514' };
  const warnings: string[] = [];

  // Per-page LLM calls
  const perPageCalls: Array<{ purpose: LLMTask; callsPerPage: number }> = [
    { purpose: 'pageRelevance', callsPerPage: 1 },
    { purpose: 'extraction', callsPerPage: 0.7 },       // ~70% of pages are extractable
    { purpose: 'linkEvaluation', callsPerPage: 0.05 },   // 1 batch call per ~20 links
  ];

  // Per-job LLM calls (not per-page)
  const evolutionBatchSize = config.schema.evolutionConfig?.batchSize ?? 10;
  const perJobCalls: Array<{ purpose: LLMTask; calls: number }> = [
    { purpose: 'schemaEvolution', calls: Math.ceil(pages / evolutionBatchSize) },
    { purpose: 'entityMatching', calls: 1 },
    { purpose: 'conflictResolution', calls: 1 },
    { purpose: 'qualityAudit', calls: 1 },
    { purpose: 'documentation', calls: 1 },
  ];

  const breakdown: CostBreakdownEntry[] = [];

  // Calculate per-page costs
  for (const { purpose, callsPerPage } of perPageCalls) {
    const calls = Math.ceil(pages * callsPerPage);
    const model = resolveModel(llmConfig, purpose);
    const pricing = getModelPricing(model);
    const avgTokens = AVG_TOKENS_PER_CALL[purpose] ?? { prompt: 1000, completion: 500 };
    const tokens = calls * (avgTokens.prompt + avgTokens.completion);
    const costUsd =
      (calls * avgTokens.prompt * pricing.promptPer1M) / 1_000_000 +
      (calls * avgTokens.completion * pricing.completionPer1M) / 1_000_000;

    breakdown.push({ purpose, model, calls, tokens, costUsd: Math.round(costUsd * 1000) / 1000 });
  }

  // Calculate per-job costs
  for (const { purpose, calls } of perJobCalls) {
    const model = resolveModel(llmConfig, purpose);
    const pricing = getModelPricing(model);
    const avgTokens = AVG_TOKENS_PER_CALL[purpose] ?? { prompt: 1000, completion: 500 };
    const tokens = calls * (avgTokens.prompt + avgTokens.completion);
    const costUsd =
      (calls * avgTokens.prompt * pricing.promptPer1M) / 1_000_000 +
      (calls * avgTokens.completion * pricing.completionPer1M) / 1_000_000;

    breakdown.push({ purpose, model, calls, tokens, costUsd: Math.round(costUsd * 1000) / 1000 });
  }

  const totalTokens = breakdown.reduce((sum, e) => sum + e.tokens, 0);
  const totalCostUsd = Math.round(breakdown.reduce((sum, e) => sum + e.costUsd, 0) * 1000) / 1000;
  const confidence = estimateConfidence(config);

  if (confidence === 'low') {
    warnings.push('Wide crawl (depth >= 3 or maxPages > 1000) — actual cost may vary by 2-3x');
  }

  return {
    estimatedPages: pages,
    totalTokens,
    totalCostUsd,
    confidence,
    llmCallBreakdown: breakdown,
    warnings,
  };
}

function estimatePageCount(config: JobConfig): number {
  const maxPages = config.crawl.maxPages;
  const maxDepth = config.crawl.maxDepth;
  const seedCount = config.seedUrls.length;

  if (maxDepth === 0) return Math.min(seedCount, maxPages);
  if (maxDepth === 1) return Math.min(seedCount * 20, maxPages);
  // depth 2+: assume maxPages will be hit
  return maxPages;
}

function estimateConfidence(config: JobConfig): 'low' | 'medium' | 'high' {
  const { maxDepth, maxPages } = config.crawl;
  // Spec: low when maxDepth >= 3 OR maxPages > 1000
  if (maxDepth >= 3 || maxPages > 1000) return 'low';
  // Spec: high when maxDepth <= 1 AND maxPages <= 1000
  if (maxDepth <= 1) return 'high';
  // Spec: medium otherwise (maxDepth === 2, maxPages <= 1000)
  return 'medium';
}
