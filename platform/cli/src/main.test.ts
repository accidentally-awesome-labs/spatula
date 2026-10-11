import { sha256Hex, type ApplySummary, type RunView } from '@spatula/core';
import { testDefinition } from '@spatula/store/fixtures';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { POLL_MS, WAIT_LIMIT_MS, type Io } from './commands';
import { main } from './main';

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

    expect(await main(['check', 'broken.yaml'], { io, env: {} })).toBe(1);
    expect(err.at(-1)).toMatch(/^broken\.yaml isn’t valid YAML: /u);
    expect(await main(['check', 'missing.yaml'], { io, env: {} })).toBe(1);
    expect(err.at(-1)).toBe('missing.yaml can’t be read: no such file');
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
});
