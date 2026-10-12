import { sha256Hex, type ApplySummary, type RunView } from '@spatula/core';
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
