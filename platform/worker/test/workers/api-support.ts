import { hmacSha256Hex, matchQuestion, sha256Hex } from '@spatula/core';
import {
  applyDefinition,
  commitSnapshot,
  datasets,
  entities,
  holdSnapshot,
  listLiveItems,
  openReview,
  recordFetch,
  startRun,
} from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { api } from '../../src/api';
import { withDatabase } from '../../src/database';
import { PUBLISH_QUESTION } from '../../src/publish';

/*
 * What the tests of the API share. They are in files of their own because each database client
 * the Worker opens stays open until the test file ends, and a file that makes enough requests runs
 * the test database out of connections.
 */

/**
 * Calls the API as the owner, unless told to send another token, none, or a whole authorization
 * header, with any other headers given. A string body goes as is.
 */
export function call(
  method: string,
  path: string,
  options: {
    body?: unknown;
    token?: string | null;
    authorization?: string;
    headers?: Record<string, string>;
    bindings?: Env;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  const authorization =
    options.authorization ??
    (options.token === null ? undefined : `Bearer ${options.token ?? 'test-token'}`);
  if (authorization !== undefined) headers.set('authorization', authorization);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const body =
    options.body === undefined || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body);
  return Promise.resolve(api.request(path, { method, headers, body }, options.bindings ?? env));
}

/** Every answer but the public page is private, no-store, whatever its status. */
export function expectNoStore(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
}

/** Crowdio's token, and the key it signs its acknowledgments with, in these tests. */
export const CONSUMER_TOKEN = 'crowdio-token';
export const CONSUMER_KEY = 'crowdio-hmac-key';

/** The test bindings with crowdio's two secrets set, as `wrangler secret put` sets them. */
export async function consumerBindings(): Promise<Env> {
  return {
    ...env,
    CONSUMER_CROWDIO_TOKEN_HASH: await sha256Hex(CONSUMER_TOKEN),
    CONSUMER_CROWDIO_HMAC_KEY: CONSUMER_KEY,
  } as Env;
}

/** Crowdio's bindings, with these scopes granted to its reviewers: `review:answer` unless told. */
export async function reviewerBindings(scopes = 'review:answer'): Promise<Env> {
  return { ...(await consumerBindings()), CONSUMER_CROWDIO_SCOPES: scopes } as Env;
}

/** The classification question a run asks about the test dataset's category. */
export const CLASSIFY_QUESTION = {
  type: 'choice' as const,
  prompt: 'Which category does the one product this page is about have?',
  options: ['Headphones', 'DAC/Amp', 'None of these'],
};

/**
 * A dataset that lists crowdio, with a question of every kind waiting: whether its first page is
 * each of two records (at minutes 0 and 1), its second page's category (minute 2), and whether to
 * publish a held snapshot (minute 3), whose records are in R2 where a run puts them. A run read
 * both pages once, as it does before it asks: a person's category is recorded against the read. It
 * opens one database client.
 */
export async function questionsIn(datasetId: string) {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 0, minute));
  const key = `datasets/${datasetId}/held/sn_${datasetId}.json`;
  const draft = JSON.stringify({
    project: datasetId,
    snapshotId: `sn_${datasetId}`,
    records: [{ canonicalId: `sp_${datasetId}`, fields: { name: 'A1' }, provenance: {} }],
  });
  await env.STORE.put(key, draft);
  return withDatabase(env, async (db) => {
    await applyDefinition(db, { ...testDefinition(datasetId), consumers: ['crowdio'] });
    const [a1, a2] = await listLiveItems(db, datasetId);
    if (a1 === undefined || a2 === undefined) throw new Error(`${datasetId} has no pages`);
    const runId = `rn_${datasetId}`;
    await startRun(db, { id: runId, datasetId });
    for (const item of [a1, a2]) {
      await recordFetch(db, {
        id: `fe_${item.id}`,
        runId,
        itemId: item.id,
        url: item.locator,
        finalUrl: null,
        policy: 'allowed',
        policyReason: null,
        method: 'http',
        outcome: 'changed',
        httpStatus: 200,
        bytes: 100,
        signals: null,
        startedAt: at(0),
        durationMs: 10,
        error: null,
        page: { contentHash: `hash-${item.id}`, etag: null, lastModified: null },
      });
    }
    const records = [`sp_${datasetId}_one`, `sp_${datasetId}_two`];
    await db
      .insert(entities)
      .values(records.map((id) => ({ id, datasetId, recordType: 'product' })));
    for (const [index, entityId] of records.entries()) {
      await openReview(db, {
        id: `rv_${datasetId}_match_${index}`,
        datasetId,
        kind: 'match',
        subject: `${a1.id}|${entityId}`,
        itemId: a1.id,
        entityId,
        question: matchQuestion(),
        context: {
          page: a1.locator,
          record: entityId,
          entity: a1.locator,
          proposed: 'same',
          probabilities: { same: 0.55, 'spec-version': 0.4 },
          reason: 'The names match, and the maker’s does.',
        },
        at: at(index),
      });
    }
    await openReview(db, {
      id: `rv_${datasetId}_classify`,
      datasetId,
      kind: 'classify',
      subject: a2.id,
      itemId: a2.id,
      question: CLASSIFY_QUESTION,
      context: {
        url: a2.locator,
        field: 'category',
        proposed: 'Headphones',
        probabilities: { Headphones: 0.62, 'DAC/Amp': 0.3 },
        reason: 'It sits over the ears.',
      },
      at: at(2),
    });
    await holdSnapshot(db, {
      id: `sn_${datasetId}`,
      datasetId,
      runId: null,
      revision: 1,
      recordCount: 1,
      recordsSha256: `records-${datasetId}`,
      key,
      sha256: await sha256Hex(draft),
      bytes: draft.length,
      heldReason: 'the dataset’s approval is manual',
      report: { excluded: [] },
      at: at(3),
      review: {
        id: `rv_${datasetId}_publish`,
        question: PUBLISH_QUESTION,
        context: { snapshotId: `sn_${datasetId}`, records: 1 },
      },
    });
    return { a1, a2, records };
  });
}

