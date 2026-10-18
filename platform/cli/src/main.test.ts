import {
  sha256Hex,
  type ApplySummary,
  type DatasetStatus,
  type DiscoverySummary,
  type EvalView,
  type ItemView,
  type ReviewView,
  type RunSummary,
  type RunView,
} from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { POLL_MS, WAIT_LIMIT_MS, type Io } from './commands';
import { describeError, printable } from './format';
import { failureLine, main, USAGE } from './main';

const ENV = { SPATULA_URL: 'https://spatula.test', SPATULA_TOKEN: 'owner-token' };
const DEFINITION = testDefinition('cli-products');
const FILES = { 'cli-products.yaml': stringify(DEFINITION) };
const RUN_ID = 'cli-products-202610100000';

/** Files in memory, and every line the CLI prints. */
function memoryIo(files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  const sleeps: number[] = [];
  const io: Io = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    async readFile(path) {
      const text = files[path];
      if (text === undefined) throw new Error('no such file');
      return text;
    },
    async writeFile(path, data) {
      written.set(path, data);
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
  };
  return { io, out, err, written, sleeps };
}

interface Sent {
  method: string;
  origin: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

/** A stub of the API: every request is logged and answered by `answer`. */
function stubApi(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: Sent = {
      method: init?.method ?? 'GET',
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get('authorization'),
    };
    sent.push(request);
    return answer(request);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const RUNNING: RunView = {
  id: RUN_ID,
  datasetId: 'cli-products',
  status: 'running',
  startedAt: '2026-10-10T00:00:00.000Z',
  finishedAt: null,
  summary: null,
  error: null,
};

describe('check', () => {
  it('checks a definition without sending it', async () => {
    const { io, out } = memoryIo(FILES);
    const { fetch, sent } = stubApi(() => {
      throw new Error('check sends nothing');
    });
    expect(await main(['check', 'cli-products.yaml'], { io, env: {}, fetch })).toBe(0);
    expect(out).toEqual([
      'cli-products: 1 record type, 2 sources, 3 pages. Nothing is wrong with it.',
    ]);
    expect(sent).toHaveLength(0);
  });

  it('counts a sitemap source’s sitemaps', async () => {
    const definition = {
      ...DEFINITION,
      sources: [
        {
          id: 'maker-c',
          kind: 'sitemap',
          recordType: 'product',
          sitemaps: ['https://maker-c.example/a.xml', 'https://maker-c.example/b.xml'],
          include: ['/products/*'],
          fixed: { brand: 'Maker C', category: 'Headphones' },
          evidence: DEFINITION.sources[0]!.evidence,
        },
      ],
    };
    const { io, out } = memoryIo({ 'c.yaml': stringify(definition) });
    expect(await main(['check', 'c.yaml'], { io, env: ENV })).toBe(0);
    expect(out).toEqual([
      'cli-products: 1 record type, 1 source, 2 sitemaps. Nothing is wrong with it.',
    ]);
  });

  it('lists what’s wrong with a definition, or with its YAML', async () => {
    const training = stringify({
      ...DEFINITION,
      policy: { purposes: ['ai-train'], perHostIntervalMs: 1000 },
    });
    const { io, err } = memoryIo({
      'training.yaml': training,
      'broken.yaml': 'dataset: [unclosed',
    });
    expect(await main(['check', 'training.yaml'], { io, env: {} })).toBe(1);
    expect(err[0]).toMatch(/^training\.yaml has (a problem|\d+ problems):$/u);
    expect(err.join('\n')).toContain('policy.purposes');

    // The YAML library's message has several lines, so the first line printed is the one to read.
    const before = err.length;
    expect(await main(['check', 'broken.yaml'], { io, env: {} })).toBe(1);
    expect(err[before]).toMatch(/^broken\.yaml isn’t valid YAML: /u);
    expect(await main(['check', 'missing.yaml'], { io, env: {} })).toBe(1);
    expect(err.at(-1)).toBe('missing.yaml can’t be read: no such file');
  });

  it('prints a YAML error’s code frame a line at a time', async () => {
    const { io, err } = memoryIo({ 'broken.yaml': 'dataset: [unclosed' });
    expect(await main(['check', 'broken.yaml'], { io, env: {} })).toBe(1);
    expect(err[0]).toMatch(/^broken\.yaml isn’t valid YAML: .+ at line 1, column \d+:$/u);
    expect(err).toContain('dataset: [unclosed');
    // A newline inside a line would have been spelled out as \u{a}.
    expect(err.join('\n')).not.toContain(String.raw`\u{a}`);
  });
});

describe('plan and apply', () => {
  it('send the definition as the owner, and say what changes', async () => {
    const summary: ApplySummary = {
      dataset: 'cli-products',
      revision: 1,
      created: true,
      changed: true,
      sources: { added: ['maker-a', 'maker-b'], removed: [], changed: [] },
      pages: { added: 3, removed: 0 },
    };
    const { fetch, sent } = stubApi(() => Response.json(summary));
    const { io, out } = memoryIo(FILES);
    expect(await main(['plan', 'cli-products.yaml'], { io, env: ENV, fetch })).toBe(0);
    expect(await main(['apply', 'cli-products.yaml'], { io, env: ENV, fetch })).toBe(0);

    expect(
      sent.map(({ method, path, authorization }) => ({ method, path, authorization })),
    ).toEqual([
      {
        method: 'PUT',
        path: '/datasets/cli-products?dryRun=1',
        authorization: 'Bearer owner-token',
      },
      { method: 'PUT', path: '/datasets/cli-products', authorization: 'Bearer owner-token' },
    ]);
    expect(sent[0]!.body).toEqual(DEFINITION);
    expect(out).toEqual([
      'cli-products would be created at revision 1.',
      'Sources added: maker-a, maker-b.',
      'Pages: 3 added, 0 removed.',
      'cli-products was created at revision 1.',
      'Sources added: maker-a, maker-b.',
      'Pages: 3 added, 0 removed.',
    ]);
  });

  it('show what the API refused, and why', async () => {
    const { fetch } = stubApi(() =>
      Response.json(
        {
          error: 'The definition has problems.',
          issues: ['dataset: it says x, but the address says y'],
        },
        { status: 400 },
      ),
    );
    const { io, err } = memoryIo(FILES);
    expect(await main(['apply', 'cli-products.yaml'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual([
      'The definition has problems.',
      '  dataset: it says x, but the address says y',
    ]);
  });

  it('ask for the owner token before calling the API', async () => {
    const { io, err } = memoryIo(FILES);
    expect(await main(['plan', 'cli-products.yaml'], { io, env: {} })).toBe(1);
    expect(err).toEqual(['Set SPATULA_TOKEN to the owner token.']);
  });

  // A header can't hold these, and fetch's error for one quotes the header, token and all.
  it.each([
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a NUL', '\u{0}'],
    ['a tab', '\t'],
    ['DEL', '\u{7f}'],
  ])(
    'refuse a token holding %s, before any request, without printing it',
    async (_what, control) => {
      let requests = 0;
      const fetch = (async () => {
        requests += 1;
        return Response.json({
          dataset: 'cli-products',
          revision: 1,
          created: false,
          changed: false,
          sources: { added: [], removed: [], changed: [] },
          pages: { added: 0, removed: 0 },
        });
      }) as typeof globalThis.fetch;
      const { io, out, err } = memoryIo(FILES);
      const env = {
        SPATULA_URL: 'https://spatula.test',
        SPATULA_TOKEN: `sekrit${control}tokenpart`,
      };
      expect(await main(['plan', 'cli-products.yaml'], { io, env, fetch })).toBe(1);
      expect(err).toEqual(['SPATULA_TOKEN holds a control character.']);
      expect(requests).toBe(0);
      for (const line of [...out, ...err]) {
        expect(line).not.toContain('sekrit');
        expect(line).not.toContain('tokenpart');
      }
    },
  );
});

describe('run', () => {
  it('starts a run and waits for it to finish', async () => {
    const complete: RunView = {
      ...RUNNING,
      status: 'complete',
      finishedAt: '2026-10-10T00:01:00.000Z',
      summary: {
        items: 3,
        fetches: { changed: 3, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
        statements: { added: 19, reseen: 0, withdrawn: 0 },
        llm: { ran: 3, reused: 0, skipped: 0, failed: 0, inputTokens: 3000, outputTokens: 150 },
        entities: { created: 3, linked: 0, conflicts: 0, unresolved: 0 },
        snapshot: { published: true, generation: 1, snapshotId: 'sn_x', records: 3, excluded: [] },
        notes: ['https://maker-b.example/products/b1: dropped 1 of the LLM’s values'],
      },
    };
    const answers = [RUNNING, RUNNING, complete];
    const { fetch } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ runId: RUN_ID }, { status: 202 })
        : Response.json(answers.shift()),
    );
    const { io, out, sleeps } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
    expect(sleeps).toEqual([2000, 2000]);
    expect(out).toEqual([
      `Started ${RUN_ID}.`,
      `Run ${RUN_ID}: complete.`,
      'Pages: 3. Changed 3, unchanged 0, gone 0, failed 0, blocked 0.',
      'Statements: 19 added, 0 seen again, 0 withdrawn.',
      'LLM: ran 3, reused 0, skipped 0, failed 0; 3000 tokens in, 150 out.',
      'Entities: 3 new, 0 linked, 0 conflicts, 0 without an identity yet.',
      'Snapshot: generation 1, 3 records.',
      'Notes:',
      '  https://maker-b.example/products/b1: dropped 1 of the LLM’s values',
    ]);
  });

  it('follows the run already started in this slot, and fails when it fails', async () => {
    const failed: RunView = {
      ...RUNNING,
      status: 'failed',
      error: 'Dataset cli-products doesn’t exist',
    };
    const { fetch } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json(
            { error: 'A run already started in this five-minute slot.', runId: RUN_ID },
            { status: 409 },
          )
        : Response.json(failed),
    );
    const { io, out } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(1);
    expect(out).toEqual([
      `A run already started in this five-minute slot: ${RUN_ID}.`,
      `Run ${RUN_ID} failed: Dataset cli-products doesn’t exist`,
    ]);
  });

  it('refuses, in the API’s words and with exit 1, when another run is in the way, and follows none', async () => {
    // A run from an earlier slot, still working: the run asked for never started, so the slot's
    // sentence would be wrong, and following the other run would report on a run that isn't it.
    // `spatula apply && spatula run x --wait` must not go on to use a snapshot the run didn't make.
    const going = 'cli-products-202610090000';
    const message = `A run of cli-products is already running (${going}). Wait for it to finish.`;
    const { fetch, sent } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ error: message, runId: going }, { status: 409 })
        : Response.json({ ...RUNNING, id: going, status: 'complete' }),
    );
    for (const argv of [
      ['run', 'cli-products', '--wait'],
      ['run', 'cli-products'],
    ]) {
      sent.length = 0;
      const { io, out, err } = memoryIo();
      expect(await main(argv, { io, env: ENV, fetch }), argv.join(' ')).toBe(1);
      expect(err, argv.join(' ')).toEqual([message]);
      expect(out, argv.join(' ')).toEqual([]);
      // Only the start was sent: the other run was not asked after.
      expect(
        sent.map(({ method, path }) => ({ method, path })),
        argv.join(' '),
      ).toEqual([{ method: 'POST', path: '/datasets/cli-products/runs' }]);
    }
  });

