import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { seedDataset } from '../test/seed';
import { finishRun, runningRun } from './runs';

describe('runningRun', () => {
  it('names the dataset’s run that’s going, and none once it has finished', () =>
    withRollback(async (db) => {
      const { runId } = await seedDataset(db);
      expect(await runningRun(db, 'test-products')).toMatchObject({
        id: runId,
        status: 'running',
      });
      expect(await runningRun(db, 'another')).toBeNull();
      await finishRun(db, runId, { status: 'failed', error: 'a test’s run' });
      expect(await runningRun(db, 'test-products')).toBeNull();
    }));
});
