import {
  applyChanges,
  changeSchema,
  changeText,
  findItem,
  newId,
  type ActorRecord,
  type ProposableChange,
  type TaxonomySubject,
} from '@spatula/core';
import {
  applyDefinition,
  autonomy,
  autonomyOf,
  commitTaxonomy,
  currentTaxonomy,
  decideProposal,
  getProposal,
  listActions,
  saveProposals,
  seedTaxonomyVersion,
  type NewProposal,
} from '@spatula/store';
import { testTaxonomy, testTaxonomyDefinition } from '@spatula/store/fixtures';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { api } from '../../src/api';
import { withDatabase } from '../../src/database';
import {
  call,
  CONSUMER_TOKEN,
  consumerBindings,
  expectNoStore,
  reviewerBindings,
} from './api-support';

const T = testTaxonomy();
const id = (subject: TaxonomySubject, slug: string) => findItem(T, subject, slug)!.id;
const OWNER: ActorRecord = { role: 'owner', client: 'cli' };
const BOTH_SCOPES = 'review:answer,taxonomy:approve-additive';
const LINE_OUT = changeSchema.parse({
  kind: 'add-value',
  feature: id('feature', 'drives'),
  slug: 'line-out',
  name: 'Line out',
  description: 'Feeds a line-level input',
});
const DESCRIBE_DACS = changeSchema.parse({
  kind: 'describe',
  subject: 'shelf',
  item: id('shelf', 'dacs'),
  description: 'Turn digital audio into an analog signal',
});
const PHONO = changeSchema.parse({
  kind: 'add-subcategory',
  parent: id('shelf', 'amplifiers'),
  slug: 'phono-stages',
  name: 'Phono stages',
  description: 'Raise and equalize a turntable cartridge’s signal',
  implies: [id('function', 'pre-amp')],
  scopeClause: 'amplifiers',
});
const MERGE_PREAMPS = changeSchema.parse({
  kind: 'merge',
  subject: 'shelf',
  from: id('shelf', 'preamps'),
  into: id('shelf', 'power-amps'),
});

/**
 * A taxonomy dataset crowdio reads, seeded, with these proposals open and these dropped. Each
 * names B1 as its evidence, with its title, which a consumer must never see. It opens one database
 * client.
 */
async function ready(
  datasetId: string,
  proposals: Record<string, ProposableChange> = {},
  dropped: Record<string, ProposableChange> = {},
) {
  const row = (
    proposalId: string,
    change: ProposableChange,
    status: 'open' | 'dropped',
  ): NewProposal => ({
    id: proposalId,
    datasetId,
    runId: null,
    kind: change.kind,
    change,
    changeText: changeText(change),
    summary: null,
    why: 'The run’s pages call for it',
    evidence: {
      pages: [
        {
          address: 'https://maker-b.example/products/b1',
          title: 'B1 Amp',
          shelf: 'headphone-amps',
        },
      ],
    },
    impact: null,
    status,
    dropReason: status === 'dropped' ? 'It quotes nothing from the scope.' : null,
    base: 1,
    createdAt: new Date(),
  });
  await withDatabase(env, async (db) => {
    await applyDefinition(db, { ...testTaxonomyDefinition(datasetId), consumers: ['crowdio'] });
    await seedTaxonomyVersion(db, { datasetId, taxonomy: T, actor: OWNER, at: new Date() });
    await saveProposals(db, [
      ...Object.entries(proposals).map(([proposalId, change]) => row(proposalId, change, 'open')),
      ...Object.entries(dropped).map(([proposalId, change]) => row(proposalId, change, 'dropped')),
    ]);
  });
}

