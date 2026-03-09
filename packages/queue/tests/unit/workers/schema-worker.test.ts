import { describe, it, expect } from 'vitest';
import { processSchemaEvolutionJob } from '../../../src/workers/schema-worker.js';

describe('processSchemaEvolutionJob', () => {
  it('is a function', () => {
    expect(typeof processSchemaEvolutionJob).toBe('function');
  });

  it('logs a stub message and returns without error', async () => {
    await expect(
      processSchemaEvolutionJob(
        { jobId: 'job-1', tenantId: 'tenant-1', extractionIds: ['ext-1'] },
        {} as any,
      ),
    ).resolves.toBeUndefined();
  });
});
