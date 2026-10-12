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
    await expect(importSigningKey('not json')).rejects.toThrow(
      'WEB_BOT_AUTH_KEY isn’t JSON: set it to an Ed25519 private key as a JWK.',
    );
    await expect(importSigningKey('{"kty":"RSA"}')).rejects.toThrow(
      'WEB_BOT_AUTH_KEY isn’t an Ed25519 private key as a JWK (kty OKP, crv Ed25519, d, and x).',
    );
    // RFC 8037's test key's public half, with RFC 9421's private half: they don't belong together.
    const mismatched = JSON.stringify({
      ...JSON.parse(TEST_KEY),
      x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
    });
    await expect(importSigningKey(mismatched)).rejects.toThrow(/^WEB_BOT_AUTH_KEY/u);
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
    await expect(
      signRequest({
        url: 'https://example.com/',
        agent: 'https://a"b.test',
        key,
        now: 0,
        nonce: NONCE,
      }),
    ).rejects.toThrow(
      'The signature agent can’t hold a quote, a backslash, or a control character',
    );
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
