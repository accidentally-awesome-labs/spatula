import type { ReviewAction } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { env } from 'cloudflare:workers';
import { sign } from 'hono/jwt';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/api';
import { call, expectNoStore, questionsIn } from './api-support';
import { network } from './network';

/*
 * The console's API, behind Cloudflare Access. The tests sign tokens as Access does, with RSA keys
 * whose public halves Access's certs endpoint lists, through the network handlers.
 */

const TEAM = 'https://spatula-test.cloudflareaccess.com';
const AUD = 'aud-of-the-console';
const MISSING = 'Cloudflare Access’s token is missing or wrong.';

interface AccessTestKey {
  /** The private key, as `sign` takes it. */
  signing: JsonWebKey & { alg: string; kid: string };
  /** The public key, as Access's certs endpoint lists it. */
  listed: JsonWebKey & { kid: string };
}

async function accessKey(kid: string): Promise<AccessTestKey> {
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
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    signing: { ...jwk, alg: 'RS256', kid },
    listed: { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', kid, use: 'sig' },
  };
}

let owner: AccessTestKey;
let stranger: AccessTestKey;

beforeAll(async () => {
  owner = await accessKey('key-one');
  // Another key under the same ID, as a forger would name it.
  stranger = await accessKey('key-one');
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A token as Access signs one for the owner, with these claims changed. */
function tokenFor(
  signing: JsonWebKey & { kid?: string },
  claims: Record<string, unknown> = {},
  team = TEAM,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      aud: [AUD],
      email: 'Owner@Example.com',
      exp: now + 3600,
      iat: now - 60,
      nbf: now - 60,
      iss: team,
      type: 'app',
      sub: 'the-owner',
      ...claims,
    },
    signing,
  );
}

/** The test bindings with the console set up for this team. */
const consoleEnv = (team = TEAM) =>
  ({ ...env, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD, OWNER_EMAIL: 'owner@example.com' }) as Env;

/** Access's certs endpoint for a team, listing these keys as they are when it's read. */
function certs(team: string, keys: (JsonWebKey & { kid: string })[]): { reads: () => number } {
  let reads = 0;
  network.use(
    http.get(`${team}/cdn-cgi/access/certs`, () => {
      reads += 1;
      return HttpResponse.json({ keys });
    }),
  );
  return { reads: () => reads };
}

/** Calls the console's API with Access's token, as Access forwards the owner's requests. */
function consoleCall(
  method: string,
  path: string,
  options: {
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
    bindings?: Env;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token !== undefined) headers.set('cf-access-jwt-assertion', options.token);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return Promise.resolve(
    api.request(path, { method, headers, body }, options.bindings ?? consoleEnv()),
  );
}

