import { sha256Hex, type RunView } from '@spatula/core';
import { commitSnapshot, datasets, getDataset, getRun, runs, startRun } from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { introspectWorkflow } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { api, RUN_START_GRACE_MS } from '../../src/api';
import { withDatabase } from '../../src/database';
import { network } from './network';

/**
 * Calls the API as the owner, unless told to send another token, none, or a whole authorization
 * header. A string body goes as is.
 */
function call(
  method: string,
  path: string,
  options: {
    body?: unknown;
    token?: string | null;
    authorization?: string;
    bindings?: Env;
  } = {},
): Promise<Response> {
  const headers = new Headers();
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
function expectNoStore(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
}

/**
 * How long a run ID's slot lasts. Core's runIdFor (platform/core/src/ids.ts) puts every run in a
 * five-minute slot, and doesn't export the length.
 */
const SLOT_MS = 5 * 60 * 1000;
/** What a slot needs left before requests that must share it are sent. They take far less. */
const SLOT_ROOM_MS = 10_000;

/** Waits for the next slot to start when this one has less than SLOT_ROOM_MS left. */
async function untilSlotHasRoom(): Promise<void> {
  const left = () => SLOT_MS - (Date.now() % SLOT_MS);
  while (left() < SLOT_ROOM_MS) await scheduler.wait(left());
}

/**
 * Bindings whose Workflow binding has no instance to give: `get` rejects, as the real one does for
 * an ID it never created. The real one prints a few lines of workerd noise each time, and a fake
 * lets the test name the error.
 */
const withoutWorkflows = (): Env =>
  ({
    ...env,
    REFRESH: { get: () => Promise.reject(new Error('no such instance')) },
  }) as unknown as Env;

/**
 * A run's row with no Workflow behind it, started `ago` ms ago. A POST records the run and then
 * creates its Workflow, so one that ended between the two leaves a row like this.
 */
async function runWithoutWorkflow(id: string, ago: number): Promise<void> {
  const datasetId = 'api-orphans';
  await call('PUT', `/datasets/${datasetId}`, { body: testDefinition(datasetId) });
  await withDatabase(env, async (db) => {
    await startRun(db, { id, datasetId });
    if (ago > 0) {
      await db
        .update(runs)
        .set({ startedAt: new Date(Date.now() - ago) })
        .where(eq(runs.id, id));
    }
  });
}

describe('the public page', () => {
  it('tells anyone what Spatula is and how to opt out', async () => {
    const response = await call('GET', '/', { token: null });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const page = await response.text();
    expect(page).toContain('Spatula 0.2.0-dev');
    expect(page).toContain('User-agent: Spatula');
  });

  it('escapes the version it prints', async () => {
    const pageFor = async (version: string) =>
      (
        await call('GET', '/', {
          token: null,
          bindings: { ...env, SPATULA_VERSION: version } as Env,
        })
      ).text();
    const markup = await pageFor('1<b>');
    expect(markup).toContain('Spatula 1&lt;b&gt;');
    expect(markup).not.toContain('1<b>');
    // All five characters, "&" among them, so a replacement that comes first isn't escaped again.
    expect(await pageFor(`a&b<c>d"e'f`)).toContain('Spatula a&amp;b&lt;c&gt;d&quot;e&#39;f keeps');
  });

  it('says what it does with robots.txt and with Content Signals', async () => {
    // The page's text, with its line breaks collapsed.
    const page = (await (await call('GET', '/', { token: null })).text()).replace(/\s+/gu, ' ');
    expect(page).toContain(
      "While a site's robots.txt can't be reached, or answers with a server error or 429, it fetches nothing from that site. A site with no robots.txt (any other 4xx answer) has no rules for it.",
    );
    expect(page).toContain(
      "it reads a page with an AI model unless the site's Content Signals say <code>ai-input=no</code>.",
    );
    // What it said before promised more than the code does.
    expect(page).not.toContain("robots.txt can't be read");
    expect(page).not.toContain('only where the site allows');
  });
});

describe('the Worker’s entry', () => {
  it('serves the public page, and keeps the owner routes behind the token', async () => {
    // Not api.request: this calls the Worker's own default export, the way the platform does, so
    // a wrong export in index.ts fails here.
    const page = await exports.default.fetch('https://spatula.example/');
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('Spatula 0.2.0-dev');
    expect(text).toContain('User-agent: Spatula');

    expect((await exports.default.fetch('https://spatula.example/runs/x')).status).toBe(401);
  });
});

describe('the answers that aren’t the page', () => {
  it('keep an unknown path’s 404 out of every cache, with or without a token', async () => {
    for (const response of [
      await call('GET', '/nowhere', { token: null }),
      await call('GET', '/nowhere'),
    ]) {
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({ error: 'Not found.' });
    }
  });

  it('keep a failure’s 500 out of every cache, and log what failed', async () => {
    // The page reads the version from the bindings, so bindings that throw make it fail. It is
    // outside the owner routes, so nothing but the error handler can mark the answer.
    const broken = {
      get SPATULA_VERSION(): string {
        throw new Error('the version could not be read');
      },
    } as unknown as Env;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await call('GET', '/', { token: null, bindings: broken });
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({
        error: 'Something went wrong. The Worker’s logs say what.',
      });
      expect(logged).toHaveBeenCalledWith('API error:', 'the version could not be read');
    } finally {
      logged.mockRestore();
    }
  });
});

