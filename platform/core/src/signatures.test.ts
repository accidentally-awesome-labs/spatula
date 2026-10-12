import { describe, expect, it } from 'vitest';
import {
  importSigningKey,
  jwkThumbprint,
  keyDirectory,
  randomNonce,
  signDirectory,
  signRequest,
} from './signatures';

// RFC 9421's Ed25519 test key (appendix B.1.4), as a JWK. Its public half's thumbprint is the keyid
// in Cloudflare's Web Bot Auth example.
const TEST_KEY = JSON.stringify({
  kty: 'OKP',
  crv: 'Ed25519',
  d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU',
  x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
});
const KEY_ID = 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U';
const NONCE =
  'e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==';
/** The key's private member, which no error may quote. */
const KEY_D = (JSON.parse(TEST_KEY) as { d: string }).d;

/** The message `importSigningKey` refuses `text` with. */
async function refusalOf(text: string): Promise<string> {
  const error: unknown = await importSigningKey(text).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error))
    throw new Error('The key was accepted, and should have been refused');
  return error.message;
}

describe('importSigningKey', () => {
  it('reads an Ed25519 JWK, and names it by its thumbprint', async () => {
    const key = await importSigningKey(TEST_KEY);
    expect(key.keyId).toBe(KEY_ID);
    expect(key.publicJwk).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
    });
    expect(await jwkThumbprint(key.publicJwk)).toBe(KEY_ID);
  });

  it('takes a key as a runtime exports it, with members it doesn’t need', async () => {
    const exported = { ...JSON.parse(TEST_KEY), alg: 'Ed25519', ext: true, key_ops: ['sign'] };
    expect((await importSigningKey(JSON.stringify(exported))).keyId).toBe(KEY_ID);
  });

  it('refuses anything else, without quoting it', async () => {
    // Every case holds the private member, so a message that quoted what it was given would show it.
    const key = JSON.parse(TEST_KEY) as Record<string, string>;
    const notJson = await refusalOf(TEST_KEY.slice(0, -1));
    const notEd25519 = await refusalOf(JSON.stringify({ ...key, kty: 'RSA' }));
    // RFC 8037's test key's public half, with RFC 9421's private half: they don't belong together.
    const notAPair = await refusalOf(
      JSON.stringify({ ...key, x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }),
    );

    expect(notJson).toBe('WEB_BOT_AUTH_KEY isn’t JSON: set it to an Ed25519 private key as a JWK.');
    expect(notEd25519).toBe(
      'WEB_BOT_AUTH_KEY isn’t an Ed25519 private key as a JWK (kty OKP, crv Ed25519, d, and x).',
    );
    expect(notAPair).toMatch(/^WEB_BOT_AUTH_KEY/u);
    for (const message of [notJson, notEd25519, notAPair]) {
      expect(message).not.toContain(KEY_D);
    }
  });
});

describe('signRequest', () => {
  it('signs as Cloudflare’s Web Bot Auth example does, to the byte', async () => {
    const key = await importSigningKey(TEST_KEY);
    expect(
      await signRequest({
        url: 'https://example.com/products/a1?variant=2',
        agent: 'https://signature-agent.test',
        key,
        now: 1_735_689_600_000,
        nonce: NONCE,
        ttlSeconds: 3600,
      }),
    ).toEqual({
      'signature-agent': '"https://signature-agent.test"',
      'signature-input': `sig1=("@authority" "signature-agent");created=1735689600;keyid="${KEY_ID}";alg="ed25519";expires=1735693200;nonce="${NONCE}";tag="web-bot-auth"`,
      signature:
        'sig1=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:',
    });
  });

  it('refuses an agent that can’t be written as a structured string', async () => {
    const key = await importSigningKey(TEST_KEY);
    // A structured-field string holds printable ASCII, with no quote or backslash unescaped. The
    // control characters include the line breaks a header value must never carry.
    const characters = [
      '"',
      '\\',
      '\r',
      '\n',
      '\t',
      String.fromCharCode(0x1f),
      String.fromCharCode(0x7f),
      String.fromCodePoint(0xe9),
      String.fromCodePoint(0x1f600),
    ];
    for (const character of characters) {
      await expect(
        signRequest({
          url: 'https://example.com/',
          agent: `https://a${character}b.test`,
          key,
          now: 0,
          nonce: NONCE,
        }),
        `U+${character.codePointAt(0)!.toString(16)}`,
      ).rejects.toThrow(
        'The signature agent can’t hold a quote, a backslash, or a character outside printable ASCII',
      );
    }
  });

  it('takes the whole printable range, a space to a tilde', async () => {
    const key = await importSigningKey(TEST_KEY);
    const signed = await signRequest({
      url: 'https://example.com/',
      agent: 'https://a b~c.test',
      key,
      now: 0,
      nonce: NONCE,
    });
    expect(signed['signature-agent']).toBe('"https://a b~c.test"');
  });
});

describe('how long a signature is good for', () => {
  it('is a minute unless told otherwise, so a captured request can’t be replayed later', async () => {
    const key = await importSigningKey(TEST_KEY);
    const now = 1_735_689_600_000;
    const request = await signRequest({
      url: 'https://example.com/',
      agent: 'https://signature-agent.test',
      key,
      now,
      nonce: NONCE,
    });
    const directory = await signDirectory({ authority: 'spatula.example', key, now, nonce: NONCE });
    for (const input of [request['signature-input'], directory['signature-input']]) {
      expect(input).toContain(';created=1735689600;');
      expect(input).toContain(';expires=1735689660;');
    }
  });
});

describe('the key directory', () => {
  it('lists the public key, and signs its answer for the host that asked', async () => {
    const key = await importSigningKey(TEST_KEY);
    expect(JSON.parse(keyDirectory(key))).toEqual({ keys: [key.publicJwk] });
    expect(
      await signDirectory({
        authority: 'spatula.example',
        key,
        now: 1_760_256_000_000,
        nonce: NONCE,
        ttlSeconds: 60,
      }),
    ).toEqual({
      'signature-input': `sig1=("@authority";req);created=1760256000;keyid="${KEY_ID}";alg="ed25519";expires=1760256060;nonce="${NONCE}";tag="http-message-signatures-directory"`,
      signature:
        'sig1=:TfhzLpdbLgVxuBiROvlY3gyR34SP0JSWwo8biT5p6sb3fIMjSE5swdX2sN88QrqDIvrsmL9tTK1E4YjQyCSvAg==:',
    });
  });
});

describe('randomNonce', () => {
  it('is 64 random bytes in base64, different each time', () => {
    const nonce = randomNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{86}==$/u);
    expect(randomNonce()).not.toBe(nonce);
  });
});
