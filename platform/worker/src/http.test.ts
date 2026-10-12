import { describe, expect, it, vi } from 'vitest';
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

  it('sends only its own user agent, however a caller spells another', async () => {
    const { fetch, calls } = stub(() => new Response('', { status: 200 }));
    const http = createHttpFetcher({ userAgent: UA, fetch });
    await http.get('https://maker-a.example/a', { 'user-agent': 'other' });
    await http.get('https://maker-a.example/b', { 'User-Agent': 'other', 'if-none-match': '"v1"' });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(new Headers(call.init.headers).get('user-agent')).toBe(UA);
    }
    expect(new Headers(calls[1]!.init.headers).get('if-none-match')).toBe('"v1"');
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

  it('answers an error status even when its body has already failed', async () => {
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    const http = createHttpFetcher({
      userAgent: UA,
      fetch: stub(() => new Response(failed, { status: 503 })).fetch,
    });
    expect(await http.get('https://maker-a.example/down', {})).toEqual({
      ok: true,
      status: 503,
      headers: {},
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

  it('stops reading a long stream at the limit, and cancels it', async () => {
    const chunks = ['aaaa', 'bbbb', 'cccc', 'dddd'].map((text) => new TextEncoder().encode(text));
    const cancelled = vi.fn();
    let next = 0;
    const long = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[next++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel: cancelled,
    });
    const http = createHttpFetcher({
      userAgent: UA,
      maxBytes: 10,
      fetch: stub(() => new Response(long, { status: 200 })).fetch,
    });
    const result = await http.get('https://maker-a.example/long', {});
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && new TextDecoder().decode(result.body)).toBe('aaaabbbbcc');
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('keeps the body it read up to the limit when the stream fails right after', async () => {
    // The first chunk passes the limit. The stream fails on the next pull, before the reader
    // cancels it, so cancelling it fails too.
    let pulls = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('x'.repeat(25)));
        else controller.error(new TypeError('terminated'));
      },
    });
    const http = createHttpFetcher({
      userAgent: UA,
      maxBytes: 10,
      fetch: stub(() => new Response(failing, { status: 200 })).fetch,
    });
    const result = await http.get('https://maker-a.example/cut-short', {});
    expect(result).toMatchObject({ ok: true, status: 200, truncated: true });
    expect(result.ok && new TextDecoder().decode(result.body)).toBe('x'.repeat(10));
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

  it('asks for the address it checked, in the form it checked', async () => {
    const { fetch, calls } = stub(() => new Response('', { status: 200 }));
    const http = createHttpFetcher({ userAgent: UA, fetch });
    await http.get('https://SHOP.example:443/a b', {});
    expect(calls.map((call) => call.url)).toEqual(['https://shop.example/a%20b']);
  });

  it('reads up to the cap a caller sets, and asks for what it accepts', async () => {
    const { fetch, calls } = stub(() => new Response('0123456789', { status: 200 }));
    const http = createHttpFetcher({ userAgent: UA, fetch });
    const result = await http.get(
      'https://maker-c.example/sitemap.xml',
      {},
      {
        maxBytes: 4,
        accept: 'application/xml',
      },
    );
    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      body: new TextEncoder().encode('0123'),
    });
    expect(new Headers(calls[0]!.init.headers).get('accept')).toBe('application/xml');
  });

  it('adds the signer’s headers, which a caller can’t replace', async () => {
    const { fetch, calls } = stub(() => new Response('', { status: 200 }));
    const http = createHttpFetcher({
      userAgent: UA,
      fetch,
      sign: async (url) => ({
        signature: `sig1=:${url}:`,
        'signature-agent': '"https://spatula.test"',
      }),
    });
    await http.get('https://maker-a.example/a', { signature: 'forged' });
    const sent = new Headers(calls[0]!.init.headers);
    expect(sent.get('signature')).toBe('sig1=:https://maker-a.example/a:');
    expect(sent.get('signature-agent')).toBe('"https://spatula.test"');

    // However a caller spells a name, and however many spellings of it it sends. Its other
    // headers still go.
    await http.get('https://maker-a.example/b', {
      signature: 'forged',
      Signature: 'forged again',
      'SIGNATURE-AGENT': 'forged',
      'if-none-match': '"v1"',
    });
    const again = new Headers(calls[1]!.init.headers);
    expect(again.get('signature')).toBe('sig1=:https://maker-a.example/b:');
    expect(again.get('signature-agent')).toBe('"https://spatula.test"');
    expect(again.get('if-none-match')).toBe('"v1"');
  });

  it('keeps its own user agent, whatever the signer returns', async () => {
    const { fetch, calls } = stub(() => new Response('', { status: 200 }));
    const http = createHttpFetcher({
      userAgent: UA,
      fetch,
      sign: async () => ({ 'User-Agent': 'other', signature: 'sig1=::' }),
    });
    await http.get('https://maker-a.example/a', { 'user-agent': 'another' });
    const sent = new Headers(calls[0]!.init.headers);
    expect(sent.get('user-agent')).toBe(UA);
    expect(sent.get('signature')).toBe('sig1=::');
  });

  it('fails the request, without sending it, when it can’t be signed', async () => {
    const { fetch, calls } = stub(() => new Response('', { status: 200 }));
    const http = createHttpFetcher({
      userAgent: UA,
      fetch,
      sign: async () => {
        throw new Error('WEB_BOT_AUTH_KEY isn’t JSON: set it to an Ed25519 private key as a JWK.');
      },
    });
    expect(await http.get('https://maker-a.example/a', {})).toEqual({
      ok: false,
      error:
        'the request couldn’t be signed: WEB_BOT_AUTH_KEY isn’t JSON: set it to an Ed25519 private key as a JWK.',
    });
    expect(calls).toHaveLength(0);
  });
});
