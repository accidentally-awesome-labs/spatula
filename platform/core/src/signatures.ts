import { z } from 'zod';
import { sha256Hex } from './ids';

/** The key Web Crypto gives back, as both Node's types and the Workers' types name it. */
type SigningCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/*
 * Web Bot Auth: HTTP Message Signatures (RFC 9421) over each request's authority and its
 * Signature-Agent header, made with an Ed25519 key whose public half Spatula serves at
 * DIRECTORY_PATH. A site that checks them knows the request came from Spatula. Signing hides
 * nothing: it's the opposite of stealth, and a site that refuses signed requests is refused like
 * any other. The formats are Cloudflare's (developers.cloudflare.com/bots/reference/bot-verification/
 * web-bot-auth/, checked 2026-10-08), and the tests pin them byte for byte.
 */

export const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const DIRECTORY_CONTENT_TYPE = 'application/http-message-signatures-directory+json';
export const SIGNATURE_TAG = 'web-bot-auth';
export const DIRECTORY_TAG = 'http-message-signatures-directory';

/** How long a signature is good for: a minute, so a captured request can't be replayed later. */
const SIGNATURE_TTL_SECONDS = 60;

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

export interface SigningKey {
  privateKey: SigningCryptoKey;
  publicJwk: PublicJwk;
  /** The JWK thumbprint (RFC 7638) of the public key, which signatures name as their keyid. */
  keyId: string;
}

const base64Url = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
// A runtime's export adds alg, ext, and key_ops, which aren't needed and are dropped.
const privateJwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  d: base64Url,
  x: base64Url,
});

/**
 * The signing key, from the WEB_BOT_AUTH_KEY secret: an Ed25519 private key as a JWK. A private
 * half that doesn't belong to the public half would sign requests no directory can verify, so one
 * signature is checked against the public half before the key is used. Errors never quote the key.
 */
export async function importSigningKey(jwkText: string): Promise<SigningKey> {
  let data: unknown;
  try {
    data = JSON.parse(jwkText);
  } catch {
    throw new Error('WEB_BOT_AUTH_KEY isn’t JSON: set it to an Ed25519 private key as a JWK.');
  }
  const parsed = privateJwkSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      'WEB_BOT_AUTH_KEY isn’t an Ed25519 private key as a JWK (kty OKP, crv Ed25519, d, and x).',
    );
  }
  const publicJwk: PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: parsed.data.x };
  let privateKey: SigningCryptoKey;
  let publicKey: SigningCryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      'jwk',
      { ...publicJwk, d: parsed.data.d },
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    publicKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, false, [
      'verify',
    ]);
  } catch (error) {
    const why = error instanceof Error ? error.message : 'it was refused';
    throw new Error(`WEB_BOT_AUTH_KEY isn’t a usable Ed25519 key: ${why}`);
  }
  const probe = new TextEncoder().encode('Spatula checks its key');
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, probe);
  if (!(await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, probe))) {
    throw new Error('WEB_BOT_AUTH_KEY’s private half (d) doesn’t belong to its public half (x).');
  }
  return { privateKey, publicJwk, keyId: await jwkThumbprint(publicJwk) };
}

/** RFC 7638's thumbprint: the SHA-256 of the required members in order, in base64url. */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  const hex = await sha256Hex(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`);
  return base64(hexBytes(hex), true);
}

/** The key directory's body: the public key, which is all a site needs to check a signature. */
export function keyDirectory(key: SigningKey): string {
  return JSON.stringify({ keys: [key.publicJwk] });
}

/** A nonce: 64 random bytes, in base64. */
export function randomNonce(): string {
  return base64(crypto.getRandomValues(new Uint8Array(64)), false);
}

/**
 * The headers that sign a request to `url`. `agent` is where Spatula serves its key directory; it
 * travels as a structured-field string, in quotes.
 */
export async function signRequest(input: {
  url: string;
  agent: string;
  key: SigningKey;
  now: number;
  nonce: string;
  ttlSeconds?: number;
}): Promise<{ 'signature-agent': string; 'signature-input': string; signature: string }> {
  // A structured-field string (RFC 8941) holds printable ASCII only, with no quote or backslash
  // unescaped. Spatula's own address never needs any of that, so it's refused rather than escaped.
  if (/[^\x20-\x7e]|["\\]/u.test(input.agent)) {
    throw new Error(
      'The signature agent can’t hold a quote, a backslash, or a character outside printable ASCII',
    );
  }
  const agent = `"${input.agent}"`;
  const params = signatureParams({
    components: '("@authority" "signature-agent")',
    key: input.key,
    now: input.now,
    nonce: input.nonce,
    ttlSeconds: input.ttlSeconds,
    tag: SIGNATURE_TAG,
  });
  const base = [
    `"@authority": ${new URL(input.url).host}`,
    `"signature-agent": ${agent}`,
    `"@signature-params": ${params}`,
  ].join('\n');
  return {
    'signature-agent': agent,
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${await sign(input.key, base)}:`,
  };
}

/** The headers that sign the key directory's answer, for the host the request was sent to. */
export async function signDirectory(input: {
  authority: string;
  key: SigningKey;
  now: number;
  nonce: string;
  ttlSeconds?: number;
}): Promise<{ 'signature-input': string; signature: string }> {
  const params = signatureParams({
    components: '("@authority";req)',
    key: input.key,
    now: input.now,
    nonce: input.nonce,
    ttlSeconds: input.ttlSeconds,
    tag: DIRECTORY_TAG,
  });
  const base = [`"@authority";req: ${input.authority}`, `"@signature-params": ${params}`].join(
    '\n',
  );
  return {
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${await sign(input.key, base)}:`,
  };
}

/** Signature parameters, in the order Cloudflare's examples give them. */
function signatureParams(input: {
  components: string;
  key: SigningKey;
  now: number;
  nonce: string;
  ttlSeconds: number | undefined;
  tag: string;
}): string {
  const created = Math.floor(input.now / 1000);
  const expires = created + (input.ttlSeconds ?? SIGNATURE_TTL_SECONDS);
  return `${input.components};created=${created};keyid="${input.key.keyId}";alg="ed25519";expires=${expires};nonce="${input.nonce}";tag="${input.tag}"`;
}

async function sign(key: SigningKey, base: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    key.privateKey,
    new TextEncoder().encode(base),
  );
  return base64(new Uint8Array(signature), false);
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** Bytes in base64, or in base64url without padding. Both Node and Workers have btoa. */
function base64(bytes: Uint8Array, url: boolean): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  const encoded = btoa(text);
  return url ? encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') : encoded;
}
