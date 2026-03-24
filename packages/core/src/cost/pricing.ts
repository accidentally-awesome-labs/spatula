// packages/core/src/cost/pricing.ts
import type { LLMTask } from '../llm/types.js';

/**
 * Per-model pricing in USD per 1M tokens.
 * Sources: OpenRouter pricing pages.
 * Ollama models are free (local inference).
 */
export interface ModelPricing {
  promptPer1M: number;
  completionPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic models
  'anthropic/claude-sonnet-4-20250514': { promptPer1M: 3.00, completionPer1M: 15.00 },
  'anthropic/claude-3-haiku-20240307': { promptPer1M: 0.25, completionPer1M: 1.25 },
  'anthropic/claude-opus-4-20250514': { promptPer1M: 15.00, completionPer1M: 75.00 },
  // Google models
  'google/gemini-2.5-flash': { promptPer1M: 0.15, completionPer1M: 0.60 },
  'google/gemini-2.5-pro': { promptPer1M: 1.25, completionPer1M: 10.00 },
  // Meta models (via OpenRouter)
  'meta-llama/llama-3.3-70b-instruct': { promptPer1M: 0.40, completionPer1M: 0.40 },
};

/** Default pricing for unknown models */
export const DEFAULT_PRICING: ModelPricing = { promptPer1M: 1.00, completionPer1M: 5.00 };

/** Ollama models are always free */
export const OLLAMA_PRICING: ModelPricing = { promptPer1M: 0, completionPer1M: 0 };

/**
 * Average tokens per LLM call type, based on empirical measurement.
 */
export const AVG_TOKENS_PER_CALL: Record<LLMTask, { prompt: number; completion: number }> = {
  pageRelevance: { prompt: 800, completion: 100 },
  extraction: { prompt: 2000, completion: 1500 },
  linkEvaluation: { prompt: 1500, completion: 300 },
  schemaEvolution: { prompt: 3000, completion: 1000 },
  entityMatching: { prompt: 1500, completion: 500 },
  conflictResolution: { prompt: 1000, completion: 300 },
  qualityAudit: { prompt: 2000, completion: 500 },
  documentation: { prompt: 1000, completion: 2000 },
};

/**
 * Get pricing for a model. Ollama models (any model containing no '/')
 * or explicitly prefixed patterns are treated as free.
 */
export function getModelPricing(model: string): ModelPricing {
  // Ollama models don't have a provider prefix (e.g., 'llama3.2:8b')
  // or are explicitly local
  if (!model.includes('/')) return OLLAMA_PRICING;

  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}
