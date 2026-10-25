import {
  findItem,
  parseDefinition,
  reviewOutputSchema,
  runIdFor,
  stableId,
  type Definition,
  type LlmPort,
  type ReviewProposal,
} from '@spatula/core';
import {
  autonomy,
  autonomyOf,
  getRun,
  listActions,
  proposalsOfRun,
  taxonomyHistory,
} from '@spatula/store';
import { testTaxonomy, testTaxonomyDefinition } from '@spatula/store/fixtures';
import { describe, expect, it } from 'vitest';
import { db } from '../test/node/db';
import { fakeStep, type StepCache, type World } from '../test/node/fakes';
import { published, refresh, taxonomyWorld } from '../test/node/runs';
import { standardRoutes, URLS } from '../test/pages';
import { LlmHttpError } from './llm-openai';
import { runRefresh } from './refresh';

const PHONO: ReviewProposal = {
  kind: 'add-subcategory',
  change: JSON.stringify({
    kind: 'add-subcategory',
    parent: 'amplifiers',
    slug: 'phono-stages',
    name: 'Phono stages',
    description: 'Raise and equalize a turntable cartridge’s signal',
    implies: ['pre-amp'],
    scopeClause: 'amplifiers',
  }),
  why: 'Three pages are amplifiers for turntables',
  pages: [URLS.a1, URLS.a2, URLS.b1],
};
/** PHONO under DACs, which has no subcategories: its first ones are a split. */
const UNDER_DACS: ReviewProposal = {
  ...PHONO,
  change: PHONO.change.replace('"parent":"amplifiers"', '"parent":"dacs"'),
};
const LINE_OUT: ReviewProposal = {
  kind: 'add-value',
  change: JSON.stringify({
    kind: 'add-value',
    feature: 'drives',
    slug: 'line-out',
    name: 'Line out',
    description: 'Feeds a line-level input',
  }),
  why: 'B1 drives line-level gear too',
  pages: [URLS.b1],
};

const DESCRIBE_DACS: ReviewProposal = {
  kind: 'describe',
  change: JSON.stringify({
    kind: 'describe',
    subject: 'shelf',
    item: 'dacs',
    description: 'Turn digital audio into an analog signal',
  }),
  why: 'A1 and A2 call them converters',
  pages: [URLS.a1, URLS.a2],
};

/**
 * The run's LLM, with the taxonomy review answered by these proposals (null: an answer that doesn't
 * fit the schema), at 2000 tokens in and 300 out. Returns the review's requests, as they come.
 */
function reviewing(world: World, proposals: ReviewProposal[] | null): string[] {
  const asked: string[] = [];
  const llm = world.ports.llm!;
  world.ports.llm = {
    model: llm.model,
    async structured(request) {
      // The port is generic over its schema, so the review's is told apart by identity.
      if ((request.schema as unknown) !== reviewOutputSchema) return llm.structured(request);
      asked.push(request.user);
      const parsed = request.schema.safeParse({ proposals });
      return {
        output: parsed.success ? parsed.data : null,
        usage: { inputTokens: 2000, outputTokens: 300 },
      };
    },
  };
  return asked;
}

/** An LLM that counts what it's asked and answers every call as the table says, or throws. */
function review(
  world: World,
  answer: { throws: Error } | { proposals: ReviewProposal[] },
  model: string,
): LlmPort & { asked: number } {
  const real = world.llm.llm;
  const port = {
    model,
    asked: 0,
    async structured(request: Parameters<LlmPort['structured']>[0]) {
      if ((request.schema as unknown) !== reviewOutputSchema) return real.structured(request);
      port.asked += 1;
      if ('throws' in answer) throw answer.throws;
      const parsed = request.schema.safeParse({ proposals: answer.proposals });
      return {
        output: parsed.success ? parsed.data : null,
        usage: { inputTokens: 2000, outputTokens: 300 },
      };
    },
  } as LlmPort & { asked: number };
  return port;
}

const USAGE_LIMIT = () =>
  new LlmHttpError(400, '400 You have reached your specified API usage limits.');

/** The test taxonomy dataset, with some of its definition changed. */
function changed(
  datasetId: string,
  changes: (definition: Definition) => Partial<Definition>,
): Definition {
  const base = testTaxonomyDefinition(datasetId);
  const parsed = parseDefinition({ ...base, ...changes(base) });
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
  return parsed.definition;
}