  it('says the slot’s sentence when the API gives a run but no words for it', async () => {
    const { fetch } = stubApi(() => Response.json({ runId: RUN_ID }, { status: 409 }));
    const { io, out } = memoryIo();
    expect(await main(['run', 'cli-products'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual([`A run already started in this five-minute slot: ${RUN_ID}.`]);
  });

  it('stops waiting after an hour', async () => {
    // The API answers running until a run finishes, so a stuck run would keep the CLI asking for
    // ever. The stub's own limit makes a loop that never ends fail this test instead of hanging it.
    let polls = 0;
    const { fetch } = stubApi(({ method }) => {
      if (method === 'POST') return Response.json({ runId: RUN_ID }, { status: 202 });
      polls += 1;
      if (polls > 5000) throw new Error('still being asked after 5000 polls');
      return Response.json(RUNNING);
    });
    const { io, out, err, sleeps } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual([`Stopped waiting after 60 minutes; ${RUN_ID} is still running.`]);
    expect(out).toEqual([`Started ${RUN_ID}.`]);
    expect(polls).toBe(WAIT_LIMIT_MS / POLL_MS);
    expect(sleeps).toHaveLength(WAIT_LIMIT_MS / POLL_MS);
    expect(new Set(sleeps)).toEqual(new Set([POLL_MS]));
  });

  it('still reports a run that finishes on the last poll before that', async () => {
    const lastPoll = WAIT_LIMIT_MS / POLL_MS;
    const complete: RunView = { ...RUNNING, status: 'complete', finishedAt: RUNNING.startedAt };
    let polls = 0;
    const { fetch } = stubApi(({ method }) => {
      if (method === 'POST') return Response.json({ runId: RUN_ID }, { status: 202 });
      polls += 1;
      if (polls > 5000) throw new Error('still being asked after 5000 polls');
      return Response.json(polls < lastPoll ? RUNNING : complete);
    });
    const { io, out, err, sleeps } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([`Started ${RUN_ID}.`, `Run ${RUN_ID}: complete.`]);
    expect(polls).toBe(lastPoll);
    expect(sleeps).toHaveLength(lastPoll - 1);
  });

  it('reads every page with --all, and says how many were due', async () => {
    const complete: RunView = {
      ...RUNNING,
      status: 'complete',
      finishedAt: '2026-10-10T00:01:00.000Z',
      summary: {
        items: 2,
        live: 9,
        due: 5,
        fetches: { changed: 1, unchanged: 1, gone: 0, failed: 0, blocked: 0 },
        statements: { added: 4, reseen: 6, withdrawn: 0 },
        llm: { ran: 1, reused: 0, skipped: 1, failed: 0, inputTokens: 1000, outputTokens: 50 },
        entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
        snapshot: { published: false, reason: 'nothing changed since generation 4', excluded: [] },
        notes: [],
      },
    };
    const { fetch, sent } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ runId: RUN_ID }, { status: 202 })
        : Response.json(complete),
    );
    const { io, out } = memoryIo();
    expect(await main(['run', 'cli-products', '--all', '--wait'], { io, env: ENV, fetch })).toBe(0);
    expect(sent[0]!.path).toBe('/datasets/cli-products/runs?all=1');
    expect(out).toContain(
      'Pages: 2 read, of 5 due and 9 live. Changed 1, unchanged 1, gone 0, failed 0, blocked 0.',
    );
  });

  it('says what the sitemaps listed, and which sources weren’t read completely', async () => {
    const complete: RunView = {
      ...RUNNING,
      status: 'complete',
      summary: {
        items: 0,
        live: 2,
        due: 0,
        discovery: {
          sources: 2,
          sitemaps: 3,
          listed: 2,
          added: 1,
          revived: 0,
          missing: 0,
          gone: 0,
          incomplete: ['maker-d: https://maker-d.example/sitemap.xml: failed (HTTP 503)'],
        },
        fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
        statements: { added: 0, reseen: 0, withdrawn: 0 },
        llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
        entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
        snapshot: { published: false, reason: 'nothing changed since generation 1', excluded: [] },
        notes: [],
      },
    };
    const { fetch } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ runId: RUN_ID }, { status: 202 })
        : Response.json(complete),
    );
    const { io, out } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toContain(
      'Sitemaps: 3 read for 2 sources; 2 pages listed, 1 new, 0 back, 0 missing, 0 gone.',
    );
    expect(out).toContain(
      'Not read completely: maker-d: https://maker-d.example/sitemap.xml: failed (HTTP 503).',
    );
  });

  it('names the sources a run paused, and how many pages each left unread', async () => {
    const printed = async (paused: Record<string, number> | undefined) => {
      const complete: RunView = {
        ...RUNNING,
        status: 'complete',
        summary: {
          items: 4,
          live: 6,
          due: 6,
          fetches: { changed: 1, unchanged: 0, gone: 0, failed: 0, blocked: 3 },
          statements: { added: 0, reseen: 0, withdrawn: 0 },
          llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
          entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
          snapshot: {
            published: false,
            reason: 'nothing changed since generation 1',
            excluded: [],
          },
          notes: [],
          ...(paused === undefined ? {} : { paused }),
        },
      };
      const { fetch } = stubApi(({ method }) =>
        method === 'POST'
          ? Response.json({ runId: RUN_ID }, { status: 202 })
          : Response.json(complete),
      );
      const { io, out } = memoryIo();
      expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
      return out;
    };
    const pages =
      'Pages: 4 read, of 6 due and 6 live. Changed 1, unchanged 0, gone 0, failed 0, blocked 3.';
    // A run's notes are held to fifty, and the pause's own can be one of those dropped, so the
    // paused sources are named apart from them.
    const out = await printed({ 'maker-a': 2, 'maker-b': 1, 'maker-c': 0 });
    expect(out.slice(2, 4)).toEqual([
      pages,
      'Paused after blocks in a row: maker-a, 2 pages unread; maker-b, 1 page unread; maker-c, 0 pages unread.',
    ]);
    // Runs from before slice 1, and runs that paused nothing, say nothing of it.
    expect((await printed(undefined)).join('\n')).not.toContain('Paused');
    expect((await printed({})).join('\n')).not.toContain('Paused');
  });

  it('says nothing of sitemaps when no source has any, and counts one page and one source', async () => {
    const printed = async (discovery: DiscoverySummary) => {
      const complete: RunView = {
        ...RUNNING,
        status: 'complete',
        summary: {
          items: 0,
          discovery,
          fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
          statements: { added: 0, reseen: 0, withdrawn: 0 },
          llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
          entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
          snapshot: {
            published: false,
            reason: 'nothing changed since generation 1',
            excluded: [],
          },
          notes: [],
        },
      };
      const { fetch } = stubApi(({ method }) =>
        method === 'POST'
          ? Response.json({ runId: RUN_ID }, { status: 202 })
          : Response.json(complete),
      );
      const { io, out } = memoryIo();
      expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
      return out;
    };
    // Every run reports its discovery, so a dataset of pages has one that read nothing.
    const none = {
      sources: 0,
      sitemaps: 0,
      listed: 0,
      added: 0,
      revived: 0,
      missing: 0,
      gone: 0,
      incomplete: [],
    };
    expect((await printed(none)).filter((line) => line.startsWith('Sitemaps:'))).toEqual([]);
    expect(await printed({ ...none, sources: 1, sitemaps: 1, listed: 1, added: 1 })).toContain(
      'Sitemaps: 1 read for 1 source; 1 page listed, 1 new, 0 back, 0 missing, 0 gone.',
    );
  });

  it('says what the run decided', async () => {
    const complete: RunView = {
      ...RUNNING,
      status: 'complete',
      finishedAt: '2026-10-10T00:01:00.000Z',
      summary: {
        items: 12,
        fetches: { changed: 12, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
        statements: { added: 60, reseen: 0, withdrawn: 0 },
        llm: { ran: 12, reused: 0, skipped: 0, failed: 0, inputTokens: 12000, outputTokens: 600 },
        classify: {
          rule: 1,
          accepted: 9,
          escalated: 2,
          reused: 0,
          skipped: 0,
          failed: 0,
          inputTokens: 5000,
          outputTokens: 200,
        },
        irrelevant: 1,
        entities: { created: 9, linked: 0, conflicts: 0, unresolved: 0 },
        snapshot: { published: true, generation: 3, snapshotId: 'sn_x', records: 9, excluded: [] },
        notes: [],
      },
    };
    const { fetch } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ runId: RUN_ID }, { status: 202 })
        : Response.json(complete),
    );
    const { io, out } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toContain(
      'Classified: 1 by rule, 9 by the decider, 2 for review, 0 as before, 0 for the next run, 0 failed; 5000 tokens in, 200 out.',
    );
    expect(out).toContain('Not the dataset’s: 1 page, out until revived.');
    expect(out.some((line) => line.startsWith('Matched:'))).toBe(false);
  });

  it('says each kind of decision that was asked, in order, and nothing of one that wasn’t', async () => {
    const none = {
      rule: 0,
      accepted: 0,
      escalated: 0,
      reused: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const printed = async (more: Partial<RunSummary>) => {
      const complete: RunView = {
        ...RUNNING,
        status: 'complete',
        summary: {
          items: 0,
          fetches: { changed: 0, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
          statements: { added: 0, reseen: 0, withdrawn: 0 },
          llm: { ran: 0, reused: 0, skipped: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
          entities: { created: 0, linked: 0, conflicts: 0, unresolved: 0 },
          snapshot: {
            published: false,
            reason: 'nothing changed since generation 1',
            excluded: [],
          },
          notes: [],
          ...more,
        },
      };
      const { fetch } = stubApi(({ method }) =>
        method === 'POST'
          ? Response.json({ runId: RUN_ID }, { status: 202 })
          : Response.json(complete),
      );
      const { io, out } = memoryIo();
      expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
      return out;
    };

    // A run that asked nothing says nothing, whether its counts are zero or absent.
    const quiet = await printed({ classify: none, match: none, irrelevant: 0 });
    expect(quiet.filter((line) => /^(Classified|Matched|Not the dataset)/u.test(line))).toEqual([]);

    const busy = await printed({
      match: { ...none, accepted: 3, skipped: 1, inputTokens: 1500, outputTokens: 60 },
      irrelevant: 2,
    });
    expect(busy).toContain(
      'Matched: 0 by rule, 3 by the decider, 0 for review, 0 as before, 1 for the next run, 0 failed; 1500 tokens in, 60 out.',
    );
    expect(busy).toContain('Not the dataset’s: 2 pages, out until revived.');
    expect(busy.some((line) => line.startsWith('Classified:'))).toBe(false);
    const at = (prefix: string) => busy.findIndex((line) => line.startsWith(prefix));
    expect(at('LLM:')).toBeLessThan(at('Matched:'));
    expect(at('Matched:')).toBeLessThan(at('Not the dataset’s:'));
    expect(at('Not the dataset’s:')).toBeLessThan(at('Entities:'));
  });

  it('says how many pages wait for a match answer', async () => {
    const complete: RunView = {
      ...RUNNING,
      status: 'complete',
      finishedAt: '2026-10-10T00:01:00.000Z',
      summary: {
        items: 10,
        fetches: { changed: 10, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
        statements: { added: 50, reseen: 0, withdrawn: 0 },
        llm: { ran: 10, reused: 0, skipped: 0, failed: 0, inputTokens: 10000, outputTokens: 500 },
        match: {
          rule: 0,
          accepted: 3,
          escalated: 2,
          reused: 0,
          skipped: 0,
          failed: 0,
          inputTokens: 2500,
          outputTokens: 100,
        },
        entities: { created: 9, linked: 1, conflicts: 0, unresolved: 0, waiting: 2 },
        snapshot: { published: true, generation: 4, snapshotId: 'sn_y', records: 9, excluded: [] },
        notes: [],
      },
    };
    const { fetch } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ runId: RUN_ID }, { status: 202 })
        : Response.json(complete),
    );
    const { io, out } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toContain(
      'Entities: 9 new, 1 linked, 0 conflicts, 0 without an identity yet, 2 waiting for a match answer.',
    );
    expect(out).toContain(
      'Matched: 0 by rule, 3 by the decider, 2 for review, 0 as before, 0 for the next run, 0 failed; 2500 tokens in, 100 out.',
    );
  });

  it('says nothing of waiting when no page waits', async () => {
    const complete: RunView = {
      ...RUNNING,
      status: 'complete',
      finishedAt: '2026-10-10T00:01:00.000Z',
      summary: {
        items: 3,
        fetches: { changed: 3, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
        statements: { added: 15, reseen: 0, withdrawn: 0 },
        llm: { ran: 3, reused: 0, skipped: 0, failed: 0, inputTokens: 3000, outputTokens: 150 },
        entities: { created: 3, linked: 0, conflicts: 0, unresolved: 0, waiting: 0 },
        snapshot: { published: true, generation: 1, snapshotId: 'sn_z', records: 3, excluded: [] },
        notes: [],
      },
    };
    const { fetch } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ runId: RUN_ID }, { status: 202 })
        : Response.json(complete),
    );
    const { io, out } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toContain('Entities: 3 new, 0 linked, 0 conflicts, 0 without an identity yet.');
  });

  it('says when the run’s snapshot is held for review', async () => {
    const complete: RunView = {
      ...RUNNING,
      status: 'complete',
      finishedAt: '2026-10-10T00:01:00.000Z',
      summary: {
        items: 3,
        fetches: { changed: 3, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
        statements: { added: 19, reseen: 0, withdrawn: 0 },
        llm: { ran: 3, reused: 0, skipped: 0, failed: 0, inputTokens: 3000, outputTokens: 150 },
        entities: { created: 3, linked: 0, conflicts: 0, unresolved: 0 },
        snapshot: {
          published: false,
          reason: 'it’s held for review: it’s the dataset’s first publication',
          excluded: [],
          held: {
            snapshotId: 'sn_held',
            records: 3,
            reasons: ['it’s the dataset’s first publication'],
          },
        },
        notes: [],
      },
    };
    const { fetch } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ runId: RUN_ID }, { status: 202 })
        : Response.json(complete),
    );
    const { io, out } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toContain(
      'Snapshot: none published, because it’s held for review: it’s the dataset’s first publication.',
    );
    expect(out).toContain('Held: sn_held, 3 records. Publish or discard it with spatula review.');
  });

  it('says what is held before what was left out, and nothing of it when a snapshot published', async () => {
    const summary = (snapshot: RunSummary['snapshot']): RunView => ({
      ...RUNNING,
      status: 'complete',
      finishedAt: '2026-10-10T00:01:00.000Z',
      summary: {
        items: 3,
        fetches: { changed: 3, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
        statements: { added: 19, reseen: 0, withdrawn: 0 },
        llm: { ran: 3, reused: 0, skipped: 0, failed: 0, inputTokens: 3000, outputTokens: 150 },
        entities: { created: 3, linked: 0, conflicts: 0, unresolved: 0 },
        snapshot,
        notes: [],
      },
    });
    const run = async (snapshot: RunSummary['snapshot']) => {
      const { fetch } = stubApi(({ method }) =>
        method === 'POST'
          ? Response.json({ runId: RUN_ID }, { status: 202 })
          : Response.json(summary(snapshot)),
      );
      const { io, out } = memoryIo();
      expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
      return out;
    };

    const held = await run({
      published: false,
      reason: 'it’s held for review: the dataset’s approval is manual',
      excluded: [{ canonicalId: 'sp_x', missing: ['category'] }],
      held: { snapshotId: 'sn_held', records: 2, reasons: ['the dataset’s approval is manual'] },
    });
    expect(held.filter((line) => /^(Snapshot|Held|Left out):/u.test(line))).toEqual([
      'Snapshot: none published, because it’s held for review: the dataset’s approval is manual.',
      'Held: sn_held, 2 records. Publish or discard it with spatula review.',
      'Left out: sp_x, missing category.',
    ]);

    const publishedOne = await run({
      published: true,
      generation: 2,
      snapshotId: 'sn_new',
      records: 3,
      excluded: [],
    });
    expect(publishedOne.some((line) => line.startsWith('Held:'))).toBe(false);
  });
});