describe('the owner routes', () => {
  it('answer only the owner, and say so when no owner is set', async () => {
    const missing = await call('GET', '/runs/nothing', { token: null });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect((await call('GET', '/runs/nothing', { token: 'wrong' })).status).toBe(401);
    expect((await call('GET', '/runs/nothing')).status).toBe(404);

    const unset = await call('GET', '/runs/nothing', {
      bindings: { ...env, OWNER_TOKEN_HASH: '' } as Env,
    });
    expect(unset.status).toBe(503);
    expect(unset.headers.get('cache-control')).toBe('private, no-store');
  });

  it('keep every route under /datasets behind the token', async () => {
    // The guard is on the prefix, so it covers a path that no route answers as well as the three
    // that follow it, which edit a definition, spend on a run, and hand out a snapshot.
    const requests = [
      ['POST', '/datasets/api-guard/definition'],
      ['PUT', '/datasets/api-guard'],
      ['POST', '/datasets/api-guard/runs'],
      ['GET', '/datasets/api-guard/snapshots/latest'],
    ] as const;
    for (const [method, path] of requests) {
      for (const token of [null, 'wrong']) {
        const response = await call(method, path, { token });
        expect(response.status, `${method} ${path} with ${token ?? 'no token'}`).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe('Bearer');
        expectNoStore(response);
      }
    }
  });

  it('read the scheme in any case, and the token exactly', async () => {
    // RFC 9110 makes an authentication scheme's name case-insensitive. The token is a secret, so
    // its case counts. A run that doesn't exist is what an accepted token gets (404).
    const attempt = (authorization: string) => call('GET', '/runs/nothing', { authorization });
    expect((await attempt('bearer test-token')).status).toBe(404);
    expect((await attempt('BEARER test-token')).status).toBe(404);
    expect((await attempt('Bearer TEST-TOKEN')).status).toBe(401);
  });

  it('refuse a dryRun that is neither 1 nor 0, and apply nothing', async () => {
    const definition = testDefinition('api-dry-flag');
    const refused = await call('PUT', '/datasets/api-dry-flag?dryRun=true', { body: definition });
    expect(refused.status).toBe(400);
    expectNoStore(refused);
    expect(await refused.json()).toEqual({ error: 'dryRun is 1 or 0.' });
    expect(await withDatabase(env, (db) => getDataset(db, 'api-dry-flag'))).toBeNull();

    // 0 applies, as no dryRun does; it is the first time this dataset is written.
    const applied = await call('PUT', '/datasets/api-dry-flag?dryRun=0', { body: definition });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ created: true, changed: true });
  });

  it('preview a definition, apply it, and refuse broken ones', async () => {
    const definition = testDefinition('api-definitions');
    const preview = await call('PUT', '/datasets/api-definitions?dryRun=1', { body: definition });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('cache-control')).toBe('private, no-store');
    expect(await preview.json()).toMatchObject({
      dataset: 'api-definitions',
      revision: 1,
      created: true,
      pages: { added: 3 },
    });
    expect(
      await (await call('PUT', '/datasets/api-definitions', { body: definition })).json(),
    ).toMatchObject({
      created: true,
      changed: true,
    });
    expect(
      await (await call('PUT', '/datasets/api-definitions', { body: definition })).json(),
    ).toMatchObject({
      created: false,
      changed: false,
    });

    const elsewhere = await call('PUT', '/datasets/somewhere-else', { body: definition });
    expect(elsewhere.status).toBe(400);
    expectNoStore(elsewhere);
    expect(await elsewhere.json()).toEqual({
      error: 'The definition has problems.',
      issues: ['dataset: it says api-definitions, but the address says somewhere-else'],
    });

    const training = { ...definition, policy: { purposes: ['ai-train'], perHostIntervalMs: 1000 } };
    const refused = await call('PUT', '/datasets/api-definitions', { body: training });
    expect(refused.status).toBe(400);
    expectNoStore(refused);
    expect(await refused.json()).toMatchObject({
      issues: [expect.stringMatching(/^policy\.purposes/u)],
    });

    const noPack = {
      ...definition,
      recordTypes: { product: { ...definition.recordTypes.product!, pack: 'products/nothing' } },
    };
    const unknownPack = await call('PUT', '/datasets/api-definitions', { body: noPack });
    expect(unknownPack.status).toBe(400);
    expectNoStore(unknownPack);
    const notJson = await call('PUT', '/datasets/api-definitions', {
      body: 'dataset: api-definitions',
    });
    expect(notJson.status).toBe(400);
    expectNoStore(notJson);
    expect(await notJson.json()).toEqual({ error: 'The body isn’t JSON.' });
  });

  it('start one run per five-minute slot, and report it', async () => {
    await call('PUT', '/datasets/api-runs', { body: testDefinition('api-runs') });
    const introspector = await introspectWorkflow(env.REFRESH);
    try {
      // The run plans no pages, so it finishes without the network.
      await introspector.modifyAll(async (m) => {
        await m.mockStepResult(
          { name: 'load' },
          {
            revision: 1,
            definition: testDefinition('api-runs'),
            startedAt: new Date().toISOString(),
          },
        );
        await m.mockStepResult({ name: 'plan' }, { ids: [], due: 0, live: 0 });
      });
      // The two POSTs below must land in one slot, so they aren't sent in the last seconds of one.
      await untilSlotHasRoom();
      const started = await call('POST', '/datasets/api-runs/runs');
      expect(started.status).toBe(202);
      expectNoStore(started);
      const { runId } = (await started.json()) as { runId: string };
      expect(runId).toMatch(/^api-runs-\d{12}$/u);
      expect(started.headers.get('location')).toBe(`/runs/${runId}`);

      const twice = await call('POST', '/datasets/api-runs/runs');
      expect(twice.status).toBe(409);
      expectNoStore(twice);
      expect(await twice.json()).toEqual({
        error: 'A run already started in this five-minute slot.',
        runId,
      });

      const [instance] = await introspector.get();
      await instance!.waitForStatus('complete');
      const run = (await (await call('GET', `/runs/${runId}`)).json()) as RunView;
      expect(run).toMatchObject({
        id: runId,
        datasetId: 'api-runs',
        status: 'complete',
        summary: { items: 0 },
      });
    } finally {
      await introspector.dispose();
    }
    expect((await call('POST', '/datasets/nothing-here/runs')).status).toBe(404);
    expect((await call('POST', '/datasets/api-runs/runs?all=yes')).status).toBe(400);
  });

  it('start a run that reads every page only when asked to', async () => {
    // A Workflow binding that only records what it's asked to create. Each dataset has a run of its
    // own, so none of them shares a five-minute slot with another.
    const created: { params: unknown }[] = [];
    const bindings = {
      ...env,
      REFRESH: {
        create: async (options: { params: unknown }) => {
          created.push(options);
        },
      },
    } as unknown as Env;
    for (const [dataset, query] of [
      ['api-all-on', '?all=1'],
      ['api-all-off', '?all=0'],
      ['api-all-unset', ''],
    ] as const) {
      await call('PUT', `/datasets/${dataset}`, { body: testDefinition(dataset) });
      const started = await call('POST', `/datasets/${dataset}/runs${query}`, { bindings });
      expect(started.status).toBe(202);
    }
    expect(created.map(({ params }) => params)).toMatchObject([
      { datasetId: 'api-all-on', all: true },
      { datasetId: 'api-all-off', all: false },
      { datasetId: 'api-all-unset', all: false },
    ]);
  });

  it('refuse a run, and say why, when the stored definition no longer passes the checks', async () => {
    await call('PUT', '/datasets/api-stale', { body: testDefinition('api-stale') });
    // A later version's stricter checks would leave a stored definition like this one.
    await withDatabase(env, (db) =>
      db
        .update(datasets)
        .set({ definition: { ...testDefinition('api-stale'), consumers: ['Not A Slug'] } })
        .where(eq(datasets.id, 'api-stale')),
    );
    const refused = await call('POST', '/datasets/api-stale/runs');
    expect(refused.status).toBe(409);
    expectNoStore(refused);
    expect(await refused.json()).toEqual({
      error:
        'Dataset api-stale’s stored definition no longer passes the checks (consumers.0: Use lowercase letters, digits, and hyphens, up to 63 characters.). Apply it again.',
    });
    // The dataset can't run, so no run was recorded for it.
    expect(
      await withDatabase(env, (db) =>
        db.select().from(runs).where(eq(runs.datasetId, 'api-stale')),
      ),
    ).toEqual([]);
  });

  it('report a run that is still going as running', async () => {
    // One page, on a host no other test uses: HostGate keeps each host's robots.txt between tests,
    // and this test needs the run to ask for it.
    const base = testDefinition('api-inflight');
    const definition = {
      ...base,
      sources: [{ ...base.sources[0]!, pages: ['https://inflight.example/products/i1'] }],
    };
    await call('PUT', '/datasets/api-inflight', { body: definition });

    // The run's first request is for that robots.txt. The answer is held until the test lets go, so
    // the run can't have finished before the test has looked at it. The two sides signal each other
    // through plain flags that each polls on its own timers: a test that awaited a promise the
    // Workflow resolves froze when the Workflow was disposed at the end.
    const hold = { asked: false, letGo: false };
    network.use(
      http.get('https://inflight.example/robots.txt', async () => {
        hold.asked = true;
        while (!hold.letGo) await scheduler.wait(5);
        return HttpResponse.text('User-agent: *\nDisallow: /\n');
      }),
    );

    const introspector = await introspectWorkflow(env.REFRESH);
    try {
      const started = await call('POST', '/datasets/api-inflight/runs');
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };
      await vi.waitFor(() => expect(hold.asked).toBe(true), { timeout: 10_000 });

      const going = await call('GET', `/runs/${runId}`);
      expect(going.status).toBe(200);
      expect(await going.json()).toMatchObject({
        id: runId,
        status: 'running',
        finishedAt: null,
        summary: null,
        error: null,
      });

      // Let go: robots.txt now refuses the page, and the run finishes.
      hold.letGo = true;
      const [instance] = await introspector.get();
      await instance!.waitForStatus('complete');
      const done = (await (await call('GET', `/runs/${runId}`)).json()) as RunView;
      expect(done).toMatchObject({ status: 'complete', summary: { fetches: { blocked: 1 } } });
    } finally {
      hold.letGo = true;
      await introspector.dispose();
    }
  });

  it('report a run with no Workflow as failed once its slot is over, and leave its row alone', async () => {
    const id = 'api-orphans-old';
    await runWithoutWorkflow(id, RUN_START_GRACE_MS + 60_000);

    const response = await call('GET', `/runs/${id}`, { bindings: withoutWorkflows() });
    expect(response.status).toBe(200);
    const run = (await response.json()) as RunView;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Spatula can’t find this run’s Workflow: no such instance');
    // Only the answer says so: the stored row is as it was.
    expect(await withDatabase(env, (db) => getRun(db, id))).toMatchObject({
      status: 'running',
      error: null,
    });
  });

  it('report a run with no Workflow as running while its POST may still be creating one', async () => {
    const id = 'api-orphans-new';
    await runWithoutWorkflow(id, 0);

    const response = await call('GET', `/runs/${id}`, { bindings: withoutWorkflows() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, status: 'running', error: null });
  });

  it('serve a snapshot with its hash and generation', async () => {
    await call('PUT', '/datasets/api-snapshots', { body: testDefinition('api-snapshots') });
    const publishedAt = '2026-10-10T00:00:00.000Z';
    const body = JSON.stringify({
      project: 'api-snapshots',
      snapshotId: 'sn_test',
      generation: 1,
      publishedAt,
      records: [],
    });
    const key = 'datasets/api-snapshots/snapshots/sn_test.json';
    const sha256 = await sha256Hex(body);
    await env.STORE.put(key, body);
    await withDatabase(env, (db) =>
      commitSnapshot(db, {
        id: 'sn_test',
        datasetId: 'api-snapshots',
        generation: 1,
        runId: null,
        recordCount: 0,
        recordsSha256: 'none',
        key,
        sha256,
        bytes: body.length,
        publishedAt,
        report: { excluded: [] },
      }),
    );

    for (const which of ['latest', '1']) {
      const response = await call('GET', `/datasets/api-snapshots/snapshots/${which}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-spatula-sha256')).toBe(sha256);
      expect(response.headers.get('x-spatula-generation')).toBe('1');
      expect(response.headers.get('x-spatula-snapshot-id')).toBe('sn_test');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.text()).toBe(body);
    }
    expect((await call('GET', '/datasets/api-snapshots/snapshots/2')).status).toBe(404);
    expect((await call('GET', '/datasets/api-snapshots/snapshots/first')).status).toBe(400);

    // A generation too large for Postgres's integer column is refused here, as a 400, rather than
    // reaching the query, where the database would reject it and the route would answer 500.
    const tooBig = await call('GET', '/datasets/api-snapshots/snapshots/9999999999');
    expect(tooBig.status).toBe(400);
    expectNoStore(tooBig);
    expect(await tooBig.json()).toEqual({
      error: 'A generation is a whole number from 1, or latest.',
    });
    // The largest one the route accepts does reach the query, and is simply not found.
    expect((await call('GET', '/datasets/api-snapshots/snapshots/999999999')).status).toBe(404);
  });

  it('answer 500, and log it, when a snapshot’s file is gone from R2', async () => {
    await call('PUT', '/datasets/api-lost-file', { body: testDefinition('api-lost-file') });
    const key = 'datasets/api-lost-file/snapshots/sn_lost.json';
    await env.STORE.put(key, '{}');
    await withDatabase(env, (db) =>
      commitSnapshot(db, {
        id: 'sn_lost',
        datasetId: 'api-lost-file',
        generation: 1,
        runId: null,
        recordCount: 0,
        recordsSha256: 'none',
        key,
        sha256: 'none',
        bytes: 2,
        publishedAt: '2026-10-10T00:00:00.000Z',
        report: { excluded: [] },
      }),
    );
    await env.STORE.delete(key);

    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await call('GET', '/datasets/api-lost-file/snapshots/latest');
      expect(response.status).toBe(500);
      expectNoStore(response);
      expect(await response.json()).toEqual({
        error: 'Something went wrong. The Worker’s logs say what.',
      });
      expect(logged).toHaveBeenCalledWith(
        'API error:',
        'The file for snapshot sn_lost is missing from R2',
      );
    } finally {
      logged.mockRestore();
    }
  });
});
