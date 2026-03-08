import { z } from 'zod';
import type { JobConfig } from '../types/job.js';
import type { ConfigAction } from '../types/config-actions.js';

export const ConfigValidationResult = z.object({
  valid: z.boolean(),
  missing: z.array(z.string()),
  warnings: z.array(z.string()),
  suggestions: z.array(z.string()),
});

export type ConfigValidationResult = z.infer<typeof ConfigValidationResult>;

export const ConfigDiff = z.object({
  changes: z.array(
    z.object({
      path: z.string(),
      before: z.unknown(),
      after: z.unknown(),
      description: z.string(),
    }),
  ),
});

export type ConfigDiff = z.infer<typeof ConfigDiff>;

export interface ConfigExecutor {
  apply(config: JobConfig, action: ConfigAction): JobConfig;
  applyBatch(config: JobConfig, actions: ConfigAction[]): JobConfig;
  validate(config: JobConfig): ConfigValidationResult;
  diff(before: JobConfig, after: JobConfig): ConfigDiff;
}