/** Calls the API as crowdio's reviewer r-7, unless told another or none, with these scopes. */
async function asCrowdio(
  method: string,
  path: string,
  options: { body?: unknown; reviewer?: string | null; scopes?: string } = {},
): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${CONSUMER_TOKEN}` });
  if (options.reviewer !== null) headers.set('x-spatula-reviewer', options.reviewer ?? 'r-7');
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const bindings = {
    ...(await consumerBindings()),
    CONSUMER_CROWDIO_SCOPES: options.scopes ?? BOTH_SCOPES,
  } as Env;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return api.request(path, { method, headers, body }, bindings);
}

describe('proposals, for the owner', () => {
  it('accepts, edits, and rejects, as versions, autonomy runs, and log entries', async () => {
    await ready('proposals-owner', {
      tp_owner_line_out: LINE_OUT,
      tp_owner_describe: DESCRIBE_DACS,
      tp_owner_phono: PHONO,
    });
    const listed = await call('GET', '/datasets/proposals-owner/proposals?status=open');
    expect(listed.status).toBe(200);
    expectNoStore(listed);
    const open = (await listed.json()) as { proposals: { id: string }[] };
    expect(open.proposals.map((proposal) => proposal.id).sort()).toEqual([
      'tp_owner_describe',
      'tp_owner_line_out',
      'tp_owner_phono',
    ]);
    expect(open.proposals[0]).toHaveProperty('evidence');

    const path = (proposalId: string) => `/datasets/proposals-owner/proposals/${proposalId}`;
    const accepted = await call('POST', path('tp_owner_line_out'), {
      body: { decision: 'accept' },
    });
    expect(accepted.status).toBe(200);
    expectNoStore(accepted);
    expect(await accepted.json()).toEqual({
      proposal: 'tp_owner_line_out',
      status: 'applied',
      version: 2,
      summary: 'Add Line out to Drives',
    });
    const edited = await call('POST', path('tp_owner_describe'), {
      body: {
        decision: 'edit',
        change: { ...DESCRIBE_DACS, description: 'Digital audio in, analog out' },
        note: 'Shorter',
      },
    });
    expect(await edited.json()).toEqual({
      proposal: 'tp_owner_describe',
      status: 'applied',
      version: 3,
      summary: 'Describe DACs anew',
    });
    const rejected = await call('POST', path('tp_owner_phono'), {
      body: { decision: 'reject', note: 'Not yet' },
    });
    expect(await rejected.json()).toEqual({ proposal: 'tp_owner_phono', status: 'rejected' });

    // A decided proposal stays decided, one that isn't there isn't, and what isn't a decision or
    // a change Spatula takes is refused.
    const again = await call('POST', path('tp_owner_phono'), { body: { decision: 'accept' } });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'That proposal isn’t open: it’s rejected.' });
    expect(
      (await call('POST', path('tp_owner_nothing'), { body: { decision: 'accept' } })).status,
    ).toBe(404);
    expect(
      (await call('POST', path('tp_owner_phono'), { body: { decision: 'maybe' } })).status,
    ).toBe(400);
    expect((await call('POST', path('tp_owner_phono'), { body: '{' })).status).toBe(400);
    const restore = await call('POST', path('tp_owner_phono'), {
      body: { decision: 'edit', change: { kind: 'restore', subject: 'shelf', item: 'dacs' } },
    });
    expect(restore.status).toBe(400);
    // The definition owns the scope: no edit makes a proposal change it.
    const rescope = await call('POST', path('tp_owner_phono'), {
      body: {
        decision: 'edit',
        change: { kind: 'scope', scope: 'Headphones alone. Out of scope: everything else.' },
      },
    });
    expect(rescope.status).toBe(400);
    expect(await rescope.json()).toEqual({
      error:
        'A proposal can’t change the scope: it comes from the dataset’s definition, which the owner changes.',
    });
    expect((await call('GET', '/datasets/proposals-owner/proposals?status=maybe')).status).toBe(
      400,
    );
    expect((await call('GET', '/datasets/proposals-nowhere/proposals')).status).toBe(404);

    const history = (await (
      await call('GET', '/datasets/proposals-owner/taxonomy/versions')
    ).json()) as { versions: { version: number; proposalId: string | null }[] };
    expect(history.versions.map(({ version, proposalId }) => [version, proposalId])).toEqual([
      [3, 'tp_owner_describe'],
      [2, 'tp_owner_line_out'],
      [1, null],
    ]);
    const runs = (await (await call('GET', '/datasets/proposals-owner/autonomy')).json()) as {
      after: number;
      kinds: { kind: string; streak: number }[];
    };
    expect(runs.after).toBe(10);
    expect(runs.kinds.map(({ kind, streak }) => [kind, streak])).toEqual([
      ['add-subcategory', 0],
      ['add-feature', 0],
      ['add-value', 1],
    ]);
    const log = await withDatabase(env, (db) => listActions(db, 'proposals-owner', {}));
    expect(log.map(({ action, subject }) => `${action} ${subject}`).sort()).toEqual([
      'accept tp_owner_line_out',
      'edit tp_owner_describe',
      'reject tp_owner_phono',
    ]);
  });
});

describe('a description, for the owner', () => {
  it('applies when the owner approves it, and counts toward no run', async () => {
    await ready('proposals-describe', { tp_describe_dacs: DESCRIBE_DACS });
    const accepted = await call('POST', '/datasets/proposals-describe/proposals/tp_describe_dacs', {
      body: { decision: 'accept' },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      proposal: 'tp_describe_dacs',
      status: 'applied',
      version: 2,
      summary: 'Describe DACs anew',
    });
    // No kind of its own to list, and no row behind any kind.
    const runs = (await (await call('GET', '/datasets/proposals-describe/autonomy')).json()) as {
      kinds: { kind: string; streak: number }[];
    };
    expect(runs.kinds.map(({ kind, streak }) => [kind, streak])).toEqual([
      ['add-subcategory', 0],
      ['add-feature', 0],
      ['add-value', 0],
    ]);
    expect(
      await withDatabase(env, (db) =>
        db.select().from(autonomy).where(eq(autonomy.datasetId, 'proposals-describe')),
      ),
    ).toEqual([]);
  });
});

describe('proposals, for a consumer’s reviewer', () => {
  it('lists and decides the additive kinds alone, sees no page text, and counts toward autonomy', async () => {
    await ready('proposals-crowdio', {
      tp_crowdio_line_out: LINE_OUT,
      tp_crowdio_describe: DESCRIBE_DACS,
      tp_crowdio_phono: PHONO,
    });
    const path = (proposalId: string) => `/datasets/proposals-crowdio/proposals/${proposalId}`;
    const listed = await asCrowdio('GET', '/datasets/proposals-crowdio/proposals');
    expect(listed.status).toBe(200);
    expectNoStore(listed);
    const seen = (await listed.json()) as { proposals: Record<string, unknown>[] };
    expect(seen.proposals.map((proposal) => proposal.id).sort()).toEqual([
      'tp_crowdio_line_out',
      'tp_crowdio_phono',
    ]);
    // Neither the evidence nor the review's reasons reach a consumer: both carry page text.
    for (const proposal of seen.proposals) {
      expect(proposal).not.toHaveProperty('evidence');
      expect(proposal).not.toHaveProperty('why');
    }

    const accepted = await asCrowdio('POST', path('tp_crowdio_line_out'), {
      body: { decision: 'accept' },
    });
    expect(await accepted.json()).toEqual({
      proposal: 'tp_crowdio_line_out',
      status: 'applied',
      version: 2,
      summary: 'Add Line out to Drives',
    });
    const description = await asCrowdio('POST', path('tp_crowdio_describe'), {
      body: { decision: 'accept' },
    });
    expect(description.status).toBe(403);
    expect(await description.json()).toEqual({
      error: 'Only the owner decides describe proposals.',
    });
    const edit = await asCrowdio('POST', path('tp_crowdio_phono'), {
      body: { decision: 'edit', change: PHONO },
    });
    expect(edit.status).toBe(403);
    expect(await edit.json()).toEqual({ error: 'Only the owner edits a proposal.' });
    // An edit that would turn an additive proposal into the owner's kind is refused the same way,
    // and applies nothing.
    const toMerge = await asCrowdio('POST', path('tp_crowdio_phono'), {
      body: { decision: 'edit', change: MERGE_PREAMPS },
    });
    expect(toMerge.status).toBe(403);
    expect(await toMerge.json()).toEqual({ error: 'Only the owner edits a proposal.' });
    const anonymous = await asCrowdio('POST', path('tp_crowdio_phono'), {
      body: { decision: 'reject' },
      reviewer: null,
    });
    expect(anonymous.status).toBe(400);
    const unscoped = { scopes: 'review:answer' };
    expect((await asCrowdio('GET', '/datasets/proposals-crowdio/proposals', unscoped)).status).toBe(
      403,
    );
    expect(
      (
        await asCrowdio('POST', path('tp_crowdio_phono'), {
          body: { decision: 'reject' },
          ...unscoped,
        })
      ).status,
    ).toBe(403);
    for (const [method, route] of [
      ['GET', '/datasets/proposals-crowdio/taxonomy/versions'],
      ['POST', '/datasets/proposals-crowdio/taxonomy/versions/2/undo'],
      ['GET', '/datasets/proposals-crowdio/autonomy'],
      ['POST', '/datasets/proposals-crowdio/autonomy/add-value/revoke'],
    ] as const) {
      expect((await asCrowdio(method, route)).status).toBe(403);
    }
    // Only the accepted proposal became a version, and the refused ones are still open.
    const versions = await withDatabase(
      env,
      async (db) => (await currentTaxonomy(db, 'proposals-crowdio'))?.version,
    );
    expect(versions).toBe(2);
    const stillOpen = (await (
      await call('GET', '/datasets/proposals-crowdio/proposals?status=open')
    ).json()) as { proposals: { id: string }[] };
    expect(stillOpen.proposals.map((proposal) => proposal.id).sort()).toEqual([
      'tp_crowdio_describe',
      'tp_crowdio_phono',
    ]);

    // The reviewer's approval counts toward add-value's run, and the log says who gave it.
    const runs = (await (await call('GET', '/datasets/proposals-crowdio/autonomy')).json()) as {
      kinds: { kind: string; streak: number }[];
    };
    expect(runs.kinds.find(({ kind }) => kind === 'add-value')?.streak).toBe(1);
    const log = await withDatabase(env, (db) => listActions(db, 'proposals-crowdio', {}));
    expect(log).toEqual([
      expect.objectContaining({
        action: 'accept',
        subject: 'tp_crowdio_line_out',
        actor: { role: 'reviewer', client: 'consumer', consumer: 'crowdio', reviewer: 'r-7' },
      }),
    ]);
  });

  it('never shows a consumer a dropped proposal, which the owner still sees', async () => {
    const balanced = changeSchema.parse({
      kind: 'add-value',
      feature: id('feature', 'drives'),
      slug: 'balanced',
      name: 'Balanced',
      description: 'Feeds a balanced input',
    });
    await ready(
      'proposals-dropped',
      { tp_dropped_line_out: LINE_OUT },
      { tp_dropped_balanced: balanced },
    );
    const idsOf = async (response: Response) =>
      ((await response.json()) as { proposals: { id: string }[] }).proposals
        .map((proposal) => proposal.id)
        .sort();

    // A dropped proposal's text is the review's, unchecked: not in the reviewer's list, however
    // the reviewer asks for it.
    const listed = await asCrowdio('GET', '/datasets/proposals-dropped/proposals');
    expect(await idsOf(listed)).toEqual(['tp_dropped_line_out']);
    const asked = await asCrowdio('GET', '/datasets/proposals-dropped/proposals?status=dropped');
    expect(asked.status).toBe(200);
    expect(await idsOf(asked)).toEqual([]);
    // The owner sees both, and why one was dropped.
    expect(await idsOf(await call('GET', '/datasets/proposals-dropped/proposals'))).toEqual([
      'tp_dropped_balanced',
      'tp_dropped_line_out',
    ]);
    const dropped = (await (
      await call('GET', '/datasets/proposals-dropped/proposals?status=dropped')
    ).json()) as { proposals: { id: string; dropReason: string }[] };
    expect(dropped.proposals).toEqual([
      expect.objectContaining({
        id: 'tp_dropped_balanced',
        dropReason: 'It quotes nothing from the scope.',
      }),
    ]);
  });

  it('answers 401 to a missing or wrong token on every route it reaches', async () => {
    await ready('proposals-token', { tp_token_line_out: LINE_OUT });
    for (const [method, route] of [
      ['GET', '/datasets/proposals-token/proposals'],
      ['POST', '/datasets/proposals-token/proposals/tp_token_line_out'],
      ['GET', '/datasets/proposals-token/taxonomy/versions'],
      ['POST', '/datasets/proposals-token/taxonomy/versions/2/undo'],
      ['GET', '/datasets/proposals-token/autonomy'],
      ['POST', '/datasets/proposals-token/autonomy/add-value/revoke'],
    ] as const) {
      const body = method === 'POST' ? { decision: 'accept' } : undefined;
      for (const token of [null, 'not-the-token']) {
        const refused = await call(method, route, { token, body });
        expect(refused.status, `${method} ${route} with ${token ?? 'no token'}`).toBe(401);
        expect(refused.headers.get('www-authenticate')).toBe('Bearer');
        expectNoStore(refused);
      }
    }
  });
});

describe('the limiters, on the writes of proposals, undo, and autonomy', () => {
  const LIMITED =
    'That’s more writes this minute than the review API takes. Wait a minute, then send the rest.';

  /**
   * Bindings whose two limiters count the writes they are asked about, in order, and refuse every
   * one while `refusing` says so. A consumer's write asks the consumer's bucket, then the
   * reviewer's; the owner's asks one.
   */
  async function counting(scopes = BOTH_SCOPES) {
    const asked: string[] = [];
    const state = { refusing: false };
    const limiter = (name: string): RateLimit => ({
      limit: ({ key }) => {
        asked.push(`${name} ${key}`);
        return Promise.resolve({ success: !state.refusing });
      },
    });
    const bindings = {
      ...(await reviewerBindings(scopes)),
      CONSUMER_REVIEW_LIMITER: limiter('consumer'),
      REVIEW_LIMITER: limiter('reviewer'),
    } as Env;
    return { asked, state, bindings };
  }

  const reviewer = (bindings: Env, method: string, path: string, body?: unknown) =>
    call(method, path, {
      token: CONSUMER_TOKEN,
      bindings,
      headers: { 'x-spatula-reviewer': 'r-7' },
      body,
    });

  it('counts a reviewer’s decision against its consumer and then itself, and refuses it past either', async () => {
    await ready('proposals-limits', {
      tp_limits_line_out: LINE_OUT,
      tp_limits_phono: PHONO,
    });
    const { asked, state, bindings } = await counting();
    const decide = (proposalId: string, decision: string) =>
      reviewer(bindings, 'POST', `/datasets/proposals-limits/proposals/${proposalId}`, {
        decision,
      });

    // A read costs nothing. A decision asks the consumer's bucket first.
    expect((await reviewer(bindings, 'GET', '/datasets/proposals-limits/proposals')).status).toBe(
      200,
    );
    expect(asked).toEqual([]);
    expect((await decide('tp_limits_line_out', 'accept')).status).toBe(200);
    expect(asked).toEqual(['consumer crowdio', 'reviewer crowdio:r-7']);

    // Refused, it answers 429 and applies nothing: no new version, and the proposal is open.
    state.refusing = true;
    const refused = await decide('tp_limits_phono', 'accept');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expectNoStore(refused);
    expect(await refused.json()).toEqual({ error: LIMITED });
    // The consumer's bucket said no first, so the reviewer's was not asked.
    expect(asked.slice(2)).toEqual(['consumer crowdio']);
    expect(await withDatabase(env, (db) => currentTaxonomy(db, 'proposals-limits'))).toMatchObject({
      version: 2,
    });
    expect(await withDatabase(env, (db) => getProposal(db, 'tp_limits_phono'))).toMatchObject({
      status: 'open',
    });
    expect(await withDatabase(env, (db) => listActions(db, 'proposals-limits', {}))).toHaveLength(
      1,
    );
  });

  it('counts the owner’s decision, undo, and revoke, and a refused one changes nothing', async () => {
    await ready('proposals-limits-owner', {
      tp_limitsown_line_out: LINE_OUT,
      tp_limitsown_phono: PHONO,
    });
    await withDatabase(env, (db) =>
      db.insert(autonomy).values({
        datasetId: 'proposals-limits-owner',
        kind: 'add-feature',
        streak: 12,
        updatedAt: new Date(),
      }),
    );
    const { asked, state, bindings } = await counting();
    const owner = (path: string, body?: unknown) =>
      call('POST', `/datasets/proposals-limits-owner/${path}`, { bindings, body });
    const accept = (proposalId: string) => owner(`proposals/${proposalId}`, { decision: 'accept' });
    const version = async () =>
      (await withDatabase(env, (db) => currentTaxonomy(db, 'proposals-limits-owner')))?.version;
    const streak = async () =>
      (await withDatabase(env, (db) => autonomyOf(db, 'proposals-limits-owner'))).find(
        ({ kind }) => kind === 'add-feature',
      )?.streak;

    expect((await accept('tp_limitsown_line_out')).status).toBe(200);
    expect(await version()).toBe(2);

    // With the limiter refusing, each write answers 429 and changes nothing.
    state.refusing = true;
    const decision = await accept('tp_limitsown_phono');
    expect(decision.status).toBe(429);
    expect(await decision.json()).toEqual({ error: LIMITED });
    expect(await withDatabase(env, (db) => getProposal(db, 'tp_limitsown_phono'))).toMatchObject({
      status: 'open',
    });
    const undo = await owner('taxonomy/versions/2/undo');
    expect(undo.status).toBe(429);
    expect(undo.headers.get('retry-after')).toBe('60');
    expectNoStore(undo);
    expect(await undo.json()).toEqual({ error: LIMITED });
    expect(await version()).toBe(2);
    const revoke = await owner('autonomy/add-feature/revoke');
    expect(revoke.status).toBe(429);
    expect(await revoke.json()).toEqual({ error: LIMITED });
    expect(await streak()).toBe(12);

    // With room again, the same writes go through.
    state.refusing = false;
    expect((await owner('taxonomy/versions/2/undo')).status).toBe(200);
    expect(await version()).toBe(3);
    expect(await (await owner('autonomy/add-feature/revoke')).json()).toEqual({
      kind: 'add-feature',
      streak: 0,
      was: 12,
    });
    // Every one was the owner's, and counted: the accepted, the three refused, the two that went
    // through.
    expect(asked).toEqual(Array.from({ length: 6 }, () => 'reviewer owner'));
  });

  it('spends no limiter tokens on a write it turns away before the limiter', async () => {
    await ready('proposals-limits-turned', { tp_limitsturned_phono: PHONO });
    const { asked, bindings } = await counting();
    const withoutScope = await counting('review:answer');
    const base = '/datasets/proposals-limits-turned';
    // The owner's routes answer a consumer 403 before anything is counted.
    expect((await reviewer(bindings, 'POST', `${base}/taxonomy/versions/1/undo`)).status).toBe(403);
    expect((await reviewer(bindings, 'POST', `${base}/autonomy/add-value/revoke`)).status).toBe(
      403,
    );
    // So do a decision without the scope, and one that doesn't name its reviewer.
    expect(
      (
        await reviewer(withoutScope.bindings, 'POST', `${base}/proposals/tp_limitsturned_phono`, {
          decision: 'reject',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `${base}/proposals/tp_limitsturned_phono`, {
          token: CONSUMER_TOKEN,
          bindings,
          body: { decision: 'reject' },
        })
      ).status,
    ).toBe(400);
    expect(asked).toEqual([]);
    expect(withoutScope.asked).toEqual([]);
  });
});

describe('taxonomy versions and autonomy', () => {
  it('undoes a version as a new one, and takes autonomy from the kind Spatula applied it as', async () => {
    await ready('proposals-undo', { tp_undo_line_out: LINE_OUT });
    // Spatula applies the add-value on its own, as a run does once the kind has earned it.
    await withDatabase(env, async (db) => {
      await db.insert(autonomy).values({
        datasetId: 'proposals-undo',
        kind: 'add-value',
        streak: 10,
        updatedAt: new Date(),
      });
      await decideProposal(db, {
        id: 'tp_undo_line_out',
        decision: 'accept',
        actor: { role: 'decider', client: 'run' },
        autonomous: true,
        makeId: () => newId('tx'),
        at: new Date(),
      });
    });
    const undo = (version: string, datasetId = 'proposals-undo') =>
      call('POST', `/datasets/${datasetId}/taxonomy/versions/${version}/undo`);
    const undone = await undo('2');
    expect(undone.status).toBe(200);
    expectNoStore(undone);
    expect(await undone.json()).toEqual({
      undone: 2,
      version: 3,
      summary: 'Retire Line out',
      revoked: 'add-value',
    });
    const runs = (await (await call('GET', '/datasets/proposals-undo/autonomy')).json()) as {
      kinds: { kind: string; streak: number }[];
    };
    expect(runs.kinds.find(({ kind }) => kind === 'add-value')?.streak).toBe(0);

    const again = await undo('2');
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'Version 2 was undone already, by version 3.' });
    expect(await (await undo('1')).json()).toEqual({
      error: 'Version 1 is the seed: there’s nothing before it to go back to.',
    });
    expect((await undo('9')).status).toBe(404);
    expect((await undo('x')).status).toBe(400);
    expect((await undo('2', 'proposals-nowhere')).status).toBe(404);
    const log = await withDatabase(env, (db) => listActions(db, 'proposals-undo', {}));
    expect(log.map(({ action, subject }) => `${action} ${subject}`)).toEqual(['undo version:2']);
  });

  it('undoes a batch last change first, and a description once', async () => {
    await ready('proposals-batch', { tp_batch_describe: DESCRIBE_DACS });
    // Version 2 makes a function and has a shelf imply it. Undone in the order they were made, the
    // function would go while the shelf still implied it.
    await withDatabase(env, async (db) => {
      const batch = applyChanges(
        T,
        [
          {
            kind: 'add-function',
            slug: 'streamer',
            name: 'Streamer',
            description: 'Plays a stream',
          },
          { kind: 'implies', shelf: 'dacs', implies: ['dac', 'streamer'] },
        ],
        () => newId('tx'),
      );
      if (!batch.ok) throw new Error(batch.issues.join(' '));
      await commitTaxonomy(db, {
        datasetId: 'proposals-batch',
        base: 1,
        taxonomy: batch.taxonomy,
        changes: batch.applied,
        actor: OWNER,
        at: new Date(),
      });
    });
    const undo = (version: number) =>
      call('POST', `/datasets/proposals-batch/taxonomy/versions/${version}/undo`);
    const undone = await undo(2);
    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({
      undone: 2,
      version: 3,
      summary: 'Change what DACs implies; Retire Streamer',
      revoked: null,
    });

    const accepted = await call('POST', '/datasets/proposals-batch/proposals/tp_batch_describe', {
      body: { decision: 'accept' },
    });
    expect(accepted.status).toBe(200);
    const described = await undo(4);
    expect(described.status).toBe(200);
    // A description's inverse would apply a second time, so only the record of the first undo
    // stops it.
    const twice = await undo(4);
    expect(twice.status).toBe(409);
    expect(await twice.json()).toEqual({ error: 'Version 4 was undone already, by version 5.' });
  });

  it('revokes a kind’s autonomy, and says which kinds never have any, a description among them', async () => {
    await ready('proposals-revoke');
    await withDatabase(env, (db) =>
      db.insert(autonomy).values({
        datasetId: 'proposals-revoke',
        kind: 'add-value',
        streak: 12,
        updatedAt: new Date(),
      }),
    );
    const revoke = (kind: string) =>
      call('POST', `/datasets/proposals-revoke/autonomy/${kind}/revoke`);
    const revoked = await revoke('add-value');
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ kind: 'add-value', streak: 0, was: 12 });
    const merge = await revoke('merge');
    expect(merge.status).toBe(400);
    expect(await merge.json()).toEqual({
      error:
        'merge never applies on its own: it’s always the owner’s, so there’s nothing to revoke.',
    });
    // A description is a kind of change, but never one that applies on its own.
    const describing = await revoke('describe');
    expect(describing.status).toBe(400);
    expect(await describing.json()).toEqual({
      error:
        'describe never applies on its own: it’s always the owner’s, so there’s nothing to revoke.',
    });
    expect((await revoke('teleport')).status).toBe(404);
    const log = await withDatabase(env, (db) => listActions(db, 'proposals-revoke', {}));
    expect(log.map(({ action, subject }) => `${action} ${subject}`)).toEqual([
      'revoke autonomy:add-value',
    ]);
  });

  it('answers the same routes under /console/api, for the console behind Access', () => {
    const paths = api.routes.map((route) => route.path);
    for (const path of [
      '/datasets/:id/proposals',
      '/datasets/:id/proposals/:proposalId',
      '/datasets/:id/taxonomy/versions',
      '/datasets/:id/taxonomy/versions/:version/undo',
      '/datasets/:id/autonomy',
      '/datasets/:id/autonomy/:kind/revoke',
    ]) {
      expect(paths).toContain(path);
      expect(paths).toContain(`/console/api${path}`);
    }
  });
});
