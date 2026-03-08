import type { LLMConfig } from '../types/job.js';
import type { LLMTask } from './types.js';

export function resolveModel(config: LLMConfig, task: LLMTask): string {
  const override = config.modelOverrides?.[task];
  return override ?? config.primaryModel;
}
