import {
  DIRECTORY_CONTENT_TYPE,
  DIRECTORY_PATH,
  matchQuestion,
  sha256Hex,
  type DatasetStatus,
  type PagesSource,
  type RunSummary,
  type RunView,
} from '@spatula/core';
import {
  applyDefinition,
  closeReview,
  commitSnapshot,
  datasets,
  entities,
  finishRun,
  getDataset,
  getRun,
  holdSnapshot,
  items,
  judgementsFor,
  listLiveItems,
  openReview,
  runs,
  snapshotById,
  snapshots,
  sources,
  startRun,
} from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { introspectWorkflow, introspectWorkflowInstance } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { and, eq, inArray } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { RUN_START_GRACE_MS } from '../../src/api';
import { withDatabase } from '../../src/database';
import { PUBLISH_QUESTION } from '../../src/publish';
import { call, expectNoStore, staleDataset } from './api-support';
import { network } from './network';

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
 * A run's row with no Workflow created for it, started `ago` ms ago. A POST records the run and
 * then creates its Workflow, so one that ended between the two leaves a row like this. Whether
 * the run reads as going is up to the bindings a test calls with: they say what Workflow, if any,
 * is behind the run's ID.
 */
async function runWithoutWorkflow(
  id: string,
  ago: number,
  datasetId = 'api-orphans',
): Promise<void> {
  await withDatabase(env, async (db) => {
    await applyDefinition(db, testDefinition(datasetId));
    await startRun(db, { id, datasetId });
    if (ago > 0) {
      await db
        .update(runs)
        .set({ startedAt: new Date(Date.now() - ago) })
        .where(eq(runs.id, id));
    }
  });
}

/**
 * Runs' rows with no Workflow created for them, as `runWithoutWorkflow` makes them, each in a
 * dataset of its own and started `ago` ms ago, through one database client.
 */
async function runsStartedAgo(
  started: readonly (readonly [id: string, ago: number, datasetId: string])[],
): Promise<void> {
  await withDatabase(env, async (db) => {
    for (const [id, ago, datasetId] of started) {
      await applyDefinition(db, testDefinition(datasetId));
      await startRun(db, { id, datasetId });
      await db
        .update(runs)
        .set({ startedAt: new Date(Date.now() - ago) })
        .where(eq(runs.id, id));
    }
  });
}

/**
 * An hour. The tests write the six hours after which a run whose Workflow no longer reads as going
 * is recorded failed as 6 * HOUR, so a change to the API's RUN_STALE_MS shows.
 */
const HOUR = 60 * 60 * 1000;

/**
 * Bindings whose Workflow binding records the IDs of the instances it is asked to create, and finds
 * instances through `find`. By default it finds none, as the real one finds none it never created.
 */
function recordingWorkflows(
  find: (id: string) => Promise<unknown> = () => Promise.reject(new Error('no such instance')),
): { bindings: Env; created: string[] } {
  const created: string[] = [];
  const bindings = {
    ...env,
    REFRESH: {
      get: find,
      create: async (options: { id: string }) => {
        created.push(options.id);
      },
    },
  } as unknown as Env;
  return { bindings, created };
}

/** Finds a Workflow that is still working for each of these runs, and none for any other. */
function goingWorkflows(...ids: string[]): (id: string) => Promise<unknown> {
  return (id) =>
    ids.includes(id)
      ? Promise.resolve({ status: () => Promise.resolve({ status: 'running' }) })
      : Promise.reject(new Error('no such instance'));
}

/** Finds, for each run named, a Workflow whose status reads as given, and none for any other. */
function workflowsReading(statuses: Record<string, string>): (id: string) => Promise<unknown> {
  return (id) => {
    const status = statuses[id];
    return status === undefined
      ? Promise.reject(new Error('no such instance'))
      : Promise.resolve({ status: () => Promise.resolve({ status }) });
  };
}

/**
 * RFC 9421's Ed25519 test key (appendix B.1.4), as a JWK: published test material, not a key Spatula
 * uses. The key directory's tests sign with it.
 */
