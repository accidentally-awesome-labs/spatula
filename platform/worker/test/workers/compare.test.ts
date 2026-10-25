import type { ComparisonReport } from '@spatula/core';
import { applyDefinition } from '@spatula/store';
import { testDefinition } from '@spatula/store/fixtures';
import { introspectWorkflow, introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { comparisonIdFor, comparisonKey, type CompareParams } from '../../src/compare';
import { withDatabase } from '../../src/database';
import { call, CONSUMER_TOKEN, consumerBindings, expectNoStore } from './api-support';

/*
 * The comparison routes (ADR 0010, spec §10): POST /datasets/:id/comparisons starts one, and
 * GET /comparisons/:id reads it. Only the owner may do either, since a comparison spends the
 * owner's money. The tests have no model to ask, so the Workflow they start runs on a dataset with
 * no answered questions: it asks nothing, and writes its report.
 */

/** A body the route takes. */
const body = (more: Record<string, unknown> = {}) => ({
  job: 'classify',
  model: 'anthropic/claude-haiku-5-5',
  maxUsd: 2,
  ...more,
});

/** The test bindings with the gateway's address and Anthropic's key, made up: a Worker that asks. */
const asking = (bindings: Env = env): Env =>
  ({
    ...bindings,
    AI_GATEWAY_URL: 'https://gateway.example/v1/acct/spatula-llm',
    ANTHROPIC_API_KEY: 'sk-test',
  }) as unknown as Env;

const start = (datasetId: string, sent: unknown, bindings: Env = asking()) =>
  call('POST', `/datasets/${datasetId}/comparisons`, { body: sent, bindings });

describe('comparisons', () => {
  it('are the owner’s alone, to start and to read', async () => {
    const datasetId = 'cmp-owner';
    await withDatabase(env, (db) =>
      applyDefinition(db, { ...testDefinition(datasetId), consumers: ['crowdio'] }),
    );
    const bindings = asking(await consumerBindings());
    // A consumer the dataset lists is known, and refused: a comparison spends the owner's money.
    const consumer = await call('POST', `/datasets/${datasetId}/comparisons`, {
      body: body(),
      token: CONSUMER_TOKEN,
      bindings,
    });
    expect(consumer.status).toBe(403);
    expectNoStore(consumer);
    const nobody = await call('POST', `/datasets/${datasetId}/comparisons`, {
      body: body(),
      token: null,
      bindings,
    });
    expect(nobody.status).toBe(401);
    expect(nobody.headers.get('www-authenticate')).toBe('Bearer');

    const id = comparisonIdFor(datasetId, new Date());
    for (const token of [null, CONSUMER_TOKEN]) {
      const read = await call('GET', `/comparisons/${id}`, { token, bindings });
      expect(read.status, String(token)).toBe(401);
      expectNoStore(read);
    }
  });

  it('refuse a body that isn’t one, naming what’s wrong', async () => {
    const refused = await start('cmp-body', '{"job":');
    expect(refused.status).toBe(400);
    expectNoStore(refused);
    expect(await refused.json()).toEqual({ error: 'The body isn’t JSON.' });

    const without = (key: string) =>
      Object.fromEntries(Object.entries(body()).filter(([name]) => name !== key));
    const noJob = without('job');
    const noLimit = without('maxUsd');
    for (const [sent, at] of [
      [noJob, 'job'],
      [body({ job: 'extract' }), 'job'],
      [body({ model: 7 }), 'model'],
      [body({ backup: null }), 'backup'],
      [noLimit, 'maxUsd'],
      [body({ maxUsd: 0 }), 'maxUsd'],
      [body({ maxUsd: 50.01 }), 'maxUsd'],
      [body({ maxUsd: '2' }), 'maxUsd'],
      [body({ accept: 0.49 }), 'accept'],
      [body({ accept: 1.01 }), 'accept'],
      [body({ limit: 0 }), 'limit'],
      [body({ limit: 501 }), 'limit'],
      [body({ limit: 2.5 }), 'limit'],
      [body({ wait: true }), 'the body'],
      [[], 'the body'],
    ] as const) {
      const response = await start('cmp-body', sent);
      expect(response.status, JSON.stringify(sent)).toBe(400);
      const { error } = (await response.json()) as { error: string };
      expect(error, JSON.stringify(sent)).toMatch(
        new RegExp(`^The comparison is wrong at ${at}: `, 'u'),
      );
    }
  });

  it('refuse a model or a backup the Worker can’t ask, and a Worker that asks none', async () => {
    const datasetId = 'cmp-models';
    await withDatabase(env, (db) => applyDefinition(db, testDefinition(datasetId)));
    const refusals = [
      [
        body({ model: 'nobody/model' }),
        asking(),
        'The model nobody/model can’t be asked: Spatula has no provider called nobody.',
      ],
      [
        body({ backup: 'anthropic/claude-unpriced' }),
        asking(),
        'The backup anthropic/claude-unpriced can’t be asked: it has no price: add it to LLM_PRICES.',
      ],
      [
        body({ model: 'openai/gpt-6.1-sol' }),
        asking(),
        'The model openai/gpt-6.1-sol can’t be asked: no key: set OPENAI_API_KEY, or name openai in LLM_GATEWAY_KEYS.',
      ],
      // The tests' own bindings have no gateway: the model passes, and the Worker asks none.
      [body(), env, 'This Worker asks no model.'],
    ] as const;
    for (const [sent, bindings, error] of refusals) {
      const response = await start(datasetId, sent, bindings);
      expect(response.status, error).toBe(400);
      expectNoStore(response);
      expect(await response.json()).toEqual({ error });
    }
  });

  it('refuse a dataset that isn’t there, or doesn’t allow AI input', async () => {
    const missing = await start('cmp-missing', body());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Dataset cmp-missing doesn’t exist.' });

    const datasetId = 'cmp-no-ai';
    const definition = testDefinition(datasetId);
    await withDatabase(env, (db) =>
      applyDefinition(db, { ...definition, policy: { ...definition.policy, purposes: [] } }),
    );
    const refused = await start(datasetId, body());
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: `${datasetId} doesn’t allow AI input, so no model is asked its questions.`,
    });
  });

  it('start a Workflow, whose report the GET reads once it’s written', async () => {
    const datasetId = 'cmp-start';
    await withDatabase(env, (db) => applyDefinition(db, testDefinition(datasetId)));
    const introspector = await introspectWorkflow(env.COMPARE);
    try {
      const response = await start(
        datasetId,
        body({ job: 'match', backup: 'anthropic/claude-opus-5-5', accept: 0.95, limit: 10 }),
      );
      expect(response.status).toBe(202);
      expectNoStore(response);
      const { comparisonId } = (await response.json()) as { comparisonId: string };
      expect(comparisonId).toMatch(/^cmp-cmp-start-\d{14}$/u);
      expect(response.headers.get('location')).toBe(`/comparisons/${comparisonId}`);

      const [instance, ...others] = await introspector.get();
      expect(others).toEqual([]);
      // The dataset has no answered questions, so the Workflow asks no model.
      await instance!.waitForStatus('complete');

      const read = await call('GET', `/comparisons/${comparisonId}`);
      expect(read.status).toBe(200);
      expectNoStore(read);
      const answer = (await read.json()) as { status: string; report: ComparisonReport };
      expect(answer.status).toBe('complete');
      expect(answer.report).toMatchObject({
        id: comparisonId,
        dataset: datasetId,
        job: 'match',
        model: 'anthropic/claude-haiku-5-5',
        backup: 'anthropic/claude-opus-5-5',
        accept: 0.95,
        skipped: 0,
        stoppedAtBudget: false,
        columns: { person: { questions: 0 }, model: { questions: 0 } },
      });
      expect(answer.report.notes[0]).toBe(
        'The dataset has no answered questions for this job under the current criteria.',
      );
    } finally {
      await introspector.dispose();
    }
  });

  it('read a report from R2, a failed Workflow, and nothing for an ID that isn’t one', async () => {
    const id = 'cmp-cmp-kept-20261101090000';
    const report = { id, dataset: 'cmp-kept', job: 'classify', notes: [] };
    await env.STORE.put(comparisonKey('cmp-kept', id), JSON.stringify(report));
    const kept = await call('GET', `/comparisons/${id}`);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({ status: 'complete', report });

    // A dataset that's gone by the time the Workflow loads it: the Workflow stops at once.
    const gone = 'cmp-cmp-gone-20261101090000';
    const params: CompareParams = {
      comparisonId: gone,
      datasetId: 'cmp-gone',
      job: 'classify',
      model: 'anthropic/claude-haiku-5-5',
      backup: null,
      accept: null,
      limit: 200,
      maxUsd: 2,
      startedAt: '2026-11-01T09:00:00.000Z',
    };
    const instance = await introspectWorkflowInstance(env.COMPARE, gone);
    try {
      await env.COMPARE.create({ id: gone, params });
      await instance.waitForStatus('errored');
      // Read before the instance is disposed, which takes it away.
      const failed = await call('GET', `/comparisons/${gone}`);
      expect(failed.status).toBe(200);
      // Miniflare says why in words of its own, which the answer passes on.
      expect(await failed.json()).toEqual({
        status: 'failed',
        error: expect.stringMatching(/\S/u),
      });
    } finally {
      await instance.dispose();
    }

    // An ID of the right form with no report and no Workflow. Miniflare's own binding answers an
    // unknown instance by throwing, as Cloudflare's does, but its engine logs and hangs a request
    // as it does, so these bindings give the same refusal without it.
    const noInstance = {
      ...env,
      COMPARE: { get: () => Promise.reject(new Error('instance.not_found')) },
    } as unknown as Env;
    for (const [unknown, bindings] of [
      ['cmp-cmp-never-20261101090000', noInstance],
      ['nope', env],
      ['cmp-Upper-20261101090000', env],
      ['cmp-cmp-kept-2026110109', env],
    ] as const) {
      const response = await call('GET', `/comparisons/${unknown}`, { bindings });
      expect(response.status, unknown).toBe(404);
      expectNoStore(response);
      expect(await response.json()).toEqual({ error: 'No such comparison.' });
    }
  });
});
