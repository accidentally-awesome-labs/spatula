import { gzip, runIdFor, sha256Hex, type ReviewView } from '@spatula/core';
import {
  applyDefinition,
  items,
  recordCapture,
  recordFetch,
  seedTaxonomyVersion,
  startRun,
} from '@spatula/store';
import { testDefinition, testTaxonomy, testTaxonomyDefinition } from '@spatula/store/fixtures';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { sign } from 'hono/jwt';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { api } from '../../src/api';
import { CAPTURE_HEADERS } from '../../src/capture-api';
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_SCRIPT } from '../../src/console/page';
import { CONSOLE_CSP } from '../../src/console/routes';
import { withDatabase } from '../../src/database';
import { pageKey } from '../../src/pipeline';
import { A1, A2, B1, ROBOTS_OPEN, URLS } from '../pages';
import { expectNoStore } from './api-support';
import { network } from './network';

/*
 * The console in the Worker (ADR 0009): its files and its API behind Cloudflare Access, and the
 * owner's capture route. These tests play Access with a key of their own, whose public half msw
 * serves where Access publishes its keys. The team and the key's ID are this file's alone.
 */

const ORIGIN = 'https://spatula.run';
const TEAM = 'https://console-tests.cloudflareaccess.com';
const AUDIENCE = 'console-tests-audience';
const OWNER = 'owner@example.com';
const KEY_ID = 'console-tests';
const CONSUMER_TOKEN = 'crowdio-console-token';

type KeyPair = { privateJwk: JsonWebKey; publicJwk: JsonWebKey };
let keys: Promise<KeyPair> | undefined;

/** The key Access signs with here, made on first use: workerd makes no key while it loads. */
function accessKeys(): Promise<KeyPair> {
  keys ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    return {
      privateJwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey,
      publicJwk: (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey,
    };
  })();
  return keys;
}

/** Serves the team's public key where Access publishes it. */
async function serveAccess(): Promise<void> {
  const { publicJwk } = await accessKeys();
  network.use(
    http.get(`${TEAM}/cdn-cgi/access/certs`, () =>
      HttpResponse.json({ keys: [{ ...publicJwk, kid: KEY_ID, alg: 'RS256' }] }),
    ),
  );
}

/** A token as Access signs one for whoever signed in with this email. */
async function accessToken(email: string): Promise<string> {
  const { privateJwk } = await accessKeys();
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { iss: TEAM, aud: [AUDIENCE], email, sub: `user-${email}`, iat: now, exp: now + 600 },
    { ...privateJwk, alg: 'RS256', kid: KEY_ID },
  );
}

/** The test bindings, with Access, the owner's email, and crowdio's token and scopes set. */
async function bindings(): Promise<Env> {
  return {
    ...env,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUDIENCE,
    OWNER_EMAIL: OWNER,
    CONSUMER_CROWDIO_TOKEN_HASH: await sha256Hex(CONSUMER_TOKEN),
    CONSUMER_CROWDIO_SCOPES: 'review:answer,taxonomy:approve-additive',
  } as Env;
}

