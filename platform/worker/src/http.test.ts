import { describe, expect, it } from 'vitest';
import { createHttpFetcher, userAgent } from './http';

const UA = userAgent('0.2.0-dev', 'https://github.com/accidentally-awesome-labs/spatula');

/** A stub fetch that records what it was asked and answers with `respond`. */
function stub(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('userAgent', () => {
  it('names Spatula, its version, and where to read about it', () => {
    expect(UA).toBe('Spatula/0.2.0-dev (+https://github.com/accidentally-awesome-labs/spatula)');
  });
});

describe('createHttpFetcher', () => {
  it('identifies itself, passes the conditional headers, and never follows redirects', async () => {
    const { fetch, calls } = stub(
      () =>
        new Response('<html>A1</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html', ETag: '"v2"' },
        }),
    );
    const http = createHttpFetcher({ userAgent: UA, fetch });
    const result = await http.get('https://maker-a.example/products/a1', {
      'if-none-match': '"v1"',
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      headers: { 'content-type': 'text/html', etag: '"v2"' },
      body: new TextEncoder().encode('<html>A1</html>'),
      truncated: false,
    });
    const sent = new Headers(calls[0]!.init.headers);
    expect(sent.get('user-agent')).toBe(UA);
    expect(sent.get('if-none-match')).toBe('"v1"');
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('answers a redirect or an error without reading its body', async () => {
    const http = createHttpFetcher({
      userAgent: UA,
      fetch: stub(
        () => new Response('moved', { status: 301, headers: { Location: '/products/a1-new' } }),
      ).fetch,
    });
    expect(await http.get('https://maker-a.example/products/a1', {})).toEqual({
      ok: true,
      status: 301,
      headers: { location: '/products/a1-new', 'content-type': 'text/plain;charset=UTF-8' },
      body: new Uint8Array(),
      truncated: false,
    });
  });

  it('cuts a body off at the limit and says so', async () => {
    const http = createHttpFetcher({
      userAgent: UA,
      maxBytes: 10,
      fetch: stub(() => new Response('x'.repeat(25), { status: 200 })).fetch,
    });
    const result = await http.get('https://maker-a.example/big', {});
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.body.byteLength).toBe(10);
  });

  it('reads at most 5 MB of a page unless told otherwise', async () => {
    const http = createHttpFetcher({
      userAgent: UA,
      fetch: stub(() => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { status: 200 })).fetch,
    });
    const result = await http.get('https://maker-a.example/huge', {});
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.body.byteLength).toBe(5 * 1024 * 1024);
  });

  it('turns a timeout or a network error into a failed answer', async () => {
    const timedOut = createHttpFetcher({
      userAgent: UA,
      fetch: stub(() => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }).fetch,
    });
    expect(await timedOut.get('https://maker-a.example/slow', {})).toEqual({
      ok: false,
      error: 'no answer within 30 s',
    });

    const unreachable = createHttpFetcher({
      userAgent: UA,
      fetch: stub(() => {
        throw new TypeError('fetch failed');
      }).fetch,
    });
    expect(await unreachable.get('https://maker-a.example/down', {})).toEqual({
      ok: false,
      error: 'fetch failed',
    });
  });

  it('stops waiting when the timeout passes', async () => {
    // A site that never answers: this fetch settles only when the signal it was given aborts.
    const silent = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('no signal was passed'));
        signal.addEventListener('abort', () => reject(signal.reason));
      })) as typeof globalThis.fetch;
    const http = createHttpFetcher({ userAgent: UA, timeoutMs: 20, fetch: silent });
    expect(await http.get('https://maker-a.example/slow', {})).toEqual({
      ok: false,
      error: 'no answer within 0.02 s',
    });
  });

  it('turns a failure while reading the body into a failed answer', async () => {
    const dropped = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    const http = createHttpFetcher({
      userAgent: UA,
      fetch: stub(() => new Response(dropped, { status: 200 })).fetch,
    });
    expect(await http.get('https://maker-a.example/cut', {})).toEqual({
      ok: false,
      error: 'terminated',
    });
  });

  it('asks only for HTTPS addresses', async () => {
    const { fetch, calls } = stub(() => new Response('', { status: 200 }));
    const http = createHttpFetcher({ userAgent: UA, fetch });
    expect(await http.get('http://maker-a.example/products/a1', {})).toEqual({
      ok: false,
      error: 'http://maker-a.example/products/a1 isn’t an HTTPS address',
    });
    expect(calls).toHaveLength(0);
  });

  it('never asks a non-public address', async () => {
    const { fetch, calls } = stub(() => new Response('<html>ok</html>', { status: 200 }));
    const http = createHttpFetcher({ userAgent: UA, fetch });

    // A redirect's location comes from the site, so each hop is judged like a definition's address.
    for (const [url, reason] of [
      ['https://127.0.0.1/x', 'an IP address, not a host name'],
      ['https://localhost/x', 'a local name'],
      ['https://intranet/x', 'a local name'],
      ['https://printer.local/x', 'a private-use name'],
      ['https://user:pass@shop.example/x', 'carrying a user name or password'],
    ] as const) {
      expect(await http.get(url, {})).toEqual({ ok: false, error: `${url} is ${reason}` });
    }
    expect(await http.get('https://', {})).toEqual({
      ok: false,
      error: 'https:// isn’t an address',
    });
    expect(calls).toHaveLength(0);

    expect(await http.get('https://shop.example/x', {})).toMatchObject({ ok: true, status: 200 });
    expect(calls.map((call) => call.url)).toEqual(['https://shop.example/x']);
  });
});
