import type { RunSummary } from '@spatula/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { seedDataset } from '../test/seed';
import { finishRun, latestRunSummary, runningRun, startRun } from './runs';
import { runs } from './schema';

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

/** What a run that did nothing reports, with a note to tell it by. */
const summaryNoting = (note: string): RunSummary => ({
  items: 0,
  fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
  statements: { added: 0, reseen: 0, withdrawn: 0 },
  llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
  entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
  snapshot: { published: false, reason: 'nothing changed', excluded: [] },
  notes: [note],
});

describe('latestRunSummary', () => {
  it('gives the summary of the run that finished last, and none before a run has one', () =>
    withRollback(async (db) => {
      const { runId: going } = await seedDataset(db);
      expect(await latestRunSummary(db, 'test-products')).toBeNull();

      const earlier = 'test-products-202610100500';
      const later = 'test-products-202610101000';
      await startRun(db, { id: earlier, datasetId: 'test-products' });
      await startRun(db, { id: later, datasetId: 'test-products' });
      await finishRun(db, earlier, { status: 'complete', summary: summaryNoting('earlier') });
      await finishRun(db, later, { status: 'complete', summary: summaryNoting('later') });
      const finished = (id: string, at: string) =>
        db
          .update(runs)
          .set({ finishedAt: new Date(at) })
          .where(eq(runs.id, id));
      // The run that started first finished last.
      await finished(earlier, '2026-10-10T12:00:00Z');
      await finished(later, '2026-10-10T11:00:00Z');
      expect(await latestRunSummary(db, 'test-products')).toEqual({
        id: earlier,
        summary: summaryNoting('earlier'),
      });

      // A run that failed has no summary, however late it finished.
      await finishRun(db, going, { status: 'failed', error: 'robots.txt is unreachable' });
      await finished(going, '2026-10-10T13:00:00Z');
      expect((await latestRunSummary(db, 'test-products'))?.id).toBe(earlier);

      expect(await latestRunSummary(db, 'another')).toBeNull();
    }));
});