/**
 * A dataset that lists these consumers (crowdio, unless told otherwise), with generation 1
 * published. It opens one database client.
 */
export async function subscribed(datasetId: string, consumers = ['crowdio']): Promise<void> {
  const publishedAt = '2026-10-10T00:00:00.000Z';
  const body = JSON.stringify({
    project: datasetId,
    snapshotId: `sn_${datasetId}`,
    generation: 1,
    publishedAt,
    records: [],
  });
  const key = `datasets/${datasetId}/snapshots/sn_${datasetId}.json`;
  await env.STORE.put(key, body);
  await withDatabase(env, async (db) => {
    await applyDefinition(db, { ...testDefinition(datasetId), consumers });
    await commitSnapshot(db, {
      id: `sn_${datasetId}`,
      datasetId,
      generation: 1,
      runId: null,
      recordCount: 0,
      recordsSha256: 'none',
      key,
      sha256: 'x',
      bytes: body.length,
      publishedAt,
      report: { excluded: [] },
    });
  });
}

/**
 * A dataset whose stored definition no longer passes the checks, as a later version's stricter
 * ones would leave it: the dataset is applied (listing these consumers), and then its stored
 * definition gets a consumer name that fails, beside them. It opens one database client.
 */
export async function staleDataset(datasetId: string, consumers: string[] = []): Promise<void> {
  await withDatabase(env, async (db) => {
    await applyDefinition(db, { ...testDefinition(datasetId), consumers });
    await db
      .update(datasets)
      .set({
        definition: { ...testDefinition(datasetId), consumers: [...consumers, 'Not A Slug'] },
      })
      .where(eq(datasets.id, datasetId));
  });
}

/** POSTs exactly this text, or these bytes, to the dataset's acknowledgments, with these headers. */
export async function post(
  datasetId: string,
  body: string | Uint8Array,
  headers: Record<string, string>,
  using?: Env,
): Promise<Response> {
  return api.request(
    `/datasets/${datasetId}/acknowledgments`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body },
    using ?? (await consumerBindings()),
  );
}

/**
 * The signature header for this text, as its UTF-8 bytes, or for these bytes, under crowdio's key
 * unless told another.
 */
export async function signed(
  body: string | Uint8Array,
  key = CONSUMER_KEY,
): Promise<Record<string, string>> {
  return { 'x-spatula-signature': `sha256=${await hmacSha256Hex(key, body)}` };
}

/** Sends crowdio's acknowledgment, signed unless told not to. */
export async function acknowledge(
  datasetId: string,
  body: Record<string, unknown>,
  sign = true,
): Promise<Response> {
  const text = JSON.stringify(body);
  return post(datasetId, text, {
    authorization: `Bearer ${CONSUMER_TOKEN}`,
    ...(sign ? await signed(text) : {}),
  });
}

export const MINUTE = 60 * 1000;

/** What a consumer says of the first generation of the dataset `subscribed` published. */
export function applied(datasetId: string, more: Record<string, unknown> = {}) {
  return {
    generation: 1,
    snapshotId: `sn_${datasetId}`,
    outcome: 'applied',
    sentAt: new Date().toISOString(),
    ...more,
  };
}
