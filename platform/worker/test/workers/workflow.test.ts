import { runIdFor, sha256Hex, snapshotSchema, type RunSummary } from '@spatula/core';
import { applyDefinition, getRun, latestSnapshot, type Executor } from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { http, HttpResponse, type HttpResponseResolver } from 'msw';
import { describe, expect, it } from 'vitest';
import { withDatabase } from '../../src/database';
import { A1, A2, B1, ROBOTS_OPEN, URLS } from '../pages';
import { network } from './network';

/** The test database, through the Worker's own Hyperdrive binding. */
const withDb = <T>(fn: (db: Executor) => Promise<T>) => withDatabase(env, fn);

const html = (body: string) =>
  new HttpResponse(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('RefreshWorkflow', () => {
  it('refreshes a dataset end to end: pages, Postgres, and a snapshot in R2', async () => {
    const asked: { url: string; agent: string | null }[] = [];
    // Typed by MSW: the Workers runtime's Request declares a generic json(), which MSW's doesn't.
    const answer =
      (body: () => Response): HttpResponseResolver =>
      ({ request }) => {
        asked.push({ url: request.url, agent: request.headers.get('user-agent') });
        return body();
      };
    network.use(
      http.get(
        'https://maker-a.example/robots.txt',
        answer(() => HttpResponse.text(ROBOTS_OPEN)),
      ),
      http.get(
        'https://maker-b.example/robots.txt',
        answer(() => HttpResponse.text('User-agent: *\nDisallow: /cart\n')),
      ),
      http.get(
        URLS.a1,
        answer(() => html(A1())),
      ),
      http.get(
        URLS.a2,
        answer(() => html(A2())),
      ),
      http.get(
        URLS.b1,
        answer(() => html(B1())),
      ),
    );
    const datasetId = 'workers-refresh';
    await withDb((db) => applyDefinition(db, testDefinition(datasetId)));
    const runId = runIdFor(datasetId, new Date());

    const instance = await introspectWorkflowInstance(env.REFRESH, runId);
    try {
      await env.REFRESH.create({ id: runId, params: { runId, datasetId } });
      await instance.waitForStatus('complete');
      // No LLM key in tests, so the LLM step is skipped and the records have no specs.
      expect((await instance.getOutput()) as RunSummary).toMatchObject({
        fetches: { changed: 3 },
        llm: { ran: 0, skipped: 3 },
        entities: { created: 3 },
        snapshot: { published: true, generation: 1, records: 3 },
      });
    } finally {
      await instance.dispose();
    }

    expect(asked.map((sent) => sent.url)).toEqual([
      'https://maker-a.example/robots.txt',
      URLS.a1,
      URLS.a2,
      'https://maker-b.example/robots.txt',
      URLS.b1,
    ]);
    expect(new Set(asked.map((sent) => sent.agent))).toEqual(
      new Set(['Spatula/0.2.0-dev (+https://spatula-platform.salar-sayyad.workers.dev)']),
    );

    await withDb(async (db) => {
      expect(await getRun(db, runId)).toMatchObject({ status: 'complete', summary: { items: 3 } });
      const row = (await latestSnapshot(db, datasetId))!;
      const file = await env.STORE.get(row.key);
      const body = await file!.text();
      expect(await sha256Hex(body)).toBe(row.sha256);
      expect(snapshotSchema.parse(JSON.parse(body)).records).toHaveLength(3);
    });
    expect((await env.STORE.list({ prefix: 'pages/' })).objects).toHaveLength(3);
  });

  it('fails at once, without retrying, when the dataset doesn’t exist', async () => {
    const runId = 'workers-missing-202610100000';
    const instance = await introspectWorkflowInstance(env.REFRESH, runId);
    try {
      await env.REFRESH.create({ id: runId, params: { runId, datasetId: 'workers-missing' } });
      await instance.waitForStatus('errored');
    } finally {
      await instance.dispose();
    }
  });

  it('marks the run failed when a step keeps failing', async () => {
    network.use(
      http.get('https://maker-a.example/robots.txt', () => HttpResponse.text(ROBOTS_OPEN)),
      http.get('https://maker-b.example/robots.txt', () =>
        HttpResponse.text('User-agent: *\nDisallow: /cart\n'),
      ),
      http.get(URLS.a1, () => html(A1())),
      http.get(URLS.a2, () => html(A2())),
      http.get(URLS.b1, () => html(B1())),
    );
    const datasetId = 'workers-failed';
    await withDb((db) => applyDefinition(db, testDefinition(datasetId)));
    const runId = runIdFor(datasetId, new Date());
    const mocked = 'the resolve step was made to fail';

    const instance = await introspectWorkflowInstance(env.REFRESH, runId);
    try {
      // The pages are fetched and read as usual; then the resolve step throws on every attempt.
      // Its retries still happen, but without their delays, which would outlast the test.
      await instance.modify(async (m) => {
        await m.disableRetryDelays();
        await m.mockStepError({ name: 'resolve' }, new Error(mocked));
      });
      await env.REFRESH.create({ id: runId, params: { runId, datasetId } });
      await instance.waitForStatus('errored');
    } finally {
      await instance.dispose();
    }

    // The load step created the run's row, and the fail step closed it.
    await withDb(async (db) => {
      expect(await getRun(db, runId)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining(mocked),
      });
    });
  });
});
