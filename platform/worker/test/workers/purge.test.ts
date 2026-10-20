import {
  applyDefinition,
  captures,
  finishRun,
  items,
  recordCapture,
  recordFetch,
  runs,
  setCaptureRead,
  startRun,
} from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { RUN_START_GRACE_MS } from '../../src/api';
import { rawPageKey, readKey } from '../../src/captures';
import { withDatabase } from '../../src/database';
import { pageKey } from '../../src/pipeline';
import { call, expectNoStore } from './api-support';

/** Bindings whose Workflow binding has no instance to give, as for a run whose Workflow never started. */
const withoutWorkflows = (): Env =>
  ({
    ...env,
    REFRESH: { get: () => Promise.reject(new Error('no such instance')) },
  }) as unknown as Env;

/** A made-up body hash, unique to the dataset and source it's named for. */
const hashOf = (name: string) => name.padEnd(64, '0');

/**
 * A dataset whose A1 (maker-a's) and B1 (maker-b's) were each captured once, with their bodies,
 * old and new, and their reads in R2, and whose run has finished. It opens one database client.
 */
async function archived(datasetId: string): Promise<void> {
  await withDatabase(env, async (db) => {
    await applyDefinition(db, testDefinition(datasetId));
    const runId = `${datasetId}-202610100000`;
    await startRun(db, { id: runId, datasetId });
    const pages = await db.select().from(items).where(eq(items.datasetId, datasetId));
    for (const page of pages.filter((one) => !one.locator.endsWith('/a2'))) {
      const hash = hashOf(`${datasetId}-${page.sourceId}`);
      const fetchId = `fe_${datasetId}_${page.sourceId}`;
      const at = new Date();
      await recordFetch(db, {
        id: fetchId,
        runId,
        itemId: page.id,
        url: page.locator,
        finalUrl: page.locator,
        policy: 'allowed',
        policyReason: null,
        method: 'http',
        outcome: 'changed',
        httpStatus: 200,
        bytes: 10,
        signals: {},
        startedAt: at,
        durationMs: 1,
        error: null,
        page: { contentHash: hash, etag: '"e"', lastModified: null },
      });
      const captureId = `cp_${datasetId}_${page.sourceId}`;
      await recordCapture(db, {
        id: captureId,
        datasetId,
        itemId: page.id,
        sourceId: page.sourceId,
        fetchId,
        url: page.locator,
        finalUrl: page.locator,
        httpStatus: 200,
        etag: '"e"',
        lastModified: null,
        fetchedAt: at,
        contentHash: hash,
        bytes: 10,
        storedBytes: 5,
        signals: {},
      });
      await setCaptureRead(db, {
        id: captureId,
        readKey: readKey(datasetId, captureId),
        reader: 1,
      });
      await env.STORE.put(pageKey(hash), 'gzipped');
      await env.STORE.put(rawPageKey(hash), 'raw');
      await env.STORE.put(readKey(datasetId, captureId), 'read');
    }
    await finishRun(db, runId, { status: 'failed', error: 'a test’s run' });
  });
}

const purge = (datasetId: string, body: unknown, more: { bindings?: Env; token?: string } = {}) =>
  call('POST', `/datasets/${datasetId}/captures/purge`, { body, ...more });