// Each test runs the pipeline against a real database, several runs in some.
describe('the taxonomy review', { timeout: 20_000 }, () => {
  it('applies an earned kind once, however often the review step runs', async () => {
    const { world } = await taxonomyWorld(testTaxonomyDefinition('review-once'));
    await db.insert(autonomy).values({
      datasetId: 'review-once',
      kind: 'add-value',
      streak: 10,
      updatedAt: world.clock.now(),
    });
    const asked = reviewing(world, [LINE_OUT]);
    const params = {
      runId: runIdFor('review-once', world.clock.now()),
      datasetId: 'review-once',
      all: true,
    };
    const cache: StepCache = new Map();
    const first = fakeStep(world.clock, cache);
    const summary = await runRefresh(params, first.step, world.ports);
    expect(first.names.slice(-4)).toEqual(['snapshot', 'captures', 'taxonomy:review', 'finish']);
    expect(summary.taxonomy).toEqual({
      proposed: 1,
      dropped: 0,
      applied: [{ version: 2, summary: 'Add Line out to Drives' }],
      inputTokens: 2000,
      outputTokens: 300,
    });

    // The step runs again, twice, as after a crash that came after it applied the change.
    for (let replay = 0; replay < 2; replay += 1) {
      cache.delete('taxonomy:review');
      cache.delete('finish');
      const again = fakeStep(world.clock, cache);
      const replayed = await runRefresh(params, again.step, world.ports);
      expect(again.replayed).not.toContain('taxonomy:review');
      expect(replayed.taxonomy).toMatchObject({
        applied: [{ version: 2, summary: 'Add Line out to Drives' }],
      });
    }
    expect(asked).toHaveLength(1);
    expect((await taxonomyHistory(db, 'review-once')).map((row) => row.version)).toEqual([2, 1]);
    const applied = (await listActions(db, 'review-once', {})).filter(
      (action) => action.action === 'apply',
    );
    expect(applied).toHaveLength(1);
    // Spatula's own application doesn't add to the kind's run.
    expect(await autonomyOf(db, 'review-once')).toContainEqual(
      expect.objectContaining({ kind: 'add-value', streak: 10, earned: true }),
    );
  });

  it('applies an earned kind and leaves a description for the owner, whatever else has been earned', async () => {
    const { world } = await taxonomyWorld(testTaxonomyDefinition('review-describe'));
    await db.insert(autonomy).values(
      ['add-subcategory', 'add-feature', 'add-value'].map((kind) => ({
        datasetId: 'review-describe',
        kind,
        streak: 12,
        updatedAt: world.clock.now(),
      })),
    );
    reviewing(world, [DESCRIBE_DACS, LINE_OUT]);
    const run = await refresh(world, 'review-describe');
    // The value applied on its own; the description, proposed by the same run, didn't.
    expect(run.summary.taxonomy).toMatchObject({
      proposed: 2,
      dropped: 0,
      applied: [{ version: 2, summary: 'Add Line out to Drives' }],
    });
    const rows = await proposalsOfRun(db, run.runId);
    expect(rows.map(({ kind, status }) => `${kind} ${status}`).sort()).toEqual([
      'add-value applied',
      'describe open',
    ]);
    expect((await taxonomyHistory(db, 'review-describe')).map((row) => row.version)).toEqual([
      2, 1,
    ]);
  });

  it('keeps what passes the checks, with its evidence and impact, and what fails as dropped', async () => {
    const { world } = await taxonomyWorld(testTaxonomyDefinition('review-kept'));
    const asked = reviewing(world, [PHONO, UNDER_DACS]);
    const run = await refresh(world, 'review-kept');
    expect(run.names.slice(-3)).toEqual(['captures', 'taxonomy:review', 'finish']);
    expect(run.summary.taxonomy).toEqual({
      proposed: 1,
      dropped: 1,
      applied: [],
      inputTokens: 2000,
      outputTokens: 300,
    });
    // The pages' titles reach the model inside the untrusted wrapper.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.startsWith('The taxonomy to review:')).toBe(true);
    expect(asked[0]!.indexOf('A1 | Maker A')).toBeGreaterThan(
      asked[0]!.indexOf('<UNTRUSTED_CONTENT>'),
    );

    const rows = new Map(
      (await proposalsOfRun(db, run.runId)).map((row) => [row.id, row] as const),
    );
    const T = testTaxonomy();
    expect(rows.get(await stableId('tp', run.runId, 0))).toMatchObject({
      kind: 'add-subcategory',
      change: { parent: findItem(T, 'shelf', 'amplifiers')!.id },
      status: 'open',
      summary: 'Add Phono stages under Amplifiers',
      why: 'Three pages are amplifiers for turntables',
      base: 1,
      evidence: {
        pages: [
          { address: URLS.a1, title: 'A1 | Maker A', shelf: 'over-ear' },
          { address: URLS.a2, title: 'A2 | Maker A', shelf: 'on-ear' },
          { address: URLS.b1, title: 'B1 Amp', shelf: 'headphone-amps' },
        ],
      },
      // Only B1's key covers Amplifiers, so only B1 is decided again, at 640 tokens a page.
      impact: {
        pagesToRedecide: 1,
        moves: [],
        questions: 0,
        leaving: 0,
        tokens: 640,
        migration: [],
      },
    });
    expect(rows.get(await stableId('tp', run.runId, 1))).toMatchObject({
      status: 'dropped',
      dropReason:
        'It doesn’t apply to version 1: changes.0: DACs has no subcategories yet: its first ones are a split, which is the owner’s.',
      impact: null,
    });
  });

  it('leaves out the pages whose site says ai-input=no', async () => {
    const routes = {
      ...standardRoutes(),
      'https://maker-a.example/robots.txt': {
        status: 200,
        body: 'User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n',
        headers: { 'content-type': 'text/plain' },
      },
    };
    const { world } = await taxonomyWorld(testTaxonomyDefinition('review-consent'), routes);
    const asked = reviewing(world, []);
    await refresh(world, 'review-consent');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(URLS.b1);
    for (const text of [URLS.a1, URLS.a2, 'A1 | Maker A', 'A2 | Maker A']) {
      expect(asked[0]).not.toContain(text);
    }
  });

  it('skips the review, and says why, when it may not ask', async () => {
    const cases: [Definition, { llm?: boolean }, string][] = [
      [
        changed('review-budget', (definition) => ({
          budget: { ...definition.budget, llmUsdPerRun: 0 },
        })),
        {},
        'this run’s LLM budget is spent',
      ],
      [
        changed('review-purpose', (definition) => ({
          policy: { ...definition.policy, purposes: [] },
        })),
        {},
        'the dataset doesn’t allow AI input',
      ],
      [testTaxonomyDefinition('review-model'), { llm: false }, 'no model is configured'],
    ];
    for (const [definition, options, reason] of cases) {
      const { world } = await taxonomyWorld(definition, standardRoutes(), options);
      const asked = options.llm === false ? [] : reviewing(world, [PHONO]);
      const run = await refresh(world, definition.dataset);
      expect(run.summary.taxonomy).toEqual({
        proposed: 0,
        dropped: 0,
        applied: [],
        inputTokens: 0,
        outputTokens: 0,
        skipped: reason,
      });
      expect(asked).toEqual([]);
    }
  });

  it('notes an answer that doesn’t fit the schema, and proposes nothing', async () => {
    const { world } = await taxonomyWorld(testTaxonomyDefinition('review-unfit'));
    reviewing(world, null);
    const run = await refresh(world, 'review-unfit');
    expect(run.summary.taxonomy).toEqual({
      proposed: 0,
      dropped: 0,
      applied: [],
      inputTokens: 2000,
      outputTokens: 300,
    });
    expect(run.summary.notes).toContain(
      'The taxonomy review’s answer didn’t fit the schema, so it proposed nothing.',
    );
  });

  it('notes a call that fails, and finishes the run with what it published', async () => {
    const { world } = await taxonomyWorld(testTaxonomyDefinition('review-failed'));
    const llm = world.ports.llm!;
    world.ports.llm = {
      model: llm.model,
      async structured(request) {
        if ((request.schema as unknown) !== reviewOutputSchema) return llm.structured(request);
        throw new Error('529 Overloaded');
      },
    };
    const run = await refresh(world, 'review-failed');
    expect(run.names.slice(-3)).toEqual(['captures', 'taxonomy:review', 'finish']);
    expect(run.summary.taxonomy).toEqual({
      proposed: 0,
      dropped: 0,
      applied: [],
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(run.summary.notes).toContain(
      'The taxonomy review’s call failed: test/model: 529 Overloaded',
    );
    expect(run.summary.snapshot).toMatchObject({ published: true });
    expect(await published(world, 'review-failed')).not.toBeNull();
    expect(await getRun(db, run.runId)).toMatchObject({ status: 'complete' });
    expect(await proposalsOfRun(db, run.runId)).toEqual([]);
  });

  it('asks the review’s backup when its model fails, and counts both', async () => {
    const definition = changed('review-backup', () => ({
      models: { taxonomyReview: { model: 'down/x', backup: 'up/y' } },
    }));
    const { world } = await taxonomyWorld(definition);
    const down = review(world, { throws: USAGE_LIMIT() }, 'down/x');
    const up = review(world, { proposals: [PHONO] }, 'up/y');
    world.ports.modelPorts = (model) => ({
      llm: model === 'down/x' ? down : model === 'up/y' ? up : world.llm.llm,
      decider: world.decider.decider,
      taxonomyDecider: world.taxonomyDecider.decider,
    });
    const run = await refresh(world, 'review-backup');
    expect(run.summary.taxonomy).toMatchObject({ proposed: 1, dropped: 0 });
    expect(down.asked).toBe(1);
    expect(up.asked).toBe(1);
    expect(run.summary.spend?.taxonomyReview?.['down/x']).toMatchObject({
      calls: 1,
      failed: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(run.summary.spend?.taxonomyReview?.['up/y']).toMatchObject({
      calls: 1,
      failed: 0,
      inputTokens: 2000,
      outputTokens: 300,
    });
    expect(run.summary.llm.down?.down?.reason).toBe('usage limit');
    expect(await proposalsOfRun(db, run.runId)).toHaveLength(1);
  });

  it('proposes nothing, with a note naming each failure, when both fail', async () => {
    const definition = changed('review-both', () => ({
      models: { taxonomyReview: { model: 'down/x', backup: 'up/y' } },
    }));
    const { world } = await taxonomyWorld(definition);
    const down = review(world, { throws: USAGE_LIMIT() }, 'down/x');
    const up = review(world, { throws: new Error('529 Overloaded') }, 'up/y');
    world.ports.modelPorts = (model) => ({
      llm: model === 'down/x' ? down : model === 'up/y' ? up : world.llm.llm,
      decider: world.decider.decider,
      taxonomyDecider: world.taxonomyDecider.decider,
    });
    const run = await refresh(world, 'review-both');
    expect(run.summary.taxonomy).toMatchObject({ proposed: 0, dropped: 0, applied: [] });
    expect(run.summary.notes).toContain(
      'The taxonomy review’s call failed: down/x: 400 You have reached your specified API usage limits.; up/y: 529 Overloaded',
    );
    expect(run.summary.spend?.taxonomyReview?.['down/x']).toMatchObject({ calls: 1, failed: 1 });
    expect(run.summary.spend?.taxonomyReview?.['up/y']).toMatchObject({ calls: 1, failed: 1 });
    expect(await proposalsOfRun(db, run.runId)).toEqual([]);
    expect(await getRun(db, run.runId)).toMatchObject({ status: 'complete' });
  });

  it('sends nothing to a provider an earlier step of the run found down', async () => {
    // A whole run: extraction's model is on 'down', which answers a usage limit on the first page
    // and so is down for the rest of the run, review included.
    const definition = changed('review-skip-down', () => ({
      models: {
        extract: { model: 'down/e', backup: 'up/y' },
        taxonomyReview: { model: 'down/x', backup: 'up/y' },
      },
    }));
    const { world } = await taxonomyWorld(definition);
    const throwing: LlmPort = {
      model: 'down/e',
      async structured() {
        throw USAGE_LIMIT();
      },
    };
    const down = review(world, { throws: USAGE_LIMIT() }, 'down/x');
    const up = review(world, { proposals: [PHONO] }, 'up/y');
    world.ports.modelPorts = (model) => ({
      llm:
        model === 'down/e'
          ? throwing
          : model === 'down/x'
            ? down
            : model === 'up/y'
              ? up
              : world.llm.llm,
      decider: world.decider.decider,
      taxonomyDecider: world.taxonomyDecider.decider,
    });
    const run = await refresh(world, 'review-skip-down');
    expect(run.summary.llm.down?.down).toBeDefined();
    expect(down.asked).toBe(0);
    expect(up.asked).toBe(1);
    expect(run.summary.taxonomy).toMatchObject({ proposed: 1 });
    expect(run.summary.spend?.taxonomyReview?.['down/x']).toMatchObject({
      calls: 1,
      failed: 1,
      inputTokens: 0,
    });
  });
});
