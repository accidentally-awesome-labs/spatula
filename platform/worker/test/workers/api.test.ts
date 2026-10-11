import { sha256Hex, type RunView } from '@spatula/core';
import { commitSnapshot } from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api } from '../../src/api';
import { withDatabase } from '../../src/database';

/** Calls the API as the owner, unless told to send another token or none. A string body goes as is. */
function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; bindings?: Env } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.token !== null)
    headers.set('authorization', `Bearer ${options.token ?? 'test-token'}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const body =
    options.body === undefined || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body);
  return Promise.resolve(api.request(path, { method, headers, body }, options.bindings ?? env));
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
    expect(await elsewhere.json()).toEqual({
      error: 'The definition has problems.',
      issues: ['dataset: it says api-definitions, but the address says somewhere-else'],
    });

    const training = { ...definition, policy: { purposes: ['ai-train'], perHostIntervalMs: 1000 } };
    const refused = await call('PUT', '/datasets/api-definitions', { body: training });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      issues: [expect.stringMatching(/^policy\.purposes/u)],
    });

    const noPack = {
      ...definition,
      recordTypes: { product: { ...definition.recordTypes.product!, pack: 'products/nothing' } },
    };
    expect((await call('PUT', '/datasets/api-definitions', { body: noPack })).status).toBe(400);
    const notJson = await call('PUT', '/datasets/api-definitions', {
      body: 'dataset: api-definitions',
    });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'The body isn’t JSON.' });
  });

  it('start one run per five-minute slot, and report it', async () => {
    await call('PUT', '/datasets/api-runs', { body: testDefinition('api-runs') });
    const introspector = await introspectWorkflow(env.REFRESH);
    try {
      // The run's load step returns no pages, so the run finishes without the network.
      await introspector.modifyAll(async (m) => {
        await m.mockStepResult(
          { name: 'load' },
          { revision: 1, definition: testDefinition('api-runs'), items: [] },
        );
      });
      const started = await call('POST', '/datasets/api-runs/runs');
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };
      expect(runId).toMatch(/^api-runs-\d{12}$/u);
      expect(started.headers.get('location')).toBe(`/runs/${runId}`);

      const twice = await call('POST', '/datasets/api-runs/runs');
      expect(twice.status).toBe(409);
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
    expect(await tooBig.json()).toEqual({
      error: 'A generation is a whole number from 1, or latest.',
    });
    // The largest one the route accepts does reach the query, and is simply not found.
    expect((await call('GET', '/datasets/api-snapshots/snapshots/999999999')).status).toBe(404);
  });
});
