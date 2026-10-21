import { applyChanges, type ActorRecord } from '@spatula/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/db';
import { applyDefinition, listLiveItems } from './datasets';
import { testTaxonomy, testTaxonomyDefinition } from './fixtures';
import { items } from './schema';
import {
  commitTaxonomy,
  currentTaxonomy,
  seedTaxonomyVersion,
  setTaxonomyKey,
  taxonomyAt,
  taxonomyHistory,
} from './taxonomy';

const OWNER: ActorRecord = { role: 'owner', client: 'cli' };
const AT = new Date('2026-10-20T08:00:00.000Z');
const DATASET = 'test-taxonomy';

describe('taxonomy versions', () => {
  it('seeds version 1 once', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testTaxonomyDefinition());
      expect(await currentTaxonomy(db, DATASET)).toBeNull();
      const taxonomy = testTaxonomy();
      expect(
        await seedTaxonomyVersion(db, { datasetId: DATASET, taxonomy, actor: OWNER, at: AT }),
      ).toBe('seeded');
      expect(
        await seedTaxonomyVersion(db, { datasetId: DATASET, taxonomy, actor: OWNER, at: AT }),
      ).toBe('exists');
      expect(await currentTaxonomy(db, DATASET)).toEqual({
        datasetId: DATASET,
        version: 1,
        taxonomy,
        changes: [],
        actor: OWNER,
        autonomous: false,
        proposalId: null,
        undoes: null,
        createdAt: AT,
      });
    }));

  it('commits the next version compared and set, and keeps every one', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testTaxonomyDefinition());
      const first = testTaxonomy();
      await seedTaxonomyVersion(db, { datasetId: DATASET, taxonomy: first, actor: OWNER, at: AT });
      const next = applyChanges(
        first,
        [
          {
            kind: 'describe',
            subject: 'shelf',
            item: 'dacs',
            description: 'Digital to analog, alone',
          },
        ],
        () => 'tx_00000000000000000999',
      );
      if (!next.ok) throw new Error(next.issues.join('\n'));
      const decider: ActorRecord = { role: 'decider', client: 'run' };
      const commit = {
        datasetId: DATASET,
        base: 1,
        taxonomy: next.taxonomy,
        changes: next.applied,
        actor: decider,
        autonomous: true,
        proposalId: 'tp_one',
        at: AT,
      };
      expect(await commitTaxonomy(db, commit)).toEqual({ committed: true, version: 2 });
      // A second commit on the same base, as a step that runs again sends it, commits nothing.
      expect(await commitTaxonomy(db, commit)).toEqual({ committed: false, version: 2 });
      expect((await taxonomyAt(db, DATASET, 1))!.taxonomy).toEqual(first);
      expect((await currentTaxonomy(db, DATASET))!.taxonomy.version).toBe(2);
      expect(await taxonomyHistory(db, DATASET)).toEqual([
        expect.objectContaining({
          version: 2,
          actor: decider,
          autonomous: true,
          proposalId: 'tp_one',
          changes: next.applied,
        }),
        expect.objectContaining({ version: 1, actor: OWNER, autonomous: false, changes: [] }),
      ]);
      expect(await taxonomyHistory(db, DATASET)).not.toContainEqual(
        expect.objectContaining({ taxonomy: expect.anything() }),
      );
    }));

  it('remembers the key a page was decided under', () =>
    withRollback(async (db) => {
      await applyDefinition(db, testTaxonomyDefinition());
      const [page] = await listLiveItems(db, DATASET);
      await setTaxonomyKey(db, page!.id, 'key-1');
      const [row] = await db
        .select({ key: items.taxonomyKey })
        .from(items)
        .where(eq(items.id, page!.id));
      expect(row).toEqual({ key: 'key-1' });
    }));
});
