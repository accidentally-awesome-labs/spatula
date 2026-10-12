import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { workerPorts } from '../../src/ports';
import { network } from './network';

/*
 * The Worker's ports, as the pipeline gets them, read the way a site would. `sign` is an optional
 * option, so a workerPorts that dropped it would be no type error and no failing unit test, while
 * every request went out unsigned.
 */

/** What a site sees of one request: where it went, and the Web Bot Auth headers on it. */
interface Sent {
  url: string;
  agent: string | null;
  input: string | null;
  signature: string | null;
}

/** Answers every request to `host` with an open robots.txt, and records what it was sent. */
function recording(host: string, sent: Sent[]) {
  return http.get(`https://${host}/*`, ({ request }) => {
    sent.push({
      url: request.url,
      agent: request.headers.get('signature-agent'),
      input: request.headers.get('signature-input'),
      signature: request.headers.get('signature'),
    });
    return HttpResponse.text('User-agent: *\nAllow: /\n');
  });
}

/** A key made for one test and kept in memory: its JWK for the Worker, its public half to check with. */
async function throwawayKey(): Promise<{ jwk: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
  return { jwk, publicKey: pair.publicKey };
}

/** Whether a request's signature checks out for `authority`, rebuilt as a site would. */
async function verifies(request: Sent, authority: string, publicKey: CryptoKey): Promise<boolean> {
  const base = [
    `"@authority": ${authority}`,
    `"signature-agent": ${request.agent}`,
    `"@signature-params": ${request.input!.slice('sig1='.length)}`,
  ].join('\n');
  const signature = Uint8Array.from(atob(request.signature!.slice('sig1=:'.length, -1)), (char) =>
    char.charCodeAt(0),
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    signature,
    new TextEncoder().encode(base),
  );
}

const ASKING = { minIntervalMs: 1000, maxWaitMs: 20_000 };

describe('the Worker’s ports', () => {
  it('sign robots.txt and pages, each for the host it asks, where the Worker has a key', async () => {
    const { jwk, publicKey } = await throwawayKey();
    const sent: Sent[] = [];
    network.use(recording('signs-a.example', sent), recording('signs-b.example', sent));
    const ports = workerPorts({ ...env, WEB_BOT_AUTH_KEY: jwk } as Env);

    // The gate reads a host's robots.txt before it lets a request go. A page on another host is
    // a request of its own.
    await ports.gate.reserve('https://signs-a.example/a', ASKING);
    await ports.http.get('https://signs-b.example/b?x=1', {});

    expect(sent.map((request) => request.url)).toEqual([
      'https://signs-a.example/robots.txt',
      'https://signs-b.example/b?x=1',
    ]);
    const robots = sent[0]!;
    const page = sent[1]!;
    for (const request of sent) {
      expect(request.agent).toBe(`"${new URL(env.PUBLIC_URL).origin}"`);
    }
    expect(await verifies(robots, 'signs-a.example', publicKey)).toBe(true);
    expect(await verifies(page, 'signs-b.example', publicKey)).toBe(true);
    // A signature is made for one host: neither is good for the other's.
    expect(await verifies(robots, 'signs-b.example', publicKey)).toBe(false);
    expect(await verifies(page, 'signs-a.example', publicKey)).toBe(false);

    // Each has a nonce of its own, and is good for a minute.
    const nonces = sent.map((request) => /nonce="([^"]+)"/u.exec(request.input!)?.[1]);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[1]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
    const seconds = (pattern: RegExp) => Number(pattern.exec(page.input!)?.[1]);
    expect(seconds(/expires=(\d+)/u) - seconds(/created=(\d+)/u)).toBe(60);
  });

  it('sign nothing where the Worker has no key', async () => {
    const sent: Sent[] = [];
    network.use(recording('unsigned.example', sent));
    // The Workers tests blank the key, so one the owner later puts in .dev.vars can't reach them.
    const ports = workerPorts(env);

    await ports.gate.reserve('https://unsigned.example/a', ASKING);
    await ports.http.get('https://unsigned.example/b', {});

    expect(sent.map((request) => request.url)).toEqual([
      'https://unsigned.example/robots.txt',
      'https://unsigned.example/b',
    ]);
    for (const request of sent) {
      expect(request).toMatchObject({ agent: null, input: null, signature: null });
    }
  });

  it('fail before sending anything where the key won’t import', async () => {
    const sent: Sent[] = [];
    network.use(recording('badkey.example', sent));
    const ports = workerPorts({ ...env, WEB_BOT_AUTH_KEY: '{"kty":"RSA"}' } as Env);

    const refused = {
      ok: false,
      error:
        'the request couldn’t be signed: WEB_BOT_AUTH_KEY isn’t an Ed25519 private key as a JWK (kty OKP, crv Ed25519, d, and x).',
    };
    expect(await ports.http.get('https://badkey.example/a', {})).toEqual(refused);
    expect(await ports.http.get('https://badkey.example/b', {})).toEqual(refused);
    // robots.txt is a request like any other, so the host stays shut: its rules can't be read.
    expect((await ports.gate.reserve('https://badkey.example/c', ASKING)).kind).toBe('deny');
    expect(sent).toEqual([]);
  });
});