/** A request from the console's page: Access's token, and on a write the console's own origin. */
async function fromConsole(
  method: string,
  path: string,
  options: { body?: unknown; email?: string } = {},
): Promise<Response> {
  const headers = new Headers({
    'cf-access-jwt-assertion': await accessToken(options.email ?? OWNER),
  });
  if (method !== 'GET') {
    headers.set('origin', ORIGIN);
    headers.set('sec-fetch-site', 'same-origin');
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  return api.request(`${ORIGIN}${path}`, { method, headers, body }, await bindings());
}

/** A GET with a bearer token: the owner's CLI, or a consumer's server. */
async function withToken(path: string, token: string): Promise<Response> {
  const headers = { authorization: `Bearer ${token}` };
  return api.request(`${ORIGIN}${path}`, { headers }, await bindings());
}

const html = (body: string) =>
  new HttpResponse(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

/**
 * A taxonomy dataset crowdio reads, at version 1, after one run. These tests set no LLM key, so no
 * decider places a page: each page's question asks a person for its shelf.
 */
async function ranOnce(datasetId: string): Promise<void> {
  network.use(
    http.get('https://maker-a.example/robots.txt', () => HttpResponse.text(ROBOTS_OPEN)),
    http.get('https://maker-b.example/robots.txt', () => HttpResponse.text(ROBOTS_OPEN)),
    http.get(URLS.a1, () => html(A1())),
    http.get(URLS.a2, () => html(A2())),
    http.get(URLS.b1, () => html(B1())),
  );
  await withDatabase(env, async (db) => {
    await applyDefinition(db, { ...testTaxonomyDefinition(datasetId), consumers: ['crowdio'] });
    await seedTaxonomyVersion(db, {
      datasetId,
      taxonomy: testTaxonomy(),
      actor: { role: 'owner', client: 'cli' },
      at: new Date(),
    });
  });
  const runId = runIdFor(datasetId, new Date());
  const instance = await introspectWorkflowInstance(env.REFRESH, runId);
  try {
    await env.REFRESH.create({ id: runId, params: { runId, datasetId } });
    await instance.waitForStatus('complete');
  } finally {
    await instance.dispose();
  }
}

/**
 * A dataset crowdio reads whose A1 was captured once, its body gzipped where a run keeps it (as
 * plan 1's purge test captures pages), with this page as its body. Returns the capture's ID.
 */
async function captured(datasetId: string, page = A1()): Promise<string> {
  const hash = `${datasetId}-a1`.padEnd(64, '0');
  const captureId = `cp_${datasetId}_a1`;
  await env.STORE.put(pageKey(hash), await gzip(new TextEncoder().encode(page)));
  await withDatabase(env, async (db) => {
    await applyDefinition(db, { ...testDefinition(datasetId), consumers: ['crowdio'] });
    const runId = `${datasetId}-202610200000`;
    await startRun(db, { id: runId, datasetId });
    const pages = await db.select().from(items).where(eq(items.datasetId, datasetId));
    const page = pages.find((one) => one.locator === URLS.a1)!;
    const fetchId = `fe_${datasetId}_a1`;
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
      page: { contentHash: hash, etag: null, lastModified: null },
    });
    await recordCapture(db, {
      id: captureId,
      datasetId,
      itemId: page.id,
      sourceId: page.sourceId,
      fetchId,
      url: page.locator,
      finalUrl: page.locator,
      httpStatus: 200,
      etag: null,
      lastModified: null,
      fetchedAt: at,
      contentHash: hash,
      bytes: 10,
      storedBytes: 5,
      signals: {},
    });
  });
  return captureId;
}