describe('revive', () => {
  it('puts refused pages, or the pages named, back for the next run', async () => {
    const { fetch, sent } = stubApi(() => Response.json({ revived: 2 }));
    const { io, out } = memoryIo();
    const argv = ['revive', 'cli-products', '--refused', 'https://maker-a.example/products/a1'];
    expect(await main(argv, { io, env: ENV, fetch })).toBe(0);
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/datasets/cli-products/items/revive',
      body: { refused: true, pages: ['https://maker-a.example/products/a1'] },
    });
    expect(out).toEqual(['Revived 2 pages of cli-products. The next run reads them.']);
  });

  it('says when nothing matched, not that the next run reads it', async () => {
    const { fetch } = stubApi(() => Response.json({ revived: 0 }));
    const { io, out, err } = memoryIo();
    expect(await main(['revive', 'cli-products', '--refused'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual(['Nothing matched in cli-products, so no page was revived.']);
    expect(err).toEqual([]);
  });

  it('reports a dataset Spatula doesn’t have', async () => {
    const { fetch } = stubApi(() =>
      Response.json({ error: 'Dataset nothing doesn’t exist.' }, { status: 404 }),
    );
    const { io, out, err } = memoryIo();
    expect(await main(['revive', 'nothing', '--refused'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual(['Dataset nothing doesn’t exist.']);
    expect(out).toEqual([]);
  });

  it('needs pages to revive, or --refused', async () => {
    const { io } = memoryIo();
    expect(await main(['revive', 'cli-products'], { io, env: ENV })).toBe(2);
  });
});

describe('review', () => {
  const PUBLISH_CONTEXT = {
    snapshotId: 'sn_held',
    records: 412,
    added: 412,
    removed: 0,
    reasons: ['it’s the dataset’s first publication'],
    previousGeneration: null,
  };
  const REVIEWS: ReviewView[] = [
    {
      id: 'rv_classify',
      kind: 'classify',
      subject: 'it_a1',
      question: {
        type: 'choice',
        prompt: 'Which category does the one product this page is about have?',
        options: ['Headphones', 'DAC/Amp', 'None of these'],
      },
      context: {
        url: 'https://maker-a.example/products/a1',
        field: 'category',
        proposed: 'Headphones',
        probabilities: { Headphones: 0.62, 'DAC/Amp': 0.3 },
        reason: 'It sits over the ears.',
      },
      createdAt: '2026-10-10T00:00:00.000Z',
    },
    {
      id: 'rv_publish',
      kind: 'publication',
      subject: 'sn_held',
      question: {
        type: 'choice',
        prompt: 'Publish this held snapshot?',
        options: ['publish', 'discard'],
      },
      context: { ...PUBLISH_CONTEXT, incomplete: 3, openClassify: 2, openMatch: 1 },
      createdAt: '2026-10-10T00:01:00.000Z',
    },
  ];

  /** What `spatula review cli-products` prints for these questions. */
  async function listed(reviews: ReviewView[]) {
    const { fetch } = stubApi(() => Response.json({ reviews }));
    const { io, out, err } = memoryIo();
    expect(await main(['review', 'cli-products'], { io, env: ENV, fetch })).toBe(0);
    expect(err).toEqual([]);
    return out;
  }

  /** The held snapshot's question, with these in its context. */
  const publication = (context: Record<string, unknown>): ReviewView => ({
    ...REVIEWS[1]!,
    context: { ...PUBLISH_CONTEXT, ...context },
  });

  it('lists the open questions, with what each proposes and how to answer', async () => {
    const { fetch, sent } = stubApi(() => Response.json({ reviews: REVIEWS }));
    const { io, out } = memoryIo();
    expect(await main(['review', 'cli-products'], { io, env: ENV, fetch })).toBe(0);
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/datasets/cli-products/review' });
    expect(out).toEqual([
      '2 questions wait for an answer.',
      '',
      'rv_classify  classify  https://maker-a.example/products/a1',
      '  Which category does the one product this page is about have?',
      '  Proposed: Headphones (0.62). It sits over the ears.',
      '  Answers: Headphones | DAC/Amp | None of these',
      '',
      'rv_publish  publication  sn_held',
      '  Publish this held snapshot? 412 records: 412 new, 0 removed.',
      '  Held because it’s the dataset’s first publication.',
      '  Left out as incomplete: 3. Open questions: 2 classify, 1 match.',
      '  Answers: publish | discard',
      '',
      'Answer with: spatula review cli-products <id> "<answer>"',
    ]);
  });

  // A match question as a run asks it now: it names the record by its ID, which is how a refusal
  // names it, and by the address of the page that stands for the record.
  const MATCH_CONTEXT = {
    page: 'https://maker-a.example/products/a3',
    entity: 'https://maker-a.example/products/a1',
    proposed: 'same',
    probabilities: { same: 0.5, variant: 0.45 },
    reason: 'The names agree.',
  };
  const MATCH: ReviewView = {
    id: 'rv_match',
    kind: 'match',
    subject: 'it_a3|sp_one',
    question: {
      type: 'choice',
      prompt: 'Is this page the same product as the record?',
      options: ['same', 'variant', 'different'],
    },
    context: { ...MATCH_CONTEXT, record: 'sp_one' },
    createdAt: '2026-10-10T00:00:00.000Z',
  };

  it('shows a match question’s page and record, and a question that waits alone in the singular', async () => {
    const out = await listed([MATCH]);
    expect(out).toEqual([
      '1 question waits for an answer.',
      '',
      'rv_match  match  https://maker-a.example/products/a3 and sp_one (https://maker-a.example/products/a1)',
      '  Is this page the same product as the record?',
      '  Proposed: same (0.50). The names agree.',
      '  Answers: same | variant | different',
      '',
      'Answer with: spatula review cli-products <id> "<answer>"',
    ]);
  });

  it('names the two pages alone for a match question asked before it named the record', async () => {
    const out = await listed([{ ...MATCH, context: MATCH_CONTEXT }]);
    expect(out[2]).toBe(
      'rv_match  match  https://maker-a.example/products/a3 and https://maker-a.example/products/a1',
    );
    // An empty record, or one that isn't text, is no record.
    for (const record of ['', null, 7]) {
      const listing = await listed([{ ...MATCH, context: { ...MATCH_CONTEXT, record } }]);
      expect(listing[2], JSON.stringify(record)).toBe(out[2]);
    }
  });

  it('shows what the decider proposed as far as it said, and why where it proposed nothing', async () => {
    const shown = (context: Record<string, unknown>) =>
      listed([{ ...REVIEWS[0]!, context: { url: 'https://maker-a.example/a1', ...context } }]);
    const proposals = async (context: Record<string, unknown>) =>
      (await shown(context)).filter((line) => line.startsWith('  Proposed'));
    expect(
      await proposals({ proposed: 'Headphones', probabilities: { Headphones: 0.62 } }),
    ).toEqual(['  Proposed: Headphones (0.62).']);
    expect(await proposals({ proposed: 'Headphones', reason: 'It sits over the ears.' })).toEqual([
      '  Proposed: Headphones. It sits over the ears.',
    ]);
    expect(
      await proposals({
        proposed: null,
        probabilities: {},
        reason: 'The decider named no answer.',
      }),
    ).toEqual([]);

    // Where nothing was proposed, the reason is still the one thing the decider said.
    expect(
      await shown({ proposed: null, probabilities: {}, reason: 'The decider named no answer.' }),
    ).toEqual([
      '1 question waits for an answer.',
      '',
      'rv_classify  classify  https://maker-a.example/a1',
      '  Which category does the one product this page is about have?',
      '  Nothing proposed. The decider named no answer.',
      '  Answers: Headphones | DAC/Amp | None of these',
      '',
      'Answer with: spatula review cli-products <id> "<answer>"',
    ]);
    // With no reason either, there is nothing to say.
    for (const context of [{ proposed: null, probabilities: {} }, { reason: '' }, {}]) {
      const lines = await shown(context);
      expect(
        lines.filter((line) => /^ {2}(Proposed|Nothing proposed)/u.test(line)),
        JSON.stringify(context),
      ).toEqual([]);
      expect(lines, JSON.stringify(context)).toHaveLength(7);
    }
  });

  it('counts a held snapshot’s records, and how many of them are new and how many went', async () => {
    const out = await listed([publication({ records: 10, added: 4, removed: 2 })]);
    expect(out).toContain('  Publish this held snapshot? 10 records: 4 new, 2 removed.');
  });

  it('says why records left a held snapshot only for the numbers that are above zero', async () => {
    const heldLines = async (context: Record<string, unknown>) =>
      (await listed([publication(context)])).filter(
        (line) => line.includes('Left out as incomplete') || line.includes('Open questions'),
      );
    expect(await heldLines({ incomplete: 3, openClassify: 2, openMatch: 1 })).toEqual([
      '  Left out as incomplete: 3. Open questions: 2 classify, 1 match.',
    ]);
    expect(await heldLines({ incomplete: 3, openClassify: 0, openMatch: 0 })).toEqual([
      '  Left out as incomplete: 3.',
    ]);
    expect(await heldLines({ incomplete: 0, openClassify: 0, openMatch: 2 })).toEqual([
      '  Open questions: 0 classify, 2 match.',
    ]);
    // Nothing left out and nothing open, or a question from before the counts: no such line.
    expect(await heldLines({ incomplete: 0, openClassify: 0, openMatch: 0 })).toEqual([]);
    expect(await heldLines({})).toEqual([]);
  });

  it('sends an answer, and prints what it did', async () => {
    const { fetch, sent } = stubApi(() =>
      Response.json({
        answered: 'rv_classify',
        answer: 'DAC/Amp',
        effect: 'The page’s category is DAC/Amp. The next run publishes it.',
      }),
    );
    const { io, out } = memoryIo();
    expect(
      await main(['review', 'cli-products', 'rv_classify', 'DAC/Amp'], { io, env: ENV, fetch }),
    ).toBe(0);
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/datasets/cli-products/review/rv_classify',
      body: { answer: 'DAC/Amp' },
      authorization: 'Bearer owner-token',
    });
    expect(out).toEqual([
      'Answered rv_classify: DAC/Amp. The page’s category is DAC/Amp. The next run publishes it.',
    ]);
  });

  it('answers without a trailing space when the API says nothing of the effect', async () => {
    const { fetch } = stubApi(() => Response.json({ answered: 'rv_publish', answer: 'publish' }));
    const { io, out } = memoryIo();
    expect(
      await main(['review', 'cli-products', 'rv_publish', 'publish'], { io, env: ENV, fetch }),
    ).toBe(0);
    expect(out).toEqual(['Answered rv_publish: publish.']);
  });

  it('keeps a dataset’s name and a question’s ID to their place in the address', async () => {
    const { fetch, sent } = stubApi(() => Response.json({ reviews: [] }));
    const { io } = memoryIo();
    await main(['review', 'a b/c'], { io, env: ENV, fetch });
    await main(['review', 'a b/c', 'rv ?x', 'None of these'], { io, env: ENV, fetch });
    expect(sent.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/datasets/a%20b%2Fc/review' },
      { method: 'POST', path: '/datasets/a%20b%2Fc/review/rv%20%3Fx' },
    ]);
    expect(sent[1]!.body).toEqual({ answer: 'None of these' });
  });

  it('says when nothing waits, and needs both an ID and an answer to answer', async () => {
    const { fetch, sent } = stubApi(() => Response.json({ reviews: [] }));
    const { io, out } = memoryIo();
    expect(await main(['review', 'cli-products'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual(['No questions wait for an answer.']);
    const { io: called, err } = memoryIo();
    const calls = sent.length;
    // An ID with no answer, no dataset, and more than an answer are mistakes in the call.
    for (const argv of [
      ['review', 'cli-products', 'rv_classify'],
      ['review'],
      ['review', 'cli-products', 'rv_classify', 'DAC/Amp', 'extra'],
    ]) {
      expect(await main(argv, { io: called, env: ENV, fetch }), argv.join(' ')).toBe(2);
    }
    expect(err.slice(0, USAGE.split('\n').length)).toEqual(USAGE.split('\n'));
    expect(sent).toHaveLength(calls);
  });

  it('shows why the API refused an answer, and exits 1', async () => {
    const reason =
      'A person already said this page is the same product as sp_one, and a page joins one record. Answer variant or different.';
    const { fetch } = stubApi(() => Response.json({ error: reason }, { status: 409 }));
    const { io, out, err } = memoryIo();
    expect(await main(['review', 'cli-products', 'rv_m', 'same'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual([reason]);
    expect(out).toEqual([]);
  });

  it('shows why the API refused to list the questions, and exits 1', async () => {
    const { fetch } = stubApi(() =>
      Response.json({ error: 'The owner token is missing or wrong.' }, { status: 401 }),
    );
    const { io, out, err } = memoryIo();
    expect(await main(['review', 'cli-products'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual(['The owner token is missing or wrong.']);
    expect(out).toEqual([]);
  });

  it('reports a dataset Spatula doesn’t have, as revive does, and sends only the listing', async () => {
    const { fetch, sent } = stubApi(() =>
      Response.json({ error: 'Dataset nothing doesn’t exist.' }, { status: 404 }),
    );
    const { io, out, err } = memoryIo();
    expect(await main(['review', 'nothing'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual(['Dataset nothing doesn’t exist.']);
    expect(out).toEqual([]);
    expect(sent.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/datasets/nothing/review' },
    ]);
  });
});

describe('status', () => {
  const STATUS: DatasetStatus = {
    dataset: 'cli-products',
    revision: 3,
    headGeneration: 4,
    held: {
      snapshotId: 'sn_held',
      records: 412,
      reason: 'the definition changed since the last publication (revision 2 to 3)',
      createdAt: '2026-10-12T10:00:00.000Z',
    },
    reviews: { classify: 3, match: 2, publication: 1 },
    consumers: [
      {
        name: 'crowdio',
        generation: 4,
        outcome: 'applied',
        receivedAt: '2026-10-12T09:00:00.000Z',
      },
      { name: 'other', generation: null, outcome: null, receivedAt: null },
    ],
  };

  it('says where a dataset stands', async () => {
    const { fetch, sent } = stubApi(() => Response.json(STATUS));
    const { io, out } = memoryIo();
    expect(await main(['status', 'cli-products'], { io, env: ENV, fetch })).toBe(0);
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/datasets/cli-products/status' });
    expect(out).toEqual([
      'cli-products, revision 3: generation 4 is published.',
      'Held: sn_held, 412 records, because the definition changed since the last publication (revision 2 to 3).',
      'Waiting for review: 3 classify, 2 match, 1 publication.',
      'crowdio: applied generation 4 at 2026-10-12T09:00:00.000Z.',
      'other: has acknowledged nothing yet.',
    ]);
  });

  it('says what is missing: nothing published, nothing held, nothing waiting, nobody listed', async () => {
    const fresh: DatasetStatus = {
      dataset: 'cli-new',
      revision: 1,
      headGeneration: 0,
      held: null,
      reviews: { classify: 0, match: 0, publication: 0 },
      consumers: [],
    };
    const { fetch } = stubApi(() => Response.json(fresh));
    const { io, out, err } = memoryIo();
    expect(await main(['status', 'cli-new'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual([
      'cli-new, revision 1: nothing is published yet.',
      'Nothing waits for review.',
    ]);
    expect(err).toEqual([]);
  });

  it('names a refusal as it names an application, and a hold that gave no reason', async () => {
    const status: DatasetStatus = {
      ...STATUS,
      held: {
        snapshotId: 'sn_held',
        records: 2,
        reason: null,
        createdAt: '2026-10-12T10:00:00.000Z',
      },
      reviews: { classify: 0, match: 0, publication: 1 },
      consumers: [
        {
          name: 'crowdio',
          generation: 2,
          outcome: 'refused',
          receivedAt: '2026-10-12T09:00:00.000Z',
        },
      ],
    };
    const { fetch } = stubApi(() => Response.json(status));
    const { io, out } = memoryIo();
    expect(await main(['status', 'cli-products'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual([
      'cli-products, revision 3: generation 4 is published.',
      'Held: sn_held, 2 records.',
      'Waiting for review: 0 classify, 0 match, 1 publication.',
      'crowdio: refused generation 2 at 2026-10-12T09:00:00.000Z.',
    ]);
  });

  it('keeps a dataset’s name to its place in the address', async () => {
    const { fetch, sent } = stubApi(() => Response.json(STATUS));
    const { io } = memoryIo();
    await main(['status', 'a b/c'], { io, env: ENV, fetch });
    expect(sent.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/datasets/a%20b%2Fc/status' },
    ]);
  });

  it('shows why the API refused, and exits 1', async () => {
    const stale =
      'Dataset cli-products’s stored definition no longer passes the checks (consumers.0: Use lowercase letters, digits, and hyphens, up to 63 characters.). Apply it again.';
    for (const [status, error] of [
      [404, 'Dataset nothing doesn’t exist.'],
      [401, 'The owner token is missing or wrong.'],
      [409, stale],
    ] as const) {
      const { fetch } = stubApi(() => Response.json({ error }, { status }));
      const { io, out, err } = memoryIo();
      expect(await main(['status', 'cli-products'], { io, env: ENV, fetch }), `${status}`).toBe(1);
      expect(err).toEqual([error]);
      expect(out).toEqual([]);
    }
  });

  it('needs exactly one dataset', async () => {
    const { fetch, sent } = stubApi(() => Response.json(STATUS));
    const { io, out, err } = memoryIo();
    for (const argv of [['status'], ['status', 'cli-products', 'extra']]) {
      expect(await main(argv, { io, env: ENV, fetch }), argv.join(' ')).toBe(2);
    }
    expect(err.slice(0, USAGE.split('\n').length)).toEqual(USAGE.split('\n'));
    expect(out).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('is in the usage, with the apostrophe every other message uses', () => {
    expect(USAGE).toContain('status <dataset>');
    expect(USAGE).toContain('what’s held');
    expect(USAGE).not.toContain("what's held");
  });
});

describe('snapshot pull', () => {
  const body = JSON.stringify({
    project: 'cli-products',
    snapshotId: 'sn_x',
    generation: 2,
    publishedAt: '2026-10-10T00:00:00.000Z',
    records: [],
  });

  it('writes a snapshot only after checking its hash and format', async () => {
    const sha256 = await sha256Hex(body);
    const headers = {
      'content-type': 'application/json',
      'x-spatula-sha256': sha256,
      'x-spatula-generation': '2',
      'x-spatula-snapshot-id': 'sn_x',
    };
    const good = stubApi(() => new Response(body, { headers }));
    const first = memoryIo();
    const args = [
      'snapshot',
      'pull',
      'cli-products',
      '--generation',
      '2',
      '--out',
      'snapshot.json',
    ];
    expect(await main(args, { io: first.io, env: ENV, fetch: good.fetch })).toBe(0);
    expect(good.sent[0]!.path).toBe('/datasets/cli-products/snapshots/2');
    expect(first.written.get('snapshot.json')).toBe(body);
    expect(first.out).toEqual([
      'Wrote generation 2 of cli-products (0 records) to snapshot.json.',
      `SHA-256: ${sha256}`,
    ]);

    const tampered = stubApi(
      () => new Response(body.replace('"generation":2', '"generation":3'), { headers }),
    );
    const second = memoryIo();
    expect(
      await main(['snapshot', 'pull', 'cli-products', '--out', 'snapshot.json'], {
        io: second.io,
        env: ENV,
        fetch: tampered.fetch,
      }),
    ).toBe(1);
    expect(tampered.sent[0]!.path).toBe('/datasets/cli-products/snapshots/latest');
    expect(second.written.size).toBe(0);
    expect(second.err[0]).toMatch(
      /^The snapshot’s SHA-256 is [0-9a-f]{64}, but Spatula said [0-9a-f]{64}\. Nothing was written\.$/u,
    );
  });

  it.each([
    {
      label: 'generation',
      headers: { 'x-spatula-generation': '2', 'x-spatula-snapshot-id': 'sn_x' },
      said: 'generation 2 (sn_x)',
    },
    {
      label: 'ID',
      headers: { 'x-spatula-generation': '1', 'x-spatula-snapshot-id': 'sn_y' },
      said: 'generation 1 (sn_y)',
    },
  ])('writes nothing when the headers and the body differ on its $label', async (mixedUp) => {
    // The body is generation 1 of sn_x and its hash is right. Only the labels are wrong, as a mix-up
    // between two responses would leave them, and consumers trust the file's own generation.
    const first = JSON.stringify({ ...JSON.parse(body), generation: 1 });
    const headers = {
      'content-type': 'application/json',
      'x-spatula-sha256': await sha256Hex(first),
      ...mixedUp.headers,
    };
    const api = stubApi(() => new Response(first, { headers }));
    const { io, err, written } = memoryIo();
    expect(
      await main(['snapshot', 'pull', 'cli-products', '--out', 'snapshot.json'], {
        io,
        env: ENV,
        fetch: api.fetch,
      }),
    ).toBe(1);
    expect(err).toEqual([
      `The snapshot says generation 1 (sn_x), but Spatula said ${mixedUp.said}. Nothing was written.`,
    ]);
    expect(written.size).toBe(0);
  });

  it('writes nothing when the snapshot is for another dataset', async () => {
    // The hash is right and the headers agree with the body. Only the dataset is wrong.
    const other = JSON.stringify({ ...JSON.parse(body), project: 'other-products' });
    const headers = {
      'content-type': 'application/json',
      'x-spatula-sha256': await sha256Hex(other),
      'x-spatula-generation': '2',
      'x-spatula-snapshot-id': 'sn_x',
    };
    const api = stubApi(() => new Response(other, { headers }));
    const { io, out, err, written } = memoryIo();
    expect(
      await main(['snapshot', 'pull', 'cli-products', '--out', 'snapshot.json'], {
        io,
        env: ENV,
        fetch: api.fetch,
      }),
    ).toBe(1);
    expect(err).toEqual([
      'The snapshot is for other-products, but you asked for cli-products. Nothing was written.',
    ]);
    expect(out).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('writes nothing when Spatula sends another generation than the one asked for', async () => {
    // Generation 3, whole: its hash, its headers, and its body agree. Only the generation is wrong.
    const third = JSON.stringify({ ...JSON.parse(body), generation: 3 });
    const headers = {
      'content-type': 'application/json',
      'x-spatula-sha256': await sha256Hex(third),
      'x-spatula-generation': '3',
      'x-spatula-snapshot-id': 'sn_x',
    };
    const api = stubApi(() => new Response(third, { headers }));
    const asked = memoryIo();
    const args = ['snapshot', 'pull', 'cli-products', '--out', 'snapshot.json'];
    expect(
      await main([...args, '--generation', '2'], { io: asked.io, env: ENV, fetch: api.fetch }),
    ).toBe(1);
    expect(api.sent[0]!.path).toBe('/datasets/cli-products/snapshots/2');
    expect(asked.err).toEqual([
      'You asked for generation 2, but Spatula sent generation 3. Nothing was written.',
    ]);
    expect(asked.out).toEqual([]);
    expect(asked.written.size).toBe(0);

    // The latest is whichever generation Spatula has, so the same answer is written.
    const latest = memoryIo();
    expect(await main(args, { io: latest.io, env: ENV, fetch: api.fetch })).toBe(0);
    expect(latest.written.get('snapshot.json')).toBe(third);
  });

  it('says so in one line when the file can’t be written', async () => {
    const headers = {
      'content-type': 'application/json',
      'x-spatula-sha256': await sha256Hex(body),
      'x-spatula-generation': '2',
      'x-spatula-snapshot-id': 'sn_x',
    };
    const api = stubApi(() => new Response(body, { headers }));
    const { io, out, err } = memoryIo();
    io.writeFile = async () => {
      throw new Error("EACCES: permission denied, open '/locked/.snapshot.json.tmp'");
    };
    expect(
      await main(['snapshot', 'pull', 'cli-products', '--out', 'snapshot.json'], {
        io,
        env: ENV,
        fetch: api.fetch,
      }),
    ).toBe(1);
    expect(err).toEqual([
      "Couldn’t write snapshot.json: EACCES: permission denied, open '/locked/.snapshot.json.tmp'",
    ]);
    expect(out).toEqual([]);
  });
});

describe('eval', () => {
  const A2 = 'https://maker-a.example/products/a2';
  const GOLDEN = {
    dataset: 'cli-products',
    version: 2,
    checked: '2026-10-14',
    identifiers: ['gtins', 'mpns'],
    specs: 'specs',
    products: [
      {
        key: 'maker-a-a2',
        pages: [A2],
        fields: { brand: 'Maker A', name: 'A2', gtins: ['04006381333931'] },
        checkedAgainst: ['https://retailer.example/a2'],
      },
    ],
  };
  const snapshotOf = (records: { canonicalId: string; fields: Record<string, unknown> }[]) =>
    JSON.stringify({
      project: 'cli-products',
      snapshotId: 'sn_x',
      generation: 3,
      publishedAt: '2026-10-14T00:00:00.000Z',
      records: records.map((record) => ({ ...record, provenance: {} })),
    });
  const SNAPSHOT = snapshotOf([
    {
      canonicalId: 'sp_a2',
      fields: { brand: 'Maker A', name: 'A2', gtins: ['04006381333931'] },
    },
  ]);
  const item = (locator: string, entityId: string | null): ItemView => ({
    locator,
    sourceId: 'maker-a',
    status: 'live',
    entityId,
  });

  /**
   * Spatula's answers, with the snapshot's real hash, which the command checks, unless a test
   * says another. A score is kept (201), and the history is empty.
   */
  async function serve(
    options: { snapshot?: string; items?: ItemView[]; headers?: Record<string, string> } = {},
  ) {
    const snapshot = options.snapshot ?? SNAPSHOT;
    const headers = {
      'x-spatula-sha256': await sha256Hex(snapshot),
      'x-spatula-generation': '3',
      'x-spatula-snapshot-id': 'sn_x',
      ...options.headers,
    };
    return stubApi(({ method, path }) => {
      if (path.endsWith('/items'))
        return Response.json({ items: options.items ?? [item(A2, 'sp_a2')] });
      if (path.includes('/snapshots/')) return new Response(snapshot, { headers });
      if (method === 'POST') return Response.json({ id: 'ev_1' }, { status: 201 });
      return Response.json({ evals: [] });
    });
  }

  it('scores the latest snapshot against a golden set, and keeps the score with --save', async () => {
    const { fetch, sent } = await serve();
    const { io, out } = memoryIo({ 'golden.json': JSON.stringify(GOLDEN) });
    expect(await main(['eval', 'golden.json', '--save'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual([
      'cli-products, generation 3, against golden set version 2 (1 product):',
      'Precision: 100.0% (target 99%): met.',
      'Recall: 100.0%, 1 of 1 found (target 90%): met.',
      'Identifiers: 100.0% of 1 stated (target 98%): met.',
      'Key specs: none checked.',
      'Fields: brand 100.0% of 1, gtins 100.0% of 1, name 100.0% of 1.',
      'Saved the score.',
    ]);
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      path: '/datasets/cli-products/evals',
      body: { generation: 3, goldenVersion: 2, scores: { precision: 1, recall: 1, found: 1 } },
    });
  });

  it('keeps the score only when asked to', async () => {
    const { fetch, sent } = await serve();
    const { io, out } = memoryIo({ 'golden.json': JSON.stringify(GOLDEN) });
    expect(await main(['eval', 'golden.json'], { io, env: ENV, fetch })).toBe(0);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /datasets/cli-products/snapshots/latest',
      'GET /datasets/cli-products/items',
    ]);
    expect(out).not.toContain('Saved the score.');
  });

  it('lists what missed, what the records left out, and what spread over several records', async () => {
    const golden = {
      ...GOLDEN,
      products: [
        {
          ...GOLDEN.products[0]!,
          fields: {
            ...GOLDEN.products[0]!.fields,
            mpns: ['A-2'],
            specs: [{ label: 'Impedance', value: '32 Ω' }],
          },
        },
        {
          key: 'maker-a-a1',
          pages: ['https://maker-a.example/products/a1', 'https://maker-a.example/products/a1-new'],
          fields: { name: 'A1' },
          checkedAgainst: ['https://retailer.example/a1'],
        },
      ],
    };
    const snapshot = snapshotOf([
      {
        canonicalId: 'sp_a2',
        fields: { brand: 'Maker A', name: 'A2 Pro', gtins: ['04006381333931'] },
      },
      { canonicalId: 'sp_a1', fields: { name: 'A1' } },
      { canonicalId: 'sp_a1_new', fields: { name: 'A1 New' } },
    ]);
    const { fetch } = await serve({
      snapshot,
      items: [
        item(A2, 'sp_a2'),
        item('https://maker-a.example/products/a1', 'sp_a1'),
        item('https://maker-a.example/products/a1-new', 'sp_a1_new'),
      ],
    });
    const { io, out } = memoryIo({ 'golden.json': JSON.stringify(golden) });
    expect(await main(['eval', 'golden.json'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual([
      'cli-products, generation 3, against golden set version 2 (2 products):',
      'Precision: 100.0% (target 99%): met.',
      'Recall: 100.0%, 2 of 2 found (target 90%): met.',
      'Identifiers: 100.0% of 1 stated, 1 left out (target 98%): met.',
      'Key specs: none checked, 1 left out: not met.',
      'Fields: brand 100.0% of 1, gtins 100.0% of 1, mpns none checked (1 left out), name 50.0% of 2.',
      'Spread over several records: 1.',
      'Misses:',
      '  maker-a-a2: name is A2 Pro, not A2',
      '  maker-a-a2: mpns is missing, not A-2',
      '  maker-a-a2: specs Impedance is missing, not 32 Ω',
      '  maker-a-a1: spread over 2 records',
    ]);
  });

  it('scores nothing when the snapshot’s hash isn’t the one Spatula sent', async () => {
    const { fetch, sent } = await serve({ headers: { 'x-spatula-sha256': '0'.repeat(64) } });
    const { io, out, err } = memoryIo({ 'golden.json': JSON.stringify(GOLDEN) });
    expect(await main(['eval', 'golden.json', '--save'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual([
      `The snapshot’s SHA-256 doesn’t match what Spatula said (${'0'.repeat(64)}). Nothing was scored.`,
    ]);
    expect(out).toEqual([]);
    expect(sent.map((request) => request.method)).toEqual(['GET']);
  });

  it.each<{ label: string; snapshot: string; headers: Record<string, string>; said: string }>([
    {
      label: 'is not JSON',
      snapshot: 'not json',
      headers: {},
      said: 'The snapshot isn’t JSON. Nothing was scored.',
    },
    {
      label: 'is not in the published format',
      snapshot: JSON.stringify({ project: 'cli-products' }),
      headers: {},
      said: 'The snapshot isn’t cli-products’s, in the published format. Nothing was scored.',
    },
    {
      label: 'is for another dataset',
      snapshot: SNAPSHOT.replace('"project":"cli-products"', '"project":"other-products"'),
      headers: {},
      said: 'The snapshot isn’t cli-products’s, in the published format. Nothing was scored.',
    },
    {
      label: 'says another generation than Spatula did',
      snapshot: SNAPSHOT,
      headers: { 'x-spatula-generation': '4' },
      said: 'The snapshot says generation 3 (sn_x), but Spatula said generation 4 (sn_x). Nothing was scored.',
    },
    {
      label: 'says another ID than Spatula did',
      snapshot: SNAPSHOT,
      headers: { 'x-spatula-snapshot-id': 'sn_y' },
      said: 'The snapshot says generation 3 (sn_x), but Spatula said generation 3 (sn_y). Nothing was scored.',
    },
  ])('scores nothing when the snapshot $label', async ({ snapshot, headers, said }) => {
    // The hash is right for what was sent, so only these checks can tell.
    const { fetch, sent } = await serve({ snapshot, headers });
    const { io, out, err } = memoryIo({ 'golden.json': JSON.stringify(GOLDEN) });
    expect(await main(['eval', 'golden.json', '--save'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual([said]);
    expect(out).toEqual([]);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /datasets/cli-products/snapshots/latest',
    ]);
  });

  it('says so, after the scores, when the score can’t be kept', async () => {
    const headers = {
      'x-spatula-sha256': await sha256Hex(SNAPSHOT),
      'x-spatula-generation': '3',
      'x-spatula-snapshot-id': 'sn_x',
    };
    const { fetch } = stubApi(({ method, path }) => {
      if (path.endsWith('/items')) return Response.json({ items: [item(A2, 'sp_a2')] });
      if (method === 'POST') {
        return Response.json({ error: 'Dataset cli-products doesn’t exist.' }, { status: 404 });
      }
      return new Response(SNAPSHOT, { headers });
    });
    const { io, out, err } = memoryIo({ 'golden.json': JSON.stringify(GOLDEN) });
    expect(await main(['eval', 'golden.json', '--save'], { io, env: ENV, fetch })).toBe(1);
    expect(out).toHaveLength(6);
    expect(out).not.toContain('Saved the score.');
    expect(err).toEqual(['Dataset cli-products doesn’t exist.']);
  });

  it('refuses a golden set that isn’t one', async () => {
    const { fetch, sent } = await serve();
    const { io, out, err } = memoryIo({
      'golden.json': JSON.stringify({ dataset: 'cli-products' }),
    });
    expect(await main(['eval', 'golden.json'], { io, env: ENV, fetch })).toBe(1);
    expect(err[0]).toBe('golden.json isn’t a golden set:');
    expect(err.length).toBeGreaterThan(1);
    expect(err.slice(1).every((line) => /^ {2}\S/u.test(line))).toBe(true);
    expect(out).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('lists the first 20 problems of a golden set that has more', async () => {
    const bad = { key: 'Bad Key', pages: ['http://a.example/x'], fields: {}, checkedAgainst: [] };
    const golden = { ...GOLDEN, products: Array.from({ length: 25 }, () => bad) };
    const { fetch } = await serve();
    const { io, err } = memoryIo({ 'golden.json': JSON.stringify(golden) });
    expect(await main(['eval', 'golden.json'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toHaveLength(21);
    expect(err[1]).toMatch(/^ {2}products\.0\./u);
  });

  it('says so when the golden set can’t be read or isn’t JSON, and sends nothing', async () => {
    const { fetch, sent } = await serve();
    const { io, out, err } = memoryIo({ 'broken.json': '{ "dataset": ' });
    expect(await main(['eval', 'missing.json'], { io, env: ENV, fetch })).toBe(1);
    expect(await main(['eval', 'broken.json'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toHaveLength(2);
    expect(err[0]).toBe('missing.json can’t be read: no such file');
    expect(err[1]).toMatch(/^broken\.json isn’t JSON: \S/u);
    expect(out).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('needs exactly one golden set', async () => {
    const { fetch, sent } = await serve();
    const { io, out, err } = memoryIo();
    for (const argv of [['eval'], ['eval', 'a.json', 'b.json']]) {
      expect(await main(argv, { io, env: ENV, fetch }), argv.join(' ')).toBe(2);
    }
    expect(err.slice(0, USAGE.split('\n').length)).toEqual(USAGE.split('\n'));
    expect(out).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});

describe('evals', () => {
  const score = (identifiers: Record<string, number>, keySpecs: Record<string, number>) =>
    ({
      precision: 1,
      recall: 0.92,
      identifiers,
      keySpecs,
    }) as unknown as EvalView['scores'];

  it('shows the history of a dataset’s scores', async () => {
    const saved: EvalView[] = [
      {
        id: 'ev_2',
        generation: 4,
        goldenVersion: 2,
        createdAt: '2026-10-15T00:00:00.000Z',
        scores: {
          precision: 1,
          recall: 0.92,
          identifiers: { accuracy: 0.99 },
          keySpecs: { accuracy: 0.97 },
        } as unknown as EvalView['scores'],
      },
      {
        id: 'ev_1',
        generation: 3,
        goldenVersion: 2,
        createdAt: '2026-10-14T00:00:00.000Z',
        // Nothing was stated, which is not a perfect score.
        scores: score({ checked: 0, accuracy: 1 }, { checked: 0, accuracy: 1 }),
      },
      {
        id: 'ev_0',
        generation: 2,
        goldenVersion: 1,
        createdAt: '2026-10-13T00:00:00.000Z',
        scores: score({ checked: 20, accuracy: 1 }, { checked: 5, accuracy: 0.8 }),
      },
    ];
    const { fetch, sent } = stubApi(() => Response.json({ evals: saved }));
    const { io, out } = memoryIo();
    expect(await main(['evals', 'cli-products'], { io, env: ENV, fetch })).toBe(0);
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/datasets/cli-products/evals' });
    expect(out).toEqual([
      '2026-10-15T00:00:00.000Z  generation 4  golden v2  precision 100.0%  recall 92.0%  identifiers 99.0%  key specs 97.0%',
      '2026-10-14T00:00:00.000Z  generation 3  golden v2  precision 100.0%  recall 92.0%  identifiers none checked  key specs none checked',
      '2026-10-13T00:00:00.000Z  generation 2  golden v1  precision 100.0%  recall 92.0%  identifiers 100.0%  key specs 80.0%',
    ]);
  });

  it('says how to keep a score when none is kept yet', async () => {
    const { fetch } = stubApi(() => Response.json({ evals: [] }));
    const { io, out } = memoryIo();
    expect(await main(['evals', 'cli-products'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual(['No scores are kept yet. spatula eval <golden.json> --save keeps one.']);
  });

  it('keeps a dataset’s name to its place in the address', async () => {
    const { fetch, sent } = stubApi(() => Response.json({ evals: [] }));
    const { io } = memoryIo();
    await main(['evals', 'a b/c'], { io, env: ENV, fetch });
    expect(sent.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/datasets/a%20b%2Fc/evals' },
    ]);
  });

  it('shows why the API refused, and exits 1', async () => {
    const { fetch } = stubApi(() =>
      Response.json({ error: 'The owner token is missing or wrong.' }, { status: 401 }),
    );
    const { io, out, err } = memoryIo();
    expect(await main(['evals', 'cli-products'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual(['The owner token is missing or wrong.']);
    expect(out).toEqual([]);
  });

  it('needs exactly one dataset', async () => {
    const { fetch, sent } = stubApi(() => Response.json({ evals: [] }));
    const { io, out, err } = memoryIo();
    for (const argv of [['evals'], ['evals', 'cli-products', 'extra']]) {
      expect(await main(argv, { io, env: ENV, fetch }), argv.join(' ')).toBe(2);
    }
    expect(err.slice(0, USAGE.split('\n').length)).toEqual(USAGE.split('\n'));
    expect(out).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('are in the usage, before snapshot pull, with the apostrophe every other message uses', () => {
    // The descriptions start in the same column as the other commands'.
    expect(USAGE).toContain(
      [
        '  eval <golden.json> [--save]  Score the latest snapshot against a golden set, and keep',
        '                               the score with --save',
        '  evals <dataset>              The history of a dataset’s scores',
      ].join('\n'),
    );
    expect(USAGE).not.toContain("dataset's");
    expect(USAGE.indexOf('evals <dataset>')).toBeLessThan(USAGE.indexOf('snapshot pull'));
    expect(USAGE.indexOf('status <dataset>')).toBeLessThan(USAGE.indexOf('eval <golden.json>'));
  });
});

describe('SPATULA_URL', () => {
  const REFUSED = 'SPATULA_URL must be an https:// address unless Spatula runs on this machine.';
  const UNCHANGED: ApplySummary = {
    dataset: 'cli-products',
    revision: 1,
    created: false,
    changed: false,
    sources: { added: [], removed: [], changed: [] },
    pages: { added: 0, removed: 0 },
  };

  it.each([
    ['plan', ['plan', 'cli-products.yaml']],
    ['apply', ['apply', 'cli-products.yaml']],
    ['run', ['run', 'cli-products']],
    ['run --wait', ['run', 'cli-products', '--wait']],
    ['snapshot pull', ['snapshot', 'pull', 'cli-products', '--out', 'snapshot.json']],
  ])('%s never sends the owner token in clear text to another machine', async (_name, argv) => {
    const { fetch, sent } = stubApi(() => Response.json(UNCHANGED));
    const { io, err, written } = memoryIo(FILES);
    const env = { SPATULA_URL: 'http://spatula.example.com', SPATULA_TOKEN: 'owner-token' };
    expect(await main(argv, { io, env, fetch })).toBe(1);
    expect(err).toEqual([REFUSED]);
    expect(sent).toHaveLength(0);
    expect(written.size).toBe(0);
  });

  it.each([
    'HTTP://Spatula.Example.com:8787',
    'http://localhost.example.com',
    'http://localhost@spatula.example.com',
    'http://127.0.0.1.example.com',
    'http://[::2]:8787',
  ])('treats %s as another machine', async (url) => {
    const { fetch, sent } = stubApi(() => Response.json(UNCHANGED));
    const { io, err } = memoryIo(FILES);
    const env = { SPATULA_URL: url, SPATULA_TOKEN: 'owner-token' };
    expect(await main(['plan', 'cli-products.yaml'], { io, env, fetch })).toBe(1);
    expect(err).toEqual([REFUSED]);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
    ['HTTP://LOCALHOST:8787', 'http://localhost:8787'],
    ['https://spatula.example.com', 'https://spatula.example.com'],
  ])('sends the owner token to %s', async (url, expectedOrigin) => {
    const { fetch, sent } = stubApi(() => Response.json(UNCHANGED));
    const { io, err } = memoryIo(FILES);
    const env = { SPATULA_URL: url, SPATULA_TOKEN: 'owner-token' };
    expect(await main(['plan', 'cli-products.yaml'], { io, env, fetch })).toBe(0);
    expect(err).toEqual([]);
    expect(sent.map(({ origin, authorization }) => ({ origin, authorization }))).toEqual([
      { origin: expectedOrigin, authorization: 'Bearer owner-token' },
    ]);
  });

  it('leaves commands that send nothing alone, whatever the address', async () => {
    const { io, out, err } = memoryIo(FILES);
    const env = { SPATULA_URL: 'http://spatula.example.com' };
    expect(await main(['check', 'cli-products.yaml'], { io, env })).toBe(0);
    expect(await main(['--help'], { io, env })).toBe(0);
    expect(out[0]).toBe(
      'cli-products: 1 record type, 2 sources, 3 pages. Nothing is wrong with it.',
    );
    expect(out[1]).toContain('Usage: spatula <command>');
    expect(err).toEqual([]);
  });

  it('reports an address that isn’t one, and sends nothing', async () => {
    const { fetch, sent } = stubApi(() => Response.json(UNCHANGED));
    const { io, err } = memoryIo(FILES);
    const env = { SPATULA_URL: 'spatula.example.com', SPATULA_TOKEN: 'owner-token' };
    expect(await main(['plan', 'cli-products.yaml'], { io, env, fetch })).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^Spatula at spatula\.example\.com didn’t answer: /u);
    expect(sent).toHaveLength(0);
  });

  it('never follows a redirect, so the owner token goes nowhere else', async () => {
    // Every request is redirected, and the stub handles the redirect option as fetch does: it
    // fails on "error", answers the 302 itself on "manual", and asks the new address on "follow".
    const sent: { url: string; redirect: RequestInit['redirect'] }[] = [];
    async function redirecting(input: string | URL | Request, init?: RequestInit) {
      sent.push({ url: String(input), redirect: init?.redirect });
      if (sent.length > 1) return Response.json(UNCHANGED);
      const moved = 'https://elsewhere.example/datasets/cli-products';
      switch (init?.redirect ?? 'follow') {
        case 'error':
          throw new TypeError('fetch failed');
        case 'manual':
          return new Response(null, { status: 302, headers: { location: moved } });
        default:
          return redirecting(moved, init);
      }
    }
    const { io, out, err } = memoryIo(FILES);
    const fetch = redirecting as typeof globalThis.fetch;
    expect(await main(['plan', 'cli-products.yaml'], { io, env: ENV, fetch })).toBe(1);
    expect(sent).toEqual([
      { url: 'https://spatula.test/datasets/cli-products?dryRun=1', redirect: 'error' },
    ]);
    expect(err).toEqual(['Spatula at https://spatula.test didn’t answer: fetch failed']);
    expect(out).toEqual([]);
  });
});

describe('usage', () => {
  it('explains itself when asked, or when called wrongly', async () => {
    const { io, out, err } = memoryIo();
    expect(await main(['--help'], { io, env: {} })).toBe(0);
    expect(out.join('\n')).toContain('snapshot pull <dataset> --out <file>');
    expect(await main([], { io, env: {} })).toBe(2);
    expect(await main(['snapshot', 'pull', 'cli-products'], { io, env: {} })).toBe(2);
    expect(await main(['run', 'cli-products', '--bogus'], { io, env: {} })).toBe(2);
    expect(
      await main(['snapshot', 'pull', 'cli-products', '--out', 'x.json', '--generation', 'first'], {
        io,
        env: {},
      }),
    ).toBe(2);
    expect(err.join('\n')).toContain('Usage: spatula <command>');
  });

  it('takes an empty --out as a mistake in the call', async () => {
    const { fetch, sent } = stubApi(() => {
      throw new Error('a call with an empty --out sends nothing');
    });
    const { io, err, written } = memoryIo();
    const argv = ['snapshot', 'pull', 'cli-products', '--out', ''];
    expect(await main(argv, { io, env: ENV, fetch })).toBe(2);
    expect(err).toEqual(USAGE.split('\n'));
    expect(sent).toHaveLength(0);
    expect(written.size).toBe(0);
  });

  it('prints the usage one line at a time, as it always read', async () => {
    const { io, out, err } = memoryIo();
    expect(await main(['--help'], { io, env: {} })).toBe(0);
    expect(out).toEqual(USAGE.split('\n'));
    expect(await main([], { io, env: {} })).toBe(2);
    expect(err).toEqual(USAGE.split('\n'));
  });
});

describe('what reaches the terminal', () => {
  // What Spatula prints can quote what a site wrote, and a terminal obeys some characters: escape
  // sequences recolor and rewrite the screen, retitle the window, write to the clipboard, and hide
  // where a link goes, bidi controls reorder the text the eye reads, and the line and paragraph
  // separators break a line in two. These are the C0 and C1 controls with DEL, the Bidi_Control
  // characters (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069), and U+2028 and U+2029.
  const DRIVES_A_TERMINAL =
    /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200e}\u{200f}\u{2028}-\u{202e}\u{2066}-\u{2069}]/u;

  it('prints a run’s error on one line, with its controls spelled out', async () => {
    const hostile: RunView = {
      ...RUNNING,
      status: 'failed',
      error: 'boom \u001b]0;pwned\u0007\nRun x complete',
    };
    const { fetch } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ runId: RUN_ID }, { status: 202 })
        : Response.json(hostile),
    );
    const { io, out, err } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(1);
    expect(out).toEqual([
      `Started ${RUN_ID}.`,
      String.raw`Run ${RUN_ID} failed: boom \u{1b}]0;pwned\u{7}\u{a}Run x complete`,
    ]);
    expect(err).toEqual([]);
    for (const line of [...out, ...err]) expect(line).not.toMatch(DRIVES_A_TERMINAL);
  });

  it('spells out controls in everything a finished run reports', async () => {
    const hostile: RunView = {
      ...RUNNING,
      status: 'complete',
      finishedAt: '2026-10-10T00:01:00.000Z',
      summary: {
        items: 1,
        fetches: { changed: 1, unchanged: 0, gone: 0, failed: 0, blocked: 0 },
        statements: { added: 1, reseen: 0, withdrawn: 0 },
        llm: { ran: 0, reused: 0, skipped: 1, failed: 0, inputTokens: 0, outputTokens: 0 },
        entities: { created: 1, linked: 0, conflicts: 0, unresolved: 0 },
        snapshot: {
          published: false,
          reason: 'a \u001b[31mred\u001b[0m reason',
          excluded: [{ canonicalId: 'sp_1\u0007', missing: ['na\u009bme'] }],
        },
        notes: [
          'see \u001b]8;;https://evil.example\u0007here\u001b]8;;\u0007',
          'marks \u{200e}\u{200f}\u{61c} and separators \u{2028}\u{2029}',
        ],
      },
    };
    const { fetch } = stubApi(({ method }) =>
      method === 'POST'
        ? Response.json({ runId: RUN_ID }, { status: 202 })
        : Response.json(hostile),
    );
    const { io, out, err } = memoryIo();
    expect(await main(['run', 'cli-products', '--wait'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toContain(
      String.raw`Snapshot: none published, because a \u{1b}[31mred\u{1b}[0m reason.`,
    );
    expect(out).toContain(String.raw`Left out: sp_1\u{7}, missing na\u{9b}me.`);
    expect(out).toContain(String.raw`  see \u{1b}]8;;https://evil.example\u{7}here\u{1b}]8;;\u{7}`);
    expect(out).toContain(
      String.raw`  marks \u{200e}\u{200f}\u{61c} and separators \u{2028}\u{2029}`,
    );
    expect(err).toEqual([]);
    for (const line of [...out, ...err]) expect(line).not.toMatch(DRIVES_A_TERMINAL);
  });

  it('spells out controls in a plan, and in what the API refuses with', async () => {
    const summary: ApplySummary = {
      dataset: 'cli-products',
      revision: 2,
      created: false,
      changed: true,
      sources: { added: ['a\u001b[2J'], removed: ['b\u0007'], changed: ['c\u{202e}'] },
      pages: { added: 0, removed: 0 },
    };
    const planned = stubApi(() => Response.json(summary));
    const first = memoryIo(FILES);
    expect(
      await main(['plan', 'cli-products.yaml'], {
        io: first.io,
        env: ENV,
        fetch: planned.fetch,
      }),
    ).toBe(0);
    expect(first.out).toEqual([
      'cli-products would move to revision 2.',
      String.raw`Sources added: a\u{1b}[2J.`,
      String.raw`Sources removed: b\u{7}.`,
      String.raw`Sources changed: c\u{202e}.`,
    ]);

    const refused = stubApi(() =>
      Response.json(
        { error: 'No \u001b[2Jway', issues: ['dataset: \u009b31mbad\u{202e}q'] },
        { status: 400 },
      ),
    );
    const second = memoryIo(FILES);
    expect(
      await main(['apply', 'cli-products.yaml'], {
        io: second.io,
        env: ENV,
        fetch: refused.fetch,
      }),
    ).toBe(1);
    expect(second.err).toEqual([
      String.raw`No \u{1b}[2Jway`,
      String.raw`  dataset: \u{9b}31mbad\u{202e}q`,
    ]);
    expect(second.out).toEqual([]);
    for (const line of [...first.out, ...first.err, ...second.out, ...second.err]) {
      expect(line).not.toMatch(DRIVES_A_TERMINAL);
    }
  });

  it('spells out controls in the questions a review lists, and in what answering says', async () => {
    const question = { type: 'choice' as const, prompt: 'Which?', options: ['a', 'b'] };
    const hostile: ReviewView[] = [
      {
        id: 'rv_classify',
        kind: 'classify',
        subject: 'it_1',
        question,
        context: {
          url: 'https://evil.example/\u001b]8;;https://good.example\u0007here',
          proposed: 'a',
          probabilities: { a: 0.6 },
          reason: 'ignore \u001b[2J all that\nAnswered rv_x: b \u{202e}',
        },
        createdAt: '2026-10-10T00:00:00.000Z',
      },
      {
        id: 'rv_match',
        kind: 'match',
        subject: 'it_2|sp_1',
        question,
        context: {
          page: 'https://evil.example/\u009b31m',
          entity: 'sp\u{2028}1',
          record: 'sp_\u001b[2J1',
        },
        createdAt: '2026-10-10T00:00:00.000Z',
      },
      {
        id: 'rv_publish',
        kind: 'publication',
        subject: 'sn_1',
        question,
        context: { snapshotId: 'sn_\u0007', reasons: ['a \u001b[31mred\u001b[0m reason'] },
        createdAt: '2026-10-10T00:00:00.000Z',
      },
    ];
    const listing = stubApi(() => Response.json({ reviews: hostile }));
    const first = memoryIo();
    expect(
      await main(['review', 'cli-products'], { io: first.io, env: ENV, fetch: listing.fetch }),
    ).toBe(0);
    expect(first.out).toContain(
      String.raw`rv_classify  classify  https://evil.example/\u{1b}]8;;https://good.example\u{7}here`,
    );
    expect(first.out).toContain(
      String.raw`  Proposed: a (0.60). ignore \u{1b}[2J all that\u{a}Answered rv_x: b \u{202e}`,
    );
    expect(first.out).toContain(
      String.raw`rv_match  match  https://evil.example/\u{9b}31m and sp_\u{1b}[2J1 (sp\u{2028}1)`,
    );
    expect(first.out).toContain(String.raw`rv_publish  publication  sn_\u{7}`);
    expect(first.out).toContain(String.raw`  Held because a \u{1b}[31mred\u{1b}[0m reason.`);

    const answering = stubApi(() =>
      Response.json({
        answered: 'rv_x',
        answer: 'b',
        effect: 'Done \u001b]0;pwned\u0007\nAnswered rv_y: a',
      }),
    );
    const second = memoryIo();
    expect(
      await main(['review', 'cli-products', 'rv_x', 'b'], {
        io: second.io,
        env: ENV,
        fetch: answering.fetch,
      }),
    ).toBe(0);
    expect(second.out).toEqual([
      String.raw`Answered rv_x: b. Done \u{1b}]0;pwned\u{7}\u{a}Answered rv_y: a`,
    ]);
    for (const line of [...first.out, ...first.err, ...second.out, ...second.err]) {
      expect(line).not.toMatch(DRIVES_A_TERMINAL);
    }
  });

  it('spells out controls in the status of a dataset', async () => {
    const hostile: DatasetStatus = {
      dataset: 'cli\u001b[2J',
      revision: 3,
      headGeneration: 4,
      held: {
        snapshotId: 'sn_\u0007',
        records: 1,
        reason: 'a \u001b[31mred\u001b[0m reason\nHeld: sn_ok, 9 records',
        createdAt: '2026-10-12T10:00:00.000Z',
      },
      reviews: { classify: 0, match: 0, publication: 1 },
      consumers: [
        { name: 'c\u{202e}x', generation: 2, outcome: 'applied', receivedAt: 'at \u009b31m' },
        { name: 'o\u001bther', generation: null, outcome: null, receivedAt: null },
      ],
    };
    const { fetch } = stubApi(() => Response.json(hostile));
    const { io, out, err } = memoryIo();
    expect(await main(['status', 'cli-products'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual([
      String.raw`cli\u{1b}[2J, revision 3: generation 4 is published.`,
      String.raw`Held: sn_\u{7}, 1 records, because a \u{1b}[31mred\u{1b}[0m reason\u{a}Held: sn_ok, 9 records.`,
      'Waiting for review: 0 classify, 0 match, 1 publication.',
      String.raw`c\u{202e}x: applied generation 2 at at \u{9b}31m.`,
      String.raw`o\u{1b}ther: has acknowledged nothing yet.`,
    ]);
    expect(err).toEqual([]);
    for (const line of [...out, ...err]) expect(line).not.toMatch(DRIVES_A_TERMINAL);
  });

  it('spells out controls in the misses an eval lists', async () => {
    const golden = {
      dataset: 'cli-products',
      version: 1,
      checked: '2026-10-14',
      identifiers: [],
      products: [
        {
          key: 'maker-a-a2',
          pages: ['https://maker-a.example/products/a2'],
          fields: { name: 'A2' },
          checkedAgainst: ['https://retailer.example/a2'],
        },
      ],
    };
    // What a record says is what a site wrote, and it comes back in the miss that quotes it.
    const snapshot = JSON.stringify({
      project: 'cli-products',
      snapshotId: 'sn_x',
      generation: 3,
      publishedAt: '2026-10-14T00:00:00.000Z',
      records: [
        {
          canonicalId: 'sp_a2',
          fields: { name: 'A2\u001b]0;pwned\u0007\nMisses:\n  maker-a-a1: fine \u{202e}' },
          provenance: {},
        },
      ],
    });
    const headers = {
      'x-spatula-sha256': await sha256Hex(snapshot),
      'x-spatula-generation': '3',
      'x-spatula-snapshot-id': 'sn_x',
    };
    const { fetch } = stubApi(({ path }) =>
      path.endsWith('/items')
        ? Response.json({
            items: [
              {
                locator: 'https://maker-a.example/products/a2',
                sourceId: 'maker-a',
                status: 'live',
                entityId: 'sp_a2',
              },
            ],
          })
        : new Response(snapshot, { headers }),
    );
    const { io, out, err } = memoryIo({ 'golden.json': JSON.stringify(golden) });
    expect(await main(['eval', 'golden.json'], { io, env: ENV, fetch })).toBe(0);
    expect(out).toEqual([
      'cli-products, generation 3, against golden set version 1 (1 product):',
      'Precision: 100.0% (target 99%): met.',
      'Recall: 100.0%, 1 of 1 found (target 90%): met.',
      'Identifiers: none checked.',
      'Key specs: none checked.',
      'Fields: name 0.0% of 1.',
      'Misses:',
      String.raw`  maker-a-a2: name is A2\u{1b}]0;pwned\u{7}\u{a}Misses:\u{a}  maker-a-a1: fine \u{202e}, not A2`,
    ]);
    expect(err).toEqual([]);
    for (const line of [...out, ...err]) expect(line).not.toMatch(DRIVES_A_TERMINAL);
  });

  it('spells out controls in the run another run is going', async () => {
    const message = 'A run of x is already running (x-1\u001b]0;pwned\u0007). Wait.\nStarted y.';
    const { fetch } = stubApi(() =>
      Response.json({ error: message, runId: 'x-1\u001b' }, { status: 409 }),
    );
    const { io, out, err } = memoryIo();
    expect(await main(['run', 'cli-products'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual([
      String.raw`A run of x is already running (x-1\u{1b}]0;pwned\u{7}). Wait.\u{a}Started y.`,
    ]);
    expect(out).toEqual([]);
    for (const line of [...out, ...err]) expect(line).not.toMatch(DRIVES_A_TERMINAL);
  });

  it('spells out controls in what was typed', async () => {
    const { io, err } = memoryIo();
    expect(await main(['run', 'cli-products', '--bog\u001bus'], { io, env: {} })).toBe(2);
    expect(err[0]).toContain(String.raw`--bog\u{1b}us`);
    expect(err.slice(1)).toEqual(USAGE.split('\n'));
    for (const line of err) expect(line).not.toMatch(DRIVES_A_TERMINAL);
  });
});

describe('failureLine', () => {
  it('reports what escaped main as one printable line, without its stack', () => {
    const error = new TypeError('boom \u{1b}[2J\nRun x complete');
    const line = failureLine(error);
    expect(line).toBe(String.raw`Spatula’s CLI failed: boom \u{1b}[2J\u{a}Run x complete`);
    expect(line).not.toContain('main.test.ts');
    expect(failureLine('a thrown string')).toBe('Spatula’s CLI failed: a thrown string');
  });
});

describe('printable', () => {
  it.each([
    ['a tab', 'a\tb', String.raw`a\u{9}b`],
    ['a newline', 'a\nb', String.raw`a\u{a}b`],
    ['escape', '\u001b[31mred', String.raw`\u{1b}[31mred`],
    ['the C1 control sequence introducer', '\u009b31m', String.raw`\u{9b}31m`],
    ['a right-to-left override', 'abc\u{202e}def', String.raw`abc\u{202e}def`],
  ])('spells out %s', (_what, text, spelledOut) => {
    expect(printable(text)).toBe(spelledOut);
  });

  // The ends of each range, and the characters that stand on their own.
  it.each([
    ['U+0000', '\u{0}', String.raw`\u{0}`],
    ['U+001F', '\u{1f}', String.raw`\u{1f}`],
    ['U+007F', '\u{7f}', String.raw`\u{7f}`],
    ['U+0080', '\u{80}', String.raw`\u{80}`],
    ['U+009F', '\u{9f}', String.raw`\u{9f}`],
    ['U+061C', '\u{61c}', String.raw`\u{61c}`],
    ['U+200E', '\u{200e}', String.raw`\u{200e}`],
    ['U+200F', '\u{200f}', String.raw`\u{200f}`],
    ['U+2028', '\u{2028}', String.raw`\u{2028}`],
    ['U+2029', '\u{2029}', String.raw`\u{2029}`],
    ['U+202A', '\u{202a}', String.raw`\u{202a}`],
    ['U+202E', '\u{202e}', String.raw`\u{202e}`],
    ['U+2066', '\u{2066}', String.raw`\u{2066}`],
    ['U+2069', '\u{2069}', String.raw`\u{2069}`],
  ])('spells out %s', (_what, text, spelledOut) => {
    expect(printable(text)).toBe(spelledOut);
  });

  it.each([
    ['a space', ' '],
    ['a tilde', '~'],
    ['a no-break space', '\u{a0}'],
    ['the code point before the Arabic letter mark', '\u{61b}'],
    ['the code point after the Arabic letter mark', '\u{61d}'],
    ['a zero-width space', '\u{200b}'],
    ['a zero-width non-joiner', '\u{200c}'],
    ['a zero-width joiner', '\u{200d}'],
    ['the code point after the right-to-left mark', '\u{2010}'],
    ['the code point before the line separator', '\u{2027}'],
    ['a narrow no-break space', '\u{202f}'],
    ['the code point before the isolates', '\u{2065}'],
    ['the code point after the isolates', '\u{206a}'],
    ['a byte order mark', '\u{feff}'],
    ['accents and a typographic apostrophe', 'Zoë’s café'],
    ['a character outside the BMP', '\u{1f3a7}'],
    ['a backslash', 'C:\\Users\\salar'],
  ])('leaves %s alone', (_what, text) => {
    expect(printable(text)).toBe(text);
  });

  it('spells out exactly the characters in its ranges, across the whole BMP', () => {
    const SPELLED_OUT: [number, number][] = [
      [0x0, 0x1f], // the C0 controls
      [0x7f, 0x9f], // DEL and the C1 controls
      [0x61c, 0x61c], // the Arabic letter mark
      [0x200e, 0x200f], // the left-to-right and right-to-left marks
      [0x2028, 0x202e], // the line and paragraph separators, the embeddings, and the overrides
      [0x2066, 0x2069], // the isolates
    ];
    const wrong: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const char = String.fromCharCode(code);
      const expected = SPELLED_OUT.some(([from, to]) => code >= from && code <= to)
        ? `\\u{${code.toString(16)}}`
        : char;
      if (printable(char) !== expected) wrong.push(`U+${code.toString(16).padStart(4, '0')}`);
    }
    expect(wrong).toEqual([]);
  });

  it('spells out every control in a long line, and nothing else', () => {
    expect(printable('\u001b]0;title\u0007 and \u001b[2J and \u{202e}evil\u{2069}')).toBe(
      String.raw`\u{1b}]0;title\u{7} and \u{1b}[2J and \u{202e}evil\u{2069}`,
    );
  });
});

describe('describeError', () => {
  it('adds the cause when it says more', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:8787'),
    });
    expect(describeError(error)).toBe('fetch failed (connect ECONNREFUSED 127.0.0.1:8787)');
    expect(describeError(new Error('same', { cause: new Error('same') }))).toBe('same');
  });

  it('lists what an AggregateError cause holds when it has no message of its own', () => {
    // Node's fetch reports a refused connection to a name with several addresses, such as
    // localhost, this way: the reasons are in `errors`, and the message is empty.
    const refused = new AggregateError(
      [
        new Error('connect ECONNREFUSED ::1:8787'),
        new Error('connect ECONNREFUSED 127.0.0.1:8787'),
      ],
      '',
    );
    expect(describeError(new TypeError('fetch failed', { cause: refused }))).toBe(
      'fetch failed (connect ECONNREFUSED ::1:8787; connect ECONNREFUSED 127.0.0.1:8787)',
    );
    // A reason given twice is said once. What isn't an error is left out, and a cause with nothing
    // left to say adds nothing.
    const twice = new AggregateError([new Error('timed out'), 'text', new Error('timed out')], '');
    expect(describeError(new Error('fetch failed', { cause: twice }))).toBe(
      'fetch failed (timed out)',
    );
    const empty = new AggregateError([], '');
    expect(describeError(new Error('fetch failed', { cause: empty }))).toBe('fetch failed');
  });

  it('keeps an AggregateError’s own message when it has one', () => {
    const cause = new AggregateError([new Error('inner')], 'every address refused');
    expect(describeError(new Error('fetch failed', { cause }))).toBe(
      'fetch failed (every address refused)',
    );
  });

  it('never throws, even for a value with no text form', () => {
    expect(describeError(Object.create(null))).toBe('an error that can’t be shown as text');
    expect(describeError('plain')).toBe('plain');
  });

  it('gives the same phrase for an error it can’t read, and failureLine prints it', () => {
    const phrase = 'an error that can’t be shown as text';
    const noText = Object.create(null);
    const aggregate = (errors: unknown) => Object.assign(new AggregateError([], ''), { errors });
    const unreadable = [
      // A cause whose errors aren't a list.
      new Error('fetch failed', { cause: aggregate(null) }),
      // A cause holding an error whose message has no text form.
      new Error('fetch failed', {
        cause: aggregate([Object.assign(new Error(), { message: noText })]),
      }),
      // A message with no text form, and one that throws when it's read.
      Object.assign(new Error(), { message: noText }),
      Object.defineProperty(new Error(), 'message', {
        get() {
          throw new Error('unreadable');
        },
      }),
    ];
    for (const error of unreadable) {
      expect(describeError(error)).toBe(phrase);
      expect(failureLine(error)).toBe(`Spatula’s CLI failed: ${phrase}`);
    }
  });
});

describe('failures', () => {
  it('say what the network said when Spatula doesn’t answer', async () => {
    const { io, err } = memoryIo();
    const fetch = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }) as typeof globalThis.fetch;
    expect(await main(['run', 'cli-products'], { io, env: ENV, fetch })).toBe(1);
    expect(err).toEqual([
      'Spatula at https://spatula.test didn’t answer: fetch failed (unexpected redirect)',
    ]);
  });

  it('say why localhost, the default address, refused the connection', async () => {
    const { io, err } = memoryIo();
    const fetch = (async () => {
      throw new TypeError('fetch failed', {
        cause: new AggregateError(
          [
            new Error('connect ECONNREFUSED ::1:8787'),
            new Error('connect ECONNREFUSED 127.0.0.1:8787'),
          ],
          '',
        ),
      });
    }) as typeof globalThis.fetch;
    const env = { SPATULA_TOKEN: 'owner-token' };
    expect(await main(['run', 'cli-products'], { io, env, fetch })).toBe(1);
    expect(err).toEqual([
      'Spatula at http://localhost:8787 didn’t answer: fetch failed (connect ECONNREFUSED ::1:8787; connect ECONNREFUSED 127.0.0.1:8787)',
    ]);
  });

  it('print a thrown value with no text form without failing again', () => {
    expect(failureLine(Object.create(null))).toBe(
      'Spatula’s CLI failed: an error that can’t be shown as text',
    );
  });
});