describe('POST /datasets/:id/captures/purge', () => {
  it('deletes a source’s captures, their files, and its pages’ copies, and nothing of another source', async () => {
    await archived('purge-one');
    const response = await purge('purge-one', { source: 'maker-a' });
    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(await response.json()).toEqual({ purged: { captures: 1, pages: 1, bodies: 1 } });

    const a = hashOf('purge-one-maker-a');
    const b = hashOf('purge-one-maker-b');
    expect(await env.STORE.get(pageKey(a))).toBeNull();
    expect(await env.STORE.get(rawPageKey(a))).toBeNull();
    expect(await env.STORE.get(readKey('purge-one', 'cp_purge-one_maker-a'))).toBeNull();
    expect(await env.STORE.get(pageKey(b))).not.toBeNull();
    expect(await env.STORE.get(readKey('purge-one', 'cp_purge-one_maker-b'))).not.toBeNull();
    await withDatabase(env, async (db) => {
      expect(
        await db
          .select({ id: captures.id })
          .from(captures)
          .where(eq(captures.datasetId, 'purge-one')),
      ).toEqual([{ id: 'cp_purge-one_maker-b' }]);
      expect(
        await db
          .select({ sourceId: items.sourceId, contentHash: items.contentHash, etag: items.etag })
          .from(items)
          .where(eq(items.datasetId, 'purge-one'))
          .orderBy(items.locator),
      ).toEqual([
        { sourceId: 'maker-a', contentHash: null, etag: null },
        { sourceId: 'maker-a', contentHash: null, etag: null },
        { sourceId: 'maker-b', contentHash: b, etag: '"e"' },
      ]);
    });

    // Again: nothing is left of the source, which is no error.
    const again = await purge('purge-one', { source: 'maker-a' });
    expect(await again.json()).toEqual({ purged: { captures: 0, pages: 0, bodies: 0 } });
  });

  it.each(['page', 'capture'] as const)(
    'keeps a body that a %s of another dataset holds, and deletes the rest of the source',
    async (kind) => {
      const datasetId = `purge-shared-${kind}`;
      const holder = `purge-holder-${kind}`;
      await archived(datasetId);
      await archived(holder);
      const shared = hashOf(`${datasetId}-maker-a`);
      await withDatabase(env, async (db) => {
        if (kind === 'page') {
          await db
            .update(items)
            .set({ contentHash: shared })
            .where(and(eq(items.datasetId, holder), eq(items.sourceId, 'maker-a')));
        } else {
          await db
            .update(captures)
            .set({ contentHash: shared })
            .where(eq(captures.id, `cp_${holder}_maker-a`));
        }
      });

      const response = await purge(datasetId, { source: 'maker-a' });
      expect(response.status).toBe(200);
      // The source's capture and page went, but no body: the other dataset holds it.
      expect(await response.json()).toEqual({ purged: { captures: 1, pages: 1, bodies: 0 } });
      expect(await env.STORE.get(pageKey(shared))).not.toBeNull();
      expect(await env.STORE.get(rawPageKey(shared))).not.toBeNull();
      // The capture's own read is still deleted.
      expect(await env.STORE.get(readKey(datasetId, `cp_${datasetId}_maker-a`))).toBeNull();
      await withDatabase(env, async (db) => {
        expect(
          await db
            .select({ id: captures.id })
            .from(captures)
            .where(eq(captures.datasetId, datasetId)),
        ).toEqual([{ id: `cp_${datasetId}_maker-b` }]);
        // Nothing of the holder's was touched.
        expect(
          await db
            .select({ id: captures.id })
            .from(captures)
            .where(eq(captures.datasetId, holder))
            .orderBy(captures.id),
        ).toEqual([{ id: `cp_${holder}_maker-a` }, { id: `cp_${holder}_maker-b` }]);
      });
    },
  );

  it('answers 404 for a dataset or a source that isn’t there, 400 for a body that’s wrong, and 401 to anyone but the owner', async () => {
    await archived('purge-missing');
    const nobody = await purge('purge-nobody', { source: 'maker-a' });
    expect(nobody.status).toBe(404);
    expect(await nobody.json()).toEqual({ error: 'Dataset purge-nobody doesn’t exist.' });
    const noSource = await purge('purge-missing', { source: 'maker-z' });
    expect(noSource.status).toBe(404);
    expect(await noSource.json()).toEqual({ error: 'purge-missing has no source called maker-z.' });
    for (const body of [
      'not json',
      { source: '' },
      { sources: ['maker-a'] },
      { source: 'maker-a', more: 1 },
    ]) {
      expect((await purge('purge-missing', body)).status).toBe(400);
    }
    expect(
      (await purge('purge-missing', { source: 'maker-a' }, { token: 'not-the-owner' })).status,
    ).toBe(401);
    // Nothing was purged by any of them.
    expect(await env.STORE.get(pageKey(hashOf('purge-missing-maker-a')))).not.toBeNull();
  });

  it('waits while a run of the dataset is going, and not for a run whose Workflow is gone', async () => {
    await archived('purge-running');
    const going = 'purge-running-202610100005';
    await withDatabase(env, (db) => startRun(db, { id: going, datasetId: 'purge-running' }));
    const refused = await purge(
      'purge-running',
      { source: 'maker-a' },
      { bindings: withoutWorkflows() },
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: `A run of purge-running is going (${going}). Purge once it has finished.`,
      runId: going,
    });
    expect(await env.STORE.get(pageKey(hashOf('purge-running-maker-a')))).not.toBeNull();

    // Past the grace a Workflow has to start, a run without one is no run (viewRun).
    await withDatabase(env, (db) =>
      db
        .update(runs)
        .set({ startedAt: new Date(Date.now() - RUN_START_GRACE_MS - 60_000) })
        .where(eq(runs.id, going)),
    );
    const done = await purge(
      'purge-running',
      { source: 'maker-a' },
      { bindings: withoutWorkflows() },
    );
    expect(done.status).toBe(200);
  });
});