const TEST_KEY = JSON.stringify({
  kty: 'OKP',
  crv: 'Ed25519',
  d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU',
  x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
});
/** Its private member, which no answer may quote. */
const KEY_D = (JSON.parse(TEST_KEY) as { d: string }).d;

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

  it('says what it collects and for whom, how it reads and slows down, and whom to write to', async () => {
    // The page's text, with its line breaks collapsed.
    const page = (await (await call('GET', '/', { token: null })).text()).replace(/\s+/gu, ' ');
    expect(page).toContain(
      'names, identifiers such as GTINs and part numbers, and specifications. Prices come later.',
    );
    expect(page).toContain('It collects them for Crowdio, a site about audio gear.');
    expect(page).toContain('It collects facts only, never descriptions or photos.');
    expect(page).toContain(
      'It uses an AI model only to read pages, and nothing it reads is used to train one.',
    );
    expect(page).toContain(
      'It waits 15 seconds between requests to a site for the datasets it keeps today',
    );
    expect(page).toContain(
      'When a site refuses it, it waits twice as long on its next visit, up to four times as long.',
    );
    expect(page).toContain(
      'After three visits in a row that a site refused, it asks for one page a visit until the site answers again.',
    );
    expect(page).toContain('<a href="mailto:bot@spatula.run">bot@spatula.run</a>');
    expect(page).not.toContain('open an issue');
  });

  /** The page's text for these bindings, with its line breaks collapsed. */
  const textWith = async (bindings: Env) =>
    (await (await call('GET', '/', { token: null, bindings })).text()).replace(/\s+/gu, ' ');

  it('says it signs its requests, and where its key is, where it has a key', async () => {
    const page = await textWith({ ...env, WEB_BOT_AUTH_KEY: TEST_KEY } as Env);
    expect(page).toContain(
      'It signs its requests with Web Bot Auth (HTTP Message Signatures), so a site can check that a request naming Spatula came from Spatula.',
    );
    // The link is the route's own path, so the two can't drift apart.
    expect(page).toContain(`<a href="${DIRECTORY_PATH}"><code>${DIRECTORY_PATH}</code></a>`);
  });

  it('says nothing of signing where it has no key, as it signs nothing there', async () => {
    // The Workers tests blank the key, so these bindings have none. Without one nothing is signed
    // and the directory answers 404, so a page that said otherwise would promise more than the code
    // does.
    const page = await textWith(env);
    expect(page).toContain('It collects facts only');
    expect(page).not.toContain('Web Bot Auth');
    expect(page).not.toContain('signs its requests');
    expect(page).not.toContain(DIRECTORY_PATH);
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

    // A consumers' route says so too, rather than telling a consumer its token is wrong.
    const unsetRead = await call('GET', '/datasets/x/snapshots/latest', {
      bindings: { ...env, OWNER_TOKEN_HASH: '' } as Env,
    });
    expect(unsetRead.status).toBe(503);
    expectNoStore(unsetRead);
  });

  it('keep every route under /datasets behind the token', async () => {
    // Every path under /datasets is the owner's, but a consumer's two, which a listed consumer's
    // token opens too. So the guard covers a path that no route answers as well as the routes that
    // follow it, which edit a definition, spend on a run, hand out a snapshot, answer a review
    // question, or read and save scores.
    const requests = [
      ['POST', '/datasets/api-guard/definition'],
      ['PUT', '/datasets/api-guard'],
      ['POST', '/datasets/api-guard/runs'],
      ['GET', '/datasets/api-guard/snapshots/latest'],
      ['POST', '/datasets/api-guard/review/rv_x'],
      ['GET', '/datasets/api-guard/items'],
      ['POST', '/datasets/api-guard/evals'],
      ['GET', '/datasets/api-guard/evals'],
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

  it('start a run that counts every page as due only when asked to', async () => {
    // A Workflow binding that only records what it's asked to create. Each request uses its own
    // dataset, because a second run of one dataset in the same five-minute slot would be refused.
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

  it('refuse a run while another run of the dataset is going, and name it', async () => {
    const datasetId = 'api-one-at-a-time';
    // A run from an earlier slot, whose Workflow is still working.
    const going = `${datasetId}-202601010000`;
    await runWithoutWorkflow(going, HOUR, datasetId);
    const { bindings, created } = recordingWorkflows(goingWorkflows(going));

    const refused = await call('POST', `/datasets/${datasetId}/runs`, { bindings });
    expect(refused.status).toBe(409);
    expectNoStore(refused);
    expect(await refused.json()).toEqual({
      error: `A run of ${datasetId} is already running (${going}, started 1 hour ago). Wait for it to finish.`,
      runId: going,
    });
    // Nothing was recorded for the request, and no Workflow was created.
    expect(created).toEqual([]);
    expect(
      await withDatabase(env, (db) =>
        db.select({ id: runs.id }).from(runs).where(eq(runs.datasetId, datasetId)),
      ),
    ).toEqual([{ id: going }]);
  });

  it('start a run once the one before it has finished', async () => {
    const datasetId = 'api-after-the-last';
    const before = `${datasetId}-202601010000`;
    await runWithoutWorkflow(before, HOUR, datasetId);
    await withDatabase(env, (db) =>
      finishRun(db, before, { status: 'failed', error: 'robots.txt is unreachable' }),
    );
    const { bindings, created } = recordingWorkflows();

    const started = await call('POST', `/datasets/${datasetId}/runs`, { bindings });
    expect(started.status).toBe(202);
    const { runId } = (await started.json()) as { runId: string };
    expect(created).toEqual([runId]);
  });

  it('refuse a run beside one whose Workflow still reads as going, however long it has run', async () => {
    // Each dataset's run started six hours and a minute ago, and its Workflow reads as one of the
    // statuses of a Workflow still at work. The statuses are the Worker's InstanceStatus type's.
    const going = ['queued', 'running', 'waiting', 'paused', 'waitingForPause', 'rollingBack'];
    const datasetOf = (status: string) => `api-long-${status.toLowerCase()}`;
    const runOf = (status: string) => `${datasetOf(status)}-202601010000`;
    await runsStartedAgo(
      going.map((status) => [runOf(status), 6 * HOUR + 60_000, datasetOf(status)] as const),
    );
    const { bindings, created } = recordingWorkflows(
      workflowsReading(Object.fromEntries(going.map((status) => [runOf(status), status] as const))),
    );

    for (const status of going) {
      const refused = await call('POST', `/datasets/${datasetOf(status)}/runs`, { bindings });
      expect(refused.status, status).toBe(409);
      expect(await refused.json(), status).toEqual({
        error: `A run of ${datasetOf(status)} is already running (${runOf(status)}, started 6 hours ago). Wait for it to finish.`,
        runId: runOf(status),
      });
    }
    expect(created).toEqual([]);
    const left = await withDatabase(env, (db) =>
      db
        .select({ id: runs.id, status: runs.status })
        .from(runs)
        .where(inArray(runs.id, going.map(runOf))),
    );
    expect(left).toHaveLength(going.length);
    expect(new Set(left.map((row) => row.status))).toEqual(new Set(['running']));
  });

  it('record a run as failed and start the next once its Workflow has stopped, or past six hours when it reads as neither going nor stopped', async () => {
    const PAST = 6 * HOUR + 60_000;
    // Each dataset's run: how long ago it started, what its Workflow reads (null when none can be
    // found), and what the start that finds it records.
    const healed = [
      [
        'api-past-complete',
        PAST,
        'complete',
        'This run’s Workflow reads complete, though the run never finished, and it started more than 6 hours ago.',
      ],
      [
        'api-past-unknown',
        PAST,
        'unknown',
        'This run’s Workflow reads unknown, though the run never finished, and it started more than 6 hours ago.',
      ],
      ['api-past-lost', PAST, null, 'Spatula can’t find this run’s Workflow: no such instance'],
      ['api-early-errored', HOUR, 'errored', 'The Workflow stopped before the run finished.'],
    ] as const;
    // Within six hours, a Workflow that reads complete still blocks: only a stopped or lost one is
    // recorded failed so soon.
    const early = 'api-early-complete';
    const runOf = (datasetId: string) => `${datasetId}-202601010000`;
    await runsStartedAgo([
      ...healed.map(([datasetId, ago]) => [runOf(datasetId), ago, datasetId] as const),
      [runOf(early), 6 * HOUR - 60_000, early],
    ]);
    const reading: Record<string, string> = { [runOf(early)]: 'complete' };
    for (const [datasetId, , status] of healed) {
      if (status !== null) reading[runOf(datasetId)] = status;
    }
    const { bindings, created } = recordingWorkflows(workflowsReading(reading));

    const started: string[] = [];
    for (const [datasetId] of healed) {
      const response = await call('POST', `/datasets/${datasetId}/runs`, { bindings });
      expect(response.status, datasetId).toBe(202);
      started.push(((await response.json()) as { runId: string }).runId);
    }
    expect(created).toEqual(started);
    const refused = await call('POST', `/datasets/${early}/runs`, { bindings });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ runId: runOf(early) });

    const rows = await withDatabase(env, (db) =>
      db
        .select({ id: runs.id, status: runs.status, error: runs.error })
        .from(runs)
        .where(inArray(runs.id, [...healed.map(([datasetId]) => runOf(datasetId)), runOf(early)])),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [datasetId, , , error] of healed) {
      expect(byId.get(runOf(datasetId)), datasetId).toEqual({
        id: runOf(datasetId),
        status: 'failed',
        error,
      });
    }
    expect(byId.get(runOf(early))).toMatchObject({ status: 'running', error: null });
  });

  it('record a run whose Workflow can’t be found as failed once its slot is over, and start the next', async () => {
    const datasetId = 'api-lost-run';
    const old = `${datasetId}-202601010000`;
    await runWithoutWorkflow(old, RUN_START_GRACE_MS + 60_000, datasetId);
    const { bindings, created } = recordingWorkflows();
    // What the run's status says of it is what a start has to go by: it can't be going.
    const reported = (await (await call('GET', `/runs/${old}`, { bindings })).json()) as RunView;
    expect(reported).toMatchObject({
      status: 'failed',
      error: 'Spatula can’t find this run’s Workflow: no such instance',
    });

    const started = await call('POST', `/datasets/${datasetId}/runs`, { bindings });
    expect(started.status).toBe(202);
    const { runId } = (await started.json()) as { runId: string };
    expect(runId).toMatch(/^api-lost-run-\d{12}$/u);
    expect(runId).not.toBe(old);
    expect(created).toEqual([runId]);
    // The failure the status reported is now the row's own, so the run no longer blocks anything.
    expect(await withDatabase(env, (db) => getRun(db, old))).toMatchObject({
      status: 'failed',
      error: reported.error,
      finishedAt: expect.any(String),
    });
  });

  it('refuse a run beside one whose Workflow may still be on its way, and leave that one alone', async () => {
    const datasetId = 'api-new-run';
    const old = `${datasetId}-202601010000`;
    // Started a minute ago: the POST that recorded it may not have created its Workflow yet.
    await runWithoutWorkflow(old, 60_000, datasetId);
    const { bindings, created } = recordingWorkflows();

    const refused = await call('POST', `/datasets/${datasetId}/runs`, { bindings });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: `A run of ${datasetId} is already running (${old}, started 1 minute ago). Wait for it to finish.`,
      runId: old,
    });
    expect(created).toEqual([]);
    expect(await withDatabase(env, (db) => getRun(db, old))).toMatchObject({
      status: 'running',
      error: null,
      finishedAt: null,
    });
  });

  it('record the dead run in the way, and still refuse when another run is going', async () => {
    const datasetId = 'api-two-in-the-way';
    const going = `${datasetId}-202601010000`;
    const dead = `${datasetId}-202601010100`;
    // A database can hold overlapping runs from before the rule. The newer has lost its Workflow;
    // the older is working.
    await runWithoutWorkflow(going, 2 * HOUR, datasetId);
    await runWithoutWorkflow(dead, HOUR, datasetId);
    const { bindings, created } = recordingWorkflows(goingWorkflows(going));

    // The start finds the newer run, sees it is dead and records that, and tries once more: that
    // attempt finds the older run, and is answered as the first would have been.
    const refused = await call('POST', `/datasets/${datasetId}/runs`, { bindings });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: `A run of ${datasetId} is already running (${going}, started 2 hours ago). Wait for it to finish.`,
      runId: going,
    });
    expect(created).toEqual([]);
    expect(await withDatabase(env, (db) => getRun(db, dead))).toMatchObject({ status: 'failed' });
    expect(await withDatabase(env, (db) => getRun(db, going))).toMatchObject({
      status: 'running',
      error: null,
    });
  });

  it('record a run whose Workflow errored as failed, with the Workflow’s error, and start the next', async () => {
    const datasetId = 'api-errored-run';
    const old = `${datasetId}-202601010000`;
    await runWithoutWorkflow(old, HOUR, datasetId);
    const mocked = 'the resolve step and the fail step were made to fail';
    const instance = await introspectWorkflowInstance(env.REFRESH, old);
    try {
      await instance.modify(async (m) => {
        // The run plans no pages, so it gets as far as the resolve step without the network.
        await m.disableRetryDelays();
        await m.mockStepResult(
          { name: 'load' },
          {
            revision: 1,
            definition: testDefinition(datasetId),
            startedAt: new Date().toISOString(),
          },
        );
        await m.mockStepResult({ name: 'plan' }, { ids: [], due: 0, live: 0 });
        await m.mockStepError({ name: 'resolve' }, new Error(mocked));
        // The fail step is what would close the run's row, so it fails too.
        await m.mockStepError({ name: 'fail' }, new Error(mocked));
      });
      await env.REFRESH.create({ id: old, params: { runId: old, datasetId } });
      await instance.waitForStatus('errored');
      expect(await withDatabase(env, (db) => getRun(db, old))).toMatchObject({
        status: 'running',
      });

      // The real Workflow binding finds the instance and says how it ended; only the creation of
      // the new run's Workflow is recorded instead of done.
      const { bindings, created } = recordingWorkflows((id) => env.REFRESH.get(id));
      const started = await call('POST', `/datasets/${datasetId}/runs`, { bindings });
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };
      expect(created).toEqual([runId]);
      expect(await withDatabase(env, (db) => getRun(db, old))).toMatchObject({
        status: 'failed',
        error: expect.stringContaining(mocked),
        finishedAt: expect.any(String),
      });
    } finally {
      await instance.dispose();
    }
  });

  it('record a run whose Workflow was terminated as failed, and start the next', async () => {
    const datasetId = 'api-terminated-run';
    const old = `${datasetId}-202601010000`;
    await runWithoutWorkflow(old, HOUR, datasetId);
    const instance = await introspectWorkflowInstance(env.REFRESH, old);
    try {
      await instance.modify(async (m) => {
        await m.mockStepResult(
          { name: 'load' },
          {
            revision: 1,
            definition: testDefinition(datasetId),
            startedAt: new Date().toISOString(),
          },
        );
        await m.mockStepResult({ name: 'plan' }, { ids: [], due: 0, live: 0 });
        // The resolve step fails and waits to be tried again, so the run is still going when it
        // is stopped from outside, and a stopped Workflow never gets to its fail step.
        await m.mockStepError({ name: 'resolve' }, new Error('the resolve step was made to fail'));
      });
      await env.REFRESH.create({ id: old, params: { runId: old, datasetId } });
      await instance.waitForStatus('running');
      await (await env.REFRESH.get(old)).terminate();
      await instance.waitForStatus('terminated');
      expect(await withDatabase(env, (db) => getRun(db, old))).toMatchObject({
        status: 'running',
      });

      const { bindings, created } = recordingWorkflows((id) => env.REFRESH.get(id));
      const started = await call('POST', `/datasets/${datasetId}/runs`, { bindings });
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };
      expect(created).toEqual([runId]);
      expect(await withDatabase(env, (db) => getRun(db, old))).toMatchObject({
        status: 'failed',
        error: 'The Workflow stopped before the run finished.',
        finishedAt: expect.any(String),
      });
    } finally {
      await instance.dispose();
    }
  });

  it('say why a dataset’s status can’t be given when its stored definition no longer passes the checks', async () => {
    await staleDataset('api-stale-status');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const refused = await call('GET', '/datasets/api-stale-status/status');
      expect(refused.status).toBe(409);
      expectNoStore(refused);
      expect(await refused.json()).toEqual({
        error:
          'Dataset api-stale-status’s stored definition no longer passes the checks (consumers.0: Use lowercase letters, digits, and hyphens, up to 63 characters.). Apply it again.',
      });
      // The owner fixes it by applying the definition again, so it is an answer, not a failure.
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
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

  it('report a finished run as its row says, whether or not its Workflow can be found', async () => {
    const datasetId = 'api-finished-runs';
    const done = `${datasetId}-202601010000`;
    const failed = `${datasetId}-202601010100`;
    // A Workflow's record doesn't last for ever, and only a run still going is checked against it.
    const summary: RunSummary = {
      items: 0,
      fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
      statements: { added: 0, reseen: 0, withdrawn: 0 },
      llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
      entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
      snapshot: { published: false, reason: 'nothing changed', excluded: [] },
      notes: [],
    };
    await runWithoutWorkflow(done, HOUR, datasetId);
    await runWithoutWorkflow(failed, HOUR, datasetId);
    await withDatabase(env, async (db) => {
      await finishRun(db, done, { status: 'complete', summary });
      await finishRun(db, failed, { status: 'failed', error: 'robots.txt is unreachable' });
    });

    const asked = async (id: string) =>
      (await (
        await call('GET', `/runs/${id}`, { bindings: withoutWorkflows() })
      ).json()) as RunView;
    expect(await asked(done)).toMatchObject({ id: done, status: 'complete', summary, error: null });
    expect(await asked(failed)).toMatchObject({
      id: failed,
      status: 'failed',
      error: 'robots.txt is unreachable',
    });
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

describe('reviving pages', () => {
  it('takes refused pages or named ones, and refuses a body that names neither', async () => {
    await call('PUT', '/datasets/api-revive', { body: testDefinition('api-revive') });
    const revived = await call('POST', '/datasets/api-revive/items/revive', {
      body: { refused: true },
    });
    expect(revived.status).toBe(200);
    expectNoStore(revived);
    expect(await revived.json()).toEqual({ revived: 0 });
    expect((await call('POST', '/datasets/api-revive/items/revive', { body: {} })).status).toBe(
      400,
    );
    expect(
      (
        await call('POST', '/datasets/api-revive/items/revive', {
          body: { refused: true },
          token: null,
        })
      ).status,
    ).toBe(401);

    // These ask for no page, or for more than the route takes: refused set to false, an empty
    // list, a key it doesn't know, and text where an object belongs.
    for (const body of [
      { refused: false },
      { pages: [] },
      { pages: ['https://maker-a.example/products/a1'], everything: true },
      'refused',
    ]) {
      const refused = await call('POST', '/datasets/api-revive/items/revive', { body });
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expectNoStore(refused);
    }
  });

  it('takes at most 1,000 pages, each at most 2,048 characters long', async () => {
    await call('PUT', '/datasets/api-revive-limits', { body: testDefinition('api-revive-limits') });
    const revive = (pages: string[]) =>
      call('POST', '/datasets/api-revive-limits/items/revive', { body: { pages } });
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => `https://maker-a.example/products/p${index}`);
    const prefix = 'https://maker-a.example/';
    const long = (length: number) => `${prefix}${'x'.repeat(length - prefix.length)}`;

    expect((await revive(many(1000))).status).toBe(200);
    const tooMany = await revive(many(1001));
    expect(tooMany.status).toBe(400);
    expectNoStore(tooMany);
    expect((await revive([long(2048)])).status).toBe(200);
    const tooLong = await revive([long(2049)]);
    expect(tooLong.status).toBe(400);
    expectNoStore(tooLong);
  });

  it('answers 404 for a dataset that doesn’t exist, as a run does', async () => {
    const response = await call('POST', '/datasets/api-revive-nothing/items/revive', {
      body: { refused: true },
    });
    expect(response.status).toBe(404);
    expectNoStore(response);
    expect(await response.json()).toEqual({ error: 'Dataset api-revive-nothing doesn’t exist.' });
  });

  it('finds a page by the name its definition gave it, and puts it back to be read', async () => {
    // A pages source keeps a page as the definition wrote it, so that is the name that finds it.
    const written = 'https://MAKER-A.example/products/a1';
    const definition = testDefinition('api-revive-named');
    definition.sources[0] = { ...(definition.sources[0] as PagesSource), pages: [written] };
    await call('PUT', '/datasets/api-revive-named', { body: definition });
    await withDatabase(env, (db) =>
      db
        .update(items)
        .set({ status: 'refused', lastOutcome: 'blocked', outcomeStreak: 3 })
        .where(eq(items.datasetId, 'api-revive-named')),
    );

    const revived = await call('POST', '/datasets/api-revive-named/items/revive', {
      body: { pages: [written, 'not an address'] },
    });
    expect(revived.status).toBe(200);
    expect(await revived.json()).toEqual({ revived: 1 });
    const [item] = await withDatabase(env, (db) =>
      db
        .select({ status: items.status, streak: items.outcomeStreak })
        .from(items)
        .where(and(eq(items.datasetId, 'api-revive-named'), eq(items.locator, written))),
    );
    expect(item).toEqual({ status: 'live', streak: 0 });
    // The dataset's other page wasn't named, so it is still refused.
    const [other] = await withDatabase(env, (db) =>
      db
        .select({ status: items.status })
        .from(items)
        .where(
          and(
            eq(items.datasetId, 'api-revive-named'),
            eq(items.locator, 'https://maker-b.example/products/b1'),
          ),
        ),
    );
    expect(other).toEqual({ status: 'refused' });
  });
});

describe('reviving sources', () => {
  it('shows each source’s standing, and puts a blocked or refused source back', async () => {
    await call('PUT', '/datasets/api-revive-sources', {
      body: testDefinition('api-revive-sources'),
    });
    await withDatabase(env, (db) =>
      db
        .update(sources)
        .set({
          blockedRuns: 3,
          refusedAt: new Date('2026-10-20T08:00:00Z'),
          lastProbeAt: new Date('2026-10-21T08:00:00Z'),
          lastProbe: 'blocked',
        })
        .where(and(eq(sources.datasetId, 'api-revive-sources'), eq(sources.id, 'maker-a'))),
    );
    const live = { blockedRuns: 0, refusedAt: null, lastProbeAt: null, lastProbe: null };
    const standing = async () =>
      ((await (await call('GET', '/datasets/api-revive-sources/status')).json()) as DatasetStatus)
        .sources;
    expect(await standing()).toEqual([
      {
        id: 'maker-a',
        blockedRuns: 3,
        refusedAt: '2026-10-20T08:00:00.000Z',
        lastProbeAt: '2026-10-21T08:00:00.000Z',
        lastProbe: 'blocked',
      },
      { id: 'maker-b', ...live },
    ]);

    // Only maker-a was blocked or refused, so only it counts; a source the dataset lacks is none.
    const revived = await call('POST', '/datasets/api-revive-sources/sources/revive', {
      body: { sources: ['maker-a', 'maker-b', 'nobody'] },
    });
    expect(revived.status).toBe(200);
    expectNoStore(revived);
    expect(await revived.json()).toEqual({ revived: 1 });
    expect(await standing()).toEqual([
      { id: 'maker-a', ...live },
      { id: 'maker-b', ...live },
    ]);
  });

  it('refuses a body that names no source, and answers 404 and 401 as the other routes do', async () => {
    await call('PUT', '/datasets/api-revive-sources-checks', {
      body: testDefinition('api-revive-sources-checks'),
    });
    for (const body of [
      {},
      { sources: [] },
      { sources: [''] },
      { sources: ['maker-a'], all: true },
      'maker-a',
    ]) {
      const refused = await call('POST', '/datasets/api-revive-sources-checks/sources/revive', {
        body,
      });
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expectNoStore(refused);
    }
    const missing = await call('POST', '/datasets/api-revive-sources-nothing/sources/revive', {
      body: { sources: ['maker-a'] },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: 'Dataset api-revive-sources-nothing doesn’t exist.',
    });
    const anonymous = await call('POST', '/datasets/api-revive-sources-checks/sources/revive', {
      body: { sources: ['maker-a'] },
      token: null,
    });
    expect(anonymous.status).toBe(401);
  });
});

describe('verification', () => {
  it('says in the status whether Cloudflare lists Spatula as a verified bot', async () => {
    await call('PUT', '/datasets/api-verified', { body: testDefinition('api-verified') });
    const verified = async (bindings?: Env) =>
      (
        (await (
          await call('GET', '/datasets/api-verified/status', bindings ? { bindings } : {})
        ).json()) as DatasetStatus
      ).verified;
    // wrangler.jsonc says "false" until the owner sets it.
    expect(await verified()).toBe(false);
    // The generated Env types the variable as "false", the value wrangler.jsonc holds, so another
    // value goes through unknown.
    expect(await verified({ ...env, VERIFIED_BOT: 'true' } as unknown as Env)).toBe(true);
    // Anything but "true" reads as not verified.
    expect(await verified({ ...env, VERIFIED_BOT: 'yes' } as unknown as Env)).toBe(false);
  });
});

describe('the key directory', () => {
  it('serves the public key, signed for the host that asked', async () => {
    const response = await call('GET', DIRECTORY_PATH, {
      token: null,
      bindings: { ...env, WEB_BOT_AUTH_KEY: TEST_KEY } as Env,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(DIRECTORY_CONTENT_TYPE);
    const body = (await response.json()) as { keys: JsonWebKey[] };
    expect(body).toEqual({
      keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' }],
    });
    expect(JSON.stringify(body)).not.toContain('"d"');
    const input = response.headers.get('signature-input')!;
    expect(input).toMatch(
      /^sig1=\("@authority";req\);created=\d+;keyid="poqk[^"]+";alg="ed25519";expires=\d+;nonce="[^"]+";tag="http-message-signatures-directory"$/u,
    );
    // The signature checks out against the key it serves, for the host the request named.
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      body.keys[0]!,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const base = `"@authority";req: localhost\n"@signature-params": ${input.slice('sig1='.length)}`;
    const signature = Uint8Array.from(
      atob(response.headers.get('signature')!.slice('sig1=:'.length, -1)),
      (char) => char.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        { name: 'Ed25519' },
        publicKey,
        signature,
        new TextEncoder().encode(base),
      ),
    ).toBe(true);
  });

  it('answers 404 where the Worker has no key', async () => {
    const response = await call('GET', DIRECTORY_PATH, { token: null });
    expect(response.status).toBe(404);
    expectNoStore(response);
    // The route's own answer, not the generic not-found.
    expect(await response.json()).toEqual({
      error: 'This deployment doesn’t sign its requests yet.',
    });
  });

  it('answers 500, quoting nothing, for a private half that isn’t its public half’s', async () => {
    // RFC 8037's test key's public half, with RFC 9421's private half. Node refuses such a pair
    // when it imports it, so core's tests never reach the signature check on the key. Workers
    // import it, and only that check catches it.
    const mismatched = JSON.stringify({
      ...JSON.parse(TEST_KEY),
      x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await call('GET', DIRECTORY_PATH, {
        token: null,
        bindings: { ...env, WEB_BOT_AUTH_KEY: mismatched } as Env,
      });
      expect(response.status).toBe(500);
      expectNoStore(response);
      expect(await response.json()).toEqual({
        error: 'Something went wrong. The Worker’s logs say what.',
      });
      // The logs say what failed, and don't quote the key.
      expect(logged).toHaveBeenCalledWith(
        'API error:',
        'WEB_BOT_AUTH_KEY’s private half (d) doesn’t belong to its public half (x).',
      );
      expect(JSON.stringify(logged.mock.calls)).not.toContain(KEY_D);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('review', () => {
  const CLASSIFY_QUESTION = {
    type: 'choice' as const,
    prompt: 'Which category does the one product this page is about have?',
    options: ['Headphones', 'DAC/Amp', 'None of these'],
  };

  /**
   * The classification question a run asks when its decider isn't sure, about the dataset's first
   * page.
   */
  async function askedAboutAPage(datasetId: string, reviewId: string, at: string) {
    await call('PUT', `/datasets/${datasetId}`, { body: testDefinition(datasetId) });
    const [page] = await withDatabase(env, (db) => listLiveItems(db, datasetId));
    const context = {
      url: page!.locator,
      field: 'category',
      proposed: 'Headphones',
      probabilities: { Headphones: 0.62, 'DAC/Amp': 0.3 },
      reason: 'It sits over the ears.',
    };
    await withDatabase(env, (db) =>
      openReview(db, {
        id: reviewId,
        datasetId,
        kind: 'classify',
        subject: page!.id,
        itemId: page!.id,
        question: CLASSIFY_QUESTION,
        context,
        at: new Date(at),
      }),
    );
    return { page: page!, context };
  }

  /** A snapshot held for the owner, its records in R2 where a run puts them. */
  async function heldSnapshot(datasetId: string, id: string, at: string) {
    const key = `datasets/${datasetId}/held/${id}.json`;
    const draft = JSON.stringify({
      project: datasetId,
      snapshotId: id,
      records: [{ canonicalId: `sp_${id}`, fields: { name: 'A1' }, provenance: {} }],
    });
    await env.STORE.put(key, draft);
    const context = {
      snapshotId: id,
      records: 1,
      added: 1,
      removed: 0,
      reasons: ['the dataset’s approval is manual'],
      previousGeneration: null,
      incomplete: 0,
      openClassify: 0,
      openMatch: 0,
    };
    await withDatabase(env, async (db) =>
      holdSnapshot(db, {
        id,
        datasetId,
        runId: null,
        revision: 1,
        recordCount: 1,
        recordsSha256: `records-${id}`,
        key,
        sha256: await sha256Hex(draft),
        bytes: draft.length,
        heldReason: 'the dataset’s approval is manual',
        report: { excluded: [] },
        at: new Date(at),
        review: { id: `rv_${id}`, question: PUBLISH_QUESTION, context },
      }),
    );
    return { reviewId: `rv_${id}`, context };
  }

  it('lists open questions, and refuses answers that aren’t options or aren’t open', async () => {
    await call('PUT', '/datasets/api-review', { body: testDefinition('api-review') });
    const listed = await call('GET', '/datasets/api-review/review');
    expect(listed.status).toBe(200);
    expectNoStore(listed);
    expect(await listed.json()).toEqual({ reviews: [] });

    const answer = (body: unknown) => call('POST', '/datasets/api-review/review/rv_none', { body });
    expect((await answer({ answer: 'same' })).status).toBe(404);
    expect((await answer('not json')).status).toBe(400);
    expect((await answer({ answer: 'same', extra: 1 })).status).toBe(400);
    expect((await call('GET', '/datasets/api-review/review', { token: null })).status).toBe(401);
  });

  it('lists the questions that wait, oldest first, with what each proposes', async () => {
    const datasetId = 'api-review-list';
    const { page, context } = await askedAboutAPage(
      datasetId,
      'rv_api_classify',
      '2026-10-10T00:00:00.000Z',
    );
    const held = await heldSnapshot(datasetId, 'sn_api_listed', '2026-10-10T00:01:00.000Z');
    const listed = await call('GET', `/datasets/${datasetId}/review`);
    expect(listed.status).toBe(200);
    expectNoStore(listed);
    expect(await listed.json()).toEqual({
      reviews: [
        {
          id: 'rv_api_classify',
          kind: 'classify',
          subject: page.id,
          question: CLASSIFY_QUESTION,
          context,
          createdAt: '2026-10-10T00:00:00.000Z',
        },
        {
          id: held.reviewId,
          kind: 'publication',
          subject: 'sn_api_listed',
          question: PUBLISH_QUESTION,
          context: held.context,
          createdAt: '2026-10-10T00:01:00.000Z',
        },
      ],
    });
    // Another dataset's questions aren't this one's.
    await call('PUT', '/datasets/api-review-other', { body: testDefinition('api-review-other') });
    expect(await (await call('GET', '/datasets/api-review-other/review')).json()).toEqual({
      reviews: [],
    });
  });

  it('answers 404 for a dataset that doesn’t exist, as a run does, not an empty list', async () => {
    const response = await call('GET', '/datasets/api-review-nothing/review');
    expect(response.status).toBe(404);
    expectNoStore(response);
    expect(await response.json()).toEqual({ error: 'Dataset api-review-nothing doesn’t exist.' });
  });

  it('refuses an answer that isn’t an option, one for a question answered already, and one it can’t read', async () => {
    const datasetId = 'api-review-refused';
    await askedAboutAPage(datasetId, 'rv_api_refused', '2026-10-10T00:00:00.000Z');
    const path = `/datasets/${datasetId}/review/rv_api_refused`;

    const notAnOption = await call('POST', path, { body: { answer: 'Speakers' } });
    expect(notAnOption.status).toBe(400);
    expectNoStore(notAnOption);
    expect(await notAnOption.json()).toEqual({
      error: 'Answer with one of: Headphones, DAC/Amp, None of these.',
    });
    // It was refused, so the question still waits.
    const waiting = await call('GET', `/datasets/${datasetId}/review`);
    expect(((await waiting.json()) as { reviews: unknown[] }).reviews).toHaveLength(1);

    // These aren't answers: nothing, too little or too much, text that isn't an answer's shape, or
    // not JSON at all.
    for (const body of [
      {},
      { answer: '' },
      { answer: 'x'.repeat(601) },
      { answer: 1 },
      '"DAC/Amp"',
    ]) {
      const refused = await call('POST', path, { body });
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expectNoStore(refused);
      expect(await refused.json(), JSON.stringify(body)).toEqual({
        error: 'Send { "answer": one of the question’s options }.',
      });
    }
    const notJson = await call('POST', path, { body: 'DAC/Amp' });
    expect(notJson.status).toBe(400);
    expectNoStore(notJson);
    expect(await notJson.json()).toEqual({ error: 'The body isn’t JSON.' });

    // Only the owner answers, and only for the dataset the question is about.
    const unsigned = await call('POST', path, { body: { answer: 'DAC/Amp' }, token: null });
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get('www-authenticate')).toBe('Bearer');
    expectNoStore(unsigned);
    const elsewhere = await call('POST', '/datasets/api-review/review/rv_api_refused', {
      body: { answer: 'DAC/Amp' },
    });
    expect(elsewhere.status).toBe(404);
    expectNoStore(elsewhere);
    expect(await elsewhere.json()).toEqual({ error: 'No such question for this dataset.' });

    await withDatabase(env, (db) =>
      closeReview(db, {
        id: 'rv_api_refused',
        status: 'decided',
        answer: 'Headphones',
        at: new Date('2026-10-10T00:02:00.000Z'),
      }),
    );
    const closed = await call('POST', path, { body: { answer: 'DAC/Amp' } });
    expect(closed.status).toBe(409);
    expectNoStore(closed);
    expect(await closed.json()).toEqual({ error: 'That question has been answered already.' });
  });

  it('records a person’s match verdict, and refuses a second “same” for the page', async () => {
    const datasetId = 'api-review-match';
    await call('PUT', `/datasets/${datasetId}`, { body: testDefinition(datasetId) });
    const [page] = await withDatabase(env, (db) => listLiveItems(db, datasetId));
    // Two records the page might be, each with a question for a person.
    const records = ['sp_api_match_one', 'sp_api_match_two'];
    await withDatabase(env, async (db) => {
      await db
        .insert(entities)
        .values(records.map((id) => ({ id, datasetId, recordType: 'product' })));
      for (const [index, entityId] of records.entries()) {
        await openReview(db, {
          id: `rv_api_match_${index}`,
          datasetId,
          kind: 'match',
          subject: `${page!.id}|${entityId}`,
          itemId: page!.id,
          entityId,
          question: matchQuestion(),
          context: { page: page!.locator, entity: page!.locator, proposed: 'same' },
          at: new Date('2026-10-10T00:00:00.000Z'),
        });
      }
    });
    const answer = (index: number, value: string) =>
      call('POST', `/datasets/${datasetId}/review/rv_api_match_${index}`, {
        body: { answer: value },
      });

    const first = await answer(0, 'same');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      answered: 'rv_api_match_0',
      answer: 'same',
      effect: 'The page joins that record at the next run.',
    });
    // A page joins one record, so the same word about the other is refused, and its question waits.
    const second = await answer(1, 'same');
    expect(second.status).toBe(409);
    expectNoStore(second);
    expect(await second.json()).toEqual({
      error: `A person already said this page is the same product as ${records[0]}, and a page joins one record. Answer variant or different.`,
    });
    expect((await answer(1, 'variant')).status).toBe(200);
    expect(await withDatabase(env, (db) => judgementsFor(db, datasetId))).toMatchObject([
      { itemId: page!.id, entityId: records[0], verdict: 'same', who: 'person' },
      { itemId: page!.id, entityId: records[1], verdict: 'not_same', who: 'person' },
    ]);
  });

  it('publishes a held snapshot when the owner says so, and discards the next', async () => {
    const datasetId = 'api-review-publish';
    await call('PUT', `/datasets/${datasetId}`, { body: testDefinition(datasetId) });
    const first = await heldSnapshot(datasetId, 'sn_api_first', '2026-10-10T00:00:00.000Z');
    const published = await call('POST', `/datasets/${datasetId}/review/${first.reviewId}`, {
      body: { answer: 'publish' },
    });
    expect(published.status).toBe(200);
    expectNoStore(published);
    expect(await published.json()).toEqual({
      answered: first.reviewId,
      answer: 'publish',
      effect: 'Published as generation 1.',
    });
    // The consumer's route serves what was held, as generation 1.
    const served = await call('GET', `/datasets/${datasetId}/snapshots/latest`);
    expect(served.status).toBe(200);
    expect(served.headers.get('x-spatula-generation')).toBe('1');
    expect(served.headers.get('x-spatula-snapshot-id')).toBe('sn_api_first');
    const file = (await served.json()) as { publishedAt: string };
    expect(file).toMatchObject({
      project: datasetId,
      generation: 1,
      records: [{ canonicalId: 'sp_sn_api_first' }],
    });
    // It was published when the owner said so, not when it was held.
    expect(Math.abs(Date.now() - Date.parse(file.publishedAt))).toBeLessThan(60_000);

    const second = await heldSnapshot(datasetId, 'sn_api_second', '2026-10-10T00:05:00.000Z');
    const discarded = await call('POST', `/datasets/${datasetId}/review/${second.reviewId}`, {
      body: { answer: 'discard' },
    });
    expect(discarded.status).toBe(200);
    expect(await discarded.json()).toEqual({
      answered: second.reviewId,
      answer: 'discard',
      effect: 'The held snapshot is discarded.',
    });
    expect((await withDatabase(env, (db) => snapshotById(db, 'sn_api_second')))?.state).toBe(
      'discarded',
    );
    // Neither is waiting any more, and an answer sent again finds its question closed.
    expect(await (await call('GET', `/datasets/${datasetId}/review`)).json()).toEqual({
      reviews: [],
    });
    const again = await call('POST', `/datasets/${datasetId}/review/${second.reviewId}`, {
      body: { answer: 'discard' },
    });
    expect(again.status).toBe(409);
    expectNoStore(again);
    expect(await again.json()).toEqual({ error: 'That question has been answered already.' });
  });

  it('refuses to publish a snapshot that isn’t held any more, and says what became of it', async () => {
    const datasetId = 'api-review-stale';
    await call('PUT', `/datasets/${datasetId}`, { body: testDefinition(datasetId) });
    const held = await heldSnapshot(datasetId, 'sn_api_stale', '2026-10-10T00:00:00.000Z');
    // A newer run replaced it, and its question is still open for the moment the answer arrives.
    await withDatabase(env, (db) =>
      db.update(snapshots).set({ state: 'superseded' }).where(eq(snapshots.id, 'sn_api_stale')),
    );
    const stale = await call('POST', `/datasets/${datasetId}/review/${held.reviewId}`, {
      body: { answer: 'publish' },
    });
    expect(stale.status).toBe(409);
    expectNoStore(stale);
    expect(await stale.json()).toEqual({ error: 'A newer run replaced that snapshot.' });
    expect((await withDatabase(env, (db) => snapshotById(db, 'sn_api_stale')))?.state).toBe(
      'superseded',
    );
  });
});