describe('the console’s API', () => {
  it('lets in the owner Access signed in, and no one else', async () => {
    certs(TEAM, [owner.listed]);
    await call('PUT', '/datasets/access-listed', { body: testDefinition('access-listed') });
    const read = (token?: string, bindings?: Env) =>
      consoleCall('GET', '/console/api/datasets', { token, bindings });

    const listed = await read(await tokenFor(owner.signing));
    expect(listed.status).toBe(200);
    expectNoStore(listed);
    const { datasets } = (await listed.json()) as { datasets: unknown[] };
    expect(datasets).toContainEqual({ id: 'access-listed', revision: 1, headGeneration: 0 });
    // An address's case doesn't make it another address.
    const upper = await read(await tokenFor(owner.signing, { email: 'OWNER@example.COM' }));
    expect(upper.status).toBe(200);

    const someone = await read(await tokenFor(owner.signing, { email: 'someone@example.com' }));
    expect(someone.status).toBe(403);
    expectNoStore(someone);
    expect(await someone.json()).toEqual({ error: 'The console is the owner’s.' });

    const now = Math.floor(Date.now() / 1000);
    const shared = { kty: 'oct', k: 'c2VjcmV0', alg: 'HS256', kid: 'key-one' };
    const refused: [string, string | undefined][] = [
      ['no token', undefined],
      ['a token that isn’t one', 'not.a.token'],
      ['another application’s', await tokenFor(owner.signing, { aud: ['another-aud'] })],
      [
        'another team’s',
        await tokenFor(owner.signing, { iss: 'https://elsewhere.cloudflareaccess.com' }),
      ],
      ['an expired one', await tokenFor(owner.signing, { exp: now - 60 })],
      ['one not good yet', await tokenFor(owner.signing, { nbf: now + 3600 })],
      ['one that never expires', await tokenFor(owner.signing, { exp: undefined })],
      ['one signed with another key under the same ID', await tokenFor(stranger.signing)],
      ['one signed with a shared secret', await tokenFor(shared)],
    ];
    // Another application's and another team's are logged by name (see below); not here.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [name, token] of refused) {
      const response = await read(token);
      expect(response.status, name).toBe(401);
      expectNoStore(response);
      expect(await response.json(), name).toEqual({ error: MISSING });
    }

    // The owner token is the CLI's, and opens nothing here.
    const bearer = await api.request(
      '/console/api/datasets',
      { headers: { authorization: 'Bearer test-token' } },
      consoleEnv(),
    );
    expect(bearer.status).toBe(401);
    // Without Access's settings, the console is shut.
    const unset = await read(await tokenFor(owner.signing), env);
    expect(unset.status).toBe(503);
    expectNoStore(unset);
    expect(await unset.json()).toEqual({ error: 'This deployment’s console isn’t set up yet.' });
  });

  it('keeps Access’s keys ten minutes, and reads them again for a key it hasn’t seen', async () => {
    const team = 'https://spatula-keys.cloudflareaccess.com';
    const two = await accessKey('key-two');
    const three = await accessKey('key-three');
    const keys = [owner.listed];
    const endpoint = certs(team, keys);
    // A path no route answers: an owner Access let in gets a 404.
    const knock = async (key: AccessTestKey) =>
      (
        await consoleCall('GET', '/console/api/nowhere', {
          token: await tokenFor(key.signing, {}, team),
          bindings: consoleEnv(team),
        })
      ).status;
    const start = Date.now();
    const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(start + ms);

    expect(await knock(owner)).toBe(404);
    expect(endpoint.reads()).toBe(1);
    expect(await knock(owner)).toBe(404);
    expect(endpoint.reads()).toBe(1);
    // Access rotates its keys: one the Worker hasn't seen has it read them again, once half a
    // minute has passed since it last did.
    keys.push(two.listed);
    expect(await knock(two)).toBe(401);
    expect(endpoint.reads()).toBe(1);
    at(31_000);
    expect(await knock(two)).toBe(404);
    expect(endpoint.reads()).toBe(2);
    // Ten minutes on, it reads them again whatever the key.
    at(31_000 + 11 * 60 * 1000);
    expect(await knock(owner)).toBe(404);
    expect(endpoint.reads()).toBe(3);
    // A key Access doesn't list is refused, and looked for again only after half a minute.
    expect(await knock(three)).toBe(401);
    expect(endpoint.reads()).toBe(3);
    at(31_000 + 11 * 60 * 1000 + 31_000);
    expect(await knock(three)).toBe(401);
    expect(endpoint.reads()).toBe(4);
  });

  it('reads Access’s keys only for a token Access could have signed, and once for many made-up keys', async () => {
    const team = 'https://spatula-made-up.cloudflareaccess.com';
    const endpoint = certs(team, [owner.listed]);
    const knock = async (token: string) =>
      (
        await consoleCall('GET', '/console/api/nowhere', {
          token,
          bindings: consoleEnv(team),
        })
      ).status;
    // Neither a token signed with a shared secret nor one that names no key has it look.
    const shared = { kty: 'oct', k: 'c2VjcmV0', alg: 'HS256', kid: 'key-one' };
    expect(await knock(await tokenFor(shared, {}, team))).toBe(401);
    expect(await knock(await tokenFor({ ...owner.signing, kid: undefined }, {}, team))).toBe(401);
    expect(endpoint.reads()).toBe(0);
    // Key IDs Access never listed, sent at once and one after another, share one read.
    const madeUp = (kid: string) => tokenFor({ ...stranger.signing, kid }, {}, team);
    const knocks = await Promise.all(
      ['made-up-1', 'made-up-2', 'made-up-3'].map(async (kid) => knock(await madeUp(kid))),
    );
    expect(knocks).toEqual([401, 401, 401]);
    expect(await knock(await madeUp('made-up-4'))).toBe(401);
    expect(endpoint.reads()).toBe(1);
    // The owner's key was among those read, so the owner gets in meanwhile.
    expect(await knock(await tokenFor(owner.signing, {}, team))).toBe(404);
    expect(endpoint.reads()).toBe(1);
  });

  it('logs a check that fails for a reason other than the token by its name alone, and answers 401', async () => {
    const team = 'https://spatula-broken.cloudflareaccess.com';
    // A key Access lists that can't be imported: an RSA key without its modulus.
    certs(team, [{ kty: 'RSA', e: 'AQAB', alg: 'RS256', kid: 'broken', use: 'sig' }]);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await tokenFor({ ...owner.signing, kid: 'broken' }, {}, team);
    const response = await consoleCall('GET', '/console/api/datasets', {
      token,
      bindings: consoleEnv(team),
    });
    expect(response.status).toBe(401);
    expectNoStore(response);
    expect(await response.json()).toEqual({ error: MISSING });
    expect(warned).toHaveBeenCalledTimes(1);
    const [message, name] = warned.mock.calls[0]!;
    expect(message).toBe('Access’s token couldn’t be checked:');
    expect(name).toEqual(expect.any(String));
    expect(name).not.toMatch(/^Jwt/u);
    expect(JSON.stringify(warned.mock.calls)).not.toContain(token);

    // A token that doesn't check out is the caller's, and isn't logged.
    warned.mockClear();
    certs(TEAM, [owner.listed]);
    const now = Math.floor(Date.now() / 1000);
    const expired = await tokenFor(owner.signing, { exp: now - 60 });
    expect((await consoleCall('GET', '/console/api/datasets', { token: expired })).status).toBe(
      401,
    );
    expect(warned).not.toHaveBeenCalled();
  });

  it('logs a token for another audience or issuer by its error’s name, as ACCESS_AUD or ACCESS_TEAM_DOMAIN set wrong would make every one', async () => {
    certs(TEAM, [owner.listed]);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrong: [string, string][] = [
      [await tokenFor(owner.signing, { aud: ['another-aud'] }), 'JwtTokenAudience'],
      [
        await tokenFor(owner.signing, { iss: 'https://elsewhere.cloudflareaccess.com' }),
        'JwtTokenIssuer',
      ],
    ];
    for (const [token, name] of wrong) {
      warned.mockClear();
      const response = await consoleCall('GET', '/console/api/datasets', { token });
      expect(response.status, name).toBe(401);
      expect(await response.json(), name).toEqual({ error: MISSING });
      expect(warned.mock.calls, name).toEqual([
        [
          'Access’s token is for another audience or issuer: check ACCESS_AUD and ACCESS_TEAM_DOMAIN.',
          name,
        ],
      ]);
      expect(JSON.stringify(warned.mock.calls), name).not.toContain(token);
    }
  });

  it('answers 503 for a team that isn’t an https address, and 500 when Access’s keys can’t be read', async () => {
    const token = await tokenFor(owner.signing);
    for (const team of ['http://spatula-test.cloudflareaccess.com', 'spatula-test', '']) {
      const response = await consoleCall('GET', '/console/api/datasets', {
        token,
        bindings: consoleEnv(team),
      });
      expect(response.status, team).toBe(503);
      expectNoStore(response);
    }

    const down = 'https://spatula-down.cloudflareaccess.com';
    network.use(
      http.get(`${down}/cdn-cgi/access/certs`, () => new HttpResponse(null, { status: 500 })),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await consoleCall('GET', '/console/api/datasets', {
      token: await tokenFor(owner.signing, {}, down),
      bindings: consoleEnv(down),
    });
    // The Worker can't tell, so it doesn't turn the owner away as a stranger.
    expect(failed.status).toBe(500);
    expectNoStore(failed);
    expect(await failed.json()).toEqual({
      error: 'Something went wrong. The Worker’s logs say what.',
    });
    expect(logged).toHaveBeenCalledWith('API error:', 'Access’s keys answered 500');
  });

  it('refuses a console write from another origin', async () => {
    certs(TEAM, [owner.listed]);
    const datasetId = 'access-writes';
    await questionsIn(datasetId);
    const reviewId = `rv_${datasetId}_match_0`;
    const token = await tokenFor(owner.signing);
    const write = (headers: Record<string, string>) =>
      consoleCall('POST', `/console/api/datasets/${datasetId}/review/${reviewId}`, {
        token,
        headers,
        body: { answer: 'same' },
      });
    // The test's requests are to http://localhost, which is the console's origin here.
    const elsewhere: Record<string, string>[] = [
      {},
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: 'http://localhost', 'sec-fetch-site': 'cross-site' },
      { origin: 'http://localhost', 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of elsewhere) {
      const response = await write(headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expectNoStore(response);
      expect(await response.json(), JSON.stringify(headers)).toEqual({
        error: 'A console write comes from the console’s own page.',
      });
    }
    // A read needs no origin, and the question still waits.
    const listed = await consoleCall('GET', `/console/api/datasets/${datasetId}/review`, { token });
    expect(listed.status).toBe(200);
    const { reviews } = (await listed.json()) as { reviews: { id: string }[] };
    expect(reviews.map((review) => review.id)).toContain(reviewId);

    const answered = await write({ origin: 'http://localhost', 'sec-fetch-site': 'same-origin' });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      answered: reviewId,
      answer: 'same',
      effect: 'The page joins that record at the next run.',
    });
    // The log records the console as the owner's client.
    const log = await call('GET', `/datasets/${datasetId}/review/log`);
    const { actions } = (await log.json()) as { actions: ReviewAction[] };
    expect(actions).toMatchObject([
      { action: 'answer', subject: reviewId, actor: { role: 'owner', client: 'console' } },
    ]);
  });

  it('lets no path under it answer before accessActor has set the actor', async () => {
    // A request without a token gets Access's 401 at every route registered under /console/api, a
    // route added later included, and at the bare path and the paths no route answers: Hono's
    // trailing /* covers the bare one. A path outside /console/api is none of this app's.
    const registered = api.routes.filter(({ path }) => /^\/console\/api(?:\/|$)/u.test(path));
    expect(registered.length).toBeGreaterThan(5);
    const shapes = new Set<string>(['GET /console/api', 'GET /console/api/', 'POST /console/api']);
    for (const { method, path } of registered) {
      const concrete = path.replaceAll(/:[A-Za-z]+/gu, 'x').replaceAll('*', 'x');
      shapes.add(`${method === 'ALL' ? 'GET' : method} ${concrete}`);
    }
    // A route the test hasn't named, to be sure the guard isn't only on the routes known today.
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      shapes.add(`${method} /console/api/nowhere/deeper/still`);
    }
    for (const shape of shapes) {
      const [method = '', path = ''] = shape.split(' ');
      const response = await consoleCall(method, path, { body: method === 'GET' ? undefined : {} });
      expect(response.status, shape).toBe(401);
      expectNoStore(response);
      expect(await response.json(), shape).toEqual({ error: MISSING });
    }
  });
});