describe('the console', () => {
  it('serves its page, script, and style to the owner alone, signed in by Access', async () => {
    await serveAccess();
    for (const [path, type, body] of [
      ['/console', 'text/html', CONSOLE_HTML],
      ['/console/app.js', 'text/javascript', CONSOLE_SCRIPT],
      ['/console/app.css', 'text/css', CONSOLE_CSS],
    ] as const) {
      const response = await fromConsole('GET', path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type')).toBe(`${type}; charset=utf-8`);
      expect(response.headers.get('content-security-policy')).toBe(CONSOLE_CSP);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expectNoStore(response);
      expect(await response.text()).toBe(body);
    }
    // Someone else Access let in, no one, and the owner's token: the console is Access's alone.
    const stranger = await fromConsole('GET', '/console', { email: 'someone@example.com' });
    expect(stranger.status).toBe(403);
    expect((await api.request(`${ORIGIN}/console`, {}, await bindings())).status).toBe(401);
    expect((await withToken('/console', 'test-token')).status).toBe(401);
  });

  it('lists, shows, and answers a question in parts, and logs who answered: a round trip', async () => {
    await ranOnce('console-trip');
    await serveAccess();
    const base = '/console/api/datasets/console-trip';
    const listed = await fromConsole('GET', '/console/api/datasets');
    expect(listed.status).toBe(200);
    const { datasets } = (await listed.json()) as { datasets: { id: string }[] };
    expect(datasets.map((one) => one.id)).toContain('console-trip');

    const questions = async () => {
      const response = await fromConsole('GET', `${base}/review`);
      expect(response.status).toBe(200);
      const { reviews } = (await response.json()) as { reviews: ReviewView[] };
      return reviews.filter((one) => one.question.type === 'taxonomy');
    };
    const asked = await questions();
    expect(asked.map((one) => one.context.url).sort()).toEqual([URLS.a1, URLS.a2, URLS.b1]);
    const a1 = asked.find((one) => one.context.url === URLS.a1)!;
    const overEar = testTaxonomy().shelves.find((shelf) => shelf.slug === 'over-ear')!.id;
    expect(a1.question).toMatchObject({ parts: { shelves: expect.arrayContaining([overEar]) } });
    expect(await (await fromConsole('GET', `${base}/taxonomy`)).json()).toMatchObject({
      version: 1,
    });

    // The evidence card's link: the page as Spatula saw it.
    const captureId = a1.context.captureId as string;
    const seen = await fromConsole('GET', `${base}/captures/${encodeURIComponent(captureId)}`);
    expect(seen.status).toBe(200);
    expectNoStore(seen);
    expect(await seen.json()).toMatchObject({
      capture: { id: captureId, datasetId: 'console-trip', url: URLS.a1 },
      read: { title: 'A1 | Maker A', text: expect.stringContaining('Impedance: 300 Ω') },
    });

    const answered = await fromConsole('POST', `${base}/review/${encodeURIComponent(a1.id)}`, {
      body: { parts: { shelf: overEar }, note: 'Cups around the ears.' },
    });
    expect(answered.status).toBe(200);
    expect((await questions()).map((one) => one.id)).not.toContain(a1.id);
    // History reads an answered question, to offer the owner a reviewer's answer to replace.
    const read = await fromConsole('GET', `${base}/review/${encodeURIComponent(a1.id)}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      review: {
        id: a1.id,
        status: 'decided',
        answeredBy: { role: 'owner', client: 'console' },
        note: 'Cups around the ears.',
      },
    });

    // What the page reads of a bulk request: a status for each answer, and beside it `answered` or
    // `flagged`, or the `error` that refused it. Not a kind and a reason.
    const a2 = asked.find((one) => one.context.url === URLS.a2)!;
    const bulk = await fromConsole('POST', `${base}/review/bulk`, {
      body: {
        answers: [
          { reviewId: a2.id, parts: { shelf: overEar } },
          { reviewId: 'rv_nowhere', suggestion: true },
        ],
      },
    });
    expect(bulk.status).toBe(200);
    expect(await bulk.json()).toEqual({
      results: [
        { reviewId: a2.id, status: 200, answered: a2.id, effect: expect.any(String) },
        { reviewId: 'rv_nowhere', status: 404, error: 'No such question for this dataset.' },
      ],
    });

    // The rest of what the screens read, through Access: the proposals, the versions, and autonomy
    // as `{ after, kinds }`, each kind with its run and whether it has earned its autonomy.
    const proposals = await fromConsole('GET', `${base}/proposals?status=open`);
    expect(proposals.status).toBe(200);
    expect(await proposals.json()).toEqual({ proposals: [] });
    const versions = await fromConsole('GET', `${base}/taxonomy/versions`);
    expect(versions.status).toBe(200);
    expect(await versions.json()).toMatchObject({ versions: [{ version: 1, undoes: null }] });
    const autonomy = await fromConsole('GET', `${base}/autonomy`);
    expect(autonomy.status).toBe(200);
    // A description never earns autonomy, so it isn't listed.
    expect(await autonomy.json()).toEqual({
      after: 10,
      kinds: [
        expect.objectContaining({ kind: 'add-subcategory', streak: 0, earned: false }),
        expect.objectContaining({ kind: 'add-feature', streak: 0, earned: false }),
        expect.objectContaining({ kind: 'add-value', streak: 0, earned: false }),
      ],
    });

    const log = await fromConsole('GET', `${base}/review/log`);
    expect(log.status).toBe(200);
    const { actions } = (await log.json()) as { actions: unknown[] };
    expect(actions).toContainEqual(
      expect.objectContaining({
        action: 'answer',
        actor: expect.objectContaining({ role: 'owner', client: 'console' }),
      }),
    );
  });

  it('serves a capture to the owner alone, by token or in the console, under its own dataset', async () => {
    const captureId = await captured('console-capture');
    const elsewhere = await captured('console-elsewhere');
    await serveAccess();
    const path = `/datasets/console-capture/captures/${captureId}`;

    const owner = await withToken(path, 'test-token');
    expect(owner.status).toBe(200);
    expectNoStore(owner);
    expect(await owner.json()).toMatchObject({
      capture: { id: captureId, datasetId: 'console-capture', url: URLS.a1 },
      read: { url: URLS.a1, title: 'A1 | Maker A' },
    });
    expect((await fromConsole('GET', `/console/api${path}`)).status).toBe(200);

    // A consumer reads the dataset's snapshots, never its captures (Review Focus 3), and the
    // console's API takes no bearer token at all.
    const consumer = await withToken(path, CONSUMER_TOKEN);
    expect(consumer.status).toBe(403);
    expectNoStore(consumer);
    expect(await consumer.text()).not.toContain('Maker A');
    const bearerAtConsole = await withToken(`/console/api${path}`, 'test-token');
    expect(bearerAtConsole.status).toBe(401);
    const stranger = await fromConsole('GET', `/console/api${path}`, { email: 'x@example.com' });
    expect(stranger.status).toBe(403);

    // An unknown capture, and another dataset's, are no capture of this dataset.
    for (const other of ['cp_none', elsewhere]) {
      const missing = await withToken(`/datasets/console-capture/captures/${other}`, 'test-token');
      expect(missing.status, other).toBe(404);
      expect(await missing.json()).toEqual({ error: 'No such capture in console-capture.' });
    }
  });

  it('refuses a capture to a request with no token, or a wrong one, whichever way it comes', async () => {
    const captureId = await captured('console-refused');
    await serveAccess();
    const path = `/datasets/console-refused/captures/${captureId}`;
    const attempts: [string, Response][] = [
      ['no token', await api.request(`${ORIGIN}${path}`, {}, await bindings())],
      ['a wrong token', await withToken(path, 'wrong-token')],
      ['no Access token', await api.request(`${ORIGIN}/console/api${path}`, {}, await bindings())],
      ['a bearer token at the console', await withToken(`/console/api${path}`, 'wrong-token')],
      [
        'an Access token at the bearer route',
        await api.request(
          `${ORIGIN}${path}`,
          { headers: { 'cf-access-jwt-assertion': await accessToken(OWNER) } },
          await bindings(),
        ),
      ],
    ];
    for (const [what, response] of attempts) {
      expect(response.status, what).toBe(401);
      expectNoStore(response);
      expect(await response.text(), what).not.toContain('Maker A');
    }
  });

  it('serves a capture as data, never as a page: a scraped script can’t run on the console’s origin', async () => {
    const hostile = A1().replace(
      '<title>A1 | Maker A</title>',
      '<title><script>alert(1)</script> A1</title>',
    );
    const captureId = await captured('console-hostile', hostile);
    await serveAccess();
    const path = `/datasets/console-hostile/captures/${captureId}`;
    for (const response of [
      await withToken(path, 'test-token'),
      await fromConsole('GET', `/console/api${path}`),
      await withToken('/datasets/console-hostile/captures/cp_none', 'test-token'),
    ]) {
      // JSON, which no browser runs as a page, and which nosniff keeps it from being taken for one.
      expect(response.headers.get('content-type')).toMatch(/^application\/json\b/u);
      expect(response.headers.get('content-type')).not.toMatch(/html/iu);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toBe(
        CAPTURE_HEADERS['content-security-policy'],
      );
      expect(response.headers.get('content-security-policy')).not.toContain('allow-scripts');
      expectNoStore(response);
    }
    // The page's text comes inside the JSON, as a string.
    const seen = (await (await withToken(path, 'test-token')).json()) as {
      read: { title: string };
    };
    expect(seen.read.title).toContain('<script>alert(1)</script>');
  });
});
